# Pawesome Capstone — Agent Guide

## Project Overview

Pawesome is a pet care management system with role-based access for 7 roles:
customer, receptionist, cashier, inventory, veterinary, manager, admin.

- `admin` is the all-access staff role: it reaches every staff module
  (admin + manager + receptionist + cashier + inventory + vet) but is
  blocked from the customer portal.
- `super_receptionist` is a composite role — receptionist + cashier +
  inventory combined.
- `super_admin` was merged into `admin` and no longer exists as a separate
  role; stale rows/sessions normalize to `admin`.

## Architecture

- **Backend:** Laravel 12 (PHP 8.2+) at `backend/`
- **Frontend:** React 18 + Vite at `frontend/`
- **Database:** MySQL
- **Auth:** Laravel Sanctum personal access tokens + custom ApiTokenAuth middleware
- **E2E Tests:** Playwright at `frontend/e2e/`

## Key Commands

### Backend
```bash
cd backend
composer install
php artisan migrate --seed          # Local/demo initialization only
php artisan serve --host=127.0.0.1 --port=8000
php artisan route:cache              # Production route caching
php artisan view:cache               # Production view caching
php artisan config:cache             # Production config caching
php artisan test                     # Unit/feature tests (phpunit.xml forces MySQL pawesome_test)
php artisan inventory:reconcile-stock        # Dry-run stock vs batch drift report
php artisan inventory:reconcile-stock --apply # Repair drift (creates RECON- batches)
```

### Pre-push backend verification (CI parity)

`phpunit.xml` pins `DB_*` to MySQL `pawesome_test` (the legacy
`.env.testing` sqlite values are overridden). CI
(`.github/workflows/ci.yml`) runs the FULL suite on MySQL 8 as well.
Before pushing backend changes, run:

```bash
mysql -u root -e "CREATE DATABASE IF NOT EXISTS pawesome_test;"   # one-time
cd backend
DB_CONNECTION=mysql DB_DATABASE=pawesome_test DB_USERNAME=root DB_PASSWORD= php artisan test
```

### Frontend
```bash
cd frontend
npm install
npm run dev                          # Dev server on port 3000
npm run build                        # Production build to build/
```

Workspace note: the frontend checkout currently has no `yarn.lock`; Corepack Yarn 4.9.2 reports that `pawesome_frontend@workspace:.` is missing from the lockfile. Running `yarn install` would create/update dependency lock state and requires explicit user approval.

### E2E Tests
```bash
cd frontend
npx playwright test                  # Run all E2E tests
npx playwright test e2e/pawesome-role-smoke-audit.spec.js --reporter=list
npx playwright test e2e/cross-role-main-workflow.spec.js --reporter=list
```

### Audit Scripts
```bash
cd backend
php pawesome_cross_role_e2e_audit.php          # Gate A: Cross-role E2E
php pawesome_security_rbac_audit.php           # Gate B: Security & RBAC
php pawesome_database_readiness_audit.php      # Gate C: Database readiness
php pawesome_report_reconciliation_audit.php   # Gate D: Report reconciliation
```

## Test Credentials

| Role | Email | Password |
| --- | --- | --- |
| admin | admin@example.com | Password123! |
| manager | manager@example.com | password123 |
| cashier | cashier@example.com | password123 |
| receptionist | receptionist@example.com | Password123! |
| super receptionist | super_receptionist@example.com | Password123! |
| inventory | inventory@example.com | Password123! |
| veterinary | vet@example.com | Password123! |
| customer | customer@example.com | Password123! |

## Email & Verification

Transactional email covers: customer email verification, password reset links,
password-changed and account-welcome notices, lifecycle notifications
(`CustomerNotificationMail`), and authoritative payment receipts
(`PaymentReceiptMail`). **Every** customer-facing email flows through the
durable `email_deliveries` outbox — a producer creates an intent row inside
the business transaction, `email-deliveries:dispatch` publishes it to the
`emails` database queue, and `App\Jobs\SendEmailDelivery` renders and sends
via the configured mailer. See `docs/NOTIFICATION_MATRIX.md` → "Email outbox"
for dedup (`occurrence_key`), encrypted recipients, send-time suppression
checks, and state semantics (queued ≠ sent ≠ provider-accepted ≠ delivered).

