<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Support\Facades\Schema;

class Boarding extends Model
{
    use HasFactory;

    protected $fillable = [
        'pet_id',
        'pet_name',
        'pet_type',
        'pet_breed',
        'customer_id',
        'customer_email',
        'customer_name',
        'room_id',
        'room_name',
        'room_type',
        'rate_per_day',
        'number_of_days',
        'hotel_room_id', // Keep for backward compatibility
        'stay_type',
        'check_in',
        'check_in_time',
        'check_out',
        'check_out_time',
        'boarding_type',
        'status',
        'base_amount',
        'additional_charges',
        'total_amount',
        'amount_paid',
        'balance_due',
        'payment_status',
        'payment_method',
        'payment_reference',
        'payment_proof',
        'paid_at',
        'verified_by',
        'cashier_remarks',
        'receipt_number',
        'notes',
        'special_requests',
        'feeding_instructions',
        'medication_notes',
        'reminder_sent_at',
        'emergency_contact',
        'vaccination_card',
        'vaccination_card_verified_at',
        'approved_by',
        'approved_at',
        'rejected_by',
        'rejected_at',
        'rejection_reason',
        'cancellation_reason',
        'confirmed_at',
        'actual_check_in',
        'checked_in_by',
        'checked_in_at',
        'ready_for_pickup_by',
        'ready_for_pickup_at',
        'actual_check_out',
        'checked_out_by',
        'checked_out_at',
        'service_request_id',
    ];

    protected $appends = [
        'vaccination_card_url',
    ];

    protected $casts = [
        'check_in' => 'datetime',
        'check_out' => 'datetime',
        'actual_check_in' => 'datetime',
        'actual_check_out' => 'datetime',
        'checked_in_at' => 'datetime',
        'ready_for_pickup_at' => 'datetime',
        'checked_out_at' => 'datetime',
        'confirmed_at' => 'datetime',
        'approved_at' => 'datetime',
        'rejected_at' => 'datetime',
        'paid_at' => 'datetime',
        'reminder_sent_at' => 'datetime',
        'vaccination_card_verified_at' => 'datetime',
        'base_amount' => 'decimal:2',
        'additional_charges' => 'decimal:2',
        'total_amount' => 'decimal:2',
        'amount_paid' => 'decimal:2',
        'balance_due' => 'decimal:2',
    ];

    /**
     * Valid boarding statuses
     */
    public const VALID_STATUSES = [
        'pending',
        'approved',
        'scheduled',
        'confirmed',
        'checked_in',
        'in_care',
        'ready_for_pickup',
        'checked_out',
        'completed',
        'cancelled',
        'rejected',
    ];

    /**
     * Valid payment statuses
     */
    public const VALID_PAYMENT_STATUSES = ['unpaid', 'pending', 'partial', 'balance_due', 'paid', 'rejected', 'refunded'];

    /**
     * Boot method for model-level validation
     */
    protected static function boot()
    {
        parent::boot();

        static::saving(function ($boarding) {
            // Validate status
            if (!in_array($boarding->status, self::VALID_STATUSES)) {
                $boarding->status = 'pending';
            }

            // Validate payment status
            if (!in_array($boarding->payment_status, self::VALID_PAYMENT_STATUSES)) {
                $boarding->payment_status = 'pending';
            }

            // Ensure non-negative amount
            $boarding->total_amount = max(0, (float) $boarding->total_amount);

            // Ensure check_out is after check_in
            if ($boarding->check_in && $boarding->check_out) {
                $checkIn = $boarding->check_in instanceof \Carbon\Carbon 
                    ? $boarding->check_in 
                    : \Carbon\Carbon::parse($boarding->check_in);
                $checkOut = $boarding->check_out instanceof \Carbon\Carbon 
                    ? $boarding->check_out 
                    : \Carbon\Carbon::parse($boarding->check_out);
                
                if ($checkOut->lessThanOrEqualTo($checkIn)) {
                    $boarding->check_out = $checkIn->copy()->addDay();
                }
            }
        });
    }

