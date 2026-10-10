# Predefined Group Labels Design

**Status:** Approved for planning  
**Date:** 2026-10-10

## Goal

Manage audience group labels from the app instead of relying on free-form, comma-separated input. Admins can create and archive labels in Members & Access, then assign active labels to members and ceremonies with a multi-select control.

## Chosen approach

Add a `Groups` tab to the existing Google Sheets workbook as the canonical label registry. Keep group assignments in the existing `Members.Groups` and `Itinerary.Group` cells as comma-separated label names. This avoids changing the current audience-filtering and notification data paths while preventing new assignments to unregistered labels.

The tab has `Label` and `Status` columns, with `Active` and `Archived` statuses. `setup()` creates it idempotently and may seed any labels already used by members or itinerary rows as active. It does not rename, reorder, or delete existing tabs, columns, or rows.

Other options considered:

- Store stable group IDs in assignments: supports renaming more naturally but requires a broader assignment migration and more complex sheet values.
- Normalize assignments into separate membership/audience rows: offers relational structure but is a larger departure from the current workbook model.

## Admin experience

- Add a Group labels section to Members & Access, with an input and Add action, plus a list of active and archived labels.
- Labels are immutable. To replace a name, archive it and create a new label.
- Archiving retains existing member and event assignments, so it does not silently change access or event audiences. Archived labels are unavailable for new assignments. Existing archived assignments remain visible during edits and can be removed.
- Member creation/editing and ceremony creation/editing use a mobile-friendly, accessible checkbox multi-select populated from the Groups tab. Avoid free-form entry.
- A ceremony with no selected labels remains an everyone announcement. For a labelled ceremony, a member sees it if they match at least one selected label; pushes go to the union of matching current members.

## Backend and security

- Add admin-only create/archive group actions. Validate labels, prevent case-insensitive duplicates, and perform sheet changes under the existing script lock.
- Validate member/event assignment labels against the registry. New assignments require active labels; an already-assigned archived label may remain or be removed, but cannot be newly assigned.
- Continue deriving identity and authorization from the verified Google ID token and Members sheet. Do not trust client role or email claims.
- Audit every create/archive operation and every changed member/event assignment with the existing `AuditLog` mechanism.
- Keep group reads safe for older sheets; `setup()` adds only the new tab/headers, and all writes use the existing safe-cell helpers.

## Data flow

1. `setup()` ensures the Groups tab exists and seeds any existing assignment labels without replacing existing data.
2. An admin session receives active labels plus any archived labels needed to render existing assignments.
3. The frontend sends selected label names as an array or canonical delimited value; the backend validates against the current registry before storing the existing comma-separated representation.
4. Session filtering and OneSignal targeting continue using the existing case-insensitive, any-match group semantics.

## Tests and documentation

- Backend tests: setup/idempotency and seeding; group creation, duplicate rejection, archiving and audit logging; active/archived assignment validation; safe removal of archived assignments; filtering and push targeting.
- E2E tests: create/archive label controls; select labels for new and existing members/events; prevent archived labels from being newly selected; verify blank ceremony audience still means everyone.
- Update `README.md` and `docs/DEVELOPER_GUIDE.md` with the Groups tab, management workflow, assignment semantics, and deployment/setup steps.
- Bump `CACHE_VERSION` for the frontend shell changes.
