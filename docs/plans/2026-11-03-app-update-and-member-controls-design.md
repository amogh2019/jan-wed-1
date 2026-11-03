# App Update and Member Controls Design

## Goal

Keep installed PWAs current without requiring reinstall, make member search visually distinct, and reduce visual noise in member cards by collapsing group assignment controls.

## App update lifecycle

- Use the existing service-worker registration rather than adding a separate version endpoint.
- Check for updates after registration, every 30 minutes while the page remains open, and whenever the document returns to the foreground.
- When a replacement worker takes control, show a persistent card in the existing banner area with the message **App updated** and a **Reload** button.
- After 30 seconds, reload automatically only when no work could be interrupted:
  - no pending action;
  - no open modal, tour, or welcome screen;
  - no focused input, select, textarea, or editable element.
- If the page is busy, keep the card visible and retry when the UI becomes idle. The explicit Reload button remains available.
- A user who closes and reopens the PWA loads the active worker and current shell normally, so the update card does not remain unresolved and reinstall is never required.
- Update-check failures only write a console warning and retry on the next scheduled or foreground check.

## Members search

- Replace the standalone input with a compact festive search card.
- Include a magnifier, a visible **Find a member** label, the existing search field, a live matching-result count, and a **Clear** action only when a query exists.
- Preserve current case-insensitive matching across email, exact role, and group labels.
- Preserve focus and caret position while filtering.

## Member group disclosure

- Keep each member's identity, role selector, and remove action visible.
- Move only the group picker and **Save groups** action into a native, accessible `<details>` disclosure.
- Label the summary **Groups**, show the selected-group count, and use a rotating arrow to indicate state.
- Disclosures are closed by default. They may close after navigation or a successful save.
- Existing draft, validation, pending, archived-group, and authorization behavior remains unchanged.

## Validation

- Add browser coverage for update-card activation, manual reload, safe delayed reload gating, search presentation/count/clear behavior, and collapsed/expanded group controls.
- Rebuild Tailwind output after class changes.
- Bump the service-worker cache version because shell files change.
- Run the existing unit and Playwright suites and update the Developer Guide and changelog.
