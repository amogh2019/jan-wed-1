# Phase 1: Standalone Admin Broadcast

**Goal:** Deliver an admin-only composer that sends standalone targeted push announcements, records shared history and audit data, and optionally prepares the message in WhatsApp.

**Scope:** Backend action and OneSignal delivery; admin Broadcast tab and tour step; existing Notifications/AuditLog storage; backend and E2E tests; project docs and service-worker cache.

**Dependencies:** Existing Google ID token authentication, Members role/group data, active group catalog, opaque OneSignal member IDs, notification history, and WhatsApp URL helper.

## Tasks

1. Add backend tests for admin authorization, validation, audience matching, message/history logging, audit identity, push failures, and unchanged event push behavior.
2. Implement `broadcastNotification` and shared OneSignal delivery support.
3. Extend the E2E backend mock and add tests for role visibility, all/group sends, WhatsApp handoff, error cleanup, and tour navigation.
4. Add the admin-only navigation item, composer, client action handlers, WhatsApp click flow, and Admin tour step.
5. Update README and Developer Guide; increment `CACHE_VERSION`.
6. Run `npm test`, `npm run test:e2e`, and `git diff --check`; review changes.

## Files

- Backend: `backend/Code.gs`
- UI/navigation/tour: `index.html`, `app.js`
- Tests: `tests/backend.test.js`, `tests/e2e.smoke.js`
- Docs/cache: `README.md`, `docs/DEVELOPER_GUIDE.md`, `service-worker.js`

**Status:** Ready for TDD implementation.  
**Delivery constraint:** Keep changes on the current branch, uncommitted, and do not push.
