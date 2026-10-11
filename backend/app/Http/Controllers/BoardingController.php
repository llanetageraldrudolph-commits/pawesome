<?php

namespace App\Http\Controllers;

use App\Models\ActivityLog;
use App\Models\Boarding;
use App\Models\BoardingCareLog;
use App\Models\BoardingRoom;
use App\Models\HotelRoom;
use App\Models\Pet;
use App\Models\Customer;
use App\Models\ServiceItemUsage;
use App\Services\FileStorageService;
use App\Services\NotificationService;
use App\Services\WorkflowNotifier;
use App\Services\BookingAvailabilityService;
use App\Services\BoardingInventoryService;
use App\Services\BoardingRoomService;
use App\Services\BoardingAddOnInventoryService;
use App\Services\InventoryDeductionService;
use App\Services\PetServiceCompatibilityService;
use App\Services\ServiceDurationService;
use App\Services\ServiceBillingService;
use App\Services\PaymentVerificationService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Facades\Validator;
use Illuminate\Support\Str;
use Carbon\Carbon;

class BoardingController extends Controller
{
    protected $boardingRoomService;

    public function __construct(BoardingRoomService $boardingRoomService)
    {
        $this->boardingRoomService = $boardingRoomService;
    }

    private function currentCustomerId(Request $request): ?int
    {
        $user = $request->user();

        if (!$user) {
            return null;
        }

        // Use AND logic to ensure we get the correct customer
        return Customer::where('user_id', $user->id)
            ->where('email', $user->email)
            ->value('id') 
            ?: Customer::where('user_id', $user->id)->value('id')
            ?: Customer::where('email', $user->email)->value('id');
    }

    private function customerCanAccess(Request $request, Boarding $boarding): bool
    {
        if ($request->user()?->role !== 'customer') {
            return true;
        }

        $customerId = $this->currentCustomerId($request);

        if (!$customerId) {
            return false;
        }

        if ((int) $boarding->customer_id === (int) $customerId) {
            return true;
        }

        if ($boarding->pet_id && Pet::where('id', $boarding->pet_id)->where('customer_id', $customerId)->exists()) {
            return true;
        }

        return Schema::hasColumn('boardings', 'customer_email')
            && $request->user()?->email
            && $boarding->customer_email === $request->user()->email;
    }

    /**
     * List all boarding reservations with filters
     */
    public function index(Request $request): JsonResponse
    {
        try {
            $query = Boarding::query();
            $user = $request->user();

            if ($user?->role === 'customer') {
                $customerId = $this->currentCustomerId($request);

                if (!$customerId) {
                    $query->whereRaw('1 = 0');
                } else {
                    $petIds = Pet::where('customer_id', $customerId)->pluck('id');
                    $canMatchCustomer = Schema::hasColumn('boardings', 'customer_id');
                    $canMatchPet = $petIds->isNotEmpty() && Schema::hasColumn('boardings', 'pet_id');
                    $canMatchEmail = Schema::hasColumn('boardings', 'customer_email') && $user->email;

                    if (!$canMatchCustomer && !$canMatchPet && !$canMatchEmail) {
                        $query->whereRaw('1 = 0');
                    }

                    $query->where(function ($customerQuery) use ($customerId, $petIds, $user, $canMatchCustomer, $canMatchPet, $canMatchEmail) {
                        if ($canMatchCustomer) {
                            $customerQuery->where('customer_id', $customerId);
                        }

                        if ($canMatchPet) {
                            $method = $canMatchCustomer ? 'orWhereIn' : 'whereIn';
                            $customerQuery->{$method}('pet_id', $petIds);
                        }

                        if ($canMatchEmail) {
                            $method = $canMatchCustomer || $canMatchPet ? 'orWhere' : 'where';
                            $customerQuery->{$method}('customer_email', $user->email);
                        }
                    });
                }
            } elseif (!$user && $request->filled('email')) {
                return response()->json([
                    'success' => false,
                    'message' => 'Authentication is required to load customer boardings.',
                    'data' => [],
                ], 401);
            }

            // Filter by status
            if ($request->has('status')) {
                $query->where('status', $request->status);
            }

            // Filter by date range
            if ($request->has('date_from')) {
                $query->where('check_in', '>=', $request->date_from);
            }
            if ($request->has('date_to')) {
                $query->where('check_out', '<=', $request->date_to);
            }

            if ($user?->role !== 'customer') {
                // Filter by customer for staff/admin views only. Customer routes are always scoped above.
                if ($request->has('customer_id') && Schema::hasColumn('boardings', 'customer_id')) {
                    $query->where('customer_id', $request->customer_id);
                }

                if ($request->has('pet_id')) {
                    $query->where('pet_id', $request->pet_id);
                }
            }

            // Current boarders only
            if ($request->has('current')) {
                $query->current();
            }

            /*
             IMPORTANT:
             Only eager-load relationships that actually exist on the Boarding model.
            */
            $with = [];

            if (method_exists(Boarding::class, 'pet')) {
                $with[] = 'pet';
            }

            if (method_exists(Boarding::class, 'customer')) {
                $with[] = 'customer';
            }

            if (method_exists(Boarding::class, 'roomReservation')) {
                $with[] = 'roomReservation.room';
            }

            if (method_exists(Boarding::class, 'roomReservations')) {
                $with[] = 'roomReservations.room';
            }

            if (method_exists(Boarding::class, 'bookingAddOns')) {
                $with[] = 'bookingAddOns.addOn';
            }

            if (method_exists(Boarding::class, 'hotelRoom')) {
                $with[] = 'hotelRoom';
            }

            if (!empty($with)) {
                $query->with($with);
            }

            $boardings = $query
                ->orderByDesc('created_at')
                ->get();

            return response()->json([
                'success' => true,
                'data' => $boardings,
                'boardings' => $boardings,
            ]);
        } catch (\Throwable $e) {
            Log::error('Failed to load customer boardings', [
                'message' => $e->getMessage(),
                'file' => $e->getFile(),
                'line' => $e->getLine(),
            ]);

            return response()->json([
                'success' => false,
                'message' => 'Failed to load customer boardings.',
                'data' => [],
                'boardings' => [],
            ], 500);
        }
    }