### Flow

- `POST /api/auth/register` → creates customer (`email_verified_at = null`) →
  hashed token in `email_verification_tokens` (60-min expiry) → outbox intent
  `EmailVerificationMail` → link `{FRONTEND_URL}/verify-email?token=…&email=…`
- `POST /api/auth/email/verify` → sets `email_verified_at`, deletes token
- `POST /api/auth/email/resend` → generic response (no account enumeration)
- `POST /api/auth/password/forgot` → hashed token in `password_reset_tokens`
  (60-min expiry) → outbox intent `PasswordResetMail` → link
  `{FRONTEND_URL}/forgot-password?email=…&token=…`
- `POST /api/auth/password/reset` → generic "invalid or expired" errors
  (no account enumeration)
- `verified` middleware (`EnsureEmailIsVerified`) blocks unverified **customers**
  from all booking/checkout POSTs; staff roles are exempt. Login is allowed —
  React redirects unverified customers to `/verify-email`.
- Changing email via `PUT /api/auth/profile` re-triggers verification
  (customers only).
- `POST /api/admin/users` (admin-created accounts) → outbox intent
  `AccountWelcomeMail` with a set-your-own-password link (reuses
  `password_reset_tokens`) — plaintext credentials are never emailed.
  Admin/seeded accounts are pre-verified (`email_verified_at` set at
  creation); verification applies to customers only.
- Customer lifecycle emails honor `notification_preferences.email`
  (`GET|PUT /api/customer/notification-preferences`) — checked at intent
  creation AND re-checked by the worker at send time, so an opt-out between
  intent and pickup suppresses the delivery. Required internal state and
  payment success are never affected by email preferences.
- `User::profile_photo` falls back to a locally generated initials avatar
  (data-URI SVG, deterministic color per name) when no photo is uploaded —
  every dashboard/navbar shows an identity avatar automatically with no
  external service dependency. Raw value via `getRawOriginal('profile_photo')`.

### Mailer configuration

| Environment | Driver | Notes |
| --- | --- | --- |
| Local dev | `MAIL_MAILER=log` | Emails (incl. links) written to `storage/logs/laravel.log` |
| Tests | `MAIL_MAILER=array` | `phpunit.xml` / `.env.testing`; use `Mail::fake()` |
| Demo/Prod | Brevo HTTPS API | `MAIL_MAILER=brevo`, `BREVO_API_KEY`; requests use HTTPS (port 443) |

Brevo setup: app.brevo.com → **SMTP & API → API Keys** → create a REST API key
for `BREVO_API_KEY` (not the SMTP key). `MAIL_FROM_ADDRESS` must be a
Brevo-verified sender (**Senders**; single-sender verification works without a
domain). `BREVO_DOMAIN` is only needed if Brevo assigns a regional API endpoint.
Never put mail credentials in frontend code or `VITE_*` vars.

Dev alternative: Mailtrap (`sandbox.smtp.mailtrap.io:2525`) — see commented
block in `backend/.env.example`.

### Queue

Email sends run as `App\Jobs\SendEmailDelivery` on the `emails` database queue
(mailables are rendered inside the job, not queued directly). The demo may use
`QUEUE_CONNECTION=sync` to avoid a worker. Business production requires a
supervised `php artisan queue:work --queue=emails,default` service (or Redis
per DEPLOYMENT.md), a scheduler daemon for `email-deliveries:dispatch`/
`:reconcile` and the other scheduled commands, and monitored failed jobs.

### Domain authentication (deployment requirement — not yet implemented)

Without a real sending domain, SPF/DKIM/DMARC **cannot** be configured — this
is a documented requirement, not a claim. When a domain is available:

1. Brevo → **Senders, Domains & Dedicated IPs → Domains** → add domain.
2. Publish the DNS records Brevo provides: SPF (`v=spf1 include:spf.brevo.com …`),
   DKIM (Brevo-generated `mail._domainkey` TXT), and DMARC
   (`_dmarc` TXT, e.g. `v=DMARC1; p=quarantine; rua=mailto:postmaster@domain`).
3. Set `MAIL_FROM_ADDRESS` to an address on that domain.

### Tests

`backend/tests/Feature/EmailAuthFlowTest.php` covers the full flow.
Note: the suite requires MySQL (migrations use MySQL-specific syntax);
sqlite `:memory:` fails. Run against a dedicated test DB:

```bash
mysql -u root -e "CREATE DATABASE IF NOT EXISTS pawesome_test;"
DB_CONNECTION=mysql DB_DATABASE=pawesome_test php artisan test --filter=EmailAuthFlowTest
```

## Deployment

The supported target is Vercel for the React/Vite frontend and Railway for the
Laravel API/MySQL service. The legacy `backend/render.yaml` and nested
`backend/.github/workflows/deploy.yml` are not active canonical deployment
configuration; review `docs/DEPLOYMENT.md` before using any provider settings.

### Capstone demo
- Vercel frontend, Railway Laravel API and MySQL.
- Use a Railway persistent volume mounted at Laravel `storage/app` before using
  local public/private upload disks.
- `QUEUE_CONNECTION=sync` and file cache are acceptable for a controlled demo.

### Business production
- Separate staging and production Railway services/databases.
- Use Redis with a dedicated queue worker and scheduler.
- Use separate private and public S3-compatible buckets; private payment proofs
  must never be publicly readable.
- Configure backups, restore drills, monitoring, and gated releases.

### Release checklist
- [ ] `APP_DEBUG=false`, production `APP_KEY`, and production database credentials
- [ ] Exact production CORS/Sanctum/frontend/API domains
- [ ] Persistent demo volume or verified private/public object storage
- [ ] Queue worker/scheduler enabled where required
- [ ] No demo seed accounts in business production
- [ ] Dependency audit reviewed and exceptions documented
- [ ] Backup and rollback procedures tested
- [ ] CI, health check, and post-deploy smoke checks pass

## Known Windows Development Issues

- Socket exhaustion (68K+ TIME_WAIT sockets) causes `ERR_NETWORK_CHANGED`,
  `ERR_ADDRESS_IN_USE`, and `Failed to fetch` errors in Playwright tests.
- These are Windows TCP/IP stack issues, not application defects.
- Mitigation: reboot, or run tests on Linux/Docker.

## Issue Tracking

- **Profile Photo Fallback: FIXED** — 12/12 browser/API/database checks passed.
  `User::profile_photo` returns a deterministic-color initials `data:` URI when
  no photo is uploaded; `frontend/src/utils/avatar.js` (`resolveAvatarUrl`)
  passes `data:`/`blob:`/`http` through (stripping corrupted `?v=` suffixes)
  and resolves `/api/...` paths against the `VITE_API_BASE_URL` origin.
  Verified in Chromium: topbar, ProfileSettings, receptionist customer list,
  and manager staff list all render the avatar; uploaded photos load via
  `/api/files/profile-photos/{id}/view`.
- **Veterinary Profile Navigation: FIXED** — `DashboardProfile.ROLE_PROFILE_PATHS`
  now maps `veterinary → /veterinary/profile`, matching the `/veterinary/*`
  route mount. Browser-verified in `e2e/role-deep-links.spec.js` alongside the
  vet `/vet/*` → `/veterinary/*` notification deep-link fixes.
