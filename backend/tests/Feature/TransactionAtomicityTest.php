<?php

namespace Tests\Feature;

use App\Models\Appointment;
use App\Models\Boarding;
use App\Models\Customer;
use App\Models\HotelRoom;
use App\Models\InventoryItem;
use App\Models\InventoryLog;
use App\Models\Invoice;
use App\Models\MedicalConfinement;
use App\Models\Payment;
use App\Models\Pet;
use App\Models\Sale;
use App\Models\SaleItem;
use App\Models\ServiceItemUsage;
use App\Models\Attendance;
use App\Models\User;
use App\Services\InventoryService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/**
 * Transaction atomicity: critical multi-write workflows must either commit
 * every change or roll back to zero partial state.
 */
class TransactionAtomicityTest extends TestCase
{
    use RefreshDatabase;

    private array $users = [];

    protected function setUp(): void
    {
        parent::setUp();
        foreach (['customer', 'receptionist', 'cashier', 'inventory', 'veterinary', 'admin'] as $role) {
            $this->users[$role] = User::factory()->create(['role' => $role]);
        }
    }

    private function as(string $role): static
    {
        return $this->withHeaders(['Authorization' => 'Bearer ' . $this->users[$role]->createToken('t')->plainTextToken]);
    }

    private function product(int $stock, float $price = 100): InventoryItem
    {
        return InventoryItem::create([
            'sku' => 'ATX-' . uniqid(), 'name' => 'Atomic Product', 'category' => 'Food',
            'price' => $price, 'stock' => $stock, 'reorder_level' => 1,
            'status' => 'active', 'is_sellable' => true,
        ]);
    }

    private function posPayload(array $items, ?int $customerId = null): array
    {
        return [
            'customer_id' => $customerId,
            'items' => $items,
            'payment_method' => 'cash',
            'cash_received' => 10000,
        ];
    }

    public function test_pos_checkout_commits_all_writes(): void
    {
        $product = $this->product(10);
        $customer = Customer::create(['name' => 'C', 'email' => 'c@example.com']);

        $response = $this->as('cashier')->postJson('/api/cashier/pos/transaction', $this->posPayload([
            ['item_id' => $product->id, 'item_type' => 'product', 'item_name' => 'Atomic Product', 'quantity' => 2, 'unit_price' => 100],
        ], $customer->id));

        $response->assertOk();
        $this->assertSame(1, Sale::count());
        $this->assertSame(1, SaleItem::count());
        $this->assertSame(1, Payment::count());
        $this->assertSame(1, Invoice::count());
        $this->assertSame(8, $product->fresh()->stock);
        $this->assertSame(1, InventoryLog::where('reference_type', 'sale')->count());
    }

    public function test_pos_checkout_late_failure_rolls_back_everything(): void
    {
        $product = $this->product(10);
        $logCount = InventoryLog::count(); // initial-stock log exists from creation

        // Force a failure at the LAST write (invoice creation) — after the sale,
        // items, stock deduction, and payment have already been written.
        Invoice::creating(fn () => throw new \RuntimeException('forced late failure'));

        $response = $this->as('cashier')->postJson('/api/cashier/pos/transaction', $this->posPayload([
            ['item_id' => $product->id, 'item_type' => 'product', 'item_name' => 'Atomic Product', 'quantity' => 2, 'unit_price' => 100],
        ]));

        $response->assertStatus(500);
        $this->assertSame(0, Sale::count());
        $this->assertSame(0, SaleItem::count());
        $this->assertSame(0, Payment::count());
        $this->assertSame(0, Invoice::count());
        $this->assertSame(10, $product->fresh()->stock, 'stock must be restored on rollback');
        $this->assertSame($logCount, InventoryLog::count(), 'no orphan stock-movement log');
    }

