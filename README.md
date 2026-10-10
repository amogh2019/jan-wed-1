# Event Companion — PWA

A private, installable Progressive Web App (PWA) for a 3-day event. It is hosted on **GitHub Pages**. The backend is a **Google Sheet** with an **Apps Script** web app. Users sign in with **Google Sign-In**, and live alerts go out through **OneSignal Web Push**.

> 📘 **Maintainers:** see [docs/DEVELOPER_GUIDE.md](docs/DEVELOPER_GUIDE.md) for architecture, the data model, the API, safe sheet migration, security and how to extend.

## Features

| Who | What |
|---|---|
| Everyone | Google sign-in is **required**. Only emails listed on the `Members` sheet can open the app. After signing in, guests see a **welcome screen** that opens with the Ganesh Vandana and greets them by name. It appears on every sign-in and every time the app is opened. |
| First visit | A short **guided tour** highlights the main parts of the app. It runs **once per guest**: finishing or skipping it is saved to that guest's row in `Members` (`TourStatus`), so it never repeats, even on another device. Guests can replay it from their profile at any time. |
| Atithi (guest) | A festive schedule grouped by day, with a progress bar, a "Happening now" card, an "Up next" card and map links for every venue. A gentle message appears when a new ceremony starts. **My travel** shows their own pick-up and drop (linked by their email on the `Logistics` sheet) with a one-tap call to the family contact. There is also a **Notify me** button and a step-by-step guide to install the app to the home screen (shareable link: `<site>/?install=1`). |
| Admin | **Event Control:** add ceremonies and set one Live, which sends a push to every subscriber and opens WhatsApp with a ready-made message. **Pick & Drop:** add or edit a family's travel, and mark pick-ups (Picked Up) and departure drops (Dropped Off), sorted by time. **Members:** add/remove members and switch their role between Admin and Atithi. |

Every admin action sends the admin's email and a timestamp. `Code.gs` writes them to the `AuditLog` sheet.

## Google Sheet layout

