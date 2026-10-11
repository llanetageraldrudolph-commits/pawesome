<?php

namespace App\Http\Controllers\Cashier;

use App\Http\Controllers\Controller;
use App\Models\Sale;
use App\Models\Appointment;
use App\Models\InventoryItem;
use App\Models\ActivityLog;
use App\Models\User;
use App\Services\WorkflowNotifier;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Schema;
use App\Services\PaymentVerificationService;
use App\Services\ServiceCatalog;
use App\Support\EmailContent;

class DashboardController extends Controller
{
    private function overviewData(): array
    {
        $today = Carbon::today();
        $user = Auth::user();

        $lowStockItems = InventoryItem::whereColumn('stock', '<=', 'threshold')
            ->where('stock', '>', 0)
            ->get()
            ->map(function ($item) {
                return [
                    'id' => $item->id,
                    'name' => $item->name,
                    'sku' => $item->sku,
                    'stock' => $item->stock,
                    'threshold' => $item->threshold,
                ];
            });

        // Fix: query sale_items (not sales.product_id) for accurate top-selling data
        $topSellingProducts = DB::table('sale_items')
            ->join('sales', 'sale_items.sale_id', '=', 'sales.id')
            ->whereNotNull('sale_items.product_id')
            ->whereMonth('sales.created_at', $today->month)
            ->selectRaw('sale_items.product_id, SUM(sale_items.quantity) as units_sold, SUM(sale_items.total_price) as revenue')
            ->groupBy('sale_items.product_id')
            ->orderByDesc('units_sold')
            ->limit(5)
            ->get()
            ->map(function ($row) {
                $product = InventoryItem::find($row->product_id);
                return [
                    'id' => $row->product_id,
                    'name' => $product ? $product->name : 'Unknown',
                    'units_sold' => (int) $row->units_sold,
                    'revenue' => (float) $row->revenue,
                ];
            });

        $pendingOrders = Appointment::where('status', 'approved')
            ->with(['pet', 'customer'])
            ->limit(5)
            ->get()
            ->map(function ($appointment) {
                $waitingTime = $appointment->scheduled_at
                    ? Carbon::parse($appointment->scheduled_at)->diffInMinutes(now()) . ' min'
                    : '0 min';
                return [
                    'id' => $appointment->id,
                    'customer' => $appointment->customer ? $appointment->customer->name : 'Guest',
                    'total' => $appointment->service ? $appointment->service->price : 0,
                    'waiting_time' => $waitingTime,
                ];
            });

        // Cashier-relevant: count ALL service requests across all customers (not by cashier email)
        $pendingServiceRequests = \App\Models\ServiceRequest::where('status', 'pending')->count();
        $approvedServiceRequests = \App\Models\ServiceRequest::where('status', 'approved')->count();
        $paymentPendingServiceRequests = \App\Models\ServiceRequest::where('payment_status', 'pending')->count();
        $paidServiceRequests = \App\Models\ServiceRequest::where('payment_status', 'paid')->count();

        $salesByType = Sale::selectRaw('payment_type, COUNT(*) as count, SUM(amount) as total')
            ->whereDate('created_at', $today)
            ->groupBy('payment_type')
            ->get()
            ->map(function ($sale) {
                return [
                    'type' => $sale->payment_type ?? 'cash',
                    'count' => $sale->count,
                    'total' => $sale->total,
                ];
            });

        return [
            'today_sales' => Sale::whereDate('created_at', $today)->sum('amount'),
            'today_transactions' => Sale::whereDate('created_at', $today)->count(),
            'monthly_sales' => Sale::whereMonth('created_at', $today->month)->sum('amount'),
            'monthly_transactions' => Sale::whereMonth('created_at', $today->month)->count(),
            'pending_payments' => Appointment::where('status', 'approved')->count(),
            'completed_payments' => Sale::where('type', 'appointment')->count(),
            'recent_sales' => Sale::latest()->limit(10)->get(),
            'sales_by_type' => $salesByType,
            'low_stock_items' => $lowStockItems,
            'top_selling_products' => $topSellingProducts,
            'pending_orders' => $pendingOrders,
            'pending_service_requests' => $pendingServiceRequests,
            'approved_service_requests' => $approvedServiceRequests,
            'payment_pending' => $paymentPendingServiceRequests,
            'payment_paid' => $paidServiceRequests,
        ];
    }

    public function overview()
    {
        return response()->json($this->overviewData());
    }

    public function overviewWrapped()
    {
        return response()->json(['data' => $this->overviewData()]);
    }

    public function sales(Request $request)
    {
        $perPage = (int) $request->get('per_page', 50);
        $page    = (int) $request->get('page', 1);

        $query = Sale::latest();

        if ($request->filled('status')) {
            $query->where('status', $request->status);
        }
        if ($request->filled('date_from')) {
            $query->whereDate('created_at', '>=', $request->date_from);
        }
        if ($request->filled('date_to')) {
            $query->whereDate('created_at', '<=', $request->date_to);
        }

        $sales = $query->paginate($perPage, ['*'], 'page', $page);

        return response()->json($sales);
    }

