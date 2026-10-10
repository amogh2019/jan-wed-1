# Predefined Group Labels Test Specification

Implementation source plan: `docs/plans/2026-10-10-predefined-group-labels.md`  
Approved design: `docs/plans/2026-10-10-predefined-group-labels-design.md`

## Backend unit tests

Use `tests/backend.test.js` and the Apps Script fake-sheet helpers in `tests/gas-harness.js`.

1. `setup()` creates the `Groups` tab with `Label` and `Status` headers on a workbook without the tab.
2. `setup()` imports labels from existing `Members.Groups` and `Itinerary.Group` cells as `Active`, deduplicating case-insensitively while leaving the source cells untouched.
3. Re-running `setup()` leaves the Groups rows and audit count unchanged.
4. `addGroup` trims/collapses whitespace, appends an `Active` label, and audits the admin, timestamp, and label.
5. `addGroup` rejects invalid names and case-insensitive duplicates; non-admins are denied.
6. `archiveGroup` changes the label status without modifying existing member/event assignment cells and writes an audit record.
7. `archiveGroup` rejects unknown labels and non-admins.
8. Admin session data contains the group catalog with status.
9. `addMember` and `addEvent` accept active labels and reject unknown or archived labels.
10. `updateMemberGroups` and `updateEventGroup` accept active labels; an archived label is allowed only when already assigned to that same record, and may be removed.
11. Assignments resolve case-insensitive input to the registry spelling and remain comma-separated in the existing columns.
12. Empty ceremony groups still mean everyone. Multiple groups use any-match filtering and target the union of matching current members for OneSignal.
13. Changed group assignments are audited; no-op assignments do not create extra audit rows.

## End-to-end tests

Use `tests/e2e.smoke.js` with the mocked Apps Script backend.

1. An admin creates a group in Members & Access and sees it listed as active.
2. A duplicate submission surfaces the backend validation error without creating a second label.
3. Admins select multiple active groups for a new member and an existing member; saved assignments match the selected options.
4. Admins select multiple groups for a new ceremony and an existing ceremony; the audience display and saved assignments match.
5. Archive preserves existing assignments, marks the option archived, and prevents it from being newly selected for another assignment.
6. An existing archived assignment can be unchecked and saved.
7. The guest schedule shows everyone-events and any events matching at least one assigned group, but no other group events.
8. Blank audience continues to show to all members.

## Acceptance criteria

- All backend and config tests pass with `npm test`.
- All browser smoke tests pass with `npm run test:e2e`.
- `git diff --check` passes.
- No selector accepts arbitrary label text; the server rejects unregistered labels even when called directly.
- Existing group filtering, notification history, and targeted push behavior remain intact.
