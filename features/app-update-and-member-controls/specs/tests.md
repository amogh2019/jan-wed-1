# App Update and Member Controls Test Plan

## Scope

Browser coverage verifies the approved behavior in
`docs/plans/2026-11-03-app-update-and-member-controls.md`. No backend,
API, or Google Sheet contract changes are involved.

## E2E cases

### PWA-UPDATE-1: Check for an update after registration

**Given** service workers are supported and registration succeeds  
**When** the page finishes loading  
**Then** `registration.update()` is called without user interaction.

### PWA-UPDATE-2: Show a replacement-worker prompt

**Given** the page already has a controlling service worker  
**When** a replacement worker fires `controllerchange`  
**Then** a persistent `App updated` card with a `Reload` button becomes visible.

### PWA-UPDATE-3: Suppress the first-install prompt

**Given** the page did not have a controlling service worker at startup  
**When** its first worker fires `controllerchange`  
**Then** the update card remains hidden.

### PWA-UPDATE-4: Reload explicitly

**Given** the update card is visible  
**When** the user presses `Reload`  
**Then** the current page reloads immediately.

### PWA-UPDATE-5: Defer automatic reload while editing

**Given** the update card is visible and a form control has focus  
**When** 30 seconds elapse  
**Then** the page does not reload  
**And when** the control loses focus and the retry interval elapses  
**Then** the page reloads.

The coordinator's guard must also cover pending actions, open modals, the
welcome screen, and the tour; these conditions use the same predicate as the
focused-control case.

### PWA-UPDATE-6: Defer automatic reload during any API request

**Given** the automatic reload deadline is approaching  
**When** a background refresh starts and remains in flight at that deadline  
**Then** the page does not reload  
**And when** the request finishes and the retry interval elapses  
**Then** the page reloads.

### MEMBER-SEARCH-1: Present search as a labelled card

**Given** an admin opens Members & access  
**Then** a visually distinct search card shows a magnifier, `Find a member`
label, search field, and current matching count.

### MEMBER-SEARCH-2: Filter and count matches

**Given** multiple members are loaded  
**When** the admin types a role, email fragment, or group fragment  
**Then** the existing case-insensitive matching behavior is preserved  
**And** the card reports `matching count of total count`.

### MEMBER-SEARCH-3: Clear a query

**Given** a non-empty member query  
**Then** a `Clear` action is visible  
**When** it is pressed  
**Then** the query is emptied, all members return, and focus returns to search.

### MEMBER-GROUPS-1: Collapse group editors by default

**Given** member cards are rendered  
**Then** each native `details` group disclosure is closed  
**And** role and Remove controls remain visible  
**And** group checkboxes and Save groups are hidden.

### MEMBER-GROUPS-2: Expand an editor

**When** the admin presses a member's `Groups` summary  
**Then** the existing group picker and Save groups action become visible  
**And** the summary reports the saved assigned-group count.

### MEMBER-GROUPS-3: Preserve disclosure state across filtering

**Given** a member's group editor is expanded  
**When** a search temporarily filters that member out  
**And** the search is cleared  
**Then** the restored member's group editor remains expanded.

## Regression gates

- Existing member invitation, role, remove, group draft, archived-group, and
  pending-state tests remain green.
- Existing install-banner and service-worker-independent browser tests remain
  green.
- `window.EventApp` exposes no additional state.
- No CSP violations are introduced.
- `npm test` and `npm run test:e2e` pass.