- **Storage Hardening: FIXED** — all uploads go through
  `App\Services\FileStorageService::storeAndPersist()` (store → DB write in a
  transaction → delete new file on failure → delete replaced file only after
  success). Controllers keep their own validation/business rules. Payment proofs
  pass `deleteOld: false`: replaced/rejected proofs are retained as evidence.
  Inventory photos/batch proofs are image-validated and stored on the `public`
  disk (`HandlesInventoryUploads` trait) — never written under `public/`.
  `private`/`public` disks use `throw => true`; S3/R2 roots come from
  `PRIVATE_STORAGE_ROOT`/`PUBLIC_STORAGE_ROOT` (never local paths); storage
  failures render as a 503 JSON (`bootstrap/app.php`). Local dev needs
  `php artisan storage:link` once for public-disk URLs.
  Tests: `php artisan test --filter="StorageLifecycleTest|PrivatePetPhotoTest|PrivateConfinementPaymentProofTest"`;
  browser: `E2E_BASE_URL=http://localhost:3000 npx playwright test e2e/storage-hardening.spec.js --project=chromium`
  (evidence in `browser-evidence/storage-hardening/`).
- **Known unrelated test failures: OPEN — requires separate investigation** —
  8 full-suite failures observed during storage hardening (DatabaseIntegrityTest ×2,
  EndToEndBusinessFlowTest, FullSystemIntegrationTest, PayrollEndToEndTest ×2,
  ReportsTest inventory count, VeterinaryWorkflowTest). None exercise upload code,
  but they have NOT been confirmed against a clean-checkout baseline yet.
- **E2E hygiene & reliability: FIXED** — suite defaults to live mode
  (`E2E_LIVE=true`; opt out with `0`/`false`), port drift `:3002`→`:3000` and
  the `localhost`/`127.0.0.1` origin split are resolved, login throttling is
  avoided via the shared token cache in `e2e/test-utils.js` (`apiLogin`
  supports `{ refresh: true }` for post-logout re-issue), and data-dependent
  tests provision fixtures via API. Two app-level bugs were found and fixed:
  `CustomerRequestStatus` emptied the whole table if any one of its three
  fetches failed, and `NotificationDropdown` defaulted unresolved roles to
  `"manager"`. Full-suite result: 105 passed / 13 failed at 4 workers; the
  residuals are Windows/dev-server load starvation — all pass at
  `--workers=2` or in isolation. Details and rerun guidance:
  `docs/E2E_RELIABILITY_AUDIT.md`.
- **POS "Insufficient batch stock" false failures: FIXED** — the flat
  `inventory_items.stock` counter and `inventory_batches` totals could drift:
  the monthly audit wrote `stock` but only a 0-qty `audit_adjusted` marker
  batch (which then forced the item onto the FEFO path with nothing to
  deduct), and adjust/set, customer-order, and boarding add-on paths moved
  `stock` with no batch at all. `InventoryService::reconcileToStock` +
  `applyMonthlyAuditAdjustment` now keep both counters in sync on every path;
  `deductStock` self-heals residual drift by materializing a labelled `RECON-`
  batch instead of blocking the cashier; `hasRealBatches()` ignores marker
  rows; `php artisan inventory:reconcile-stock [--apply]` reports/repairs
  existing drift (dry-run default). Tests:
  `php artisan test --filter=InventoryBatchReconciliationTest`.
- **Cashier notification deep link: FIXED** — `/cashier/payment-verification`
  (used by `NotificationDropdown` and the chatbot) previously hit the `*` catch-all
  and opened POS on the Products tab. It is now a real route rendering
  `CashierPOS initialTab="payment-approvals"`; the tab is re-selected on each
  navigation without remounting (cart preserved). `CashierPaymentVerification.jsx`
  is unrouted legacy — the live approvals UI is `PaymentApprovals` inside POS.
  Browser: `E2E_BASE_URL=http://localhost:3000 npx playwright test e2e/cashier-payment-deep-link.spec.js --project=chromium`.
