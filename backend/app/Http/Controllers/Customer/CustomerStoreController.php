<?php

namespace App\Http\Controllers\Customer;

use App\Http\Controllers\Controller;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\Validator;
use Illuminate\Support\Str;
use App\Services\FileStorageService;
use App\Services\WorkflowNotifier;
use App\Support\EmailContent;
use App\Models\ActivityLog;

class CustomerStoreController extends Controller
{
    private function orderWorkflowsDisabled()
    {
        return response()->json([
            'success' => false,
            'message' => 'Customer store order workflows are disabled.',
        ], 410);
    }

    public function checkout(Request $request)
    {
        return $this->orderWorkflowsDisabled();

        $user = Auth::user();

        Log::info('Customer store checkout attempt', [
            'user_id' => $user?->id,
            'user_role' => $user?->role,
            'items_count' => count($request->input('items', [])),
            'total_amount' => $request->input('totalAmount') ?? $request->input('total_amount'),
        ]);

        if (!$user) {
            return response()->json([
                'success' => false,
                'message' => 'Unauthorized. Please login again before placing your order.',
            ], 401);
        }

        if (strtolower((string) $user->role) !== 'customer') {
            return response()->json([
                'success' => false,
                'message' => 'Forbidden. Only customer accounts can place store orders.',
            ], 403);
        }

        $validator = Validator::make($request->all(), [
            'items' => 'required|array|min:1',
            'items.*.id' => 'nullable|integer',
            'items.*.product_id' => 'nullable|integer',
            'items.*.name' => 'required|string|max:255',
            'items.*.sku' => 'nullable|string|max:255',
            'items.*.qty' => 'nullable|integer|min:1',
            'items.*.quantity' => 'nullable|integer|min:1',
            'items.*.price' => 'required|numeric|min:0',
            'total_amount' => 'required|numeric|min:0',
            'order_type' => 'required|string',
            'payment_method' => 'required|string',
            'payment_proof' => 'nullable|string',
            'payment_reference' => 'nullable|string',
            'subtotal' => 'nullable|numeric|min:0',
            'discountAmount' => 'nullable|numeric|min:0',
            'discount_amount' => 'nullable|numeric|min:0',
            'discountApplied' => 'nullable|numeric|min:0',
            'discount_applied' => 'nullable|numeric|min:0',

            'paymentMethod' => 'nullable|string|max:255',
            'paymentProof' => 'nullable|string|max:255',
            'orderId' => 'nullable|string|max:255',
            'referenceNumber' => 'nullable|string|max:255',
            'customerName' => 'nullable|string|max:255',
            'orderType' => 'nullable|string|max:255',
]);

        $validator->after(function ($validator) use ($request) {
            $total = $request->input('total_amount');

            if ($total === null) {
                $validator->errors()->add('total_amount', 'Total amount is required.');
            }

            $paymentMethod = $request->input('payment_method');

            if (!$paymentMethod) {
                $validator->errors()->add('payment_method', 'Payment method is required.');
            }

            foreach ($request->input('items', []) as $index => $item) {
                $productId = $item['product_id'] ?? $item['id'] ?? null;

                if (!$productId) {
                    $validator->errors()->add("items.$index.product_id", 'Product ID is required.');
                }

                $quantity = $item['quantity'] ?? $item['qty'] ?? null;

                if (!$quantity) {
                    $validator->errors()->add("items.$index.quantity", 'Quantity is required.');
                }
            }
        });

        if ($validator->fails()) {
            return response()->json([
                'success' => false,
                'message' => 'Order validation failed.',
                'errors' => $validator->errors(),
            ], 422);
        }

        $validated = $validator->validated();

        try {
            DB::beginTransaction();

            $items = $request->input('items', []);
            $totalAmount = (float) ($request->input('totalAmount') ?? $request->input('total_amount') ?? 0);
            $subtotal = (float) ($request->input('subtotal') ?? $totalAmount);
            $discountAmount = (float) ($request->input('discountAmount') ?? $request->input('discount_amount') ?? 0);
            $discountApplied = (float) ($request->input('discountApplied') ?? $request->input('discount_applied') ?? 0);

            $paymentMethod = $request->input('paymentMethod') ?? $request->input('payment_method') ?? 'Online Payment';
            $paymentProof = $request->input('paymentProof') ?? $request->input('payment_proof');
            $orderNumber = $request->input('orderId') ?? $request->input('order_id') ?? $this->generateOrderNumber();
            $referenceNumber = $request->input('referenceNumber') ?? $request->input('reference_number') ?? $this->generateReferenceNumber();
            $customerName = $request->input('customerName') ?? $request->input('customer_name') ?? $user->name ?? 'Customer';
            $orderType = $request->input('orderType') ?? $request->input('order_type') ?? 'Pick-up';

            $computedSubtotal = 0;
            $serverPrices = [];

            foreach ($items as $item) {
                $productId = $item['product_id'] ?? $item['id'];
                $quantity = (int) ($item['quantity'] ?? $item['qty'] ?? 1);

                $inventoryItem = DB::table('inventory_items')
                    ->where('id', $productId)
                    ->first();

                if (!$inventoryItem) {
                    DB::rollBack();

                    return response()->json([
                        'success' => false,
                        'message' => "Item not found: {$item['name']}",
                    ], 422);
                }

                $availableStock = (int) ($inventoryItem->stock ?? 0);

                if ($availableStock < $quantity) {
                    DB::rollBack();

                    return response()->json([
                        'success' => false,
                        'message' => "Not enough stock for {$item['name']}. Available stock: {$availableStock}",
                    ], 422);
                }

                // Price is authoritative from the database — the client-supplied
                // price/line_total/total_amount values are never persisted.
                $serverPrice = (float) $inventoryItem->price;
                $serverPrices[$productId] = $serverPrice;
                $computedSubtotal += $serverPrice * $quantity;
            }

            // Server-side totals: client totals are display hints only.
            $subtotal = $computedSubtotal;
            $discountAmount = min(max($discountAmount, 0), $computedSubtotal);
            $discountApplied = min(max($discountApplied, 0), $computedSubtotal);
            $totalAmount = max($computedSubtotal - $discountAmount, 0);

            $orderData = [
                'created_at' => now(),
                'updated_at' => now(),
            ];

            $this->setIfColumnExists($orderData, 'customer_orders', 'customer_id', $user->id);
            $this->setIfColumnExists($orderData, 'customer_orders', 'user_id', $user->id);
            $this->setIfColumnExists($orderData, 'customer_orders', 'customer_name', $customerName);
            $this->setIfColumnExists($orderData, 'customer_orders', 'customer_email', $user->email ?? null);

            $this->setIfColumnExists($orderData, 'customer_orders', 'order_number', $orderNumber);
            $this->setIfColumnExists($orderData, 'customer_orders', 'order_id', $orderNumber);
            $this->setIfColumnExists($orderData, 'customer_orders', 'reference_number', $referenceNumber);

            $this->setIfColumnExists($orderData, 'customer_orders', 'subtotal', $subtotal ?: $computedSubtotal);
            $this->setIfColumnExists($orderData, 'customer_orders', 'discount_amount', $discountAmount);
            $this->setIfColumnExists($orderData, 'customer_orders', 'discount_applied', $discountApplied);
            $this->setIfColumnExists($orderData, 'customer_orders', 'total_amount', $totalAmount);

            $this->setIfColumnExists($orderData, 'customer_orders', 'order_type', $orderType);
            $this->setIfColumnExists($orderData, 'customer_orders', 'payment_method', $paymentMethod);
            // Do not set payment_proof during checkout - only when customer uploads proof
            $this->setIfColumnExists($orderData, 'customer_orders', 'payment_status', 'unpaid');
            $this->setIfColumnExists($orderData, 'customer_orders', 'status', 'pending');
            $this->setIfColumnExists($orderData, 'customer_orders', 'notes', 'Order submitted and waiting for receptionist approval.');

            if (!isset($orderData['total_amount']) && Schema::hasColumn('customer_orders', 'total')) {
                $orderData['total'] = $totalAmount;
            }

            $customerOrderId = DB::table('customer_orders')->insertGetId($orderData);

            foreach ($items as $item) {
                $productId = $item['product_id'] ?? $item['id'];
                $quantity = (int) ($item['quantity'] ?? $item['qty'] ?? 1);
                $price = $serverPrices[$productId] ?? 0;
                $lineTotal = $price * $quantity;

                $itemData = [
                    'created_at' => now(),
                    'updated_at' => now(),
                ];

                $this->setIfColumnExists($itemData, 'customer_order_items', 'customer_order_id', $customerOrderId);
                $this->setIfColumnExists($itemData, 'customer_order_items', 'order_id', $customerOrderId);

                $this->setIfColumnExists($itemData, 'customer_order_items', 'inventory_item_id', $productId);
                $this->setIfColumnExists($itemData, 'customer_order_items', 'product_id', $productId);

                $this->setIfColumnExists($itemData, 'customer_order_items', 'product_name', $item['name']);
                $this->setIfColumnExists($itemData, 'customer_order_items', 'name', $item['name']);
                $this->setIfColumnExists($itemData, 'customer_order_items', 'sku', $item['sku'] ?? null);

                $this->setIfColumnExists($itemData, 'customer_order_items', 'quantity', $quantity);
                $this->setIfColumnExists($itemData, 'customer_order_items', 'qty', $quantity);

                $this->setIfColumnExists($itemData, 'customer_order_items', 'price', $price);
                $this->setIfColumnExists($itemData, 'customer_order_items', 'unit_price', $price);

                $this->setIfColumnExists($itemData, 'customer_order_items', 'subtotal', $lineTotal);
                $this->setIfColumnExists($itemData, 'customer_order_items', 'line_total', $lineTotal);

                DB::table('customer_order_items')->insert($itemData);
            }

            DB::commit();

            Log::info('Customer store checkout submitted successfully', [
                'user_id' => $user->id,
                'customer_order_id' => $customerOrderId,
                'order_number' => $orderNumber,
                'reference_number' => $referenceNumber,
                'total_amount' => $totalAmount,
            ]);

            return response()->json([
                'success' => true,
                'message' => 'Order submitted successfully. Please wait for receptionist approval before uploading payment proof.',
                'id' => $customerOrderId,
                'orderId' => $orderNumber,
                'order_id' => $orderNumber,
                'referenceNumber' => $referenceNumber,
                'reference_number' => $referenceNumber,
                'status' => 'pending',
                'payment_status' => 'unpaid',
            ], 201);

        } catch (\Exception $e) {
            DB::rollBack();
            Log::error('Customer store checkout error', [
                'user_id' => $user?->id,
                'error' => $e->getMessage(),
            ]);

            return response()->json([
                'success' => false,
                'message' => app()->environment('local')
                    ? $e->getMessage()
                    : 'Checkout failed. Please try again.',
            ], 500);
        }
    }

