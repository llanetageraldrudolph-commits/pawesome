<?php

namespace Tests\Feature;

use App\Mail\PaymentReceiptMail;
use App\Models\Appointment;
use App\Models\Boarding;
use App\Models\Customer;
use App\Models\HotelRoom;
use App\Models\InventoryItem;
use App\Models\Notification;
use App\Models\Pet;
use App\Models\Service;
use App\Models\ServiceRequest;
use App\Models\User;
use App\Services\InventoryService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * Canonical notification matrix:
 * event -> successful business-state transition -> authorized recipient -> in-app.
 *
 * Verifies persistence, read/unread, recipient authorization, composite-role
 * expansion, and duplicate prevention for the critical workflow events.
 */
class NotificationMatrixTest extends TestCase
{
    use RefreshDatabase;

    private array $users = [];

    protected function setUp(): void
    {
        parent::setUp();
        foreach (['customer', 'receptionist', 'super_receptionist', 'cashier', 'inventory', 'veterinary', 'manager', 'admin'] as $role) {
            $this->users[$role] = User::factory()->create([
                'role' => $role,
                'is_active' => true,
                'email_verified_at' => now(),
            ]);
        }
    }

    private function as(string $role): static
    {
        return $this->withHeaders(['Authorization' => 'Bearer ' . $this->users[$role]->createToken('t')->plainTextToken]);
    }

    private function asUser(User $user): static
    {
        return $this->withHeaders(['Authorization' => 'Bearer ' . $user->createToken('t')->plainTextToken]);
    }

    private function notificationsFor(User $user)
    {
        return Notification::where('user_id', $user->id)->get();
    }

    // ------------------------------------------------------------------
    // Event: service request submitted -> receptionist (+super_receptionist)
    // ------------------------------------------------------------------
    public function test_service_request_submitted_notifies_receptionist_roles(): void
    {
        $customer = Customer::factory()->create(['user_id' => $this->users['customer']->id]);
        $pet = Pet::factory()->create(['customer_id' => $customer->id]);

        $this->as('customer')->postJson('/api/customer/requests', [
            'customer_name' => 'Test Customer',
            'customer_email' => $this->users['customer']->email,
            'pet_id' => $pet->id,
            'request_type' => 'grooming',
            'service_name' => 'Full Groom',
            'requested_date' => now()->addDays(2)->toDateString(),
            'requested_time' => '10:00',
        ]);

        $this->assertTrue(
            $this->notificationsFor($this->users['receptionist'])->contains('title', 'New Service Request'),
            'receptionist must receive new-service-request notification'
        );
        $this->assertTrue(
            $this->notificationsFor($this->users['super_receptionist'])->contains('title', 'New Service Request'),
            'super_receptionist inherits receptionist notifications'
        );
        // Unauthorized roles receive nothing
        $this->assertCount(0, $this->notificationsFor($this->users['cashier'])->where('title', 'New Service Request'));
        $this->assertCount(0, $this->notificationsFor($this->users['inventory'])->where('title', 'New Service Request'));
    }

    // ------------------------------------------------------------------
    // Event: request status changed -> customer
    // ------------------------------------------------------------------
    public function test_request_status_update_notifies_customer(): void
    {
        $customerUser = $this->users['customer'];
        $sr = ServiceRequest::create([
            'customer_id' => $customerUser->id,
            'customer_name' => 'Test Customer',
            'customer_email' => $customerUser->email,
            'pet_name' => 'Bantay',
            'request_type' => 'grooming',
            'service_name' => 'Full Groom',
            'request_date' => now()->addDays(2)->toDateString(),
            'request_time' => '10:00',
            'status' => 'pending',
            'payment_status' => 'unpaid',
        ]);

        $this->as('receptionist')->patchJson("/api/receptionist/requests/{$sr->id}/status", [
            'status' => 'approved',
        ])->assertOk();

        $this->assertTrue(
            $this->notificationsFor($customerUser)->contains('title', 'Service Request Updated'),
            'customer must be notified on status change'
        );
    }

