# KIZA — Full Mobile Application Engineering Brief
## For Claude Code Opus 5.5

You are the principal software architect, senior React Native engineer, product designer, security engineer, and technical lead responsible for building **Kiza**, a real-world prepaid student meal-management platform for a restaurant in Huye, Rwanda.

Your task is to build the actual software, not merely produce a proposal, UI mockup, prototype, or collection of disconnected screens.

Use your coding tools to inspect the current project, make sound architectural decisions, implement the application, run available checks, and maintain clear documentation.

Do not assume that a feature works because its UI exists. Implement real behavior, persistence, validation, and error handling.

---

# 1. PRODUCT CONTEXT

Kiza serves students from the University of Rwanda (UR) and Rwanda Polytechnic (RP) in Huye.

Kiza sells prepaid meal packages known locally as *igifu*. Packages can last 5, 10, 15, 20, 30, 45 days, or other configurable durations. Each eligible day includes lunch and dinner.

The current workflow relies on physical cards, handwritten books, staff checking student names and payment confirmations, and a token or ticket passed to buffet staff before food is collected.

This creates opportunities to improve:
- Student identification and meal verification.
- Tracking active packages and remaining meal entitlements.
- Duplicate meal-claim prevention.
- Payment reconciliation.
- Staff efficiency and record accuracy.
- Management reporting and operational visibility.
- Student convenience and transparency.

Kiza needs a practical system designed for real restaurant operations, not a generic restaurant ordering app.

The expected scale is approximately 3,000 students in the wider student population. This is an initial planning estimate, not a confirmed number of Kiza's active customers.

There are **three buffets**, each expected to have its own scanning phone.

# 2. PRIMARY PRODUCT VISION

Build one connected platform with two main mobile experiences:

1. **Kiza Student:** Students view their meal packages, payment status, remaining entitlements, profile, and a QR-based meal pass.
2. **Kiza Staff:** Authorized employees scan student QR codes using ordinary Android phone cameras, verify identities and entitlements, and record approved meal claims.

Add management capabilities for registration, package assignment, payment records, reports, and staff administration.

The application must support Kinyarwanda as its primary interface language. English may be provided as a secondary language, but Kinyarwanda must not feel like an afterthought.

All essential screens, errors, notifications, status messages, and confirmation dialogs should be localized.

Use natural, clear Kinyarwanda. Avoid literal translations that sound unnatural to Rwandan users.

# 3. TECHNOLOGY STACK

Use the following stack unless repository inspection reveals a compelling technical reason to change a choice.

## Mobile application
- React Native.
- Expo with TypeScript.
- Expo Router for navigation.
- A maintained camera and barcode-scanning library compatible with the selected Expo SDK.
- Expo-compatible secure storage for sensitive device credentials.
- SQLite for appropriate local persistence and offline data.
- A maintainable state-management solution.
- A reusable design system with typed components.

Choose package versions that are mutually compatible. Inspect current project dependencies before changing them.

Prefer Expo's supported workflows and development builds when necessary. Do not sacrifice camera functionality, native security, or reliable offline storage merely to remain in Expo Go.

## Backend and shared data
Choose a backend that supports:
- PostgreSQL as the authoritative database.
- Transactional meal-claim processing.
- Strong authentication and role-based access control.
- A documented API.
- Local-network operation.
- Optional internet connectivity and cloud synchronization.
- Audit logs and recoverable backups.

A reasonable default is a TypeScript backend using Fastify or NestJS with PostgreSQL. Select one, explain the decision briefly in the architecture documentation, and implement it consistently.

The backend must remain separate from the mobile UI.

Do not place privileged database credentials, signing secrets, administrative credentials, or unrestricted database access in the mobile application.

## Development quality
- Strict TypeScript.
- Clear module boundaries.
- Schema validation at API boundaries.
- Database migrations.
- Automated tests for critical business rules.
- Environment-based configuration.
- No secrets committed to version control.
- Reproducible setup instructions.

Do not introduce unnecessary dependencies or an elaborate architecture without a clear operational benefit.

# 4. DESIGN DIRECTION — RWANDAN IMIGONGO

The design must be distinctly Kiza, with a contemporary Rwandan identity.

Use **Imigongo-inspired geometric patterns** as a source of visual inspiration: repeated diamonds, triangles, interlocking forms, stepped lines, and rhythmic geometric arrangements.

Create original decorative patterns rather than copying existing artwork without permission.

## Visual identity

Build a cohesive design system around:
- Warm ivory and off-white surfaces.
- Deep charcoal and restrained black.
- Earthy brown tones.
- Carefully selected terracotta accents.
- A restrained green for successful meal verification.
- Red for rejection or invalid entitlements.
- Amber for warnings and pending actions.