    public function orders(Request $request)
    {
        $user = Auth::user();

        if (!$user) {
            return response()->json(['message' => 'Unauthorized'], 401);
        }

        $orders = DB::table('customer_orders')
            ->where(function ($query) use ($user) {
                // Use AND logic to ensure we only get the current customer's orders
                if (Schema::hasColumn('customer_orders', 'customer_id')) {
                    $query->where('customer_id', $user->id);
                } elseif (Schema::hasColumn('customer_orders', 'user_id')) {
                    $query->where('user_id', $user->id);
                } elseif (Schema::hasColumn('customer_orders', 'customer_email') && $user->email) {
                    $query->where('customer_email', $user->email);
                } else {
                    // Fallback: no orders if no proper customer identification field exists
                    $query->whereRaw('1 = 0');
                }
            })
            ->orderBy('created_at', 'desc')
            ->get()
            ->map(function ($order) {
                $orderId = $order->id;

                $itemsQuery = DB::table('customer_order_items');

                if (Schema::hasColumn('customer_order_items', 'customer_order_id')) {
                    $itemsQuery->where('customer_order_id', $orderId);
                } elseif (Schema::hasColumn('customer_order_items', 'order_id')) {
                    $itemsQuery->where('order_id', $orderId);
                }

                $items = $itemsQuery->get();

                return [
                    'id' => $order->id,
                    'order_number' => $order->order_number ?? null,
                    'reference_number' => $order->reference_number ?? null,
                    'customer_name' => $order->customer_name ?? null,
                    'customer_email' => $order->customer_email ?? null,
                    'subtotal' => (float) ($order->subtotal ?? 0),
                    'discount_amount' => (float) ($order->discount_amount ?? 0),
                    'total_amount' => (float) ($order->total_amount ?? $order->total ?? 0),
                    'payment_method' => $order->payment_method ?? null,
                    'payment_proof' => $order->payment_proof ?? null,
                    'payment_status' => $order->payment_status ?? 'pending',
                    'status' => $order->status ?? 'pending',
                    'created_at' => $order->created_at,
                    'updated_at' => $order->updated_at,
                    'items' => $items,
                ];
            });

        return response()->json([
            'success' => true,
            'data' => $orders,
        ]);
    }

