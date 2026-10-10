# Predefined Group Labels Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use engineering-lifecycle:implementing-with-tdd to implement this plan task-by-task.

**Goal:** Manage audience labels in a workbook `Groups` tab and replace free-text group assignment inputs with validated multi-select controls.

**Architecture:** `Groups` is the canonical registry (`Label`, `Status`), while existing comma-separated `Members.Groups` and `Itinerary.Group` cells remain the assignment store. Apps Script enforces active-label assignments, preserves already-attached archived labels unless explicitly removed, and returns the catalog to admin sessions. The Members & Access page manages labels and offers checkbox-based multi-selects for all member/event assignment flows.

**Tech Stack:** Google Apps Script, Google Sheets, vanilla JavaScript, Tailwind CSS, Node test harness, Playwright smoke tests.

---

## Task 1: Add the Groups registry and audited label actions

**Files:**
- Modify: `tests/gas-harness.js` — add a `Groups` fake sheet and support explicit sheet overrides.
- Modify: `tests/backend.test.js` — add registry/setup/action tests.
- Modify: `backend/Code.gs` — sheet/header constants, registry helpers, admin actions, `setup()`, and admin session payload.

**Step 1: Write failing setup and lifecycle tests**

In `tests/backend.test.js`, add tests that:

- An empty workbook setup creates `Groups` with `['Label', 'Status']`.
- Setup seeds existing comma-separated member/event labels as active, case-insensitively deduplicates them, and preserves the assignment cells.
- A second setup changes neither rows nor audit count.
- `addGroup` trims/collapses whitespace, adds an active label, and audits it; a case-insensitive duplicate and an invalid label are rejected.
- `archiveGroup` changes only the status, keeps assignments intact, and audits the operation.
- Atithi users cannot add or archive labels.
- Admin session data exposes the registry with status.

**Step 2: Run backend tests to confirm the new cases fail**

Run: `npm test`  
Expected: FAIL because the registry sheet, setup seeding, session field, and actions do not exist yet.

**Step 3: Implement registry setup and actions**

In `backend/Code.gs`:

- Add `SHEETS.GROUPS` and `HEADERS.Groups = ['Label', 'Status']`; let the existing safe `setup()` create headers.
- Add registry readers/lookups keyed case-insensitively, with deterministic display-name ordering.
- Seed labels found in `Members.Groups` and `Itinerary.Group` into missing registry rows as `Active`; never rewrite existing assignment cells or existing registry rows.
- Add admin-only `addGroup` and `archiveGroup` actions under the existing script lock. Validate label length/characters, reject case-insensitive duplicates, and call `writeAudit_` for actual mutations.
- Return group catalog entries from admin sessions.

**Step 4: Run backend tests**

Run: `npm test`  
Expected: all backend and config-sync tests pass, including the new setup/idempotency and audit cases.

## Task 2: Enforce registry rules on member and ceremony assignments

**Files:**
- Modify: `tests/backend.test.js` — exercise all assignment entry points and archive cases.
- Modify: `backend/Code.gs` — shared active/archived assignment validator and action integrations.

**Step 1: Write failing assignment-validation tests**

Add tests proving:

- `addMember` and `addEvent` reject unknown or archived labels.
- `updateMemberGroups` and `updateEventGroup` reject unknown labels.
- Existing archived assignments may remain unchanged or be removed, but cannot be added to another member/event.
- Labels are matched case-insensitively and persisted using registry spelling.
- Blank event groups retain the current “everyone” behavior.
- Group audience filtering and push target the union of current members matching any selected active/archived assigned label.
- Every changed assignment remains audited; unchanged assignments are not audited.

**Step 2: Run backend tests to confirm the cases fail**

Run: `npm test`  
Expected: the new tests fail because assignment actions currently accept any syntactically valid label.

**Step 3: Implement server-side assignment validation**

In `backend/Code.gs`, add one helper that validates requested labels against the Groups registry:

- New member/event assignments may contain active labels only.
- Update actions may retain an archived label only if it is already assigned to that same record; omitting it removes the archived assignment.
- Resolve case-insensitive input to the canonical label spelling before serializing to the existing comma-separated cell.
- Reject stale submissions if a label was archived after the admin loaded the form and was not already attached.

Apply it to `addMember`, `updateMemberGroups`, `addEvent`, and `updateEventGroup`. Keep authorization, lock behavior, safe-cell writes, and existing `inGroups_`/OneSignal matching semantics unchanged.

**Step 4: Run backend tests**

Run: `npm test`  
Expected: all tests pass; arbitrary free-form labels can no longer become audiences.

## Task 3: Build group management and multi-select assignment UI

**Files:**
- Modify: `tests/e2e.smoke.js` — extend the mocked workbook/backend and add UI behavior tests.
- Modify: `app.js` — group catalog state, reusable selector, Members & Access management section, assignment forms, and actions.

**Step 1: Add failing browser tests and mock support**

Extend `makeBackend()` in `tests/e2e.smoke.js` with an in-memory group registry and handlers for `addGroup` and `archiveGroup`. Add assertions that:

- The Members & Access page can create a label and shows its Active status.
- A duplicate label is rejected by the server and reported to the admin.
- Member and ceremony create/edit controls select multiple labels from the catalog without accepting arbitrary text.
- The selected labels are saved as comma-separated values in the existing mock `Members.Groups` and `Itinerary.Group` cells.
- Archiving does not clear assignments, excludes the label from new selections, and displays the existing archived selection so it can be removed.
- Blank event selection still means everyone.

**Step 2: Run E2E tests to confirm the new assertions fail**

Run: `npm run test:e2e`  
Expected: FAIL because the registry and multi-select UI are not implemented.

**Step 3: Implement the reusable accessible selector**

In `app.js`:

- Add catalog state to `Store` and load it from the admin session.
- Render a mobile-friendly checkbox dropdown with selected-label summary, visible focus states, keyboard-operable native controls, and 44px minimum touch targets.
- Render active labels as assignable; render a selected archived label as marked archived and removable, but do not offer it as a new selection.
- Collect checked values as arrays rather than comma-separated free text. Keep serialization to comma-separated text at the API/sheet boundary only.

**Step 4: Wire all assignment and management flows**

In `Views.members`, add the label create/archive section and use the selector for new members and existing member assignments. In `Views.control` and `Actions.openAddEvent`, use it for ceremony audiences. Update delegated event handlers and actions to submit selected arrays and refresh member/event/catalog state from successful responses. Preserve blank ceremony selection as everyone.

**Step 5: Run E2E tests**

Run: `npm run test:e2e`  
Expected: the new group-management and selection scenarios pass along with the existing smoke flows.

## Task 4: Document setup and verify the complete feature

**Files:**
- Modify: `README.md` — summarize label setup and assignment behavior.
- Modify: `docs/DEVELOPER_GUIDE.md` — document Groups schema, setup, API actions, archive semantics, and targeting behavior; add a changelog entry.
- Modify: `service-worker.js` — bump `CACHE_VERSION` for frontend shell changes.
- Regenerate if needed: `styles.css` from `src/styles.css` using the existing Tailwind command.

**Step 1: Update user and developer documentation**

Document that:

- `setup()` creates the `Groups` tab and seeds any labels already assigned.
- Admins create/archive labels from Members & Access.
- Member/event assignments are multi-selects; existing sheet assignments stay comma-separated.
- Archived labels preserve current audiences and cannot be newly assigned.
- Blank event audiences still target everyone; multiple labels use any-match filtering and union push recipients.

**Step 2: Bump the shell cache and rebuild generated CSS if necessary**

Increment `CACHE_VERSION` in `service-worker.js`. If new Tailwind classes were added, run:

```bash
npm run build:css
```

Expected: the generated `styles.css` includes the selector styles.

**Step 3: Run final checks**

Run:

```bash
npm test
npm run test:e2e
git diff --check
```

Expected: all tests pass and the diff has no whitespace errors. Do not push or commit unless separately requested.