Use sufficient contrast and ensure color is never the only way to communicate a status.

The result should feel premium, distinctly Rwandan, contemporary, and appropriate for a serious operational system.

Do not make the interface look like a tourism brochure, an old-fashioned government portal, or a generic AI-generated dashboard.

## Imigongo implementation

Create reusable decorative elements that can appear in:
- The welcome screen.
- Login and onboarding screens.
- Section headers.
- Empty states.
- Loading screens.
- Small card backgrounds and subtle visual accents.

Use SVG, vector shapes, or other appropriate scalable techniques. Patterns must remain lightweight and must not interfere with text legibility.

Avoid excessive decoration on the scanning interface. Buffet staff need speed and clarity above everything else.

## Motion design

Use purposeful motion, not animation for its own sake.

Examples:
- Subtle geometric transitions during onboarding.
- A smooth camera-scan feedback animation.
- A clear success transition when a meal is accepted.
- A brief, restrained rejection animation for invalid or duplicate claims.
- Subtle navigation and card transitions.
- Respect for reduced-motion accessibility preferences where supported.

Motion must never delay meal verification or interfere with repeated scanning.

# 5. USER ROLES AND PERMISSIONS

Implement proper authorization for the following roles.

## Student
Can:
- View their profile.
- View active and historical meal packages.
- View remaining meal entitlements.
- Display a QR meal pass.
- View payment and package status.
- View their recent meal history.
- View confirmation when a meal claim has been accepted.
- Access help and relevant account settings.

Students cannot:
- Approve their own meals.
- Edit authoritative package balances.
- Change their payment status.
- Create arbitrary QR credentials.
- Access another student's private account information.

## Buffet staff
Can:
- Sign in to an authorized staff account.
- Select or be assigned a buffet location.
- Scan student QR codes.
- View the student's registered photograph and name where appropriate.
- See the entitlement decision and clear instructions.
- Record an approved claim through the authoritative service.
- View relevant operational history according to their permissions.

Staff must not be able to edit financial records or arbitrarily restore meal entitlements.

## Registration and payment staff
Can:
- Register students.
- Update permitted student details.
- Assign or renew meal packages.
- Record payment references and supporting details.
- Review payment reconciliation status.
- Resolve permitted exceptions through an auditable workflow.

## Manager / administrator
Can:
- View dashboards and reports.
- Manage staff accounts and permissions.
- Configure packages, prices, meal sessions, and operating rules.
- Review payments, claims, exceptions, and audit records.
- Approve authorized corrections.
- View activity across all three buffets.

Enforce permissions on the backend, not only by hiding mobile interface elements.

# 6. STUDENT EXPERIENCE

Design the following screens.

## A. Welcome and onboarding
- Kiza identity and Imigongo-inspired branding.
- Language selection where appropriate.
- Clear login and account activation flows.
- Accessible layouts for common Android screen sizes.

## B. Student home
Show:
- Student name and profile photograph.
- Current package and its status.
- Remaining eligible lunches and dinners.
- Package validity dates or remaining eligible days.
- Recent meal history.
- Payment status.
- A prominent action to display the meal QR code.

Do not calculate remaining entitlements solely from values stored on the student's phone. Display cached information as cached and authoritative information when it is available.

## C. Meal pass
Create a clean, high-contrast QR display that is easy for a phone camera to scan quickly.

The QR code must not simply encode a student ID, editable balance, or permanent unrestricted meal-approval token.

Design a secure credential flow in which:
- Credentials are issued through a trusted service.
- QR credentials are signed or otherwise cryptographically protected.
- Credentials have a defined validity period.
- The backend validates the credential and current entitlement.
- A copied or replayed QR cannot authorize a second meal claim for the same service session.
- Credentials can be revoked or rotated when necessary.

Prefer a short-lived dynamic QR when connectivity permits. Design a defensible offline alternative without pretending that a static screenshot is impossible to copy.

The QR display should communicate:
- Student identity in a privacy-conscious way.
- Credential or pass status.
- Clear scanning instructions.
- A visible expired or unavailable state when the pass cannot be used.

## D. Claim confirmation
After the meal claim has actually been accepted, show:
- The student's photograph and name.
- Meal type: lunch or dinner.
- Date and applicable meal session.
- Confirmation status.
- A clear success message in Kinyarwanda.

For example, use a natural message equivalent to “Your lunch has been confirmed. Enjoy your meal!”

Do not display a success confirmation before the authoritative service confirms the claim.

