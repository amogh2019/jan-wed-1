# Role-Specific Tour and Action Loading — Test Plan

Approved design: `docs/plans/2026-10-10-role-specific-tour-and-action-loading-design.md`  
Implementation plan: `docs/plans/2026-10-10-role-specific-tour-and-action-loading.md`

The feature changes only the frontend. The existing `completeTour` contract and
`Members.TourStatus` storage remain unchanged; backend tests should not need
updates unless implementation uncovers a contract defect.

## Test Categories

### 1. Unit and contract checks

Source: existing `tests/backend.test.js` and `tests/config-sync.test.js`.

| Test Case | Input | Expected | Priority |
|---|---|---|---|
| Existing one-time tour contract | `completeTour` with `Completed` or `Skipped` | Only the signed-in member is updated, and the first outcome wins | P0 |
| Existing cancellation contract | Sign out or change identity during a tour | No `completeTour` request is made for the abandoned identity | P0 |
| Existing action API contract | User-triggered admin mutation | `Actions.run` uses its action-specific pending key and preserves existing success/error toast behavior | P0 |

### 2. End-to-end tests

Source: `tests/e2e.smoke.js`; run with `npm run test:e2e`.

| Scenario | Steps | Expected | Priority |
|---|---|---|---|
| Atithi tour walks accessible tabs | Sign in as a Pending Atithi; advance through every step | Steps explain Schedule, Notifications, My travel, notification opt-in and profile/help; the proper tab becomes active before its target is spotlighted; no Admin tabs appear | P0 |
| Admin tour walks accessible tabs | Sign in as a Pending Admin using an isolated backend fixture; advance through every step | Steps explain Schedule, Notifications, Event Control, Pick & Drop, and Members & Access; no Atithi-only My travel step appears | P0 |
| Back and next cross tab boundaries | Advance into another tab, then go Back and Next | Active tab, step count, card, and spotlight target stay in sync | P0 |
| Sparse and empty screens remain tourable | Use fixtures with no travel rows, ceremonies, logistics, announcements, or group labels as applicable | Each tab still gets an explanatory stable target or centered card; no step silently disappears because its data row is absent; no-plan travel copy prompts RSVP/family contact | P1 |
| Notification prompt is never triggered by tour | Advance through notification guidance with OneSignal unsubscribed and already subscribed | Tour describes opt-in without requesting browser permission or changing subscription state; when the banner is hidden the guidance card has no spotlight target | P0 |
| Tour guidance never executes highlighted controls | Complete or skip both role paths | No event, group, member, logistics, notification, or pickup/drop mutation is introduced by tour navigation | P0 |
| Finish and skip save once | Finish one tour and skip another (including Escape) | `completeTour` receives `Completed` or `Skipped` once; stored first outcome and client marker prevent automatic replay after refresh | P0 |
| Completion request stays busy and recovers | Delay `completeTour`; then separately make it fail once and retry | Initiating Finish/Skip button displays a spinner and is disabled while pending; on failure the tour remains actionable, error toast appears, and retry can save the outcome | P0 |
| Replay uses current role without persistence | Start replay from profile after role data is current; finish replay | Current role's steps are used and no `completeTour` write is sent | P1 |
| Identity cancellation does not save | Sign out or change identity while a tour is open | Overlay/listeners close and no completion request or stale local completion marker is written | P0 |
| Button mutation shows accessible control-level progress | Delay a form submission and a row action such as Set Live or delete | Only the initiating button shows a spinner, disabled state, `aria-busy`, and a screen-reader action name; duplicate submission is prevented; success toast and updated UI remain intact | P0 |
| Button mutation error preserves draft | Fail a modal-backed mutation after entering values | Spinner clears, error toast appears, dialog remains open, and entered values remain available for retry | P0 |
| Select mutation shows adjacent progress | Delay event-status, pickup/drop, or member-role change | Initiating select is disabled and an adjacent accessible progress status is visible until completion | P0 |
| Other admin mutations show their own progress | Delay member/group/audience changes and modal submit | Feedback is attached to the initiating control; unrelated controls remain usable unless they share the same pending key | P1 |
| Background refresh remains quiet | Delay an automatic/visibility refresh while no user action is pending, then trigger explicit refresh | Automatic refresh does not show the global sync indicator or mutation spinners; explicit refresh keeps its loading indicator | P0 |

## Acceptance Criteria Coverage

| Acceptance Criterion | Test Case(s) | Status |
|---|---|---|
| Atithi and Admin see only their role-specific walkthrough and permitted tabs | Atithi tour walks accessible tabs; Admin tour walks accessible tabs | Covered |
| Tour navigation switches tabs and resolves stable targets, including sparse states | Back/next; sparse and empty screens remain tourable | Covered |
| Tour explains controls without performing their actions or triggering notification permission | Notification prompt is never triggered; tour guidance never executes highlighted controls | Covered |
| Existing completion, skip, replay, cancellation and first-outcome semantics remain intact | Finish/skip save once; replay; identity cancellation | Covered |
| Completion controls indicate pending state and recover after errors | Completion request stays busy and recovers | Covered |
| User-triggered backend mutations provide accessible per-control loading and keep response feedback | Button mutation, draft preservation, select mutation, other admin mutations | Covered |
| Background polling does not show loading UI, while explicit refresh remains visible | Background refresh remains quiet | Covered |

## Test Fixtures

| Fixture | Purpose | Used By |
|---|---|---|
| Pending Atithi with linked travel | Verify role path and populated My travel target | Atithi tour, back/next |
| Pending Atithi without linked travel | Verify no-plan fallback | Sparse and empty screens |
| Pending Admin with isolated backend state | Verify Admin path without changing shared smoke-test state | Admin tour |
| Empty-data backend variant | Verify Schedule, Notifications, Event Control, Pick & Drop, and group-label fallbacks | Sparse and empty screens |
| Delayed backend response | Keep a request pending long enough to inspect initiating-control state | Completion and mutation loading |
| One-shot action failure | Verify error toast, draft preservation, pending-state cleanup, and retry | Completion and button mutation error |