    public function transactions(?Request $request = null)
    {
        $perPage = $request ? (int) $request->get('per_page', 50) : 50;
        $page    = $request ? (int) $request->get('page', 1) : 1;
        $search  = $request ? trim((string) $request->get('search', '')) : '';
        $method  = $request ? $request->get('method', 'all') : 'all';
        $dateFilter = $request ? $request->get('date_filter', 'all') : 'all';

        // Get traditional sales (POS transactions)
        $sales = Sale::latest()->limit(200)->get()->map(function ($sale) {
            return [
                'id' => 'SALE-' . $sale->id,
                'transaction_id' => $sale->id,
                'customer' => $sale->customer ? $sale->customer->name : 'Walk-in Customer',
                'customer_name' => $sale->customer ? $sale->customer->name : 'Walk-in Customer',
                'amount' => $sale->amount,
                'method' => $sale->payment_type ?? 'cash',
                'payment_method' => $sale->payment_type ?? 'cash',
                'type' => 'pos_sale',
                'source' => 'pos',
                'date' => $sale->created_at,
                'created_at' => $sale->created_at,
                'status' => $sale->status ?? 'completed',
            ];
        });

        // Get online payments from customer orders
        $customerOrders = DB::table('customer_orders')
            ->where('payment_status', 'paid')
            ->orderBy('paid_at', 'desc')
            ->limit(50)
            ->get()
            ->map(function ($order) {
                return [
                    'id' => 'ORDER-' . $order->id,
                    'transaction_id' => $order->id,
                    'customer' => $order->customer_name ?? 'Customer #' . $order->customer_id,
                    'customer_name' => $order->customer_name ?? 'Customer #' . $order->customer_id,
                    'amount' => $order->total_amount,
                    'method' => $order->payment_method ?? 'Online Payment',
                    'payment_method' => $order->payment_method ?? 'Online Payment',
                    'type' => 'online_order',
                    'source' => 'customer_order',
                    'date' => $order->paid_at ?? $order->updated_at,
                    'created_at' => $order->paid_at ?? $order->updated_at,
                    'status' => $order->status,
                    'payment_reference' => $order->payment_reference,
                    'receipt_number' => $order->receipt_number,
                ];
            });

        // Get veterinary/service payments from service requests
        $serviceRequests = DB::table('service_requests')
            ->where('payment_status', 'paid')
            ->orderBy('paid_at', 'desc')
            ->limit(50)
            ->get()
            ->map(function ($request) {
                return [
                    'id' => 'SERVICE-' . $request->id,
                    'transaction_id' => $request->id,
                    'customer' => $request->customer_name ?? 'Customer',
                    'customer_name' => $request->customer_name ?? 'Customer',
                    'amount' => $request->total_amount ?? $request->price ?? $request->service_price ?? 500,
                    'method' => $request->payment_method ?? 'Service Payment',
                    'payment_method' => $request->payment_method ?? 'Service Payment',
                    'type' => 'service_payment',
                    'source' => 'service_request',
                    'service_type' => $request->request_type ?? 'service',
                    'service_name' => $request->service_name ?? 'Service',
                    'pet_name' => $request->pet_name,
                    'date' => $request->paid_at ?? $request->updated_at,
                    'created_at' => $request->paid_at ?? $request->updated_at,
                    'status' => $request->status,
                    'payment_reference' => $request->payment_reference,
                    'receipt_number' => $request->receipt_number,
                ];
            });

        // Service payments settled through the payment ledger — boarding,
        // veterinary, grooming, confinement, and à-la-carte item payments.
        // 'service_request' settlements are skipped: that leg is already
        // rendered above from the service_requests table.
        $settlementRows = DB::table('payment_settlements')
            ->where('status', 'paid')
            ->where('settleable_type', '!=', 'service_request')
            ->orderBy('paid_at', 'desc')
            ->limit(100)
            ->get();

        $settlementCustomers = \App\Models\Customer::whereIn('id', $settlementRows->pluck('customer_id')->filter()->unique()->values())
            ->pluck('name', 'id');

        $settlements = $settlementRows->map(function ($settlement) use ($settlementCustomers) {
                $typeLabel = match ($settlement->settleable_type) {
                    'boarding' => 'boarding_payment',
                    'appointment', 'veterinary' => 'veterinary_payment',
                    'grooming' => 'grooming_payment',
                    'medical_confinement' => 'confinement_payment',
                    default => 'service_payment',
                };
                $customerName = $settlementCustomers[$settlement->customer_id] ?? 'Customer #' . ($settlement->customer_id ?? '?');
                return [
                    'id' => 'SETTLEMENT-' . $settlement->id,
                    'transaction_id' => $settlement->id,
                    'customer' => $customerName,
                    'customer_name' => $customerName,
                    'amount' => $settlement->amount,
                    'method' => $settlement->payment_method ?? 'Service Payment',
                    'payment_method' => $settlement->payment_method ?? 'Service Payment',
                    'type' => $typeLabel,
                    'source' => 'payment_settlement',
                    'service_type' => $settlement->settleable_type,
                    'service_id' => $settlement->settleable_id,
                    'date' => $settlement->paid_at ?? $settlement->created_at,
                    'created_at' => $settlement->paid_at ?? $settlement->created_at,
                    'status' => $settlement->status,
                    'payment_reference' => $settlement->reference_number,
                    'receipt_number' => $settlement->receipt_number,
                ];
            });

        // Combine all transactions and sort by date (most recent first)
        $allTransactions = $sales
            ->concat($customerOrders)
            ->concat($serviceRequests)
            ->concat($settlements)
            ->sortByDesc('date')
            ->values();

        // Apply search filter
        if ($search) {
            $keyword = strtolower($search);
            $allTransactions = $allTransactions->filter(function ($t) use ($keyword) {
                return str_contains(strtolower($t['customer'] ?? ''), $keyword)
                    || str_contains(strtolower($t['id'] ?? ''), $keyword)
                    || str_contains(strtolower($t['method'] ?? ''), $keyword);
            })->values();
        }

        // Apply payment method filter
        if ($method && $method !== 'all') {
            $allTransactions = $allTransactions->filter(function ($t) use ($method) {
                return strtolower($t['method'] ?? '') === strtolower($method);
            })->values();
        }

        // Apply date filter
        if ($dateFilter && $dateFilter !== 'all') {
            $now = now();
            $allTransactions = $allTransactions->filter(function ($t) use ($dateFilter, $now) {
                $date = \Carbon\Carbon::parse($t['date'] ?? null);
                if (!$date) return false;
                if ($dateFilter === 'today')  return $date->isToday();
                if ($dateFilter === 'week')   return $date->gte($now->copy()->subDays(7));
                if ($dateFilter === 'month')  return $date->gte($now->copy()->subDays(30));
                return true;
            })->values();
        }

        $total = $allTransactions->count();
        $offset = ($page - 1) * $perPage;
        $paginated = $allTransactions->slice($offset, $perPage)->values();

        return response()->json([
            'transactions' => $paginated,
            'data' => $paginated,
            'salespeople' => User::whereIn('role', ['cashier', 'admin', 'manager'])
                ->orderBy('name')
                ->get(['id', 'name', 'role']),
            'meta' => [
                'total'        => $total,
                'per_page'     => $perPage,
                'current_page' => $page,
                'last_page'    => max(1, (int) ceil($total / $perPage)),
            ],
        ]);
    }