    /**
     * Create new boarding reservation
     */
    public function store(Request $request): JsonResponse
    {
        if ($request->user()?->role === 'customer') {
            $customerId = $this->currentCustomerId($request);

            if (!$customerId) {
                return response()->json(['error' => 'Customer not found'], 404);
            }

            $request->merge(['customer_id' => $customerId]);
        }

        $useHotelRoom = $request->has('hotel_room_id') && $request->hotel_room_id;

        $validator = Validator::make($request->all(), [
            'pet_id' => 'required|exists:pets,id',
            'customer_id' => 'required|exists:customers,id',
            'room_id' => 'nullable|exists:boarding_rooms,id',
            'hotel_room_id' => 'nullable|exists:hotel_rooms,id',
            'check_in_date' => 'required|date|after_or_equal:today',
            'number_of_days' => 'nullable|integer|min:1|max:1',
            'check_in_time' => 'nullable|date_format:H:i',
            'check_out_time' => 'nullable|date_format:H:i',
            'vaccination_card' => 'nullable|file|mimes:jpg,jpeg,png,pdf|max:5120',
            'notes' => 'nullable|string',
            'add_ons' => 'nullable|array',
            'add_ons.*.id' => 'required|exists:add_ons,id',
            'add_ons.*.quantity' => 'required|integer|min:1',
        ]);

        if ($validator->fails()) {
            return response()->json(['errors' => $validator->errors()], 422);
        }

        if (
            $request->user()?->role === 'customer'
            && ServiceDurationService::isSameDayBookingClosed($request->check_in_date)
        ) {
            $message = 'Same-day hotel bookings are closed after 6:00 PM. Please choose a future date.';

            return response()->json([
                'success' => false,
                'message' => $message,
                'errors' => ['check_in_date' => [$message]],
            ], 422);
        }

        if (!$request->room_id && !$request->hotel_room_id) {
            return response()->json(['errors' => ['room_id' => ['A room must be selected.']]], 422);
        }

        // Store operates 10:00 AM - 6:00 PM; boarding stays are same-day only.
        $withinHours = function (?string $time): bool {
            if (!$time) return true;
            return $time >= '10:00' && $time <= '18:00';
        };
        if (!$withinHours($request->check_in_time) || !$withinHours($request->check_out_time)) {
            return response()->json([
                'errors' => ['check_in_time' => ['Bookings are only accepted within store hours (10:00 AM - 6:00 PM).']],
            ], 422);
        }

        if ($request->pet_id && $request->user()?->role === 'customer') {
            if (!Pet::where('id', $request->pet_id)->where('customer_id', $request->customer_id)->exists()) {
                return response()->json(['error' => 'Pet not found'], 404);
            }
        }

        $pet = Pet::find($request->pet_id);
        if (!$pet) {
            return response()->json(['error' => 'Pet not found'], 404);
        }

        // Same-day boarding: check-out is always the same date as check-in
        $checkIn = Carbon::parse($request->check_in_date);
        $checkOutDate = $checkIn->toDateString();

        // Calculate total amount using room-based pricing (one day only)
        if ($useHotelRoom) {
            $hotelRoom = \App\Models\HotelRoom::find($request->hotel_room_id);
            $dailyRate = (float) ($hotelRoom->daily_rate ?? 0);
            $numberOfDays = 1;
            $totalAmount = $dailyRate * $numberOfDays;
            $roomName = $hotelRoom->name ?? $hotelRoom->room_number;
            $roomType = $hotelRoom->type;
        } else {
            $pricingResult = $this->boardingRoomService->calculateTotalAmount(
                $request->room_id,
                $request->check_in_date,
                $checkOutDate
            );

            if (!$pricingResult['success']) {
                return response()->json([
                    'success' => false,
                    'message' => $pricingResult['message']
                ], 422);
            }

            $totalAmount = $pricingResult['total_amount'];
            $dailyRate = $pricingResult['daily_rate'];
            $numberOfDays = $pricingResult['number_of_days'];
            $roomName = $pricingResult['room_name'];
            $roomType = $pricingResult['room_type'];
        }

        // Process add-ons
        $addOnSubtotal = 0;
        $selectedAddOns = [];
        
        if ($request->has('add_ons')) {
            foreach ($request->add_ons as $addOnKey => $addOnPayload) {
                $addOnId = is_array($addOnPayload)
                    ? ($addOnPayload['id'] ?? $addOnPayload['add_on_id'] ?? $addOnPayload['boarding_add_on_id'] ?? null)
                    : $addOnKey;
                $quantity = is_array($addOnPayload)
                    ? ($addOnPayload['quantity'] ?? 1)
                    : $addOnPayload;
                $quantity = max(1, (int) $quantity);
                $addOn = \App\Models\AddOn::find($addOnId);
                if ($addOn && $addOn->status) {
                    $subtotal = $addOn->unit_price * $quantity;
                    
                    // For per_day add-ons, multiply by number of days
                    if ($addOn->charge_type === 'per_day') {
                        $subtotal = $addOn->unit_price * $quantity * $numberOfDays;
                    }
                    
                    $addOnSubtotal += $subtotal;
                    $selectedAddOns[] = [
                        'id' => $addOn->id,
                        'name' => $addOn->name,
                        'add_on_type' => $addOn->add_on_type,
                        'charge_type' => $addOn->charge_type,
                        'quantity' => $quantity,
                        'unit_price' => (float) $addOn->unit_price,
                        'number_of_days' => $addOn->charge_type === 'per_day' ? $numberOfDays : null,
                        'subtotal' => (float) $subtotal,
                        'inventory_item_id' => $addOn->inventory_item_id,
                    ];
                }
            }
        }

        $finalTotal = $totalAmount + $addOnSubtotal;

        $customer = Customer::find($request->customer_id);
        $initialPaymentStatus = DB::connection()->getDriverName() === 'sqlite' ? 'pending' : 'unpaid';

        // Determine status based on approval requirements
        $status = 'pending';
        if ($pet) {
            $species = $pet->species ?? $pet->type ?? '';
            $requiresApproval = PetServiceCompatibilityService::requiresStaffApproval($species, 'petHotel');
            // Keep status as 'pending' but note approval requirement in notes
        }
        
        $boardingData = [
            'pet_id' => $request->pet_id,
            'pet_name' => $pet ? $pet->name : null,
            'pet_type' => $pet ? ($pet->type ?? $pet->species) : null,
            'pet_breed' => $pet ? $pet->breed : null,
            'customer_id' => $request->customer_id,
            'customer_email' => $customer ? $customer->email : ($request->user() ? $request->user()->email : null),
            'customer_name' => $customer ? $customer->name : ($request->user() ? $request->user()->name : null),
            'room_name' => $roomName,
            'room_type' => $roomType,
            'rate_per_day' => $dailyRate,
            'number_of_days' => $numberOfDays,
            'stay_type' => 'hotel_boarding',
            'check_in' => $request->check_in_date,
            'check_in_time' => $request->check_in_time,
            'check_out' => $checkOutDate,
            'check_out_time' => $request->check_out_time,
            'boarding_type' => $roomType,
            'status' => $status,
            'total_amount' => $finalTotal,
            'payment_status' => $initialPaymentStatus,
            'vaccination_card' => null,
            'notes' => $request->notes,
        ];

        if (Schema::hasColumn('boardings', 'room_id') && $request->room_id) {
            $boardingData['room_id'] = $request->room_id;
        }

        if (Schema::hasColumn('boardings', 'hotel_room_id') && $request->hotel_room_id) {
            $boardingData['hotel_room_id'] = $request->hotel_room_id;
        }
        
        // Note: Special care fields and compatibility metadata stored in notes field
        // to avoid database migrations
        $compatibilityNotes = [];
        if ($request->has('cage_provided')) {
            $compatibilityNotes[] = 'Cage: ' . $request->cage_provided;
        }
        if ($request->has('special_care_notes')) {
            $compatibilityNotes[] = 'Special Care: ' . $request->special_care_notes;
        }
        if ($request->has('handling_instructions')) {
            $compatibilityNotes[] = 'Handling: ' . $request->handling_instructions;
        }
        
        // Add species compatibility metadata to notes
        if ($pet) {
            $species = $pet->species ?? $pet->type ?? '';
            $compatibilityNotes[] = 'Species: ' . $species;
            $compatibilityNotes[] = 'Category: ' . PetServiceCompatibilityService::getSpeciesCategory($species);
            if (PetServiceCompatibilityService::requiresStaffApproval($species, 'petHotel')) {
                $compatibilityNotes[] = 'Requires Staff Approval';
            }
            if (PetServiceCompatibilityService::requiresManualQuotation($species, 'petHotel')) {
                $compatibilityNotes[] = 'Requires Manual Quotation';
            }
        }
        
        // Append compatibility notes to existing notes
        if (!empty($compatibilityNotes)) {
            $existingNotes = $boardingData['notes'] ?? '';
            $compatibilityText = implode(' | ', $compatibilityNotes);
            $boardingData['notes'] = $existingNotes ? $existingNotes . ' | ' . $compatibilityText : $compatibilityText;
        }

        $boardingData = array_intersect_key(
            $boardingData,
            array_flip(Schema::getColumnListing('boardings'))
        );
        
        // Create boarding and room reservation in a transaction
        $createBoarding = fn (?string $vaccinationCardPath = null) => DB::transaction(function () use ($boardingData, $request, $selectedAddOns, $checkOutDate, $useHotelRoom, $vaccinationCardPath) {
            // Re-check hotel room availability inside the transaction to
            // prevent race-condition double booking.
            if ($useHotelRoom) {
                $lockedRoom = \App\Models\HotelRoom::where('id', $request->hotel_room_id)
                    ->lockForUpdate()
                    ->first();

                if (!$lockedRoom || $lockedRoom->status !== 'available') {
                    throw new \Exception('Selected room is no longer available.');
                }

                $conflict = Boarding::where('hotel_room_id', $lockedRoom->id)
                    ->whereNotIn('status', ['rejected', 'cancelled', 'checked_out', 'completed'])
                    ->where('check_in', '<=', $checkOutDate)
                    ->where('check_out', '>=', $request->check_in_date)
                    ->exists();

                if ($conflict) {
                    throw new \Exception('Selected room is already booked for the selected date.');
                }

                if (Schema::hasTable('medical_confinements')) {
                    $confined = DB::table('medical_confinements')
                        ->where('room_id', $lockedRoom->id)
                        ->whereIn('status', ['approved_for_admission', 'admitted', 'under_observation', 'under_treatment', 'ready_for_discharge'])
                        ->exists();

                    if ($confined) {
                        throw new \Exception('Selected room is no longer available.');
                    }
                }
            }

            if ($vaccinationCardPath && array_key_exists('vaccination_card', $boardingData)) {
                $boardingData['vaccination_card'] = $vaccinationCardPath;
            }
            $boarding = Boarding::create($boardingData);

            // Create room reservation (only for boarding rooms, not legacy hotel rooms)
            if (!$useHotelRoom) {
                $roomReservationResult = $this->boardingRoomService->createRoomReservation(
                    $request->room_id,
                    'pet_hotel',
                    $boarding->id,
                    $request->pet_id,
                    $request->check_in_date,
                    $checkOutDate,
                    $request->customer_id
                );

                if (!$roomReservationResult['success']) {
                    throw new \Exception($roomReservationResult['message']);
                }
            }

            // Create booking add-ons
            foreach ($selectedAddOns as $addOn) {
                \App\Models\BookingAddOn::create([
                    'booking_id' => $boarding->id,
                    'add_on_id' => $addOn['id'],
                    'inventory_item_id' => $addOn['inventory_item_id'] ?? null,
                    'name' => $addOn['name'],
                    'add_on_type' => $addOn['add_on_type'],
                    'charge_type' => $addOn['charge_type'],
                    'quantity' => $addOn['quantity'],
                    'unit_price' => $addOn['unit_price'],
                    'number_of_days' => $addOn['number_of_days'],
                    'subtotal' => $addOn['subtotal'],
                ]);
            }

            return $boarding;
        });

        try {
            $result = $request->hasFile('vaccination_card')
                ? FileStorageService::storeAndPersist($request->file('vaccination_card'), 'vaccination_cards', 'private', $createBoarding)
                : $createBoarding();
        } catch (\Exception $e) {
            return response()->json(['errors' => ['room_id' => [$e->getMessage()]]], 422);
        }

        $result->load(['pet', 'customer', 'roomReservation.room']);

        // Append vaccination_card URL for client convenience
        if ($result->vaccination_card) {
            $result->vaccination_card_url = url('/api/files/vaccination-cards/' . $result->id . '/view');
        }

        // Send notifications (notifyBoardingCreated already covers customer + receptionist/manager/admin roles)
        NotificationService::notifyBoardingCreated($result);

        return response()->json([
            'message' => 'Reservation created successfully',
            'boarding' => $result,
        ], 201);
    }

