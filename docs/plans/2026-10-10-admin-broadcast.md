# Admin Broadcast Tab Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use engineering-lifecycle:implementing-with-tdd to implement this plan task-by-task.

**Goal:** Add an admin-only Broadcast tab for sending standalone OneSignal announcements to all current members or selected groups, with an optional WhatsApp handoff.

**Architecture:** Add a server-authorized `broadcastNotification` Apps Script action that validates the message and active audience labels, targets existing opaque OneSignal member IDs, records the announcement in the existing Notifications sheet, and audits the action. Add an admin-only composer and an Admin tour step to the static frontend; the WhatsApp variant opens a temporary tab synchronously and navigates it only after the backend accepts the request.

**Tech Stack:** Vanilla JavaScript, HTML/Tailwind, Google Apps Script, Google Sheets, OneSignal REST API, Node.js `node:test`, Playwright smoke tests.

---

### Task 1: Specify broadcast backend behavior with failing tests

**Files:**
- Modify: `tests/backend.test.js`

**Step 1: Add an admin broadcast success test**

Call `createBackend().call(ADMIN, 'broadcastNotification', { title: 'Schedule update', body: 'Meet at the east gate.', groups: ['Bride side'] })`. Assert the result succeeds, the OneSignal request contains that exact heading/body and only the opaque push IDs of matching members, the Notifications sheet contains the message and selected groups, and the AuditLog records the authenticated admin and broadcast audience.

**Step 2: Add all-member and multi-group targeting tests**

Use fixtures with members assigned to different groups. Assert an empty `groups` array targets every current member, and multiple selected groups target members in any selected group without duplicating an identity.

**Step 3: Add rejection and delivery-failure tests**

Assert an Atithi call returns `FORBIDDEN` and writes the existing denied-admin security audit. Assert missing/blank/oversized title or body and an unknown/archived group return `BAD_REQUEST` without sending a push. Configure the mocked OneSignal request to fail; assert the broadcast remains in notification history and the audit identifies delivery failure.

**Step 4: Run the backend tests and verify the new cases fail**

Run: `npm test`

Expected: the new tests fail because `broadcastNotification` is not implemented; existing tests continue to pass.

### Task 2: Implement the Apps Script broadcast action

**Files:**
- Modify: `backend/Code.gs`
- Test: `tests/backend.test.js`

**Step 1: Add the action under `ACTIONS_`**

Implement `broadcastNotification(payload, user, req)` as an admin mutation. Validate title and body as required strings using existing helpers and enforce a body limit compatible with the Notifications schema (`Message` is stored up to 500 characters). Resolve selected labels through the active group catalog; an empty array means everyone. Authorization remains in `doPost`/`resolveAction_`, and the action uses `user.email` rather than client identity fields.

**Step 2: Reuse the existing OneSignal delivery path**

Factor only the shared REST request/recipient-targeting behavior needed from `sendLivePush_` into a helper accepting an explicit `{ title, body }` and groups. Preserve existing Live-event notification content, event URL routing to `?open=notifications`, opaque `groupPushIds_` targeting, the recipient cap, and useful admin-only failure diagnostics. Keep the existing `event-live` topic for event pushes and omit a fixed web-push topic for independent broadcasts so later announcements do not collapse earlier notifications.

**Step 3: Record history and audit on delivery success or failure**

Log the composed title/body, selected groups, sender, and delivery status through `logNotification_` even when OneSignal reports an error. Use the existing Event audit category and server-authenticated email/time; include message context and the selected audience, but not recipient email lists. Return delivery status so the admin can distinguish sent from failed.

**Step 4: Run backend tests and verify the new cases pass**

Run: `npm test`

Expected: all backend and config-sync tests pass, including recipient filtering, input validation, history, audit, and push failure assertions. Existing event push tests remain unchanged and pass.

### Task 3: Specify the admin composer and WhatsApp flow with E2E tests

**Files:**
- Modify: `tests/e2e.smoke.js`

**Step 1: Extend the mocked backend**

Add `broadcastNotification` handling to `makeBackend()`. Capture submitted title/body/groups and the request timestamp/admin identity; append a group-labeled notification; return success with either successful or failed push status based on a controllable fixture flag. Continue to model role-based authorization.

**Step 2: Add admin-only tab and all-member/group broadcast tests**

