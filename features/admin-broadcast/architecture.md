# Admin Broadcast — Architecture

## Current state

```text
[Admin browser]
  ├─ Event Control → updateEvent → itinerary row → OneSignal event push
  │                                      ├→ Notifications history
  │                                      └→ AuditLog
  ├─ Notices ← session → filtered Notifications history
  └─ WhatsApp helper → encoded event-specific message

[Apps Script] authenticates the Google ID token, checks Members role,
targets OneSignal through opaque member IDs, and stores data in Sheets.
```

The `Groups` catalog and member group assignments already drive event audiences. Empty event groups mean all current members. The shared Notices view filters stored notices to everyone or any matching member group and hides sender/push diagnostics from Atithis.

## Target state

```text
[Admin Broadcast tab]
  ├─ Title + body + zero-or-more active groups
  ├─ Broadcast ──────────────┐
  └─ Broadcast + WhatsApp ───┤
                             v
[Apps Script broadcastNotification]
  ├─ Authenticate token; re-check Admin role under lock
  ├─ Validate text and active audience labels
  ├─ Target opaque IDs for all members or union of selected groups
  ├─ Append Notifications entry regardless of OneSignal result
  └─ Append Event AuditLog entry using authenticated admin/server time
                             |
             ┌───────────────┴────────────────┐
             v                                v
 [Eligible devices / Notices]      [WhatsApp title + body]
                                    (group labels excluded)

[Admin tour] adds a read-only Broadcast step.
```

## Changes required

- Add a dedicated admin-only tab and composer to the single-page frontend.
- Add the `broadcastNotification` admin action and reusable push delivery logic.
- Reuse existing Notifications, AuditLog, group catalog, and opaque OneSignal IDs; no sheet schema change.
- Add backend and browser smoke tests, update operator documentation, and bump the service-worker cache version.

## Key decisions and risks

- No selected groups means all current members; multiple groups use any-match semantics.
- Server-side auth and group validation remain authoritative. A hidden tab is not an authorization control.
- OneSignal failure does not discard the announcement or suppress the WhatsApp handoff. Diagnostics remain admin-only.
- WhatsApp must open a temporary tab synchronously during the click to avoid popup blockers. Close it and show the API error if the server rejects the request.
- Messages are capped to what can be safely recorded by the existing Notifications schema (title: 200 characters, body: 500 characters).
- Existing event-push behavior must not regress if delivery code is factored into a shared helper.
