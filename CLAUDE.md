# CLAUDE.md

**Before making any change, read [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md).** It is the source of truth for architecture, the Google Sheet data model, the backend API, safe sheet migration, security and conventions. Update it (including the Changelog) whenever you change behaviour.

## Project in one line
Invite-only festive event PWA: static frontend on GitHub Pages (`index.html`, `app.js`, `config.js`, Tailwind) + Google Sheets / Apps Script backend (`backend/Code.gs`) + Google sign-in + OneSignal push.

## Commands
```bash
npm run build:css   # after any Tailwind class / src/styles.css change (commit styles.css too)
npm test            # backend unit tests (Code.gs in a Node sandbox: tests/gas-harness.js)
npm run test:e2e    # Playwright smoke test against a mocked backend
```

## Rules that must not be broken
- **No secrets in the repo.** `config.js` holds only public identifiers; the OneSignal REST key lives in Apps Script Script Properties.
- **Server-side auth is the security boundary.** Every `doPost` action verifies the Google ID token and Members membership; admin actions check `Role=Admin` under the script lock. Never trust client-sent role/email.
- **Every admin mutation writes to `AuditLog`** (UserEmail, Timestamp, ActionCategory, Details).
- **Sheet changes are non-destructive.** Never rename, reorder or delete existing tabs/columns/rows. New columns go in `OPTIONAL_HEADERS` (+ `BACKFILL` for blank-only defaults); `setup()` must stay idempotent.
- Sheet writes go through `safeCell_` (formula-injection guard). Escape all rendered user data with `escapeHtml`.
- ID tokens live in `sessionStorage` only, never `localStorage`.
- **Bump `CACHE_VERSION` in `service-worker.js`** when any shell file changes; add new static assets to `APP_SHELL`.
- Keep e2e selectors stable (see `tests/e2e.smoke.js`). Add backend tests for new actions.
- Keep the festive theme and warm guest tone (marigold/sindoor/haldi palette, Yatra One + Poppins, reduced-motion support, ≥44px touch targets).
