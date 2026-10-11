<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Appointment;
use App\Models\Boarding;
use App\Models\Customer;
use App\Models\Grooming;
use App\Models\Service;
use App\Models\ServiceRequest;
use App\Models\ActivityLog;
use App\Models\Pet;
use App\Models\BoardingRoom;
use App\Services\EmailDeliveryService;
use App\Services\FileStorageService;
use App\Services\WorkflowNotifier;
use App\Services\BookingAvailabilityService;
use App\Services\PetServiceCompatibilityService;
use App\Services\ServiceCatalog;
use App\Services\ServiceDurationService;
use App\Support\EmailContent;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Log;
use Carbon\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class ServiceRequestController extends Controller
{
    private function normalizeServiceType(string $requestType): string
    {
        return match (strtolower(trim($requestType))) {
            'vet', 'veterinary', 'appointment', 'vet appointment' => 'veterinary',
            'hotel', 'boarding', 'pet hotel', 'pet_hotel' => 'petHotel',
            default => strtolower(trim($requestType)),
        };
    }

    private function hasAvailableHotelRoom(string $checkIn, ?string $checkOut, ?string $roomType, ?int $boardingRoomId = null): bool
    {
        $checkInDate = Carbon::parse($checkIn)->startOfDay();
        $checkOutDate = $checkOut ? Carbon::parse($checkOut)->startOfDay() : $checkInDate->copy();
        if ($checkOutDate->lessThanOrEqualTo($checkInDate)) {
            $checkOutDate = $checkInDate->copy()->addDay();
        }

        // A specific boarding room was requested — check its remaining capacity.
        if ($boardingRoomId) {
            return BookingAvailabilityService::isBoardingRoomAvailable(
                $boardingRoomId,
                $checkInDate->toDateString(),
                $checkOutDate->toDateString(),
                'boarding_rooms'
            );
        }

        $rooms = collect(BookingAvailabilityService::getBoardingAvailability(
            $checkInDate->toDateString(),
            $checkOutDate->toDateString()
        )['rooms'] ?? [])->filter(fn ($room) => (bool) ($room['available'] ?? false));

        if ($roomType) {
            $requestedType = strtolower(trim($roomType));
            $rooms = $rooms->filter(fn ($room) => str_contains(strtolower((string) ($room['type'] ?? '')), $requestedType));
        }

        return $rooms->isNotEmpty();
    }

    private function formatRequest(object $item): array
    {
        return [
            'id' => $item->id,
            'customer_id' => $item->customer_id,
            'customer' => $item->customer_name,
            'customer_name' => $item->customer_name,
            'email' => $item->customer_email,
            'customer_email' => $item->customer_email,
            'pet_id' => $item->pet_id,
            'pet' => $item->pet_name,
            'pet_name' => $item->pet_name,
            'type' => $item->request_type,
            'request_type' => $item->request_type,
            'service_type' => $item->service_name,
            'service' => $item->service_name,
            'service_name' => $item->service_name,
            'date' => $item->request_date,
            'request_date' => $item->request_date,
            'requested_date' => $item->request_date,
            'time' => $item->request_time,
            'request_time' => $item->request_time,
            'notes' => $item->notes,
            'status' => $item->status,
            'price' => $item->price,
            'amount' => $item->price,
            'payment' => $item->payment_status,
            'payment_status' => $item->payment_status,
            'payment_method' => $item->payment_method,
            'payment_reference' => $item->payment_reference,
            'payment_proof' => $item->payment_proof,
            'rejection_reason' => $item->rejection_reason,
            'created_at' => $item->created_at,
        ];
    }

    public function store(Request $request)
    {
        // Map frontend field names to backend field names before validation
        $request->merge([
            'request_type' => $request->request_type ?? $request->service_type,
            'requested_date' => $request->requested_date ?? $request->request_date ?? $request->preferred_date,
            'requested_time' => $request->requested_time ?? $request->request_time ?? $request->preferred_time,
        ]);

        $isHotel = in_array(strtolower($request->request_type ?? ''), ['hotel', 'boarding']);

        $validated = $request->validate([
            'customer_name' => 'required|string|max:150',
            'customer_email' => 'nullable|email|max:150',
            'pet_id' => 'required|integer|exists:pets,id',
            'pet_name' => 'nullable|string|max:150',
            'pet_type' => 'nullable|string|max:50',
            'request_type' => 'required|string|max:150',
            'service_name' => 'nullable|string|max:150',
            'requested_date' => 'required|date|after_or_equal:today',
            'requested_time' => $isHotel ? 'nullable|date_format:H:i' : 'required|date_format:H:i',
            'notes' => 'nullable|string',
            'check_out_date' => 'nullable|date|after_or_equal:requested_date',
            'boarding_room_id' => 'nullable|integer|exists:boarding_rooms,id',
            'room_name' => 'nullable|string|max:255',
            'room_type' => 'nullable|string|max:255',
            'total_days' => 'nullable|integer|min:1',
        ]);

        $availabilityType = $this->normalizeServiceType($validated['request_type']);

        // The selected pet is the authoritative identity — pet_name/pet_type
        // sent by the client are ignored and re-derived from the record.
        $pet = Pet::with('customer')->find($validated['pet_id']);

        if (Auth::check()) {
            $customer = $pet?->customer;
            $user = Auth::user();

            $ownsPet = $customer
                && (
                    (int) ($customer->user_id ?? 0) === (int) $user->id
                    || ($customer->email && $customer->email === $user->email)
                );

            if (!$ownsPet) {
                return response()->json([
                    'message' => 'You can only book services for your own pets.',
                ], 403);
            }

            if ($pet->isArchived()) {
                return response()->json([
                    'message' => 'Archived pets cannot be used for new bookings. Please restore the pet first.',
                    'errors' => ['pet_id' => ['Archived pets cannot be booked.']],
                ], 422);
            }

            $serviceType = $this->normalizeServiceType($validated['request_type']);
            $compatibility = PetServiceCompatibilityService::validateServiceCompatibility($pet->id, $serviceType);

            if (!($compatibility['valid'] ?? false)) {
                return response()->json([
                    'message' => $compatibility['message'] ?? 'This service is not available for this pet species.',
                    'errors' => ['pet_id' => [$compatibility['message'] ?? 'This service is not available for this pet species.']],
                    'error_code' => $compatibility['error_code'] ?? 'service_not_allowed',
                ], 422);
            }
        }

        // Validate business hours (skip for hotel bookings which don't use time slots)
        $time = $validated['requested_time'] ?? '00:00';
        if (!$isHotel && ($time < '10:00' || $time > '18:00')) {
            return response()->json([
                'message' => 'Selected time is outside shop opening hours. Please choose between 10:00 AM and 6:00 PM.',
            ], 422);
        }

        if (ServiceDurationService::isSameDayBookingClosed($validated['requested_date'])) {
            $message = 'Same-day bookings are closed after 6:00 PM. Please choose a future date.';

            return response()->json([
                'success' => false,
                'message' => $message,
                'errors' => ['requested_date' => [$message]],
            ], 422);
        }

        if ($isHotel && !$this->hasAvailableHotelRoom(
            $validated['requested_date'],
            $validated['check_out_date'] ?? null,
            $validated['room_type'] ?? null,
            $validated['boarding_room_id'] ?? null
        )) {
            $roomType = trim((string) ($validated['room_type'] ?? ''));
            $message = $roomType
                ? "No {$roomType} rooms are available for the selected stay date."
                : 'No hotel rooms are available for the selected stay date.';
            $errorField = $roomType ? 'room_type' : 'requested_date';

            return response()->json([
                'success' => false,
                'message' => $message,
                'errors' => [$errorField => [$message]],
            ], 422);
        }

        if (in_array($availabilityType, ['grooming', 'veterinary'], true)
            && !BookingAvailabilityService::isServiceTimeAvailable(
                $availabilityType === 'grooming' ? 'grooming' : 'veterinary',
                $validated['requested_date'],
                $time,
                $validated['service_name'] ?? null
            )) {
            return response()->json([
                'success' => false,
                'message' => 'This time is no longer available. Please choose another slot.',
                'errors' => ['requested_time' => ['Time slot overlaps an existing booking.']],
            ], 422);
        }

        if (!empty($validated['pet_id'])) {
            $duplicateExists = ServiceRequest::where('pet_id', $validated['pet_id'])
                ->where('request_type', $validated['request_type'])
                ->where('request_date', $validated['requested_date'])
                ->where('request_time', $validated['requested_time'])
                ->whereNotIn('status', ['cancelled', 'rejected', 'completed'])
                ->exists();

            if ($duplicateExists) {
                return response()->json([
                    'success' => false,
                    'message' => 'This pet already has a booking for the selected service, date, and time.',
                    'errors' => ['requested_time' => ['Duplicate booking for this pet and time.']],
                ], 422);
            }
        }

        // Price is always resolved server-side; client-supplied amounts are ignored.
        $price = null;
        if (!empty($validated['service_name'])) {
            $svc = Service::whereRaw('LOWER(name) = ?', [strtolower($validated['service_name'])])->first();
            if ($svc) {
                $price = $svc->price;
            }
        }

        // Fall back to the catalog bucket default so a generic or unmatched
        // service name still carries a priced estimate (e.g. "Grooming").
        if ($price === null) {
            $price = ServiceCatalog::priceFor(
                $validated['service_name'] ?? null,
                ServiceCatalog::bucketFor($validated['request_type'] ?? null)
            ) ?: null;
        }

        $createData = [
            'request_type' => $validated['request_type'],
            'customer_name' => $validated['customer_name'],
            'pet_name' => $pet->name,
            'service_name' => $validated['service_name'] ?? $validated['request_type'], // Use request_type as service_name fallback
            // Use requested_date/time as primary, fallback to preferred_date/time
            'request_date' => $validated['requested_date'],
            'request_time' => $validated['requested_time'],
            'preferred_date' => $validated['requested_date'],
            'preferred_time' => $validated['requested_time'],
            'notes' => $validated['notes'] ?? null,
            'status' => 'pending',
            'payment_status' => 'unpaid',
        ];

        if (Schema::hasColumn('service_requests', 'price')) {
            $createData['price'] = $price;
        }

        if (Schema::hasColumn('service_requests', 'customer_email')) {
            // Authenticated customers can only book as themselves — the account
            // email is authoritative; a client-supplied email is never trusted.
            $createData['customer_email'] = Auth::check()
                ? Auth::user()->email
                : ($validated['customer_email'] ?? null);
        }

        if (Schema::hasColumn('service_requests', 'pet_id')) {
            $createData['pet_id'] = $pet->id;
        }

        if (Schema::hasColumn('service_requests', 'pet_type')) {
            $createData['pet_type'] = $pet->species ?? $pet->type;
        }

        // Add room data for hotel/boarding bookings
        if ($isHotel) {
            if (Schema::hasColumn('service_requests', 'room_type')) {
                $createData['room_type'] = $validated['room_type'] ?? null;
            }
            $room = null;
            if (!empty($validated['boarding_room_id'])) {
                // Get room details from boarding_rooms table
                $room = \App\Models\BoardingRoom::find($validated['boarding_room_id']);
                if ($room) {
                    $createData['boarding_room_id'] = $room->id;
                    $createData['room_name'] = $room->room_name;
                    $createData['room_type'] = $room->room_type;
                    $createData['daily_rate'] = $room->daily_rate;
                }
            }

            // Use provided check_out_date or calculate from request
            if (!empty($validated['check_out_date'])) {
                $createData['check_out_date'] = $validated['check_out_date'];
            }

            // Nights derive from the stay dates; fall back to a supplied count.
            $totalDays = null;
            if (!empty($validated['check_out_date'])) {
                $totalDays = max(1, (int) abs(
                    Carbon::parse($validated['requested_date'])->startOfDay()
                        ->diffInDays(Carbon::parse($validated['check_out_date'])->startOfDay())
                ));
            } elseif (!empty($validated['total_days'])) {
                $totalDays = (int) $validated['total_days'];
            }
            if ($totalDays) {
                $createData['total_days'] = $totalDays;
            }

            // The payable amount is always computed from the authoritative
            // room rate; client-supplied totals are never persisted.
            if ($room && $totalDays) {
                $createData['total_amount'] = (float) $room->daily_rate * $totalDays;
            }
        }

        // Add customer_id if user is authenticated
        if (Auth::check()) {
            $createData['customer_id'] = Auth::id();
        }

        $serviceRequest = DB::transaction(function () use ($isHotel, $availabilityType, $validated, $time, $createData) {
            if ($isHotel && !$this->hasAvailableHotelRoom(
                $validated['requested_date'],
                $validated['check_out_date'] ?? null,
                $validated['room_type'] ?? null,
                $validated['boarding_room_id'] ?? null
            )) {
                return null;
            }

            if (in_array($availabilityType, ['grooming', 'veterinary'], true)) {
                Service::query()->orderBy('id')->lockForUpdate()->first();
                $serviceType = $availabilityType === 'grooming' ? 'grooming' : 'veterinary';
                if (!BookingAvailabilityService::isServiceTimeAvailable(
                    $serviceType,
                    $validated['requested_date'],
                    $time,
                    $validated['service_name'] ?? null
                )) {
                    return null;
                }
            }

            return ServiceRequest::create($createData);
        });

        if (!$serviceRequest) {
            if ($isHotel) {
                $roomType = trim((string) ($validated['room_type'] ?? ''));
                $message = $roomType
                    ? "No {$roomType} rooms remain available for the selected stay date."
                    : 'No hotel rooms remain available for the selected stay date.';
                $errorField = $roomType ? 'room_type' : 'requested_date';

                return response()->json([
                    'success' => false,
                    'message' => $message,
                    'errors' => [$errorField => [$message]],
                ], 422);
            }

            return response()->json([
                'success' => false,
                'message' => 'This time is no longer available. Please choose another slot.',
                'errors' => ['requested_time' => ['Time slot overlaps an existing booking.']],
            ], 422);
        }

        // Auto-create a pending Grooming record so groomer dashboard can see customer bookings
        if ($this->normalizeServiceType($validated['request_type']) === 'grooming') {
            try {
                $groomingPet = null;
                if (!empty($validated['pet_id'])) {
                    $groomingPet = Pet::find($validated['pet_id']);
                }
                $groomingCustomer = $groomingPet?->customer;
                if (!$groomingCustomer && !empty($serviceRequest->customer_email)) {
                    $groomingCustomer = Customer::where('email', $serviceRequest->customer_email)->first();
                }

                if ($groomingCustomer && $groomingPet) {
                    $price = (float) ($serviceRequest->price ?? 0);
                    if ($price <= 0) {
                        $price = ServiceCatalog::priceFor($validated['service_name'] ?? null, 'grooming');
                    }

                    $groomingData = [
                        'customer_id' => $groomingCustomer->id,
                        'pet_id' => $groomingPet->id,
                        'service' => $validated['service_name'] ?? 'Grooming',
                        'appointment_date' => $validated['requested_date'],
                        'appointment_time' => $validated['requested_time'] ?? '10:00',
                        'notes' => $validated['notes'] ?? null,
                        'amount' => $price,
                        'base_amount' => $price,
                        'total_amount' => $price,
                        'balance_due' => $price,
                        'status' => 'pending',
                        'payment_status' => 'unpaid',
                    ];

                    if (Schema::hasColumn('groomings', 'service_request_id')) {
                        $groomingData['service_request_id'] = $serviceRequest->id;
                    }

                    Grooming::create($groomingData);
                }
            } catch (\Throwable $e) {
                Log::warning('Auto-create grooming failed for service request #' . $serviceRequest->id . ': ' . $e->getMessage());
            }
        }

        WorkflowNotifier::notifyRole(
            'receptionist',
            'New Service Request',
            "{$serviceRequest->customer_name} submitted a {$serviceRequest->request_type} request.",
            'info',
            'service_request',
            $serviceRequest->id,
            ['customer_email' => $serviceRequest->customer_email]
        );

        WorkflowNotifier::notifyEmail(
            $serviceRequest->customer_email,
            'Service Request Submitted',
            "Your {$serviceRequest->service_name} request is waiting for receptionist approval.",
            'info',
            'service_request',
            $serviceRequest->id
        );

        app(EmailDeliveryService::class)->lifecycle(
            $serviceRequest->customer_email,
            'Service Request Submitted',
            "Your {$serviceRequest->service_name} request is waiting for receptionist approval.",
            'info',
            [
                'event_key' => 'service_request.submitted',
                'occurrence_key' => "service_request.submitted:{$serviceRequest->id}",
                'source_type' => 'service_request',
                'source_id' => $serviceRequest->id,
                'user_id' => $serviceRequest->customer_id,
                'content' => [
                    'subject' => "[Pawesome] Booking Request Received — SR-{$serviceRequest->id}",
                    'customer_name' => $serviceRequest->customer_name,
                    'intro' => "We have received your {$serviceRequest->service_name} request. Our reception team will review it shortly and update you once a decision has been made.",
                    'details' => [
                        ['label' => 'Reference', 'value' => "SR-{$serviceRequest->id}"],
                        ['label' => 'Service', 'value' => $serviceRequest->service_name],
                        ['label' => 'Pet', 'value' => $serviceRequest->pet_name],
                        ['label' => 'Preferred date', 'value' => EmailContent::date($serviceRequest->request_date)],
                        ['label' => 'Preferred time', 'value' => $serviceRequest->preferred_time ?? $serviceRequest->request_time],
                        ['label' => 'Estimated amount', 'value' => EmailContent::money($serviceRequest->total_amount ?? $serviceRequest->price)],
                    ],
                    'status' => 'Pending review',
                    'status_type' => 'info',
                    'cta_url' => EmailContent::frontendUrl('/customer/my-requests'),
                    'cta_label' => 'View Request',
                ],
            ]
        );

        return response()->json([
            'success' => true,
            'message' => 'Booking request submitted successfully.',
            'request' => $this->formatRequest($serviceRequest),
        ], 201);
    }

    public function receptionistRequests()
    {
        $requests = ServiceRequest::latest()
            ->get()
            ->map(fn ($item) => $this->formatRequest($item));

        return response()->json([
            'success' => true,
            'requests' => $requests,
        ]);
    }

    public function customerRequests(Request $request)
    {
        $user = Auth::user();

        if (!$user) {
            return response()->json([
                'success' => false,
                'message' => 'Unauthorized.',
            ], 401);
        }

        $query = ServiceRequest::query();

        $query->where(function ($scopedQuery) use ($user) {
            // Use AND logic to ensure we only get the current customer's requests
            if (Schema::hasColumn('service_requests', 'customer_id')) {
                $scopedQuery->where('customer_id', $user->id);
            } elseif (Schema::hasColumn('service_requests', 'customer_email') && $user->email) {
                $scopedQuery->where('customer_email', $user->email);
            } else {
                // Fallback: no requests if no proper customer identification field exists
                $scopedQuery->whereRaw('1 = 0');
            }
        });

        $requests = $query
            ->latest()
            ->get()
            ->map(fn ($item) => $this->formatRequest($item));

        return response()->json([
            'success' => true,
            'requests' => $requests,
        ]);
    }

    public function cancel(Request $request, $id)
    {
        $user = Auth::user();

        if (!$user) {
            return response()->json([
                'success' => false,
                'message' => 'Unauthorized.',
            ], 401);
        }

        $serviceRequest = ServiceRequest::findOrFail($id);

        if (!$this->customerOwnsRequest($serviceRequest, $user)) {
            return response()->json(['message' => 'Request not found'], 404);
        }

        if ($serviceRequest->status !== 'pending') {
            return response()->json([
                'message' => 'Only pending requests can be cancelled.',
            ], 422);
        }

        $cancelReason = trim((string) ($request->input('reason') ?: $request->input('cancellation_reason') ?: ''));

        $serviceRequest->update([
            'status' => 'cancelled',
            'payment_status' => 'unpaid',
            'cancellation_reason' => $cancelReason !== '' ? $cancelReason : null,
        ]);

        // Release linked dedicated records so their slots/rooms free up — the
        // auto-created pending Grooming would otherwise block the time slot
        // forever even though the request is cancelled.
        $linkedCancel = ['status' => 'cancelled'];
        if ($cancelReason !== '') {
            $linkedCancel['cancellation_reason'] = $cancelReason;
        }
        if (Schema::hasColumn('appointments', 'service_request_id')) {
            Appointment::where('service_request_id', $serviceRequest->id)
                ->whereNotIn('status', ['completed', 'checked_out'])
                ->update($linkedCancel);
        }
        if (Schema::hasColumn('groomings', 'service_request_id')) {
            Grooming::where('service_request_id', $serviceRequest->id)
                ->whereNotIn('status', ['completed'])
                ->update($linkedCancel + ['payment_status' => 'unpaid']);
        }
        if (Schema::hasColumn('boardings', 'service_request_id')) {
            Boarding::where('service_request_id', $serviceRequest->id)
                ->whereNotIn('status', ['checked_out', 'completed'])
                ->update($linkedCancel);
        }

        // Cancel related room reservation if this is a hotel/boarding request
        if ($serviceRequest->request_type === 'hotel' || $serviceRequest->request_type === 'boarding') {
            $reservation = \App\Models\BoardingRoomReservation::where('source_type', 'service_request')
                ->where('source_id', $serviceRequest->id)
                ->first();
            if ($reservation) {
                $reservation->update(['status' => 'cancelled']);
            }
        }

        WorkflowNotifier::notifyRole(
            'receptionist',
            'Service Request Cancelled',
            "{$serviceRequest->customer_name} cancelled a {$serviceRequest->service_name} request.",
            'warning',
            'service_request',
            $serviceRequest->id,
            ['customer_email' => $serviceRequest->customer_email]
        );

        ActivityLog::log($user->id, 'service_request_cancelled', "Customer cancelled service request #{$serviceRequest->id}", [
            'category' => 'service_requests',
            'reference_type' => 'service_request',
            'reference_id' => $serviceRequest->id,
        ]);

        return response()->json([
            'success' => true,
            'message' => 'Request cancelled successfully.',
            'request' => $this->formatRequest($serviceRequest),
        ]);
    }

    public function updateStatus(Request $request, $id)
    {
        $validated = $request->validate([
            'status' => 'required|in:pending,approved,rejected,rescheduled',
            'rejection_reason' => 'required_if:status,rejected|string|max:1000',
        ]);

        /** @var ServiceRequest|null $serviceRequest */
        $serviceRequest = ServiceRequest::find($id);

        if (!$serviceRequest) {
            return response()->json([
                'success' => false,
                'message' => 'Request not found.',
            ], 404);
        }

        $paymentStatus = $validated['status'] === 'approved'
            ? 'unpaid'
            : 'unpaid';

        $statusUpdate = [
            'status' => $validated['status'],
            'payment_status' => $paymentStatus,
        ];
        if ($validated['status'] === 'rejected') {
            $statusUpdate['rejection_reason'] = $validated['rejection_reason'];
            $statusUpdate['rejected_by'] = Auth::id();
            $statusUpdate['rejected_at'] = now();
        }

        $serviceRequest->update($statusUpdate);

        // Create room reservation if this is a hotel/boarding approval
        if ($validated['status'] === 'approved' && ($serviceRequest->request_type === 'hotel' || $serviceRequest->request_type === 'boarding')) {
            if (!empty($serviceRequest->boarding_room_id)) {
                // Get room details and create reservation
                $room = \App\Models\BoardingRoom::find($serviceRequest->boarding_room_id);
                if ($room) {
                    // Check availability one more time before creating reservation
                    // (inclusive same-day overlap: check_in <= stay_date <= check_out)
                    $stayDate = $serviceRequest->check_in_date ?? $serviceRequest->check_in_date;
                    $existingReservations = \App\Models\BoardingRoomReservation::where('room_id', $room->id)
                        ->where('check_in_date', '<=', $stayDate)
                        ->where('check_out_date', '>=', $stayDate)
                        ->whereIn('status', ['pending', 'approved', 'scheduled', 'checked_in'])
                        ->count();
                    
                    $availableRooms = $room->total_rooms - $existingReservations;
                    
                    if ($availableRooms > 0) {
                        // Create room reservation
                        $reservation = \App\Models\BoardingRoomReservation::create([
                            'room_id' => $room->id,
                            'source_type' => 'service_request',
                            'source_id' => $serviceRequest->id,
                            'pet_id' => $serviceRequest->pet_id,
                            'customer_id' => $serviceRequest->customer_id,
                            'check_in_date' => $serviceRequest->check_in_date ?? $serviceRequest->check_in_date,
                            'check_out_date' => $serviceRequest->check_out_date ?? $serviceRequest->check_in_date,
                            'status' => 'approved',
                        ]);
                        
                        // Create billing record for hotel stay
                        $checkIn = Carbon::parse($serviceRequest->check_in_date ?? $serviceRequest->check_in_date);
                        $checkOut = Carbon::parse($serviceRequest->check_out_date ?? $serviceRequest->check_in_date);
                        // Same-day stays (check_in == check_out) bill as 1 day
                        $totalDays = max(1, $checkIn->diffInDays($checkOut));
                        
                        \App\Models\ServiceItemUsage::create([
                            'service_type' => 'boarding',
                            'service_id' => $serviceRequest->id,
                            'item_type' => 'base_service',
                            'description' => $room->room_name . ' - ' . $totalDays . ' days',
                            'quantity_used' => $totalDays,
                            'unit' => 'day',
                            'unit_price' => $room->daily_rate,
                            'total_price' => $room->daily_rate * $totalDays,
                            'is_billable' => true,
                            'is_paid' => false,
                            'pet_id' => $serviceRequest->pet_id,
                            'customer_id' => $serviceRequest->customer_id,
                        ]);
                    }
                }
            }
        }

        $statusMessage = $validated['status'] === 'rejected'
            ? "Your {$serviceRequest->service_name} request has been rejected. Reason: {$validated['rejection_reason']}"
            : "Your {$serviceRequest->service_name} request is now {$validated['status']}.";

        WorkflowNotifier::notifyEmail(
            $serviceRequest->customer_email,
            'Service Request Updated',
            $statusMessage,
            $validated['status'] === 'rejected' ? 'error' : 'success',
            'service_request',
            $serviceRequest->id
        );

        $isRejected = $validated['status'] === 'rejected';
        app(EmailDeliveryService::class)->lifecycle(
            $serviceRequest->customer_email,
            'Service Request Updated',
            $statusMessage,
            $isRejected ? 'error' : 'success',
            [
                'event_key' => 'service_request.status',
                'occurrence_key' => "service_request.status:{$serviceRequest->id}:{$validated['status']}:" . $serviceRequest->updated_at?->format('Uv'),
                'source_type' => 'service_request',
                'source_id' => $serviceRequest->id,
                'user_id' => $serviceRequest->customer_id,
                'content' => [
                    'subject' => "[Pawesome] Service Request " . EmailContent::status($validated['status']) . " — SR-{$serviceRequest->id}",
                    'customer_name' => $serviceRequest->customer_name,
                    'intro' => $isRejected
                        ? "We are writing to inform you that your {$serviceRequest->service_name} request could not be approved at this time."
                        : "Your {$serviceRequest->service_name} request has been updated. Please review the latest status below.",
                    'details' => [
                        ['label' => 'Reference', 'value' => "SR-{$serviceRequest->id}"],
                        ['label' => 'Service', 'value' => $serviceRequest->service_name],
                        ['label' => 'Pet', 'value' => $serviceRequest->pet_name],
                        ['label' => 'Date', 'value' => EmailContent::date($serviceRequest->request_date)],
                        ['label' => 'Time', 'value' => $serviceRequest->preferred_time ?? $serviceRequest->request_time],
                        ['label' => 'Reason', 'value' => $isRejected ? ($validated['rejection_reason'] ?? null) : null],
                    ],
                    'status' => EmailContent::status($validated['status']),
                    'status_type' => $isRejected ? 'error' : 'success',
                    'cta_url' => EmailContent::frontendUrl('/customer/my-requests'),
                    'cta_label' => 'View Request',
                ],
            ]
        );

        ActivityLog::log(Auth::id() ?? 0, 'service_request_' . $validated['status'], "Service request #{$serviceRequest->id} set to {$validated['status']}", [
            'category' => 'service_requests',
            'reference_type' => 'service_request',
            'reference_id' => $serviceRequest->id,
        ]);

        return response()->json([
            'success' => true,
            'message' => 'Request status updated successfully.',
            'request' => $this->formatRequest($serviceRequest),
        ]);
    }

    public function uploadPaymentProof(Request $request, $id)
    {
        $user = Auth::user();
        
        if (!$user) {
            return response()->json(['message' => 'Unauthorized'], 401);
        }

        $validated = $request->validate([
            'payment_method' => 'required|in:cash,gcash,maya',
            'payment_reference' => 'required_unless:payment_method,cash|nullable|string|max:255',
            'payment_proof' => 'required_unless:payment_method,cash|nullable|file|mimes:jpg,jpeg,png,pdf|max:5120',
        ]);

        $serviceRequest = ServiceRequest::findOrFail($id);

        if (!$this->customerOwnsRequest($serviceRequest, $user)) {
            return response()->json(['message' => 'Forbidden: You can only upload proof for your own requests'], 403);
        }

        // Only allow payment proof upload for approved or scheduled requests
        if (!in_array($serviceRequest->status, ['approved', 'scheduled'])) {
            return response()->json([
                'message' => 'Payment proof can only be uploaded for approved requests.',
            ], 403);
        }

        // Reject upload if payment is already pending or paid
        if (in_array($serviceRequest->payment_status, ['pending', 'paid'])) {
            return response()->json([
                'message' => 'Payment proof has already been uploaded or payment is verified.',
            ], 422);
        }

        $paymentData = [
            'payment_method' => $validated['payment_method'],
            'payment_reference' => $validated['payment_reference'] ?? null,
            'payment_status' => 'pending',
        ];

        if ($request->hasFile('payment_proof')) {
            // Replaced (rejected) proofs are retained as payment evidence (deleteOld: false).
            FileStorageService::storeAndPersist(
                $request->file('payment_proof'), 'payment-proofs', 'private',
                fn (string $path) => $serviceRequest->update($paymentData + [
                    'payment_proof' => $path,
                ]),
                deleteOld: false,
                prefix: 'proof',
            );
        } else {
            // Cash payments are verified by the cashier at the counter — no proof file.
            $serviceRequest->update($paymentData);
        }

        // Keep the linked booking's payment state in step with the request —
        // a resubmitted proof supersedes a prior rejection on either row.
        $linkedTable = match (ServiceCatalog::bucketFor($serviceRequest->request_type ?? null)) {
            'grooming' => 'groomings',
            'hotel' => 'boardings',
            'vet' => 'appointments',
            default => null,
        };
        if ($linkedTable && Schema::hasColumn($linkedTable, 'service_request_id')) {
            $linkedUpdates = ['payment_status' => 'pending'];
            if (Schema::hasColumn($linkedTable, 'payment_method')) {
                $linkedUpdates['payment_method'] = $validated['payment_method'];
            }
            if (Schema::hasColumn($linkedTable, 'payment_reference')) {
                $linkedUpdates['payment_reference'] = $validated['payment_reference'] ?? null;
            }
            $freshProof = $serviceRequest->fresh()->payment_proof ?? null;
            if (Schema::hasColumn($linkedTable, 'payment_proof') && $freshProof) {
                $linkedUpdates['payment_proof'] = $freshProof;
            }
            if (Schema::hasColumn($linkedTable, 'updated_at')) {
                $linkedUpdates['updated_at'] = now();
            }
            DB::table($linkedTable)
                ->where('service_request_id', $serviceRequest->id)
                ->where('payment_status', '!=', 'paid')
                ->update($linkedUpdates);
        }

        $isCash = $validated['payment_method'] === 'cash';

        // Notify cashier role
        $this->notifyRole(
            'cashier',
            $isCash ? 'New Cash Payment' : 'New Payment Proof Uploaded',
            ($isCash
                ? 'A customer will pay in cash at the counter for service request #'
                : 'A customer uploaded payment proof for service request #')
                . $serviceRequest->id,
            'info',
            'service_request',
            $serviceRequest->id
        );

        // Notify customer about payment pending verification
        $paymentSubmittedMessage = $isCash
            ? "Your cash payment for {$serviceRequest->service_name} is pending verification at the counter."
            : "Your payment proof for {$serviceRequest->service_name} is pending verification.";

        WorkflowNotifier::notifyEmail(
            $serviceRequest->customer_email,
            'Payment Submitted',
            $paymentSubmittedMessage,
            'info',
            'service_request',
            $serviceRequest->id
        );

        app(EmailDeliveryService::class)->lifecycle(
            $serviceRequest->customer_email,
            'Payment Submitted',
            $paymentSubmittedMessage,
            'info',
            [
                'event_key' => 'payment.proof_submitted',
                'occurrence_key' => "service_request:{$serviceRequest->id}:{$serviceRequest->fresh()->updated_at->getTimestamp()}",
                'source_type' => 'service_request',
                'source_id' => $serviceRequest->id,
                'user_id' => $serviceRequest->customer_id,
                'suppression' => [[
                    'type' => 'model_field',
                    'table' => 'service_requests',
                    'id' => $serviceRequest->id,
                    'field' => 'payment_status',
                    'allowed' => ['pending', 'paid', 'partial'],
                ]],
                'content' => [
                    'subject' => "[Pawesome] Payment Received for Verification — SR-{$serviceRequest->id}",
                    'customer_name' => $serviceRequest->customer_name,
                    'intro' => $isCash
                        ? "Your cash payment for {$serviceRequest->service_name} will be verified by our cashier at the counter."
                        : "We have received your payment submission for {$serviceRequest->service_name}. Our cashier will verify it shortly.",
                    'details' => [
                        ['label' => 'Reference', 'value' => "SR-{$serviceRequest->id}"],
                        ['label' => 'Service', 'value' => $serviceRequest->service_name],
                        ['label' => 'Pet', 'value' => $serviceRequest->pet_name],
                        ['label' => 'Amount due', 'value' => EmailContent::money($serviceRequest->total_amount ?? $serviceRequest->price)],
                        ['label' => 'Payment method', 'value' => ucfirst((string) $validated['payment_method'])],
                        ['label' => 'Payment reference', 'value' => $validated['payment_reference'] ?? null],
                        ['label' => 'Submitted', 'value' => EmailContent::datetime(now())],
                    ],
                    'status' => 'Pending verification',
                    'status_type' => 'warning',
                    'cta_url' => EmailContent::frontendUrl('/customer/payments'),
                    'cta_label' => 'View Payment',
                ],
            ]
        );

        ActivityLog::log($user->id, 'payment_proof_uploaded', "Customer uploaded proof for service request #{$serviceRequest->id}", [
            'category' => 'service_requests',
            'reference_type' => 'service_request',
            'reference_id' => $serviceRequest->id,
        ]);

        return response()->json([
            'success' => true,
            'message' => 'Payment submitted successfully. Waiting for cashier verification.',
            'request' => $this->formatRequest($serviceRequest),
            'payment_status' => 'pending',
            'proof_url' => "/api/files/payment-proofs/service-request/{$serviceRequest->id}/view",
        ]);
    }

    public function receipt(Request $request, $id)
    {
        $user = Auth::user();

        if (!$user) {
            return response()->json(['message' => 'Unauthorized'], 401);
        }

        $serviceRequest = ServiceRequest::findOrFail($id);

        $isOwner = false;
        if (Schema::hasColumn('service_requests', 'customer_id') && $serviceRequest->customer_id) {
            $isOwner = (int) $serviceRequest->customer_id === (int) $user->id;
        } elseif (Schema::hasColumn('service_requests', 'customer_email') && $serviceRequest->customer_email) {
            $isOwner = $serviceRequest->customer_email === $user->email;
        }

        if (!$isOwner) {
            return response()->json(['message' => 'Receipt not found'], 404);
        }

        if ($serviceRequest->payment_status !== 'paid') {
            return response()->json([
                'message' => 'Receipt is only available after payment verification.',
            ], 422);
        }

        $totalAmount = (float) ($serviceRequest->total_amount ?? $serviceRequest->price ?? 0);
        $vatAmount = EmailContent::vatInclusivePortion($totalAmount);

        return response()->json([
            'receipt' => [
                'receipt_number' => $serviceRequest->receipt_number,
                'request_id' => $serviceRequest->id,
                'customer_name' => $serviceRequest->customer_name,
                'customer_email' => $serviceRequest->customer_email,
                'pet_name' => $serviceRequest->pet_name,
                'service_type' => $serviceRequest->request_type ?? $serviceRequest->service_type,
                'service_name' => $serviceRequest->service_name,
                'service_date' => $serviceRequest->request_date,
                'net_amount' => $vatAmount !== null ? round($totalAmount - $vatAmount, 2) : null,
                'vat_amount' => $vatAmount,
                'vat_rate' => 0.12,
                'total_amount' => $serviceRequest->total_amount ?? $serviceRequest->price,
                'payment_status' => $serviceRequest->payment_status,
                'payment_method' => $serviceRequest->payment_method,
                'payment_reference' => $serviceRequest->reference_number ?? $serviceRequest->payment_reference,
                'paid_at' => $serviceRequest->paid_at,
                'verified_by' => $serviceRequest->verified_by,
                'cashier_remarks' => $serviceRequest->cashier_remarks,
                'created_at' => $serviceRequest->created_at,
            ],
        ]);
    }

    private function notifyRole($role, $title, $message, $type = 'info', $relatedType = null, $relatedId = null, $data = [])
    {
        try {
            WorkflowNotifier::notifyRole($role, $title, $message, $type, $relatedType, $relatedId, $data);
        } catch (\Throwable $e) {
            Log::warning('notifyRole failed: ' . $e->getMessage());
        }
    }

    private function customerOwnsRequest(ServiceRequest $serviceRequest, $user): bool
    {
        if (Schema::hasColumn('service_requests', 'customer_id') && $serviceRequest->customer_id) {
            return (int) $serviceRequest->customer_id === (int) $user->id;
        }

        return Schema::hasColumn('service_requests', 'customer_email')
            && $serviceRequest->customer_email
            && $serviceRequest->customer_email === $user->email;
    }
}