    public function show(Request $request, $id)
    {
        $user = Auth::user();

        if (!$user) {
            return response()->json(['message' => 'Unauthorized'], 401);
        }

        $order = DB::table('customer_orders')
            ->where('id', $id)
            ->where(function ($q) use ($user) {
                if (Schema::hasColumn('customer_orders', 'customer_id')) {
                    $q->where('customer_id', $user->id);
                }
                if (Schema::hasColumn('customer_orders', 'user_id')) {
                    $q->orWhere('user_id', $user->id);
                }
                if (Schema::hasColumn('customer_orders', 'customer_email') && $user->email) {
                    $q->orWhere('customer_email', $user->email);
                }
            })
            ->first();

        if (!$order) {
            return response()->json(['message' => 'Order not found'], 404);
        }

        $orderId = $order->id;
        $itemsQuery = DB::table('customer_order_items');
        if (Schema::hasColumn('customer_order_items', 'customer_order_id')) {
            $itemsQuery->where('customer_order_id', $orderId);
        } elseif (Schema::hasColumn('customer_order_items', 'order_id')) {
            $itemsQuery->where('order_id', $orderId);
        }
        $items = $itemsQuery->get();

        return response()->json([
            'success' => true,
            'data' => [
                'id' => $order->id,
                'order_number' => $order->order_number ?? null,
                'reference_number' => $order->reference_number ?? null,
                'customer_name' => $order->customer_name ?? null,
                'customer_email' => $order->customer_email ?? null,
                'subtotal' => (float) ($order->subtotal ?? 0),
                'discount_amount' => (float) ($order->discount_amount ?? 0),
                'total_amount' => (float) ($order->total_amount ?? $order->total ?? 0),
                'payment_method' => $order->payment_method ?? null,
                'payment_proof' => $order->payment_proof ?? null,
                'payment_status' => $order->payment_status ?? 'pending',
                'status' => $order->status ?? 'pending',
                'created_at' => $order->created_at,
                'updated_at' => $order->updated_at,
                'items' => $items,
            ],
        ]);
    }

