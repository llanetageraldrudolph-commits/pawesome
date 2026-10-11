<?php

namespace App\Http\Controllers\Veterinary;

use App\Http\Controllers\Controller;
use App\Models\Appointment;
use App\Models\Pet;
use App\Models\User;
use App\Services\ServiceBillingService;
use App\Support\EmailContent;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Auth;

class DashboardController extends Controller
{
    private function assignedAppointments()
    {
        $query = Appointment::query();
        $user = Auth::user();

        // Regular veterinarians only see appointments assigned to them.
        // Admin sees the full appointment board.
        if (!$user || !$user->hasRoleAccess('admin')) {
            $query->where('veterinarian_id', Auth::id());
        }

        return $query;
    }

    private function appointmentPatientScope($query)
    {
        $user = Auth::user();

        if ($user && $user->hasRoleAccess('admin')) {
            return $query->whereHas('appointments');
        }

        $authId = Auth::id();
        return $query->whereHas('appointments', function ($q) use ($authId) {
            $q->where('veterinarian_id', $authId);
        });
    }

    public function overview()
    {
        $today = Carbon::today();

        $todayAssigned = $this->assignedAppointments()
            ->whereDate('scheduled_at', $today)
            ->whereIn('status', ['approved', 'scheduled', 'in_progress', 'treated', 'awaiting_payment'])
            ->count();

        $pendingAssigned = $this->assignedAppointments()
            ->where('status', 'pending')
            ->count();

        $upcomingAssigned = $this->assignedAppointments()
            ->with(['customer', 'pet', 'service', 'veterinarian'])
            ->where('scheduled_at', '>=', $today)
            ->whereIn('status', ['approved', 'scheduled', 'in_progress', 'treated', 'awaiting_payment'])
            ->orderBy('scheduled_at')
            ->limit(5)
            ->get();

        return response()->json([
            'today_appointments' => $todayAssigned,
            'approved_appointments' => $this->assignedAppointments()
                ->whereIn('status', ['approved', 'scheduled'])
                ->count(),
            'pending_appointments' => $pendingAssigned,
            'completed_appointments' => $this->assignedAppointments()
                ->where('status', 'completed')
                ->count(),
            'total_patients' => $this->appointmentPatientScope(Pet::query())->count(),
            'new_patients_this_month' => $this->appointmentPatientScope(Pet::query())->whereMonth('created_at', $today->month)->count(),
            'upcoming_appointments' => $upcomingAssigned->sortBy('scheduled_at')->values()->take(5),
            'recent_patients' => $this->appointmentPatientScope(Pet::with('customer'))
                ->latest()
                ->take(5)
                ->get(),
            'appointments_by_type' => $this->assignedAppointments()
                ->with('service')
                ->selectRaw('service_id, count(*) as count')
                ->whereMonth('scheduled_at', $today->month)
                ->whereIn('status', ['approved', 'scheduled', 'in_progress', 'treated', 'awaiting_payment', 'completed'])
                ->groupBy('service_id')
                ->get(),
        ]);
    }

    public function appointments()
    {
        // Regular veterinarians only see appointments assigned to them
        // (i.e., ones that receptionist has approved and assigned);
        // admin sees the full board.
        return response()->json(
            $this->assignedAppointments()
                ->with(['customer', 'pet', 'service', 'veterinarian'])
                ->whereIn('status', ['approved', 'scheduled', 'in_progress', 'in_consultation', 'needs_confinement', 'treated', 'awaiting_payment'])
                ->orderBy('scheduled_at')
                ->get()
        );
    }

    public function patients()
    {
        return response()->json(
            $this->appointmentPatientScope(
                Pet::with(['customer', 'appointments' => function($query) {
                    $query->latest()->take(3);
                }])
            )->get()
        );
    }

    public function appointment($id)
    {
        $appointment = $this->assignedAppointments()
            ->with(['customer', 'pet', 'service', 'veterinarian'])
            ->findOrFail($id);

        return response()->json([
            'appointment' => $appointment,
        ]);
    }

