# Role-Specific Tour and Action Loading Design

**Status:** Approved for planning  
**Date:** 2026-10-10

## Goal

Upgrade the guided tour so it demonstrates the relevant tabs and capabilities for both Admins and Atithis. Add visible, per-control loading feedback while a user-triggered backend action is in flight, without making background polling flash UI.

## Chosen approach

Extend the existing spotlight tour into a role-specific, tab-by-tab walkthrough. Each step may select a tab before resolving and spotlighting its target. The tour describes actions but never submits forms, changes event/member data, sends notifications, or otherwise performs the action for the user.

Other options considered:

- Keep the tour on Schedule and spotlight only navigation buttons: simpler, but does not explain what users can do inside the other screens.
- Replace spotlights with a static page-by-page guide: works for empty screens but loses the existing contextual spotlight interaction.

The selected walkthrough reuses the current Tour overlay, target positioning, reduced-motion behavior, welcome flow, completion statuses and per-member persistence.

## Role-specific steps

- **Shared:** orientation; Schedule, including day navigation, Live/Up next content and venue links; Notifications and their per-member clear behavior; profile/help entry; closing summary.
- **Atithi:** My travel, explaining arrival/pick-up, departure/drop and the family contact when present, or the RSVP/contact guidance when no travel row exists; notification opt-in, without triggering the browser permission prompt.
- **Admin:** Event Control, including creating ceremonies, assigning audience groups, status changes, WhatsApp broadcast and notifications; Pick & Drop, including creating/editing travel and tracking arrivals/departures; Members & Access, including inviting members, roles, group-label management and multi-select assignments.

The tour visits only tabs present for the current role. If content-dependent targets are absent, use a stable heading, empty state, or section introduction on that tab. Keep steps concise and ensure the tour remains usable on mobile.

## Completion, replay and navigation

- Preserve current `TourStatus` behavior: the first completed or skipped tour is recorded once per member across devices.
- Replay from the profile uses the signed-in member's current role and does not rewrite their stored status.
- Next/back navigation switches tabs as needed, waits for the screen to render, then scrolls and positions the spotlight.
- Skip and Escape record `Skipped`; finishing records `Completed`. Sign-out or identity change cancels the tour without submitting a completion request.
- Tour copy and navigation must not invoke the highlighted controls.

## User-triggered backend loading feedback

- Reuse the existing pending-action state (`Store.pending` / `Actions.run`) as the source of truth.
- While a user-triggered request is pending, show a spinner and disabled state inside its initiating button. Preserve form values and prevent duplicate submissions.
- For requests initiated by selects or other controls without an action button, disable the control and show an adjacent, accessible progress indicator.
- The tour completion/skip control stays visibly busy until its `completeTour` request settles; errors use the existing error toast and restore an actionable state rather than silently swallowing the failure.
- Keep current success/error toasts as the response feedback. Do not introduce a full-screen loading overlay.
- Background session polling and automatic refreshes remain quiet. Explicit refresh/sign-in continues to use the app's existing loading presentation.

## Implementation boundaries

- Frontend changes are in `app.js`, with only necessary style changes in `src/styles.css` and rebuilt `styles.css`.
- No sheet schema or backend API changes are expected; `completeTour` remains the existing self-service action.
- Bump `CACHE_VERSION` in `service-worker.js` for changed shell files.
- Update README and Developer Guide descriptions of the role-specific tour and action loading behavior.

## Tests

- E2E tests cover Atithi and Admin tour sequences, tab switching, spotlight resolution (including empty/content-sparse screens), next/back, skip and finish, and confirm tour guidance does not mutate highlighted app data.
- Verify role-appropriate steps are shown and unavailable tabs/actions are not included.
- Verify user-triggered mutation buttons show busy/disabled state through the response and preserve success/error toast behavior.
- Verify select-driven operations show adjacent progress, duplicate requests are prevented, and background polling does not flash an action spinner.
- Backend tests should remain unchanged unless implementation reveals a necessary `completeTour` contract adjustment.
