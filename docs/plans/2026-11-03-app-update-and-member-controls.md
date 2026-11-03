# App Update and Member Controls Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use engineering-lifecycle:implementing-with-tdd to implement this plan task-by-task.

**Goal:** Detect deployed PWA updates and offer a safe reload while improving member search and collapsing per-member group editing.

**Architecture:** Extend the existing service-worker registration with an `AppUpdate` coordinator that checks on registration, every 30 minutes, and on foreground. A controller change shows a banner and schedules a guarded reload. Keep member filtering in `Views.members`, but render it as a dedicated search card and move each group editor into a native `<details>` disclosure.

**Tech Stack:** Vanilla JavaScript, Service Worker API, HTML `<details>`, Tailwind CSS, Node test runner, Playwright.

---

### Task 1: Service-worker update card

**Files:**
- Modify: `tests/e2e.smoke.js:200-224`
- Modify: `tests/e2e.smoke.js:450-490`
- Modify: `index.html:76-97`
- Modify: `app.js:2430-2453`

**Step 1: Add a controllable service-worker stub to the browser harness**

Extend `newPage` with an optional `serviceWorkerStub` flag. When enabled, install an `EventTarget`-based `navigator.serviceWorker` stub before application code runs:

```js
const workerEvents = new EventTarget();
const registration = { updateCalls: 0, update: async () => { registration.updateCalls += 1; } };
Object.defineProperty(navigator, 'serviceWorker', {
  configurable: true,
  value: Object.assign(workerEvents, {
    controller: {},
    register: async () => registration,
  }),
});
window.__swRegistration = registration;
window.__activateAppUpdate = () => workerEvents.dispatchEvent(new Event('controllerchange'));
```

Keep this opt-in so the rest of the suite continues blocking real service workers.

**Step 2: Write failing update-card tests**

Add assertions that:

```js
assert(await updatePage.evaluate(() => window.__swRegistration.updateCalls) >= 1,
  'service worker checks for an update after registration');
await updatePage.evaluate(() => window.__activateAppUpdate());
assert(await visible(updatePage, '#banner-update'), 'an activated update shows the update card');
assert((await updatePage.textContent('#update-text')).includes('App updated'),
  'update card explains that a reload is ready');
```

Click `#update-btn`, record a `beforeunload` marker in `sessionStorage`, and assert the page reloads. Add a second page using Playwright's clock to advance 30 seconds; verify focused form input blocks automatic reload, then blur it and advance the retry timer to verify reload proceeds.

**Step 3: Run the browser test and confirm RED**

Run:

```bash
npm run test:e2e
```

Expected: FAIL because `#banner-update` and update coordination do not exist.

**Step 4: Add the update banner**

Add a hidden card inside `#banners`, matching the install/notification-card visual language:

```html
<div id="banner-update" class="hidden rounded-2xl bg-kumkum-900 text-ivory-100 p-4 items-center gap-3 shadow-lift" role="status">
  <div class="text-2xl" aria-hidden="true">✨</div>
  <div class="flex-1 min-w-0">
    <p class="font-semibold text-sm">App updated</p>
    <p id="update-text" class="text-xs text-ivory-100/80">Reload to use the latest version.</p>
  </div>
  <button id="update-btn" type="button" class="btn-gold btn-sm shrink-0">Reload</button>
</div>
```

**Step 5: Implement the update coordinator**

Add constants:

```js
const UPDATE_CHECK_MS = 30 * 60 * 1000;
const UPDATE_RELOAD_DELAY_MS = 30 * 1000;
const UPDATE_RETRY_MS = 1000;
```

Add an `AppUpdate` object that:

- records whether the page started with a controlling worker;
- subscribes to `controllerchange` before registration;
- ignores the first controller on a first-time installation;
- shows `#banner-update` for a replacement controller;
- calls `registration.update()` immediately, every 30 minutes, and when visibility becomes `visible`;
- catches update failures and logs `console.warn('Service worker update check failed', err)`;
- reloads after 30 seconds only when `Store.state.pending.size === 0`, modal root is empty, `Tour.active` and `Welcome.open` are false, and focus is not in a form/editable control;
- retries the safe-reload check every second while blocked;
- reloads immediately when `#update-btn` is clicked.

Have `registerServiceWorker()` delegate to this coordinator.

**Step 6: Run the update tests and confirm GREEN**

Run:

```bash
npm run test:e2e
```

Expected: update-card assertions pass without breaking existing PWA installation tests.

**Step 7: Commit**

```bash
git add index.html app.js tests/e2e.smoke.js
git commit -m "feat: prompt installed apps to reload updates"
```

### Task 2: Member search card

**Files:**
- Modify: `tests/e2e.smoke.js:595-665`
- Modify: `app.js:1605-1695`

**Step 1: Write failing search-card tests**

Add browser assertions for:

```js
assert(await page.isVisible('[data-section="member-search"]'), 'member search has a dedicated card');
assert((await page.textContent('[data-section="member-search"]')).includes('Find a member'),
  'member search has a visible label');
await page.fill('[data-action="member-search"]', 'viewer');
assert((await page.textContent('[data-member-search-count]')).includes('1 of 2'),
  'member search reports the filtered result count');
assert(await page.isVisible('[data-action="member-search-clear"]'), 'search query exposes a clear action');
await page.click('[data-action="member-search-clear"]');
assert(await page.inputValue('[data-action="member-search"]') === '', 'clear resets member search');
```

Retain the existing focus/caret behavior assertion or add one while typing.

**Step 2: Run the browser test and confirm RED**

Run:

```bash
npm run test:e2e
```

Expected: FAIL because the search section, count, and clear action do not exist.

**Step 3: Render the festive search card**

Replace the standalone search input with a compact `data-section="member-search"` card containing:

- a magnifier icon;
- a visible `Find a member` label;
- the existing `data-action="member-search"` input;
- `data-member-search-count` text using `${list.length} of ${s.members.length}`;
- a `data-action="member-search-clear"` button only when the query is non-empty.

Keep the existing filtering expression unchanged.

**Step 4: Wire the Clear action**

In delegated click handling:

```js
case 'member-search-clear':
  Store.set({ memberSearch: '' });
  requestAnimationFrame(() => $('[data-action="member-search"]')?.focus());
  break;
```

Do not persist the query or add new state.

**Step 5: Run the browser test and confirm GREEN**

Run:

```bash
npm run test:e2e
```

Expected: all search-card and existing member-management assertions pass.

**Step 6: Commit**

```bash
git add app.js tests/e2e.smoke.js
git commit -m "feat: improve member search"
```

### Task 3: Collapsible member group controls

**Files:**
- Modify: `tests/e2e.smoke.js:595-665`
- Modify: `app.js:1621-1652`

**Step 1: Write failing disclosure tests**

For the first member card, assert:

```js
const details = page.locator('[data-member-groups]').first();
assert(!(await details.getAttribute('open')), 'member groups are collapsed by default');
assert(!(await details.locator('[data-action="save-member-groups"]').isVisible()),
  'collapsed groups hide their editor and save action');
assert(await page.locator('[data-action="set-role"]').first().isVisible(),
  'role remains visible while groups are collapsed');
await details.locator('summary').click();
assert(await details.locator('[data-action="save-member-groups"]').isVisible(),
  'group disclosure reveals the existing editor');
```

Also assert the summary contains `Groups` and the assigned-group count.

**Step 2: Run the browser test and confirm RED**

Run:

```bash
npm run test:e2e
```

Expected: FAIL because group controls are always expanded.

**Step 3: Move group editing into `<details>`**

Wrap only the group picker and Save button:

```html
<details data-member-groups class="group mt-2 rounded-xl border border-haldi-200 bg-ivory-100/60">
  <summary class="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-2 px-3 text-xs font-semibold text-ink-600">
    <span>Groups · N assigned</span>
    <span class="transition-transform group-open:rotate-180" aria-hidden="true">⌄</span>
  </summary>
  <div class="border-t border-haldi-200 p-3">
    <!-- existing picker and Save groups button -->
  </div>
</details>
```

Use the saved member group count for `N`. Preserve the existing picker action, draft source, pending key, and Save handler unchanged.

**Step 4: Run the browser test and confirm GREEN**

Run:

```bash
npm run test:e2e
```

Expected: disclosures are closed by default, expand accessibly, and existing group-save behavior passes.

**Step 5: Commit**

```bash
git add app.js tests/e2e.smoke.js
git commit -m "feat: collapse member group controls"
```

### Task 4: Styling, cache, documentation, and final validation

**Files:**
- Modify: `styles.css`
- Modify: `service-worker.js:10`
- Modify: `docs/DEVELOPER_GUIDE.md:105-118`
- Modify: `docs/DEVELOPER_GUIDE.md:190-200`

**Step 1: Build Tailwind output**

Run:

```bash
npm run build:css
```

Expected: `styles.css` is regenerated with the new banner, search-card, and disclosure classes.

**Step 2: Bump the shell cache**

Change:

```js
const CACHE_VERSION = 'v1.7.10';
```

This ensures installed clients download the changed HTML, JavaScript, and CSS.

**Step 3: Update the Developer Guide**

Document:

- 30-minute and foreground service-worker update checks;
- persistent update card and guarded 30-second reload;
- close/reopen resolution without reinstall;
- member search card;
- collapsed member group disclosures.

Add a `v1.7.10` changelog entry.

**Step 4: Run all existing validation**

Run:

```bash
npm test
npm run test:e2e
git diff --check
```

Expected: unit tests and browser tests pass; diff check prints nothing.

**Step 5: Review quality and security**

Inspect the final diff for:

- no token or secret persistence;
- no service-worker update loop;
- no reload during pending actions or editable UI;
- accessible names and 44px touch targets;
- escaped dynamic member data;
- no changes to backend authorization or sheet behavior.

Run the repository's available static/IDE inspections; treat any new high-confidence Sonar-style issue as blocking.

**Step 6: Commit**

```bash
git add styles.css service-worker.js docs/DEVELOPER_GUIDE.md
git commit -m "docs: describe automatic PWA updates"
```