    public function uploadPaymentProof(Request $request, $id)
    {
        return $this->orderWorkflowsDisabled();

        $user = Auth::user();

        if (!$user) {
            return response()->json(['message' => 'Unauthorized'], 401);
        }

        $validated = $request->validate([
            'payment_method' => 'required|in:cash,gcash,maya',
            'payment_reference' => 'required_unless:payment_method,cash|nullable|string|max:255',
            'payment_proof' => 'required_unless:payment_method,cash|nullable|file|mimes:jpg,jpeg,png,pdf|max:5120',
        ]);

        // Ownership check with fallback for customer_id / user_id / customer_email
        $order = DB::table('customer_orders')
            ->where('id', $id)
            ->where(function ($q) use ($user) {
                if (Schema::hasColumn('customer_orders', 'customer_id')) {
                    $q->where('customer_id', $user->id);
                }
                if (Schema::hasColumn('customer_orders', 'user_id')) {
                    $q->orWhere('user_id', $user->id);
                }
                if (Schema::hasColumn('customer_orders', 'customer_email') && $user->email) {
                    $q->orWhere('customer_email', $user->email);
                }
            })
            ->first();

        if (!$order) {
            return response()->json(['message' => 'Order not found'], 404);
        }

        $paymentStatus = $order->payment_status ?? 'unpaid';

        if ($order->status !== 'approved' || !in_array($paymentStatus, ['unpaid', 'rejected'], true)) {
            return response()->json([
                'message' => 'Payment proof can only be uploaded for approved orders with unpaid or rejected payment status.',
            ], 422);
        }

        $update = [
            'payment_method' => $validated['payment_method'],
            'payment_status' => 'pending',
            'updated_at' => now(),
        ];

        if (Schema::hasColumn('customer_orders', 'payment_reference')) {
            $update['payment_reference'] = $validated['payment_reference'] ?? null;
        }

        $path = null;
        if ($request->hasFile('payment_proof')) {
            // Replaced proofs are retained as payment evidence (deleteOld: false).
            $path = FileStorageService::storeAndPersist(
                $request->file('payment_proof'), 'payment-proofs/orders', 'private',
                function (string $path) use ($order, $update) {
                    DB::table('customer_orders')->where('id', $order->id)->update($update + ['payment_proof' => $path]);
                    return $path;
                },
                deleteOld: false,
                prefix: 'order_proof',
            );
        } else {
            // Cash payments are verified by the cashier at the counter — no proof file.
            DB::table('customer_orders')->where('id', $order->id)->update($update);
        }

        $isCash = $validated['payment_method'] === 'cash';

        WorkflowNotifier::notifyUser(
            $user->id,
            'Payment Submitted',
            $isCash
                ? "Your cash payment for order #{$order->id} is pending verification at the counter."
                : "Payment proof for order #{$order->id} is under cashier verification.",
            'info',
            'customer_order',
            $order->id,
            ['payment_reference' => $validated['payment_reference'] ?? null]
        );

        WorkflowNotifier::notifyRole(
            'cashier',
            'Payment Needs Verification',
            $isCash
                ? "{$user->name} will pay in cash at the counter for order #{$order->id}."
                : "{$user->name} uploaded payment proof for order #{$order->id}.",
            'warning',
            'customer_order',
            $order->id,
            ['customer_email' => $user->email]
        );

        ActivityLog::log($user->id, 'payment_proof_uploaded', "Customer uploaded proof for order #{$order->id}", [
            'category' => 'payment',
            'reference_type' => 'customer_order',
            'reference_id' => $order->id,
        ]);

        return response()->json([
            'message' => 'Payment submitted and waiting for cashier verification.',
            'order_id' => $order->id,
            'payment_status' => 'pending',
            'payment_proof' => $path,
            'proof_url' => url('/api/files/payment-proofs/customer-order/' . $order->id . '/view'),
        ]);
    }