    public function pet(): BelongsTo
    {
        return $this->belongsTo(Pet::class);
    }

    public function customer(): BelongsTo
    {
        return $this->belongsTo(Customer::class);
    }

    /**
     * Get the hotel room associated with the boarding
     */
    public function hotelRoom(): BelongsTo
    {
        return $this->belongsTo(HotelRoom::class, 'hotel_room_id');
    }

    /**
     * Get the room reservation associated with the boarding
     */
    public function roomReservation(): HasOne
    {
        $foreignKey = Schema::hasColumn('boarding_room_reservations', 'source_id')
            ? 'source_id'
            : 'boarding_booking_id';
        $relation = $this->hasOne(BoardingRoomReservation::class, $foreignKey);

        if (Schema::hasColumn('boarding_room_reservations', 'source_type')) {
            $relation->whereIn('source_type', ['pet_hotel', 'vet_boarding']);
        }

        return $relation;
    }

    /**
     * Get the room reservations associated with the boarding
     */
    public function roomReservations(): HasMany
    {
        $foreignKey = Schema::hasColumn('boarding_room_reservations', 'source_id')
            ? 'source_id'
            : 'boarding_booking_id';
        $relation = $this->hasMany(BoardingRoomReservation::class, $foreignKey);

        if (Schema::hasColumn('boarding_room_reservations', 'source_type')) {
            $relation->whereIn('source_type', ['pet_hotel', 'vet_boarding']);
        }

        return $relation;
    }

    /**
     * Get the booking add-ons for this boarding
     */
    public function bookingAddOns(): HasMany
    {
        return $this->hasMany(BookingAddOn::class, 'booking_id');
    }

    public function careLogs()
    {
        return $this->hasMany(BoardingCareLog::class);
    }

    public function payments()
    {
        return $this->hasMany(Payment::class);
    }

    public function scopeCurrent($query)
    {
        return $query->whereIn('status', ['approved', 'scheduled', 'confirmed', 'checked_in', 'in_care'])
            ->where('check_out', '>=', now());
    }

    public function scopeCheckedIn($query)
    {
        return $query->where('status', 'checked_in');
    }

    public function scopePending($query)
    {
        return $query->where('status', 'pending');
    }

    public function scopeForDateRange($query, $start, $end)
    {
        return $query->whereBetween('check_in', [$start, $end])
            ->orWhereBetween('check_out', [$start, $end]);
    }

    public function calculateTotalAmount()
    {
        if (!$this->hotel_room_id || !$this->check_in || !$this->check_out) {
            return 0;
        }

        $days = $this->check_in->diffInDays($this->check_out);
        $days = max(1, $days);

        return $days * $this->hotelRoom->daily_rate;
    }

    public function confirm()
    {
        $this->update([
            'status' => 'approved',
            'confirmed_at' => now(),
            'approved_at' => now(),
        ]);

        $this->hotelRoom?->update(['status' => 'reserved']);
    }

    public function checkIn()
    {
        $this->update([
            'status' => 'in_care',
            'actual_check_in' => now(),
            'checked_in_at' => now(),
        ]);

        $this->hotelRoom?->update(['status' => 'occupied']);
    }

    public function checkOut()
    {
        $this->update([
            'status' => 'completed',
            'actual_check_out' => now(),
            'checked_out_at' => now(),
        ]);

        $this->hotelRoom?->update(['status' => 'available']);
    }

    public function cancel()
    {
        $this->update(['status' => 'cancelled']);

        // Release room back to available if it was reserved or occupied
        if ($this->hotelRoom && in_array($this->hotelRoom->status, ['reserved', 'occupied'])) {
            $this->hotelRoom->update(['status' => 'available']);
        }
    }

    protected function getVaccinationCardUrlAttribute(): ?string
    {
        if (!$this->vaccination_card) {
            return null;
        }

        return '/files/vaccination-cards/' . $this->id . '/view';
    }
}
