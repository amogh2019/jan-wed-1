# Admin Broadcast Tab Design

## Status

Approved for planning on 2026-10-10.

## Context

The app already supports event-specific Live announcements, OneSignal audience targeting by member group, a shared in-app Notifications history, WhatsApp sharing, server-side admin authorization, and AuditLog entries. Admins need a separate way to send a title/body announcement that is not tied to an event.

## Decision

Add a dedicated, admin-only **Broadcast** tab. This keeps general announcements distinct from ceremony management while preserving the existing Notices tab as the announcement history for all members. Add an Admin tour step for the new tab so the role-specific walkthrough continues to cover each admin screen.

The composer contains:

- A required notification title and body.
- A multi-select of active group labels. Selecting no groups means all current members; selecting multiple groups includes members belonging to any selected group.
- **Broadcast** and **Broadcast + WhatsApp** actions.

Both actions send the same title and body through the backend. The WhatsApp message uses a bold title followed by the body and does not include audience/group details, leaving WhatsApp recipients to be chosen by the admin.

## Backend and data flow

The frontend posts a new broadcast action with the title, body, selected groups, and current request metadata. The Apps Script independently authenticates the Google ID token, verifies the caller is an Admin, validates the title/body and active group labels, and sends the OneSignal notification using existing opaque member push identities. A blank group selection targets all current members; a selected group audience uses the app's existing any-matching-group behavior.

The backend records the announcement in the existing Notifications sheet, including its audience and delivery status, so eligible members see it in Notices even if OneSignal delivery fails. Push diagnostics remain visible to admins only. The action also writes an AuditLog entry with the authenticated admin, server timestamp, audience, and message context. The client-supplied role, email, and timestamp are never trusted for authorization or audit identity.

For **Broadcast + WhatsApp**, the click handler opens a blank tab synchronously to preserve browser user activation. Once the backend accepts and logs the request, the tab navigates to the URL-encoded title/body message. It navigates even when OneSignal reports a delivery failure; if the backend rejects the request, the client closes the blank tab and presents the error.

## Alternatives considered

1. **Dedicated admin-only tab (selected):** clearly separates general notices from event operations and keeps the feature easy to find.
2. **Composer within Event Control:** fewer navigation items, but mixes event-specific and general broadcast workflows.
3. **Composer within Notices:** keeps composing close to history, but conflates a shared member-facing inbox with an admin action.

## Validation and error handling

- Require a non-empty title and body; enforce documented server-side length limits.
- Accept only active group labels from the server-side catalog.
- Preserve the existing behavior in which notification history is recorded and push failure details are not exposed to guests.
- Surface request/validation errors in the admin UI; do not navigate the prepared WhatsApp tab for a rejected server request.
- Keep the new tab hidden from Atithis and verify admin authorization in Apps Script regardless of client UI state.

## Tests and documentation

Add backend tests for admin-only access, required/length-limited content, active-group validation, all-member and group targeting, notification history, audit identity/timestamp, and push failure recording. Add E2E coverage for the admin-only tab, multi-group/all-member selection, WhatsApp message construction (without group details), popup behavior, request failures, and the Admin tour step. Update the Developer Guide API/audience/audit/tour sections and changelog, and bump the service-worker cache version for frontend shell changes.
