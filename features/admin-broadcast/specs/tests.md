# Admin Broadcast — Test Specification

Implementation plan: `docs/plans/2026-10-10-admin-broadcast.md`  
Approved design: `docs/plans/2026-10-10-admin-broadcast-tab-design.md`

## Backend unit/integration tests

Source: `tests/backend.test.js`, using the fake Apps Script environment in `tests/gas-harness.js`.

| Test case | Expected | Priority |
|---|---|---|
| Admin broadcasts a title/body to a selected group | OneSignal payload contains exact content and only opaque IDs for matching current members; history and audit record the selected audience | P0 |
| Admin broadcasts with multiple groups | Target is the union of members matching any selected group, with no duplicate IDs | P0 |
| Admin broadcasts with no groups | All current member IDs are targeted | P0 |
| Atithi attempts the action | `FORBIDDEN`, no notification or push; denied action is security-audited | P0 |
| Title/body are missing, blank, wrongly typed, or oversized | `BAD_REQUEST`; no push/history mutation | P0 |
| Group is unknown or archived | `BAD_REQUEST`; no push/history mutation | P0 |
| OneSignal rejects or is unconfigured | Announcement is retained with failure status, admin response contains delivery failure, and audit captures outcome | P0 |
| Caller forges client email/timestamp | Token-derived identity and server time remain authoritative; email mismatch is rejected | P0 |
| Guest reads announcement session | Only everyone/matching-group announcement is returned; sender and push diagnostics are omitted | P0 |
| Existing event Live push still works | Existing event title/body, audience targeting, deep link, Notifications entry, and AuditLog behavior are unchanged | P0 |

## End-to-end tests

Source: `tests/e2e.smoke.js`, using the mocked Apps Script backend.

| Scenario | Steps | Expected | Priority |
|---|---|---|---|
| Admin-only Broadcast tab | Sign in as Admin and Atithi | Admin sees and opens Broadcast; Atithi cannot see its nav control | P0 |
| Admin broadcasts to everyone | Enter title/body, select no groups, click Broadcast | Mock receives exact content and empty audience; success feedback appears; stored notice is available to all members | P0 |
| Admin broadcasts to selected groups | Select multiple groups and broadcast | Mock receives selected values; only members matching at least one group see the notice | P0 |
| Broadcast + WhatsApp happy path | Click combined action | A temporary tab is opened synchronously; after server acceptance it receives the encoded bold-title/body WhatsApp URL without group labels | P0 |
| Push delivery failure with WhatsApp | Configure mocked push failure and click combined action | Failure is reported to Admin and WhatsApp still opens with the composed message | P0 |
| Backend rejects combined action | Configure action rejection and click combined action | Temporary tab closes, error is shown, and no success is claimed | P0 |
| Role-specific Admin tour includes Broadcast | Advance the Admin tour | It switches to and highlights Broadcast without submitting or mutating the form | P0 |
| Atithi tour remains unchanged | Advance the Atithi tour | Broadcast does not appear in its steps | P1 |

## Acceptance criteria coverage

| Acceptance criterion | Test cases |
|---|---|
| Standalone broadcast can be composed by Admins only | Admin-only Broadcast tab; Atithi attempts the action |
| Empty and multi-group targeting match existing audience semantics | All-member, multiple-group, and guest filtering tests |
| Server validates content and group labels | Required/length and unknown/archived group tests |
| Every accepted broadcast is recorded and audited even when push delivery fails | Admin success and OneSignal failure backend tests |
| WhatsApp gets only the title/body and opens despite a push delivery failure | WhatsApp happy path and push delivery failure E2E tests |
| Rejected server requests do not leave a blank tab or imply success | Backend rejection E2E test |
| The role-specific tour explains the new Admin tab without submitting | Admin and Atithi tour tests |
| Existing event behavior and guest privacy remain intact | Existing event push regression and guest projection tests |

## Fixtures

| Fixture | Purpose |
|---|---|
| Admin, Atithi, and members assigned to overlapping groups | Verify authorization and union targeting |
| Active and archived group catalog labels | Verify catalog validation |
| Fake OneSignal success/failure responses | Verify sent/failed diagnostics and history persistence |
| E2E backend with action success/failure switches | Verify form state and popup cleanup |
