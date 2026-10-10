# Developer Guide

Everything needed to keep building this app. Read this before changing code.

## 1. What the app is

An **invite-only, festive PWA** for a 3-day event, hosted for free on GitHub Pages.

- **Frontend:** static HTML/JS + Tailwind, installable ("Add to Home Screen"), works offline from cache. Offline schedule data contains everyone-events as of the last sync and expires after 15 minutes. Audience changes made while a device is offline cannot be known until it reconnects.
- **Backend:** one Google Sheet + Google Apps Script web app (`backend/Code.gs`).
- **Login:** Google sign-in is **mandatory**. Only emails in the `Members` tab get in.
- **Roles:** `Admin` (can change things) and `Atithi` (read-only guest; called `Viewer` before v1.4 — legacy `Viewer` cells and requests are still accepted as Atithi).
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
| `manifest.json` | PWA install metadata. `name`/`short_name` are copied from `config.js` by `npm run sync:config`. |
| `scripts/sync-config.js` | Copies the app name from `config.js` into `manifest.json` and `index.html`. |
| `service-worker.js` | Shell cache (`CACHE_VERSION`), network-first for API. |
| `backend/Code.gs` | Entire backend. Paste into the Sheet's Apps Script editor. |
| `types/globals.d.ts` | Editor-only type hints (GSI `google`, `Guest` rows, form fields) for IDE inspections. Not loaded by the browser. |
| `tests/` | `gas-harness.js` (runs Code.gs in Node with fake sheets), `backend.test.js`, `config-sync.test.js` (app name in sync), `e2e.smoke.js` (Playwright). |

## 3. Google Sheet data model

Tab names and required columns (exact header text; case/space differences are tolerated on read):

