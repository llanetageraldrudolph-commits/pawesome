<?php

namespace Tests\Feature;

use App\Mail\CustomerNotificationMail;
use App\Models\Customer;
use App\Models\EmailDelivery;
use App\Models\Pet;
use App\Models\Service;
use App\Models\ServiceRequest;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use Tests\TestCase;

/**
 * Covers the structured business-email layer:
 *  - branded layout, greeting, details table, status chip, CTA, footer
 *  - plain-text fallback rendering
 *  - escaping of dynamic values and conditional detail rows
 *  - payment.rejected outbox intent (cashier rejection path)
 *  - order.status outbox intent (receptionist order transitions)
 *  - no-duplicate and no-op-transition protection
 *  - customer email preference suppression
 */
class EmailStructuredContentTest extends TestCase
{
    use RefreshDatabase;

    private function bearer(User $user): array
    {
        return ['Authorization' => 'Bearer ' . $user->createToken('test')->plainTextToken];
    }

    private function staff(string $role): User
    {
        return User::factory()->create([
            'role' => $role,
            'is_active' => true,
            'email_verified_at' => now(),
        ]);
    }

    private function verifiedCustomer(array $overrides = []): array
    {
        $user = User::factory()->create(array_merge([
            'role' => 'customer',
            'is_active' => true,
            'email_verified_at' => now(),
        ], $overrides));

        $customer = Customer::create([
            'user_id' => $user->id,
            'name' => $user->name,
            'email' => $user->email,
        ]);

        return [$user, $customer];
    }

    private function submitRequest(User $user): ServiceRequest
    {
        Service::create([
            'name' => 'Full Groom',
            'category' => 'Grooming',
            'price' => 350,
            'is_active' => true,
        ]);

        $pet = Pet::create([
            'customer_id' => Customer::where('user_id', $user->id)->firstOrFail()->id,
            'name' => 'Buddy',
            'species' => 'dog',
        ]);

        $this->postJson('/api/customer/requests', [
            'customer_name' => $user->name,
            'pet_id' => $pet->id,
            'request_type' => 'grooming',
            'service_name' => 'Full Groom',
            'requested_date' => now()->addDay()->toDateString(),
            'requested_time' => '10:00',
        ], $this->bearer($user))->assertCreated();

        return ServiceRequest::latest('id')->firstOrFail();
    }