    public function receipt(Request $request, $id)
    {
        $user = Auth::user();

        if (!$user) {
            return response()->json(['message' => 'Unauthorized'], 401);
        }

        $order = DB::table('customer_orders')
            ->where('id', $id)
            ->where('customer_id', $user->id)
            ->first();

        if (!$order) {
            return response()->json(['message' => 'Receipt not found'], 404);
        }

        if (($order->payment_status ?? 'unpaid') !== 'paid') {
            return response()->json(['message' => 'Receipt is available only after cashier verification'], 422);
        }

        $items = DB::table('customer_order_items')
            ->where('customer_order_id', $id)
            ->get();

        $verifiedBy = $order->verified_by
            ? DB::table('users')->where('id', $order->verified_by)->value('name')
            : null;

        $totalAmount = (float) ($order->total_amount ?? 0);
        $vatAmount = EmailContent::vatInclusivePortion($totalAmount);

        return response()->json([
            'receipt' => [
                'order_id' => $order->id,
                'receipt_number' => $order->receipt_number,
                'customer_name' => $order->customer_name,
                'customer_email' => $order->customer_email,
                'items' => $items,
                'net_amount' => $vatAmount !== null ? round($totalAmount - $vatAmount, 2) : null,
                'vat_amount' => $vatAmount,
                'vat_rate' => 0.12,
                'total_amount' => $order->total_amount,
                'payment_method' => $order->payment_method,
                'payment_reference' => $order->reference_number ?? $order->payment_reference ?? null,
                'paid_at' => $order->paid_at,
                'verified_by' => $verifiedBy,
                'cashier_remarks' => $order->cashier_remarks,
            ],
        ]);
    }

