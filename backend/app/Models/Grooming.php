<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\SoftDeletes;

class Grooming extends Model
{
    use SoftDeletes;
    protected $fillable = [
        'customer_id',
        'pet_id',
        'service',
        'appointment_date',
        'appointment_time',
        'notes',
        'amount',
        'payment_status',
        'base_amount',
        'additional_charges',
        'total_amount',
        'amount_paid',
        'balance_due',
        'payment_method',
        'payment_reference',
        'payment_proof',
        'paid_at',
        'verified_by',
        'cashier_remarks',
        'receipt_number',
        'completed_at',
        'status',
        'service_request_id',
        'cancellation_reason',
    ];

    protected $casts = [
        'appointment_date' => 'date',
        'amount' => 'decimal:2',
        'base_amount' => 'decimal:2',
        'additional_charges' => 'decimal:2',
        'total_amount' => 'decimal:2',
        'amount_paid' => 'decimal:2',
        'balance_due' => 'decimal:2',
        'paid_at' => 'datetime',
        'completed_at' => 'datetime',
    ];

    public function customer()
    {
        return $this->belongsTo(Customer::class);
    }

    public function pet()
    {
        return $this->belongsTo(Pet::class);
    }
}
