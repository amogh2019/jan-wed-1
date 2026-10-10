# Developer Guide

Everything needed to keep building this app. Read this before changing code.

## 1. What the app is

An **invite-only, festive PWA** for a 3-day event, hosted for free on GitHub Pages.

- **Frontend:** static HTML/JS + Tailwind, installable ("Add to Home Screen"), works offline from cache.
- **Backend:** one Google Sheet + Google Apps Script web app (`backend/Code.gs`).
- **Login:** Google sign-in is **mandatory**. Only emails in the `Members` tab get in.
- **Roles:** `Admin` (can change things) and `Viewer` (read-only guest).
- **Push:** OneSignal Web Push; fired server-side when an event goes Live.
- **WhatsApp:** "Set Live & Broadcast" opens `https://api.whatsapp.com/send?text=…` with an editable, pre-formatted message.

## 2. File map

| File | Purpose |
|---|---|
| `index.html` | App shell: header, nav, view containers, fonts, CSP. |
| `app.js` | All frontend logic (modules listed in section 5). |
| `config.js` | **Public** settings: event name/dates/blessing/hosts, Apps Script URL, Google Client ID, OneSignal App ID. |
| `src/styles.css` → `styles.css` | Tailwind source → built CSS (`npm run build:css`). Commit both. |
| `tailwind.config.js` | Festive palette (marigold, maroon/sindoor, haldi), fonts. |
| `fonts/` | Self-hosted Poppins + Yatra One (incl. Devanagari). |
| `icons/` | PWA icons, `icon-80.png` (header logo, 2x), `mandala.svg` decoration. |
| `manifest.json` | PWA install metadata. |
| `service-worker.js` | Shell cache (`CACHE_VERSION`), network-first for API. |
| `backend/Code.gs` | Entire backend. Paste into the Sheet's Apps Script editor. |
| `types/globals.d.ts` | Editor-only type hints (GSI `google`, `Guest` rows, form fields) for IDE inspections. Not loaded by the browser. |
| `tests/` | `gas-harness.js` (runs Code.gs in Node with fake sheets), `backend.test.js`, `e2e.smoke.js` (Playwright). |

## 3. Google Sheet data model

Tab names and required columns (exact header text; case/space differences are tolerated on read):

| Tab | Required columns | Optional (added later) |
|---|---|---|
| `Itinerary` | EventID, Day, Time, Title, Location, Status (`Upcoming`/`Live`/`Completed`) | |
| `Logistics` | ID, Name, Members, Contact, ArrivalDateTime, DepartureDateTime, Mode, PickupStatus (`Pending`/`Picked Up`) | |
| `Members` | Email, Role (`Admin`/`Viewer`), AddedBy, AddedDate | TourStatus (`Pending`/`Completed`/`Skipped`), TourCompletedAt |
| `AuditLog` | Timestamp, UserEmail, ActionCategory, Details | |

- Required columns: defined in `HEADERS` in Code.gs. Optional: `OPTIONAL_HEADERS`. Defaults for blanks: `BACKFILL`.
- The legacy `Admins` tab (from v1) is migrated into `Members` by `setup()` **only if Members is empty**.
- Extra columns you add yourself (notes, colours, formulas) are ignored and never touched.

### `setup()` — safe to run any time

Run from the Apps Script editor after pasting a new Code.gs. It is **non-destructive and idempotent**:

1. Missing tab → created with headers. Existing tab → **left as is**.
2. Empty tab → header row written.
3. Missing required/optional column → **appended to the right**. Existing columns are never renamed, reordered or deleted.
4. Backfill: defaults written **only into blank cells** of rows that have a key (e.g. blank `Status` → `Upcoming`, blank `TourStatus` → `Pending`). Filled cells are never overwritten; done cell-by-cell so formulas elsewhere survive.
5. Dropdown validation added with `allowInvalid=true` (odd legacy values are flagged, not rejected).
6. Writes a one-line summary to `AuditLog` (category `Schema`) when something changed. Running it twice changes nothing the second time.

