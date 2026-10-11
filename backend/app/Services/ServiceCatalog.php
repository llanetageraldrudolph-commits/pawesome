<?php

namespace App\Services;

use App\Models\Service;
use App\Models\ServiceRequest;
use Illuminate\Support\Facades\Schema;

/**
 * Single source of truth for mapping a booking's free-text service name +
 * request type onto the priced `services` catalog row.
 *
 * Every path that creates a payable booking record (service_requests,
 * groomings, boardings, appointments) should resolve the price through here
 * so a missing/unmatched service name can never produce a ₱0 billing.
 */
class ServiceCatalog
{
    /**
     * Normalize the various request_type spellings used across the codebase
     * into catalog buckets.
     */
    public static function bucketFor(?string $type): string
    {
        return match (strtolower(trim((string) $type))) {
            'grooming' => 'grooming',
            'hotel', 'boarding', 'pet hotel', 'pet_hotel', 'pethotel' => 'hotel',
            'vet', 'veterinary', 'appointment', 'vet appointment' => 'vet',
            default => 'generic',
        };
    }

    public static function forRequest(ServiceRequest $serviceRequest): ?Service
    {
        return self::resolve($serviceRequest->service_name, self::bucketFor($serviceRequest->request_type));
    }

    /**
     * Resolve the catalog Service for a booking's service name within a
     * bucket. Exact name match wins; otherwise a per-bucket fallback picks
     * the default service, materializing a sensible default when the catalog
     * has none (mirrors the legacy receptionist approval behavior).
     */
    public static function resolve(?string $serviceName, string $bucket): ?Service
    {
        $serviceName = trim((string) $serviceName);

        if ($serviceName !== '') {
            $service = Service::whereRaw('LOWER(name) = ?', [strtolower($serviceName)])->first();
            if ($service) {
                return $service;
            }
        }

        return match ($bucket) {
            'grooming' => self::resolveGrooming(),
            'hotel' => self::resolveHotel(),
            'vet' => self::resolveVet($serviceName),
            default => null,
        };
    }

    /**
     * Resolved catalog price, or 0 when nothing can be resolved.
     */
    public static function priceFor(?string $serviceName, string $bucket): float
    {
        return (float) (self::resolve($serviceName, $bucket)?->price ?? 0);
    }

    private static function resolveVet(string $serviceName): ?Service
    {
        $category = collect(['Consultation', 'Vaccination', 'Surgery', 'Dental'])
            ->first(fn ($item) => str_contains(strtolower($serviceName), strtolower($item)));

        if ($category) {
            $service = Service::where('category', $category)->first();
            if ($service) {
                return $service;
            }
        }

        $service = Service::whereIn('category', ['Consultation', 'Vaccination', 'Surgery', 'Dental'])
            ->orderByRaw("CASE category WHEN 'Consultation' THEN 1 WHEN 'Vaccination' THEN 2 WHEN 'Surgery' THEN 3 WHEN 'Dental' THEN 4 ELSE 5 END")
            ->first();

        if ($service) {
            return $service;
        }

        return self::firstOrCreateService('Veterinary Consultation', [
            'category' => 'Consultation',
            'price' => 500,
            'description' => 'Default veterinary consultation service for approved vet requests.',
            'is_active' => true,
        ]);
    }

    private static function resolveGrooming(): ?Service
    {
        $service = Service::where('category', 'Grooming')->first();
        if ($service) {
            return $service;
        }

        return self::firstOrCreateService('Standard Grooming', [
            'category' => 'Grooming',
            'price' => 800,
            'description' => 'Default grooming service for approved grooming requests.',
            'is_active' => true,
        ]);
    }

    private static function resolveHotel(): ?Service
    {
        $service = Service::where('category', 'Hotel')->first();
        if ($service) {
            return $service;
        }

        return self::firstOrCreateService('Pet Hotel / Boarding', [
            'category' => 'Hotel',
            'price' => 1500,
            'description' => 'Default pet hotel/boarding service for approved hotel requests.',
            'is_active' => true,
        ]);
    }

    private static function firstOrCreateService(string $name, array $attributes): Service
    {
        if (!Schema::hasColumn('services', 'category')) {
            unset($attributes['category']);
        }

        if (!Schema::hasColumn('services', 'is_active')) {
            unset($attributes['is_active']);
        }

        return Service::firstOrCreate(['name' => $name], $attributes);
    }
}
