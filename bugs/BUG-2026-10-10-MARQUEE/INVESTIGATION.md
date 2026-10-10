---
id: "BUG-2026-10-10-MARQUEE"
status: root-cause-found
severity: "medium"
reported: 2026-10-10
epic: "standalone"
---

# BUG-2026-10-10-MARQUEE: Header marquee stops before the title ends

## Status

| Field | Value |
|-------|-------|
| Status | root-cause-found |
| Severity | medium |
| Reported | 2026-10-10 |
| Resolved | — |
| Service(s) | PWA header layout and marquee animation |

## Symptoms

- **Expected behavior**: When the event name exceeds the available header width, the marquee travels far enough to reveal the final character before pausing and reversing.
- **Actual behavior**: The title moves left, pauses while its end is still clipped, then returns to its starting position.
- **Error messages**: None reported.
- **Frequency**: Reported during normal use; most likely after the signed-in header controls appear without a viewport resize.

## Reproduction Steps

1. Configure an event name long enough to overflow the header.
2. Load the app and let its initial title measurement run while the account and refresh controls are hidden.
3. Sign in, causing those controls to occupy header width without resizing the browser.
4. Observe the marquee stop before the end of the title is visible, then reverse.

## Architecture

```text
Header flex layout → #app-title width → fitTitle() overflow measurement
                   → --marquee-shift → marqueeGlide keyframes
```

| Component | Role | Relevant? |
|-----------|------|-----------|
| `index.html` header | Flex layout; shows/hides account and refresh controls | Yes |
| `app.js` `fitTitle()` | Measures overflow and assigns `--marquee-shift` | Yes |
| `src/styles.css` | Clips title and animates to the measured shift, then reverses | Yes |

## Investigation Notes

### 2026-10-10: Source trace

`fitTitle()` computes `text.scrollWidth - box.clientWidth`, then sets the negative result as `--marquee-shift`. The formula accounts for the intrinsic text width and the current visible box width. The span's `.25rem` right padding is included in its `scrollWidth`.

The value is recalculated when the title text changes, after `document.fonts.ready`, and on window resize. The header also changes width when `refresh-btn` and `account-btn` change from hidden to visible after authentication. That is a flex-layout change, not a window resize; no observer currently recalculates the shift then.

### Hypotheses

| # | Hypothesis | Evidence For | Evidence Against | Status |
|---|-----------|-------------|-----------------|--------|
| 1 | The intrinsic-width formula omits the final glyph | User reports clipped trailing characters | `scrollWidth` includes the inline-block content and padding; the calculation rounds overflow upward | Rejected as the primary cause |
| 2 | The saved shift is stale after header controls consume flex width | The title is measured before sign-in; auth reveals controls; current code only listens for viewport resize and font readiness | Needs a browser regression to verify the layout transition | Source-confirmed; runtime regression pending |
| 3 | The CSS pause begins before the animation reaches its target | The animation has a rest interval around the destination | The keyframe target is the saved shift; an undersized target leaves text clipped throughout the rest | Rejected as the primary cause |

## Root Cause

The marquee shift is measured using the pre-authentication title width and is not recomputed when sign-in reveals the refresh/account controls. The header's flex layout then gives the title a narrower viewport, but the animation still translates by the smaller, stale overflow value. Its intentional pause at the keyframe destination makes the incomplete scroll visible before it reverses.

**Code location**: `fitTitle()` and `boot()` in `app.js`; header control visibility in `renderHeader()`.

**Why it happened**: Measurement was tied to font readiness and browser-window resize, not to changes in the title container's own layout size.