    /**
     * Get available add-ons
     */
    public function getAddOns(): JsonResponse
    {
        $addOns = \App\Models\AddOn::active()->get();
        
        return response()->json(['add_ons' => $addOns]);
    }

    /**
     * Get single boarding details
     */
    public function show(Request $request, $id): JsonResponse
    {
        $boarding = Boarding::with(['pet', 'customer', 'hotelRoom', 'careLogs.loggedBy', 'bookingAddOns.addOn'])->findOrFail($id);

        if (!$this->customerCanAccess($request, $boarding)) {
            return response()->json(['message' => 'Reservation not found'], 404);
        }

        return response()->json(['boarding' => $boarding]);
    }

    /**
     * Update boarding reservation
     */
    public function update(Request $request, $id): JsonResponse
    {
        $boarding = Boarding::findOrFail($id);

        $validator = Validator::make($request->all(), [
            'hotel_room_id' => 'nullable|exists:hotel_rooms,id',
            'check_in' => 'nullable|date',
            'check_out' => 'nullable|date|after_or_equal:check_in',
            'status' => 'nullable|in:pending,approved,scheduled,confirmed,checked_in,in_care,ready_for_pickup,checked_out,completed,cancelled,rejected',
            'payment_status' => 'nullable|in:unpaid,pending,partial,paid,rejected,refunded',
            'notes' => 'nullable|string',
        ]);

        if ($validator->fails()) {
            return response()->json(['errors' => $validator->errors()], 422);
        }

        // Check room availability if changing room or dates
        if ($request->has('hotel_room_id') || $request->has('check_in') || $request->has('check_out')) {
            $roomId = $request->hotel_room_id ?? $boarding->hotel_room_id;
            $checkIn = $request->check_in ?? $boarding->check_in;
            // Same-day boarding: check-out always equals check-in
            $checkOut = $checkIn;

            $room = HotelRoom::find($roomId);
            if (!$room || $room->status !== 'available') {
                return response()->json([
                    'error' => 'Room is not available for the selected date'
                ], 422);
            }

            $conflicting = Boarding::where('hotel_room_id', $roomId)
                ->where('id', '!=', $id)
                ->whereNotIn('status', ['rejected', 'cancelled', 'checked_out', 'completed'])
                ->where('check_in', '<=', $checkOut)
                ->where('check_out', '>=', $checkIn)
                ->exists();

            if ($conflicting) {
                return response()->json([
                    'error' => 'Room is not available for selected dates'
                ], 422);
            }

            // One-day pricing
            $boarding->total_amount = (float) $room->daily_rate;
        }

        // Enforce same-day check-in/check-out on any update touching dates
        $updateData = $request->only([
            'hotel_room_id', 'check_in', 'check_out', 'status',
            'payment_status', 'special_requests', 'emergency_contact',
            'emergency_phone', 'notes'
        ]);

        // Same-day boarding: check-out always equals check-in
        $updateData['check_out'] = $updateData['check_in'] ?? $boarding->check_in;

        $boarding->update($updateData);

        $boarding->load(['pet', 'customer', 'hotelRoom']);

        return response()->json([
            'message' => 'Reservation updated successfully',
            'boarding' => $boarding,
        ]);
    }

