<?php

namespace Tests\Feature;

use App\Mail\CustomerNotificationMail;
use App\Models\Appointment;
use App\Models\Boarding;
use App\Models\Customer;
use App\Models\EmailDelivery;
use App\Models\Pet;
use App\Models\Service;
use App\Models\ServiceRequest;
use App\Models\User;
use App\Services\EmailDeliveryService;
use App\Services\NotificationService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Queue;
use Tests\TestCase;

/**
 * Phase 4 — booking/service lifecycle emails through the durable outbox:
 * service-request submission/approval/rejection, boarding + appointment
 * lifecycle, reminders, dedup, and send-time suppression.
 */
class EmailServiceWorkflowTest extends TestCase
{
    use RefreshDatabase;

    private function bearer(User $user): array
    {
        return ['Authorization' => 'Bearer ' . $user->createToken('test')->plainTextToken];
    }

    private function deliverPending(): void
    {
        $deliveries = app(EmailDeliveryService::class);
        EmailDelivery::where('status', EmailDelivery::STATUS_PENDING)
            ->orderBy('id')
            ->pluck('id')
            ->each(fn ($id) => $deliveries->send($id, 'test'));
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

    private function submitGroomingRequest(User $user): ServiceRequest
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

    public function test_service_request_submission_records_and_delivers_customer_email(): void
    {
        Mail::fake();
        Queue::fake();
        [$user] = $this->verifiedCustomer(['email' => 'customer@example.com']);

        $this->submitGroomingRequest($user);

        $delivery = EmailDelivery::where('event_key', 'service_request.submitted')->firstOrFail();
        $this->assertSame(EmailDelivery::fingerprint('customer@example.com'), $delivery->recipient_fingerprint);
        $this->assertSame($user->id, $delivery->user_id);

        $this->deliverPending();
        Mail::assertSent(CustomerNotificationMail::class, fn ($m) => $m->hasTo('customer@example.com'));
        $this->assertSame(EmailDelivery::STATUS_ACCEPTED, $delivery->fresh()->status);
    }

    public function test_receptionist_approval_emails_customer(): void
    {
        Mail::fake();
        Queue::fake();
        [$user] = $this->verifiedCustomer(['email' => 'customer@example.com']);
        $receptionist = User::factory()->create(['role' => 'receptionist', 'is_active' => true]);
        $serviceRequest = $this->submitGroomingRequest($user);

        $this->postJson("/api/receptionist/requests/{$serviceRequest->id}/approve", [], $this->bearer($receptionist))
            ->assertOk();

        $delivery = EmailDelivery::where('event_key', 'service_request.approved')->firstOrFail();
        $this->deliverPending();
        Mail::assertSent(CustomerNotificationMail::class, fn ($m) => $m->hasTo('customer@example.com')
            && str_contains($m->title, 'Approved'));
        $this->assertSame(EmailDelivery::STATUS_ACCEPTED, $delivery->fresh()->status);
    }

    public function test_receptionist_rejection_emails_customer(): void
    {
        Mail::fake();
        Queue::fake();
        [$user] = $this->verifiedCustomer(['email' => 'customer@example.com']);
        $receptionist = User::factory()->create(['role' => 'receptionist', 'is_active' => true]);
        $serviceRequest = $this->submitGroomingRequest($user);

        $this->postJson("/api/receptionist/requests/{$serviceRequest->id}/reject", [
            'rejection_reason' => 'Fully booked that day.',
        ], $this->bearer($receptionist))->assertOk();

        $delivery = EmailDelivery::where('event_key', 'service_request.rejected')->firstOrFail();
        $this->deliverPending();
        Mail::assertSent(CustomerNotificationMail::class, fn ($m) => $m->hasTo('customer@example.com')
            && str_contains($m->title, 'Rejected'));
        $this->assertSame(EmailDelivery::STATUS_ACCEPTED, $delivery->fresh()->status);
    }

    public function test_service_request_completion_sends_booking_reference_and_is_idempotent(): void
    {
        Mail::fake();
        Queue::fake();
        [$user] = $this->verifiedCustomer(['email' => 'customer@example.com']);
        $receptionist = User::factory()->create(['role' => 'receptionist', 'is_active' => true]);
        $serviceRequest = $this->submitGroomingRequest($user);

        $this->patchJson("/api/receptionist/requests/{$serviceRequest->id}/status", [
            'status' => 'completed',
        ], $this->bearer($receptionist))->assertOk();

        $delivery = EmailDelivery::where('event_key', 'booking.completed')->firstOrFail();
        $this->assertSame('service_request', $delivery->source_type);
        $this->assertSame($serviceRequest->id, $delivery->source_id);
        $this->deliverPending();
        Mail::assertSent(CustomerNotificationMail::class, fn ($mail) => $mail->hasTo('customer@example.com')
            && $mail->title === 'Booking Completed'
            && str_contains($mail->content['subject'], "SR-{$serviceRequest->id}"));

        $this->patchJson("/api/receptionist/requests/{$serviceRequest->id}/status", [
            'status' => 'completed',
        ], $this->bearer($receptionist))->assertOk();
        $this->assertSame(1, EmailDelivery::where('event_key', 'booking.completed')->count());
    }

    public function test_appointment_creation_records_lifecycle_intent_via_model_hook(): void
    {
        Mail::fake();
        Queue::fake();
        [$user, $customer] = $this->verifiedCustomer(['email' => 'customer@example.com']);
        $pet = Pet::create(['customer_id' => $customer->id, 'name' => 'Buddy', 'species' => 'dog']);
        $service = Service::create(['name' => 'Checkup', 'category' => 'Consultation', 'price' => 500, 'is_active' => true]);

        $appointment = Appointment::create([
            'customer_id' => $customer->id,
            'pet_id' => $pet->id,
            'service_id' => $service->id,
            'scheduled_at' => now()->addDay(),
            'status' => 'pending',
        ]);

        $delivery = EmailDelivery::where('event_key', 'appointment.created')->firstOrFail();
        $this->assertSame($appointment->id, $delivery->source_id);

        $this->deliverPending();
        Mail::assertSent(CustomerNotificationMail::class, fn ($m) => $m->hasTo('customer@example.com'));
    }

    public function test_appointment_lifecycle_statuses_email_but_routine_states_stay_in_app(): void
    {
        Mail::fake();
        Queue::fake();
        [$user, $customer] = $this->verifiedCustomer(['email' => 'customer@example.com']);
        $pet = Pet::create(['customer_id' => $customer->id, 'name' => 'Buddy', 'species' => 'dog']);
        $service = Service::create(['name' => 'Checkup', 'category' => 'Consultation', 'price' => 500, 'is_active' => true]);
        $appointment = Appointment::create([
            'customer_id' => $customer->id,
            'pet_id' => $pet->id,
            'service_id' => $service->id,
            'scheduled_at' => now()->addDay(),
            'status' => 'pending',
        ]);

        // Routine operational state — in-app only, no email intent.
        $appointment->update(['status' => 'in_progress']);
        $this->assertDatabaseMissing('email_deliveries', ['event_key' => 'appointment.status']);

        // Lifecycle state — email intent recorded.
        $appointment->update(['status' => 'approved']);
        $delivery = EmailDelivery::where('event_key', 'appointment.status')->firstOrFail();
        $appointment->update(['status' => 'completed']);
        $completion = EmailDelivery::where('event_key', 'booking.completed')->firstOrFail();
        $this->assertSame($appointment->id, $completion->source_id);

        $this->deliverPending();
        Mail::assertSent(CustomerNotificationMail::class, fn ($m) => $m->hasTo('customer@example.com'));
        Mail::assertSent(CustomerNotificationMail::class, fn ($m) => $m->hasTo('customer@example.com')
            && $m->title === 'Booking Completed'
            && str_contains($m->content['subject'], "APT-{$appointment->id}"));
    }

    public function test_boarding_lifecycle_statuses_record_email_intents(): void
    {
        Mail::fake();
        Queue::fake();
        [$user, $customer] = $this->verifiedCustomer(['email' => 'customer@example.com']);
        $pet = Pet::create(['customer_id' => $customer->id, 'name' => 'Buddy', 'species' => 'dog']);
        $boarding = Boarding::create([
            'customer_id' => $customer->id,
            'customer_email' => $user->email,
            'customer_name' => $user->name,
            'pet_id' => $pet->id,
            'pet_name' => 'Buddy',
            'pet_type' => 'dog',
            'status' => 'approved',
            'payment_status' => 'unpaid',
            'check_in' => now()->addDay()->toDateString(),
            'check_out' => now()->addDays(3)->toDateString(),
            'total_amount' => 1000,
        ]);

        foreach (['in_care', 'ready_for_pickup', 'checked_out', 'completed'] as $status) {
            $boarding->update(['status' => $status]);
            NotificationService::notifyBoardingStatusChange($boarding, 'previous');
        }

        $this->assertSame(3, EmailDelivery::where('event_key', 'boarding.status')->count());
        $this->assertSame(1, EmailDelivery::where('event_key', 'booking.completed')->count());
        $this->deliverPending();
        Mail::assertSent(CustomerNotificationMail::class, 4);
    }

    public function test_reminder_command_records_intent_and_marks_reminder_sent(): void
    {
        Mail::fake();
        Queue::fake();
        [$user, $customer] = $this->verifiedCustomer(['email' => 'customer@example.com']);
        $pet = Pet::create(['customer_id' => $customer->id, 'name' => 'Buddy', 'species' => 'dog']);
        $service = Service::create(['name' => 'Checkup', 'category' => 'Consultation', 'price' => 500, 'is_active' => true]);
        $appointment = Appointment::create([
            'customer_id' => $customer->id,
            'pet_id' => $pet->id,
            'service_id' => $service->id,
            'scheduled_at' => now()->addDay()->setTime(10, 0),
            'status' => 'approved',
        ]);

        $this->artisan('notifications:send-reminders')->assertSuccessful();

        $delivery = EmailDelivery::where('event_key', 'reminder.appointment')->firstOrFail();
        $this->assertNotNull($appointment->fresh()->reminder_sent_at);

        // A second run must not re-notify — reminder_sent_at now persists.
        $this->artisan('notifications:send-reminders')->assertSuccessful();
        $this->assertSame(1, EmailDelivery::where('event_key', 'reminder.appointment')->count());

        $this->deliverPending();
        Mail::assertSent(CustomerNotificationMail::class, fn ($m) => $m->hasTo('customer@example.com'));
    }

    public function test_reminder_is_suppressed_when_appointment_cancelled(): void
    {
        Mail::fake();
        Queue::fake();
        [$user, $customer] = $this->verifiedCustomer(['email' => 'customer@example.com']);
        $pet = Pet::create(['customer_id' => $customer->id, 'name' => 'Buddy', 'species' => 'dog']);
        $service = Service::create(['name' => 'Checkup', 'category' => 'Consultation', 'price' => 500, 'is_active' => true]);
        $appointment = Appointment::create([
            'customer_id' => $customer->id,
            'pet_id' => $pet->id,
            'service_id' => $service->id,
            'scheduled_at' => now()->addDay()->setTime(10, 0),
            'status' => 'approved',
        ]);

        $this->artisan('notifications:send-reminders')->assertSuccessful();
        $delivery = EmailDelivery::where('event_key', 'reminder.appointment')->firstOrFail();

        // Customer cancels before the delayed worker sends.
        $appointment->update(['status' => 'cancelled']);

        $this->deliverPending();
        // The reminder is suppressed; the cancellation notice itself is a
        // legitimate lifecycle email and still reaches the customer.
        Mail::assertNotSent(CustomerNotificationMail::class, fn ($m) => str_contains($m->title, 'Reminder'));
        Mail::assertSent(CustomerNotificationMail::class, fn ($m) => str_contains($m->title, 'Update'));
        $this->assertSame(EmailDelivery::STATUS_SUPPRESSED, $delivery->fresh()->status);
    }

    public function test_customer_email_opt_out_records_no_intent_but_keeps_in_app(): void
    {
        Mail::fake();
        Queue::fake();
        [$user, $customer] = $this->verifiedCustomer(['email' => 'customer@example.com']);
        $customer->update(['notification_preferences' => ['email' => false]]);

        $this->submitGroomingRequest($user);

        $this->assertDatabaseMissing('email_deliveries', ['event_key' => 'service_request.submitted']);
        $this->assertDatabaseHas('notifications', ['title' => 'Service Request Submitted']);

        $this->deliverPending();
        Mail::assertNothingSent();
    }

    public function test_occurrence_dedup_collapses_duplicate_intents(): void
    {
        Mail::fake();
        Queue::fake();
        [$user, $customer] = $this->verifiedCustomer(['email' => 'customer@example.com']);

        $context = [
            'event_key' => 'service_request.approved',
            'occurrence_key' => 'service_request.approved:1',
            'source_type' => 'service_request',
            'source_id' => 1,
        ];
        $svc = app(EmailDeliveryService::class);
        $first = $svc->lifecycle($user->email, 'Approved', 'Body', 'success', $context);
        $second = $svc->lifecycle($user->email, 'Approved', 'Body', 'success', $context);

        $this->assertSame($first->id, $second->id);
        $this->assertDatabaseCount('email_deliveries', 1);

        $this->deliverPending();
        Mail::assertSent(CustomerNotificationMail::class, 1);
    }
}