    public function history(?Request $request = null)
    {
        return $this->transactions($request);
    }

    public function searchTransactions(Request $request)
    {
        $query = $request->get('q', '');

        $transactions = Sale::where('id', 'like', "%{$query}%")
            ->orWhereHas('customer', function ($q) use ($query) {
                $q->where('name', 'like', "%{$query}%");
            })
            ->orWhere('amount', 'like', "%{$query}%")
            ->with(['customer'])
            ->limit(20)
            ->get()
            ->map(function ($sale) {
                return [
                    'id' => $sale->id,
                    'customer' => $sale->customer ? $sale->customer->name : 'Guest',
                    'payment_type' => $sale->payment_type ?? 'cash',
                    'amount' => $sale->amount,
                    'date' => $sale->created_at->format('Y-m-d'),
                ];
            });

        return response()->json($transactions);
    }

    public function refund(Request $request)
    {
        $validated = $request->validate([
            'transaction_id' => 'required',
            'amount' => 'nullable|numeric|min:0',
            'refund_amount' => 'nullable|numeric|min:0',
            'reason' => 'required|string',
            'cashier_name' => 'required|string',
        ]);

        // Create refund record
        $refund = Sale::create([
            'amount' => $validated['amount'] ?? $validated['refund_amount'] ?? 0,
            'type' => 'refund',
            'status' => 'completed',
            'payment_type' => 'refund',
            'notes' => 'Refund for ' . $validated['transaction_id'] . ': ' . $validated['reason'],
        ]);

        return response()->json([
            'success' => true,
            'refund_id' => $refund->id,
        ]);
    }

    public function multiPayment(Request $request)
    {
        $validated = $request->validate([
            'cash_amount' => 'required|numeric|min:0',
            'card_amount' => 'required|numeric|min:0',
            'total_amount' => 'required|numeric|min:0',
            'transaction_id' => 'nullable',
        ]);

        // Create multi-payment record
        $payment = Sale::create([
            'amount' => $validated['total_amount'],
            'type' => 'multi_payment',
            'status' => 'completed',
            'payment_type' => 'multi',
            'cash_amount' => $validated['cash_amount'],
            'card_amount' => $validated['card_amount'],
            'notes' => isset($validated['transaction_id']) ? 'Split payment for ' . $validated['transaction_id'] : null,
        ]);

        return response()->json([
            'success' => true,
            'transaction_id' => $payment->id,
        ]);
    }