    /**
     * Archive boarding reservation (replaces delete)
     */
    public function destroy(Request $request, $id): JsonResponse
    {
        $boarding = Boarding::findOrFail($id);

        // Check for active dependencies before archiving
        if ($boarding->status === 'active' || $boarding->status === 'checked_in') {
            return response()->json([
                'success' => false,
                'message' => 'Cannot archive active boarding reservation. Please complete or cancel the reservation first.'
            ], 422);
        }

        // Archive the boarding reservation
        $boarding->update([
            'status' => 'archived',
            'archived_at' => now(),
            'archived_by' => $request->user()?->id,
            'archive_reason' => 'Archived via boarding management'
        ]);
        
        // Release room if checked in
        if ($boarding->status === 'checked_in' && $boarding->hotelRoom) {
            $boarding->hotelRoom->update(['status' => 'available']);
        }
        
        return response()->json([
            'success' => true,
            'message' => 'Boarding reservation archived successfully',
        ]);
    }

    /**
     * Confirm/Approve boarding reservation with inventory deduction
     */
    public function confirm(Request $request, $id): JsonResponse
    {
        $boarding = Boarding::findOrFail($id);

        if (!in_array($boarding->status, ['pending'], true)) {
            return response()->json(['error' => 'Only pending boarding requests can be confirmed'], 422);
        }

        // Vaccination card verification is now optional
        // Removed blocking requirement to allow approval without vaccination card

        $oldStatus = $boarding->status;
        
        // Initialize inventory service
        $addOnInventoryService = new BoardingAddOnInventoryService();
        
        // Check if there are inventory-backed add-ons and verify stock
        $inventoryAddOns = $addOnInventoryService->getInventoryAddOnsWithStockStatus($boarding);
        $hasInsufficientStock = false;
        $insufficientItems = [];
        
        foreach ($inventoryAddOns as $addOn) {
            if (!$addOn['has_sufficient_stock']) {
                $hasInsufficientStock = true;
                $insufficientItems[] = [
                    'name' => $addOn['add_on_name'],
                    'required' => $addOn['required_quantity'],
                    'available' => $addOn['available_stock']
                ];
            }
        }
        
        if ($hasInsufficientStock) {
            return response()->json([
                'error' => 'Insufficient stock for some add-ons',
                'insufficient_items' => $insufficientItems
            ], 422);
        }

        // Process approval and inventory deduction in transaction
        $result = DB::transaction(function () use ($boarding, $oldStatus, $addOnInventoryService, $request) {
            // Update boarding status
            $boarding->update([
                'status' => 'approved',
                'approved_by' => $request->user()?->id,
                'approved_at' => now(),
                'payment_status' => $boarding->payment_status === 'paid' ? 'paid' : 'unpaid',
            ]);

            // Create base service billing item when boarding is approved.
            // The authoritative amount is the persisted booking total
            // (room rate × days + selected add-ons), not a recomputed rate.
            ServiceBillingService::ensureBaseServiceItem('boarding', (int) $boarding->id);

            // Deduct inventory for add-ons
            $inventoryResult = $addOnInventoryService->deductAddOnInventory($boarding, 'receptionist');
            
            if (!$inventoryResult['success']) {
                throw new \Exception($inventoryResult['message'] ?? 'Inventory deduction failed');
            }

            return [
                'boarding' => $boarding,
                'inventory_result' => $inventoryResult
            ];
        });

        // Send notification
        NotificationService::notifyBoardingStatusChange($result['boarding'], $oldStatus);

        ActivityLog::log($request->user()?->id, 'boarding_approved', "Boarding reservation #{$boarding->id} approved", [
            'category' => 'booking',
            'reference_type' => 'boarding',
            'reference_id' => $boarding->id,
            'changes' => ['status' => ['old' => $oldStatus, 'new' => 'approved']],
        ]);

        return response()->json([
            'message' => 'Boarding request approved and inventory deducted',
            'boarding' => $result['boarding']->fresh(['pet', 'customer', 'hotelRoom', 'bookingAddOns']),
            'inventory_deductions' => $result['inventory_result']['deducted_items'] ?? []
        ]);
    }

    public function approve(Request $request, $id): JsonResponse
    {
        return $this->confirm($request, $id);
    }

    /**
     * Mark vaccination card as verified by receptionist
     */
    public function verifyVaccinationCard(Request $request, $id): JsonResponse
    {
        $boarding = Boarding::findOrFail($id);

        if (!$boarding->vaccination_card) {
            return response()->json(['error' => 'No vaccination card on file for this booking.'], 422);
        }

        if (!in_array($boarding->status, ['pending', 'approved', 'scheduled', 'confirmed'], true)) {
            return response()->json(['error' => 'Cannot verify vaccination card for this reservation status.'], 422);
        }

        $boarding->update([
            'vaccination_card_verified_at' => now(),
        ]);

        return response()->json([
            'message' => 'Vaccination card verified successfully.',
            'boarding' => $boarding->fresh(['pet', 'customer', 'hotelRoom']),
        ]);
    }

    public function pending(): JsonResponse
    {
        $boardings = Boarding::with(['pet', 'customer', 'hotelRoom'])
            ->where('status', 'pending')
            ->where(function ($query) {
                $query->where('stay_type', 'hotel_boarding')
                    ->orWhere('boarding_type', 'like', '%hotel%')
                    ->orWhere('boarding_type', 'like', '%boarding%')
                    ->orWhereNotNull('check_in')
                    ->orWhereNotNull('check_out');
            })
            ->latest()
            ->get();

        return response()->json([
            'success' => true,
            'boarding_requests' => $boardings,
            'boardings' => $boardings,
            'data' => $boardings,
        ]);
    }

