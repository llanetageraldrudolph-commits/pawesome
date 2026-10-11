<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Grooming;
use App\Models\ServiceItemUsage;
use App\Services\GroomingInventoryService;
use App\Services\ServiceBillingService;
use App\Services\ServiceCatalog;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Validator;

class GroomingController extends Controller
{
    public function index()
    {
        return response()->json([
            'appointments' => Grooming::with(['customer', 'pet'])
                ->latest()
                ->get()
        ]);
    }

    public function store(Request $request)
    {
        $validated = $request->validate([
            'customer_id' => 'required|exists:customers,id',
            'pet_id' => 'required|exists:pets,id',
            'service' => 'required|string|max:255',
            'appointment_date' => 'required|date',
            'appointment_time' => 'nullable|string|max:50',
            'notes' => 'nullable|string',
            'amount' => 'nullable|numeric',
        ]);

        $resolvedAmount = isset($validated['amount']) && is_numeric($validated['amount'])
            ? (float) $validated['amount']
            : ServiceCatalog::priceFor($validated['service'], 'grooming');

        $validated['status'] = 'pending';
        $validated['payment_status'] = 'unpaid';
        $validated['amount'] = $resolvedAmount;
        $validated['base_amount'] = $resolvedAmount;
        $validated['total_amount'] = $resolvedAmount;
        $validated['amount_paid'] = 0;
        $validated['balance_due'] = $resolvedAmount;

        $grooming = Grooming::create($validated);

        return response()->json([
            'message' => 'Grooming appointment created',
            'appointment' => $grooming
        ], 201);
    }

    public function updateStatus(Request $request, Grooming $grooming)
    {
        $validated = $request->validate([
            'status' => 'required|in:pending,approved,rejected,in_progress,completed,cancelled'
        ]);

        $oldStatus = $grooming->status;
        $newStatus = $validated['status'];

        if (in_array($newStatus, ['approved', 'in_progress'], true)) {
            $this->ensureBaseBillingItem($grooming);
        }

        if ($newStatus === 'approved' && ($grooming->payment_status ?? 'unpaid') !== 'paid') {
            $grooming->payment_status = 'unpaid';
        }

        if ($newStatus === 'completed') {
            $billing = ServiceBillingService::canCompleteService(ServiceItemUsage::SERVICE_GROOMING, (int) $grooming->id);
            $paymentStatus = strtolower((string) ($grooming->payment_status ?? 'unpaid'));

            if ($paymentStatus !== 'paid' || !$billing['can_complete']) {
                return response()->json([
                    'success' => false,
                    'message' => $paymentStatus !== 'paid'
                        ? 'Grooming cannot be completed until payment is fully verified.'
                        : $billing['message'],
                    'payment_status' => $grooming->payment_status,
                    'billing' => $billing,
                ], 422);
            }

            $grooming->completed_at = now();
        }

        $grooming->status = $newStatus;
        $grooming->save();

        if ($newStatus === 'completed' && $oldStatus !== 'completed') {
            $this->sendGroomingCompletionNotification($grooming);
        }

        return response()->json([
            'message' => 'Grooming status updated',
            'appointment' => $grooming
        ]);
    }

    public function show(int $id)
    {
        $grooming = Grooming::with(['customer', 'pet'])->findOrFail($id);

        return response()->json([
            'success' => true,
            'appointment' => $grooming,
        ]);
    }

    public function finalizeBill(Request $request, int $id)
    {
        Grooming::findOrFail($id);

        return response()->json(
            ServiceBillingService::finalizeServiceBill(ServiceItemUsage::SERVICE_GROOMING, $id)
        );
    }

    public function complete(Request $request, int $id)
    {
        $grooming = Grooming::findOrFail($id);
        $request->merge(['status' => 'completed']);

        return $this->updateStatus($request, $grooming);
    }