| Tab | Required columns | Optional (added later) |
|---|---|---|
| `Itinerary` | EventID, Day, Time, Title, Location, Status (`Upcoming`/`Live`/`Completed`) | MapLink (Google Maps link), Group (comma-separated audience labels; blank means everyone) |
| `Logistics` | ID, Name, Members, Contact, ArrivalDateTime, DepartureDateTime, Mode, PickupStatus (`Pending`/`Picked Up`) | Email (guest's Google email → their "My travel" tab), DropStatus (`Pending`/`Dropped Off`, backfilled `Pending`) |
| `Members` | Email, Role (`Admin`/`Atithi`; legacy `Viewer` = Atithi), AddedBy, AddedDate | TourStatus (`Pending`/`Completed`/`Skipped`), TourCompletedAt, Groups (comma-separated labels), NotificationsClearedAt |
| `AuditLog` | Timestamp, UserEmail, ActionCategory, Details | |
| `Notifications` | Timestamp, Title, Message, EventID, Groups, SentBy, PushStatus (created by `setup()`; one row per app announcement) | |
| `Groups` | Label, Status (`Active`/`Archived`; created by `setup()`) | |

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

Every request: body size cap → local ID-token precheck → Google tokeninfo verification (cached until the token expires, ≤ 1 h) → `userEmail` must match token → caller must be in `Members` → rate limit (60/min/user).

| Action | Who | What | Audit category |
|---|---|---|---|
| `session` | any member | Returns user, role, tourStatus, member groups, filtered itinerary and recent notifications, opaque `pushId`, `myTravel` (only rows whose Email is the caller, without the Email field), `familyContact` (+ full logistics, members, known groups and group catalog for admins). A guest's session still loads if Logistics is missing. | — |
| `updateEvent` | Admin | Set event status; `Live` triggers OneSignal push to all current Members when Group is blank, or to matching group members only. It does not target unrelated/stale OneSignal subscriptions. Each announcement is logged in `Notifications` even if push fails. | Event |
| `updatePickup` | Admin | Set PickupStatus. | Logistics |
| `updateDropoff` | Admin | Set DropStatus (`Pending`/`Dropped Off`); adds the column on first use. | Logistics |
| `updateLogistics` | Admin | Edit a travel row (`id`, `name` required). **Only keys present in the payload are written**, so free-text times the form can't show are never wiped; statuses untouched. Returns `changed`; no-op edits aren't audited. | Logistics |
| `addEvent` | Admin | Append an itinerary row: `title`, `day` required (the app sends the date picker's value as "Sat, Jan 23"); `time`, `location`, `mapLink`, and selected `groups` optional. Groups must be in the active catalog. `mapLink` must be an https Google Maps link (allow-listed on both server and client, since it becomes an href). Always starts `Upcoming` (no push). Next EventID = highest number + 1. Written in the sheet's own column order. | Event |
| `updateEventGroup` | Admin | Set a ceremony's audience with selected `groups`; blank means everyone. Only catalog labels are accepted; an archived label may remain on its existing assignment or be removed. Stale titles are rejected. | Event |
| `deleteEvent` | Admin | Delete an itinerary row: `eventId` required, `title` optional but sent by the app (must match, else `CONFLICT`, so a stale screen can't delete a renumbered event). Numeric IDs of rows **below** shift down by one (deleting 3: 4→3, 5→4) so the next `addEvent` continues the sequence. If a shift would collide with an ID that stays (hand-edited, out-of-order sheet), the row is deleted and no IDs change. Older AuditLog lines keep the old IDs, and the deletion audit line lists every `from→to`. | Event |
| `addPickup` | Admin | Append a Logistics row: `name` required; `members` (1–500), `contact` (phone chars), `arrival`/`departure` (`yyyy-MM-ddTHH:mm`, sheet time zone, departure ≥ arrival), `mode`, `email`, `pickupStatus` optional. Next ID keeps the prefix (`G7` → `G8`). | Logistics |
| `addMember` | Admin | Add email with role (`Admin`/`Atithi`; `Viewer` accepted and stored as `Atithi`) and optional selected `groups`. Groups must be in the active catalog. | Admin Management |
| `updateMemberGroups` | Admin | Replace a member's group labels. Labels are case-insensitive for matching; up to 10 labels, 30 characters each. Existing archived assignments may be retained or removed, but cannot be newly assigned. | Admin Management |
| `addGroup` / `archiveGroup` | Admin | Add a label or archive an active label. Labels cannot be renamed; archiving preserves existing assignments and removes the label from new-assignment pickers. | Admin Management |
| `updateMemberRole` | Admin | Change role (can't change own; can't remove last admin). | Admin Management |
| `removeMember` | Admin | Remove (can't remove self or last admin). | Admin Management |
| `addAdmin` / `removeAdmin` | Admin | Back-compat aliases. | Admin Management |
| `completeTour` | any member | `status: Completed/Skipped`; only the caller's own row; recorded once. | Onboarding |
| `clearNotifications` | any member | Set the caller's `NotificationsClearedAt` timestamp, hiding existing notices for that member across devices without deleting shared history. | — |

**Family contact for guests.** Set Script Properties `FAMILY_CONTACT_NAME` and `FAMILY_CONTACT_PHONE` (e.g. `+91 98765 43210`) to show a "Plans changed? Call …" button on every guest's My travel tab. Kept out of the repo on purpose; unset → the button is hidden.

**Groups and announcement history.** The `Groups` tab is the label catalog (`Label`, `Status`); `setup()` creates it and seeds active labels from existing member/event assignments. The Members & Access screen lets admins add labels or archive them (labels are never renamed). Assignment controls are checkbox multi-selects; archived assignments remain visible and removable, but the backend rejects new assignments to archived or unknown labels. The sheet stores group names comma-separated; matching is case-insensitive, labels cannot contain commas, and blank event groups mean everyone currently on the `Members` list. Guests receive only events/notices for everyone or groups assigned to them; admins can see all. Pushes target current member devices using an HMAC-derived opaque external ID, not email addresses, so removed members' stale subscriptions are excluded. `setup()` creates the `PUSH_ID_SECRET` Script Property; never copy it into the frontend or repository. Each device must open the updated app once while signed in before targeted pushes can reach it. The `Notifications` tab records announcements initiated by Event Control, including push failures; messages sent directly in the OneSignal dashboard and delivery receipts cannot be captured here. Clear is per member/device-synced and does not delete the shared notification rows. Session history shows up to 50 newest announcements (reading up to the latest 100 from the sheet).

**Admins don't need access to the Sheet.** The web app runs *Execute as: Me*, so every read/write happens as the script owner after the checks above. Only organisers who want to look at the raw data need the Sheet shared with them.

**AuditLog size.** `appendRow` grows the tab automatically (it isn't capped at 1,000 rows). The real limit is Google's 10 million cells per spreadsheet — AuditLog's 4 columns allow millions of rows, far beyond a 3-day event. There's no automatic rollover; if it ever gets large, copy old rows to an archive tab or file by hand.

Mutations run under a script lock, re-check the admin role inside the lock, and write to `AuditLog` with the admin's email and timestamp. Cell writes go through `safeCell_` (blocks `=`, `+`, `-`, `@` formula injection).

**Adding an action:** add a function to `ACTIONS_` (admin) or `MEMBER_ACTIONS_` (self-service), validate inputs with `requireString_`/`requireOneOf_`/`requireEmail_`, call `writeAudit_`, add a backend test, and call it from `app.js` via `Api.post('name', payload)`.

## 5. Frontend modules (`app.js`)

- `Store`: state plus localStorage cache (no tokens ever stored there; the ID token lives in sessionStorage only).
- `Auth`: GIS sign-in, gate screen, "Access not granted" screen, sign-out.
- `Api`: POST with timeout, retries and error mapping.
- `Push`: OneSignal init, the "Turn on Notifications" banner, and `OneSignal.login()` with the backend-issued opaque member ID for group-targeted delivery.
- `WhatsApp`: builds the `*bold*` broadcast message and the `api.whatsapp.com/send` URL.
- `Install`: native install prompt where the browser offers one, otherwise a step-by-step guide (iOS Safari, Android Chrome, desktop, and in-app browsers like WhatsApp which must "Open in browser" first). Available from the 📲 banner and the profile menu. **Shareable install link:** `<site>/?install=1` (admins: profile → "Copy the install link for guests") opens the guide even if the banner was dismissed; the query is then stripped from the URL. Browsers only allow the native prompt after a tap, so the link opens the guide rather than installing silently. The installed app's name comes from `EVENT_NAME` (or `APP_SHORT_NAME` if set) in `config.js`. Phones read it from `manifest.json` and the `apple-mobile-web-app-title` meta *before* any JS runs, so after changing it run `npm run sync:config` (copies it into both files and `<title>`; `npm test` fails if they drift), then bump `CACHE_VERSION`. Already-installed apps keep their old name until reinstalled (Android may update it on its own after a few days).
- `Toast`, `Modal`, `Festive` (petal shower): UI helpers.
- **Welcome**: Ganesh Vandana splash (ॐ, ॥ श्री गणेशाय नमः ॥, the Vakratunda shloka with its meaning, then "स्वागतम्, <name> ji" with falling petals). Shown on every sign-in and every time the app is opened/reloaded (not on background syncs); tap/Esc to skip; respects `prefers-reduced-motion`.
- **Tour**: spotlight tour of the guest tabs. Starts only when `tourStatus` is `Pending`/blank. Skip or finish → `completeTour` saved to the Members sheet, so it never auto-plays again on any device. It can be replayed from the profile menu; a replay is not re-recorded.
- **Nudges**: when an event newly turns Live during a session, a warm toast ("🪔 … has begun — please join us!") appears with a petal shower. Together with the notifications banner, the install prompt and the Maps links, these are the guest nudges.
- `Views` / `ScheduleParts`: the screens — Schedule; guest **My travel** (own pick-up & drop + family contact); **Notifications** for all members; admin **Pick & Drop** (one list with a Pick-ups/Drops toggle, sorted by arrival or departure time, per-row ✎ edit), Event Control and Members. Bottom nav includes Notifications for both roles. `Data` handles sync (polls every `REFRESH_INTERVAL_MS` ±20% jitter, minimum 15 s, only while visible and online); `Actions` handles admin mutations.
- **Header title**: the full `EVENT_NAME` is shown; if it is wider than the header it glides left and back (`.marquee`, shift set via CSSOM). With reduced motion it wraps instead.

Event wording: `EVENT_NAME`, `EVENT_DATES`, `EVENT_BLESSING` and `EVENT_HOSTS` in `config.js`.

## 6. Security: what is public and why that's OK

The site and `config.js` are public. That's fine because:

- **Apps Script URL, Google Client ID and OneSignal App ID** are public identifiers by design; every browser must see them. They grant nothing on their own.
- The real protection is **server-side**: every request needs a valid Google ID token for *your* Client ID, and the email must be in `Members`. Admin actions also need `Role=Admin`.
- **Secrets** (`ONESIGNAL_REST_API_KEY`) live only in Apps Script **Script Properties**. Never put them in the repo.

Checklist:

- Google Cloud → OAuth client → **Authorized JavaScript origins** = only your `https://<user>.github.io` origin.
- OneSignal → Settings → Push & In-App → Web: integration **Custom Code**, Site URL = `https://<user>.github.io` (origin only). **Push** gotcha: with *Typical Site*, the dashboard's service-worker settings (`/OneSignalSDKWorker.js`, scope `/`) override `serviceWorkerPath` in `app.js`. That file 404s on a GitHub Pages project site, so nobody can subscribe and the API answers "All included players are not subscribed". You can check what OneSignal will use at `https://api.onesignal.com/sync/<appId>/web?callback=x` (`integration.kind` should be `custom`).
- Keep the Sheet itself private (share only with organisers).
- Deploy the web app as *Execute as: Me*, *Access: Anyone*.
- Before committing, run: `grep -rn "REST_API_KEY\|private_key\|secret" --exclude-dir=node_modules .`

**CSP (in `index.html`).** No wildcard hosts and no `'unsafe-inline'` anywhere. Google profile photos are limited to `lh3`–`lh6.googleusercontent.com` (also enforced by `safePicture`), and OneSignal to `onesignal.com`/`api.onesignal.com`. **`script-src` must include `https://api.onesignal.com`**: OneSignal v16 loads its app config by JSONP from `api.onesignal.com/sync/<appId>/web`; without it `OneSignal.init` never resolves and no device can subscribe. If init fails or takes longer than 15 s, the banner shows **Retry** (reloads the page) instead of "Loading…". Never write `style="…"` in markup: set dynamic styles through the CSSOM (`el.style.x = …`), e.g. progress bars use `data-progress` + `applyProgressWidths()`. The e2e test fails on any CSP violation. If a real OneSignal/Google prompt ever renders unstyled in production, check the browser console for a `style-src` violation before loosening the policy. The service worker only accepts `postMessage` from its own origin.

## 7. Run, test, deploy

```bash
npm install
npm run build:css     # after any class/style change
npm run sync:config   # after changing EVENT_NAME / APP_SHORT_NAME in config.js
npm test              # backend unit tests (Code.gs in a Node sandbox)
npm run test:e2e      # Playwright smoke test against a mocked backend
npx serve .           # local preview
```

Deploy:

1. Push to GitHub, then Settings → Pages → branch root.
2. In Apps Script: paste `Code.gs` → set Script Properties → run `setup()` (optional, once: `migrateViewerToAtithi()` relabels legacy `Viewer` role cells) → Deploy → **Manage deployments → edit → New version** (keeps the same URL).
3. **Bump `CACHE_VERSION` in `service-worker.js`** whenever a shell file changes, otherwise installed phones keep the old version. Add any new static asset to `APP_SHELL`.

## 8. Capacity and Apps Script quotas

Free (consumer Gmail) Apps Script limits that matter here: **~20,000 `UrlFetch` calls/day**, **30 simultaneous executions** per script owner, 6 min per execution. Web-app requests themselves have no daily cap.

Worst case, 200 guests × 2 h open per day, polling every 60 s (±20% jitter, only while the app is visible and online):

| What | Per day | Limit |
|---|---|---|
| `session` requests (web-app executions) | 200 × 120 = **24,000** | no daily cap |
| tokeninfo `UrlFetch` (cached per token ≤ 1 h) | ≤ 200 × 2–3 = **~600** | 20,000 |
| OneSignal `UrlFetch` (one per *Set Live*) | ~10–20 | 20,000 |
| Concurrent executions | all 200 open at once ≈ 3–4 req/s × ~1 s ≈ **3–5** | 30 |
| Per-user rate limit | 1 poll/min + taps | 60/min |

So the default comfortably fits. Levers if it is ever needed: raise `REFRESH_INTERVAL_MS` (e.g. 120000 halves the load), and the itinerary is already cached for 30 s in `CacheService`. Watch Apps Script → **Executions** for failures during the event.

## 9. Decommissioning after the event

Do these in order (each step is reversible until the last):

1. **Export the data**: File → Download → `.xlsx` of the Sheet (Itinerary, Logistics, Members, AuditLog). Logistics holds phone numbers and emails, so keep the export private or delete it later.
2. **Say goodbye (optional)**: mark all ceremonies *Completed* — guests see the "Dhanyavaad!" card — and send a last WhatsApp note.
3. **Stop the backend**: Apps Script → Deploy → Manage deployments → **Archive** the web app. Every call now fails, so the app stops at the sign-in screen.
4. **Remove the secret**: Project Settings → Script Properties → delete `ONESIGNAL_REST_API_KEY` (and the family-contact properties). Then OneSignal → Settings → Keys & IDs → **rotate/revoke the REST API key**.
5. **OneSignal**: Settings → *Delete app* (removes all subscriber tokens). Guests' browsers simply stop receiving pushes.
6. **Google sign-in**: Google Cloud Console → APIs & Services → Credentials → delete the OAuth client (or the whole project). Optionally revoke the script's access at myaccount.google.com → Security → Third-party access.
7. **Website**: GitHub → Settings → Pages → *Unpublish*/set Source to None, then Settings → General → **Change visibility → Private** (or archive). Installed home-screen icons will show an offline/empty app; guests can long-press → remove.
8. **The Sheet**: unshare it from co-organisers; after you have the export, delete it (or keep it private as a keepsake). Remove `AuditLog` rows that you don't need.
9. **Last check**: open the site URL in a private window (should 404) and run `testPush()` (should fail) to confirm everything is off.

## 10. Theme / UX conventions

- Palette: marigold (primary), sindoor/maroon (accent, headings), haldi (highlights), ivory background.
- Fonts: Yatra One (display, Devanagari) and Poppins (body), self-hosted.
- Mobile-first, bottom nav, 44px+ touch targets, visible focus rings, ARIA live regions for toasts, reduced-motion support.
- Copy tone: warm, hosting-guests ("ji", "Welcome", "We're so glad you're here").

## 11. Changelog

- **v1.7.0** Group audiences and announcement history: optional `Itinerary.Group` and `Members.Groups` labels filter guest schedules; blank event group means all current Members. `Notifications` logs Event Control Live announcements and provides per-member clearing across devices. OneSignal targeting uses HMAC-derived opaque external IDs (`PUSH_ID_SECRET` is created by `setup()`), excluding removed-member subscriptions; devices must open the updated app once before targeted pushes can reach them. Offline cache excludes group-restricted events as of its last sync and expires after 15 minutes; group changes made while offline cannot be learned until the device reconnects. Added admin group controls, a shared Notifications tab, and tests/docs. Dashboard-originated OneSignal sends and delivery receipts are not captured.
- **v1.7.2** Completed predefined group labels: added the admin group catalog UI, checkbox multi-selects for member and ceremony audiences, and server-side checks that assignments use active labels. Archiving preserves existing assignments while blocking new ones; added backend and browser regression coverage.
- **v1.0** Itinerary, Logistics, Admins, AuditLog; GIS login; OneSignal; WhatsApp broadcast.
- **v1.1** Mandatory login; `Members` tab with Admin/Viewer roles; Members management tab; hardened backend (token verify, rate limit, locks, injection guard).
- **v1.2** Festive Hindu celebration theme and professional UX pass.
- **v1.3** Ganesh Vandana welcome splash, warm nudges, one-time guided tour tracked in `Members.TourStatus`; non-destructive `setup()` with column append and blank-only backfill; this guide.
- **v1.3.1** SonarJS static-analysis cleanup (0 issues): split `doPost` into `authenticate_` / `resolveAction_` / `runLocked_`, split `render()` and `loadSession()` into helpers, removed nested ternaries/templates, crypto-based randomness for petals, linear-time base-path parsing, explicit NaN-safe token expiry check. No behaviour change.
- **v1.3.2** Second Sonar/unicorn pass: `node:` imports, `replaceAll`/`codePointAt`/`dataset`/`Set.has`, braces on one-line loops in tests, locale-aware sort; CSP wildcards removed; service-worker message origin check; offline banner is an `<output>` element.
- **v1.3.3** IDE-inspection cleanup (0 IntelliJ/Sonar issues): removed `'unsafe-inline'` from `style-src` (progress bars via CSSOM), explicit `void` on fire-and-forget promises, `types/globals.d.ts` + `@types/node` dev dependency for type hints, `icon-80.png` header logo, Tailwind at-rule suppressions, e2e uses `@playwright/test` (the declared dependency).
- **v1.5.0** **Pick & Drop**: departure drops tracked like pick-ups (`DropStatus`), admins can edit any travel row (`updateLogistics`, partial updates only), rows sorted by time. Guests get a **My travel** tab with only their own rows (linked by the new `Logistics.Email`) and a call button for the family contact (Script Properties). Welcome splash now plays on every sign-in/app open. Full event name in the header (gliding marquee when long); manifest/home-screen name updated. Install guide + shareable `?install=1` link. Polling jitter to spread Apps Script load. Docs: capacity/quota maths and a decommissioning checklist. Run `setup()` once to add the new columns (optional; actions add them on first use).
- **v1.5.2** The notification banner only hides once OneSignal has really registered the device (subscription id present), so a failed registration keeps showing "Notify me" instead of looking done.
- **v1.6.1** Event Control: **🗑 Delete ceremony** (`deleteEvent`) with a confirm that warns when the event is Live and how many later ceremonies will be renumbered. Deletes the sheet row and shifts later EventIDs down by one; audited.
- **v1.6.0** Add ceremony: Day is a date picker (opens on tap); location name plus optional Google Maps link, filled by pasting a share link, "Use my current location" or "Find on Google Maps". Tapping a location opens that pin (fallback: search by name), and the WhatsApp broadcast includes it. Travel Mode is a dropdown: Plane, Train, Own Vehicle, Other Vehicle (old free-text values are kept when editing). More space above the header blessing.
- **v1.5.1** Push fix (docs + clearer `testPush()` error): the OneSignal app must use the *Custom Code* integration on GitHub Pages project sites. Installed-app name now fully driven by `config.js` (`EVENT_NAME`, optional `APP_SHORT_NAME`) via `npm run sync:config`, guarded by a test.
- **v1.4.0** Fixed push: CSP `script-src` now allows `https://api.onesignal.com` (OneSignal's JSONP config call was blocked, so init hung on "Loading…" and nobody could subscribe); the banner now shows **Retry** if init fails or times out. Admins can add ceremonies (`addEvent`) and arrivals (`addPickup`) from the app in a modal form, so a background refresh never wipes a draft. Both are locked, validated, written in the sheet's column order and audited. The read-only role is renamed **Atithi** (legacy `Viewer` still works; the dropdown keeps both; optional `migrateViewerToAtithi()`). The "Control" tab is now **Event Control**.