    public function schedule(Request $request, $id): JsonResponse
    {
        $boarding = Boarding::findOrFail($id);

        if (!in_array($boarding->status, ['approved', 'pending', 'confirmed'], true)) {
            return response()->json(['error' => 'Only pending or approved boarding requests can be scheduled'], 422);
        }

        $validator = Validator::make($request->all(), [
            'hotel_room_id' => 'required|exists:hotel_rooms,id',
            'check_in' => 'nullable|date|after_or_equal:today',
            'check_out' => 'nullable|date|after_or_equal:check_in',
            'check_in_time' => 'nullable|date_format:H:i',
            'check_out_time' => 'nullable|date_format:H:i',
            'total_amount' => 'nullable|numeric|min:0',
            'boarding_type' => 'nullable|string|max:255',
            'notes' => 'nullable|string',
        ]);

        if ($validator->fails()) {
            return response()->json(['errors' => $validator->errors()], 422);
        }

        $checkIn = $request->input('check_in', optional($boarding->check_in)->toDateString() ?? $boarding->check_in);
        // Same-day boarding: check-out always equals check-in (9 AM - 7 PM)
        $checkOut = $checkIn;
        $room = HotelRoom::findOrFail($request->hotel_room_id);

        if ($room->status !== 'available' && $room->id !== $boarding->hotel_room_id) {
            return response()->json(['error' => 'Selected room is not available.'], 422);
        }

        // Enhanced double booking prevention - explicit database conflict check
        // Inclusive overlap: a stay occupies every date check_in..check_out
        $conflictingBoarding = Boarding::where('hotel_room_id', $request->hotel_room_id)
            ->whereIn('status', ['pending', 'approved', 'scheduled', 'confirmed', 'checked_in', 'in_care', 'in_stay', 'ready_for_pickup'])
            ->where('id', '!=', $boarding->id)
            ->where('check_in', '<=', $checkOut)
            ->where('check_out', '>=', $checkIn)
            ->first();

        if ($conflictingBoarding) {
            return response()->json([
                'error' => 'This room/kennel is already booked for the selected date range.',
                'conflict_with' => $conflictingBoarding->id,
                'conflict_dates' => [
                    'existing_check_in' => $conflictingBoarding->check_in,
                    'existing_check_out' => $conflictingBoarding->check_out,
                    'requested_check_in' => $checkIn,
                    'requested_check_out' => $checkOut
                ]
            ], 422);
        }

        // Additional check using existing room availability method
        if (!$room->isAvailableForDates($checkIn, $checkOut)) {
            return response()->json(['error' => 'Room is not available for selected dates'], 422);
        }

        $days = 1;
        $newTotal = (float) $request->input('total_amount', $days * $room->daily_rate);

        // A booking that has already received money may not be silently
        // re-priced — extra charges must go through the itemized billing
        // workflow instead.
        if (in_array($boarding->payment_status, ['paid', 'partial'], true) && abs($newTotal - (float) $boarding->total_amount) > 0.01) {
            return response()->json([
                'error' => 'This reservation is already paid. Record extra charges as billing items instead of changing the total.',
            ], 422);
        }

        DB::transaction(function () use ($boarding, $room, $request, $checkIn, $checkOut, $newTotal, $days) {
            $boarding->update([
                'hotel_room_id' => $room->id,
                'check_in' => $checkIn,
                'check_out' => $checkOut,
                'check_in_time' => $request->input('check_in_time', $boarding->check_in_time),
                'check_out_time' => $request->input('check_out_time', $boarding->check_out_time),
                'boarding_type' => $request->input('boarding_type', $boarding->boarding_type),
                'total_amount' => $newTotal,
                'status' => 'scheduled',
                'payment_status' => $boarding->payment_status === 'paid' ? 'paid' : 'unpaid',
                'approved_by' => $boarding->approved_by ?: $request->user()?->id,
                'approved_at' => $boarding->approved_at ?: now(),
                'notes' => $request->input('notes', $boarding->notes),
            ]);

            $room->update(['status' => 'reserved']);

            // Keep the itemized bill aligned with the re-priced total:
            // re-write the unpaid base item rather than leaving a stale one.
            $baseItem = ServiceBillingService::ensureBaseServiceItem('boarding', (int) $boarding->id);
            if ($baseItem && !$baseItem->is_paid) {
                $baseItem->update([
                    'description' => $room->name . ' - ' . $days . ' day(s)',
                    'unit_price' => $newTotal,
                    'total_price' => $newTotal,
                ]);
                ServiceBillingService::syncServicePaymentState('boarding', (int) $boarding->id);
            }
        });
        WorkflowNotifier::notifyEmail($boarding->customer_email, 'Boarding scheduled', 'Your pet hotel stay has been scheduled.', 'success', 'boarding', $boarding->id);

        return response()->json([
            'message' => 'Boarding request scheduled',
            'boarding' => $boarding->fresh(['pet', 'customer', 'hotelRoom']),
        ]);
    }

    /**
     * Check in guest
     */
    public function checkIn(Request $request, $id): JsonResponse
    {
        $boarding = Boarding::findOrFail($id);

        if (!in_array($boarding->status, ['approved', 'scheduled', 'confirmed'], true)) {
            return response()->json(['error' => 'Invalid status for check-in'], 422);
        }

        // Anti human-error gates: payment must be verified and the stay must
        // be scheduled for today before a pet can be checked in.
        if (strtolower((string) $boarding->payment_status) !== 'paid') {
            return response()->json(['error' => 'Booking must be paid before check-in.'], 422);
        }

        $scheduledDate = $boarding->check_in ?? $boarding->check_in_date ?? null;
        if ($scheduledDate && !Carbon::parse($scheduledDate)->isToday()) {
            return response()->json(['error' => 'Check-in is only allowed on the scheduled date.'], 422);
        }

        $oldStatus = $boarding->status;

        // Initialize inventory service
        $addOnInventoryService = new BoardingAddOnInventoryService();

        // Process check-in and inventory deduction in transaction
        $result = DB::transaction(function () use ($boarding, $oldStatus, $addOnInventoryService, $request) {
            $boarding->update([
                'status' => 'in_care',
                'actual_check_in' => now(),
                'checked_in_at' => now(),
                'checked_in_by' => $request->user()?->id,
            ]);
            $boarding->hotelRoom?->update(['status' => 'occupied']);

            BoardingCareLog::create([
                'boarding_id' => $boarding->id,
                'logged_by' => $request->user()?->id,
                'log_type' => 'general_update',
                'title' => 'Pet checked in',
                'notes' => $request->input('notes', 'Pet checked in for boarding care.'),
            ]);

            // Deduct inventory for add-ons if not already deducted
            $inventoryResult = $addOnInventoryService->deductAddOnInventory($boarding, 'receptionist');

            return [
                'boarding' => $boarding,
                'inventory_result' => $inventoryResult
            ];
        });

        // Send notification
        NotificationService::notifyBoardingStatusChange($result['boarding'], $oldStatus);

        return response()->json([
            'message' => 'Guest checked in successfully',
            'boarding' => $boarding->fresh(['pet', 'customer', 'hotelRoom']),
        ]);
    }

    /**
     * Check out guest
     */
    public function checkOut(Request $request, $id): JsonResponse
    {
        $boarding = Boarding::findOrFail($id);

        if (!in_array($boarding->status, ['ready_for_pickup', 'in_care', 'checked_in'], true)) {
            return response()->json(['error' => 'Pet is not ready for checkout'], 422);
        }

        if ($boarding->payment_status !== 'paid') {
            return response()->json(['error' => 'Payment must be settled before checkout'], 422);
        }

        $billing = ServiceBillingService::canCompleteService(ServiceItemUsage::SERVICE_BOARDING, (int) $boarding->id);
        if (!$billing['can_complete']) {
            return response()->json([
                'error' => $billing['message'],
                'payment_status' => $boarding->payment_status,
                'billing' => $billing,
            ], 422);
        }

        $oldStatus = $boarding->status;
        $boarding->update([
            'status' => 'completed',
            'actual_check_out' => now(),
            'checked_out_at' => now(),
            'checked_out_by' => $request->user()?->id,
            'balance_due' => 0,
        ]);
        $boarding->hotelRoom?->update(['status' => 'available']);

        // Send notification
        NotificationService::notifyBoardingStatusChange($boarding, $oldStatus);

        return response()->json([
            'message' => 'Guest checked out successfully',
            'boarding' => $boarding->fresh(['pet', 'customer', 'hotelRoom']),
        ]);
    }