When the student has no internet, distinguish a confirmed result from a pending or unverified result.

## E. Package and meal history
Display package validity, remaining entitlement, past meal claims, and relevant payment status.

Do not reveal sensitive financial or identity information unnecessarily.

# 7. BUFFET SCANNER EXPERIENCE

This is the most operationally important feature.

Build a fast, camera-based scanning experience that runs on ordinary Android smartphones.

Each of the three buffets should have an independently authenticated scanning device.

## Scanner home
Display:
- Kiza branding.
- Assigned buffet name or number.
- Staff identity.
- Connection status.
- Current meal session.
- Camera preview and scanning guide.
- Clear instructions in Kinyarwanda.

## Successful scan
When the backend authorizes a claim, display:
- A large, unmistakable green success indicator.
- Student photograph.
- Student name.
- Meal type.
- Confirmation time.
- A short success message.
- A clear indication that the claim has been recorded.

Make the result visible at a glance. Use sound or haptic feedback where supported, with an option to disable it.

## Rejected scan
Clearly distinguish:
- Invalid QR credential.
- Expired credential.
- Student without an active package.
- Package not yet activated.
- No remaining entitlement for the requested session.
- Duplicate claim.
- Unrecognized student.
- Unavailable verification service.
- Pending payment or registration.
- Expired or revoked credential.

Give staff a short, actionable Kinyarwanda explanation.

A duplicate claim must never look like a successful claim.

## Repeated scanning
After a successful scan, return to the ready state quickly so the next student can be served.

Prevent the same QR from triggering multiple requests accidentally during a single camera detection. This camera-level protection is only a usability feature; the backend must independently prevent duplicate claims.

Do not force staff through unnecessary confirmation screens after every valid scan.

## Privacy
Only authorized staff should see student photographs and identifying information. Minimize personal information in logs and on screens visible to other students.

# 8. THE THREE-BUFFET ARCHITECTURE

Treat the three buffets as three independent scanning stations connected to a shared meal-verification authority.

The authoritative service must know:
- Which student is being checked.
- Which package is active.
- Which meal session is currently being served.
- Whether that student has the right to claim that meal.
- Whether the entitlement has already been used.
- Which buffet and staff member recorded the claim.
- Whether the claim is confirmed, pending, or rejected.

The system must not independently approve meals on each phone using stale copies of the same entitlement balance.

## Required duplicate protection

Implement atomic, transactional claim processing.

A claim should have a unique business identity based on the applicable student, entitlement, and meal session, with additional identifiers for traceability.

The database must enforce the necessary uniqueness constraints. Concurrent scans of the same student at different buffets must not result in two accepted claims.

Use idempotency keys or an equivalent reliable mechanism so retries do not create duplicate records.

A network timeout must not automatically be interpreted as a failed claim. The scanner must be able to safely determine the outcome of a claim whose response was lost.

Define meal-session boundaries explicitly. Lunch and dinner are separate entitlements, and different dates must not be conflated.

For example, a five-day package generally represents five eligible lunches and five eligible dinners, subject to the configured package rules.

A successful Monday lunch claim must not prevent the student's Monday dinner or Tuesday lunch from being claimed.

Handle time zones consistently using Rwanda local operating dates, while storing timestamps in a reliable canonical format.

# 9. OFFLINE-FIRST OPERATION

Offline support is a core requirement, not a decorative feature.

However, offline capability must be described precisely.

There are three different conditions:

1. **Internet unavailable, local Kiza network available:** the three scanning phones can continue operating through the shared local verification service.
2. **Internet available:** the local service can synchronize appropriate data with the cloud service and backups.
3. **Local verification service or shared network unavailable:** the system must enter a clearly defined degraded state and must not silently accept unverified claims.

Students should not need to connect to Kiza's Wi-Fi just to display their QR code. Their phone can generate or display an appropriately issued credential locally.

The staff scanning phones need connectivity to the shared local authority, at least for normal authoritative verification. The application should detect connection state and communicate it accurately.

## Offline requirements

Implement:
- Persistent local student and package data where appropriate.
- A defined synchronization strategy.
- A local claim journal and audit trail.
- Safe retry handling.
- Idempotent synchronization.
- Conflict detection.
- Clear pending and confirmed states.
- Protection against stale entitlements.
- Recovery after restarts and power interruptions.
- A documented procedure for complete local network failure.

Do not rely on each scanning phone's private SQLite database as the sole authority for meal claims.

Do not assume that storing a QR code locally provides secure offline verification.