    public function test_pos_insufficient_stock_deducts_nothing_from_any_item(): void
    {
        $enough = $this->product(10);
        $short = $this->product(1);
        $logCount = InventoryLog::count();

        $response = $this->as('cashier')->postJson('/api/cashier/pos/transaction', $this->posPayload([
            ['item_id' => $enough->id, 'item_type' => 'product', 'item_name' => 'A', 'quantity' => 2, 'unit_price' => 100],
            ['item_id' => $short->id, 'item_type' => 'product', 'item_name' => 'B', 'quantity' => 5, 'unit_price' => 100],
        ]));

        $response->assertStatus(422);
        $this->assertSame(10, $enough->fresh()->stock);
        $this->assertSame(1, $short->fresh()->stock);
        $this->assertSame(0, Sale::count());
        $this->assertSame($logCount, InventoryLog::count());
    }

    public function test_pos_double_void_cannot_double_restore_stock(): void
    {
        $product = $this->product(10);
        $saleId = $this->as('cashier')->postJson('/api/cashier/pos/transaction', $this->posPayload([
            ['item_id' => $product->id, 'item_type' => 'product', 'item_name' => 'P', 'quantity' => 2, 'unit_price' => 100],
        ]))->assertOk()->json('transaction.id');

        $this->assertSame(8, $product->fresh()->stock);

        $this->as('cashier')->postJson("/api/cashier/pos/transaction/{$saleId}/void", ['reason' => 'first'])->assertOk();
        $this->assertSame(10, $product->fresh()->stock);

        $this->as('cashier')->postJson("/api/cashier/pos/transaction/{$saleId}/void", ['reason' => 'second'])->assertStatus(400);
        $this->assertSame(10, $product->fresh()->stock, 'stock must not be restored twice');
        $this->assertSame('cancelled', Sale::find($saleId)->status);
        $this->assertSame(1, InventoryLog::where('movement_type', 'sale_void')->count());
    }

    public function test_payment_verify_commits_linked_service_state(): void
    {
        $boarding = $this->pendingBoarding();
        ServiceItemUsage::create([
            'service_type' => ServiceItemUsage::SERVICE_BOARDING,
            'service_id' => $boarding->id,
            'quantity_used' => 1, 'item_type' => ServiceItemUsage::ITEM_BASE_SERVICE,
            'description' => 'Base', 'unit_price' => 100, 'total_price' => 100,
            'is_billable' => true, 'is_paid' => false,
        ]);

        $this->as('cashier')->postJson("/api/cashier/payment-requests/{$boarding->id}/verify", [
            'type' => 'boarding', 'reference_number' => 'REF123456',
        ])->assertOk();

        $boarding->refresh();
        $this->assertSame('paid', $boarding->payment_status);
        $this->assertNotNull($boarding->receipt_number);
        $this->assertSame(1, ServiceItemUsage::where('service_id', $boarding->id)->where('is_paid', true)->count());
    }

    public function test_payment_verify_failure_rolls_back_to_pending(): void
    {
        $boarding = $this->pendingBoarding();
        $item = ServiceItemUsage::create([
            'service_type' => ServiceItemUsage::SERVICE_BOARDING,
            'service_id' => $boarding->id,
            'quantity_used' => 1, 'item_type' => ServiceItemUsage::ITEM_BASE_SERVICE,
            'description' => 'Base', 'unit_price' => 100, 'total_price' => 100,
            'is_billable' => true, 'is_paid' => false,
        ]);

        // Force failure during the billing sync — after payment_status has
        // already been written inside the transaction.
        Boarding::saving(fn () => throw new \RuntimeException('forced billing failure'));

        $response = $this->as('cashier')->postJson("/api/cashier/payment-requests/{$boarding->id}/verify", [
            'type' => 'boarding', 'reference_number' => 'REF123456',
        ]);

        $response->assertStatus(500);
        $boarding->refresh();
        $this->assertSame('pending', $boarding->payment_status);
        $this->assertNull($boarding->receipt_number);
        $this->assertNull($boarding->verified_by);
        $this->assertSame(0, (int) $item->fresh()->is_paid, 'billing item must stay unpaid');
    }