    public function cancel(Request $request, $id)
    {
        return $this->orderWorkflowsDisabled();

        $user = Auth::user();

        if (!$user) {
            return response()->json(['message' => 'Unauthorized'], 401);
        }

        if (strtolower((string) $user->role) !== 'customer') {
            return response()->json(['message' => 'Only customers can cancel their own orders'], 403);
        }

        $validated = $request->validate([
            'cancellation_reason' => 'required|string|max:500',
        ]);

        $order = DB::table('customer_orders')
            ->where('id', $id)
            ->where('customer_id', $user->id)
            ->first();

        if (!$order) {
            return response()->json(['message' => 'Order not found'], 404);
        }

        if (($order->status ?? 'pending') !== 'pending') {
            return response()->json(['message' => 'Only pending orders can be cancelled'], 422);
        }

        try {
            DB::beginTransaction();

            // Update order status
            $updateData = [
                'status' => 'cancelled',
                'updated_at' => now(),
            ];

            // Add cancellation fields if they exist
            if (Schema::hasColumn('customer_orders', 'cancelled_by')) {
                $updateData['cancelled_by'] = $user->id;
            }
            if (Schema::hasColumn('customer_orders', 'cancelled_at')) {
                $updateData['cancelled_at'] = now();
            }
            if (Schema::hasColumn('customer_orders', 'cancellation_reason')) {
                $updateData['cancellation_reason'] = $validated['cancellation_reason'];
            }

            DB::table('customer_orders')->where('id', $order->id)->update($updateData);

            DB::commit();

            // Notify receptionist
            $orderNumber = $order->order_number ?? $order->id;
            WorkflowNotifier::notifyRole(
                'receptionist',
                'Customer Cancelled Order',
                "Customer {$user->name} cancelled order #{$orderNumber}. Reason: {$validated['cancellation_reason']}",
                'warning',
                'customer_order',
                $order->id,
                ['customer_email' => $user->email]
            );

            ActivityLog::log($user->id, 'customer_order_cancelled', "Customer cancelled order #{$order->id}", [
                'category' => 'order',
                'reference_type' => 'customer_order',
                'reference_id' => $order->id,
                'metadata' => ['cancellation_reason' => $validated['cancellation_reason']],
            ]);

            return response()->json([
                'success' => true,
                'message' => 'Order cancelled successfully',
                'order_id' => $order->id,
                'order_number' => $order->order_number,
            ]);

        } catch (\Exception $e) {
            DB::rollBack();
            Log::error('Customer order cancellation error', [
                'order_id' => $id,
                'user_id' => $user->id,
                'error' => $e->getMessage(),
            ]);

            return response()->json([
                'success' => false,
                'message' => 'Failed to cancel order. Please try again.',
            ], 500);
        }
    }

    private function setIfColumnExists(array &$data, string $table, string $column, $value): void
    {
        if (Schema::hasColumn($table, $column)) {
            $data[$column] = $value;
        }
    }

    private function generateOrderNumber(): string
    {
        return 'PAW-' . strtoupper(base_convert((string) time(), 10, 36)) . '-' . strtoupper(substr(md5((string) microtime(true)), 0, 4));
    }

    private function generateReferenceNumber(): string
    {
        return strtoupper(substr(md5(uniqid('', true)), 0, 12));
    }
}