    /**
     * Record inventory usage for grooming (shampoos, conditioners, supplies)
     */
    public function recordInventoryUsage(Request $request, int $id)
    {
        $grooming = Grooming::findOrFail($id);
        
        // Check access - only staff/admin can record usage
        if (!in_array($request->user()?->role, ['admin', 'receptionist', 'veterinary', 'inventory'])) {
            return response()->json([
                'success' => false,
                'message' => 'You do not have permission to record inventory usage'
            ], 403);
        }

        $items = collect($request->input('items', []))
            ->map(function ($item) {
                if (!is_array($item)) {
                    return $item;
                }

                if (!array_key_exists('quantity_used', $item) && array_key_exists('quantity', $item)) {
                    $item['quantity_used'] = $item['quantity'];
                }

                if (!array_key_exists('notes', $item) && array_key_exists('reason', $item)) {
                    $item['notes'] = $item['reason'];
                }

                return $item;
            })
            ->values()
            ->all();

        $validator = Validator::make([
            'items' => $items,
        ], [
            'items' => 'required|array',
            'items.*.inventory_item_id' => 'required|integer|exists:inventory_items,id',
            'items.*.quantity_used' => 'required|integer|min:1',
            'items.*.notes' => 'nullable|string|max:500',
        ]);
        
        if ($validator->fails()) {
            return response()->json([
                'success' => false,
                'message' => 'Validation failed',
                'errors' => $validator->errors()
            ], 422);
        }
        
        try {
            $groomingInventoryService = new GroomingInventoryService();
            $result = $groomingInventoryService->recordInventoryUsage(
                $items,
                $id,
                $grooming->pet_id,
                'Grooming supply usage',
                $request->user()?->id
            );
            
            if ($result['success']) {
                return response()->json([
                    'success' => true,
                    'message' => $result['message'],
                'usages' => $result['usages'],
                'updated_stock' => $result['usages'],
                'total_items' => $result['total_items'],
                'processed_items' => $result['processed_items']
            ]);
            } else {
                return response()->json([
                    'success' => false,
                    'message' => $result['message'],
                    'errors' => $result['errors']
                ], 422);
            }
        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Failed to record inventory usage: ' . $e->getMessage()
            ], 500);
        }
    }
    
    /**
     * Get inventory usage history for a grooming appointment
     */
    public function getInventoryUsageHistory(int $id)
    {
        $grooming = Grooming::findOrFail($id);
        
        try {
            $groomingInventoryService = new GroomingInventoryService();
            $history = $groomingInventoryService->getGroomingUsageHistory($id);
            
            return response()->json([
                'success' => true,
                'history' => $history,
                'grooming_id' => $id,
                'pet_id' => $grooming->pet_id
            ]);
        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Failed to fetch usage history: ' . $e->getMessage()
            ], 500);
        }
    }
    
    /**
     * Get available inventory items for grooming usage
     */
    public function getAvailableInventoryItems()
    {
        try {
            $groomingInventoryService = new GroomingInventoryService();
            $items = $groomingInventoryService->getAvailableServiceItems();
            
            return response()->json([
                'success' => true,
                'items' => $items,
                'count' => count($items)
            ]);
        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Failed to fetch available items: ' . $e->getMessage()
            ], 500);
        }
    }
    
    /**
     * Send completion notification to customer for grooming service
     */
    private function sendGroomingCompletionNotification(Grooming $grooming): void
    {
        try {
            // Get customer information
            $customer = \App\Models\Customer::find($grooming->customer_id);
            if (!$customer || !$customer->user_id) return;
            
            // Get pet information
            $pet = \App\Models\Pet::find($grooming->pet_id);
            $petName = $pet ? $pet->name : 'Unknown Pet';
            
            // Create notification for customer
            $reference = $grooming->service_request_id
                ? 'SR-' . $grooming->service_request_id
                : 'GR-' . $grooming->id;
            $message = "Booking {$reference} for {$petName}'s grooming service has been completed.";
            \App\Services\NotificationService::createNotification(
                $customer->user_id,
                'Grooming Service Completed',
                $message,
                'success',
                'grooming',
                $grooming->id,
                [
                    'grooming_id' => $grooming->id,
                    'pet_name' => $petName,
                    'service' => $grooming->service,
                    'amount' => $grooming->amount,
                    'status' => 'completed'
                ]
            );

            app(\App\Services\EmailDeliveryService::class)->lifecycle(
                $customer->email ?? $customer->user?->email,
                'Booking Completed',
                $message,
                'success',
                [
                    'event_key' => 'booking.completed',
                    'occurrence_key' => 'booking.completed:grooming:' . $grooming->id . ':' . ($grooming->completed_at?->format('Uv') ?? $grooming->updated_at?->format('Uv')),
                    'source_type' => 'grooming',
                    'source_id' => $grooming->id,
                    'user_id' => $customer->user_id,
                    'customer_id' => $customer->id,
                    'content' => [
                        'subject' => "[Pawesome] Booking Completed — {$reference}",
                        'customer_name' => $customer->name,
                        'intro' => $message . ' Keep this booking reference for your records.',
                        'details' => [
                            ['label' => 'Booking reference', 'value' => $reference],
                            ['label' => 'Service', 'value' => $grooming->service],
                            ['label' => 'Pet', 'value' => $petName],
                            ['label' => 'Date', 'value' => \App\Support\EmailContent::date($grooming->appointment_date)],
                        ],
                        'status' => 'Booking Completed',
                        'status_type' => 'success',
                        'cta_url' => \App\Support\EmailContent::frontendUrl('/customer/bookings'),
                        'cta_label' => 'View Booking',
                    ],
                ]
            );
            
        } catch (\Exception $e) {
            // Log error but don't fail the completion process
            \Log::error('Failed to send grooming completion notification', [
                'grooming_id' => $grooming->id,
                'error' => $e->getMessage()
            ]);
        }
    }

    private function ensureBaseBillingItem(Grooming $grooming): void
    {
        $basePrice = (float) ($grooming->base_amount ?? $grooming->amount ?? 0);
        if ($basePrice <= 0) {
            return;
        }

        $existing = ServiceItemUsage::where('service_type', ServiceItemUsage::SERVICE_GROOMING)
            ->where('service_id', $grooming->id)
            ->where('item_type', ServiceItemUsage::ITEM_BASE_SERVICE)
            ->first();

        if ($existing) {
            return;
        }

        ServiceBillingService::createBaseServiceItem(
            ServiceItemUsage::SERVICE_GROOMING,
            (int) $grooming->id,
            $grooming->service ?: 'Grooming package',
            $basePrice,
            $grooming->pet_id
        );
    }
}