    public function test_rejected_payment_can_be_settled_by_verification(): void
    {
        $boarding = $this->pendingBoarding();

        $this->as('cashier')->postJson("/api/cashier/payment-requests/{$boarding->id}/reject", [
            'type' => 'boarding', 'rejection_reason' => 'Blurry proof',
        ])->assertOk();
        $this->assertSame('rejected', $boarding->fresh()->payment_status);

        // A rejected online proof can still be settled at the desk —
        // reject → resubmit/settle → verify is the supported recovery path.
        $this->as('cashier')->postJson("/api/cashier/payment-requests/{$boarding->id}/verify", [
            'type' => 'boarding', 'reference_number' => 'REF123456',
        ])->assertOk();
        $this->assertSame('paid', $boarding->fresh()->payment_status);
        $this->assertNotNull($boarding->fresh()->receipt_number);
    }

    public function test_customer_order_approval_is_disabled_without_changing_stock_or_order_data(): void
    {
        $product = $this->product(10);
        $orderId = $this->createOrderWithItem($product, 3);
        $logCount = InventoryLog::count();

        $this->as('receptionist')
            ->postJson("/api/receptionist/customer-orders/{$orderId}/approve")
            ->assertStatus(410);

        $this->assertSame(10, $product->fresh()->stock);
        $this->assertSame('pending', DB::table('customer_orders')->where('id', $orderId)->value('status'));
        $this->assertSame($logCount, InventoryLog::count());
    }

    public function test_customer_order_approval_is_disabled_without_partial_stock_deductions(): void
    {
        $enough = $this->product(10);
        $short = $this->product(1);
        $orderId = $this->createOrderWithItems([[$enough, 2], [$short, 5]]);
        $logCount = InventoryLog::count();

        $this->as('receptionist')
            ->postJson("/api/receptionist/customer-orders/{$orderId}/approve")
            ->assertStatus(410);

        $this->assertSame(10, $enough->fresh()->stock);
        $this->assertSame(1, $short->fresh()->stock);
        $this->assertSame('pending', DB::table('customer_orders')->where('id', $orderId)->value('status'));
        $this->assertSame($logCount, InventoryLog::count());
    }

    public function test_customer_order_rejection_and_cancellation_are_disabled_without_mutating_data(): void
    {
        $product = $this->product(10);
        $orderId = $this->createOrderWithItem($product, 3);
        $logCount = InventoryLog::count();

        $this->as('receptionist')->postJson("/api/receptionist/customer-orders/{$orderId}/reject", [
            'rejection_reason' => 'Not available',
        ])->assertStatus(410);
        $this->as('receptionist')->postJson("/api/receptionist/customer-orders/{$orderId}/cancel", [
            'cancellation_reason' => 'Customer request',
        ])->assertStatus(410);

        $this->assertSame(10, $product->fresh()->stock);
        $this->assertSame('pending', DB::table('customer_orders')->where('id', $orderId)->value('status'));
        $this->assertSame('unpaid', DB::table('customer_orders')->where('id', $orderId)->value('payment_status'));
        $this->assertSame($logCount, InventoryLog::count());
    }

    public function test_stock_adjustment_cannot_go_negative(): void
    {
        $product = $this->product(5);
        $logCount = InventoryLog::count();
        $service = new InventoryService();

        try {
            $service->adjustStock($product->id, 10, 'test', ['adjustment_type' => 'decrement']);
            $this->fail('expected exception');
        } catch (\Exception $e) {
            // expected
        }

        $this->assertSame(5, $product->fresh()->stock);
        $this->assertSame($logCount, InventoryLog::count());
    }

    public function test_deduct_stock_beyond_available_changes_nothing(): void
    {
        $product = $this->product(5);
        $logCount = InventoryLog::count();
        $service = new InventoryService();

        try {
            $service->deductStock($product->id, 8);
            $this->fail('expected exception');
        } catch (\Exception $e) {
            // expected
        }

        $this->assertSame(5, $product->fresh()->stock);
        $this->assertSame($logCount, InventoryLog::count());
    }

