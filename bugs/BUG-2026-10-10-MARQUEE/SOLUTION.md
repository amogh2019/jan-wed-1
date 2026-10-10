---
id: "BUG-2026-10-10-MARQUEE"
chosen_solution: 1
date_resolved: 2026-10-10
---

# BUG-2026-10-10-MARQUEE: Solution

## Proposed Solutions

### Option 1 (Recommended): Observe title-container size

**Description**: Attach a `ResizeObserver` to `#app-title` and call `fitTitle()` whenever its rendered width changes. Keep the existing font-ready and resize triggers as fallbacks.

| Pros | Cons |
|------|------|
| Covers sign-in controls and other flex-layout changes, not just window resizing | Adds one small observer lifecycle to app boot |
| Keeps the current overflow formula and CSS animation semantics | Requires a fallback for environments without `ResizeObserver` |

### Option 2: Recalculate after authentication-driven header changes

**Description**: Call `fitTitle()` explicitly after `renderHeader()` toggles the refresh and account controls.

| Pros | Cons |
|------|------|
| Minimal implementation change | Couples measurement to the current set of controls and misses future layout changes |
| No observer support required | Additional header-width changes may reintroduce the bug |

## Resolution

**Chosen**: Option 1 — a `ResizeObserver` watches `#app-title` and recalculates the shift whenever the title viewport changes size, including the auth-driven flex layout change.

**Files Changed:**

| File | Change |
|------|--------|
| `app.js` | Observe the marquee container and recalculate its shift on size changes. |
| `tests/e2e.smoke.js` | Add a regression flow that signs in at a mobile viewport and verifies the shift covers the post-sign-in overflow. |
| `service-worker.js` | Bump shell cache version so deployed clients receive the updated JavaScript. |

**Pull Requests:**

| PR | Description | Status |
|----|-------------|--------|
| — | Not requested; local changes only. | Not created |

## Verification

- [x] Regression test written and fails before the fix.
- [x] Regression test passes with the fix.
- [x] All existing tests pass.
- [ ] Deployed and verified in environment.
- [x] Bug no longer reproducible in the browser regression test.

## Lessons Learned

- **What caused it**: The measured overflow became stale when the flex item changed size without a window resize.
- **How to prevent**: Observe the element whose dimensions drive animation endpoints, not only global viewport events.
- **What to monitor**: Browser test should compare the translation endpoint against the title's current measured overflow after header controls appear.

## Coding Standard Impact

- **Category**: State Management / Test Reliability.
- **Existing rule violated**: None identified; `docs/coding-standards.md` is not present.
- **New rule created**: Not indicated; use element-size observation for this specific responsive measurement.
- **Rule file**: Not applicable.