    public function finalizeBill($id): JsonResponse
    {
        Boarding::findOrFail($id);

        return response()->json(
            ServiceBillingService::finalizeServiceBill(ServiceItemUsage::SERVICE_BOARDING, (int) $id)
        );
    }

    public function complete(Request $request, $id): JsonResponse
    {
        return $this->checkOut($request, $id);
    }

    public function readyForPickup(Request $request, $id): JsonResponse
    {
        $boarding = Boarding::findOrFail($id);

        if (!in_array($boarding->status, ['checked_in', 'in_care'], true)) {
            return response()->json(['error' => 'Only checked-in pets can be marked ready for pickup'], 422);
        }

        $oldStatus = $boarding->status;
        $boarding->update([
            'status' => 'ready_for_pickup',
            'ready_for_pickup_by' => $request->user()?->id,
            'ready_for_pickup_at' => now(),
        ]);

        NotificationService::notifyBoardingStatusChange($boarding, $oldStatus);
        WorkflowNotifier::notifyEmail($boarding->customer_email, 'Ready for pickup', "{$boarding->pet_name} is ready for pickup.", 'success', 'boarding', $boarding->id);

        return response()->json([
            'message' => 'Boarding marked ready for pickup',
            'boarding' => $boarding->fresh(['pet', 'customer', 'hotelRoom']),
        ]);
    }

    /**
     * Cancel reservation
     */
    public function cancel(Request $request, $id): JsonResponse
    {
        $boarding = Boarding::findOrFail($id);

        if (!$this->customerCanAccess($request, $boarding)) {
            return response()->json(['message' => 'Reservation not found'], 404);
        }

        if (in_array($boarding->status, ['checked_out', 'completed'], true)) {
            return response()->json(['error' => 'Cannot cancel completed reservation'], 422);
        }

        if ($request->user()?->role === 'customer' && $boarding->status !== 'pending') {
            return response()->json(['error' => 'Customers can only cancel pending boarding requests'], 422);
        }

        $oldStatus = $boarding->status;

        $cancelReason = trim((string) ($request->input('reason') ?: $request->input('cancellation_reason') ?: ''));

        // Initialize inventory service
        $addOnInventoryService = new BoardingAddOnInventoryService();

        // Process cancellation and inventory restoration in transaction
        $result = DB::transaction(function () use ($boarding, $oldStatus, $addOnInventoryService, $cancelReason) {
            $boarding->update(array_filter([
                'status' => 'cancelled',
                'cancellation_reason' => $cancelReason !== '' ? $cancelReason : null,
            ]));
            if ($boarding->hotelRoom && in_array($boarding->hotelRoom->status, ['reserved', 'occupied'], true)) {
                $boarding->hotelRoom->update(['status' => 'available']);
            }

            // Restore inventory for add-ons that were deducted
            $inventoryResult = $addOnInventoryService->restoreAddOnInventory($boarding, 'receptionist');
            
            return [
                'boarding' => $boarding,
                'inventory_result' => $inventoryResult
            ];
        });

        // Send notification
        NotificationService::notifyBoardingStatusChange($result['boarding'], $oldStatus);

        return response()->json([
            'message' => 'Reservation cancelled',
            'boarding' => $boarding->fresh(['pet', 'customer', 'hotelRoom']),
        ]);
    }

    /**
     * Get available rooms for date range
     */
    public function availableRooms(Request $request): JsonResponse
    {
        $validator = Validator::make($request->all(), [
            'check_in' => 'nullable|date|after_or_equal:today',
            'check_out' => 'nullable|date|after_or_equal:check_in',
            'check_in_date' => 'nullable|date|after_or_equal:today',
            'check_out_date' => 'nullable|date|after_or_equal:check_in_date',
            'pet_id' => 'nullable|exists:pets,id',
            'species' => 'nullable|string|max:100',
            'size' => 'nullable|in:small,medium,large',
            'type' => 'nullable|string|max:100',
            'room_type' => 'nullable|string|max:100',
        ]);

        if ($validator->fails()) {
            return response()->json(['errors' => $validator->errors()], 422);
        }

        $checkIn = $request->query('check_in') ?: $request->query('check_in_date');
        // Same-day stays: check-out defaults to check-in when not provided
        $checkOut = $request->query('check_out') ?: $request->query('check_out_date') ?: $checkIn;

        if (!$checkIn || !$checkOut) {
            return response()->json([
                'success' => false,
                'message' => 'Check-in and check-out dates are required.',
                'available_rooms' => [],
                'rooms' => [],
            ], 422);
        }

        $pet = $request->filled('pet_id') ? Pet::find($request->pet_id) : null;
        $species = strtolower(trim((string) ($request->query('species') ?: $pet?->species ?: $pet?->type ?: '')));

        $allowedRoomTypes = match ($species) {
            'dog' => ['dog_standard', 'dog_large', 'dog_family'],
            'cat' => ['cat_condo', 'cat_suite'],
            'bird' => ['small_pet'],
            default => [],
        };

        if (empty($allowedRoomTypes)) {
            return response()->json([
                'success' => true,
                'message' => $species ? ucfirst($species) . ' cannot be accommodated in Pet Hotel rooms.' : 'Select a pet to view compatible rooms.',
                'available_rooms' => [],
                'rooms' => [],
                'check_in' => $checkIn,
                'check_out' => $checkOut,
            ]);
        }

        $roomType = $request->query('room_type') ?: $request->query('type');
        if ($roomType && in_array($roomType, $allowedRoomTypes, true)) {
            $allowedRoomTypes = [$roomType];
        }

        if ($request->filled('size') && in_array($species, ['dog', 'cat'], true)) {
            $size = strtolower((string) $request->query('size'));
            if (in_array($size, ['small', 'medium'], true)) {
                $allowedRoomTypes = array_values(array_intersect($allowedRoomTypes, ['dog_standard', 'cat_condo']));
            } elseif (in_array($size, ['large'], true)) {
                $allowedRoomTypes = array_values(array_intersect($allowedRoomTypes, ['dog_large', 'dog_family', 'cat_suite']));
            }
        }

        $roomsQuery = BoardingRoom::query()->whereIn('room_type', $allowedRoomTypes);
        if (Schema::hasColumn('boarding_rooms', 'is_active')) {
            $roomsQuery->where('is_active', true);
        }
        if (Schema::hasColumn('boarding_rooms', 'customer_selectable')) {
            $roomsQuery->where('customer_selectable', true);
        }

        $reservationRoomColumn = Schema::hasColumn('boarding_room_reservations', 'room_id')
            ? 'room_id'
            : (Schema::hasColumn('boarding_room_reservations', 'boarding_room_id') ? 'boarding_room_id' : null);

        $availableRooms = $roomsQuery->orderBy('daily_rate')->get()->map(function ($room) use ($checkIn, $checkOut, $reservationRoomColumn) {
            $blockingCount = 0;

            if ($reservationRoomColumn && Schema::hasTable('boarding_room_reservations')) {
                $blockingCount = DB::table('boarding_room_reservations')
                    ->where($reservationRoomColumn, $room->id)
                    ->whereNotIn('status', ['rejected', 'cancelled', 'checked_out', 'completed'])
                    ->where('check_in_date', '<=', $checkOut)
                    ->where('check_out_date', '>=', $checkIn)
                    ->count();
            }

            $room->available = $blockingCount < (int) ($room->total_rooms ?? 1);
            $room->available_rooms = max(0, (int) ($room->total_rooms ?? 1) - $blockingCount);

            return $room;
        })->filter(fn ($room) => $room->available)->values();

        return response()->json([
            'success' => true,
            'available_rooms' => $availableRooms,
            'rooms' => $availableRooms,
            'check_in' => $checkIn,
            'check_out' => $checkOut,
        ]);
    }