    public function test_confinement_admit_and_room_status_are_atomic(): void
    {
        [$confinement, $room] = $this->admittableConfinement();

        // Force the room update to fail — the confinement must not stay 'admitted'.
        HotelRoom::updating(fn () => throw new \RuntimeException('forced room failure'));

        $this->as('receptionist')->postJson("/api/receptionist/medical-confinements/{$confinement->id}/admit")->assertStatus(500);

        $this->assertSame('approved_for_admission', $confinement->fresh()->status);
        $this->assertSame('reserved', $room->fresh()->status);
    }

    public function test_confinement_release_frees_room_atomically(): void
    {
        [$confinement, $room] = $this->admittableConfinement();
        $confinement->update(['status' => 'ready_for_discharge', 'payment_status' => 'paid']);
        $room->update(['status' => 'occupied']);

        $this->as('receptionist')->postJson("/api/receptionist/medical-confinements/{$confinement->id}/release")->assertOk();

        $this->assertSame('completed', $confinement->fresh()->status);
        $this->assertSame('available', $room->fresh()->status);
    }

    public function test_second_check_in_is_rejected_without_duplicate_record(): void
    {
        $this->as('cashier')->postJson('/api/attendance/check-in')->assertOk();
        $this->as('cashier')->postJson('/api/attendance/check-in')->assertStatus(422);
        $this->assertSame(1, Attendance::where('user_id', $this->users['cashier']->id)->count());
    }

    private function pendingBoarding(): Boarding
    {
        $customer = Customer::factory()->create();
        $pet = Pet::factory()->create(['customer_id' => $customer->id]);

        return Boarding::create([
            'pet_id' => $pet->id,
            'customer_id' => $customer->id,
            'check_in' => now()->addDay()->toDateString(),
            'check_out' => now()->addDays(3)->toDateString(),
            'status' => 'approved',
            'payment_status' => 'pending',
            'payment_proof' => 'payment-proofs/proof.png',
        ]);
    }

    private function createOrderWithItem(InventoryItem $product, int $quantity): int
    {
        return $this->createOrderWithItems([[$product, $quantity]]);
    }

    private function createOrderWithItems(array $items): int
    {
        $orderId = DB::table('customer_orders')->insertGetId([
            'customer_id' => $this->users['customer']->id,
            'status' => 'pending',
            'payment_status' => 'unpaid',
            'total_amount' => 0,
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        foreach ($items as [$product, $qty]) {
            DB::table('customer_order_items')->insert([
                'customer_order_id' => $orderId,
                'inventory_item_id' => $product->id,
                'product_name' => $product->name,
                'quantity' => $qty,
                'price' => $product->price,
                'subtotal' => $product->price * $qty,
                'created_at' => now(),
                'updated_at' => now(),
            ]);
        }

        return $orderId;
    }

    private function admittableConfinement(): array
    {
        $customer = Customer::factory()->create();
        $pet = Pet::factory()->create(['customer_id' => $customer->id]);
        $room = HotelRoom::create([
            'name' => 'Ward A', 'room_number' => 'A1', 'status' => 'reserved', 'daily_rate' => 500,
        ]);
        $appointment = Appointment::factory()->create([
            'customer_id' => $customer->id,
            'pet_id' => $pet->id,
            'veterinarian_id' => $this->users['veterinary']->id,
        ]);

        $confinement = MedicalConfinement::create([
            'consultation_id' => $appointment->id,
            'customer_id' => $customer->id,
            'pet_id' => $pet->id,
            'vet_id' => $this->users['veterinary']->id,
            'room_id' => $room->id,
            'diagnosis' => 'Test',
            'reason_for_confinement' => 'Test',
            'status' => 'approved_for_admission',
            'payment_status' => 'unpaid',
        ]);

        return [$confinement, $room];
    }
}