    public function history(Request $request)
    {
        $statuses = $request->input('status', 'completed,cancelled');
        $statusArray = explode(',', $statuses);

        $perPage = (int) $request->get('per_page', 25);
        $page    = (int) $request->get('page', 1);
        $search  = trim((string) $request->get('search', ''));
        $dateFilter = $request->get('date_filter', 'all');

        $query = $this->assignedAppointments()
            ->with(['customer', 'pet', 'service', 'veterinarian'])
            ->whereIn('status', $statusArray)
            ->orderBy('scheduled_at', 'desc');

        if ($search) {
            $query->where(function ($q) use ($search) {
                $q->whereHas('customer', fn ($c) => $c->where('name', 'like', "%$search%"))
                  ->orWhereHas('pet', fn ($p) => $p->where('name', 'like', "%$search%"))
                  ->orWhereHas('service', fn ($s) => $s->where('name', 'like', "%$search%"));
            });
        }

        if ($dateFilter === 'today')  $query->whereDate('scheduled_at', \Carbon\Carbon::today());
        if ($dateFilter === 'week')   $query->where('scheduled_at', '>=', \Carbon\Carbon::now()->subDays(7));
        if ($dateFilter === 'month')  $query->where('scheduled_at', '>=', \Carbon\Carbon::now()->subDays(30));

        $paginated = $query->paginate($perPage, ['*'], 'page', $page);

        return response()->json([
            'appointments' => $paginated->items(),
            'history'      => $paginated->items(),
            'data'         => $paginated->items(),
            'meta'         => [
                'total'        => $paginated->total(),
                'per_page'     => $paginated->perPage(),
                'current_page' => $paginated->currentPage(),
                'last_page'    => $paginated->lastPage(),
            ],
        ]);
    }

    public function reports(Request $request)
    {
        /** @var User|null $user */
        $user = Auth::user();
        $today = Carbon::today();
        
        // Build base query based on user role
        $query = Appointment::with(['customer', 'pet', 'service', 'veterinarian']);
        
        // If not admin, filter by assigned veterinarian
        if (!$user->hasRoleAccess('admin')) {
            $query->where('veterinarian_id', $user->id);
        }
        
        // Apply date filters
        $startDate = $request->input('start_date');
        $endDate = $request->input('end_date');
        
        if ($startDate) {
            $query->whereDate('scheduled_at', '>=', $startDate);
        } else {
            // Default to current month if no start date
            $query->whereMonth('scheduled_at', $today->month)
                  ->whereYear('scheduled_at', $today->year);
        }
        
        if ($endDate) {
            $query->whereDate('scheduled_at', '<=', $endDate);
        } else if (!$startDate) {
            // Default to current month if no end date
            $query->whereMonth('scheduled_at', $today->month)
                  ->whereYear('scheduled_at', $today->year);
        }
        
        // Apply status filter
        $statusFilter = $request->input('status');
        if ($statusFilter && $statusFilter !== 'all') {
            $query->where('status', $statusFilter);
        }
        
        // Apply service type filter
        $serviceTypeFilter = $request->input('service_type');
        if ($serviceTypeFilter && $serviceTypeFilter !== 'all') {
            $query->whereHas('service', function ($q) use ($serviceTypeFilter) {
                $q->where('name', 'like', "%{$serviceTypeFilter}%")
                  ->orWhere('category', 'like', "%{$serviceTypeFilter}%");
            });
        }
        
        // Get all matching appointments for records
        $records = (clone $query)
            ->orderBy('scheduled_at', 'desc')
            ->limit(50)
            ->get()
            ->map(function ($appointment) {
                return [
                    'id' => $appointment->id,
                    'date' => $appointment->scheduled_at ? $appointment->scheduled_at->format('Y-m-d') : null,
                    'appointment_date' => $appointment->scheduled_at ? $appointment->scheduled_at->format('Y-m-d') : null,
                    'customer_name' => $appointment->customer?->name ?: 'Unknown Customer',
                    'pet_name' => $appointment->pet?->name ?: 'Unknown Pet',
                    'service_name' => $appointment->service?->name ?: 'Unknown Service',
                    'status' => $appointment->status,
                    'revenue' => (float) ($appointment->price ?? 0),
                    'vet_name' => $appointment->veterinarian?->name ?: 'Veterinary Staff',
                    'notes' => $appointment->notes ?: '',
                ];
            });
        
        // Calculate metrics from completed appointments only
        $metricsQuery = clone $query;
        $completedQuery = clone $query;
        
        // Filter for completed appointments for revenue and counts
        if ($statusFilter && $statusFilter !== 'all') {
            $completedQuery->where('status', $statusFilter);
        } else {
            $completedQuery->whereIn('status', ['completed', 'treated']);
        }
        
        $completedAppointments = $completedQuery->count();
        $totalRevenue = $completedQuery->sum('price') ?? 0;
        
        // Build service breakdown
        $serviceBreakdown = (clone $completedQuery)
            ->with('service')
            ->selectRaw('service_id, COUNT(*) as count, SUM(price) as revenue')
            ->groupBy('service_id')
            ->get()
            ->map(function ($item) {
                $service = $item->service;
                return [
                    'id' => $service?->id ?? $item->service_id,
                    'service_name' => $service?->name ?: 'Unknown Service',
                    'count' => (int) $item->count,
                    'revenue' => (float) ($item->revenue ?? 0),
                    'status' => 'completed',
                ];
            });
        
        // Determine period label
        $period = $startDate && $endDate
            ? Carbon::parse($startDate)->format('M d, Y') . ' - ' . Carbon::parse($endDate)->format('M d, Y')
            : ($startDate ? Carbon::parse($startDate)->format('F Y') : $today->format('F Y'));
        
        return response()->json([
            'success' => true,
            'data' => [
                'period' => $period,
                'monthly_revenue' => (float) $totalRevenue,
                'monthly_completed' => $completedAppointments,
                'service_breakdown' => $serviceBreakdown,
                'records' => $records,
            ],
        ]);
    }