Even without running `setup()`, the app keeps working on an old sheet: optional columns read as blank, and `completeTour` adds its own columns on first use.

**Adding a new column in future:** add it to `OPTIONAL_HEADERS` (and to `BACKFILL` if it needs a default), read it in the relevant `read*_()` function, then re-run `setup()`. Only put it in `HEADERS` if the app cannot work without it.

## 4. Backend API (`doPost`)

Request body: `{ action, payload, idToken, userEmail, timestamp }`. Response: `{ ok: true, data }` or `{ ok: false, error: { code, message } }`.

Every request: body size cap → local ID-token precheck → Google tokeninfo verification (cached 5 min) → `userEmail` must match token → caller must be in `Members` → rate limit (60/min/user).

| Action | Who | What | Audit category |
|---|---|---|---|
| `session` | any member | Returns user, role, tourStatus, itinerary (+ logistics, members for admins). | — |
| `updateEvent` | Admin | Set event status; `Live` triggers OneSignal push. | Event |
| `updatePickup` | Admin | Set PickupStatus. | Logistics |
| `addMember` | Admin | Add email with role. | Admin Management |
| `updateMemberRole` | Admin | Change role (can't change own; can't remove last admin). | Admin Management |
| `removeMember` | Admin | Remove (can't remove self or last admin). | Admin Management |
| `addAdmin` / `removeAdmin` | Admin | Back-compat aliases. | Admin Management |
| `completeTour` | any member | `status: Completed/Skipped`; only the caller's own row; recorded once. | Onboarding |

Mutations run under a script lock, re-check the admin role inside the lock, and write to `AuditLog` with the admin's email and timestamp. Cell writes go through `safeCell_` (blocks `=`, `+`, `-`, `@` formula injection).

**Adding an action:** add a function to `ACTIONS_` (admin) or `MEMBER_ACTIONS_` (self-service), validate inputs with `requireString_`/`requireOneOf_`/`requireEmail_`, call `writeAudit_`, add a backend test, and call it from `app.js` via `Api.post('name', payload)`.

## 5. Frontend modules (`app.js`)

- `Store`: state plus localStorage cache (no tokens ever stored there; the ID token lives in sessionStorage only).
- `Auth`: GIS sign-in, gate screen, "Access not granted" screen, sign-out.
- `Api`: POST with timeout, retries and error mapping.
- `Push`: OneSignal init and the "Turn on Notifications" banner.
- `WhatsApp`: builds the `*bold*` broadcast message and the `api.whatsapp.com/send` URL.
- `Install`: "Add to Home Screen" prompt (dismissal remembered).
- `Toast`, `Modal`, `Festive` (petal shower): UI helpers.
- **Welcome**: Ganesh Vandana splash (ॐ, ॥ श्री गणेशाय नमः ॥, the Vakratunda shloka with its meaning, then "स्वागतम्, <name> ji" with falling petals). Shown once per browser session; tap/Esc to skip; respects `prefers-reduced-motion`.
- **Tour**: spotlight tour of the guest tabs. Starts only when `tourStatus` is `Pending`/blank. Skip or finish → `completeTour` saved to the Members sheet, so it never auto-plays again on any device. It can be replayed from the profile menu; a replay is not re-recorded.
- **Nudges**: when an event newly turns Live during a session, a warm toast ("🪔 … has begun — please join us!") appears with a petal shower. Together with the notifications banner, the install prompt and the Maps links, these are the guest nudges.
- `Views` / `ScheduleParts`: the screens (Schedule, admin Pick-ups and Members, Profile modal). `Data` handles sync; `Actions` handles admin mutations.

Event wording: `EVENT_NAME`, `EVENT_DATES`, `EVENT_BLESSING` and `EVENT_HOSTS` in `config.js`.

## 6. Security: what is public and why that's OK

The site and `config.js` are public. That's fine because:

- **Apps Script URL, Google Client ID and OneSignal App ID** are public identifiers by design; every browser must see them. They grant nothing on their own.
- The real protection is **server-side**: every request needs a valid Google ID token for *your* Client ID, and the email must be in `Members`. Admin actions also need `Role=Admin`.
- **Secrets** (`ONESIGNAL_REST_API_KEY`) live only in Apps Script **Script Properties**. Never put them in the repo.

Checklist:

- Google Cloud → OAuth client → **Authorized JavaScript origins** = only your `https://<user>.github.io` origin.
- OneSignal → Site URL = your GitHub Pages URL.
- Keep the Sheet itself private (share only with organisers).
- Deploy the web app as *Execute as: Me*, *Access: Anyone*.
- Before committing, run: `grep -rn "REST_API_KEY\|private_key\|secret" --exclude-dir=node_modules .`

**CSP (in `index.html`).** No wildcard hosts and no `'unsafe-inline'` anywhere. Google profile photos are limited to `lh3`–`lh6.googleusercontent.com` (also enforced by `safePicture`), and OneSignal to `onesignal.com`/`api.onesignal.com`. Never write `style="…"` in markup: set dynamic styles through the CSSOM (`el.style.x = …`), e.g. progress bars use `data-progress` + `applyProgressWidths()`. The e2e test fails on any CSP violation. If a real OneSignal/Google prompt ever renders unstyled in production, check the browser console for a `style-src` violation before loosening the policy. The service worker only accepts `postMessage` from its own origin.

## 7. Run, test, deploy

```bash
npm install
npm run build:css     # after any class/style change
npm test              # backend unit tests (Code.gs in a Node sandbox)
npm run test:e2e      # Playwright smoke test against a mocked backend
npx serve .           # local preview
```

Deploy:

1. Push to GitHub, then Settings → Pages → branch root.
2. In Apps Script: paste `Code.gs` → set Script Properties → run `setup()` → Deploy → **Manage deployments → edit → New version** (keeps the same URL).
3. **Bump `CACHE_VERSION` in `service-worker.js`** whenever a shell file changes, otherwise installed phones keep the old version. Add any new static asset to `APP_SHELL`.

## 8. Theme / UX conventions

- Palette: marigold (primary), sindoor/maroon (accent, headings), haldi (highlights), ivory background.
- Fonts: Yatra One (display, Devanagari) and Poppins (body), self-hosted.
- Mobile-first, bottom nav, 44px+ touch targets, visible focus rings, ARIA live regions for toasts, reduced-motion support.
- Copy tone: warm, hosting-guests ("ji", "Welcome", "We're so glad you're here").

## 9. Changelog

- **v1.0** Itinerary, Logistics, Admins, AuditLog; GIS login; OneSignal; WhatsApp broadcast.
- **v1.1** Mandatory login; `Members` tab with Admin/Viewer roles; Members management tab; hardened backend (token verify, rate limit, locks, injection guard).
- **v1.2** Festive Hindu celebration theme and professional UX pass.
- **v1.3** Ganesh Vandana welcome splash, warm nudges, one-time guided tour tracked in `Members.TourStatus`; non-destructive `setup()` with column append and blank-only backfill; this guide.
- **v1.3.1** SonarJS static-analysis cleanup (0 issues): split `doPost` into `authenticate_` / `resolveAction_` / `runLocked_`, split `render()` and `loadSession()` into helpers, removed nested ternaries/templates, crypto-based randomness for petals, linear-time base-path parsing, explicit NaN-safe token expiry check. No behaviour change.
- **v1.3.2** Second Sonar/unicorn pass: `node:` imports, `replaceAll`/`codePointAt`/`dataset`/`Set.has`, braces on one-line loops in tests, locale-aware sort; CSP wildcards removed; service-worker message origin check; offline banner is an `<output>` element.
- **v1.3.3** IDE-inspection cleanup (0 IntelliJ/Sonar issues): removed `'unsafe-inline'` from `style-src` (progress bars via CSSOM), explicit `void` on fire-and-forget promises, `types/globals.d.ts` + `@types/node` dev dependency for type hints, `icon-80.png` header logo, Tailwind at-rule suppressions, e2e uses `@playwright/test` (the declared dependency).