    // ------------------------------------------------------------------
    // Event: payment proof uploaded -> cashier (+super_receptionist)
    // ------------------------------------------------------------------
    public function test_payment_proof_upload_notifies_cashier(): void
    {
        Storage::fake('private');
        Storage::fake('public');

        $customerUser = $this->users['customer'];
        $sr = ServiceRequest::create([
            'customer_id' => $customerUser->id,
            'customer_name' => 'Test Customer',
            'customer_email' => $customerUser->email,
            'pet_name' => 'Bantay',
            'request_type' => 'grooming',
            'service_name' => 'Full Groom',
            'request_date' => now()->addDays(2)->toDateString(),
            'request_time' => '10:00',
            'status' => 'approved',
            'payment_status' => 'unpaid',
        ]);

        $this->as('customer')->postJson("/api/customer/requests/{$sr->id}/payment-proof", [
            'payment_method' => 'gcash',
            'payment_reference' => 'REF123456',
            'payment_proof' => UploadedFile::fake()->createWithContent(
                'proof.png',
                base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==')
            ),
        ])->assertOk();

        $this->assertTrue(
            $this->notificationsFor($this->users['cashier'])->contains('title', 'New Payment Proof Uploaded'),
            'cashier must be notified of uploaded proof'
        );
        $this->assertTrue(
            $this->notificationsFor($this->users['super_receptionist'])->contains('title', 'New Payment Proof Uploaded'),
            'super_receptionist inherits cashier notifications'
        );
        $this->assertCount(
            0,
            $this->notificationsFor($this->users['veterinary'])->where('title', 'New Payment Proof Uploaded'),
            'unauthorized roles must not receive payment-proof notifications'
        );
    }

    // ------------------------------------------------------------------
    // Events: payment verified / rejected -> customer
    // ------------------------------------------------------------------
    public function test_payment_verify_and_reject_notify_customer_once(): void
    {
        Mail::fake();
        $customerUser = $this->users['customer'];
        $sr = ServiceRequest::create([
            'customer_id' => $customerUser->id,
            'customer_name' => 'Test Customer',
            'customer_email' => $customerUser->email,
            'pet_name' => 'Bantay',
            'request_type' => 'grooming',
            'service_name' => 'Full Groom',
            'price' => 850.50,
            'total_amount' => 850.50,
            'payment_method' => 'gcash',
            'request_date' => now()->addDays(2)->toDateString(),
            'request_time' => '10:00',
            'status' => 'approved',
            'payment_status' => 'pending',
            'payment_proof' => 'payment-proofs/test.png',
        ]);

        $this->as('cashier')->postJson("/api/cashier/payment-requests/{$sr->id}/verify", [
            'type' => 'service_request',
            'reference_number' => 'REF123456',
        ])->assertOk();

        $verified = $this->notificationsFor($customerUser)->where('title', 'Payment Verified');
        $this->assertCount(1, $verified, 'customer gets exactly one payment-verified notification');
        $serviceReceiptNumber = DB::table('service_requests')->where('id', $sr->id)->value('receipt_number');
        Mail::assertSent(PaymentReceiptMail::class, function (PaymentReceiptMail $mail) use ($serviceReceiptNumber) {
            return $mail->receiptType === 'service_request'
                && $mail->receipt['receipt_number'] === $serviceReceiptNumber
                && (float) $mail->receipt['total_amount'] === 850.50
                && $mail->receipt['payment_reference'] === 'REF123456';
        });
        $serviceReceiptResponse = $this->as('customer')->getJson("/api/customer/requests/{$sr->id}/receipt")
            ->assertOk()
            ->assertJsonPath('receipt.payment_reference', 'REF123456');
        $this->assertEquals(850.5, (float) $serviceReceiptResponse->json('receipt.total_amount'));

        // Re-verification is blocked (payment_status no longer pending) and must
        // not produce a second notification.
        $this->as('cashier')->postJson("/api/cashier/payment-requests/{$sr->id}/verify", [
            'type' => 'service_request',
            'reference_number' => 'REF123456',
        ])->assertStatus(422);
        $this->assertCount(1, $this->notificationsFor($customerUser)->where('title', 'Payment Verified'));
        Mail::assertSent(PaymentReceiptMail::class, 1);

        // Rejection path on a fresh pending request
        $sr2 = ServiceRequest::create([
            'customer_id' => $customerUser->id,
            'customer_name' => 'Test Customer',
            'customer_email' => $customerUser->email,
            'pet_name' => 'Bantay',
            'request_type' => 'grooming',
            'service_name' => 'Full Groom',
            'request_date' => now()->addDays(2)->toDateString(),
            'request_time' => '10:00',
            'status' => 'approved',
            'payment_status' => 'pending',
            'payment_proof' => 'payment-proofs/test2.png',
        ]);

        $this->as('cashier')->postJson("/api/cashier/payment-requests/{$sr2->id}/reject", [
            'type' => 'service_request',
            'rejection_reason' => 'Illegible receipt',
        ])->assertOk();

        $this->assertCount(1, $this->notificationsFor($customerUser)->where('title', 'Payment Rejected'));
        Mail::assertSent(PaymentReceiptMail::class, 1);
    }