    private function structuredMail(array $content): CustomerNotificationMail
    {
        return (new CustomerNotificationMail(
            'Service Request Approved',
            'Fallback body text.',
            'success',
            $content
        ))->build();
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    public function test_structured_email_renders_branded_business_layout(): void
    {
        $mail = $this->structuredMail([
            'subject' => '[Pawesome] Booking Approved — SR-42',
            'customer_name' => 'Juan Dela Cruz',
            'intro' => 'Your grooming request has been approved.',
            'details' => [
                ['label' => 'Reference', 'value' => 'SR-42'],
                ['label' => 'Pet', 'value' => 'Buddy'],
            ],
            'status' => 'Approved',
            'status_type' => 'success',
            'cta_url' => 'https://pawesome.example/customer/my-requests',
            'cta_label' => 'View Request',
        ]);

        $html = $mail->render();

        $this->assertStringContainsString('PAWESOME', $html);
        $this->assertStringContainsString('RETREAT INC.', $html);
        $this->assertStringContainsString('VETERINARY SERVICES', $html);
        $this->assertStringContainsString('Hello, Juan Dela Cruz', $html);
        $this->assertStringContainsString('Your grooming request has been approved.', $html);
        $this->assertStringContainsString('SR-42', $html);
        $this->assertStringContainsString('Buddy', $html);
        $this->assertStringContainsString('Approved', $html);
        $this->assertStringContainsString('https://pawesome.example/customer/my-requests', $html);
        $this->assertStringContainsString('View Request', $html);
        $this->assertStringContainsString('Pawesome Retreat Inc.', $html);
        $this->assertStringContainsString('class="container"', $html);
        $this->assertSame('[Pawesome] Booking Approved — SR-42', $mail->subject);
        $this->assertSame('emails.text.notification', $mail->textView);
    }

    public function test_structured_email_escapes_dynamic_values(): void
    {
        $mail = $this->structuredMail([
            'customer_name' => '<b>Attacker</b><script>alert(1)</script>',
            'intro' => 'Intro <img src=x onerror=alert(1)>',
            'details' => [
                ['label' => 'Reason', 'value' => '<script>alert(2)</script>'],
            ],
        ]);

        $html = $mail->render();

        $this->assertStringNotContainsString('<script>alert', $html);
        $this->assertStringNotContainsString('<img src=x onerror', $html);
        $this->assertStringContainsString('&lt;script&gt;', $html);
    }

    public function test_missing_optional_detail_rows_are_not_rendered(): void
    {
        $mail = $this->structuredMail([
            'customer_name' => 'Ana',
            'intro' => 'Update on your request.',
            'details' => [
                ['label' => 'Reference', 'value' => 'SR-7'],
                ['label' => 'Reason', 'value' => null],
                ['label' => 'Veterinarian', 'value' => ''],
            ],
        ]);

        $html = $mail->render();

        $this->assertStringContainsString('SR-7', $html);
        $this->assertStringNotContainsString('Reason', $html);
        $this->assertStringNotContainsString('Veterinarian', $html);
    }

    public function test_plain_text_fallback_renders_content(): void
    {
        $this->structuredMail([
            'customer_name' => 'Ana',
            'intro' => 'Your payment has been verified.',
            'details' => [['label' => 'Reference', 'value' => 'PAY-9']],
            'status' => 'Paid',
            'cta_url' => 'https://pawesome.example/customer/payments',
            'cta_label' => 'View Payment',
        ]);

        $text = view('emails.text.notification', [
            'title' => 'Payment Confirmed',
            'body' => 'fallback',
            'type' => 'success',
            'content' => [
                'customer_name' => 'Ana',
                'intro' => 'Your payment has been verified.',
                'details' => [['label' => 'Reference', 'value' => 'PAY-9']],
                'status' => 'Paid',
                'cta_url' => 'https://pawesome.example/customer/payments',
                'cta_label' => 'View Payment',
            ],
        ])->render();

        $this->assertStringContainsString('PAWESOME', $text);
        $this->assertStringContainsString('Hello, Ana', $text);
        $this->assertStringContainsString('Your payment has been verified.', $text);
        $this->assertStringContainsString('PAY-9', $text);
        $this->assertStringContainsString('STATUS: PAID', $text);
        $this->assertStringContainsString('https://pawesome.example/customer/payments', $text);
        $this->assertStringNotContainsString('<', $text);
    }

    public function test_legacy_unstructured_mail_still_renders(): void
    {
        $mail = (new CustomerNotificationMail('Booking Update', 'Your booking is confirmed.', 'info'))->build();

        $html = $mail->render();
        $this->assertStringContainsString('Booking Update', $html);
        $this->assertStringContainsString('Your booking is confirmed.', $html);
        $this->assertStringContainsString('Hello', $html);
        $this->assertSame('[Pawesome] Booking Update', $mail->subject);
    }

    // ------------------------------------------------------------------
    // Payment rejection (cashier path)
    // ------------------------------------------------------------------

    public function test_payment_rejection_records_structured_email_intent(): void
    {
        Queue::fake();
        [$user] = $this->verifiedCustomer(['email' => 'customer@example.com']);
        $sr = $this->submitRequest($user);
        $sr->update(['payment_status' => 'pending', 'payment_method' => 'gcash', 'payment_reference' => 'OLD-REF-42']);
        $cashier = $this->staff('cashier');

        $this->postJson("/api/cashier/payment-requests/{$sr->id}/reject", [
            'type' => 'service_request',
            'rejection_reason' => 'Unclear payment screenshot.',
        ], $this->bearer($cashier))->assertOk();

        $this->assertSame('rejected', $sr->fresh()->payment_status);

        $delivery = EmailDelivery::where('event_key', 'payment.rejected')->firstOrFail();
        $this->assertSame(EmailDelivery::fingerprint('customer@example.com'), $delivery->recipient_fingerprint);

        /** @var CustomerNotificationMail $mailable */
        $mailable = unserialize(Crypt::decryptString($delivery->payload));
        $this->assertInstanceOf(CustomerNotificationMail::class, $mailable);
        $this->assertSame("[Pawesome] Action Required: Payment Verification Issue — SR-{$sr->id}", $mailable->content['subject']);
        $this->assertSame('error', $mailable->type);

        $details = collect($mailable->content['details'])->pluck('value', 'label');
        $this->assertSame('Unclear payment screenshot.', $details->get('Reason'));
        $this->assertSame('OLD-REF-42', $details->get('Payment reference to correct'));
        $this->assertStringContainsString('re-enter or correct', $mailable->content['intro']);
        $this->assertSame('Full Groom', $details->get('Service'));
        $this->assertSame('GCash', $details->get('Payment method'));

        $html = $mailable->render();
        $this->assertStringContainsString('Payment rejected', $html);
        $this->assertStringContainsString('Unclear payment screenshot.', $html);
    }

    public function test_payment_rejection_without_reason_records_no_intent(): void
    {
        Queue::fake();
        [$user] = $this->verifiedCustomer(['email' => 'customer@example.com']);
        $sr = $this->submitRequest($user);
        $sr->update(['payment_status' => 'pending', 'payment_method' => 'gcash']);
        $cashier = $this->staff('cashier');

        $this->postJson("/api/cashier/payment-requests/{$sr->id}/reject", [
            'type' => 'service_request',
        ], $this->bearer($cashier))->assertStatus(422);

        $this->assertSame('pending', $sr->fresh()->payment_status);
        $this->assertSame(0, EmailDelivery::where('event_key', 'payment.rejected')->count());
    }

    public function test_already_rejected_payment_sends_no_duplicate(): void
    {
        Queue::fake();
        [$user] = $this->verifiedCustomer(['email' => 'customer@example.com']);
        $sr = $this->submitRequest($user);
        $sr->update(['payment_status' => 'pending', 'payment_method' => 'gcash']);
        $cashier = $this->staff('cashier');

        $payload = ['type' => 'service_request', 'rejection_reason' => 'Invalid reference.'];
        $this->postJson("/api/cashier/payment-requests/{$sr->id}/reject", $payload, $this->bearer($cashier))->assertOk();
        $this->postJson("/api/cashier/payment-requests/{$sr->id}/reject", $payload, $this->bearer($cashier))->assertStatus(422);

        $this->assertSame(1, EmailDelivery::where('event_key', 'payment.rejected')->count());
    }

    public function test_customer_opt_out_suppresses_payment_rejection_intent(): void
    {
        Queue::fake();
        [$user, $customer] = $this->verifiedCustomer(['email' => 'customer@example.com']);
        $customer->update(['notification_preferences' => ['email' => false]]);
        $sr = $this->submitRequest($user);
        $sr->update(['payment_status' => 'pending', 'payment_method' => 'gcash']);
        $cashier = $this->staff('cashier');

        $this->postJson("/api/cashier/payment-requests/{$sr->id}/reject", [
            'type' => 'service_request',
            'rejection_reason' => 'Blurry proof.',
        ], $this->bearer($cashier))->assertOk();

        // Rejection still succeeds — only the email is suppressed.
        $this->assertSame('rejected', $sr->fresh()->payment_status);
        $this->assertSame(0, EmailDelivery::where('event_key', 'payment.rejected')->count());
    }

    // ------------------------------------------------------------------
    // Order lifecycle (receptionist status transitions)
    // ------------------------------------------------------------------

    private function createOrder(User $customer): int
    {
        return DB::table('customer_orders')->insertGetId([
            'customer_id' => $customer->id,
            'customer_name' => $customer->name,
            'customer_email' => $customer->email,
            'reference_number' => 'ORD-TEST-1',
            'total_amount' => 500,
            'payment_method' => 'gcash',
            'payment_status' => 'unpaid',
            'status' => 'pending',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    public function test_order_approval_records_structured_email_intent(): void
    {
        Queue::fake();
        [$user] = $this->verifiedCustomer(['email' => 'customer@example.com']);
        $orderId = $this->createOrder($user);
        $receptionist = $this->staff('receptionist');

        $this->putJson("/api/receptionist/orders/{$orderId}/status", [
            'status' => 'approved',
        ], $this->bearer($receptionist))->assertOk();

        $delivery = EmailDelivery::where('event_key', 'order.status')->firstOrFail();
        $this->assertSame(EmailDelivery::fingerprint('customer@example.com'), $delivery->recipient_fingerprint);

        /** @var CustomerNotificationMail $mailable */
        $mailable = unserialize(Crypt::decryptString($delivery->payload));
        $this->assertSame('[Pawesome] Order Approved — ORD-TEST-1', $mailable->content['subject']);
        $this->assertStringContainsString('ORD-TEST-1', $mailable->render());
        $this->assertStringContainsString('₱500.00', $mailable->render());
    }

    public function test_order_rejection_includes_reason_in_email(): void
    {
        Queue::fake();
        [$user] = $this->verifiedCustomer(['email' => 'customer@example.com']);
        $orderId = $this->createOrder($user);
        $receptionist = $this->staff('receptionist');

        $this->putJson("/api/receptionist/orders/{$orderId}/status", [
            'status' => 'rejected',
            'rejection_reason' => 'Item is out of stock.',
        ], $this->bearer($receptionist))->assertOk();

        $delivery = EmailDelivery::where('event_key', 'order.status')->firstOrFail();
        /** @var CustomerNotificationMail $mailable */
        $mailable = unserialize(Crypt::decryptString($delivery->payload));

        $details = collect($mailable->content['details'])->pluck('value', 'label');
        $this->assertSame('Item is out of stock.', $details->get('Reason'));
        $this->assertSame('[Pawesome] Order Rejected — ORD-TEST-1', $mailable->content['subject']);
        $this->assertStringContainsString('Rejected', $mailable->render());
    }

    public function test_noop_order_status_transition_sends_no_email(): void
    {
        Queue::fake();
        [$user] = $this->verifiedCustomer(['email' => 'customer@example.com']);
        $orderId = $this->createOrder($user);
        $receptionist = $this->staff('receptionist');

        $this->putJson("/api/receptionist/orders/{$orderId}/status", ['status' => 'approved'], $this->bearer($receptionist))->assertOk();
        $this->putJson("/api/receptionist/orders/{$orderId}/status", ['status' => 'approved'], $this->bearer($receptionist))->assertOk();

        $this->assertSame(1, EmailDelivery::where('event_key', 'order.status')->count());
    }
}