    /**
     * Get current and upcoming boarders for veterinary health awareness.
     */
    public function currentBoarders(): JsonResponse
    {
        $boarders = Boarding::with(['pet', 'customer', 'hotelRoom', 'roomReservation.room', 'bookingAddOns.addOn'])
            ->whereIn('status', ['approved', 'scheduled', 'confirmed', 'checked_in', 'in_care'])
            ->whereDate('check_out', '>=', now()->toDateString())
            ->orderBy('check_out', 'asc')
            ->get();

        return response()->json([
            'boarders' => $boarders,
            'count' => $boarders->count(),
        ]);
    }

    /**
     * Get today's check-ins and check-outs
     */
    public function todayActivity(): JsonResponse
    {
        $today = now()->format('Y-m-d');

        $checkIns = Boarding::with(['pet', 'customer', 'hotelRoom'])
            ->whereDate('check_in', $today)
            ->whereIn('status', ['pending', 'confirmed'])
            ->get();

        $checkOuts = Boarding::with(['pet', 'customer', 'hotelRoom'])
            ->whereDate('check_out', $today)
            ->where('status', 'checked_in')
            ->get();

        $currentlyBoarded = Boarding::with(['pet', 'customer', 'hotelRoom'])
            ->checkedIn()
            ->count();

        return response()->json([
            'date' => $today,
            'check_ins' => $checkIns,
            'check_outs' => $checkOuts,
            'currently_boarded' => $currentlyBoarded,
        ]);
    }

    /**
     * Reject reservation
     */
    public function reject(Request $request, $id): JsonResponse
    {
        $request->validate([
            'rejection_reason' => 'required|string|max:1000',
        ]);

        $boarding = Boarding::findOrFail($id);

        if (in_array($boarding->status, ['checked_out', 'completed'], true)) {
            return response()->json(['error' => 'Cannot reject completed reservation'], 422);
        }

        if (!in_array($boarding->status, ['pending', 'approved', 'scheduled', 'confirmed'], true)) {
            return response()->json(['error' => 'Can only reject pending or scheduled reservations'], 422);
        }

        $oldStatus = $boarding->status;

        // Restore inventory for add-ons that were already deducted (approved
        // bookings) before rejecting. No-op when nothing was deducted.
        $addOnInventoryService = new BoardingAddOnInventoryService();

        DB::transaction(function () use ($boarding, $request, $addOnInventoryService) {
            $boarding->update([
                'status' => 'rejected',
                'rejected_by' => $request->user()?->id,
                'rejected_at' => now(),
                'rejection_reason' => $request->input('rejection_reason'),
            ]);
            if ($boarding->hotelRoom && in_array($boarding->hotelRoom->status, ['reserved'], true)) {
                $boarding->hotelRoom->update(['status' => 'available']);
            }

            $addOnInventoryService->restoreAddOnInventory($boarding, 'receptionist');
        });

        // Send notification
        NotificationService::notifyBoardingStatusChange($boarding, $oldStatus);

        ActivityLog::log($request->user()?->id, 'boarding_rejected', "Boarding reservation #{$boarding->id} rejected", [
            'category' => 'booking',
            'reference_type' => 'boarding',
            'reference_id' => $boarding->id,
            'changes' => ['status' => ['old' => $oldStatus, 'new' => 'rejected']],
            'metadata' => ['rejection_reason' => $request->input('rejection_reason')],
        ]);

        return response()->json([
            'message' => 'Reservation rejected',
            'boarding' => $boarding->fresh(['pet', 'customer', 'hotelRoom']),
        ]);
    }

    /**
     * Mark as paid (cashier/admin only — route gated by role:cashier,admin)
     *
     * Legacy endpoint preserved for contract compatibility; the payment now
     * flows through the canonical PaymentVerificationService so the same
     * settlement ledger, receipt, and notification path is used.
     */
    public function markAsPaid(Request $request, $id): JsonResponse
    {
        $boarding = Boarding::findOrFail($id);

        if ($boarding->payment_status === 'paid') {
            return response()->json(['error' => 'Payment already confirmed'], 422);
        }

        if (!in_array($boarding->status, ['confirmed', 'checked_in', 'approved', 'scheduled', 'in_care', 'ready_for_pickup'], true)) {
            return response()->json(['error' => 'Cannot confirm payment for a reservation in this status'], 422);
        }

        $result = app(PaymentVerificationService::class)->verify('boarding', (int) $id, $request);

        if (!($result['success'] ?? false)) {
            return response()->json(['error' => $result['message'] ?? 'Payment verification failed'], $result['status'] ?? 422);
        }

        return response()->json([
            'message' => 'Payment confirmed successfully',
            'boarding' => $boarding->fresh(['pet', 'customer', 'hotelRoom']),
            'receipt_number' => $result['receipt_number'] ?? null,
        ]);
    }

    public function uploadPaymentProof(Request $request, $id): JsonResponse
    {
        $boarding = Boarding::findOrFail($id);

        if (!$this->customerCanAccess($request, $boarding)) {
            return response()->json(['message' => 'Reservation not found'], 404);
        }

        if (!in_array($boarding->status, ['approved', 'scheduled'], true)) {
            return response()->json(['error' => 'Payment proof can only be uploaded after approval or scheduling'], 422);
        }

        if (!in_array($boarding->payment_status, ['unpaid', 'pending', 'rejected'], true)) {
            return response()->json(['error' => 'Only unpaid or rejected payments can be resubmitted'], 422);
        }

        $validator = Validator::make($request->all(), [
            'payment_method' => 'required|in:cash,gcash,maya',
            'payment_reference' => 'required_unless:payment_method,cash|nullable|string|max:255',
            'payment_proof' => 'required_unless:payment_method,cash|nullable|file|mimes:jpg,jpeg,png,pdf|max:5120',
        ]);

        if ($validator->fails()) {
            return response()->json(['errors' => $validator->errors()], 422);
        }

        $paymentData = [
            'payment_method' => $request->payment_method,
            'payment_reference' => $request->payment_reference,
            'payment_status' => 'pending',
        ];

        if ($request->hasFile('payment_proof')) {
            // Replaced proofs are retained as payment evidence (deleteOld: false).
            FileStorageService::storeAndPersist(
                $request->file('payment_proof'), 'payment-proofs/boardings', 'private',
                fn (string $path) => $boarding->update($paymentData + [
                    'payment_proof' => $path,
                ]),
                deleteOld: false,
                prefix: 'boarding_proof',
            );
        } else {
            // Cash payments are verified by the cashier at the counter — no proof file.
            $boarding->update($paymentData);
        }

        // Mirror the resubmission onto the originating service request so the
        // booking re-enters cashier verification as one consistent row.
        if (!empty($boarding->service_request_id)) {
            $srUpdates = [
                'payment_status' => 'pending',
                'payment_method' => $request->payment_method,
                'payment_reference' => $request->payment_reference,
                'updated_at' => now(),
            ];
            $freshBoarding = $boarding->fresh();
            if (Schema::hasColumn('service_requests', 'payment_proof')) {
                $srUpdates['payment_proof'] = $freshBoarding->payment_proof;
            }
            DB::table('service_requests')
                ->where('id', $boarding->service_request_id)
                ->where('payment_status', '!=', 'paid')
                ->update($srUpdates);
        }

        WorkflowNotifier::notifyRole('cashier', 'Boarding payment proof submitted', "{$boarding->pet_name} has a pending boarding payment proof.", 'info', 'boarding', $boarding->id);

        return response()->json([
            'message' => 'Payment proof submitted for cashier verification',
            'boarding' => $boarding->fresh(['pet', 'customer', 'hotelRoom']),
        ]);
    }