    // Customer store order workflows are disabled: cashier verification is
    // blocked with 410, the order stays pending, and no receipt email is sent.
    public function test_disabled_customer_order_verification_sends_no_receipt_email(): void
    {
        Mail::fake();
        $customerUser = $this->users['customer'];
        $item = InventoryItem::factory()->create();
        $orderId = DB::table('customer_orders')->insertGetId([
            'customer_id' => $customerUser->id,
            'customer_email' => $customerUser->email,
            'customer_name' => $customerUser->name,
            'total_amount' => 120.00,
            'order_type' => 'Pick-up',
            'payment_method' => 'GCash',
            'status' => 'approved',
            'payment_status' => 'pending',
            'payment_reference' => 'CUSTOMER-SUBMITTED-REF',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
        DB::table('customer_order_items')->insert([
            'customer_order_id' => $orderId,
            'inventory_item_id' => $item->id,
            'product_name' => 'Persisted Item Name',
            'quantity' => 2,
            'price' => 60.00,
            'subtotal' => 120.00,
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $this->as('cashier')->postJson("/api/cashier/payment-requests/{$orderId}/verify", [
            'type' => 'customer_order',
            'reference_number' => 'VERIFIED-REF-123456',
        ])->assertStatus(410);

        $this->assertSame('pending', DB::table('customer_orders')->where('id', $orderId)->value('payment_status'));
        Mail::assertNotSent(PaymentReceiptMail::class);

        // Receipt stays unavailable while the order is unpaid.
        $this->as('customer')->getJson("/api/customer/store/orders/{$orderId}/receipt")
            ->assertStatus(422);
    }

    // ------------------------------------------------------------------
    // Event: low stock -> inventory/manager/admin, deduped
    // ------------------------------------------------------------------
    public function test_low_stock_notifies_inventory_and_manager_and_dedupes(): void
    {
        $item = InventoryItem::factory()->create([
            'stock' => 8,
            'reorder_level' => 10,
        ]);

        $service = new InventoryService();
        $service->deductStock($item->id, 1, 'Test sale', 'sale', 1);

        foreach (['inventory', 'manager', 'admin', 'super_receptionist'] as $role) {
            $this->assertTrue(
                $this->notificationsFor($this->users[$role])->contains('title', 'Low Stock Alert'),
                "{$role} must receive low stock alert"
            );
        }
        $this->assertCount(
            0,
            $this->notificationsFor($this->users['customer'])->where('title', 'Low Stock Alert'),
            'customer must not receive inventory alerts'
        );

        $countBefore = Notification::where('title', 'Low Stock Alert')->count();

        // Second deduction while still below reorder level must not re-notify.
        $service->deductStock($item->id, 1, 'Test sale 2', 'sale', 2);
        $this->assertSame($countBefore, Notification::where('title', 'Low Stock Alert')->count());

        // Marking read re-arms the alert for the next threshold event.
        Notification::where('title', 'Low Stock Alert')->update(['read' => true, 'read_at' => now()]);
        $service->deductStock($item->id, 1, 'Test sale 3', 'sale', 3);
        $this->assertGreaterThan(
            $countBefore,
            Notification::where('title', 'Low Stock Alert')->count(),
            'a new unread alert is allowed after the previous one was read'
        );
    }

    // ------------------------------------------------------------------
    // Event: appointment scheduled -> veterinary (exactly once)
    // ------------------------------------------------------------------
    public function test_appointment_created_notifies_vet_exactly_once(): void
    {
        $customer = Customer::factory()->create(['user_id' => $this->users['customer']->id]);
        $pet = Pet::factory()->create(['customer_id' => $customer->id]);
        $service = Service::factory()->create();

        Appointment::factory()->create([
            'customer_id' => $customer->id,
            'pet_id' => $pet->id,
            'service_id' => $service->id,
            'veterinarian_id' => $this->users['veterinary']->id,
            'status' => 'approved',
        ]);

        $vetNotifications = $this->notificationsFor($this->users['veterinary'])
            ->where('related_type', 'appointment');
        $this->assertCount(1, $vetNotifications, 'vet must receive exactly one notification per appointment creation');
    }

    // ------------------------------------------------------------------
    // Event: booking created -> receptionist notified once (no duplicate)
    // ------------------------------------------------------------------
    public function test_boarding_created_notifies_receptionist_exactly_once(): void
    {
        $customerUser = $this->users['customer'];
        $customer = Customer::factory()->create([
            'user_id' => $customerUser->id,
            'email' => $customerUser->email,
        ]);
        $pet = Pet::factory()->create(['customer_id' => $customer->id]);
        $room = HotelRoom::factory()->create(['status' => 'available']);

        $response = $this->as('customer')->postJson('/api/customer/boarding-requests', [
            'pet_id' => $pet->id,
            'hotel_room_id' => $room->id,
            'check_in_date' => now()->addDays(3)->toDateString(),
            'number_of_days' => 1,
        ]);
        $response->assertStatus(201);

        $receptionistNotifications = $this->notificationsFor($this->users['receptionist'])
            ->where('related_type', 'boarding');
        $this->assertCount(
            1,
            $receptionistNotifications,
            'boarding creation must produce exactly one receptionist notification (no duplicate trigger)'
        );
    }

    // ------------------------------------------------------------------
    // Payroll notifications create per-user rows, not shared broadcast rows
    // ------------------------------------------------------------------
    public function test_payroll_notifications_are_per_user_rows(): void
    {
        // Simulate the payroll-generated notification path (per-user rows)
        \App\Services\WorkflowNotifier::notifyRole(
            'manager',
            'Payroll Generated',
            'Payroll has been generated for test period.',
            'info',
            'payroll'
        );

        $this->assertSame(
            0,
            Notification::whereNull('user_id')->count(),
            'notifications must be per-user rows, not broadcast rows'
        );
        $managerNotification = $this->notificationsFor($this->users['manager'])
            ->where('title', 'Payroll Generated');
        $this->assertCount(1, $managerNotification);
        $this->assertSame('manager', $managerNotification->first()->role);
    }

    // ------------------------------------------------------------------
    // Read/unread behavior + recipient authorization
    // ------------------------------------------------------------------
    public function test_read_unread_and_authorization(): void
    {
        $target = $this->users['customer'];
        Notification::create([
            'user_id' => $target->id,
            'title' => 'Test',
            'message' => 'hello',
            'type' => 'info',
            'read' => false,
        ]);
        $notification = Notification::latest('id')->first();

        // Unread count reflects the new notification
        $this->asUser($target)->getJson('/api/notifications/unread-count')
            ->assertOk()
            ->assertJsonPath('unread_count', 1);

        // Another user cannot mark it read or delete it (404 = not found in scope)
        $this->asUser($this->users['cashier'])->postJson("/api/notifications/{$notification->id}/read")
            ->assertNotFound();
        $this->asUser($this->users['cashier'])->deleteJson("/api/notifications/{$notification->id}")
            ->assertNotFound();

        // Owner marks it read; unread flag flips and read_at is set
        $this->asUser($target)->postJson("/api/notifications/{$notification->id}/read")->assertOk();
        $notification->refresh();
        $this->assertTrue((bool) $notification->read);
        $this->assertNotNull($notification->read_at);

        // mark-all-read resets the badge
        Notification::create([
            'user_id' => $target->id,
            'title' => 'Second',
            'message' => 'again',
            'type' => 'info',
            'read' => false,
        ]);
        $this->asUser($target)->postJson('/api/notifications/mark-all-read')->assertOk();
        $this->asUser($target)->getJson('/api/notifications/unread-count')
            ->assertJsonPath('unread_count', 0);
    }

    // ------------------------------------------------------------------
    // Inactive users are not notified by role broadcasts
    // ------------------------------------------------------------------
    public function test_inactive_users_do_not_receive_role_notifications(): void
    {
        $inactiveReceptionist = User::factory()->create([
            'role' => 'receptionist',
            'is_active' => false,
        ]);

        \App\Services\WorkflowNotifier::notifyRole(
            'receptionist',
            'Test Role Notice',
            'Should skip inactive users.',
            'info'
        );

        $this->assertCount(0, $this->notificationsFor($inactiveReceptionist));
        $this->assertCount(1, $this->notificationsFor($this->users['receptionist']));
    }
}
