/* =============================================================================
 *  Event Companion PWA — app.js
 *  Modules: Utils · Store · Api · Auth · Push · WhatsApp · Install · Views · Actions
 * ===========================================================================*/
(() => {
  'use strict';

  // Clickjacking defence: GitHub Pages cannot send X-Frame-Options / frame-ancestors.
  if (window.top !== window.self) {
    try { window.top.location.replace(window.self.location.href); } catch { /* cross-origin parent */ }
    document.documentElement.replaceChildren();
    return;
  }

  const CONFIG = window.APP_CONFIG || {};
  const BASE_PATH = location.pathname.replace(/[^/]*$/, ''); // e.g. "/jan-wed-1/"
  // The ID token is a bearer credential: keep it in sessionStorage (tab-scoped, gone on close).
  // GIS auto-select silently re-issues one on the next launch.
  const STORAGE = { CREDENTIAL: 'evt.credential', LAST_USER: 'evt.lastUser', DATA_CACHE: 'evt.data', INSTALL_DISMISSED: 'evt.installDismissed' };
  const ROLES = ['Admin', 'Viewer'];
  const EMAIL_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}$/;
  const BACKEND_RE = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;
  const isPlaceholder = (v) => !v || /REPLACE_WITH/i.test(String(v));

  /* ---------------------------------------------------------------- Utils */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"'`]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]
  ));

  /** Only Google-hosted avatars are rendered; anything else is dropped. */
  const safePicture = (url) => (/^https:\/\/[a-z0-9.-]+\.googleusercontent\.com\//i.test(String(url || '')) ? String(url) : '');

  const formatDateTime = (value) => {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  const timeAgo = (date) => {
    if (!date) return 'never';
    const secs = Math.round((Date.now() - new Date(date).getTime()) / 1000);
    if (secs < 45) return 'just now';
    if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
    return new Date(date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  };

  /** Display-only decode; the backend verifies the signature with Google on every call. */
  const decodeJwt = (token) => {
    try {
      const b64 = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const json = decodeURIComponent(atob(b64).split('').map((c) => `%${(`00${c.charCodeAt(0).toString(16)}`).slice(-2)}`).join(''));
      return JSON.parse(json);
    } catch {
      return null;
    }
  };

  const makeStorage = (area) => ({
    get(key) { try { return JSON.parse(window[area].getItem(key)); } catch { return null; } },
    set(key, value) { try { window[area].setItem(key, JSON.stringify(value)); } catch { /* quota / private mode */ } },
    remove(key) { try { window[area].removeItem(key); } catch { /* ignore */ } },
  });
  const storage = makeStorage('localStorage');
  const sessionStore = makeStorage('sessionStorage');

  const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  const waitFor = (predicate, timeoutMs = 10000, intervalMs = 100) => new Promise((resolve, reject) => {
    const start = Date.now();
    (function check() {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() - start > timeoutMs) return reject(new Error('Timed out waiting for dependency'));
      setTimeout(check, intervalMs);
    })();
  });

  /* ---------------------------------------------------------------- Store */
  const Store = {
    state: {
      itinerary: [],
      logistics: [],
      members: [],
      user: null,          // { email, name, picture, idToken, exp }
      // 'checking' | 'signed-out' | 'denied' | 'authed' | 'offline' (cached read-only)
      authStatus: 'checking',
      deniedEmail: null,
      gsiReady: false,
      role: null,
      isAdmin: false,
      tab: 'schedule',
      loading: false,
      error: null,
      lastSynced: null,
      online: navigator.onLine,
      pickupFilter: 'all',
      pickupSearch: '',
      memberSearch: '',
      tourStatus: 'Completed', // real value arrives with the session; never tour before that
      pending: new Set(), // keys of in-flight admin actions
    },
    listeners: new Set(),
    set(patch) {
      Object.assign(this.state, patch);
      this.listeners.forEach((fn) => fn(this.state));
    },
    subscribe(fn) { this.listeners.add(fn); },
    setPending(key, on) {
      if (on) this.state.pending.add(key); else this.state.pending.delete(key);
      this.set({});
    },
    isPending(key) { return this.state.pending.has(key); },
  };

  /* ------------------------------------------------------------------ Api */
  class ApiError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }

  const Api = {
    configured() { return BACKEND_RE.test(String(CONFIG.APPS_SCRIPT_URL || '')); },

    async request(url, options = {}) {
      if (!this.configured()) throw new ApiError('CONFIG', 'Backend URL is not configured correctly in config.js.');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS || 25000);
      let res;
      try {
        res = await fetch(url, {
          ...options, signal: controller.signal, redirect: 'follow', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
        });
      } catch (err) {
        if (err.name === 'AbortError') throw new ApiError('TIMEOUT', 'The server took too long to respond.');
        throw new ApiError('NETWORK', navigator.onLine ? 'Could not reach the server.' : 'You appear to be offline.');
      } finally {
        clearTimeout(timer);
      }
      let body;
      try { body = await res.json(); } catch { throw new ApiError('BAD_RESPONSE', `Unexpected server response (HTTP ${res.status}).`); }
      if (!body || body.ok !== true) throw new ApiError(String(body?.code || 'SERVER_ERROR'), String(body?.error || 'Request failed.').slice(0, 300));
      return body.data;
    },

    /** Every POST carries the verified identity + timestamp for the AuditLog. */
    async post(action, payload = {}) {
      const user = Store.state.user;
      if (!user || Auth.isExpired(user)) {
        Auth.handleExpired();
        throw new ApiError('AUTH_EXPIRED', 'Your session expired. Please sign in again.');
      }
      try {
        return await this.request(CONFIG.APPS_SCRIPT_URL, {
          method: 'POST',
          // text/plain avoids a CORS preflight, which Apps Script cannot answer.
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action, payload, idToken: user.idToken, userEmail: user.email, timestamp: new Date().toISOString() }),
        });
      } catch (err) {
        if (Store.state.user?.idToken !== user.idToken) throw err; // identity changed meanwhile
        if (['AUTH_EXPIRED', 'AUTH_INVALID', 'AUTH_REQUIRED'].includes(err.code)) Auth.handleExpired();
        if (err.code === 'NOT_MEMBER') Auth.deny(user.email);
        // Role was downgraded server-side since the last sync: drop admin data now, then resync.
        if (err.code === 'FORBIDDEN' && /not authorized/i.test(err.message)) {
          Store.set({ isAdmin: false, role: 'Viewer', tab: 'schedule', logistics: [], members: [] });
          Auth.loadSession();
        }
        throw err;
      }
    },
  };

  /* ----------------------------------------------------------------- Auth */
  const Auth = {
    epoch: 0, // bumped whenever the signed-in identity ends/changes; stale responses are dropped
    renewTimer: null,

    isExpired(user) { return !user?.exp || user.exp * 1000 < Date.now() + 30000; },

    async init() {
      storage.remove(STORAGE.CREDENTIAL); // migrate: tokens used to be kept in localStorage
      const saved = sessionStore.get(STORAGE.CREDENTIAL);
      if (saved?.idToken && !this.isExpired(saved)) {
        Store.set({ user: saved, authStatus: 'checking' });
        this.loadSession();
      } else if (!navigator.onLine && this.restoreOffline()) {
        // Previously verified member, offline: show the cached schedule read-only.
      } else {
        sessionStore.remove(STORAGE.CREDENTIAL);
        Store.set({ authStatus: 'signed-out' });
      }

      if (isPlaceholder(CONFIG.GOOGLE_CLIENT_ID)) { Store.set({ gsiReady: true }); return; }
      try {
        await waitFor(() => window.google?.accounts?.id, 15000);
        google.accounts.id.initialize({
          client_id: CONFIG.GOOGLE_CLIENT_ID,
          callback: (resp) => this.onCredential(resp),
          auto_select: true,           // returning members are signed in silently
          cancel_on_tap_outside: false,
          use_fedcm_for_prompt: true,
          itp_support: true,
        });
        Store.set({ gsiReady: true });
        if (Store.state.authStatus === 'signed-out') this.prompt();
      } catch (err) {
        console.warn('Google Identity Services failed to load', err);
        Store.set({ gsiReady: true });
      }
    },

    /** One Tap / automatic re-sign-in. Safe to call repeatedly. */
    prompt() {
      try { window.google?.accounts?.id?.prompt(); } catch { /* ignore */ }
    },

    /** Offline only: the last verified member on this device sees the cached schedule (no token, no admin data). */
    restoreOffline() {
      const last = storage.get(STORAGE.LAST_USER);
      const cache = storage.get(STORAGE.DATA_CACHE);
      if (!last?.email || !Array.isArray(cache?.itinerary) || cache.email !== last.email) return false;
      Store.set({
        user: { email: last.email, name: last.name || last.email, picture: safePicture(last.picture) },
        authStatus: 'offline', role: cache.role || 'Viewer', isAdmin: false, logistics: [], members: [],
        itinerary: cache.itinerary, lastSynced: cache.savedAt,
      });
      return true;
    },

    renderButton(container) {
      if (!container) return;
      if (isPlaceholder(CONFIG.GOOGLE_CLIENT_ID)) {
        container.innerHTML = '<p class="text-sm text-rose-600">Google Client ID is not configured in config.js.</p>';
        return;
      }
      if (!window.google?.accounts?.id) {
        container.innerHTML = '<p class="text-sm text-slate-500"><span class="spinner"></span> Loading Google sign-in…</p>';
        return;
      }
      container.innerHTML = '';
      google.accounts.id.renderButton(container, { type: 'standard', theme: 'filled_blue', size: 'large', shape: 'pill', text: 'signin_with', width: 280 });
    },

    onCredential(response) {
      const claims = decodeJwt(response?.credential);
      // Cheap client-side sanity checks; the server re-verifies signature, aud, iss and exp.
      if (!claims?.email || claims.aud !== CONFIG.GOOGLE_CLIENT_ID || claims.email_verified === false) {
        Toast.show('Sign-in failed. Please try again.', 'error');
        return;
      }
      const user = {
        email: String(claims.email).toLowerCase(),
        name: String(claims.name || claims.email).slice(0, 100),
        picture: safePicture(claims.picture),
        idToken: response.credential,
        exp: claims.exp,
      };
      const wasAuthed = Store.state.authStatus === 'authed' && Store.state.user?.email === user.email;
      sessionStore.set(STORAGE.CREDENTIAL, user);
      if (!wasAuthed) this.epoch += 1; // a different identity: discard any in-flight responses
      Store.set({ user, deniedEmail: null, authStatus: wasAuthed ? 'authed' : 'checking', ...(wasAuthed ? {} : { loading: false }) });
      Modal.close();
      this.loadSession(!wasAuthed);
    },

    async loadSession(announce = false) {
      if (Store.state.loading && !announce) return;
      const epoch = this.epoch;
      const stale = () => epoch !== this.epoch;
      Store.set({ loading: true });
      try {
        const data = await Api.post('session');
        if (stale()) return;
        const savedAt = new Date().toISOString();
        const isAdmin = data.isAdmin === true && data.role === 'Admin';
        const user = {
          ...Store.state.user,
          name: String(data.name || Store.state.user.name).slice(0, 100),
          picture: safePicture(data.picture) || Store.state.user.picture,
        };
        // Persist only what offline mode needs: the schedule and a token-free identity.
        storage.set(STORAGE.DATA_CACHE, { email: user.email, role: isAdmin ? 'Admin' : 'Viewer', itinerary: data.itinerary, savedAt });
        storage.set(STORAGE.LAST_USER, { email: user.email, name: user.name, picture: user.picture });
        Store.set({
          authStatus: 'authed',
          role: isAdmin ? 'Admin' : 'Viewer',
          isAdmin,
          itinerary: Array.isArray(data.itinerary) ? data.itinerary : [],
          logistics: isAdmin && Array.isArray(data.logistics) ? data.logistics : [],
          members: isAdmin && Array.isArray(data.members) ? data.members : [],
          lastSynced: savedAt,
          error: null,
          tourStatus: ['Pending', 'Completed', 'Skipped'].includes(data.tourStatus) ? data.tourStatus : 'Completed',
          user,
        });
        Nudges.onSync();
        if (announce) Welcome.show(user, { isAdmin, onClose: () => Tour.maybeStart() });
        else Tour.maybeStart();
      } catch (err) {
        if (stale()) return;
        if (['AUTH_EXPIRED', 'AUTH_INVALID', 'AUTH_REQUIRED', 'NOT_MEMBER'].includes(err.code)) return;
        if (Store.state.authStatus === 'checking') {
          // Couldn't verify (network/server). Fall back to cache if this member was verified before.
          if (!this.restoreOffline()) Store.set({ authStatus: 'signed-out' });
        }
        Store.set({ error: err.message });
        Toast.show(`Could not sync: ${err.message}`, 'error');
      } finally {
        if (!stale()) Store.set({ loading: false });
      }
    },

    clearSession(patch) {
      this.epoch += 1;
      Tour.cancel();
      Nudges.reset();
      sessionStore.remove(STORAGE.CREDENTIAL);
      storage.remove(STORAGE.CREDENTIAL);
      storage.remove(STORAGE.LAST_USER);
      storage.remove(STORAGE.DATA_CACHE);
      Store.set({ user: null, role: null, isAdmin: false, loading: false, itinerary: [], logistics: [], members: [], tab: 'schedule', lastSynced: null, ...patch });
    },

    deny(email) {
      try { window.google?.accounts?.id?.disableAutoSelect(); } catch { /* ignore */ }
      this.clearSession({ authStatus: 'denied', deniedEmail: email });
      Modal.close();
    },

    handleExpired() {
      this.epoch += 1;
      sessionStore.remove(STORAGE.CREDENTIAL);
      // Admin-only data must not linger on screen after the session ends.
      Store.set({ authStatus: 'signed-out', user: null, isAdmin: false, role: null, logistics: [], members: [], loading: false, tab: 'schedule' });
      Modal.close();
      Tour.cancel();
      this.prompt();
      Toast.show('Your session expired — please sign in again.', 'info');
    },

    signOut() {
      try { window.google?.accounts?.id?.disableAutoSelect(); } catch { /* ignore */ }
      this.clearSession({ authStatus: 'signed-out', deniedEmail: null });
      Modal.close();
      Toast.show('Signed out.', 'info');
    },

    /** Proactively refresh the ID token shortly before it expires (tokens last ~1h). */
    scheduleRenewal() {
      clearInterval(this.renewTimer);
      this.renewTimer = setInterval(() => {
        const u = Store.state.user;
        if (Store.state.authStatus === 'authed' && u && u.exp * 1000 - Date.now() < 5 * 60 * 1000) this.prompt();
      }, 60000);
    },
  };

  /* ----------------------------------------------------------------- Push */
  const Push = {
    sdk: null,
    supported: 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window,

    init() {
      if (isPlaceholder(CONFIG.ONESIGNAL_APP_ID)) { this.render(); return; }
      window.OneSignalDeferred = window.OneSignalDeferred || [];
      window.OneSignalDeferred.push(async (OneSignal) => {
        try {
          await OneSignal.init({
            appId: CONFIG.ONESIGNAL_APP_ID,
            serviceWorkerPath: `${BASE_PATH}service-worker.js`,
            serviceWorkerParam: { scope: BASE_PATH },
            allowLocalhostAsSecureOrigin: ['localhost', '127.0.0.1'].includes(location.hostname),
            notifyButton: { enable: false },
          });
          this.sdk = OneSignal;
          OneSignal.Notifications.addEventListener('permissionChange', () => this.render());
          OneSignal.User.PushSubscription.addEventListener('change', () => this.render());
        } catch (err) {
          console.warn('OneSignal init failed', err);
        }
        this.render();
      });
      this.render();
    },

    status() {
      if (isPlaceholder(CONFIG.ONESIGNAL_APP_ID)) return 'unconfigured';
      if (isIos() && !isStandalone()) return 'ios-install';
      if (!this.supported) return 'unsupported';
      if (Notification.permission === 'denied') return 'denied';
      if (!this.sdk) return 'loading';
      if (this.sdk.Notifications.permission && this.sdk.User.PushSubscription.optedIn) return 'subscribed';
      return 'prompt';
    },

    render() {
      const banner = $('#banner-notify');
      const btn = $('#notify-btn');
      const text = $('#notify-text');
      const status = this.status();
      const authed = ['authed', 'offline'].includes(Store.state.authStatus);
      const copy = {
        'ios-install': ['On iPhone/iPad, tap Share → "Add to Home Screen", then open the app to enable notifications.', null],
        unsupported: ['This browser does not support push notifications.', null],
        denied: ['Notifications are blocked. Enable them in your browser/site settings.', null],
        loading: ['Let us call you the moment a ceremony begins.', 'Loading…'],
        prompt: ['Let us call you the moment a ceremony begins 🪔', 'Notify me'],
      };
      if (!authed || status === 'subscribed' || status === 'unconfigured') { banner.classList.add('hidden'); return; }
      const [message, label] = copy[status];
      banner.classList.remove('hidden');
      banner.classList.add('flex');
      text.textContent = message;
      btn.classList.toggle('hidden', !label);
      btn.disabled = status === 'loading';
      if (label) btn.textContent = label;
    },

    async request() {
      if (!this.sdk) return;
      const btn = $('#notify-btn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>';
      try {
        await this.sdk.Notifications.requestPermission(); // triggers native browser prompt
        if (this.sdk.Notifications.permission && !this.sdk.User.PushSubscription.optedIn) {
          await this.sdk.User.PushSubscription.optIn();
        }
        if (this.sdk.Notifications.permission) Toast.show('Notifications enabled 🔔', 'success');
      } catch (err) {
        Toast.show(`Could not enable notifications: ${err.message || err}`, 'error');
      } finally {
        this.render();
      }
    },
  };

  /* ------------------------------------------------------------- WhatsApp */
  const WhatsApp = {
    MAX_LEN: 2000,
    buildMessage(event) {
      return [
        '*🚨 Live Now!*',
        '',
        `*Event:* ${event.title}`,
        `*Location:* ${event.location || 'TBA'}`,
        `*Time:* ${[event.day, event.time].filter(Boolean).join(', ') || 'Now'}`,
        '',
        'Please gather at the venue!',
      ].join('\n');
    },
    buildUrl(message) {
      return `https://api.whatsapp.com/send?text=${encodeURIComponent(String(message).slice(0, this.MAX_LEN))}`;
    },
    /** Must be called synchronously inside a user gesture to avoid popup blockers. */
    open(message) {
      const win = window.open(this.buildUrl(message), '_blank', 'noopener,noreferrer');
      if (win) win.opener = null; // belt-and-braces against reverse tabnabbing
    },
  };

  /* -------------------------------------------------------------- Install */
  const Install = {
    deferred: null,
    init() {
      const banner = $('#banner-install');
      if (isStandalone() || storage.get(STORAGE.INSTALL_DISMISSED)) return;

      window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        this.deferred = e;
        $('#install-btn').classList.remove('hidden');
        banner.classList.remove('hidden');
        banner.classList.add('flex');
      });
      if (isIos()) {
        $('#install-text').textContent = 'Install: tap Share ⎋ then "Add to Home Screen".';
        banner.classList.remove('hidden');
        banner.classList.add('flex');
      }
      window.addEventListener('appinstalled', () => banner.classList.add('hidden'));

      $('#install-btn').addEventListener('click', async () => {
        if (!this.deferred) return;
        this.deferred.prompt();
        await this.deferred.userChoice.catch(() => null);
        this.deferred = null;
        banner.classList.add('hidden');
      });
      $('#install-dismiss').addEventListener('click', () => {
        storage.set(STORAGE.INSTALL_DISMISSED, true);
        banner.classList.add('hidden');
      });
    },
  };

  /* ---------------------------------------------------------- Toast/Modal */
  const Toast = {
    show(message, type = 'info', ms = 3800) {
      const colors = {
        success: 'bg-mehndi-700 text-ivory-50',
        error: 'bg-kumkum-700 text-ivory-50',
        info: 'bg-ink-800 text-ivory-50',
      };
      const el = document.createElement('div');
      el.setAttribute('role', type === 'error' ? 'alert' : 'status');
      el.className = `pointer-events-auto max-w-sm w-full rounded-2xl px-4 py-3 text-sm shadow-lift ring-1 ring-haldi-400/40 sheet-enter ${colors[type] || colors.info}`;
      el.textContent = String(message ?? '').slice(0, 300); // never innerHTML: may contain server text
      const root = $('#toast-root');
      while (root.childElementCount >= 3) root.firstElementChild.remove();
      root.appendChild(el);
      setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, ms);
    },
  };

  const Modal = {
    open(html, { onMount } = {}) {
      const root = $('#modal-root');
      root.innerHTML = `
        <div class="fixed inset-0 z-40 bg-ink-900/60 backdrop-blur-[2px] flex items-end sm:items-center justify-center" data-modal-backdrop>
          <div class="sheet-enter safe-bottom relative w-full sm:max-w-md bg-ivory-50 rounded-t-3xl sm:rounded-3xl p-5 max-h-[90vh] overflow-y-auto shadow-lift ring-1 ring-haldi-300/60" role="dialog" aria-modal="true">
            <div class="toran absolute inset-x-0 top-0 rounded-t-3xl" aria-hidden="true"></div>
            <div class="pt-2">${html}</div>
          </div>
        </div>`;
      root.querySelector('[data-modal-backdrop]').addEventListener('click', (e) => {
        if (e.target.hasAttribute('data-modal-backdrop')) this.close();
      });
      onMount?.(root);
      root.querySelector('button')?.focus();
    },
    close() { $('#modal-root').innerHTML = ''; },
  };

  /* -------------------------------------------------------------- Festive */
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const firstNameOf = (user) => String(user?.name || user?.email || 'Guest').split(/[\s@]/)[0].slice(0, 40);

  const Festive = {
    greeting(date = new Date()) {
      const h = date.getHours();
      if (h < 12) return { hi: 'शुभ प्रभात', en: 'Good morning' };
      if (h < 17) return { hi: 'नमस्ते', en: 'Good afternoon' };
      return { hi: 'शुभ संध्या', en: 'Good evening' };
    },

    /** A gentle shower of marigold & rose petals. Purely decorative; skipped for reduced motion. */
    petals(count = 26) {
      if (reducedMotion()) return;
      const layer = document.createElement('div');
      layer.className = 'fixed inset-0 z-[80] pointer-events-none overflow-hidden';
      layer.setAttribute('aria-hidden', 'true');
      const kinds = ['🌼', '🌸', '🏵️', '🌺'];
      for (let i = 0; i < count; i++) {
        const p = document.createElement('span');
        p.className = 'petal';
        p.textContent = kinds[i % kinds.length];
        p.style.left = `${Math.random() * 100}%`;
        p.style.fontSize = `${14 + Math.random() * 14}px`;
        p.style.animationDuration = `${3.5 + Math.random() * 3}s`;
        p.style.animationDelay = `${Math.random() * 1.2}s`;
        p.style.setProperty('--drift', `${(Math.random() - 0.5) * 160}px`);
        layer.appendChild(p);
      }
      document.body.appendChild(layer);
      setTimeout(() => layer.remove(), 8000);
    },
  };

  /** Small, warm prompts triggered by data changes (not by timers, so they never nag). */
  const Nudges = {
    seenLive: null,
    remember() { this.seenLive = new Set(Store.state.itinerary.filter((e) => e.status === 'Live').map((e) => e.id)); },
    onSync() {
      if (!this.seenLive) { this.remember(); return; } // first sync: nothing is "new"
      const fresh = Store.state.itinerary.filter((e) => e.status === 'Live' && !this.seenLive.has(e.id));
      this.remember();
      if (!fresh.length) return;
      const e = fresh[0];
      Toast.show(`🪔 ${e.title} has begun${e.location ? ` at ${e.location}` : ''} — please join us!`, 'success', 6500);
      Festive.petals(20);
    },
    reset() { this.seenLive = null; },
  };

  const mapsLink = (location) => (location
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(String(location).slice(0, 200))}`
    : '');

  /* -------------------------------------------------------------- Welcome */
  // Auspicious opening: Ganesh Vandana, then a personal welcome. Once per browser session.
  const Welcome = {
    KEY: 'evt.welcomed',
    open: false,

    shouldShow(email) { return sessionStore.get(this.KEY) !== email; },

    show(user, { isAdmin = false, onClose } = {}) {
      if (this.open) return;
      if (!this.shouldShow(user.email)) { onClose?.(); return; }
      this.open = true;
      sessionStore.set(this.KEY, user.email);

      const eventName = escapeHtml(CONFIG.EVENT_NAME || 'our celebration');
      const hosts = CONFIG.EVENT_HOSTS ? `<p class="mt-3 text-xs text-haldi-200/90">With love &amp; blessings — ${escapeHtml(CONFIG.EVENT_HOSTS)}</p>` : '';
      const overlay = document.createElement('div');
      overlay.id = 'welcome-splash';
      overlay.className = 'welcome-splash fixed inset-0 z-[70] flex items-center justify-center text-center px-6 text-ivory-50 overflow-hidden';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'welcome-title');
      overlay.innerHTML = `
        <img src="icons/mandala.svg" alt="" aria-hidden="true" class="welcome-mandala absolute w-[140vmin] max-w-none opacity-25" />
        <div class="relative max-w-sm">
          <div class="welcome-om mx-auto grid place-items-center w-28 h-28 rounded-full bg-gradient-to-b from-haldi-300 to-marigold-500 text-kumkum-800 shadow-lift ring-4 ring-haldi-200/60">
            <span class="font-display text-6xl leading-none translate-y-1" lang="sa">ॐ</span>
          </div>
          <p class="welcome-line delay-1 mt-6 font-display text-2xl text-haldi-200" lang="sa">॥ श्री गणेशाय नमः ॥</p>
          <p class="welcome-line delay-2 mt-3 text-sm leading-relaxed text-ivory-100/90" lang="sa">
            वक्रतुण्ड महाकाय सूर्यकोटि समप्रभ ।<br />निर्विघ्नं कुरु मे देव सर्वकार्येषु सर्वदा ॥
          </p>
          <p class="welcome-line delay-2 mt-2 text-[11px] italic text-ivory-100/70">
            O Lord Ganesha, radiant as a million suns — remove every obstacle from all our endeavours, always.
          </p>
          <div class="welcome-line delay-3 paisley-divider my-5" aria-hidden="true"></div>
          <h2 id="welcome-title" class="welcome-line delay-3 font-display text-3xl text-ivory-50">स्वागतम्, ${escapeHtml(firstNameOf(user))} ji 🙏</h2>
          <p class="welcome-line delay-3 mt-2 text-sm text-ivory-100/90">
            ${isAdmin ? 'Thank you for hosting with us. Everything you need to run' : 'With joy in our hearts, we welcome you to'} <b class="text-haldi-200">${eventName}</b>.
          </p>
          ${hosts}
          <div class="welcome-line delay-4 mt-6 flex items-center justify-center gap-3 text-2xl" aria-hidden="true">
            <span class="diya">🪔</span><span class="diya delay-1">🪔</span><span class="diya delay-2">🪔</span>
          </div>
          <button type="button" data-welcome="enter" class="welcome-line delay-4 btn btn-gold mt-6 px-8">Enter the celebration</button>
        </div>`;
      document.body.appendChild(overlay);
      document.body.classList.add('overflow-hidden');

      const close = () => {
        if (!this.open) return;
        this.open = false;
        document.removeEventListener('keydown', onKey);
        overlay.classList.add('welcome-exit');
        document.body.classList.remove('overflow-hidden');
        setTimeout(() => overlay.remove(), reducedMotion() ? 0 : 450);
        Festive.petals();
        onClose?.();
      };
      const onKey = (e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); close(); } };
      document.addEventListener('keydown', onKey);
      overlay.querySelector('[data-welcome="enter"]').addEventListener('click', close);
      setTimeout(() => overlay.querySelector('[data-welcome="enter"]')?.focus({ preventScroll: true }), reducedMotion() ? 0 : 1600);
    },
  };

  /* ----------------------------------------------------------------- Tour */
  // One-time coach-mark tour. Outcome (Completed/Skipped) is saved to the caller's
  // row in the Members sheet so it never replays for that guest on any device.
  const Tour = {
    active: false,
    index: 0,
    steps: [],
    els: null,
    replay: false,

    doneKey(email) { return `evt.tour.${email}`; },

    maybeStart() {
      const s = Store.state;
      if (this.active || Welcome.open || s.authStatus !== 'authed' || !s.user) return;
      if (s.tourStatus !== 'Pending' || sessionStore.get(this.doneKey(s.user.email))) return;
      // Let the schedule paint first so targets exist.
      setTimeout(() => this.start(), 350);
    },

    buildSteps() {
      const s = Store.state;
      const name = escapeHtml(firstNameOf(s.user));
      const all = [
        { title: `Namaste, ${name} ji 🙏`, body: 'A quick 30-second walk-through so you never miss a moment of the celebration.' },
        { target: '#tour-next-up', title: 'What’s next', body: 'The next ceremony is always pinned here — with the time and a map link to the venue.' },
        { target: '#tour-days', title: 'All three days', body: 'Tap a day to jump straight to its programme.' },
        { target: '#banner-notify:not(.hidden)', title: 'Never miss a ceremony', body: 'Turn on notifications and we’ll gently call you the moment an event begins.' },
        { target: '#refresh-btn', title: 'Always up to date', body: 'The schedule refreshes by itself. Tap here any time for the very latest.' },
        { target: '#account-btn', title: 'Your profile', body: 'See your details, replay this tour, or sign out.' },
        { target: '[data-tab="control"]', admin: true, title: 'Go Live', body: 'Mark a ceremony Live — guests get a push notification and you can share it on WhatsApp.' },
        { target: '[data-tab="pickups"]', admin: true, title: 'Pick-ups', body: 'Track every arriving family and mark them picked up.' },
        { target: '[data-tab="members"]', admin: true, title: 'Guests & access', body: 'Invite guests, make co-hosts admins, and remove access.' },
        { title: 'You’re all set 🪔', body: 'We are so happy you are here. Enjoy every moment!' },
      ];
      return all.filter((st) => (!st.admin || s.isAdmin) && (!st.target || this.visible(st.target)));
    },

    visible(sel) {
      const el = $(sel);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    },

    start({ replay = false } = {}) {
      if (this.active) return;
      if (Store.state.tab !== 'schedule') Store.set({ tab: 'schedule' });
      this.steps = this.buildSteps();
      if (!this.steps.length) return;
      this.active = true;
      this.replay = replay;
      this.index = 0;

      const root = document.createElement('div');
      root.id = 'tour-root';
      root.className = 'fixed inset-0 z-[60]';
      root.innerHTML = `
        <div data-tour="shade" class="absolute inset-0 bg-ink-900/60"></div>
        <div data-tour="spot" class="tour-spot hidden"></div>
        <div data-tour="card" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-body"
          class="tour-card absolute left-4 right-4 sm:left-1/2 sm:right-auto sm:w-96 sm:-translate-x-1/2 rounded-3xl bg-ivory-50 p-5 shadow-lift ring-1 ring-haldi-300">
          <div class="flex items-center justify-between">
            <p data-tour="count" class="eyebrow"></p>
            <button type="button" data-tour="skip" class="text-xs font-semibold text-ink-500 underline-offset-2 hover:underline">Skip tour</button>
          </div>
          <h3 id="tour-title" class="mt-1 font-display text-xl text-kumkum-700"></h3>
          <p id="tour-body" class="mt-1 text-sm text-ink-600"></p>
          <div class="mt-4 flex items-center justify-between gap-3">
            <div data-tour="dots" class="flex gap-1.5" aria-hidden="true"></div>
            <div class="flex gap-2">
              <button type="button" data-tour="back" class="btn btn-ghost btn-sm">Back</button>
              <button type="button" data-tour="next" class="btn btn-primary btn-sm">Next</button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(root);
      this.els = {
        root,
        spot: root.querySelector('[data-tour="spot"]'),
        shade: root.querySelector('[data-tour="shade"]'),
        card: root.querySelector('[data-tour="card"]'),
      };
      root.querySelector('[data-tour="skip"]').addEventListener('click', () => this.finish('Skipped'));
      root.querySelector('[data-tour="back"]').addEventListener('click', () => this.go(this.index - 1));
      root.querySelector('[data-tour="next"]').addEventListener('click', () => this.go(this.index + 1));
      this.onKey = (e) => {
        if (e.key === 'Escape') this.finish('Skipped');
        else if (e.key === 'ArrowRight') this.go(this.index + 1);
        else if (e.key === 'ArrowLeft') this.go(this.index - 1);
      };
      this.onLayout = () => this.position();
      document.addEventListener('keydown', this.onKey);
      window.addEventListener('resize', this.onLayout);
      window.addEventListener('scroll', this.onLayout, { passive: true });
      this.go(0);
    },

    go(i) {
      if (!this.active) return;
      if (i >= this.steps.length) { this.finish('Completed'); return; }
      this.index = Math.max(0, i);
      const step = this.steps[this.index];
      const { root } = this.els;
      root.querySelector('#tour-title').innerHTML = step.title; // titles are escaped in buildSteps
      root.querySelector('#tour-body').textContent = step.body;
      root.querySelector('[data-tour="count"]').textContent = `Step ${this.index + 1} of ${this.steps.length}`;
      root.querySelector('[data-tour="back"]').classList.toggle('invisible', this.index === 0);
      root.querySelector('[data-tour="next"]').textContent = this.index === this.steps.length - 1 ? 'Let’s begin' : 'Next';
      root.querySelector('[data-tour="dots"]').innerHTML = this.steps
        .map((_, n) => `<span class="h-1.5 rounded-full transition-all ${n === this.index ? 'w-5 bg-kumkum-600' : 'w-1.5 bg-haldi-300'}"></span>`).join('');
      const target = step.target && $(step.target);
      if (target) target.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
      this.position();
      setTimeout(() => this.position(), 380);
      root.querySelector('[data-tour="next"]').focus({ preventScroll: true });
    },

    position() {
      if (!this.active) return;
      const step = this.steps[this.index];
      const { spot, shade, card } = this.els;
      const target = step.target && $(step.target);
      if (!target) {
        spot.classList.add('hidden');
        shade.classList.remove('hidden');
        card.style.top = '50%';
        card.style.transform = 'translateY(-50%)';
        return;
      }
      const r = target.getBoundingClientRect();
      const pad = 6;
      shade.classList.add('hidden'); // the spotlight's box-shadow becomes the shade
      spot.classList.remove('hidden');
      Object.assign(spot.style, {
        top: `${r.top - pad}px`, left: `${r.left - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`,
      });
      const below = r.bottom + 16 + card.offsetHeight < window.innerHeight;
      card.style.transform = '';
      card.style.top = below ? `${r.bottom + 16}px` : `${Math.max(12, r.top - card.offsetHeight - 16)}px`;
    },

    finish(status) {
      if (!this.active) return;
      this.active = false;
      document.removeEventListener('keydown', this.onKey);
      window.removeEventListener('resize', this.onLayout);
      window.removeEventListener('scroll', this.onLayout);
      this.els?.root.remove();
      this.els = null;
      if (this.replay) return;
      const s = Store.state;
      if (!s.user) return;
      sessionStore.set(this.doneKey(s.user.email), status);
      Store.set({ tourStatus: status });
      if (status === 'Completed') { Festive.petals(18); Toast.show('Wonderful! Enjoy the celebration 🌼', 'success'); }
      // Fire-and-forget: if it fails, the session flag still prevents a replay on this device.
      Api.post('completeTour', { status }).catch(() => {});
    },

    cancel() { // sign-out / identity change: close without recording anything
      this.replay = true;
      this.finish('Skipped');
    },
  };

  /* ---------------------------------------------------------------- Views */
  const STATUS_STYLES = {
    Live: 'bg-kumkum-600 text-ivory-50 ring-kumkum-700',
    Upcoming: 'bg-haldi-100 text-haldi-800 ring-haldi-300',
    Completed: 'bg-ivory-200 text-ink-500 ring-ivory-300',
    Pending: 'bg-marigold-100 text-marigold-800 ring-marigold-300',
    'Picked Up': 'bg-mehndi-100 text-mehndi-800 ring-mehndi-300',
  };
  const STATUS_LABEL = { Live: 'Live now', Completed: '✓ Completed' };

  const badge = (status) => `<span class="inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ${STATUS_STYLES[status] || STATUS_STYLES.Upcoming}">
      ${status === 'Live' ? '<span class="w-1.5 h-1.5 rounded-full bg-ivory-50 animate-pulse"></span>' : ''}${escapeHtml(STATUS_LABEL[status] || status)}</span>`;

  const spinnerOr = (key, label) => (Store.isPending(key) ? '<span class="spinner"></span>' : label);

  const emptyState = (icon, title, text = '') => `
    <div class="card relative overflow-hidden text-center py-12 px-6">
      <div class="mandala-layer" aria-hidden="true"></div>
      <div class="relative text-4xl mb-2" aria-hidden="true">${icon}</div>
      <p class="relative font-display text-xl text-kumkum-700">${escapeHtml(title)}</p>
      ${text ? `<p class="relative text-sm text-ink-500 mt-1">${escapeHtml(text)}</p>` : ''}
    </div>`;

  const pageHeader = (eyebrow, title, text = '') => `
    <header class="mb-4">
      <p class="eyebrow">${eyebrow}</p>
      <h2 class="section-title">${title}</h2>
      ${text ? `<p class="text-sm text-ink-500 mt-1">${text}</p>` : ''}
    </header>`;

  const groupByDay = (events) => events.reduce((acc, ev) => {
    const key = ev.day || 'Schedule';
    (acc[key] = acc[key] || []).push(ev);
    return acc;
  }, {});

  const pin = '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>';
  const clock = '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

  const locationLine = (e, cls = 'text-ink-500') => (e.location ? `
    <a href="${escapeHtml(mapsLink(e.location))}" target="_blank" rel="noopener noreferrer"
      class="inline-flex items-center gap-1 text-sm ${cls} hover:underline underline-offset-2">${pin}${escapeHtml(e.location)}</a>` : '');

  const ScheduleParts = {
    hero(s) {
      const g = Festive.greeting();
      const total = s.itinerary.length;
      const done = s.itinerary.filter((e) => e.status === 'Completed').length;
      const pct = total ? Math.round((done / total) * 100) : 0;
      return `
        <section class="card relative overflow-hidden p-5 bg-gradient-to-br from-ivory-50 via-haldi-50 to-marigold-50">
          <div class="mandala-layer mandala-hero" aria-hidden="true"></div>
          <p class="relative eyebrow"><span lang="hi">${g.hi}</span> · ${g.en}</p>
          <h2 class="relative mt-1 font-display text-2xl text-kumkum-700">Namaste, ${escapeHtml(firstNameOf(s.user))} ji 🙏</h2>
          <p class="relative mt-1 text-sm text-ink-600">We’re delighted to celebrate with you. Here’s everything planned for you.</p>
          ${total ? `
          <div class="relative mt-4">
            <div class="flex justify-between text-[11px] font-semibold text-ink-500"><span>${done} of ${total} ceremonies done</span><span>${pct}%</span></div>
            <div class="mt-1 h-1.5 rounded-full bg-haldi-100 overflow-hidden" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Celebration progress">
              <div class="h-full rounded-full bg-gradient-to-r from-marigold-400 to-kumkum-500 transition-all" style="width:${pct}%"></div>
            </div>
          </div>` : ''}
        </section>`;
    },

    live(events) {
      return events.map((e) => `
        <section class="live-glow relative overflow-hidden rounded-3xl p-5 text-ivory-50 bg-gradient-to-br from-kumkum-600 via-kumkum-700 to-kumkum-900 shadow-lift" aria-live="polite">
          <div class="mandala-layer opacity-60" aria-hidden="true"></div>
          <p class="relative flex items-center gap-2 text-[11px] font-bold uppercase tracking-[.2em] text-haldi-200">
            <span class="relative flex w-2.5 h-2.5"><span class="absolute inset-0 rounded-full bg-haldi-300 animate-ping"></span><span class="relative w-2.5 h-2.5 rounded-full bg-haldi-300"></span></span>
            Happening now
          </p>
          <h2 class="relative mt-1 font-display text-2xl">${escapeHtml(e.title)}</h2>
          <p class="relative mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ivory-100">
            <span class="inline-flex items-center gap-1">${clock}${escapeHtml(e.time || 'Now')}</span>
            ${e.location ? `<span class="inline-flex items-center gap-1">${pin}${escapeHtml(e.location)}</span>` : ''}
          </p>
          ${e.location ? `<a href="${escapeHtml(mapsLink(e.location))}" target="_blank" rel="noopener noreferrer" class="relative btn btn-gold btn-sm mt-4">Take me there</a>` : ''}
        </section>`).join('');
    },

    nextUp(s) {
      const next = s.itinerary.find((e) => e.status === 'Upcoming');
      if (!next) return '';
      return `
        <section id="tour-next-up" class="card p-4 border-l-4 border-marigold-400">
          <p class="eyebrow">Up next</p>
          <div class="mt-1 flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h3 class="font-display text-lg text-kumkum-700">${escapeHtml(next.title)}</h3>
              <p class="mt-0.5 inline-flex items-center gap-1 text-sm text-ink-600">${clock}${escapeHtml([next.day, next.time].filter(Boolean).join(' · '))}</p>
              <div>${locationLine(next)}</div>
            </div>
            <span class="text-3xl" aria-hidden="true">🪔</span>
          </div>
        </section>`;
    },

    farewell(s) {
      if (!s.itinerary.length || s.itinerary.some((e) => e.status !== 'Completed')) return '';
      return `
        <section class="card relative overflow-hidden p-6 text-center">
          <div class="mandala-layer" aria-hidden="true"></div>
          <p class="relative text-3xl" aria-hidden="true">🙏</p>
          <h3 class="relative mt-1 font-display text-xl text-kumkum-700">Dhanyavaad!</h3>
          <p class="relative mt-1 text-sm text-ink-600">Thank you for making this celebration so special. Safe travels home — with our love and blessings.</p>
        </section>`;
    },
  };

  const Views = {
    schedule(s) {
      if (s.loading && !s.itinerary.length) {
        return '<div class="space-y-3">' + '<div class="skeleton h-24 rounded-3xl"></div>'.repeat(4) + '</div>';
      }
      if (s.error && !s.itinerary.length) {
        return `<div class="card p-6 text-center">
            <p class="font-display text-xl text-kumkum-700">We couldn’t load the schedule</p>
            <p class="text-sm text-ink-500 mt-1">${escapeHtml(s.error)}</p>
            <button data-action="refresh" class="btn btn-primary mt-4">Try again</button>
          </div>`;
      }
      if (!s.itinerary.length) {
        return `<div class="space-y-4">${ScheduleParts.hero(s)}${emptyState('🌼', 'The programme is being prepared', 'Our families are finalising the schedule — it will bloom right here soon.')}</div>`;
      }

      const live = s.itinerary.filter((e) => e.status === 'Live');
      const days = Object.entries(groupByDay(s.itinerary));
      const chips = days.length > 1 ? `
        <nav id="tour-days" aria-label="Jump to day" class="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 py-1">
          ${days.map(([day, events], i) => {
            const hasLive = events.some((e) => e.status === 'Live');
            const allDone = events.every((e) => e.status === 'Completed');
            return `<button data-action="jump-day" data-day="${i}" class="chip-off shrink-0 ${hasLive ? 'ring-2 ring-kumkum-400' : ''}">
              Day ${i + 1}${allDone ? ' ✓' : hasLive ? ' •' : ''}<span class="sr-only"> — ${escapeHtml(day)}</span></button>`;
          }).join('')}
        </nav>` : '';

      const sections = days.map(([day, events], i) => `
        <section id="day-${i}" class="scroll-mt-28">
          <div class="flex items-baseline gap-2 pt-2">
            <h3 class="font-display text-lg text-kumkum-700">Day ${i + 1}</h3>
            <p class="text-sm text-ink-500">${escapeHtml(day)}</p>
          </div>
          <div class="paisley-divider my-2" aria-hidden="true"></div>
          <ol class="relative ml-2 border-l-2 border-dashed border-haldi-300 space-y-3">
            ${events.map((e) => `
              <li class="ml-5 relative">
                <span class="absolute -left-[29px] top-5 grid place-items-center w-4 h-4 rounded-full ring-4 ring-ivory-100 ${e.status === 'Live' ? 'bg-kumkum-600' : e.status === 'Completed' ? 'bg-ink-300' : 'bg-marigold-400'}" aria-hidden="true"></span>
                <article class="card p-4 ${e.status === 'Live' ? 'ring-2 ring-kumkum-400' : ''} ${e.status === 'Completed' ? 'opacity-70' : ''}">
                  <div class="flex items-start justify-between gap-2">
                    <p class="inline-flex items-center gap-1 text-xs font-semibold text-ink-500">${clock}${escapeHtml(e.time)}</p>
                    ${badge(e.status)}
                  </div>
                  <h4 class="mt-1 font-semibold text-ink-900">${escapeHtml(e.title)}</h4>
                  ${locationLine(e)}
                </article>
              </li>`).join('')}
          </ol>
        </section>`).join('');

      return `
        <div class="space-y-4">
          ${ScheduleParts.hero(s)}
          ${ScheduleParts.live(live)}
          ${ScheduleParts.nextUp(s)}
          ${chips}
          ${sections}
          ${ScheduleParts.farewell(s)}
          <p class="pt-4 pb-2 text-center text-xs text-ink-400" lang="sa">॥ शुभमस्तु ॥ <span lang="en">· May all be auspicious</span></p>
        </div>`;
    },

    gate(s) {
      const name = escapeHtml(CONFIG.EVENT_NAME || 'Event Companion');
      if (s.authStatus === 'checking') {
        return `<div class="py-24 text-center text-ink-500">
            <div class="mx-auto w-16 h-16 grid place-items-center rounded-full bg-haldi-100 text-3xl diya" aria-hidden="true">🪔</div>
            <p class="mt-4 text-sm">Checking your invitation…</p>
          </div>`;
      }
      const denied = s.authStatus === 'denied';
      return `
        <div class="min-h-[70vh] flex items-center justify-center py-8">
          <article class="invite-card relative w-full max-w-sm overflow-hidden rounded-[2rem] bg-ivory-50 px-6 pt-10 pb-8 text-center shadow-lift ring-1 ring-haldi-300">
            <div class="toran absolute inset-x-0 top-0" aria-hidden="true"></div>
            <div class="mandala-layer" aria-hidden="true"></div>
            <p class="relative font-display text-lg text-marigold-700" lang="sa">${escapeHtml(CONFIG.EVENT_BLESSING || '॥ श्री गणेशाय नमः ॥')}</p>
            <img src="icons/icon-192.png" alt="" class="relative mx-auto mt-4 w-20 h-20 rounded-3xl shadow-card ring-2 ring-haldi-300" />
            <p class="relative mt-5 eyebrow">You are cordially invited to</p>
            <h2 class="relative mt-1 font-display text-3xl text-kumkum-700">${name}</h2>
            ${CONFIG.EVENT_DATES ? `<p class="relative mt-1 text-sm font-semibold text-ink-600">${escapeHtml(CONFIG.EVENT_DATES)}</p>` : ''}
            <div class="relative paisley-divider my-5" aria-hidden="true"></div>
            ${denied ? `
              <div class="relative rounded-2xl bg-kumkum-50 ring-1 ring-kumkum-200 p-4 text-left">
                <p class="font-semibold text-kumkum-700">🔒 Access not granted</p>
                <p class="text-sm text-kumkum-800/90 mt-1"><b>${escapeHtml(s.deniedEmail || 'This account')}</b> isn’t on the guest list yet. Please ask the hosts to add you, or try another Google account.</p>
              </div>` : `
              <p class="relative text-sm text-ink-600">This celebration app is private to invited guests. Please sign in with the Google account you shared with the hosts.</p>`}
            <div id="gsi-gate" class="relative mt-6 min-h-[44px] flex justify-center"></div>
            ${!s.online ? '<p class="relative mt-4 text-xs text-marigold-800">You’re offline — please connect to the internet to sign in.</p>' : ''}
            <p class="relative mt-6 text-[11px] text-ink-400">We only use your Google name, email and photo to confirm your invitation.</p>
          </article>
        </div>`;
    },
  };

  Views.control = (s) => {
    if (!s.itinerary.length) return emptyState('🎛️', 'No events to control', 'Add rows to the "Itinerary" sheet to get started.');
    return `
      ${pageHeader('Host console', 'Go Live', '<b>Set Live &amp; Broadcast</b> updates the sheet, notifies every subscribed guest and opens WhatsApp with a ready-to-send message.')}
      <div class="space-y-3">
        ${s.itinerary.map((e) => {
          const key = `event:${e.id}`;
          const busy = Store.isPending(key);
          return `
          <article class="card p-4 ${e.status === 'Live' ? 'ring-2 ring-kumkum-400' : ''}">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <p class="text-[11px] font-semibold text-ink-400">#${escapeHtml(e.id)} · ${escapeHtml(e.day)} · ${escapeHtml(e.time)}</p>
                <h4 class="font-semibold text-ink-900 truncate">${escapeHtml(e.title)}</h4>
                <p class="text-sm text-ink-500 truncate inline-flex items-center gap-1">${pin}${escapeHtml(e.location || 'TBA')}</p>
              </div>
              ${badge(e.status)}
            </div>
            <div class="mt-3 grid grid-cols-2 gap-2">
              <button data-action="open-broadcast" data-id="${escapeHtml(e.id)}" ${busy ? 'disabled' : ''} class="btn btn-live col-span-2">
                ${spinnerOr(key, e.status === 'Live' ? '📣 Re-announce &amp; Broadcast' : '🪔 Set Live &amp; Broadcast')}
              </button>
              <button data-action="share-whatsapp" data-id="${escapeHtml(e.id)}" class="btn btn-whatsapp btn-sm">Share to WhatsApp</button>
              <select data-action="set-status" data-id="${escapeHtml(e.id)}" aria-label="Change status of ${escapeHtml(e.title)}" ${busy ? 'disabled' : ''} class="input py-2 text-sm">
                ${['Upcoming', 'Live', 'Completed'].map((st) => `<option value="${st}" ${st === e.status ? 'selected' : ''}>${st}</option>`).join('')}
              </select>
            </div>
          </article>`;
        }).join('')}
      </div>`;
  };

  Views.pickups = (s) => {
    const q = s.pickupSearch.trim().toLowerCase();
    const list = s.logistics.filter((g) => {
      if (s.pickupFilter !== 'all' && g.pickupStatus !== s.pickupFilter) return false;
      if (!q) return true;
      return [g.name, g.contact, g.mode, g.id].some((v) => String(v).toLowerCase().includes(q));
    });
    const done = s.logistics.filter((g) => g.pickupStatus === 'Picked Up').length;
    const total = s.logistics.length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const chip = (value, label) => `<button data-action="pickup-filter" data-value="${value}" aria-pressed="${s.pickupFilter === value}"
        class="${s.pickupFilter === value ? 'chip-on' : 'chip-off'} shrink-0">${label}</button>`;

    return `
      ${pageHeader('Arrivals', 'Pick-ups')}
      <div class="card p-4 mb-3">
        <div class="flex justify-between text-sm text-ink-700"><span>${done} of ${total} families welcomed</span><span class="font-semibold">${pct}%</span></div>
        <div class="mt-2 h-2 rounded-full bg-haldi-100 overflow-hidden"><div class="h-full rounded-full bg-gradient-to-r from-mehndi-400 to-mehndi-600 transition-all" style="width:${pct}%"></div></div>
      </div>
      <input type="search" data-action="pickup-search" value="${escapeHtml(s.pickupSearch)}" placeholder="Search name, contact, mode…" aria-label="Search pick-ups" class="input" />
      <div class="flex gap-2 my-3 overflow-x-auto no-scrollbar">
        ${chip('all', `All (${total})`)}${chip('Pending', `Pending (${total - done})`)}${chip('Picked Up', `Picked Up (${done})`)}
      </div>
      ${!list.length ? emptyState('🚐', total ? 'No matching guests' : 'No arrivals yet', total ? 'Try a different search or filter.' : 'Add rows to the "Logistics" sheet.') : `
      <div class="space-y-3">
        ${list.map((g) => {
          const picked = g.pickupStatus === 'Picked Up';
          const key = `pickup:${g.id}`;
          return `
          <article class="card p-4 ${picked ? 'ring-1 ring-mehndi-300' : ''}">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <h4 class="font-semibold text-ink-900 truncate">${escapeHtml(g.name)} ${g.members ? `<span class="text-xs font-normal text-ink-500">· ${escapeHtml(g.members)} guests</span>` : ''}</h4>
                ${g.contact ? `<a href="tel:${escapeHtml(String(g.contact).replace(/[^\d+]/g, ''))}" class="text-sm font-medium text-kumkum-600">📞 ${escapeHtml(g.contact)}</a>` : ''}
              </div>
              ${badge(g.pickupStatus)}
            </div>
            <dl class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-ink-600">
              <div><dt class="text-ink-400">Arrival</dt><dd>${escapeHtml(formatDateTime(g.arrival))}</dd></div>
              <div><dt class="text-ink-400">Departure</dt><dd>${escapeHtml(formatDateTime(g.departure))}</dd></div>
              <div class="col-span-2"><dt class="text-ink-400 inline">Mode:</dt> <dd class="inline">${escapeHtml(g.mode || '—')}</dd></div>
            </dl>
            <button data-action="toggle-pickup" data-id="${escapeHtml(g.id)}" data-next="${picked ? 'Pending' : 'Picked Up'}" ${Store.isPending(key) ? 'disabled' : ''}
              class="btn ${picked ? 'btn-ghost' : 'btn-primary'} w-full mt-3">
              ${spinnerOr(key, picked ? '↩︎ Mark as Pending' : '✓ Mark as Picked Up')}
            </button>
          </article>`;
        }).join('')}
      </div>`}`;
  };

  Views.members = (s) => {
    const me = s.user?.email;
    const q = s.memberSearch.trim().toLowerCase();
    const list = s.members.filter((m) => !q || m.email.includes(q) || m.role.toLowerCase() === q);
    const adminCount = s.members.filter((m) => m.role === 'Admin').length;
    const roleOptions = (current) => ROLES.map((r) => `<option value="${r}" ${r === current ? 'selected' : ''}>${r}</option>`).join('');
    const stat = (n, label) => `<div class="card py-2"><p class="font-display text-xl text-kumkum-700">${n}</p><p class="text-[11px] text-ink-500">${label}</p></div>`;
    const tourChip = (t) => (t === 'Completed' ? '· toured ✓' : t === 'Skipped' ? '· tour skipped' : '· not visited yet');
    return `
      ${pageHeader('Guest list', 'Members &amp; access', 'Only people on this list can open the app. <b>Admins</b> host the event; <b>Viewers</b> follow the schedule. Every change is recorded in the AuditLog.')}
      <div class="grid grid-cols-3 gap-2 text-center mb-4">${stat(s.members.length, 'Members')}${stat(adminCount, 'Admins')}${stat(s.members.length - adminCount, 'Viewers')}</div>
      <form data-action="add-member" class="card p-4 mb-4 space-y-2" novalidate>
        <label class="block text-xs font-semibold text-ink-500" for="new-member-email">Invite a guest</label>
        <input id="new-member-email" name="email" type="email" inputmode="email" autocomplete="off" required placeholder="guest@gmail.com" class="input" />
        <div class="flex gap-2">
          <select name="role" aria-label="Role" class="input flex-1">${roleOptions('Viewer')}</select>
          <button type="submit" ${Store.isPending('member:add') ? 'disabled' : ''} class="btn btn-primary shrink-0 px-6">
            ${spinnerOr('member:add', 'Add')}
          </button>
        </div>
      </form>
      <input type="search" data-action="member-search" value="${escapeHtml(s.memberSearch)}" placeholder="Search members…" aria-label="Search members" class="input mb-3" />
      ${!list.length ? emptyState('👥', s.members.length ? 'No matching members' : 'No members yet') : `
      <ul class="card divide-y divide-haldi-100">
        ${list.map((m) => {
          const self = m.email === me;
          const busy = Store.isPending(`member:${m.email}`);
          const lastAdmin = m.role === 'Admin' && adminCount <= 1;
          return `
          <li class="flex items-center gap-3 p-3">
            <div class="w-9 h-9 shrink-0 rounded-full ${m.role === 'Admin' ? 'bg-kumkum-100 text-kumkum-700' : 'bg-haldi-100 text-haldi-800'} grid place-items-center font-bold">${escapeHtml(m.email[0]?.toUpperCase() || '?')}</div>
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium text-ink-900 truncate">${escapeHtml(m.email)} ${self ? '<span class="ml-1 rounded-full bg-kumkum-600 text-ivory-50 text-[10px] px-2 py-0.5">You</span>' : ''}</p>
              <p class="text-xs text-ink-400 truncate">Added by ${escapeHtml(m.addedBy || '—')}${m.addedDate ? ` · ${escapeHtml(formatDateTime(m.addedDate))}` : ''} ${tourChip(m.tourStatus)}</p>
            </div>
            <select data-action="set-role" data-email="${escapeHtml(m.email)}" aria-label="Role for ${escapeHtml(m.email)}" ${self || busy || lastAdmin ? 'disabled' : ''}
              title="${self ? 'You cannot change your own role' : lastAdmin ? 'At least one admin must remain' : 'Change role'}"
              class="shrink-0 rounded-lg border border-haldi-300 bg-ivory-50 text-xs px-2 py-1.5 disabled:opacity-50">${roleOptions(m.role)}</select>
            <button data-action="remove-member" data-email="${escapeHtml(m.email)}" ${self || busy || lastAdmin ? 'disabled' : ''}
              title="${self ? 'You cannot remove yourself' : lastAdmin ? 'At least one admin must remain' : 'Remove member'}" aria-label="Remove ${escapeHtml(m.email)}"
              class="btn btn-danger btn-sm shrink-0">
              ${busy ? '<span class="spinner"></span>' : 'Remove'}
            </button>
          </li>`;
        }).join('')}
      </ul>`}`;
  };

  /* --------------------------------------------------------------- Render */
  const ADMIN_TABS = ['control', 'pickups', 'members'];
  let lastGateKey = null;

  function render(s) {
    const signedIn = ['authed', 'offline'].includes(s.authStatus);

    // Header / account
    $('#app-title').textContent = CONFIG.EVENT_NAME || 'Event Companion';
    const syncText = !signedIn ? (CONFIG.EVENT_TAGLINE || '')
      : s.authStatus === 'offline' ? `Offline · last synced ${timeAgo(s.lastSynced)}`
        : s.loading ? 'Syncing…'
          : s.error ? `${s.lastSynced ? `Last synced ${timeAgo(s.lastSynced)}` : 'Not synced'}`
            : `${CONFIG.EVENT_TAGLINE || ''}${s.lastSynced ? ` · updated ${timeAgo(s.lastSynced)}` : ''}`;
    $('#sync-indicator').textContent = syncText;
    const blessing = $('#app-blessing');
    if (blessing) {
      blessing.textContent = signedIn ? (CONFIG.EVENT_BLESSING || '') : '';
      blessing.classList.toggle('hidden', !blessing.textContent);
    }
    $('#refresh-btn').classList.toggle('hidden', !signedIn);
    $('#refresh-btn').setAttribute('aria-busy', String(!!s.loading));
    $('#refresh-btn svg')?.classList.toggle('animate-spin', !!s.loading);
    $('#account-btn').classList.toggle('hidden', !signedIn);
    $('#account-btn').classList.toggle('flex', signedIn);

    if (s.user) {
      const picture = safePicture(s.user.picture);
      $('#account-avatar').innerHTML = picture
        ? `<img src="${escapeHtml(picture)}" alt="" referrerpolicy="no-referrer" class="w-7 h-7 rounded-full ring-2 ring-haldi-300" />`
        : escapeHtml(String(s.user.name || s.user.email || '?')[0].toUpperCase());
      $('#account-label').textContent = s.role || 'Member';
    }

    $('#banner-offline').classList.toggle('hidden', s.online);
    Push.render();

    // Navigation
    if (!s.isAdmin && ADMIN_TABS.includes(s.tab)) s.tab = 'schedule';
    $('#nav-grid').className = `max-w-2xl mx-auto grid ${s.isAdmin ? 'grid-cols-4' : 'grid-cols-1'}`;
    $('#bottom-nav').classList.toggle('hidden', !signedIn || !s.isAdmin);
    $$('.nav-btn').forEach((btn) => {
      const adminOnly = btn.classList.contains('admin-only');
      btn.classList.toggle('hidden', adminOnly && !s.isAdmin);
      btn.classList.toggle('flex', !adminOnly || s.isAdmin);
      const active = btn.dataset.tab === s.tab;
      btn.classList.toggle('text-kumkum-700', active);
      btn.classList.toggle('text-ink-500', !active);
      const pill = btn.querySelector('.nav-pill');
      if (pill) { pill.classList.toggle('bg-kumkum-100', active); pill.classList.toggle('bg-transparent', !active); }
      btn.setAttribute('aria-current', active ? 'page' : 'false');
    });

    // Login gate: re-render only when its state changes so the Google button isn't torn down.
    if (!signedIn) {
      const key = `${s.authStatus}|${s.deniedEmail}|${s.gsiReady}|${s.online}`;
      if (key !== lastGateKey) {
        lastGateKey = key;
        $('#view').innerHTML = Views.gate(s);
        if (s.authStatus !== 'checking') Auth.renderButton($('#gsi-gate'));
      }
      return;
    }
    lastGateKey = null;

    // Preserve focus/caret and draft input across re-renders
    const active = document.activeElement;
    const focusKey = active?.dataset?.action;
    const caret = focusKey && typeof active.selectionStart === 'number' ? active.selectionStart : null;
    const draftForm = $('form[data-action="add-member"]');
    const draft = draftForm ? { email: draftForm.elements.email.value, role: draftForm.elements.role.value, focused: active === draftForm.elements.email } : null;

    $('#view').innerHTML = (Views[s.tab] || Views.schedule)(s);

    const form = $('form[data-action="add-member"]');
    if (form && draft) {
      form.elements.email.value = draft.email;
      form.elements.role.value = draft.role;
      if (draft.focused) form.elements.email.focus();
    }
    if (['pickup-search', 'member-search'].includes(focusKey)) {
      const el = $(`[data-action="${focusKey}"]`);
      if (el) { el.focus(); if (caret !== null) el.setSelectionRange(caret, caret); }
    }
  }

  /* ----------------------------------------------------------------- Data */
  const Data = {
    timer: null,

    refresh() {
      if (Store.state.authStatus === 'offline' && navigator.onLine) {
        const saved = sessionStore.get(STORAGE.CREDENTIAL);
        if (!saved || Auth.isExpired(saved)) { Store.set({ authStatus: 'signed-out', user: null }); Auth.prompt(); return null; }
        Store.set({ authStatus: 'authed', user: saved });
      }
      if (Store.state.authStatus !== 'authed') return null;
      return Auth.loadSession();
    },

    startPolling() {
      clearInterval(this.timer);
      this.timer = setInterval(() => {
        if (document.visibilityState === 'visible' && navigator.onLine) this.refresh();
      }, CONFIG.REFRESH_INTERVAL_MS || 60000);
    },
  };

  /* -------------------------------------------------------------- Actions */
  const findEvent = (id) => Store.state.itinerary.find((e) => e.id === id);

  const Actions = {
    async run(key, fn, successMsg) {
      if (Store.isPending(key)) return null;
      Store.setPending(key, true);
      try {
        const result = await fn();
        if (successMsg) Toast.show(typeof successMsg === 'function' ? successMsg(result) : successMsg, 'success');
        return result;
      } catch (err) {
        Toast.show(err.message || 'Something went wrong.', 'error', 5000);
        return null;
      } finally {
        Store.setPending(key, false);
      }
    },

    async updateEvent(eventId, status, notify) {
      const data = await this.run(`event:${eventId}`, () => Api.post('updateEvent', { eventId, status, notify }));
      if (!data) return;
      Store.set({ itinerary: data.itinerary });
      Nudges.remember();
      const cache = storage.get(STORAGE.DATA_CACHE);
      if (cache) storage.set(STORAGE.DATA_CACHE, { ...cache, itinerary: data.itinerary, savedAt: new Date().toISOString() });
      if (status === 'Live') Festive.petals();
      if (data.push?.attempted) {
        Toast.show(data.push.ok ? `"${data.event.title}" is Live — push sent 🔔` : `Status updated, but push failed: ${data.push.error}`, data.push.ok ? 'success' : 'error', 5500);
      } else {
        Toast.show(`"${data.event.title}" set to ${status}`, 'success');
      }
    },

    async updatePickup(id, status) {
      const data = await this.run(`pickup:${id}`, () => Api.post('updatePickup', { id, status }));
      if (data) {
        Store.set({ logistics: data.logistics });
        const guest = data.logistics.find((g) => g.id === id);
        Toast.show(`${guest?.name || 'Guest'} marked as ${status}`, 'success');
      }
    },

    async addMember(form) {
      const input = form.elements.email;
      const email = input.value.trim().toLowerCase();
      const role = form.elements.role.value;
      if (email.length > 254 || !EMAIL_RE.test(email)) { Toast.show('Enter a valid email address.', 'error'); input.focus(); return; }
      if (!ROLES.includes(role)) { Toast.show('Choose a valid role.', 'error'); return; }
      if (Store.state.members.some((m) => m.email === email)) { Toast.show(`${email} is already a member.`, 'info'); return; }
      const data = await this.run('member:add', () => Api.post('addMember', { email, role }), `${email} added as ${role}`);
      if (data) { input.value = ''; Store.set({ members: data.members }); }
    },

    async setRole(email, role) {
      if (email === Store.state.user?.email) { Toast.show('You cannot change your own role.', 'error'); return; }
      if (!window.confirm(`Change ${email} to ${role}?`)) return;
      const data = await this.run(`member:${email}`, () => Api.post('updateMemberRole', { email, role }), `${email} is now ${role === 'Admin' ? 'an Admin' : 'a Viewer'}`);
      if (data) Store.set({ members: data.members });
    },

    async removeMember(email) {
      if (email === Store.state.user?.email) { Toast.show('You cannot remove yourself.', 'error'); return; }
      if (!window.confirm(`Remove ${email}? They will lose access to the app.`)) return;
      const data = await this.run(`member:${email}`, () => Api.post('removeMember', { email }), `${email} removed`);
      if (data) Store.set({ members: data.members });
    },

    openBroadcast(eventId) {
      const ev = findEvent(eventId);
      if (!ev) return;
      Modal.open(`
        <p class="eyebrow">Broadcast</p>
        <h3 class="font-display text-2xl text-kumkum-700">Set Live &amp; announce</h3>
        <p class="text-sm text-ink-600 mt-1">This will mark <b>${escapeHtml(ev.title)}</b> as Live, push a notification to all subscribers, and open WhatsApp so you can forward the message to groups or chats.</p>
        <label class="block text-xs font-semibold text-ink-500 mt-4 mb-1" for="wa-message">WhatsApp message (editable)</label>
        <textarea id="wa-message" rows="8" class="input font-mono text-sm">${escapeHtml(WhatsApp.buildMessage(ev))}</textarea>
        <div class="grid grid-cols-2 gap-2 mt-4">
          <button data-modal="cancel" class="btn btn-ghost">Cancel</button>
          <button data-modal="confirm" class="btn btn-live">Go Live &amp; Share</button>
        </div>`, {
        onMount: (root) => {
          root.querySelector('[data-modal="cancel"]').addEventListener('click', () => Modal.close());
          root.querySelector('[data-modal="confirm"]').addEventListener('click', () => {
            const message = root.querySelector('#wa-message').value.trim() || WhatsApp.buildMessage(ev);
            WhatsApp.open(message); // synchronous within the click gesture
            Modal.close();
            this.updateEvent(ev.id, 'Live', true);
          });
        },
      });
    },

    openAccount() {
      const s = Store.state;
      if (!s.user) return;
      Modal.open(`
        <div class="flex items-center gap-3">
          ${safePicture(s.user.picture) ? `<img src="${escapeHtml(safePicture(s.user.picture))}" referrerpolicy="no-referrer" alt="" class="w-12 h-12 rounded-full ring-2 ring-haldi-300" />` : ''}
          <div class="min-w-0">
            <p class="font-display text-xl text-kumkum-700 truncate">${escapeHtml(s.user.name)}</p>
            <p class="text-sm text-ink-500 truncate">${escapeHtml(s.user.email)}</p>
          </div>
        </div>
        <p class="mt-4 text-sm text-ink-700">${s.isAdmin ? 'You are a <b>host (Admin)</b> — you can run the schedule, pick-ups and the guest list.' : 'You are our honoured <b>guest</b> — follow the schedule and live updates right here.'}</p>
        <button data-modal="tour" class="btn btn-ghost w-full mt-4">🪔 Replay the welcome tour</button>
        <div class="grid grid-cols-2 gap-2 mt-2">
          <button data-modal="cancel" class="btn btn-ghost">Close</button>
          <button data-modal="signout" class="btn btn-danger">Sign out</button>
        </div>`, {
        onMount: (root) => {
          root.querySelector('[data-modal="cancel"]').addEventListener('click', () => Modal.close());
          root.querySelector('[data-modal="tour"]').addEventListener('click', () => { Modal.close(); setTimeout(() => Tour.start({ replay: true }), 50); });
          root.querySelector('[data-modal="signout"]').addEventListener('click', () => Auth.signOut());
        },
      });
    },
  };

  /* --------------------------------------------------------------- Events */
  function bindEvents() {
    $('#account-btn').addEventListener('click', () => Actions.openAccount());
    $('#refresh-btn').addEventListener('click', () => Data.refresh());
    $('#notify-btn').addEventListener('click', () => Push.request());

    $('#bottom-nav').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (!btn) return;
      Store.set({ tab: btn.dataset.tab });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    const view = $('#view');
    view.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el || el.disabled) return;
      const { action, id } = el.dataset;
      switch (action) {
        case 'refresh': Data.refresh(); break;
        case 'open-broadcast': Actions.openBroadcast(id); break;
        case 'share-whatsapp': {
          const ev = findEvent(id);
          if (ev) WhatsApp.open(WhatsApp.buildMessage(ev));
          break;
        }
        case 'toggle-pickup': Actions.updatePickup(id, el.dataset.next); break;
        case 'remove-member': Actions.removeMember(el.dataset.email); break;
        case 'pickup-filter': Store.set({ pickupFilter: el.dataset.value }); break;
        case 'jump-day': $(`#day-${Number(el.dataset.day)}`)?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' }); break;
        default: break;
      }
    });

    view.addEventListener('change', (e) => {
      const roleSel = e.target.closest('select[data-action="set-role"]');
      if (roleSel) {
        const member = Store.state.members.find((m) => m.email === roleSel.dataset.email);
        const role = roleSel.value;
        roleSel.value = member?.role || 'Viewer'; // revert until the server confirms
        if (member && role !== member.role) Actions.setRole(member.email, role);
        return;
      }
      const el = e.target.closest('select[data-action="set-status"]');
      if (!el) return;
      const ev = findEvent(el.dataset.id);
      const status = el.value;
      el.value = ev?.status || 'Upcoming'; // revert until the server confirms
      if (!ev || status === ev.status) return;
      if (status === 'Live') { Actions.openBroadcast(ev.id); return; }
      if (window.confirm(`Change "${ev.title}" to ${status}?`)) Actions.updateEvent(ev.id, status, false);
    });

    view.addEventListener('input', (e) => {
      if (e.target.matches('[data-action="pickup-search"]')) Store.set({ pickupSearch: e.target.value });
      if (e.target.matches('[data-action="member-search"]')) Store.set({ memberSearch: e.target.value });
    });

    view.addEventListener('submit', (e) => {
      const form = e.target.closest('form[data-action="add-member"]');
      if (!form) return;
      e.preventDefault();
      Actions.addMember(form);
    });

    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !Tour.active && !Welcome.open) Modal.close(); });
    window.addEventListener('online', () => { Store.set({ online: true }); Data.refresh(); });
    window.addEventListener('offline', () => Store.set({ online: false }));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { Data.refresh(); Push.render(); }
    });
  }

  /* --------------------------------------------------------------- Boot */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(`${BASE_PATH}service-worker.js`, { scope: BASE_PATH })
        .catch((err) => console.warn('Service worker registration failed', err));
    });
  }

  function warnIfUnconfigured() {
    const missing = ['APPS_SCRIPT_URL', 'GOOGLE_CLIENT_ID', 'ONESIGNAL_APP_ID'].filter((k) => isPlaceholder(CONFIG[k]));
    if (missing.length) console.warn(`[config] Missing values in config.js: ${missing.join(', ')}`);
  }

  function boot() {
    warnIfUnconfigured();
    Store.subscribe(render);
    bindEvents();
    render(Store.state);
    registerServiceWorker();
    Install.init();
    Push.init();
    Auth.init();
    Auth.scheduleRenewal();
    Data.startPolling();
  }

  // Pure helpers exposed for unit tests. No state or actions, so nothing here grants privileges.
  window.EventApp = Object.freeze({ WhatsApp, escapeHtml, decodeJwt, safePicture });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