    public function applyDiscount(Request $request)
    {
        $validated = $request->validate([
            'code' => 'required|string',
            'transaction_id' => 'nullable',
        ]);

        // Simple discount logic - in production, check against discount codes table
        $discountAmount = 0;
        $discountPercent = 0;

        // Example discount codes
        switch (strtoupper($validated['code'])) {
            case 'DISCOUNT10':
                $discountPercent = 10;
                break;
            case 'SAVE20':
                $discountPercent = 20;
                break;
            case 'WELCOME':
                $discountPercent = 15;
                break;
        }

        // Get transaction amount
        $transaction = isset($validated['transaction_id']) ? Sale::find($validated['transaction_id']) : null;
        if ($transaction) {
            $discountAmount = ($transaction->amount * $discountPercent) / 100;
            $newTotal = $transaction->amount - $discountAmount;
        } else {
            $newTotal = 0;
        }

        return response()->json([
            'success' => true,
            'discount_amount' => $discountAmount,
            'new_total' => $newTotal,
        ]);
    }

    public function generateReceipt($id)
    {
        $transaction = Sale::with(['customer', 'items'])->find($id);

        if (!$transaction) {
            return response()->json(['error' => 'Transaction not found'], 404);
        }

        // Sales store VAT-inclusive subtotal; tax_amount is the extracted
        // 12% portion and net_amount is the ex-VAT base.
        $subtotal = (float) ($transaction->subtotal ?? $transaction->amount ?? 0);
        $vatAmount = $transaction->tax_amount !== null
            ? (float) $transaction->tax_amount
            : EmailContent::vatInclusivePortion($subtotal);

        return response()->json([
            'transaction_id' => $transaction->id,
            'items' => $transaction->items ?? [],
            'net_amount' => $vatAmount !== null ? round($subtotal - $vatAmount, 2) : null,
            'vat_amount' => $vatAmount,
            'vat_rate' => 0.12,
            'subtotal' => $subtotal,
            'total' => $transaction->amount,
            'date' => $transaction->created_at->format('Y-m-d H:i:s'),
            'customer' => $transaction->customer ? $transaction->customer->name : 'Guest',
            'payment_type' => $transaction->payment_type ?? 'cash',
        ]);
    }

    public function handover(Request $request)
    {
        $validated = $request->validate([
            'note' => 'required|string',
            'cashier_name' => 'required|string',
        ]);

        ActivityLog::logForAuthUser('cashier_handover', $validated['note'], [
            'category' => 'cashier',
            'subcategory' => 'handover',
            'reference_type' => 'cashier_handover',
            'reference_id' => Auth::id(),
            'metadata' => [
                'cashier_name' => $validated['cashier_name'],
                'shift_date' => now()->toIso8601String(),
            ],
        ]);

        return response()->json([
            'success' => true,
            'message' => 'Handover note saved successfully',
        ]);
    }

    public function getLastHandover()
    {
        $lastHandover = ActivityLog::where('action', 'cashier_handover')
            ->where('user_id', Auth::id())
            ->latest()
            ->first();

        return response()->json([
            'success' => true,
            'handover' => $lastHandover ? [
                'note' => $lastHandover->description,
                'cashier_name' => $lastHandover->metadata['cashier_name'] ?? null,
                'shift_date' => $lastHandover->metadata['shift_date'] ?? null,
                'created_at' => $lastHandover->created_at->toIso8601String(),
            ] : null,
        ]);
    }

    public function endShift(Request $request)
    {
        $data = $request->validate([
            'cashier_name' => 'nullable|string',
            'shift_date' => 'nullable|date',
            'total_sales' => 'nullable|numeric|min:0',
            'total_transactions' => 'nullable|integer|min:0',
            'cash_collected' => 'nullable|numeric|min:0',
            'expected_cash' => 'nullable|numeric|min:0',
            'actual_cash' => 'nullable|numeric|min:0',
            'cash_difference' => 'nullable|numeric',
            'note' => 'nullable|string',
        ]);

        ActivityLog::logForAuthUser('cashier_end_shift', $data['note'] ?? 'Shift ended', [
            'category' => 'cashier',
            'subcategory' => 'end_shift',
            'reference_type' => 'cashier_shift',
            'reference_id' => Auth::id(),
            'metadata' => array_merge($data, [
                'submitted_at' => now()->toIso8601String(),
            ]),
        ]);

        return response()->json([
            'success' => true,
            'message' => 'Shift report submitted successfully',
            'shift_report' => array_merge($data, [
                'id' => 'SHIFT-' . now()->format('YmdHis'),
                'submitted_at' => now()->toIso8601String(),
            ]),
        ]);
    }

    public function getLastShiftReport()
    {
        $lastShift = ActivityLog::where('action', 'cashier_end_shift')
            ->where('user_id', Auth::id())
            ->latest()
            ->first();

        return response()->json([
            'success' => true,
            'shift_report' => $lastShift ? array_merge(
                $lastShift->metadata ?? [],
                ['created_at' => $lastShift->created_at->toIso8601String()]
            ) : null,
        ]);
    }