If disconnected operation at each individual scanner is required, document the additional limitations and design trade-offs. You may propose a controlled manual exception procedure, but it must be authorized, recorded, and reconciled. Never silently represent an unverified claim as confirmed.

## Recommended approach

Evaluate a local-first architecture in which a central Kiza service is reachable over a private local network, even when the internet is down. Use a cloud component for remote management and backup where justified.

Choose and document the most reliable implementation for the available budget and deployment environment.

# 10. REGISTRATION, IGIFU PACKAGES, AND PAYMENTS

Build the business logic needed to support real Kiza operations.

## Student registration
Store the minimum information required for operations:
- Unique student identifier.
- Full name.
- Contact details when available.
- Student photograph where appropriate and with proper access controls.
- Institution, if relevant.
- Account and registration status.

Prevent accidental duplicate registrations and support an auditable correction process.

## Package configuration
Allow authorized managers to configure:
- Package name.
- Duration.
- Price.
- Eligible meal types.
- Activation date.
- Expiration rules.
- Applicable operating dates.
- Special exceptions or package conditions.

Do not hardcode all prices or package durations in the mobile interface.

## Payment records
Record:
- Student.
- Amount.
- Currency.
- Payment method.
- Transaction reference where available.
- Recorded time.
- Recording staff member.
- Reconciliation status.
- Associated package.
- Relevant audit history.

MoMo payments may initially be recorded and reconciled manually. Implement actual provider integration only when supported credentials and official integration access are available.

A screenshot or student statement must not be treated as conclusive proof of payment without an authorized verification procedure.

Distinguish between:
- Payment reported.
- Payment recorded.
- Payment verified.
- Payment reconciled.
- Package activated.

Do not activate a paid package merely because a client claims that a payment succeeded.

## Entitlement accounting
Use a well-defined model for meal entitlements. Decide whether each package creates explicit meal credits or derives entitlement from package dates and configured rules.

Document the model and ensure all changes are auditable.

Never allow a mobile client to modify the authoritative balance directly.

# 11. MANAGEMENT DASHBOARD

The system must provide a practical way for authorized management staff to oversee operations.

If a separate web dashboard is appropriate, build it as a responsive web application using a compatible TypeScript stack. Do not force complex management reporting into a small mobile screen.

Include:
- Active student and package counts.
- Packages sold and renewed.
- Recorded and reconciled payments.
- Lunches and dinners served.
- Meal counts by buffet.
- Remaining entitlement summaries.
- Duplicate and rejected claim reports.
- Pending exceptions.
- Staff activity.
- Exportable operational reports.
- Audit history.

Make it possible to compare activity between the three buffets and review daily, weekly, and monthly totals.

Separate actual financial figures from estimates. Do not label package sales as verified revenue until their payment status supports that claim.

# 12. SECURITY AND DATA PROTECTION

Implement appropriate protections for a system handling student identities, photographs, meal entitlements, and payment records.

Requirements include:
- Strong authentication.
- Role-based authorization.
- Secure token storage.
- Protected API communication.
- Appropriate credential expiration and revocation.
- Server-side input validation.
- Rate limiting where useful.
- Audit logs for important operations.
- Restricted access to photographs and payment details.
- Database backups and restoration tests.
- Secret management through environment configuration.
- Protection against replayed QR credentials.
- Protection against duplicate and concurrent claims.
- Secure device registration and revocation.
- Safe handling of lost or stolen scanning phones.

Do not include sensitive student information directly in QR payloads unless absolutely necessary.

Do not store passwords in plaintext.

Do not create fake payment confirmations or hardcoded administrator credentials for production.

Document data retention and account-deletion policies appropriate to Kiza's requirements and applicable Rwandan data-protection obligations.

# 13. PERFORMANCE AND USABILITY

The buffet workflow must be optimized for throughput.

Design the scanning interface to minimize unnecessary taps and delays.

Measure:
- QR recognition time.
- Verification response time.
- Database claim-write time.
- End-to-end time from scan to visible result.
- Error rate.
- Behavior during simultaneous scans at all three buffets.

Do not promise an arbitrary latency target without measuring it on realistic hardware and networks.

The interface should:
- Remain readable in bright environments.
- Support common Android screen sizes.
- Handle denied camera permissions gracefully.
- Recover from camera errors.
- Prevent accidental double submission.
- Give staff immediate feedback when the connection changes.
- Avoid blocking the scanner longer than necessary.

# 14. IMPLEMENTATION WORKFLOW

Work methodically and use the repository as the source of truth.