Assert an admin sees and can open Broadcast, while an Atithi does not see the tab. Verify the Admin tour visits the Broadcast tab and the Atithi tour does not. Submit one broadcast with no selected group and another with multiple groups; assert the mocked requests contain the exact form data and that the sent announcements are shown only to matching audience members in Notices.

**Step 3: Add WhatsApp and failure-path tests**

Stub `window.open` in-page to record the synchronous blank-window open and resulting URL. Assert the WhatsApp text contains the title and body, excludes group labels, and is URL-encoded. Assert OneSignal delivery failure still navigates the WhatsApp tab, while a rejected backend request closes the temporary tab and shows an error without claiming the broadcast succeeded.

**Step 4: Run E2E tests and verify the new cases fail**

Run: `npm run test:e2e`

Expected: new Broadcast UI assertions fail because the tab and composer do not exist yet; existing smoke tests pass.

### Task 4: Add the admin-only Broadcast interface and client actions

**Files:**
- Modify: `index.html`
- Modify: `app.js`
- Test: `tests/e2e.smoke.js`

**Step 1: Add the admin navigation item**

Add a stable `data-tab="broadcast"` nav button with the `admin-only hidden` classes and an accessible label. Preserve the existing navigation pattern and touch target sizing.

**Step 2: Add the Broadcast view**

Implement `Views.broadcast` with required title/body controls and a multi-select using the active `groupCatalog`. Explain that no group selection means everyone and multiple groups include members of any selected group. Add separate Broadcast and Broadcast + WhatsApp buttons with stable `data-action` selectors, accessible pending indicators, and error/status feedback consistent with existing admin mutations.

**Step 3: Wire form submission**

Add delegated handlers that read and validate the current form values, send `Api.post('broadcastNotification', { title, body, groups })`, and update the view/history after the backend confirms the result. Escape any rendered dynamic values and do not display OneSignal diagnostics in the member-facing Notices view.

**Step 4: Wire the WhatsApp variant**

On the actual button click, call `window.open('about:blank', '_blank', 'noopener,noreferrer')` synchronously before awaiting the API request. After the server accepts/logs the broadcast, navigate the handle to `WhatsApp.buildUrl('*' + title + '*\n\n' + body)`; do this even when `push.ok` is false. If the API rejects the request, close the handle and surface the normal error. Do not include group labels in the WhatsApp message.

**Step 5: Add the Broadcast step to the Admin tour**

In the existing Admin tour step list, add a step that switches to `broadcast`, targets the Broadcast overview/form, and briefly explains group targeting and WhatsApp sharing. Preserve the Atithi tour sequence and verify the Admin tour advances through Broadcast without submitting the form.

**Step 6: Run E2E tests and verify the new cases pass**

Run: `npm run test:e2e`

Expected: admin visibility, form submission, audience data, WhatsApp text/encoding, popup flow, tour navigation, and error-state tests pass.

### Task 5: Update operational documentation and cache version

**Files:**
- Modify: `docs/DEVELOPER_GUIDE.md`
- Modify: `README.md`
- Modify: `service-worker.js`

**Step 1: Document the new API action**

Add `broadcastNotification` to the backend API table with its admin-only access, title/body/groups payload, validation, audience targeting, notification history, and audit behavior.

**Step 2: Document the admin workflow and deployment**

Update the feature overview and changelog to describe the Broadcast tab and Admin tour step, blank-means-everyone behavior, multi-group matching, WhatsApp content (no audience labels), and the requirement to publish updated Apps Script for backend changes.

**Step 3: Bump the shell cache**

Increment the existing `CACHE_VERSION` in `service-worker.js` by one because `index.html` and `app.js` change. Do not add assets unless the implementation introduces one.

### Task 6: Run final quality gates and review the change

**Files:**
- Review: `backend/Code.gs`, `app.js`, `index.html`, `tests/backend.test.js`, `tests/e2e.smoke.js`, `docs/DEVELOPER_GUIDE.md`, `README.md`, `service-worker.js`

**Step 1: Run the project test suites**

Run: `npm test && npm run test:e2e`

Expected: both commands pass.

**Step 2: Check patch whitespace and review the diff**

Run: `git diff --check && git diff --stat && git diff`

Expected: no whitespace errors; only the broadcast implementation, its tests, documentation, and cache version are changed. Keep all changes local and uncommitted as requested; do not push.