    public function voidTransaction(Request $request)
    {
        $validated = $request->validate([
            'transaction_id' => 'required',
            'reason' => 'required|string',
            'cashier_name' => 'required|string',
        ]);

        // Strip common prefixes to get numeric ID
        $rawId = $validated['transaction_id'];
        $numericId = preg_replace('/^(SALE-|TRX-|ORDER-|SERVICE-)/i', '', $rawId);

        // Find and void the transaction
        $transaction = Sale::find($numericId);
        if (!$transaction) {
            return response()->json([
                'success' => false,
                'message' => 'Transaction not found.',
            ], 404);
        }

        $transaction->status = 'voided';
        $transaction->void_reason = $validated['reason'];
        $transaction->voided_by = $validated['cashier_name'];
        $transaction->voided_at = now();
        $transaction->save();

        return response()->json([
            'success' => true,
            'message' => 'Transaction voided successfully.',
        ]);
    }

    // Payment Verification Methods
    public function getPaymentRequests()
    {
        // Get service request payments
        $serviceRequests = DB::table('service_requests')
            ->where('status', 'approved')
            ->whereIn('payment_status', ['pending', 'unpaid', 'rejected'])
            ->where(function ($q) {
                // 'unpaid'/'rejected' rows are counter collections — always
                // listed. 'pending' rows need a submitted proof or a
                // declared cash intent.
                $q->whereIn('payment_status', ['unpaid', 'rejected'])
                  ->orWhereNotNull('payment_proof')
                  ->orWhere('payment_method', 'cash');
            })
            ->orderBy('updated_at', 'desc')
            ->get()
            ->map(function ($request) {
                return [
                    'id' => $request->id,
                    'payable_type' => 'service_request',
                    'type' => 'service_request',
                    'source' => 'service_request',
                    'payment_source' => 'service_request',
                    'customer_name' => $request->customer_name ?? 'Customer',
                    'customer_email' => $request->customer_email,
                    'pet_name' => $request->pet_name,
                    'request_type' => $request->request_type ?? $request->service_type ?? 'Service',
                    'service_name' => $request->service_name ?? $request->request_type ?? 'Service Request',
                    'amount' => $this->serviceRequestQueueAmount($request),
                    // A rejected online attempt is settled at the counter —
                    // present it as a cash collection, not a stale e-wallet row.
                    'payment_method' => $request->payment_status === 'rejected' ? null : $request->payment_method,
                    'payment_reference' => $request->payment_reference ?? null,
                    'payment_proof' => $request->payment_proof,
                    'proof_url' => $request->payment_proof ? url('/api/files/payment-proofs/service-request/' . $request->id . '/view') : null,
                    'request_date' => $request->updated_at,
                    'status' => $request->status,
                    'payment_status' => $request->payment_status,
                ];
            });

        // Records created from a listed service_request are paid through the
        // service_request leg — listing them again would duplicate the booking.
        $listedServiceRequestIds = $serviceRequests->pluck('id')->all();
        $excludeLinked = function ($query) use ($listedServiceRequestIds) {
            $query->where(function ($q) use ($listedServiceRequestIds) {
                $q->whereNull('service_request_id')
                  ->orWhereNotIn('service_request_id', $listedServiceRequestIds);
            });
        };

        $boardings = DB::table('boardings')
            ->where($excludeLinked)
            ->whereIn('status', ['pending', 'approved', 'scheduled', 'checked_in', 'in_care', 'ready_for_pickup'])
            ->whereIn('payment_status', ['pending', 'unpaid', 'rejected'])
            ->where(function ($q) {
                // 'unpaid'/'rejected' rows are counter collections (cash at the
                // desk) — always listed. Walk-in bookings (pending status)
                // likewise have no proof yet. Other rows: only show if the
                // customer uploaded proof or indicated cash.
                $q->whereIn('payment_status', ['unpaid', 'rejected'])
                  ->orWhere('status', 'pending')
                  ->orWhereNotNull('payment_proof')
                  ->orWhere('payment_method', 'cash');
            })
            ->orderBy('updated_at', 'desc')
            ->get()
            ->map(function ($boarding) {
                $fallback = (float) ($boarding->total_amount ?? 0);
                if ($fallback <= 0 && is_numeric($boarding->rate_per_day ?? null)) {
                    $fallback = (float) $boarding->rate_per_day * max(1, (int) ($boarding->number_of_days ?? 1));
                }

                return [
                    'id' => $boarding->id,
                    'payable_type' => 'boarding',
                    'type' => 'boarding',
                    'source' => 'boarding',
                    'payment_source' => 'boarding',
                    'customer_name' => $boarding->customer_name ?? 'Customer',
                    'customer_email' => $boarding->customer_email,
                    'pet_name' => $boarding->pet_name,
                    'request_type' => 'Pet Boarding',
                    'service_name' => 'Pet Hotel Boarding #' . $boarding->id,
                    'amount' => $this->queueAmount('boarding', (int) $boarding->id, null, 'hotel', $fallback),
                    'payment_method' => $boarding->payment_status === 'rejected' ? null : $boarding->payment_method,
                    'payment_reference' => $boarding->payment_reference,
                    'payment_proof' => $boarding->payment_proof,
                    'proof_url' => $boarding->payment_proof ? url('/api/files/payment-proofs/boarding/' . $boarding->id . '/view') : null,
                    'request_date' => $boarding->updated_at,
                    'status' => $boarding->status,
                    'payment_status' => $boarding->payment_status,
                ];
            });

        $confinements = DB::table('medical_confinements')
            ->whereIn('payment_status', ['pending', 'unpaid', 'rejected'])
            ->where(function ($q) {
                // 'unpaid'/'rejected' = counter collection — no valid proof.
                $q->whereIn('payment_status', ['unpaid', 'rejected'])
                  ->orWhereNotNull('payment_proof')
                  ->orWhere('payment_method', 'cash');
            })
            ->orderBy('updated_at', 'desc')
            ->get()
            ->map(function ($confinement) {
                return [
                    'id' => $confinement->id,
                    'payable_type' => 'medical_confinement',
                    'type' => 'medical_confinement',
                    'source' => 'medical_confinement',
                    'payment_source' => 'medical_confinement',
                    'customer_name' => $confinement->customer_name ?? 'Customer',
                    'customer_email' => $confinement->customer_email,
                    'pet_name' => $confinement->pet_name,
                    'request_type' => 'Medical Confinement',
                    'service_name' => 'Medical Confinement #' . $confinement->id,
                    'amount' => $confinement->final_amount ?? $confinement->estimated_cost ?? 0,
                    'payment_method' => $confinement->payment_status === 'rejected' ? null : $confinement->payment_method,
                    'payment_reference' => $confinement->payment_reference,
                    'payment_proof' => $confinement->payment_proof,
                    'proof_url' => $confinement->payment_proof ? url('/api/files/payment-proofs/medical_confinement/' . $confinement->id . '/view') : null,
                    'request_date' => $confinement->updated_at,
                    'status' => $confinement->status,
                    'payment_status' => $confinement->payment_status,
                ];
            });

        // Get veterinary consultations awaiting payment (walk-in or online)
        // Include pending/approved so walk-in bookings created by receptionist are visible;
        // cashier can see the booking and will collect payment when status reaches awaiting_payment.
        $appointments = Appointment::with(['customer', 'pet', 'service'])
            ->where($excludeLinked)
            ->whereIn('status', ['pending', 'approved', 'in_consultation', 'needs_confinement', 'awaiting_payment', 'treated'])
            ->whereIn('payment_status', ['unpaid', 'pending', 'rejected'])
            ->orderBy('updated_at', 'desc')
            ->get()
            ->map(function ($appointment) {
                return [
                    'id' => $appointment->id,
                    'payable_type' => 'appointment',
                    'type' => 'appointment',
                    'source' => 'appointment',
                    'payment_source' => 'appointment',
                    'customer_name' => $appointment->customer?->name ?? 'Customer',
                    'customer_email' => $appointment->customer?->email,
                    'pet_name' => $appointment->pet?->name,
                    'request_type' => 'appointment',
                    'service_name' => $appointment->service?->name ?? 'Veterinary Consultation',
                    'amount' => $this->queueAmount('veterinary', (int) $appointment->id, $appointment->service?->name, 'vet', (float) ($appointment->total_amount ?? $appointment->balance_due ?? $appointment->price ?? $appointment->service?->price ?? 0)),
                    'payment_method' => $appointment->payment_method,
                    'payment_reference' => $appointment->payment_reference,
                    'payment_proof' => $appointment->payment_proof,
                    'proof_url' => $appointment->payment_proof ? url('/api/files/payment-proofs/appointment/' . $appointment->id . '/view') : null,
                    'request_date' => $appointment->updated_at,
                    'status' => $appointment->status,
                    'payment_status' => $appointment->payment_status,
                ];
            });

        // Get grooming appointments pending payment (walk-in and online)
        $groomings = DB::table('groomings')
            ->where($excludeLinked)
            ->whereNotIn('status', ['completed', 'cancelled', 'rejected'])
            ->whereIn('payment_status', ['pending', 'unpaid', 'rejected'])
            ->orderBy('updated_at', 'desc')
            ->get()
            ->map(function ($grooming) {
                $customer = DB::table('customers')->where('id', $grooming->customer_id)->first();
                $pet      = DB::table('pets')->where('id', $grooming->pet_id)->first();
                return [
                    'id'               => $grooming->id,
                    'payable_type'     => 'grooming',
                    'type'             => 'grooming',
                    'source'           => 'grooming',
                    'payment_source'   => 'grooming',
                    'customer_name'    => $customer?->name ?? 'Customer',
                    'customer_email'   => $customer?->email ?? null,
                    'pet_name'         => $pet?->name ?? null,
                    'request_type'     => 'Grooming',
                    'service_name'     => $grooming->service ?? 'Grooming Service',
                    'amount'           => $this->queueAmount('grooming', (int) $grooming->id, $grooming->service ?? null, 'grooming', (float) ($grooming->total_amount ?? $grooming->amount ?? $grooming->base_amount ?? $grooming->balance_due ?? 0)),
                    'payment_method'   => $grooming->payment_status === 'rejected' ? null : ($grooming->payment_method ?? null),
                    'payment_reference'=> $grooming->payment_reference ?? null,
                    'payment_proof'    => $grooming->payment_proof ?? null,
                    'proof_url'        => $grooming->payment_proof
                        ? url('/api/files/payment-proofs/grooming/' . $grooming->id . '/view')
                        : null,
                    'request_date'     => $grooming->updated_at,
                    'status'           => $grooming->status,
                    'payment_status'   => $grooming->payment_status,
                ];
            });

        $allPayments = $serviceRequests->concat($boardings)->concat($confinements)->concat($appointments)->concat($groomings);

        return response()->json(['payments' => $allPayments]);
    }