- **Email system (Phase 2–5): VERIFIED** — all customer-facing mail now renders
  through a shared table-based layout (`emails/layout.blade.php` + partials:
  status chip, details table, CTA) with plain-text fallbacks for every
  mailable. `CustomerNotificationMail` accepts a structured `content` payload
  serialized inside the existing encrypted outbox payload — the
  `email_deliveries` outbox, dedup, suppression, and retry semantics are
  unchanged. New events: `payment.rejected` (cashier rejection, post-commit,
  reason + resubmit CTA) and `order.status` (receptionist transitions, with
  no-op guard). `order.submitted` intentionally absent: `checkout()` is
  disabled (HTTP 410). `PayslipReleasedMail` normalized visually but still has
  no producer. Subjects standardized as `[Pawesome] <Event> — <Ref>`.
  Verified with real provider acceptance on Brevo SMTP locally (12 events:
  auth verify/reset, service-request lifecycle, proof submit/reject/resubmit,
  boarding create/status, order status, boarding receipt, opt-out suppression,
  dedup) and on the Railway `brevo` HTTPS API transport (register + forgot —
  Brevo events `sent`→`delivered`). Helper: `App\Support\EmailContent`.
  Tests: `php artisan test --filter=EmailStructuredContentTest` (12/12).
- **₱0 billings in cashier payment approvals: FIXED** — bookings with an
  unmatched/generic service name (e.g. customer-submitted "Grooming") were
  reaching the cashier queue at ₱0 because producers never resolved a
  catalog price. `App\Services\ServiceCatalog` is now the single resolver
  (name match → per-bucket default service → materializes a priced default);
  every producer uses it: `ServiceRequestController@store`,
  `ReceptionistRequestController@store`/`updateStatus`/`approve`,
  `WalkInController` (grooming), `GroomingController@store`, and
  `AppointmentController` grooming auto-create (all persist
  amount/base_amount/total_amount/balance_due). Approval paths backfill
  ₱0 linked records + `service_requests.price`/`total_amount` and call
  `ServiceBillingService::ensureBaseServiceItem` for grooming and boarding.
  Cashier queue (`Cashier\DashboardController@getPaymentRequests`) resolves
  amounts via `queueAmount`/`serviceRequestQueueAmount` (persisted total →
  itemized bill → catalog → ₱500 estimate floor), lists `unpaid`
  boardings/confinements for counter collection, and
  `PaymentVerificationService::markLinkedServiceAsPaidFromRequest` normalizes
  `hotel`→`boardings` via `ServiceCatalog::bucketFor` (hotel-typed requests
  previously left the boarding unpaid). `verifyTablePayment` accepts `unpaid`
  confinements. Frontend `usePaymentApprovals`/`PaymentApprovals` gate Reject
  to `payment_status === 'pending'` (card + modal) and self-heal the list on
  stale-state 422s. Existing ₱0 rows were repaired via tinker (catalog
  backfill + `syncServicePaymentState`).
- **Reject → resubmit → verify desync: FIXED** — rejected/resubmitted payments
  never reached booked records because propagation was one-way
  (SR → linked record on verify only). `PaymentVerificationService` is now
  bidirectional: verifying a linked record (grooming/boarding/appointment)
  marks its parent SR paid with a shared receipt via `service_request_id`;
  rejecting either side propagates to a `pending` counterpart
  (`markLinkedServiceAsRejected`/`markServiceRequestAsRejected`); reject is
  restricted to `pending` proofs (previous `unpaid`/`rejected` in the allowlist
  let cashiers "reject" a payment that never existed). Resubmit endpoints
  propagate the `pending` state + method/reference/proof to the counterpart
  (`ServiceRequestController::uploadPaymentProof` → linked record;
  `BoardingController::uploadPaymentProof` → parent SR via
  `onlyExistingColumns`). `verify`/`updatePaymentStatus` for linked types now
  also persist `payment_method`. Cashier queue lists `unpaid`/`rejected`
  approved SRs for counter collection; `rejected` linked rows emit
  `payment_method => null` so the UI treats them as counter payments.
  `appointments` has no proof/method columns — appointment payments flow
  through the SR or the counter. E2E-verified: SR#11/GR#7 full
  reject→resubmit→verify cycle (shared receipt `SR-REC-…-11`), GR#4
  linked-verify paid SR#7, stranded pair SR#10/APT#3 settled via SR verify.
