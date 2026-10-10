# Role-Specific Tour and Action Loading Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use engineering-lifecycle:implementing-with-tdd to implement this plan task-by-task.

**Goal:** Give Admins and Atithis a guided, role-specific walkthrough across their real app tabs, and show per-control loading feedback during user-triggered backend requests.

**Architecture:** Extend the existing `Tour` in `app.js` with tab-aware steps and stable `data-tour` anchors; navigate/render the step's tab before scrolling and positioning the existing spotlight. Use `Store.pending` and `Actions.run` for request state, render button spinners or adjacent status indicators for non-button triggers, and make tour completion wait for the backend response. Keep backend contracts and sheet schema unchanged.

**Tech Stack:** Vanilla JavaScript, Tailwind CSS source/build, Google Apps Script API, Node test runner, Playwright E2E smoke harness.

---

### Task 1: Specify the Atithi and Admin walkthroughs in E2E tests

**Files:**
- Modify: `tests/e2e.smoke.js`

**Step 1: Add role-tour assertions before changing production code**

Extend the existing pending Atithi tour test to assert that the step sequence visits Schedule, Notifications and My travel; verify the target is visible at each step, that Back returns to the prior tab, and that the tour does not activate page controls. Add a separate pending-Admin fixture/page and assert that it visits Schedule, Notifications, Event Control, Pick & Drop, and Members & Access, with no Atithi-only My travel step.

Use the visible bottom-nav button's `aria-current="page"` to assert the active tab; use a stable selector under `#tour-root` to inspect the current target/step. Set the Admin fixture's `tourStatus` to `Pending` without changing the shared Admin used by existing smoke checks.

**Step 2: Run the smoke test and confirm the new assertions fail**

Run: `npm run test:e2e`

Expected: FAIL because the current tour only highlights a subset of Schedule and navigation controls and never changes tabs.

**Step 3: Include empty-state/fallback coverage**

Add a guest fixture without a linked travel row and an Admin fixture with no ceremonies/logistics where useful. Assert that the relevant tab is still explained through its stable heading or empty state, and the spotlight has a visible target or intentionally shows the centered intro card.

**Step 4: Re-run the focused smoke test**

Run: `npm run test:e2e`

Expected: It still fails only on the not-yet-implemented tab journey; fixture setup and selectors should be valid.

### Task 2: Implement role-specific tab-aware tour steps

**Files:**
- Modify: `app.js` (`Tour.buildSteps`, `Tour.go`, `Tour.position`, and view markup anchors)
- Test: `tests/e2e.smoke.js`

**Step 1: Add stable targets to the actual screens**

Add `data-tour` anchors for Schedule overview/day navigation; Notifications overview/clear affordance; My travel content or no-plan greeting; Event Control add/audience/broadcast guidance; Pick & Drop mode/add/status controls; Members & Access invite/role/group-label controls; and the notification opt-in banner. Do not put anchors on destructive controls when a nearby explanatory container is available.

**Step 2: Define the role-specific step lists**

Build a shared sequence plus Admin-only and Atithi-only steps. Each targeted step carries the tab key and stable target selector. Keep the notification-permission step conditional: when the banner is already hidden, show the instructional card without a spotlight and never click/request permission.

**Step 3: Resolve target availability without dropping whole tab sections**

For data-dependent content, use a stable section heading or empty-state target when there are no rows. Include only tabs the current role can access. Keep the Atithi route to Schedule, Notifications and My travel; keep the Admin route to Schedule, Notifications, Event Control, Pick & Drop and Members & Access.

**Step 4: Switch tabs before positioning each step**

Update `Tour.go` so it sets the step tab, lets the normal render complete, then scrolls the target into view and positions the existing overlay. Back/Next must work across tabs. Keep reduced-motion behavior and avoid clicking any target or submitting any form.

**Step 5: Run E2E and adjust selectors/positioning**

Run: `npm run test:e2e`

Expected: Both roles navigate the expected tabs, show a visible spotlight/card on every step, and leave event/member/travel state unchanged.

### Task 3: Preserve tour completion semantics and add response-bound loading

**Files:**
- Modify: `app.js` (`Tour.finish`, `Tour.cancel`, tour controls)
- Modify: `tests/e2e.smoke.js`