    /**
     * Authoritative queue amount for a payable record: persisted total →
     * itemized bill → catalog price for its service bucket. A payable row
     * should never surface in the cashier queue as ₱0.
     */
    private function queueAmount(string $serviceType, int $serviceId, ?string $serviceName, string $bucket, float $fallback): float
    {
        if ($fallback > 0) {
            return $fallback;
        }

        $billed = (float) DB::table('service_item_usages')
            ->where('service_type', $serviceType)
            ->where('service_id', $serviceId)
            ->where('is_billable', true)
            ->sum('total_price');

        if ($billed > 0) {
            return $billed;
        }

        return ServiceCatalog::priceFor($serviceName, $bucket);
    }

    /**
     * Queue amount for a service_request. The SR itself may carry no price
     * (customer-submitted requests often don't) — the authoritative total
     * lives on the linked grooming/boarding/appointment record created at
     * approval, or in its itemized bill, or in the services catalog.
     */
    private function serviceRequestQueueAmount(object $serviceRequest): float
    {
        foreach (['total_amount', 'price', 'service_price'] as $column) {
            $value = $serviceRequest->{$column} ?? null;
            if (is_numeric($value) && (float) $value > 0) {
                return (float) $value;
            }
        }

        $bucket = ServiceCatalog::bucketFor($serviceRequest->request_type ?? $serviceRequest->service_type ?? null);

        [$table, $serviceType] = match ($bucket) {
            'grooming' => ['groomings', 'grooming'],
            'hotel' => ['boardings', 'boarding'],
            'vet' => ['appointments', 'veterinary'],
            default => [null, null],
        };

        if ($table && Schema::hasColumn($table, 'service_request_id')) {
            $linked = DB::table($table)->where('service_request_id', $serviceRequest->id)->first();
            if ($linked) {
                $fallback = (float) ($linked->total_amount ?? $linked->amount ?? $linked->price ?? 0);
                $amount = $this->queueAmount(
                    $serviceType,
                    (int) $linked->id,
                    $serviceRequest->service_name ?? $linked->service ?? null,
                    $bucket,
                    $fallback
                );
                if ($amount > 0) {
                    return $amount;
                }
            }
        }

        $amount = ServiceCatalog::priceFor($serviceRequest->service_name ?? null, $bucket);

        // Preserve the legacy estimate floor for request types with no
        // catalog representation at all — never surface ₱0 in the queue.
        return $amount > 0 ? $amount : 500.0;
    }