- **Cashier approvals card layout: FIXED** — `pa-card-reference` was a third
  flex child of `.pa-card-body` (`justify-content: space-between`), so on
  cards with a customer reference the amount floated mid-card while the ref
  hugged the right edge; the ref now lives inside `.pa-amount-section`.
  `.pa-bulk-bar` is sticky but its `rgba(255,95,147,.04)` background let
  cards bleed through when scrolling — now opaque `#fdf2f8`. Null-method
  (counter) rows rendered a meaningless "—" badge — `getMethodConfig` now
  falls back to the Cash config. `.pos-order-panel` (360px cart) is no
  longer rendered while `activeTab === 'payment-approvals'`, so the queue
  gets full width and the approvals tab stops clipping at ~1280px; cart
  state lives in `CashierPOS_New` and survives the unmount. Truncation
  guards added on `.pa-service`/`.pa-service-name`; ≤768px stacks body and
  puts the ref on its own line. Screenshot-verified at 1920/1440/1280/
  1100/1000/768.
- **ServiceBillingPanel 429 fetch storm: FIXED** — `onBillingUpdate` was a
  `useCallback` dep, so inline parent callbacks (receptionist hotel/grooming
  lists) recreated it every render → infinite `/billing/{type}/{id}/summary`
  loop → per-IP `throttle:api` (60/min) exhausted → whole API 429'd. Fixed by
  holding the callback in a ref and memoizing the two parent callbacks
  (`handleBillingRefresh`). Backend throttle unchanged.
- **Manual pet-name entry removed from bookings: FIXED** — every booking now
  links a real `pets` row via `pet_id`; typed names are never persisted.
  `ServiceRequestController::store` requires `pet_id` (`exists:pets,id`),
  keeps the owner/archive/species-compatibility checks, and derives
  `pet_name`/`pet_type` from the `Pet` model (client-sent names are ignored).
  `ReceptionistRequestController::store` requires `pet_id` and derives pet +
  customer identity from `pet->customer` (`service_requests.customer_id`
  stores a users.id). `HotelForm` lost its "Enter pet details manually" path
  and implicit `/customer/pets` create-on-submit; the select is required and
  a "Register a pet first" link shows when the account has no pets.
  `ServiceBookingModal` shows a registered-pet dropdown for authenticated
  customers (guests keep only the pet-type select since the booking can't
  submit until login). Draft restore (`pet_id` honored, name/species only as
  unique-match hints) updated in Grooming/Vet/Hotel forms. Latent bug found
  and fixed: `ServiceRequestController::cancel` now propagates `cancelled`
  to linked appointments/groomings/boardings — the auto-created pending
  grooming otherwise blocked the time slot forever. All other producers
  (walk-ins, appointments, boardings, chatbot bookings, confinements)
  already required `pet_id`. Tests: `CustomerBookingRulesTest` (incl. new
  missing-pet 422 / foreign-pet 403 / spoofed-name-derived cases),
  `EmailServiceWorkflowTest`, `EmailStructuredContentTest`,
  `NotificationMatrixTest`, `P1SecurityIntegrityTest`,
  `VeterinaryWorkflowTest`, `ServiceBillingRemediationTest` — all green.