## Phase A — Inspect and plan
1. Inspect the current working directory and existing code.
2. Identify the current application structure, framework, dependencies, and available tests.
3. Preserve useful existing work.
4. Identify unresolved product and deployment assumptions.
5. Create `docs/ARCHITECTURE.md`.
6. Create `docs/DATA_MODEL.md`.
7. Create `docs/OFFLINE_STRATEGY.md`.
8. Create `docs/SECURITY.md`.
9. Create a concise implementation checklist.

Do not spend excessive time producing documentation before implementation. Make enough architectural decisions to begin building safely.

## Phase B — Foundation
1. Configure the Expo application and TypeScript.
2. Set up routing and the design system.
3. Create reusable Imigongo-inspired visual components.
4. Implement Kinyarwanda localization.
5. Establish the backend structure.
6. Set up PostgreSQL and migrations.
7. Implement authentication and role permissions.
8. Establish reliable local persistence.

## Phase C — Core meal operations
Implement in a sensible order:
1. Student registration.
2. Package configuration and assignment.
3. Student authentication and profile.
4. Student meal-pass screen.
5. Staff authentication and device assignment.
6. Camera-based QR scanning.
7. Server-side entitlement verification.
8. Atomic meal claims and duplicate protection.
9. Student photograph and staff confirmation screens.
10. Meal history.
11. Payment recording and reconciliation.
12. Manager reporting.

## Phase D — Offline and synchronization
Implement local-network verification, persistence, retry behavior, synchronization, conflict handling, recovery, and explicit degraded modes.

Do not mark offline support complete until it has been tested with the internet disconnected and all three scanners operating against the same local authority.

## Phase E — Quality assurance
Run the available:
- TypeScript checks.
- Linting.
- Unit tests.
- Integration tests.
- Database migration checks.
- Production builds where feasible.

Test at least:
- A valid first lunch claim.
- A duplicate lunch claim.
- A valid dinner claim after lunch.
- A claim on a subsequent eligible day.
- An expired package.
- An inactive package.
- An unverified payment.
- Two simultaneous scans at different buffets.
- A lost response followed by a retry.
- Internet loss while the local service remains available.
- Loss of the local verification service.
- Restart and recovery after an interrupted claim.

Fix implementation errors rather than merely reporting them.

## Phase F — Deployment and handover
Provide:
- A working source tree.
- Environment variable examples without secrets.
- Database migrations and seed scripts.
- Local development instructions.
- Android development/build instructions.
- Local-network deployment instructions.
- Backup and restoration instructions.
- Staff setup instructions.
- A test report.
- A list of known limitations and remaining tasks.

Do not claim the application has been deployed to Kiza unless deployment actually occurred.

# 15. ENGINEERING RULES

1. Build real functionality, not decorative placeholders.
2. Do not fabricate API responses or payment success.
3. Do not use client-side state as the authoritative source of meal entitlement.
4. Do not use a static QR as unrestricted proof of meal eligibility.
5. Do not permit three scanners to independently authorize the same entitlement.
6. Do not introduce cloud dependence into the core workflow without documenting the consequences.
7. Do not store secrets in the repository or mobile bundle.
8. Do not make up prices, student records, or payment transactions.
9. Use realistic, clearly identified test fixtures in development.
10. Keep the application easy for future developers to understand.
11. Prefer straightforward, maintainable solutions over unnecessary abstraction.
12. Never conceal a failing test or incomplete feature.
13. Make all operationally important assumptions explicit.
14. Ask for clarification only when a missing decision materially affects architecture, security, or business correctness. Otherwise choose a sensible, documented default and continue.

# 16. INITIAL DELIVERABLE

Start now.

First inspect the repository and determine what already exists. Then establish the architecture and immediately begin implementing the application.

The initial visible result should be a coherent, polished Kiza mobile app with:
- Imigongo-inspired branding.
- Natural Kinyarwanda interface text.
- Student and staff entry points.
- A student meal-pass screen.
- A functional camera-based scanning screen on a supported device.
- A clear scan-result interface.
- A documented backend and data model for the authoritative meal-claim workflow.

Continue implementing the underlying functionality after the initial screens are created. Do not stop when the UI looks finished.

At the end of each substantial implementation stage, report:
- What was implemented.
- Which files or modules changed.
- Which tests were run and their actual results.
- What remains incomplete.
- The next concrete engineering task.

**Definition of success:** Kiza staff can use ordinary phones to verify eligible students at three buffets, record each permitted lunch or dinner exactly once, and maintain reliable operational records even when the internet is unavailable, provided the shared local verification service remains operational.

Build for real restaurant staff and real students in Huye. Make it reliable, understandable, affordable to operate, and unmistakably Kiza.