**Step 1: Add failing finish/skip/replay assertions**

Test that finish records `Completed`, Skip/Escape records `Skipped`, sign-out cancels without submitting, replay uses the current role without another completion request, and a pending save visibly disables the tour control.

**Step 2: Replace fire-and-forget completion with an awaited request**

Use the existing request/pending path for `completeTour`; show a spinner and disabled state in the clicked Finish/Skip control until the response settles. Only close the tour and write the client-side completion marker after a successful response. On failure, use the existing error toast, restore the control, and allow retry instead of swallowing the error.

**Step 3: Keep replay and cancellation separate**

Replay must close without changing stored `TourStatus`. Sign-out/identity-change cancellation must remove the overlay and listeners without calling `completeTour`. Keep backend first-outcome-wins semantics unchanged.

**Step 4: Verify completion paths**

Run: `npm run test:e2e`

Expected: Completion is recorded once, retry is possible after a simulated failure, Skip/Escape behavior remains compatible with `tests/backend.test.js`, and replay/cancel do not submit writes.

### Task 4: Show loading on every user-triggered backend mutation

**Files:**
- Modify: `app.js` (admin action buttons, selects, create/edit modals, `Actions.run`)
- Modify: `tests/e2e.smoke.js`

**Step 1: Add delayed-response tests for button actions**

Use the E2E backend's `delayMs` support. Trigger at least one form submission and one row mutation; assert the initiating button contains `.spinner`, is disabled while pending, prevents duplicate submission, then returns to its normal state and shows the existing success toast.

**Step 2: Add error-response tests**

Allow the mocked backend to fail one selected action. Assert its spinner clears, the existing error toast is visible, and form-entered values remain available for correction/retry.

**Step 3: Add tests for select-driven actions and quiet polling**

During delayed status and role updates, assert the select is disabled and an adjacent accessible `.spinner`/`role="status"` appears. Assert periodic/visibility refreshes do not render mutation spinners.

**Step 4: Wire current pending keys to initiating controls**

Use existing pending keys in `Actions.run` and add button-level `spinnerOr`/disabled states for any mutation controls that are currently missing them, including event delete/audience save, member role/group/remove, group archive, and modal submit. For select-triggered status/role changes, render an adjacent accessible progress indicator while the corresponding pending key is active. Keep the user’s form draft intact through render updates.

**Step 5: Verify action feedback across the browser suite**

Run: `npm run test:e2e`

Expected: Every user-triggered mutation shows loading only on its associated control until the API response, duplicate actions are blocked, existing success/error toasts remain, and background polling remains visually quiet.

### Task 5: Update guide copy, rebuild styles, and bump the shell cache

**Files:**
- Modify: `README.md`
- Modify: `docs/DEVELOPER_GUIDE.md`
- Modify: `service-worker.js`
- Modify: `src/styles.css` only if existing spinner/target styles need adjustment
- Generate: `styles.css` via the existing build script

**Step 1: Document the approved role paths and completion behavior**

Describe the tabs/capabilities shown to each role, the one-time per-member completion and current-role replay, and the fact that the tour guides without executing actions.

**Step 2: Document request loading behavior**

State that user-triggered actions show inline control-level feedback, explicit sign-in/refresh retain their current indicators, and periodic background refresh remains quiet.

**Step 3: Rebuild CSS if source styles/classes changed and bump cache**

Run: `npm run build:css`

Expected: Tailwind rebuild succeeds and `styles.css` reflects any new classes. Increment `CACHE_VERSION` in `service-worker.js` because `app.js` is a cached shell file.

### Task 6: Run full targeted checks and inspect the patch

**Files:**
- Verify: all modified files

**Step 1: Run backend and browser tests**

Run: `npm test && npm run test:e2e`

Expected: All backend tests pass and the E2E smoke suite reports `ALL PASSED`.

**Step 2: Check whitespace and changed-file scope**

Run: `git diff --check && git status --short`

Expected: No whitespace errors; only tour/loading UI, tests, styles/cache, and directly related docs are modified.

**Step 3: Review deployment requirements**

No Apps Script redeployment or sheet migration should be necessary because the current `completeTour` action is reused. GitHub Pages must receive the frontend files, rebuilt CSS if applicable, and bumped service-worker cache version before users see the new tour.