| Tab | Columns |
|---|---|
| `Itinerary` | EventID, Day, Time, Title, Location, Status (`Upcoming`/`Live`/`Completed`) |
| `Logistics` | ID, Name, Members, Contact, ArrivalDateTime, DepartureDateTime, Mode, PickupStatus (`Pending`/`Picked Up`), Email (optional, the guest's Google email), DropStatus (optional, `Pending`/`Dropped Off`) |
| `Members` | Email, Role (`Admin`/`Atithi`), AddedBy, AddedDate, TourStatus (`Pending`/`Completed`/`Skipped`), TourCompletedAt |
| `AuditLog` | Timestamp, UserEmail, ActionCategory, Details |

Columns are matched by header name, so you can reorder them. An empty or unknown Role, or the old name `Viewer`, is treated as `Atithi`. Admins add itinerary and pick-up rows from the app, so they don't need access to the Sheet itself (the script runs as you).

## Setup

### 1. Google Sheet + Apps Script
1. Create a Google Sheet, then open **Extensions → Apps Script**.
2. Paste in [`backend/Code.gs`](backend/Code.gs) and save.
3. Run `setup()` once and grant the permissions it asks for. It creates all tabs, headers and dropdowns, and adds **you** to `Members` as the first Admin. If you already have an `Admins` tab, it moves those emails into `Members` as Admins. Running `setup()` again is safe: it only adds missing columns, such as `TourStatus`, to the right of existing sheets, and never touches your data.
4. Go to **Project Settings → Script properties** and add:

   | Property | Value |
   |---|---|
   | `GOOGLE_CLIENT_ID` | OAuth client ID from step 2 |
   | `ONESIGNAL_APP_ID` | OneSignal App ID |
   | `ONESIGNAL_REST_API_KEY` | OneSignal REST API key. This is secret and lives here only. |
   | `FAMILY_CONTACT_NAME` / `FAMILY_CONTACT_PHONE` | Optional. Shown to guests on **My travel** as "Plans changed? Call …". |
   | `APP_URL` | `https://<user>.github.io/<repo>/` |
5. Go to **Deploy → New deployment → Web app**. Set *Execute as* to **Me** and *Who has access* to **Anyone**. Copy the `/exec` URL.
   After any change to the code, use **Manage deployments → Edit → New version**. This keeps the same URL.

### 2. Google Sign-In (OAuth client)
In Google Cloud Console, go to **APIs & Services → Credentials → Create OAuth client ID** and choose type **Web application**.
Under **Authorized JavaScript origins**, add `https://<user>.github.io` and `http://localhost:8000` (for local testing).

### 3. OneSignal
Create a **Web** app and choose **Custom Code** (not *Typical Site*). Set the Site URL to `https://<user>.github.io` (the origin only, no path).
With *Typical Site*, OneSignal ignores the service-worker path in `app.js` and looks for `/OneSignalSDKWorker.js` at the domain root, which GitHub Pages project sites don't have. No device can subscribe, and `testPush()` returns "All included players are not subscribed".
You do **not** need to upload OneSignal's service-worker file: [`service-worker.js`](service-worker.js) already imports it.
Optionally, run `testPush()` in Apps Script to check delivery.

### 4. Frontend
Fill in [`config.js`](config.js) with `APPS_SCRIPT_URL`, `GOOGLE_CLIENT_ID` and `ONESIGNAL_APP_ID`. None of these are secrets. You can also personalise `EVENT_NAME`, `EVENT_DATES`, `EVENT_BLESSING` and `EVENT_HOSTS`, which are shown on the invitation and welcome screens. `EVENT_NAME` (or `APP_SHORT_NAME`) is also the installed app's name: after changing it run `npm run sync:config`. `APPS_SCRIPT_URL` must be exactly `https://script.google.com/macros/s/<id>/exec`; any other URL is rejected. Then push to GitHub and enable **Settings → Pages → Deploy from branch (`main`, `/root`)**, and tick **Enforce HTTPS**.

Styles are precompiled Tailwind. This keeps the Content-Security-Policy strict: no CDN script and no `eval`. After you change any classes in `index.html` or `app.js`, rebuild and commit the CSS:

```bash
npm install
npm run build:css   # writes styles.css
```

Local preview: `python3 -m http.server 8000`, then open <http://localhost:8000>.

### Tests
```bash
npm test            # backend unit tests: Code.gs runs in Node with mocked Apps Script services
npm run test:e2e    # browser smoke test: mocked Google/OneSignal/backend (first run: npx playwright install chromium-headless-shell)
```

## How access works

1. The app shows a sign-in screen. Returning members are signed in automatically by Google One Tap.
2. Each request sends the Google ID token. `Code.gs` checks it with Google (audience, issuer, expiry, verified email), then looks the email up in `Members`:
   - **not found:** "Access not granted" screen
   - **Atithi:** read-only guest
   - **Admin:** full access
3. Membership is checked again on every request. Removing someone or demoting them takes effect on their next sync.
4. Safety checks: you can't remove yourself or change your own role, and at least one Admin must always remain.
5. Atithis never receive other guests' Logistics data (contact details) or the member list.
6. When offline, a member who was verified before sees the last schedule they synced, read-only. Signing out clears the cached data.

## Security model

The site is public, so the **backend is the only trust boundary**. Everything in the browser is treated as untrusted.

| Layer | Measure |
|---|---|
| Identity | Every request carries a Google ID token. `Code.gs` checks the token's shape, `aud` and `exp` locally, then verifies it with Google's `tokeninfo` endpoint (`iss`, `email_verified`). Verified tokens are cached for 5 minutes. If the request claims a `userEmail`, it must match the token. |
| Authorization | The allow-list lives in the `Members` sheet and is re-checked on every request. Actions are dispatched through an own-property allow-list, so prototype names cannot be called. Admin actions are refused for Atithis, and each attempt is written to `AuditLog` as `Security`. |
| Data minimisation | Atithis receive the itinerary and only their own travel rows. The full Logistics list (phone numbers) and the member list go to Admins only. The browser keeps them in memory and never writes them to storage. |
| Input | The request body is capped at 10 KB and must be a JSON object. Each field is type- and length-checked. Emails follow a strict pattern. Status and role values come from fixed lists. |
| Sheet safety | Any value starting with `= + - @` (and tab/CR) is prefixed with `'`. This blocks formula/CSV injection into the Sheet. |
| Abuse | Each user is rate-limited to 60 requests per minute (CacheService). Errors return generic messages; details stay in the Apps Script logs. |
| Secrets | The OneSignal REST key exists only in Script Properties. `config.js` holds public identifiers only. |
| Browser | Strict CSP: scripts only from self, Google Identity and OneSignal; no inline script or `eval`. Strict referrer policy. JS frame-busting (Pages cannot send `frame-ancestors`). The ID token is kept in **sessionStorage** only; `localStorage` holds just the schedule and a token-free name/email for offline mode. Server text is rendered with `textContent` or HTML-escaped. Avatars must be `*.googleusercontent.com` URLs. `fetch` omits credentials and the referrer. |
| Service worker | Only same-origin `basic` responses are cached. Backend, auth and push traffic is never intercepted. |

**Known limits.** GitHub Pages cannot send real HTTP security headers, so the CSP is delivered in a `<meta>` tag (no `'unsafe-inline'`; `script-src` must allow `https://api.onesignal.com` for OneSignal's config call). For full header control, put the site behind Cloudflare or a similar proxy. Apps Script quotas apply; see Google's quota page for limits on `UrlFetch` and executions.

## Notes
- **iOS:** web push only works once the app is installed with **Share → Add to Home Screen** (iOS 16.4+). The app shows a hint for this.
- **WhatsApp:** the message opens through `https://api.whatsapp.com/send?text=…` in a new tab. The tab is opened right when you tap, so popup blockers don't stop it.
- **Caching:** after changing any frontend file, bump `CACHE_VERSION` in `service-worker.js`.
- **Capacity:** 200 guests × 2 h/day at the default 60 s refresh is ~24k requests/day and well within free Apps Script quotas. See the developer guide, section 8.
- **After the event:** follow the decommissioning checklist in the developer guide, section 9 (archive the web app, revoke the OneSignal key, delete the OAuth client, unpublish Pages, make the repo private).