    public function verifyPayment(Request $request, $id)
    {
        $type = $request->input('type', $request->route('type', 'customer_order'));
        $svc = new PaymentVerificationService();
        $result = $svc->verify($type, (int) $id, $request);
        $status = $result['status'] ?? 200;
        return response()->json($result, $status);
    }

    private function verifyServiceRequestPayment(Request $request, $id)
    {
        try {
            $serviceRequest = DB::table('service_requests')->where('id', $id)->first();

            if (!$serviceRequest) {
                return response()->json(['message' => 'Service request not found'], 404);
            }

            if ($serviceRequest->payment_status !== 'pending') {
                return response()->json([
                    'message' => 'Only pending payment proofs can be verified',
                    'current_status' => $serviceRequest->payment_status
                ], 422);
            }

            $receiptNumber = 'SR-REC-' . now()->format('YmdHis') . '-' . $id;

            DB::table('service_requests')
                ->where('id', $id)
                ->update([
                    'payment_status' => 'paid',
                    'paid_at' => now(),
                    'verified_by' => Auth::id(),
                    'cashier_remarks' => $request->input('cashier_remarks', 'Payment verified by cashier'),
                    'receipt_number' => $receiptNumber,
                ]);

            ActivityLog::log(Auth::id(), 'payment_verified', "Cashier verified payment for service request #{$id}", [
                'category' => 'payment',
                'reference_type' => 'service_request',
                'reference_id' => $id,
                'metadata' => ['receipt_number' => $receiptNumber],
            ]);

            return response()->json([
                'success' => true,
                'message' => 'Service request payment verified successfully.',
                'receipt_number' => $receiptNumber,
                'request' => $serviceRequest,
            ]);

        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Failed to verify payment: ' . $e->getMessage()
            ], 500);
        }
    }

    private function verifyCustomerOrderPayment(Request $request, $id)
    {
        $order = DB::table('customer_orders')->where('id', $id)->first();

        if (!$order) {
            return response()->json(['message' => 'Payment request not found'], 404);
        }

        if (($order->payment_status ?? 'unpaid') !== 'pending') {
            return response()->json(['message' => 'Only pending payment proofs can be verified'], 422);
        }

        $receiptNumber = $order->receipt_number ?? ('REC-' . now()->format('YmdHis') . '-' . $order->id);

        // Note: Stock deduction should happen during receptionist order approval, not during payment verification
        // Cashier only updates payment status and generates receipt

        DB::table('customer_orders')
            ->where('id', $id)
            ->update([
                'payment_status' => 'paid',
                'paid_at' => now(),
                'verified_by' => Auth::id(),
                'cashier_remarks' => $request->input('cashier_remarks'),
                'receipt_number' => $receiptNumber,
                'updated_at' => now(),
            ]);

        WorkflowNotifier::notifyUser(
            $order->customer_id,
            'Payment Verified',
            "Payment for order #{$id} was verified. Receipt: {$receiptNumber}.",
            'success',
            'customer_order',
            $id,
            ['receipt_number' => $receiptNumber]
        );

        ActivityLog::log(Auth::id(), 'payment_verified', "Cashier verified payment for order #{$id}", [
            'category' => 'payment',
            'reference_type' => 'customer_order',
            'reference_id' => $id,
            'metadata' => ['receipt_number' => $receiptNumber],
        ]);

        return response()->json([
            'message' => 'Payment verified successfully',
            'payment_status' => 'paid',
            'receipt_number' => $receiptNumber,
        ]);
    }

    public function rejectPayment(Request $request, $id)
    {
        $type = $request->input('type', $request->route('type', 'customer_order'));
        $svc = new PaymentVerificationService();
        $result = $svc->reject($type, (int) $id, $request);
        $status = $result['status'] ?? 200;
        return response()->json($result, $status);
    }

    private function rejectServiceRequestPayment(Request $request, $id)
    {
        try {
            $serviceRequest = DB::table('service_requests')->where('id', $id)->first();

            if (!$serviceRequest) {
                return response()->json(['message' => 'Service request not found'], 404);
            }

            if ($serviceRequest->payment_status !== 'pending') {
                return response()->json([
                    'message' => 'Only pending payment proofs can be rejected',
                    'current_status' => $serviceRequest->payment_status
                ], 422);
            }

            $rejectionReason = $request->input('rejection_reason');

            DB::table('service_requests')
                ->where('id', $id)
                ->update([
                    'payment_status' => 'rejected',
                    'rejected_by' => Auth::id(),
                    'rejected_at' => now(),
                    'rejection_reason' => $rejectionReason,
                ]);

            ActivityLog::log(Auth::id(), 'payment_rejected', "Cashier rejected payment for service request #{$id}", [
                'category' => 'payment',
                'reference_type' => 'service_request',
                'reference_id' => $id,
                'metadata' => ['rejection_reason' => $rejectionReason],
            ]);

            return response()->json([
                'success' => true,
                'message' => 'Service request payment rejected',
                'request' => $serviceRequest,
            ]);

        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Failed to reject payment: ' . $e->getMessage()
            ], 500);
        }
    }

    private function rejectCustomerOrderPayment(Request $request, $id)
    {
        $order = DB::table('customer_orders')->where('id', $id)->first();

        if (!$order) {
            return response()->json(['message' => 'Payment request not found'], 404);
        }

        if (($order->payment_status ?? 'unpaid') !== 'pending') {
            return response()->json(['message' => 'Only pending payment proofs can be rejected'], 422);
        }

        $rejectionReason = $request->input('rejection_reason');

        DB::table('customer_orders')
            ->where('id', $id)
            ->update([
                'payment_status' => 'rejected',
                'rejected_by' => Auth::id(),
                'rejected_at' => now(),
                'rejection_reason' => $rejectionReason,
            ]);

        ActivityLog::log(Auth::id(), 'payment_rejected', "Cashier rejected payment for order #{$id}", [
            'category' => 'payment',
            'reference_type' => 'customer_order',
            'reference_id' => $id,
            'metadata' => ['rejection_reason' => $rejectionReason],
        ]);

        return response()->json([
            'success' => true,
            'message' => 'Payment rejected',
            'order' => $order,
        ]);
    }

    public function customerOrderReceipt($id)
    {
        $order = DB::table('customer_orders')->where('id', $id)->first();

        if (!$order) {
            return response()->json(['message' => 'Receipt not found'], 404);
        }

        if (($order->payment_status ?? 'unpaid') !== 'paid') {
            return response()->json(['message' => 'Receipt is available only after payment verification'], 422);
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
                'payment_reference' => $order->payment_reference ?? null,
                'paid_at' => $order->paid_at,
                'verified_by' => $verifiedBy,
                'cashier_remarks' => $order->cashier_remarks,
            ],
        ]);
    }
}
