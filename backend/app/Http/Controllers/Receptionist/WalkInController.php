<?php

namespace App\Http\Controllers\Receptionist;

use App\Http\Controllers\Controller;
use App\Models\User;
use App\Models\Customer;
use App\Models\Pet;
use App\Models\ServiceRequest;
use App\Models\Boarding;
use App\Models\Appointment;
use App\Models\Grooming;
use App\Models\Service;
use App\Mail\AccountWelcomeMail;
use App\Services\EmailDeliveryService;
use App\Services\ServiceCatalog;
use App\Services\WorkflowNotifier;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Validator;
use Illuminate\Support\Str;

class WalkInController extends Controller
{
    /**
     * Create a walk-in booking for existing or new customers
     */
    public function store(Request $request): JsonResponse
    {
        $validator = Validator::make($request->all(), [
            'customer_mode' => 'required|in:existing,new',
            'customer_id' => 'required_if:customer_mode,existing|integer',
            'pet_id' => 'required_if:customer_mode,existing|integer',
            'customer' => 'required_if:customer_mode,new|array',
            'customer.first_name' => 'required_if:customer_mode,new|string|max:255',
            'customer.last_name' => 'required_if:customer_mode,new|string|max:255',
            'customer.email' => 'required_if:customer_mode,new|email|max:255|unique:users,email',
            'customer.phone' => 'required_if:customer_mode,new|string|max:20',
            'pet' => 'required_if:customer_mode,new|array',
            'pet.name' => 'required_if:customer_mode,new|string|max:255',
            'pet.species' => 'required_if:customer_mode,new|string|max:255',
            'booking' => 'required|array',
            'booking.service_type' => 'required|in:hotel,veterinary,grooming',
            'booking.service_name' => 'required|string|max:255',
            'booking.request_date' => 'required|date',
            'booking.request_time' => 'nullable|string|max:10',
            'booking.notes' => 'nullable|string',
        ]);

        if ($validator->fails()) {
            return response()->json([
                'success' => false,
                'message' => 'Validation failed',
                'errors' => $validator->errors(),
            ], 422);
        }

        try {
            $response = DB::transaction(function () use ($request) {
                $customerMode = $request->input('customer_mode');
                $bookingData = $request->input('booking');
                $serviceType = $bookingData['service_type'];

                // Step 1: Get or create customer
                if ($customerMode === 'new') {
                    $customerData = $request->input('customer');
                    $petData = $request->input('pet');

                    // Random unknown password — the customer sets their own via
                    // the emailed set-password link (never hand out credentials).
                    $user = User::create([
                        'name' => $customerData['first_name'] . ' ' . $customerData['last_name'],
                        'email' => $customerData['email'],
                        'password' => Hash::make(Str::random(40)),
                        'role' => 'customer',
                        'is_active' => true,
                    ]);

                    // Set-password token and its delivery intent are issued
                    // atomically with the account — a rolled-back booking
                    // leaves neither a token nor a queued welcome email.
                    $resetToken = Str::random(64);
                    $resetTable = config('auth.passwords.users.table');
                    DB::table($resetTable)->where('email', $customerData['email'])->delete();
                    DB::table($resetTable)->insert([
                        'email' => $customerData['email'],
                        'token' => Hash::make($resetToken),
                        'created_at' => now(),
                    ]);
                    app(EmailDeliveryService::class)->intent(
                        new AccountWelcomeMail(
                            $resetToken,
                            $customerData['email'],
                            $customerData['first_name'] . ' ' . $customerData['last_name'],
                            '',
                            'customer'
                        ),
                        [
                            'event_key' => 'auth.account_welcome',
                            'occurrence_key' => 'auth.walkin_welcome:' . $user->id . ':' . sha1($resetToken),
                            'source_type' => 'user',
                            'source_id' => $user->id,
                            'user_id' => $user->id,
                            'recipient' => $customerData['email'],
                            'expires_at' => now()->addMinutes((int) config('auth.passwords.users.expire', 60)),
                            'suppression' => [
                                ['type' => 'token_row', 'table' => $resetTable, 'email' => $customerData['email'], 'token' => $resetToken],
                                ['type' => 'user_active', 'user_id' => $user->id],
                            ],
                        ]
                    );

                    // Create customer record
                    $customer = Customer::create([
                        'user_id' => $user->id,
                        'name' => $customerData['first_name'] . ' ' . $customerData['last_name'],
                        'email' => $customerData['email'],
                        'phone' => $customerData['phone'],
                        'address' => $customerData['address'] ?? null,
                    ]);

                    // Create pet record
                    $pet = Pet::create([
                        'customer_id' => $customer->id,
                        'name' => $petData['name'],
                        'species' => $petData['species'],
                        'breed' => $petData['breed'] ?? null,
                        'age' => $petData['age'] ?? null,
                        'sex' => $petData['sex'] ?? null,
                        'weight' => $petData['weight'] ?? null,
                    ]);

                    $customerId = $customer->id;
                    $petId = $pet->id;
                    $isNewCustomer = true;
                } else {
                    // Existing customer
                    $customerId = $request->input('customer_id');
                    $petId = $request->input('pet_id');
                    $isNewCustomer = false;

                    // Verify customer exists
                    $customer = Customer::find($customerId);
                    if (!$customer) {
                        throw new HttpResponseException(response()->json([
                            'success' => false,
                            'message' => 'Customer not found',
                        ], 404));
                    }

                    // Verify pet exists and belongs to customer
                    $pet = Pet::where('id', $petId)
                        ->where('customer_id', $customerId)
                        ->first();
                    if (!$pet) {
                        throw new HttpResponseException(response()->json([
                            'success' => false,
                            'message' => 'Pet not found or does not belong to this customer',
                        ], 404));
                    }
                }

                // Step 2: Create service request
                $serviceRequest = ServiceRequest::create([
                    'request_type' => $serviceType,
                    'customer_id' => $customer->user_id,
                    'customer_name' => $customer->name,
                    'customer_email' => $customer->email,
                    'pet_id' => $petId,
                    'pet_name' => $pet->name,
                    'service_name' => $bookingData['service_name'],
                    'request_date' => $bookingData['request_date'],
                    'request_time' => $bookingData['request_time'] ?? null,
                    'notes' => $bookingData['notes'] ?? null,
                    'status' => 'pending',
                    'payment_status' => 'pending',
                    'price' => 0, // Will be updated below for hotel, or on approval
                ]);

                // Step 3: Create specific booking record based on service type
                $bookingRecord = null;
                $bookingType = null;

                if ($serviceType === 'hotel') {
                    $ratePerDay = (float)($bookingData['rate_per_day'] ?? 0);
                    $hotelRoomId = $bookingData['hotel_room_id'] ?? $bookingData['room_id'] ?? null;

                    if ($hotelRoomId) {
                        $room = \App\Models\HotelRoom::lockForUpdate()->find($hotelRoomId);
                        if (!$room || $room->status !== 'available') {
                            throw new HttpResponseException(response()->json([
                                'success' => false,
                                'message' => 'Selected room is not available.',
                            ], 422));
                        }

                        // Same-day boarding occupies the room for the whole date
                        $date = $bookingData['request_date'];
                        $conflict = Boarding::where('hotel_room_id', $room->id)
                            ->whereNotIn('status', ['rejected', 'cancelled', 'checked_out', 'completed'])
                            ->where('check_in', '<=', $date)
                            ->where('check_out', '>=', $date)
                            ->exists();
                        if ($conflict) {
                            throw new HttpResponseException(response()->json([
                                'success' => false,
                                'message' => 'Selected room is already booked for that date.',
                            ], 422));
                        }

                        if ($ratePerDay == 0) {
                            $ratePerDay = (float)$room->daily_rate;
                        }
                    }

                    // Store operates 9 AM - 7 PM: boarding stays are same-day
                    $numberOfDays = 1;
                    $checkOutDate = $bookingData['request_date'];

                    $totalAmount = $ratePerDay * $numberOfDays;

                    // Update ServiceRequest price with the totalAmount
                    $serviceRequest->price = $totalAmount;
                    $serviceRequest->save();

                    $bookingRecord = Boarding::create([
                        'service_request_id' => $serviceRequest->id,
                        'pet_id' => $petId,
                        'pet_name' => $pet->name,
                        'pet_type' => $pet->species,
                        'customer_id' => $customerId,
                        'customer_name' => $customer->name,
                        'customer_email' => $customer->email,
                        'check_in' => $bookingData['request_date'],
                        'check_out' => $checkOutDate,
                        'hotel_room_id' => $hotelRoomId,
                        'boarding_type' => $bookingData['room_type'] ?? null,
                        'total_amount' => $totalAmount,
                        'status' => 'pending',
                        'payment_status' => 'pending',
                        'notes' => $bookingData['special_requests'] ?? null,
                        'stay_type' => 'hotel_boarding',
                    ]);
                    $bookingType = 'boarding';
                } elseif ($serviceType === 'veterinary') {
                    // Resolve the Service ID based on service_name select option
                    $service = Service::where('name', $bookingData['service_name'])->first();
                    if (!$service) {
                        $service = Service::whereIn('category', ['Consultation', 'Vaccination', 'Treatment', 'Emergency', 'Surgery', 'Dental', 'Diagnostics'])->first();
                    }
                    
                    $serviceId = $service ? $service->id : null;
                    $servicePrice = $service ? (float)$service->price : 0.0;

                    if (!$serviceId) {
                        $firstService = Service::first();
                        $serviceId = $firstService ? $firstService->id : 1;
                        $servicePrice = $firstService ? (float)$firstService->price : 0.0;
                    }

                    // Update service request price
                    $serviceRequest->price = $servicePrice;
                    $serviceRequest->save();

                    $bookingRecord = Appointment::create([
                        'service_request_id' => $serviceRequest->id,
                        'customer_id' => $customerId,
                        'pet_id' => $petId,
                        'service_id' => $serviceId,
                        'scheduled_at' => $bookingData['request_date'] . ' ' . ($bookingData['request_time'] ?? '10:00'),
                        'veterinarian_id' => $bookingData['veterinarian_id'] ?? null,
                        'status' => 'pending',
                        'notes' => $bookingData['reason'] ?? null,
                        'price' => $servicePrice,
                    ]);
                    $bookingType = 'appointment';
                } elseif ($serviceType === 'grooming') {
                    $groomingPrice = ServiceCatalog::priceFor(
                        $bookingData['service_name'] ?? null,
                        'grooming'
                    );

                    if ($groomingPrice > 0) {
                        $serviceRequest->price = $groomingPrice;
                        $serviceRequest->save();
                    }

                    $bookingRecord = Grooming::create([
                        'service_request_id' => $serviceRequest->id,
                        'customer_id' => $customerId,
                        'pet_id' => $petId,
                        'service' => $bookingData['service_name'],
                        'appointment_date' => $bookingData['request_date'],
                        'appointment_time' => $bookingData['request_time'] ?? null,
                        'amount' => $groomingPrice,
                        'base_amount' => $groomingPrice,
                        'total_amount' => $groomingPrice,
                        'balance_due' => $groomingPrice,
                        'status' => 'pending',
                        'payment_status' => 'unpaid',
                        'notes' => $bookingData['grooming_instructions'] ?? null,
                    ]);
                    $bookingType = 'grooming';
                }

                // Send notification to receptionists
                WorkflowNotifier::notifyRole(
                    'receptionist',
                    'New Walk-in Booking',
                    "Walk-in {$serviceType} booking created for {$customer->name} - Pet: {$pet->name}",
                    'info',
                    $serviceType,
                    $serviceRequest->id,
                    ['customer_email' => $customer->email]
                );

                // Send notification to customer if new
                if ($isNewCustomer) {
                    WorkflowNotifier::notifyEmail(
                        $customer->email,
                        'Welcome to Pawesome - Your Account Details',
                        "Welcome! Your walk-in booking has been created. We emailed a secure link to {$customer->email} so you can set your password and access your account.",
                        'success',
                        'account_created',
                        $serviceRequest->id
                    );
                } else {
                    WorkflowNotifier::notifyEmail(
                        $customer->email,
                        'New Booking Created',
                        "Your walk-in {$serviceType} booking has been created for {$pet->name} on {$bookingData['request_date']}. We will confirm your booking shortly.",
                        'success',
                        $serviceType,
                        $serviceRequest->id
                    );
                }

                return response()->json([
                    'success' => true,
                    'message' => 'Walk-in booking created successfully',
                    'data' => [
                        'service_request_id' => $serviceRequest->id,
                        'booking_id' => $bookingRecord->id,
                        'booking_type' => $bookingType,
                        'customer_id' => $customerId,
                        'pet_id' => $petId,
                        'is_new_customer' => $isNewCustomer,
                    ],
                ], 201);
            });

            return $response;
        } catch (HttpResponseException $e) {
            return $e->getResponse();
        } catch (\Exception $e) {
            Log::error('Walk-in booking creation failed: ' . $e->getMessage());
            return response()->json([
                'success' => false,
                'message' => 'Failed to create walk-in booking',
                'error' => $e->getMessage(),
            ], 500);
        }
    }

    /**
     * Search customers by name, email, or phone
     */
    public function searchCustomers(Request $request): JsonResponse
    {
        $query = $request->input('q');
        
        if ($query === null) {
            return response()->json([
                'success' => true,
                'data' => [],
            ]);
        }

        if (strlen($query) === 0) {
            $customers = Customer::with(['pets'])->limit(50)->get();
            return response()->json([
                'success' => true,
                'data' => $customers,
            ]);
        }

        if (strlen($query) < 2) {
            return response()->json([
                'success' => true,
                'data' => [],
            ]);
        }

        try {
            $customers = Customer::where(function ($q) use ($query) {
                $q->where('name', 'LIKE', "%{$query}%")
                    ->orWhere('email', 'LIKE', "%{$query}%")
                    ->orWhere('phone', 'LIKE', "%{$query}%");
            })
            ->with(['pets'])
            ->limit(10)
            ->get();

            return response()->json([
                'success' => true,
                'data' => $customers,
            ]);
        } catch (\Exception $e) {
            Log::error('Customer search failed: ' . $e->getMessage());
            return response()->json([
                'success' => false,
                'message' => 'Failed to search customers',
            ], 500);
        }
    }
}