    public function receipt($id)
    {
        $appointment = $this->assignedAppointments()
            ->with(['customer', 'pet', 'service', 'veterinarian'])
            ->findOrFail($id);

        $billing = ServiceBillingService::getItemizedBilling('veterinary', (int) $appointment->id);
        $baseAmount = (float) ($billing['base_amount'] ?? ($appointment->price ?? 0));
        $additionalServices = collect($billing['items'] ?? [])
            ->filter(function ($item) {
                return ($item->item_type ?? null) !== 'base_service';
            })
            ->map(function ($item) {
                return [
                    'id' => $item->id,
                    'name' => $item->description,
                    'cost' => (float) ($item->total_price ?? 0),
                    'quantity' => (int) ($item->quantity ?? $item->quantity_used ?? 1),
                ];
            })
            ->values()
            ->all();

        $totalAmount = (float) ($billing['total_bill'] ?? $appointment->price ?? 0);
        $vatAmount = EmailContent::vatInclusivePortion($totalAmount);

        return response()->json([
            'receipt' => [
                'id' => $appointment->id,
                'date' => $appointment->scheduled_at,
                'customer_name' => $appointment->customer?->name,
                'pet_name' => $appointment->pet?->name,
                'service_name' => $appointment->service?->name,
                'service_category' => $appointment->service?->category,
                'vet_name' => $appointment->veterinarian?->name ?? 'Unassigned',
                'amount' => $baseAmount,
                'net_amount' => $vatAmount !== null ? round($totalAmount - $vatAmount, 2) : null,
                'vat_amount' => $vatAmount,
                'vat_rate' => 0.12,
                'subtotal' => $totalAmount,
                'total' => $totalAmount,
                'additional_services' => $additionalServices,
                'receipt_number' => $appointment->receipt_number,
                'paid_date' => $appointment->paid_at,
                'payment_method' => $appointment->payment_method ?? 'cash',
                'status' => $appointment->payment_status ?? 'pending',
                'balance_due' => (float) ($billing['balance_due'] ?? 0),
                'notes' => $appointment->notes,
            ],
        ]);
    }
}