    public function careLogs(Request $request, $id): JsonResponse
    {
        $boarding = Boarding::with('careLogs.loggedBy')->findOrFail($id);

        if (!$this->customerCanAccess($request, $boarding)) {
            return response()->json(['message' => 'Reservation not found'], 404);
        }

        return response()->json(['care_logs' => $boarding->careLogs()->with('loggedBy')->latest()->get()]);
    }

    public function addCareLog(Request $request, $id): JsonResponse
    {
        $boarding = Boarding::findOrFail($id);

        if (!in_array($boarding->status, ['checked_in', 'in_care'], true)) {
            return response()->json(['error' => 'Care logs can only be added while pet is checked in or in care'], 422);
        }

        $validator = Validator::make($request->all(), [
            'log_type' => 'required|in:' . implode(',', BoardingCareLog::VALID_TYPES),
            'title' => 'nullable|string|max:255',
            'notes' => 'required|string',
            'feeding_amount' => 'nullable|string|max:255',
            'medication_given' => 'nullable|string',
            'behavior_notes' => 'nullable|string',
            'health_observation' => 'nullable|string',
            'photo' => 'nullable|file|mimes:jpg,jpeg,png|max:5120',
        ]);

        if ($validator->fails()) {
            return response()->json(['errors' => $validator->errors()], 422);
        }

        $createLog = fn (?string $path = null) => BoardingCareLog::create([
            'boarding_id' => $boarding->id,
            'logged_by' => $request->user()?->id,
            'log_type' => $request->log_type,
            'title' => $request->title,
            'notes' => $request->notes,
            'feeding_amount' => $request->feeding_amount,
            'medication_given' => $request->medication_given,
            'behavior_notes' => $request->behavior_notes,
            'health_observation' => $request->health_observation,
            'photo_path' => $path,
        ]);
        $log = $request->hasFile('photo')
            ? FileStorageService::storeAndPersist($request->file('photo'), 'care-logs/boardings', 'private', $createLog)
            : $createLog();

        if ($request->filled('health_observation')) {
            WorkflowNotifier::notifyRole('veterinary', 'Boarding health observation', "A care log for {$boarding->pet_name} includes a health observation.", 'warning', 'boarding', $boarding->id);
        }

        WorkflowNotifier::notifyEmail($boarding->customer_email, 'Boarding care log added', "A new care update was added for {$boarding->pet_name}.", 'info', 'boarding', $boarding->id);

        return response()->json([
            'message' => 'Care log added',
            'care_log' => $log->load('loggedBy'),
        ], 201);
    }

    /**
     * Get occupancy statistics
     */
    public function occupancyStats(Request $request): JsonResponse
    {
        $validator = Validator::make($request->all(), [
            'month' => 'required|date_format:Y-m',
        ]);

        if ($validator->fails()) {
            return response()->json(['errors' => $validator->errors()], 422);
        }

        $month = $request->month;
        $startDate = new \Carbon\Carbon($month . '-01');
        $endDate = $startDate->copy()->endOfMonth();

        $totalRooms = HotelRoom::count();
        $daysInMonth = $startDate->daysInMonth;

        // Calculate room nights and revenue
        $boardings = Boarding::where(function ($query) use ($startDate, $endDate) {
                $query->whereBetween('check_in', [$startDate, $endDate])
                    ->orWhereBetween('check_out', [$startDate, $endDate]);
            })
            ->whereIn('status', ['confirmed', 'checked_in', 'checked_out'])
            ->get();

        $totalRevenue = $boardings->sum('total_amount');
        $totalNights = 0;

        foreach ($boardings as $boarding) {
            $checkIn = new \Carbon\Carbon($boarding->check_in);
            $checkOut = new \Carbon\Carbon($boarding->check_out);
            $totalNights += $checkIn->diffInDays($checkOut);
        }

        $totalRoomNightsAvailable = $totalRooms * $daysInMonth;
        $occupancyRate = $totalRoomNightsAvailable > 0
            ? round(($totalNights / $totalRoomNightsAvailable) * 100, 2)
            : 0;

        return response()->json([
            'month' => $month,
            'total_rooms' => $totalRooms,
            'total_nights_sold' => $totalNights,
            'total_room_nights_available' => $totalRoomNightsAvailable,
            'occupancy_rate' => $occupancyRate,
            'total_revenue' => $totalRevenue,
            'average_daily_rate' => $totalNights > 0 ? round($totalRevenue / $totalNights, 2) : 0,
        ]);
    }

    /**
     * Record inventory usage for boarding (food/supplies)
     */
    public function recordInventoryUsage(Request $request, int $id): JsonResponse
    {
        $boarding = Boarding::findOrFail($id);
        
        // Check access - only staff/admin can record usage
        if (!$request->user()?->hasRoleAccess('admin', 'receptionist', 'veterinary', 'inventory')) {
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
            'items.*.usage_type' => 'nullable|in:food,supply,cleaning,other',
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
            $boardingInventoryService = new BoardingInventoryService();
            $result = $boardingInventoryService->recordInventoryUsage(
                $items,
                $id,
                $boarding->pet_id,
                'Boarding food/supply usage',
                $request->user()?->id
            );
            
            if ($result['success']) {
                return response()->json([
                    'success' => true,
                    'message' => $result['message'],
                    'usages' => $result['usages'],
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
     * Get inventory usage history for a boarding record
     */
    public function getInventoryUsageHistory(int $id): JsonResponse
    {
        $boarding = Boarding::findOrFail($id);
        
        try {
            $boardingInventoryService = new BoardingInventoryService();
            $history = $boardingInventoryService->getBoardingUsageHistory($id);
            
            return response()->json([
                'success' => true,
                'history' => $history,
                'boarding_id' => $id,
                'pet_id' => $boarding->pet_id
            ]);
        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Failed to fetch usage history: ' . $e->getMessage()
            ], 500);
        }
    }
    
    /**
     * Get available inventory items for boarding usage
     */
    public function getAvailableInventoryItems(): JsonResponse
    {
        try {
            $boardingInventoryService = new BoardingInventoryService();
            $items = $boardingInventoryService->getAvailableServiceItems();
            
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
}