- **Cancellation/rejection reason dropdowns: FIXED** — every booking
  cancel/reject prompt now shows a `<select>` of preset reasons plus an
  "Other (please specify)" free-text fallback via the shared
  `showReasonPrompt(message, title, confirmText, reasonOptions)` in
  `utils/alert.jsx`. Presets: `CUSTOMER_CANCEL_REASONS`,
  `STAFF_CANCEL_REASONS`, `BOOKING_REJECT_REASONS`, `CANCEL_REJECT_REASONS`,
  `PAYMENT_REJECT_REASONS`, `ORDER_REASONS`. Customer grooming/vet/hotel
  cancels previously collected NO reason; they now prompt and POST
  `{ reason }`. `service_requests`/`boardings`/`groomings` gained a
  `cancellation_reason` column (migration
  `2026_10_11_050413_add_cancellation_reason_to_booking_tables`;
  `appointments` already had one) and the cancel endpoints persist it —
  `ServiceRequestController::cancel` also propagates it to linked
  appointments/groomings/boardings. The ReceptionistBookings
  cancel-request modal uses an inline `<select>` (approve keeps an optional
  note). Receipt titles switched to invoice terminology (`SALES INVOICE`,
  `SERVICE INVOICE`, `INVOICE`) and `STORE_INFO.address` is a 3-line
  `\n`-joined string rendered line-by-line by every receipt.
- **VAT breakdown on all receipts: FIXED** — prices are VAT-inclusive;
  the 12% portion is `total × 0.12 / 1.12` (`EmailContent::vatInclusivePortion`
  PHP-side, `computeVatBreakdown` in `utils/storeInfo.js` client-side).
  Every receipt API payload now carries `net_amount`, `vat_amount`,
  `vat_rate`: `GET /customer/requests/{id}/receipt`,
  `GET /cashier/receipt/{id}` (uses stored `sales.subtotal`/`tax_amount`),
  `GET /cashier/customer-order-receipts/{id}`,
  `GET /customer/store/orders/{id}/receipt`, and
  `GET /veterinary/receipt/{id}`. On-screen receipts that lacked the
  breakdown now show Net Amount (ex-VAT) + VAT (12%) + Total:
  the PaymentApprovals verify-success mini receipt, the CashierTransactions
  detail modal footer, and the cashier text receipt download.
- **Booking review step on all booking forms: FIXED** —
  `components/shared/BookingReviewModal.jsx` shows pet (name/species/breed/
  age), booking details, pricing summary, vaccination-card preview, and
  notes with Go back / Confirm booking before the API call. Wired into
  customer GroomingForm, VetForm, HotelForm, the landing
  ServiceBookingModal, and receptionist walk-in flows
  (`WalkInBookingModal` — the live modal on `/receptionist/walk-ins` and
  `/super-receptionist/walk-ins`; `NewWalkInBookingModal` is wired but its
  only importer `ReceptionistAppointmentsBoarding.jsx` is unrouted legacy,
  same as `ReceptionistBookings.jsx`). Also fixed a pre-existing wizard
  bug: existing-customer mode advanced past its 3 steps into a duplicate
  "Step 4 of 3" booking form — the footer now caps at step 3 for existing
  customers. Browser-verified end-to-end (existing customer + pet select →
  review → Go back preserves form → Confirm posts once → success toast,
  zero console errors).
  Already-VAT surfaces untouched: `printReceipt`/`escpos` thermal output,
  `CashierPOS_New` completed receipt, `VetReceipt`, and the
  `payment-receipt` email (auto-filled by `EmailDeliveryService::receipt`).

## Reports

| Gate | Report Path |
| --- | --- |
| Gate A — Cross-role E2E | `browser-evidence/cross-role-e2e-audit/PAWESOME_CROSS_ROLE_E2E_READINESS_REPORT.md` |
| Gate B — Security & RBAC | `browser-evidence/security-rbac-audit/PAWESOME_SECURITY_RBAC_READINESS_REPORT.md` |
| Gate C — Database Readiness | `browser-evidence/database-readiness-audit/PAWESOME_DATABASE_READINESS_REPORT.md` |
| Gate D — Report Reconciliation | `browser-evidence/report-reconciliation-audit/PAWESOME_REPORT_RECONCILIATION_REPORT.md` |
| Browser Regression | `browser-evidence/browser-regression/PAWESOME_BROWSER_REGRESSION_REPORT.md` |
