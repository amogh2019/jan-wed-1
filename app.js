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
  const BASE_PATH = location.pathname.slice(0, location.pathname.lastIndexOf('/') + 1); // e.g. "/jan-wed-1/"
  const PUSH_INIT_TIMEOUT_MS = 15000;
  const OFFLINE_CACHE_MAX_AGE_MS = 15 * 60 * 1000;
  let notificationRoutePending = new URLSearchParams(location.search).get('open') === 'notifications';
  // The ID token is a bearer credential: keep it in sessionStorage (tab-scoped, gone on close).
  // GIS auto-select silently re-issues one on the next launch.
  const STORAGE = { CREDENTIAL: 'evt.credential', LAST_USER: 'evt.lastUser', DATA_CACHE: 'evt.data', INSTALL_DISMISSED: 'evt.installDismissed' };
  // "Atithi" (honoured guest) is the read-only role; "Viewer" is its pre-v1.4 name.
  const GUEST_ROLE = 'Atithi';
  const ROLES = ['Admin', GUEST_ROLE];
  const normalizeRole = (role) => (String(role || '').trim().toLowerCase() === 'admin' ? 'Admin' : GUEST_ROLE);
  const EMAIL_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}$/;
  const BACKEND_RE = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;
  const isPlaceholder = (v) => !v || /REPLACE_WITH/i.test(String(v));

  /* ---------------------------------------------------------------- Utils */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const escapeHtml = (value) => String(value ?? '').replaceAll(/[&<>"'`]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]
  ));

  /** Only Google-hosted avatars are rendered; anything else is dropped. */
  const safePicture = (url) => (/^https:\/\/lh[3-6]\.googleusercontent\.com\//i.test(String(url || '')) ? String(url) : '');
  const matchesAudience = (itemGroups, memberGroups) => {
    const targets = Array.isArray(itemGroups)
      ? itemGroups.filter((group) => typeof group === 'string' && group.trim())
      : typeof itemGroups === 'string' ? itemGroups.split(',').map((group) => group.trim()).filter(Boolean) : [];
    if (!targets.length) return true;
    const assigned = new Set((Array.isArray(memberGroups) ? memberGroups : [])
      .filter((group) => typeof group === 'string')
      .map((group) => group.trim().toLowerCase()));
    return targets.some((group) => assigned.has(group.trim().toLowerCase()));
  };
  const guestNotice = (notice) => ({
    id: notice.id,
    at: notice.at,
    title: notice.title,
    message: notice.message,
    eventId: notice.eventId,
    groups: notice.groups,
  });
  const offlineSchedule = (itinerary) => (Array.isArray(itinerary) ? itinerary : [])
    .filter((event) => !Array.isArray(event.groups) || event.groups.length === 0);

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

  /** Uniform number in [0, 1) from the Web Crypto API. */
  const randomUnit = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;

  /** Display-only decode; the backend verifies the signature with Google on every call. */
  const decodeJwt = (token) => {
    try {
      const b64 = String(token).split('.')[1].replaceAll('-', '+').replaceAll('_', '/');
      const json = decodeURIComponent(atob(b64).split('').map((c) => `%${c.codePointAt(0).toString(16).padStart(2, '0')}`).join(''));
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
  const persistOfflineSchedule = (email, role, itinerary, savedAt = new Date().toISOString()) => {
    storage.set(STORAGE.DATA_CACHE, {
      email,
      role,
      itinerary: offlineSchedule(itinerary),
      savedAt,
      groupSafe: true,
    });
  };

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
      /** @type {Guest[]} */
      logistics: [],
      members: [],
      broadcastDraft: { title: '', body: '', groups: [] },
      myTravel: [],        // the signed-in guest's own pick-up / drop rows
      notifications: [],
      groups: [],
      knownGroups: [],
      groupCatalog: [],
      pushId: '',
      eventGroupsDrafts: {},
      memberGroupsDrafts: {},
      familyContact: null, // { name, phone } from Script Properties, if set
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
      logisticsMode: 'pickup', // 'pickup' (arrivals) | 'drop' (departures)
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
      if (body?.ok !== true) throw new ApiError(String(body?.code || 'SERVER_ERROR'), String(body?.error || 'Request failed.').slice(0, 300));
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
          Store.set({ isAdmin: false, role: GUEST_ROLE, tab: 'schedule', logistics: [], members: [] });
          void Auth.loadSession();
        }
        throw err;
      }
    },
  };

  /* ----------------------------------------------------------------- Auth */
  const Auth = {
    epoch: 0, // bumped whenever the signed-in identity ends/changes; stale responses are dropped
    renewTimer: null,
    offlineExpiryTimer: null,
    sessionRequest: null,

    clearOfflineExpiry() {
      clearTimeout(this.offlineExpiryTimer);
      this.offlineExpiryTimer = null;
    },

    scheduleOfflineExpiry(savedAt) {
      this.clearOfflineExpiry();
      const remaining = OFFLINE_CACHE_MAX_AGE_MS - (Date.now() - savedAt);
      this.offlineExpiryTimer = setTimeout(() => {
        if (navigator.onLine || Store.state.authStatus !== 'offline') return;
        storage.remove(STORAGE.DATA_CACHE);
        Store.set({ itinerary: [], lastSynced: null });
      }, Math.max(remaining, 0));
    },

    isExpired(user) { return !user?.exp || user.exp * 1000 < Date.now() + 30000; },

    async init() {
      storage.remove(STORAGE.CREDENTIAL); // migrate: tokens used to be kept in localStorage
      const saved = sessionStore.get(STORAGE.CREDENTIAL);
      if (saved?.idToken && !this.isExpired(saved)) {
        Store.set({ user: saved, authStatus: 'checking' });
        void this.loadSession(true); // reopening the app greets the guest again
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
      const savedAt = Date.parse(cache?.savedAt || '');
      const age = Date.now() - savedAt;
      if (!last?.email || !Array.isArray(cache?.itinerary) || cache.email !== last.email || cache.groupSafe !== true
        || !Number.isFinite(savedAt) || age < 0 || age > OFFLINE_CACHE_MAX_AGE_MS) {
        storage.remove(STORAGE.DATA_CACHE);
        return false;
      }
      Store.set({
        user: { email: last.email, name: last.name || last.email, picture: safePicture(last.picture) },
        authStatus: 'offline', role: GUEST_ROLE, isAdmin: false, logistics: [], members: [], myTravel: [],
        itinerary: cache.itinerary, notifications: [], groups: [], knownGroups: [], groupCatalog: [], pushId: '',
        eventGroupsDrafts: {}, memberGroupsDrafts: {}, lastSynced: cache.savedAt,
      });
      this.scheduleOfflineExpiry(savedAt);
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
      void this.loadSession(!wasAuthed);
    },

    async loadSession(announce = false, { showLoading = true } = {}) {
      const epoch = this.epoch;
      const current = this.sessionRequest;
      if (current?.epoch === epoch) {
        if (announce) current.announce = true;
        if (showLoading && !current.showLoading) {
          current.showLoading = true;
          Store.set({ loading: true });
        }
        return current.promise;
      }

      const request = { epoch, announce, showLoading, promise: null };
      this.sessionRequest = request;
      if (request.showLoading) Store.set({ loading: true });
      request.promise = (async () => {
        try {
          const data = await Api.post('session');
          if (epoch !== this.epoch) return;
          this.applySession(data, request.announce);
        } catch (err) {
          if (epoch === this.epoch) this.onSessionError(err);
        } finally {
          if (this.sessionRequest === request) {
            this.sessionRequest = null;
            Store.set({ loading: false });
          }
        }
      })();
      return request.promise;
    },

    applySession(data, announce) {
      this.clearOfflineExpiry();
      const savedAt = new Date().toISOString();
      const isAdmin = data.isAdmin === true && data.role === 'Admin';
      const openNotifications = notificationRoutePending;
      if (openNotifications) {
        notificationRoutePending = false;
        const params = new URLSearchParams(location.search);
        params.delete('open');
        const query = params.toString();
        history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
      }
      const user = {
        ...Store.state.user,
        name: String(data.name || Store.state.user.name).slice(0, 100),
        picture: safePicture(data.picture) || Store.state.user.picture,
      };
      const memberGroups = Array.isArray(data.groups) ? data.groups : [];
      const itinerary = Array.isArray(data.itinerary) ? data.itinerary : [];
      const notifications = Array.isArray(data.notifications) ? data.notifications : [];
      const preserveBroadcastDraft = isAdmin && Store.state.user?.email === user.email;
      const visibleItinerary = isAdmin ? itinerary : itinerary.filter((event) => matchesAudience(event.groups, memberGroups));
      const visibleNotifications = isAdmin
        ? notifications
        : notifications.filter((notice) => matchesAudience(notice.groups, memberGroups))
          .map(guestNotice);
      // Persist only what offline mode needs: the schedule and a token-free identity.
      persistOfflineSchedule(user.email, isAdmin ? 'Admin' : GUEST_ROLE, visibleItinerary, savedAt);
      storage.set(STORAGE.LAST_USER, { email: user.email, name: user.name, picture: user.picture });
      Store.set({
        authStatus: 'authed',
        role: isAdmin ? 'Admin' : GUEST_ROLE,
        isAdmin,
        tab: openNotifications ? 'notifications' : Store.state.tab,
        itinerary: visibleItinerary,
        logistics: isAdmin && Array.isArray(data.logistics) ? data.logistics : [],
        members: isAdmin && Array.isArray(data.members) ? data.members : [],
        myTravel: Array.isArray(data.myTravel) ? data.myTravel : [],
        familyContact: data.familyContact && typeof data.familyContact === 'object' ? data.familyContact : null,
        lastSynced: savedAt,
        error: null,
        tourStatus: ['Pending', 'Completed', 'Skipped'].includes(data.tourStatus) ? data.tourStatus : 'Completed',
        notifications: visibleNotifications,
        groups: memberGroups,
        knownGroups: Array.isArray(data.knownGroups) ? data.knownGroups : [],
        groupCatalog: Array.isArray(data.groupCatalog) ? data.groupCatalog : [],
        broadcastDraft: preserveBroadcastDraft ? Store.state.broadcastDraft : { title: '', body: '', groups: [] },
        pushId: typeof data.pushId === 'string' ? data.pushId : '',
        eventGroupsDrafts: {},
        memberGroupsDrafts: {},
        user,
      });
      void Push.identify(data.pushId);
      Nudges.onSync();
      if (openNotifications) return;
      if (announce) Welcome.show(user, { isAdmin, onClose: () => Tour.maybeStart() });
      else Tour.maybeStart();
    },

    onSessionError(err) {
      // Auth failures are already handled by Api (re-prompt / deny screen).
      if (['AUTH_EXPIRED', 'AUTH_INVALID', 'AUTH_REQUIRED', 'NOT_MEMBER'].includes(err.code)) return;
      // Couldn't verify (network/server). Fall back to cache if this member was verified before.
      if (Store.state.authStatus === 'checking' && !this.restoreOffline()) Store.set({ authStatus: 'signed-out' });
      Store.set({ error: err.message });
      Toast.show(`Could not sync: ${err.message}`, 'error');
    },

    clearSession(patch) {
      this.clearOfflineExpiry();
      this.epoch += 1;
      this.sessionRequest = null;
      void Push.logout();
      Tour.cancel();
      Nudges.reset();
      sessionStore.remove(STORAGE.CREDENTIAL);
      storage.remove(STORAGE.CREDENTIAL);
      storage.remove(STORAGE.LAST_USER);
      storage.remove(STORAGE.DATA_CACHE);
      Store.set({ user: null, role: null, isAdmin: false, loading: false, itinerary: [], logistics: [], members: [], myTravel: [], notifications: [], groups: [], knownGroups: [], groupCatalog: [], pushId: '', eventGroupsDrafts: {}, memberGroupsDrafts: {}, broadcastDraft: { title: '', body: '', groups: [] }, familyContact: null, tab: 'schedule', lastSynced: null, ...patch });
    },

    deny(email) {
      try { window.google?.accounts?.id?.disableAutoSelect(); } catch { /* ignore */ }
      this.clearSession({ authStatus: 'denied', deniedEmail: email });
      Modal.close();
    },

    handleExpired() {
      this.clearOfflineExpiry();
      this.epoch += 1;
      this.sessionRequest = null;
      void Push.logout();
      sessionStore.remove(STORAGE.CREDENTIAL);
      // Admin-only data must not linger on screen after the session ends.
      Store.set({ authStatus: 'signed-out', user: null, isAdmin: false, role: null, logistics: [], members: [], myTravel: [], notifications: [], groups: [], knownGroups: [], groupCatalog: [], pushId: '', eventGroupsDrafts: {}, memberGroupsDrafts: {}, broadcastDraft: { title: '', body: '', groups: [] }, loading: false, tab: 'schedule' });
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
        if (Store.state.authStatus === 'authed' && u?.exp * 1000 - Date.now() < 5 * 60 * 1000) this.prompt();
      }, 60000);
    },
  };

  /* ----------------------------------------------------------------- Push */
  const Push = {
    sdk: null,
    failed: false,
    pendingIdentity: '',
    loggedInIdentity: '',
    identityOperation: Promise.resolve(),
    supported: 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window,

    init() {
      if (isPlaceholder(CONFIG.ONESIGNAL_APP_ID)) { this.render(); return; }
      // If the SDK is blocked (ad-blocker, CSP, network) init never settles; surface that instead of "Loading…" forever.
      setTimeout(() => { if (!this.sdk) { this.failed = true; this.render(); } }, PUSH_INIT_TIMEOUT_MS);
      window.OneSignalDeferred ??= [];
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
          if (Store.state.pushId) void this.identify(Store.state.pushId);
          else void this.logout();
        } catch (err) {
          console.warn('OneSignal init failed', err);
          this.failed = true;
        }
        this.render();
      });
      this.render();
    },

    identify(externalId) {
      if (typeof externalId !== 'string' || !/^m_[a-f0-9]{40}$/.test(externalId)) return Promise.resolve();
      this.pendingIdentity = externalId;
      if (!this.sdk) return Promise.resolve();
      const sdk = this.sdk;
      this.identityOperation = this.identityOperation.catch((err) => {
        console.warn('OneSignal identity setup failed', err);
      }).then(async () => {
        if (this.pendingIdentity !== externalId || this.loggedInIdentity === externalId) return;
        await sdk.login(externalId).catch((e)=>{ if(e?.code==='invalid_aliases') return; throw e; });
        if (this.pendingIdentity === externalId) this.loggedInIdentity = externalId;
      }).catch((err) => {
        console.warn('OneSignal identity setup failed', err);
      });
      return this.identityOperation;
    },

    logout() {
      this.pendingIdentity = '';
      if (!this.sdk) return Promise.resolve();
      const sdk = this.sdk;
      this.identityOperation = this.identityOperation.catch((err) => {
        console.warn('OneSignal identity setup failed', err);
      }).then(async () => {
        await sdk.logout();
        this.loggedInIdentity = '';
      }).catch((err) => {
        console.warn('OneSignal identity sign-out failed', err);
      });
      return this.identityOperation;
    },

    status() {
      if (isPlaceholder(CONFIG.ONESIGNAL_APP_ID)) return 'unconfigured';
      if (isIos() && !isStandalone()) return 'ios-install';
      if (!this.supported) return 'unsupported';
      if (Notification.permission === 'denied') return 'denied';
      if (!this.sdk) return this.failed ? 'failed' : 'loading';
      // optedIn alone isn't enough: without an id OneSignal never registered the device (e.g. wrong SW path).
      const sub = this.sdk.User.PushSubscription;
      if (this.sdk.Notifications.permission && sub.optedIn && sub.id) return 'subscribed';
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
        failed: ['Notifications couldn’t start — an ad-blocker or a weak connection may be stopping them.', 'Retry'],
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
      if (!this.sdk) {
        if (this.failed) location.reload(); // the OneSignal SDK can only be initialised once per page
        return;
      }
      const btn = $('#notify-btn');
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      btn.innerHTML = '<span class="spinner" aria-hidden="true"></span><span class="sr-only">Requesting notifications</span>';
      try {
        await this.sdk.Notifications.requestPermission(); // triggers native browser prompt
        if (this.sdk.Notifications.permission && !this.sdk.User.PushSubscription.optedIn) {
          await this.sdk.User.PushSubscription.optIn();
        }
        if (this.sdk.Notifications.permission) Toast.show('Notifications enabled 🔔', 'success');
      } catch (err) {
        Toast.show(`Could not enable notifications: ${err.message || err}`, 'error');
      } finally {
        btn.removeAttribute('aria-busy');
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
        ...(isMapsUrl(event.mapLink) ? [`*Map:* ${event.mapLink}`] : []),
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
  // In-app browsers (WhatsApp, Instagram, Facebook…) cannot install PWAs; guests must open the link in Chrome/Safari.
  const isInAppBrowser = () => /FBAN|FBAV|FB_IAB|Instagram|WhatsApp|Line\/|; wv\)/i.test(navigator.userAgent);
  const isAndroid = () => /Android/i.test(navigator.userAgent);

  const Install = {
    deferred: null,
    installed: false,
    /** Shareable link that opens the install guide (e.g. sent on WhatsApp). */
    link() { return `${location.origin}${BASE_PATH}?install=1`; },

    showBanner() {
      const banner = $('#banner-install');
      banner.classList.remove('hidden');
      banner.classList.add('flex');
    },

    init() {
      const banner = $('#banner-install');
      window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        this.deferred = e;
        $('#install-btn').classList.remove('hidden');
        if (!storage.get(STORAGE.INSTALL_DISMISSED)) this.showBanner();
      });
      window.addEventListener('appinstalled', () => {
        this.deferred = null;
        this.installed = true;
        $('#install-text').textContent = `Installed on your home screen as “${CONFIG.EVENT_NAME || 'Event'}”.`;
        $('#install-btn').classList.add('hidden');
        this.showBanner();
        setTimeout(() => banner.classList.add('hidden'), 5000);
      });

      $('#install-btn').addEventListener('click', () => { void this.start(); });
      $('#install-dismiss').addEventListener('click', () => {
        storage.set(STORAGE.INSTALL_DISMISSED, true);
        banner.classList.add('hidden');
      });

      const params = new URLSearchParams(location.search);
      const fromLink = params.has('install');
      if (fromLink) {
        params.delete('install');
        const qs = params.toString();
        history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
      }
      if (isStandalone()) return;
      if (isIos()) {
        $('#install-text').textContent = 'Install: tap Share ⎋ then “Add to Home Screen”.';
        $('#install-btn').classList.remove('hidden');
        if (!storage.get(STORAGE.INSTALL_DISMISSED)) this.showBanner();
      }
      // Opened from the shared install link: always offer it, even if the banner was dismissed before.
      if (fromLink) {
        $('#install-btn').classList.remove('hidden');
        this.showBanner();
        setTimeout(() => { if (!Welcome.open) this.guide(); }, 600);
      }
    },

    /** Native prompt where the browser allows it; otherwise step-by-step instructions. */
    async start() {
      if (!this.deferred) { this.guide(); return; }
      const prompt = this.deferred;
      this.deferred = null;
      prompt.prompt();
      const choice = await prompt.userChoice.catch(() => null);
      if (choice?.outcome === 'accepted' && !this.installed) {
        $('#install-text').textContent = 'Installation started. Waiting for your device to confirm…';
      }
    },

    guide() {
      if (isStandalone()) { Toast.show('The app is already installed on this device. 🌼', 'success'); return; }
      const step = (n, html) => `<li class="flex gap-3"><span class="w-7 h-7 shrink-0 rounded-full bg-haldi-100 text-kumkum-800 grid place-items-center text-xs font-bold">${n}</span><span class="pt-1">${html}</span></li>`;
      let steps;
      if (isInAppBrowser()) {
        steps = [
          `Tap the <b>⋮</b> or <b>…</b> menu at the top of this screen.`,
          `Choose <b>${isIos() ? 'Open in Safari' : 'Open in Chrome'}</b> (or “Open in browser”).`,
          'Then open this guide again from the 📲 banner.',
        ];
      } else if (isIos()) {
        steps = [
          'Make sure this page is open in <b>Safari</b>.',
          'Tap the <b>Share</b> button <span aria-hidden="true">⎋</span> at the bottom of the screen.',
          'Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.',
        ];
      } else if (isAndroid()) {
        steps = [
          'Open this page in <b>Chrome</b>.',
          'Tap the <b>⋮</b> menu at the top-right.',
          'Tap <b>Install app</b> (or <b>Add to Home screen</b>), then <b>Install</b>.',
        ];
      } else {
        steps = [
          'Open this page in <b>Chrome</b> or <b>Edge</b>.',
          'Click the <b>install</b> icon <span aria-hidden="true">⊕</span> at the right of the address bar.',
          'Click <b>Install</b>.',
        ];
      }
      Modal.open(`
        <div class="text-center">
          <div class="text-3xl" aria-hidden="true">📲</div>
          <h3 class="font-display text-2xl text-kumkum-800 mt-1">Add the app to your phone</h3>
          <p class="text-sm text-ink-500 mt-1">One tap from your home screen — schedule, live alerts and your pick-up.</p>
        </div>
        ${isInAppBrowser() ? '<p class="mt-3 rounded-xl bg-marigold-100 text-marigold-900 px-3 py-2 text-xs">This link opened inside another app, which can’t install apps. Please open it in your browser first.</p>' : ''}
        <ol class="mt-4 space-y-3 text-sm text-ink-700">${steps.map((t, i) => step(i + 1, t)).join('')}</ol>
        <button type="button" class="btn-primary w-full mt-5" data-modal="close">Got it</button>`, {
        onMount: (root) => root.querySelector('[data-modal="close"]').addEventListener('click', () => Modal.close()),
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
        if ('modalBackdrop' in e.target.dataset) this.close();
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
      const rand = randomUnit;
      for (let i = 0; i < count; i++) {
        const p = document.createElement('span');
        p.className = 'petal';
        p.textContent = kinds[i % kinds.length];
        p.style.left = `${rand() * 100}%`;
        p.style.fontSize = `${14 + rand() * 14}px`;
        p.style.animationDuration = `${3.5 + rand() * 3}s`;
        p.style.animationDelay = `${rand() * 1.2}s`;
        p.style.setProperty('--drift', `${(rand() - 0.5) * 160}px`);
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
      const where = e.location ? ` at ${e.location}` : '';
      Toast.show(`🪔 ${e.title} has begun${where} — please join us!`, 'success', 6500);
      Festive.petals(20);
    },
    reset() { this.seenLive = null; },
  };

  // Only Google Maps https links are ever used as hrefs (the backend applies the same allow-list).
  const MAPS_URL_RE = /^https:\/\/(?:(?:www\.|maps\.)?google\.[a-z.]{2,6}\/maps|maps\.google\.[a-z.]{2,6}\/|maps\.app\.goo\.gl\/|goo\.gl\/maps\/)[^\s"'<>]*$/i;
  const isMapsUrl = (url) => typeof url === 'string' && url.length <= 500 && MAPS_URL_RE.test(url);
  const mapsSearch = (text) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(String(text).slice(0, 200))}`;
  /** The admin-pinned Google Maps link when there is one, otherwise a search for the location name. */
  const mapsLink = (e) => (isMapsUrl(e.mapLink) ? e.mapLink : (e.location ? mapsSearch(e.location) : ''));

  /* -------------------------------------------------------------- Welcome */
  // Auspicious opening: Ganesh Vandana, then a personal welcome. Plays on every sign-in and every
  // time the app is opened — independent of the one-time tour (which may follow it).
  const Welcome = {
    open: false,

    show(user, { isAdmin = false, onClose } = {}) {
      if (this.open || !user) return;
      this.open = true;

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
            O Lord Ganesha, who has a curved trunk and a massive body, and whose brilliance is equal to millions of suns — please make all our endeavors free of obstacles, and bless our work always.
          </p>
          <div class="welcome-line delay-3 paisley-divider my-5" aria-hidden="true"></div>
          <h2 id="welcome-title" class="welcome-line delay-3 font-display text-3xl text-ivory-50">स्वागतम्, ${escapeHtml(firstNameOf(user))} ji 🙏</h2>
          <p class="welcome-line delay-3 mt-2 text-sm text-ivory-100/90">
            ${isAdmin ? 'Welcome back! Here is your central dashboard to manage and run' : 'With joy in our hearts, we welcome you to'}
          </p>
          <b class="text-haldi-200">${eventName}</b>
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
  // row in the Members sheet so it never replays for that member on any device.
  const Tour = {
    active: false,
    index: 0,
    steps: [],
    els: null,
    replay: false,
    finishing: false,
    currentTarget: '',

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
      const steps = [
        { id: 'welcome', tab: 'schedule', title: `Namaste, ${name} ji 🙏`, body: 'A quick walk-through of the places and tools that will help you enjoy the celebration.' },
        { id: 'schedule', tab: 'schedule', targets: ['#view [data-tour="schedule-overview"]'], title: 'Your celebration schedule', body: 'The programme is arranged by day, highlights what is Live or Up next, and links each venue to its map.' },
        { id: 'schedule-days', tab: 'schedule', targets: ['#view [data-tour="schedule-days"]', '#view [data-tour="schedule-overview"]'], title: 'Explore every day', body: 'When more than one day is listed, use the day buttons to jump between them. The schedule refreshes automatically.' },
        { id: 'notifications', tab: 'notifications', targets: ['#view [data-tour="notifications-overview"]'], title: 'Host announcements', body: 'Live updates appear here. Clear hides them for your account without removing shared history.' },
      ];
      if (s.isAdmin) {
        steps.push(
          { id: 'event-control', tab: 'control', targets: ['#view [data-tour="event-control"]'], title: 'Event Control', body: 'Create ceremonies, choose their audience, then mark one Live to notify guests and prepare a WhatsApp broadcast.' },
          { id: 'broadcast', tab: 'broadcast', targets: ['#view [data-tour="broadcast-overview"]'], title: 'Broadcast', body: 'Send a standalone note to everyone or selected groups, then optionally open the same title and message in WhatsApp.' },
          { id: 'pick-drop', tab: 'pickups', targets: ['#view [data-tour="pick-drop-overview"]'], title: 'Pick-up and drop-off', body: 'Add and edit travel plans, switch between arrivals and departures, and track each family’s progress.' },
          { id: 'members', tab: 'members', targets: ['#view [data-tour="members-overview"]'], title: 'Members & access', body: 'Invite Atithis, assign roles and group labels, and manage the available group labels.' },
        );
      } else {
        steps.push({
          id: 'travel', tab: 'travel', targets: ['#view [data-tour="travel-overview"]'],
          title: 'Your travel plans',
          body: s.myTravel.length
            ? 'Check your arrival pick-up and departure drop here. If the details do not match your latest plan, contact the family shown on this screen.'
            : 'Your arrival and departure details will appear here once the family adds them. If you need to confirm your RSVP, please contact the family.',
        });
      }
      steps.push(
        { id: 'notify', tab: 'schedule', targets: ['[data-tour="notification-opt-in"]'], title: 'Never miss a ceremony', body: 'Use the notification banner to opt in if it is shown. If it is hidden, notifications may already be enabled. This tour never opens a permission prompt.' },
        { id: 'profile', tab: 'schedule', targets: ['#account-btn'], title: 'Your profile and help', body: 'See your account, replay this tour, open the install guide, or sign out.' },
        { id: 'summary', tab: 'schedule', title: 'You’re all set 🪔', body: 'That is everything you need. Enjoy every moment of the celebration!' },
      );
      return steps;
    },

    visible(sel) {
      const el = $(sel);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    },

    targetFor(step) {
      return (step.targets || []).find((sel) => this.visible(sel)) || '';
    },

    start({ replay = false } = {}) {
      if (this.active) return;
      if (Store.state.tab !== 'schedule') Store.set({ tab: 'schedule' });
      this.steps = this.buildSteps();
      if (!this.steps.length) return;
      this.active = true;
      this.replay = replay;
      this.finishing = false;
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
      root.querySelector('[data-tour="skip"]').addEventListener('click', (e) => { void this.finish('Skipped', e.currentTarget); });
      root.querySelector('[data-tour="back"]').addEventListener('click', () => this.go(this.index - 1));
      root.querySelector('[data-tour="next"]').addEventListener('click', () => this.go(this.index + 1));
      this.onKey = (e) => {
        if (e.key === 'Escape') { void this.finish('Skipped', root.querySelector('[data-tour="skip"]')); }
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
      if (!this.active || this.finishing) return;
      if (i >= this.steps.length) { void this.finish('Completed', this.els.root.querySelector('[data-tour="next"]')); return; }
      this.index = Math.max(0, i);
      const step = this.steps[this.index];
      const { root } = this.els;
      const previousTab = Store.state.tab;
      if (step.tab && Store.state.tab !== step.tab) Store.set({ tab: step.tab });
      root.querySelector('#tour-title').innerHTML = step.title; // titles are escaped in buildSteps
      root.querySelector('#tour-body').textContent = step.body;
      root.querySelector('[data-tour="count"]').textContent = `Step ${this.index + 1} of ${this.steps.length}`;
      root.dataset.stepId = step.id;
      root.dataset.stepTab = step.tab || Store.state.tab;
      root.querySelector('[data-tour="back"]').classList.toggle('invisible', this.index === 0);
      const next = root.querySelector('[data-tour="next"]');
      next.textContent = this.index === this.steps.length - 1 ? 'Finish tour' : 'Next';
      next.dataset.idleText = next.textContent;
      const targetSelector = this.targetFor(step);
      root.dataset.stepTarget = targetSelector;
      this.currentTarget = targetSelector;
      root.querySelector('[data-tour="dots"]').innerHTML = this.steps
        .map((_, n) => `<span class="h-1.5 rounded-full transition-all ${n === this.index ? 'w-5 bg-kumkum-600' : 'w-1.5 bg-haldi-300'}"></span>`).join('');
      const index = this.index;
      const positionStep = () => {
        if (!this.active || this.index !== index) return;
        const target = this.currentTarget && $(this.currentTarget);
        if (target) target.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
        this.position();
        setTimeout(() => { if (this.active && this.index === index) this.position(); }, 380);
      };
      if (previousTab !== Store.state.tab) requestAnimationFrame(positionStep);
      else positionStep();
      next.focus({ preventScroll: true });
    },

    position() {
      if (!this.active) return;
      const { spot, shade, card } = this.els;
      const target = this.currentTarget && $(this.currentTarget);
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

    setControlBusy(button, busy) {
      if (!button) return;
      const idleText = button.dataset.idleText || button.textContent.trim();
      button.dataset.idleText = idleText;
      button.disabled = busy;
      button.setAttribute('aria-busy', String(busy));
      if (busy) {
        button.setAttribute('aria-label', 'Saving tour progress');
        button.innerHTML = '<span class="spinner" aria-hidden="true"></span><span class="sr-only">Saving tour progress</span>';
      } else {
        button.removeAttribute('aria-label');
        button.textContent = idleText;
      }
    },

    close() {
      this.active = false;
      document.removeEventListener('keydown', this.onKey);
      window.removeEventListener('resize', this.onLayout);
      window.removeEventListener('scroll', this.onLayout);
      this.els?.root.remove();
      this.els = null;
      this.currentTarget = '';
      this.finishing = false;
    },

    async finish(status, button) {
      if (!this.active || this.finishing) return;
      if (this.replay) {
        this.close();
        this.replay = false;
        return;
      }
      const s = Store.state;
      if (!s.user) { this.close(); return; }
      const email = s.user.email;
      this.finishing = true;
      this.setControlBusy(button, true);
      const result = await Actions.run('tour:complete', () => Api.post('completeTour', { status }));
      if (!result) {
        this.finishing = false;
        this.setControlBusy(button, false);
        return;
      }
      if (!this.active || Store.state.user?.email !== email) return;
      sessionStore.set(this.doneKey(s.user.email), status);
      Store.set({ tourStatus: status });
      this.close();
      if (status === 'Completed') { Festive.petals(18); Toast.show('Wonderful! Enjoy the celebration 🌼', 'success'); }
    },

    cancel() { // sign-out / identity change: close without recording anything
      this.close();
      this.replay = false;
    },
  };

  /* ---------------------------------------------------------------- Views */
  const STATUS_STYLES = {
    Live: 'bg-kumkum-600 text-ivory-50 ring-kumkum-700',
    Upcoming: 'bg-haldi-100 text-haldi-800 ring-haldi-300',
    Completed: 'bg-ivory-200 text-ink-500 ring-ivory-300',
    Pending: 'bg-marigold-100 text-marigold-800 ring-marigold-300',
    'Picked Up': 'bg-mehndi-100 text-mehndi-800 ring-mehndi-300',
    'Dropped Off': 'bg-mehndi-100 text-mehndi-800 ring-mehndi-300',
  };
  const STATUS_LABEL = { Live: 'Live now', Completed: '✓ Completed' };

  const badge = (status) => `<span class="inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ${STATUS_STYLES[status] || STATUS_STYLES.Upcoming}">
      ${status === 'Live' ? '<span class="w-1.5 h-1.5 rounded-full bg-ivory-50 animate-pulse"></span>' : ''}${escapeHtml(STATUS_LABEL[status] || status)}</span>`;

  const pendingAttrs = (key) => (Store.isPending(key) ? 'aria-busy="true"' : '');
  const spinnerOr = (key, label) => (Store.isPending(key)
    ? `<span class="spinner" aria-hidden="true"></span><span class="sr-only">Working: ${label}</span>`
    : label);

  const emptyState = (icon, title, text = '') => `
    <div class="card relative overflow-hidden text-center py-12 px-6">
      <div class="mandala-layer" aria-hidden="true"></div>
      <div class="relative text-4xl mb-2" aria-hidden="true">${icon}</div>
      <p class="relative font-display text-xl text-kumkum-700">${escapeHtml(title)}</p>
      ${text ? `<p class="relative text-sm text-ink-500 mt-1">${escapeHtml(text)}</p>` : ''}
    </div>`;

  const pageHeader = (eyebrow, title, text = '', tour = '') => `
    <header ${tour ? `data-tour="${tour}"` : ''} class="mb-4">
      <p class="eyebrow">${eyebrow}</p>
      <h2 class="section-title">${title}</h2>
      ${text ? `<p class="text-sm text-ink-500 mt-1">${text}</p>` : ''}
    </header>`;

  const DOT_CLASS = { Live: 'bg-kumkum-600', Completed: 'bg-ink-300', Upcoming: 'bg-marigold-400' };

  const groupByDay = (events) => events.reduce((acc, ev) => {
    const key = ev.day || 'Schedule';
    if (!acc[key]) acc[key] = [];
    acc[key].push(ev);
    return acc;
  }, {});

  const pin = '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>';
  const clock = '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

  const locationLine = (e, cls = 'text-ink-500') => (e.location ? `
    <a href="${escapeHtml(mapsLink(e))}" target="_blank" rel="noopener noreferrer"
      class="inline-flex items-center gap-1 text-sm ${cls} hover:underline underline-offset-2">${pin}${escapeHtml(e.location)}</a>` : '');

  const ScheduleParts = {
    hero(s) {
      const g = Festive.greeting();
      const total = s.itinerary.length;
      const done = s.itinerary.filter((e) => e.status === 'Completed').length;
      const pct = total ? Math.round((done / total) * 100) : 0;
      return `
        <section data-tour="schedule-overview" class="card relative overflow-hidden p-5 bg-gradient-to-br from-ivory-50 via-haldi-50 to-marigold-50">
          <div class="mandala-layer mandala-hero" aria-hidden="true"></div>
          <p class="relative eyebrow"><span lang="hi">${g.hi}</span> · ${g.en}</p>
          <h2 class="relative mt-1 font-display text-2xl text-kumkum-700">Namaste, ${escapeHtml(firstNameOf(s.user))} ji 🙏</h2>
          <p class="relative mt-1 text-sm text-ink-600">We’re delighted to celebrate with you. Here’s everything planned for you.</p>
          ${total ? `
          <div class="relative mt-4">
            <div class="flex justify-between text-[11px] font-semibold text-ink-500"><span>${done} of ${total} ceremonies done</span><span>${pct}%</span></div>
            <div class="mt-1 h-1.5 rounded-full bg-haldi-100 overflow-hidden" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Celebration progress">
              <div class="h-full rounded-full bg-gradient-to-r from-marigold-400 to-kumkum-500 transition-all w-0" data-progress="${pct}"></div>
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
          ${e.location ? `<a href="${escapeHtml(mapsLink(e))}" target="_blank" rel="noopener noreferrer" class="relative btn btn-gold btn-sm mt-4">Take me there</a>` : ''}
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
        <nav id="tour-days" data-tour="schedule-days" aria-label="Jump to day" class="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 py-1">
          ${days.map(([day, events], i) => {
            const hasLive = events.some((e) => e.status === 'Live');
            const allDone = events.every((e) => e.status === 'Completed');
            let mark = '';
            if (allDone) mark = ' ✓';
            else if (hasLive) mark = ' •';
            return `<button data-action="jump-day" data-day="${i}" class="chip-off shrink-0 ${hasLive ? 'ring-2 ring-kumkum-400' : ''}">
              Day ${i + 1}${mark}<span class="sr-only"> — ${escapeHtml(day)}</span></button>`;
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
                <span class="absolute -left-[29px] top-5 grid place-items-center w-4 h-4 rounded-full ring-4 ring-ivory-100 ${DOT_CLASS[e.status] || DOT_CLASS.Upcoming}" aria-hidden="true"></span>
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
            <p class="relative mt-6 text-[11px] text-ink-400">We only use your Google name and email to confirm access on this app.</p>
          </article>
        </div>`;
    },
  };

  const groupPicker = (catalog, selected, action, identity = {}, busy = false) => {
    const chosen = new Set(selected.map((label) => label.toLowerCase()));
    const groups = catalog.filter((group) => group.status === 'Active' || chosen.has(group.label.toLowerCase()));
    if (!groups.length) return '<p class="text-xs text-ink-500">No groups yet. Add labels in Members &amp; access.</p>';
    return `<fieldset class="mt-1 grid gap-1.5 rounded-xl border border-haldi-200 p-2">
      <legend class="sr-only">Select groups</legend>
      ${groups.map((group) => {
        const checked = chosen.has(group.label.toLowerCase());
        const archived = group.status !== 'Active';
        return `<label class="flex min-h-[44px] items-center gap-2 rounded-lg px-2 text-sm ${archived ? 'text-ink-500' : 'text-ink-700'}">
          <input type="checkbox" name="groups" value="${escapeHtml(group.label)}" data-action="${action}"
            ${identity.id ? `data-id="${escapeHtml(identity.id)}"` : ''}
            ${identity.email ? `data-email="${escapeHtml(identity.email)}"` : ''}
            ${checked ? 'checked' : ''} ${busy || (archived && !checked) ? 'disabled' : ''}
            class="h-4 w-4 accent-kumkum-700" />
          <span>${escapeHtml(group.label)}${archived ? ' <span class="text-[11px]">(archived)</span>' : ''}</span>
        </label>`;
      }).join('')}
    </fieldset>`;
  };
  const checkedGroups = (root) => [...root.querySelectorAll('input[name="groups"]:checked')].map((input) => input.value);
  const addButton = (action, label) => `
    <button data-action="${action}" class="btn btn-primary w-full mb-4">＋ ${label}</button>`;

  Views.control = (s) => {
    const header = pageHeader('Host console', 'Event Control', '<b>Set Live &amp; Broadcast</b> updates the sheet, notifies the intended audience and opens WhatsApp with a ready-to-send message.', 'event-control');
    if (!s.itinerary.length) {
      return `${header}${addButton('add-event', 'Add a ceremony')}${emptyState('🎛️', 'No ceremonies yet', 'Add the first ceremony of the celebration above.')}`;
    }
    return `
      ${header}
      ${addButton('add-event', 'Add a ceremony')}
      <div class="space-y-3">
        ${s.itinerary.map((e) => {
          const key = `event:${e.id}`;
          const busy = Store.isPending(key);
          const groupsBusy = Store.isPending(`event-groups:${e.id}`);
          return `
          <article class="card p-4 ${e.status === 'Live' ? 'ring-2 ring-kumkum-400' : ''}">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <p class="text-[11px] font-semibold text-ink-400">#${escapeHtml(e.id)} · ${escapeHtml(e.day)} · ${escapeHtml(e.time)}</p>
                <h4 class="font-semibold text-ink-900 truncate">${escapeHtml(e.title)}</h4>
                <p class="text-sm text-ink-500 truncate inline-flex items-center gap-1">${pin}${escapeHtml(e.location || 'TBA')}</p>
                <p class="text-[11px] text-ink-500 mt-1">Audience: <b>${escapeHtml((e.groups || []).join(', ') || 'Everyone')}</b></p>
              </div>
              ${badge(e.status)}
            </div>
            <div class="mt-3 grid grid-cols-2 gap-2">
              <button data-action="open-broadcast" data-id="${escapeHtml(e.id)}" ${busy ? 'disabled' : ''} ${pendingAttrs(key)} class="btn btn-live col-span-2">
                ${spinnerOr(key, e.status === 'Live' ? '📣 Re-announce &amp; Broadcast' : '🪔 Set Live &amp; Broadcast')}
              </button>
              <button data-action="share-whatsapp" data-id="${escapeHtml(e.id)}" class="btn btn-whatsapp btn-sm">Share to WhatsApp</button>
              <div class="flex min-w-0 items-center gap-2">
                <select data-action="set-status" data-id="${escapeHtml(e.id)}" aria-label="Change status of ${escapeHtml(e.title)}" ${busy ? 'disabled' : ''} class="input flex-1 py-2 text-sm">
                  ${['Upcoming', 'Live', 'Completed'].map((st) => `<option value="${st}" ${st === e.status ? 'selected' : ''}>${st}</option>`).join('')}
                </select>
                ${busy ? '<span role="status" aria-label="Updating event status"><span class="spinner" aria-hidden="true"></span><span class="sr-only">Updating event status</span></span>' : ''}
              </div>
              <button data-action="delete-event" data-id="${escapeHtml(e.id)}" ${busy ? 'disabled' : ''} ${pendingAttrs(key)} aria-label="Delete ${escapeHtml(e.title)}"
                class="btn btn-ghost btn-sm col-span-2 min-h-[44px] text-kumkum-700">${spinnerOr(key, '🗑 Delete ceremony')}</button>
              <div class="col-span-2 block text-xs font-semibold text-ink-500">Audience groups (no selection = everyone)
                ${groupPicker(s.groupCatalog, s.eventGroupsDrafts[e.id] ?? (e.groups || []), 'event-groups', { id: e.id }, groupsBusy)}
                <button data-action="save-event-groups" data-id="${escapeHtml(e.id)}" ${groupsBusy ? 'disabled' : ''} ${pendingAttrs(`event-groups:${e.id}`)} class="btn btn-ghost btn-sm mt-2 min-h-[44px]">${spinnerOr(`event-groups:${e.id}`, 'Save audience')}</button>
              </div>
            </div>
          </article>`;
        }).join('')}
      </div>`;
  };

  Views.broadcast = (s) => {
    const draft = s.broadcastDraft || { title: '', body: '', groups: [] };
    const busy = Store.isPending('broadcast:send');
    return `
      ${pageHeader('Host console', 'Broadcast', 'Send a note that is not tied to a ceremony.', 'broadcast-overview')}
      <section class="card p-4 space-y-4">
        <p class="text-sm text-ink-600">No groups selected means everyone. Select multiple groups to reach members in any selected group.</p>
        ${field('Notification title', `<input id="broadcast-title" data-action="broadcast-title" type="text" maxlength="200" required value="${escapeHtml(draft.title)}" class="input" autocomplete="off" />`)}
        ${field('Message', `<textarea id="broadcast-body" data-action="broadcast-body" maxlength="500" rows="5" required class="input">${escapeHtml(draft.body)}</textarea>`)}
        <fieldset>
          <legend class="block text-xs font-semibold text-ink-500">Audience groups (optional)</legend>
          ${groupPicker(s.groupCatalog, draft.groups, 'broadcast-groups')}
        </fieldset>
        <div class="grid gap-2 sm:grid-cols-2">
          <button type="button" data-action="broadcast-send" ${busy ? 'disabled' : ''} ${pendingAttrs('broadcast:send')} class="btn btn-primary min-h-[44px]">
            ${spinnerOr('broadcast:send', '📣 Broadcast')}
          </button>
          <button type="button" data-action="broadcast-whatsapp" ${busy ? 'disabled' : ''} ${pendingAttrs('broadcast:send')} class="btn btn-whatsapp min-h-[44px]">
            ${spinnerOr('broadcast:send', '📣 Broadcast + WhatsApp')}
          </button>
        </div>
      </section>`;
  };

  /** Pick-up (arrival) and drop (departure) are the same rows seen through two lenses. */
  const TRAVEL_MODES = {
    pickup: { statusKey: 'pickupStatus', done: 'Picked Up', timeKey: 'arrival', action: 'toggle-pickup', keyPrefix: 'pickup', doneLabel: '✓ Mark as Picked Up', welcomed: 'families welcomed', icon: '🚐' },
    drop: { statusKey: 'dropStatus', done: 'Dropped Off', timeKey: 'departure', action: 'toggle-dropoff', keyPrefix: 'drop', doneLabel: '✓ Mark as Dropped Off', welcomed: 'families seen off', icon: '🧳' },
  };

  /** Soonest first; rows without a time go last. */
  const byTime = (key) => (a, b) => {
    const ta = Date.parse(a[key]) || Infinity;
    const tb = Date.parse(b[key]) || Infinity;
    return ta - tb;
  };

  const telHref = (contact) => escapeHtml(String(contact).replaceAll(/[^\d+]/g, ''));

  Views.pickups = (s) => {
    const mode = TRAVEL_MODES[s.logisticsMode] || TRAVEL_MODES.pickup;
    const q = s.pickupSearch.trim().toLowerCase();
    const list = s.logistics.filter((g) => {
      if (s.pickupFilter !== 'all' && g[mode.statusKey] !== s.pickupFilter) return false;
      if (!q) return true;
      return [g.name, g.contact, g.mode, g.id, g.email].some((v) => String(v || '').toLowerCase().includes(q));
    }).sort(byTime(mode.timeKey));
    const done = s.logistics.filter((g) => g[mode.statusKey] === mode.done).length;
    const total = s.logistics.length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const chip = (value, label) => `<button data-action="pickup-filter" data-value="${value}" aria-pressed="${s.pickupFilter === value}"
        class="${s.pickupFilter === value ? 'chip-on' : 'chip-off'} shrink-0">${label}</button>`;
    const modeTab = (value, label) => `<button data-action="logistics-mode" data-value="${value}" role="tab" aria-selected="${s.logisticsMode === value}"
        class="${s.logisticsMode === value ? 'chip-on' : 'chip-off'} flex-1 justify-center min-h-[44px] text-sm">${label}</button>`;

    const empty = total
      ? emptyState(mode.icon, 'No matching guests', 'Try a different search or filter.')
      : emptyState(mode.icon, 'No travel plans yet', 'Add the first arriving family above.');
    const guestCount = (g) => (g.members ? `<span class="text-xs font-normal text-ink-500">· ${escapeHtml(g.members)} guests</span>` : '');
    const contactLink = (g) => (g.contact
      ? `<a href="tel:${telHref(g.contact)}" class="text-sm font-medium text-kumkum-600">📞 ${escapeHtml(g.contact)}</a>`
      : '');

    const listHtml = `
      <div class="space-y-3">
        ${list.map((g) => {
          const finished = g[mode.statusKey] === mode.done;
          const key = `${mode.keyPrefix}:${g.id}`;
          return `
          <article class="card p-4 ${finished ? 'ring-1 ring-mehndi-300' : ''}">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <h4 class="font-semibold text-ink-900 truncate">${escapeHtml(g.name)} ${guestCount(g)}</h4>
                ${contactLink(g)}
                ${g.email ? `<p class="text-[11px] text-ink-400 truncate">Linked to ${escapeHtml(g.email)}</p>` : ''}
              </div>
              ${badge(g[mode.statusKey])}
            </div>
            <dl class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-ink-600">
              <div><dt class="text-ink-400">Arrival</dt><dd class="${mode.timeKey === 'arrival' ? 'font-semibold text-ink-800' : ''}">${escapeHtml(formatDateTime(g.arrival))}</dd></div>
              <div><dt class="text-ink-400">Departure</dt><dd class="${mode.timeKey === 'departure' ? 'font-semibold text-ink-800' : ''}">${escapeHtml(formatDateTime(g.departure))}</dd></div>
              <div class="col-span-2"><dt class="text-ink-400 inline">Mode:</dt> <dd class="inline">${escapeHtml(g.mode || '—')}</dd></div>
            </dl>
            <div class="grid grid-cols-[auto_1fr] gap-2 mt-3">
              <button data-action="edit-pickup" data-id="${escapeHtml(g.id)}" class="btn btn-ghost px-4" aria-label="Edit ${escapeHtml(g.name)}">✎ Edit</button>
              <button data-action="${mode.action}" data-id="${escapeHtml(g.id)}" data-next="${finished ? 'Pending' : mode.done}" ${Store.isPending(key) ? 'disabled' : ''} ${pendingAttrs(key)}
                class="btn ${finished ? 'btn-ghost' : 'btn-primary'}">
                ${spinnerOr(key, finished ? '↩︎ Mark as Pending' : mode.doneLabel)}
              </button>
            </div>
          </article>`;
        }).join('')}
      </div>`;

    return `
      ${pageHeader('Arrivals &amp; departures', 'Pick &amp; Drop', '', 'pick-drop-overview')}
      <div class="flex gap-2 mb-3" role="tablist" aria-label="Pick-up or drop">${modeTab('pickup', '🚐 Pick-up')}${modeTab('drop', '🧳 Drop')}</div>
      ${addButton('add-pickup', 'Add a guest’s travel')}
      <div class="card p-4 mb-3">
        <div class="flex justify-between text-sm text-ink-700"><span>${done} of ${total} ${mode.welcomed}</span><span class="font-semibold">${pct}%</span></div>
        <div class="mt-2 h-2 rounded-full bg-haldi-100 overflow-hidden"><div class="h-full rounded-full bg-gradient-to-r from-mehndi-400 to-mehndi-600 transition-all w-0" data-progress="${pct}"></div></div>
      </div>
      <input type="search" data-action="pickup-search" value="${escapeHtml(s.pickupSearch)}" placeholder="Search name, contact, mode, email…" aria-label="Search travel plans" class="input" />
      <div class="flex gap-2 my-3 overflow-x-auto no-scrollbar">
        ${chip('all', `All (${total})`)}${chip('Pending', `Pending (${total - done})`)}${chip(mode.done, `${mode.done} (${done})`)}
      </div>
      ${list.length ? listHtml : empty}`;
  };

  /** A guest's own pick-up and drop, with whom to call if plans change. */
  Views.travel = (s) => {
    const contact = s.familyContact;
    const contactCard = contact ? `
      <div class="card p-4 mt-4 flex items-center gap-3">
        <div class="w-11 h-11 shrink-0 rounded-full bg-haldi-100 grid place-items-center text-xl" aria-hidden="true">🙏</div>
        <div class="flex-1 min-w-0">
          <p class="text-xs text-ink-500">Plans changed? Please let us know</p>
          <p class="font-semibold text-ink-900 truncate">${escapeHtml(contact.name || 'The family')}</p>
        </div>
        ${contact.phone ? `<a href="tel:${telHref(contact.phone)}" class="btn btn-primary btn-sm shrink-0">📞 Call</a>` : ''}
      </div>` : '';
    const step = (icon, label, when, status, done) => `
      <div class="flex items-start gap-3">
        <div class="w-10 h-10 shrink-0 rounded-full ${status === done ? 'bg-mehndi-100' : 'bg-marigold-100'} grid place-items-center text-lg" aria-hidden="true">${icon}</div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between gap-2"><p class="text-sm font-semibold text-ink-900">${label}</p>${badge(status)}</div>
          <p class="text-xs text-ink-600">${escapeHtml(formatDateTime(when))}</p>
        </div>
      </div>`;

    if (s.authStatus === 'offline') return `${pageHeader('Your journey', 'My travel', '', 'travel-overview')}${emptyState('📶', 'You’re offline', 'Connect to the internet to see your pick-up and drop.')}${contactCard}`;
    if (!s.myTravel.length) {
      return `
        ${pageHeader('Your journey', 'My travel', '', 'travel-overview')}
        ${emptyState('🚐', 'No travel plans yet', 'Once the family adds your arrival, your pick-up and drop will show up here.')}
        ${contactCard}`;
    }
    return `
      ${pageHeader('Your journey', 'My travel', 'We will be there to receive you and to see you off. 🌼', 'travel-overview')}
      <div class="space-y-3">
        ${s.myTravel.map((g) => `
          <article class="card p-4 space-y-3">
            <div class="flex items-center justify-between gap-2">
              <h3 class="font-display text-xl text-kumkum-700 truncate">${escapeHtml(g.name)}</h3>
              ${g.members ? `<span class="text-xs text-ink-500 shrink-0">${escapeHtml(g.members)} guest(s)</span>` : ''}
            </div>
            ${step('🚐', 'Pick-up on arrival', g.arrival, g.pickupStatus, 'Picked Up')}
            ${step('🧳', 'Drop on departure', g.departure, g.dropStatus, 'Dropped Off')}
            <p class="text-xs text-ink-500">Travelling by <b>${escapeHtml(g.mode || '—')}</b>${g.contact ? ` · we’ll call ${escapeHtml(g.contact)}` : ''}</p>
          </article>`).join('')}
      </div>
      ${contactCard}`;
  };

  Views.members = (s) => {
    const me = s.user?.email;
    const q = s.memberSearch.trim().toLowerCase();
    const list = s.members.filter((m) => !q || m.email.includes(q) || m.role.toLowerCase() === q || (m.groups || []).some((g) => g.toLowerCase().includes(q)));
    const adminCount = s.members.filter((m) => m.role === 'Admin').length;
    const roleOptions = (current) => ROLES.map((r) => `<option value="${r}" ${r === current ? 'selected' : ''}>${r}</option>`).join('');
    const stat = (n, label) => `<div class="card py-2"><p class="font-display text-xl text-kumkum-700">${n}</p><p class="text-[11px] text-ink-500">${label}</p></div>`;
    const TOUR_CHIP = { Completed: '· toured ✓', Skipped: '· tour skipped' };
    const tourChip = (t) => TOUR_CHIP[t] || '· app tour pending';
    const empty = emptyState('👥', s.members.length ? 'No matching members' : 'No members yet');
    const lockReason = (self, lastAdmin, selfText, fallback) => {
      if (self) return selfText;
      if (lastAdmin) return 'At least one admin must remain';
      return fallback;
    };
    const addedLine = (m) => (m.addedDate ? ` · ${escapeHtml(formatDateTime(m.addedDate))}` : '');
    const listHtml = `
      <ul class="card divide-y divide-haldi-100">
        ${list.map((m) => {
          const self = m.email === me;
          const busy = Store.isPending(`member:${m.email}`);
          const groupsBusy = Store.isPending(`member-groups:${m.email}`);
          const lastAdmin = m.role === 'Admin' && adminCount <= 1;
          return `
          <li class="flex items-center gap-3 p-3">
            <div class="w-9 h-9 shrink-0 rounded-full ${m.role === 'Admin' ? 'bg-kumkum-100 text-kumkum-700' : 'bg-haldi-100 text-haldi-800'} grid place-items-center font-bold">${escapeHtml(m.email[0]?.toUpperCase() || '?')}</div>
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium text-ink-900 truncate">${escapeHtml(m.email)} ${self ? '<span class="ml-1 rounded-full bg-kumkum-600 text-ivory-50 text-[10px] px-2 py-0.5">You</span>' : ''}</p>
              <p class="text-xs text-ink-400 truncate">· Added by ${escapeHtml(m.addedBy || '—')}</p>
              <p class="text-xs text-ink-400 truncate">${addedLine(m)}</p>
              <p class="text-xs text-ink-400 truncate"> ${tourChip(m.tourStatus)}</p>
              <label class="block mt-2 text-[11px] text-ink-500">Groups
                ${groupPicker(s.groupCatalog, s.memberGroupsDrafts[m.email] ?? (m.groups || []), 'member-groups', { email: m.email }, groupsBusy)}
              </label>
              <button data-action="save-member-groups" data-email="${escapeHtml(m.email)}" ${groupsBusy ? 'disabled' : ''} ${pendingAttrs(`member-groups:${m.email}`)} class="btn btn-ghost btn-sm mt-1 min-h-[40px]">${spinnerOr(`member-groups:${m.email}`, 'Save groups')}</button>
              <select data-action="set-role" data-email="${escapeHtml(m.email)}" aria-label="Role for ${escapeHtml(m.email)}" ${self || busy || lastAdmin ? 'disabled' : ''}
                title="${lockReason(self, lastAdmin, 'You cannot change your own role', 'Change role')}"
                class="shrink-0 rounded-lg border border-haldi-300 bg-ivory-50 text-xs px-2 py-1.5 disabled:opacity-50">${roleOptions(m.role)}</select>
              ${busy ? '<span role="status" aria-label="Updating member"><span class="spinner" aria-hidden="true"></span><span class="sr-only">Updating member</span></span>' : ''}
              <button data-action="remove-member" data-email="${escapeHtml(m.email)}" ${self || busy || lastAdmin ? 'disabled' : ''} ${pendingAttrs(`member:${m.email}`)}
                title="${lockReason(self, lastAdmin, 'You cannot remove yourself', 'Remove member')}" aria-label="Remove ${escapeHtml(m.email)}"
                class="btn btn-danger btn-sm shrink-0">
                ${busy ? '<span class="spinner" aria-hidden="true"></span><span class="sr-only">Working: Remove member</span>' : 'Remove'}
              </button>
            </div>
          </li>`;
        }).join('')}
      </ul>`;

    return `
      ${pageHeader('Guest list', 'Members &amp; access', 'Only people on this list can open the app. <b>Admins</b> host the event; <b>Atithis</b> (our guests) follow the schedule. Every change is recorded in the AuditLog.', 'members-overview')}
      <div class="grid grid-cols-3 gap-2 text-center mb-4">${stat(s.members.length, 'Members')}${stat(adminCount, 'Admins')}${stat(s.members.length - adminCount, 'Atithis')}</div>
      <section class="card p-4 mb-4">
        <h3 class="font-display text-xl text-kumkum-700">Group labels</h3>
        <p class="mt-1 text-xs text-ink-500">Create labels for member access and ceremony audiences. Archiving keeps current assignments but prevents new ones.</p>
        <form data-action="add-group" class="mt-3 flex gap-2" novalidate>
          <input name="label" maxlength="30" required placeholder="e.g. Family" aria-label="New group label" class="input min-w-0" />
          <button type="submit" ${Store.isPending('group:add') ? 'disabled' : ''} ${pendingAttrs('group:add')} class="btn btn-primary shrink-0">${spinnerOr('group:add', 'Add')}</button>
        </form>
        ${s.groupCatalog.length ? `<ul class="mt-3 divide-y divide-haldi-100">
          ${s.groupCatalog.map((group) => `<li class="flex min-h-[48px] items-center justify-between gap-2 py-2">
            <span class="text-sm text-ink-800">${escapeHtml(group.label)} ${group.status === 'Archived' ? '<span class="text-xs text-ink-500">(archived)</span>' : ''}</span>
            ${group.status === 'Active' ? `<button type="button" data-action="archive-group" data-label="${escapeHtml(group.label)}" ${Store.isPending(`group:${group.label}`) ? 'disabled' : ''} ${pendingAttrs(`group:${group.label}`)} class="btn btn-ghost btn-sm min-h-[44px]">${spinnerOr(`group:${group.label}`, 'Archive')}</button>` : ''}
          </li>`).join('')}
        </ul>` : emptyState('🏷️', 'No group labels yet', 'Add a label to make it available in member and ceremony forms.')}
      </section>
      <form data-action="add-member" class="card p-4 mb-4 space-y-2" novalidate>
        <label class="block text-xs font-semibold text-ink-500" for="new-member-email">Invite a guest</label>
        <input id="new-member-email" name="email" type="email" inputmode="email" autocomplete="off" required placeholder="guest@gmail.com" class="input" />
        <div class="flex gap-2">
          <select name="role" aria-label="Role" class="input flex-1">${roleOptions(GUEST_ROLE)}</select>
          <button type="submit" ${Store.isPending('member:add') ? 'disabled' : ''} ${pendingAttrs('member:add')} class="btn btn-primary shrink-0 px-6">
            ${spinnerOr('member:add', 'Add')}
          </button>
        </div>
        <fieldset><legend class="block text-xs font-semibold text-ink-500">Groups (optional)</legend>
          ${groupPicker(s.groupCatalog, [], 'add-member-groups')}
        </fieldset>
      </form>
      <input type="search" data-action="member-search" value="${escapeHtml(s.memberSearch)}" placeholder="Search members…" aria-label="Search members" class="input mb-3" />
      ${list.length ? listHtml : empty}`;
  };

  Views.notifications = (s) => {
    const items = s.notifications || [];
    return `
      ${pageHeader('Announcements from the hosts', 'Notifications', '', 'notifications-overview')}
      <section class="card p-4 mb-3">
        <p class="text-sm text-ink-600">Event updates and host announcements appear here.</p>
        <button data-action="clear-notifications" ${!items.length || Store.isPending('notifications:clear') ? 'disabled' : ''} ${pendingAttrs('notifications:clear')} class="btn btn-ghost btn-sm mt-3 min-h-[44px]">
          ${spinnerOr('notifications:clear', 'Clear notifications')}
        </button>
      </section>
      ${items.length ? `<div class="space-y-3">${items.map((n) => `
        <article class="card p-4">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <h3 class="font-semibold text-kumkum-800">${escapeHtml(n.title)}</h3>
              <p class="mt-1 text-sm text-ink-700">${escapeHtml(n.message)}</p>
              <p class="mt-2 text-xs text-ink-400">${escapeHtml(formatDateTime(n.at))}${n.groups?.length ? ` · ${escapeHtml(n.groups.join(', '))}` : ' · Everyone'}</p>
              ${s.isAdmin ? `<p class="mt-1 text-[11px] text-ink-500">By ${escapeHtml(n.sentBy || '—')} · ${escapeHtml(n.pushStatus && n.pushStatus.startsWith('Failed')  ? 'Failed' : (n.pushStatus || 'Not sent'))}</p>` : ''}
            </div>
            <span class="text-2xl" aria-hidden="true">🔔</span>
          </div>
        </article>`).join('')}</div>` : emptyState('🔔', 'No announcements yet', 'When a host shares an event update, it will appear here.')}`;
  };

  /* --------------------------------------------------------------- Render */
  const ADMIN_TABS = new Set(['control', 'pickups', 'members', 'broadcast']);
  const GUEST_TABS = new Set(['travel']); // admins see everyone's travel under Pick & Drop
  let lastGateKey = null;

  function syncLabel(s, signedIn) {
    const tagline = CONFIG.EVENT_TAGLINE || '';
    if (!signedIn) return tagline;
    if (s.authStatus === 'offline') return `Offline · last synced ${timeAgo(s.lastSynced)}`;
    if (s.loading) return 'Syncing…';
    if (s.error) return s.lastSynced ? `Last synced ${timeAgo(s.lastSynced)}` : 'Not synced';
    return s.lastSynced ? `${tagline} · updated ${timeAgo(s.lastSynced)}` : tagline;
  }

  /** Glide the title only when the full name does not fit the header. */
  function fitTitle() {
    const box = $('#app-title');
    const text = $('#app-title-text');
    const overflow = Math.ceil(text.scrollWidth - box.clientWidth);
    box.classList.toggle('is-scrolling', overflow > 4);
    text.style.setProperty('--marquee-shift', `${-Math.max(overflow, 0)}px`);
    box.title = text.textContent;
  }

  function renderHeader(s, signedIn) {
    const name = CONFIG.EVENT_NAME || 'Event Companion';
    const title = $('#app-title-text');
    if (title.textContent !== name) { title.textContent = name; document.title = name; requestAnimationFrame(fitTitle); }
    $('#sync-indicator').textContent = syncLabel(s, signedIn);
    const blessing = $('#app-blessing');
    if (blessing) {
      blessing.textContent = signedIn ? (CONFIG.EVENT_BLESSING || '') : '';
      blessing.classList.toggle('hidden', !blessing.textContent);
    }
    const refreshBtn = $('#refresh-btn');
    refreshBtn.classList.toggle('hidden', !signedIn);
    refreshBtn.setAttribute('aria-busy', String(!!s.loading));
    refreshBtn.querySelector('svg')?.classList.toggle('animate-spin', !!s.loading);
    const accountBtn = $('#account-btn');
    accountBtn.classList.toggle('hidden', !signedIn);
    accountBtn.classList.toggle('flex', signedIn);

    if (s.user) {
      const picture = safePicture(s.user.picture);
      $('#account-avatar').innerHTML = picture
        ? `<img src="${escapeHtml(picture)}" alt="" referrerpolicy="no-referrer" class="w-7 h-7 rounded-full ring-2 ring-haldi-300" />`
        : escapeHtml(String(s.user.name || s.user.email || '?')[0].toUpperCase());
      $('#account-label').textContent = s.role || 'Member';
    }

    $('#banner-offline').classList.toggle('hidden', s.online);
    Push.render();
  }

  function renderNav(s, signedIn) {
    if ((!s.isAdmin && ADMIN_TABS.has(s.tab)) || (s.isAdmin && GUEST_TABS.has(s.tab))) s.tab = 'schedule';
    $('#nav-grid').className = `max-w-2xl mx-auto grid ${s.isAdmin ? 'grid-cols-6' : 'grid-cols-3'}`;
    $('#bottom-nav').classList.toggle('hidden', !signedIn);
    $$('.nav-btn').forEach((btn) => {
      const shown = btn.classList.contains('admin-only') ? s.isAdmin : !btn.classList.contains('guest-only') || !s.isAdmin;
      btn.classList.toggle('hidden', !shown);
      btn.classList.toggle('flex', shown);
      const active = btn.dataset.tab === s.tab;
      btn.classList.toggle('text-kumkum-700', active);
      btn.classList.toggle('text-ink-500', !active);
      const pill = btn.querySelector('.nav-pill');
      if (pill) { pill.classList.toggle('bg-kumkum-100', active); pill.classList.toggle('bg-transparent', !active); }
      btn.setAttribute('aria-current', active ? 'page' : 'false');
    });
  }

  /** Login gate: re-render only when its state changes so the Google button isn't torn down. */
  function renderGate(s) {
    const key = `${s.authStatus}|${s.deniedEmail}|${s.gsiReady}|${s.online}`;
    if (key === lastGateKey) return;
    lastGateKey = key;
    $('#view').innerHTML = Views.gate(s);
    if (s.authStatus !== 'checking') Auth.renderButton($('#gsi-gate'));
  }

  /** Renders the active tab, preserving focus/caret and draft input across re-renders. */
  function renderView(s) {
    const active = document.activeElement;
    const focusKey = active?.dataset?.action;
    const caret = focusKey && typeof active.selectionStart === 'number' ? active.selectionStart : null;
    const before = memberFormFields();
    const draft = before ? { email: before.email.value, role: before.role.value, groups: checkedGroups(before.form), focused: active === before.email } : null;
    const groupInput = $('form[data-action="add-group"] input[name="label"]');
    const groupDraft = groupInput ? { value: groupInput.value, focused: active === groupInput } : null;

    $('#view').innerHTML = (Views[s.tab] || Views.schedule)(s);
    applyProgressWidths();

    const after = memberFormFields();
    if (after && draft) {
      after.email.value = draft.email;
      after.role.value = draft.role;
      const selectedGroups = new Set(draft.groups);
      after.form.querySelectorAll('input[name="groups"]').forEach((checkbox) => { checkbox.checked = selectedGroups.has(checkbox.value); });
      if (draft.focused) after.email.focus();
    }
    const nextGroupInput = $('form[data-action="add-group"] input[name="label"]');
    if (nextGroupInput && groupDraft) {
      nextGroupInput.value = groupDraft.value;
      if (groupDraft.focused) nextGroupInput.focus();
    }
    if (['pickup-search', 'member-search'].includes(focusKey)) {
      const el = $(`[data-action="${focusKey}"]`);
      if (el) { el.focus(); if (caret !== null) el.setSelectionRange(caret, caret); }
    }
  }

  /** @returns {MemberFormFields | null} the inputs of the "Add member" form, if it is on screen. */
  function memberFormFields(form = $('form[data-action="add-member"]')) {
    if (!form) return null;
    return {
      form,
      email: /** @type {HTMLInputElement} */ (form.querySelector('[name="email"]')),
      role: /** @type {HTMLSelectElement} */ (form.querySelector('[name="role"]')),
    };
  }

  /** Progress bars carry their width in data-progress; set via CSSOM so the CSP needs no inline styles. */
  function applyProgressWidths() {
    $$('[data-progress]').forEach((el) => { el.style.width = `${Number(el.dataset.progress) || 0}%`; });
  }

  function render(s) {
    const signedIn = ['authed', 'offline'].includes(s.authStatus);
    renderHeader(s, signedIn);
    renderNav(s, signedIn);
    if (!signedIn) { renderGate(s); return; }
    lastGateKey = null;
    renderView(s);
  }

  /* ----------------------------------------------------------------- Data */
  const Data = {
    timer: null,

    refresh({ quiet = false } = {}) {
      if (Store.state.authStatus === 'offline' && navigator.onLine) {
        Auth.clearOfflineExpiry();
        const saved = sessionStore.get(STORAGE.CREDENTIAL);
        if (!saved || Auth.isExpired(saved)) { Store.set({ authStatus: 'signed-out', user: null }); Auth.prompt(); return null; }
        Store.set({ authStatus: 'authed', user: saved });
      }
      if (Store.state.authStatus !== 'authed') return null;
      return Auth.loadSession(false, { showLoading: !quiet });
    },

    /** Self-rescheduling poll with ±20% jitter so many open phones don't hit Apps Script in lock-step. */
    startPolling() {
      clearTimeout(this.timer);
      const base = Math.max(Number(CONFIG.REFRESH_INTERVAL_MS) || 60000, 15000);
      const tick = () => {
        this.timer = setTimeout(() => {
          if (document.visibilityState === 'visible' && navigator.onLine) void this.refresh({ quiet: true });
          tick();
        }, base * (0.8 + Math.random() * 0.4));
      };
      tick();
    },
  };

  /* -------------------------------------------------------------- Actions */
  const field = (label, control) => `<label class="block"><span class="block text-xs font-semibold text-ink-500 mb-1">${label}</span>${control}</label>`;

  /** Trimmed string values of every named control in a form. */
  const formValues = (form) => Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, String(v).trim()]));

  /** "19:05" (from <input type="time">) → "7:05 PM", matching how the sheet shows times. */
  const to12h = (hhmm) => {
    const m = /^(\d{2}):(\d{2})$/.exec(hhmm || '');
    if (!m) return '';
    const h = Number(m[1]);
    return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
  };

  /** "2027-01-23" (from <input type="date">) → "Sat, Jan 23", the same format the backend gives sheet dates. */
  const toDayLabel = (ymd) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
    if (!m) return '';
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
      .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };

  /** Opens the native picker on tap/click too (not only the small calendar icon), where supported. */
  const openPickerOnTap = (input) => {
    const show = () => { try { input.showPicker?.(); } catch { /* not allowed without a gesture / unsupported */ } };
    input.addEventListener('click', show);
  };

  const TRAVEL_MODE_OPTIONS = ['Plane', 'Train', 'Own Vehicle', 'Other Vehicle'];

  const findEvent = (id) => Store.state.itinerary.find((e) => e.id === id);

  /** "2027-01-22T14:30:00+05:30" → "2027-01-22T14:30" for <input type="datetime-local"> (sheet's wall time). */
  const toLocalInput = (v) => /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/.exec(String(v || ''))?.[1] || '';

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

    async deleteEvent(eventId) {
      const ev = findEvent(eventId);
      if (!ev) return;
      const later = Store.state.itinerary.filter((e) => /^\d+$/.test(e.id) && /^\d+$/.test(ev.id) && Number(e.id) > Number(ev.id)).length;
      const warn = [
        `Delete “${ev.title}” (#${ev.id})? This removes it from the schedule for everyone.`,
        ev.status === 'Live' ? '\nIt is LIVE right now.' : '',
        later ? `\nThe ${later} ceremon${later === 1 ? 'y' : 'ies'} after it will be renumbered.` : '',
      ].join('');
      if (!window.confirm(warn)) return;
      const data = await this.run(`event:${eventId}`, () => Api.post('deleteEvent', { eventId, title: ev.title }), `“${ev.title}” deleted`);
      if (data) Store.set({ itinerary: data.itinerary });
    },

    async updateEvent(eventId, status, notify) {
      const data = await this.run(`event:${eventId}`, () => Api.post('updateEvent', { eventId, status, notify }));
      if (!data) return;
      Store.set({ itinerary: data.itinerary });
      Nudges.remember();
      if (Store.state.user?.email) persistOfflineSchedule(Store.state.user.email, Store.state.role, data.itinerary);
      if (status === 'Live') Festive.petals();
      if (data.push?.attempted) {
        Toast.show(data.push.ok ? `"${data.event.title}" is Live — push sent 🔔` : `Status updated, but push failed: ${data.push.error}`, data.push.ok ? 'success' : 'error', 5500);
      } else {
        Toast.show(`"${data.event.title}" set to ${status}`, 'success');
      }
    },

    async sendBroadcast(shareToWhatsApp) {
      const draft = Store.state.broadcastDraft;
      const title = String(draft.title || '').trim();
      const body = String(draft.body || '').trim();
      const groups = Array.isArray(draft.groups) ? [...draft.groups] : [];
      if (!title || !body) {
        Toast.show('Enter a title and message before broadcasting.', 'error');
        return;
      }

      const popup = shareToWhatsApp ? window.open('about:blank', '_blank') : null;
      if (popup) popup.opener = null;
      const data = await this.run('broadcast:send', () => Api.post('broadcastNotification', { title, body, groups }));
      if (!data) {
        popup?.close();
        return;
      }

      Store.set({
        notifications: data.notifications,
        broadcastDraft: { title: '', body: '', groups: [] },
      });
      const push = data.push;
      let status = push.ok
        ? 'Broadcast sent.'
        : `Broadcast recorded, but push failed: ${push.error || 'delivery status unavailable.'}`;
      if (shareToWhatsApp) {
        if (popup && !popup.closed) popup.location.href = WhatsApp.buildUrl(`*${title}*\n\n${body}`);
        else status += ' The browser blocked the WhatsApp window.';
      }
      Toast.show(status, push.ok ? 'success' : 'error', 6000);
    },

    async updateEventGroups(eventId) {
      const ev = findEvent(eventId);
      if (!ev) return;
      const groups = Store.state.eventGroupsDrafts[eventId] ?? (ev.groups || []);
      const data = await this.run(`event-groups:${eventId}`, () => Api.post('updateEventGroup', { eventId, title: ev.title, groups }));
      if (data) {
        const drafts = { ...Store.state.eventGroupsDrafts };
        delete drafts[eventId];
        Store.set({ itinerary: data.itinerary, eventGroupsDrafts: drafts });
        if (Store.state.user?.email) persistOfflineSchedule(Store.state.user.email, Store.state.role, data.itinerary);
        Toast.show('Event audience updated.', 'success');
      }
    },

    async updateMemberGroups(email) {
      const member = Store.state.members.find((m) => m.email === email);
      if (!member) return;
      const groups = Store.state.memberGroupsDrafts[email] ?? (member.groups || []);
      const data = await this.run(`member-groups:${email}`, () => Api.post('updateMemberGroups', { email, groups }));
      if (data) {
        const drafts = { ...Store.state.memberGroupsDrafts };
        delete drafts[email];
        Store.set({ members: data.members, memberGroupsDrafts: drafts });
        Toast.show(`Groups updated for ${email}.`, 'success');
      }
    },

    async clearNotifications() {
      const data = await this.run('notifications:clear', () => Api.post('clearNotifications'), 'Notifications cleared on this account.');
      if (data) {
        const notices = Array.isArray(data.notifications) ? data.notifications : [];
        const visible = Store.state.isAdmin
          ? notices
          : notices.filter((notice) => matchesAudience(notice.groups, Store.state.groups))
            .map(guestNotice);
        Store.set({ notifications: visible });
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

    async updateDropoff(id, status) {
      const data = await this.run(`drop:${id}`, () => Api.post('updateDropoff', { id, status }));
      if (data) {
        Store.set({ logistics: data.logistics });
        const guest = data.logistics.find((g) => g.id === id);
        Toast.show(`${guest?.name || 'Guest'} drop marked as ${status}`, 'success');
      }
    },

    async addMember(form) {
      const { email: input, role: roleSelect } = memberFormFields(form);
      const submittedEmail = input.value;
      const email = submittedEmail.trim().toLowerCase();
      const role = roleSelect.value;
      const groups = checkedGroups(form);
      if (email.length > 254 || !EMAIL_RE.test(email)) { Toast.show('Enter a valid email address.', 'error'); input.focus(); return; }
      if (!ROLES.includes(role)) { Toast.show('Choose a valid role.', 'error'); return; }
      if (Store.state.members.some((m) => m.email === email)) { Toast.show(`${email} is already a member.`, 'info'); return; }
      const data = await this.run('member:add', () => Api.post('addMember', { email, role, groups }), `${email} added as ${role}`);
      if (data) {
        const currentForm = $('form[data-action="add-member"]');
        if (currentForm) {
          const currentFields = memberFormFields(currentForm);
          const currentGroups = checkedGroups(currentForm);
          const submittedDraftUnchanged = currentFields.email.value === submittedEmail &&
            currentGroups.length === groups.length &&
            currentGroups.every((group, index) => group === groups[index]);
          if (submittedDraftUnchanged) {
            currentFields.email.value = '';
            currentForm.querySelectorAll('input[name="groups"]').forEach((checkbox) => { checkbox.checked = false; });
          }
        }
        Store.set({ members: data.members });
      }
    },

    async addGroup(form) {
      const input = form.querySelector('input[name="label"]');
      const submittedLabel = input.value;
      const label = submittedLabel.trim();
      if (!label) { Toast.show('Enter a group label.', 'error'); input.focus(); return; }
      const data = await this.run('group:add', () => Api.post('addGroup', { label }), `Group "${label}" added`);
      if (data) {
        const currentInput = $('form[data-action="add-group"] input[name="label"]');
        if (currentInput?.value === submittedLabel) currentInput.value = '';
        Store.set({ groupCatalog: data.groupCatalog });
      }
    },

    async archiveGroup(label) {
      if (!window.confirm(`Archive "${label}"? Existing assignments stay in place, but it cannot be assigned again.`)) return;
      const data = await this.run(`group:${label}`, () => Api.post('archiveGroup', { label }), `Group "${label}" archived`);
      if (data) Store.set({ groupCatalog: data.groupCatalog });
    },

    async setRole(email, role) {
      if (email === Store.state.user?.email) { Toast.show('You cannot change your own role.', 'error'); return; }
      if (!window.confirm(`Change ${email} to ${role}?`)) return;
      const data = await this.run(`member:${email}`, () => Api.post('updateMemberRole', { email, role }), `${email} is now ${role === 'Admin' ? 'an Admin' : 'an Atithi'}`);
      if (data) Store.set({ members: data.members });
    },

    async removeMember(email) {
      if (email === Store.state.user?.email) { Toast.show('You cannot remove yourself.', 'error'); return; }
      if (!window.confirm(`Remove ${email}? They will lose access to the app.`)) return;
      const data = await this.run(`member:${email}`, () => Api.post('removeMember', { email }), `${email} removed`);
      if (data) Store.set({ members: data.members });
    },

    /** Opens a create form in the modal (outside #view, so background refreshes never wipe a draft). */
    openCreateForm({ eyebrow, title, fields, submitLabel, key, collect, submit, mount }) {
      Modal.open(`
        <p class="eyebrow">${eyebrow}</p>
        <h3 class="font-display text-2xl text-kumkum-700">${title}</h3>
        <form data-modal="form" class="mt-3 space-y-3" novalidate>
          ${fields}
          <div class="grid grid-cols-2 gap-2 pt-1">
            <button type="button" data-modal="cancel" class="btn btn-ghost">Cancel</button>
            <button type="submit" data-modal="confirm" class="btn btn-primary">${submitLabel}</button>
          </div>
        </form>`, {
        onMount: (root) => {
          const form = root.querySelector('form');
          const confirm = root.querySelector('[data-modal="confirm"]');
          root.querySelector('[data-modal="cancel"]').addEventListener('click', () => Modal.close());
          form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const payload = collect(form);
            if (!payload) return;
            confirm.disabled = true;
            confirm.setAttribute('aria-busy', 'true');
            confirm.innerHTML = `<span class="spinner" aria-hidden="true"></span><span class="sr-only">Working: ${escapeHtml(submitLabel)}</span>`;
            const ok = await submit(payload, key);
            if (ok) { Modal.close(); return; }
            confirm.disabled = false;
            confirm.removeAttribute('aria-busy');
            confirm.textContent = submitLabel;
          });
          mount?.(form);
          setTimeout(() => form.querySelector('input')?.focus(), 0); // Modal.open focuses the first button after onMount
        },
      });
    },

    openAddEvent() {
      this.openCreateForm({
        eyebrow: 'Event Control',
        title: 'Add a ceremony',
        submitLabel: 'Add ceremony',
        key: 'event:add',
        fields: `
          ${field('Title', '<input name="title" required maxlength="200" placeholder="Haldi" class="input" />')}
          <div class="grid grid-cols-2 gap-2">
            ${field('Day', '<input name="day" type="date" required class="input" />')}
            ${field('Time', '<input name="time" type="time" class="input" />')}
          </div>
          ${field('Location name (shown to guests)', '<input name="location" maxlength="200" placeholder="Lawn, Hotel Leela" class="input" />')}
          ${field('Audience groups (optional; no selection means everyone)', groupPicker(Store.state.groupCatalog, [], 'add-event-groups'))}
          <div>
            ${field('Google Maps link (optional)', '<input name="mapLink" type="url" inputmode="url" maxlength="500" placeholder="https://maps.app.goo.gl/…" class="input" />')}
            <div class="mt-1.5 flex flex-wrap gap-2">
              <button type="button" data-form="use-location" class="btn btn-ghost btn-sm min-h-[44px]">📍 Use my current location</button>
              <button type="button" data-form="find-on-maps" class="btn btn-ghost btn-sm min-h-[44px]">🔎 Find on Google Maps</button>
            </div>
            <p class="mt-1 text-[11px] text-ink-500">Tapping the ceremony takes guests to this pin. In Google Maps, tap <b>Share → Copy link</b> and paste it here. Leave blank to search by the location name.</p>
          </div>
          <p class="text-xs text-ink-500">New ceremonies start as <b>Upcoming</b>. Use <b>Set Live &amp; Broadcast</b> when it begins.</p>`,
        mount: (form) => {
          openPickerOnTap(form.elements.day);
          openPickerOnTap(form.elements.time);
          const link = form.elements.mapLink;
          form.querySelector('[data-form="find-on-maps"]').addEventListener('click', () => {
            const name = form.elements.location.value.trim();
            window.open(name ? mapsSearch(name) : 'https://www.google.com/maps', '_blank', 'noopener,noreferrer');
          });
          const here = form.querySelector('[data-form="use-location"]');
          here.addEventListener('click', () => {
            if (!navigator.geolocation) { Toast.show('Location isn’t available on this device.', 'error'); return; }
            here.disabled = true;
            navigator.geolocation.getCurrentPosition((pos) => {
              const { latitude, longitude } = pos.coords;
              link.value = mapsSearch(`${latitude.toFixed(6)},${longitude.toFixed(6)}`);
              here.disabled = false;
              Toast.show('Pinned your current location 📍', 'success');
            }, () => {
              here.disabled = false;
              Toast.show('Couldn’t get your location. Allow location access, or paste a Maps link.', 'error');
            }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
          });
        },
        collect: (form) => {
          const v = formValues(form);
          const day = toDayLabel(v.day);
          if (!v.title || !day) { Toast.show('Please add a title and pick a day.', 'error'); return null; }
          if (v.mapLink && !isMapsUrl(v.mapLink)) { Toast.show('Paste a Google Maps link (https://maps.app.goo.gl/… or https://www.google.com/maps/…), or leave it blank.', 'error'); return null; }
          return { title: v.title, day, time: to12h(v.time), location: v.location, mapLink: v.mapLink, groups: checkedGroups(form) };
        },
        submit: async (payload, key) => {
          const data = await this.run(key, () => Api.post('addEvent', payload), `“${payload.title}” added 🪔`);
          if (data) Store.set({ itinerary: data.itinerary });
          return !!data;
        },
      });
    },

    /** One form for adding a family's travel and for editing it later (`guest` set → edit mode). */
    openTravelForm(guest = null) {
      const editing = !!guest;
      const g = guest || {};
      const attr = (v) => escapeHtml(String(v ?? ''));
      // The sheet may hold free text ("22 Jan, evening") that <input type="datetime-local"> cannot show.
      const unparsed = (v) => !!v && !toLocalInput(v);
      const keepNote = (v) => (unparsed(v) ? `<span class="block text-[11px] text-ink-500 mt-1">Currently “${attr(v)}” — leave blank to keep it.</span>` : '');
      const guests = Store.state.members.filter((m) => m.role !== 'Admin').map((m) => m.email);
      this.openCreateForm({
        eyebrow: 'Pick &amp; Drop',
        title: editing ? `Edit ${attr(g.name)}` : 'Add a guest’s travel',
        submitLabel: editing ? 'Save changes' : 'Add travel',
        key: editing ? `travel:${g.id}` : 'pickup:add',
        fields: `
          ${field('Family / guest name', `<input name="name" required maxlength="200" placeholder="Sharma family" value="${attr(g.name)}" class="input" />`)}
          <div class="grid grid-cols-2 gap-2">
            ${field('Guests', `<input name="members" type="number" inputmode="numeric" min="1" max="500" placeholder="4" value="${attr(g.members)}" class="input" />`)}
            ${field('Contact', `<input name="contact" type="tel" inputmode="tel" maxlength="30" placeholder="+91 98765 43210" value="${attr(g.contact)}" class="input" />`)}
          </div>
          ${field('Guest’s Google email (so they see it in “My travel”)', `<input name="email" type="email" inputmode="email" maxlength="254" list="travel-guests" placeholder="guest@gmail.com" value="${attr(g.email)}" class="input" />
            <datalist id="travel-guests">${guests.map((e) => `<option value="${attr(e)}"></option>`).join('')}</datalist>`)}
          ${field('Arrival (pick-up)', `<input name="arrival" type="datetime-local" value="${attr(toLocalInput(g.arrival))}" class="input" />${keepNote(g.arrival)}`)}
          ${field('Departure (drop)', `<input name="departure" type="datetime-local" value="${attr(toLocalInput(g.departure))}" class="input" />${keepNote(g.departure)}`)}
          <div class="grid grid-cols-2 gap-2">
            ${field('Mode', `<select name="mode" class="input">
              <option value="">Select…</option>
              ${(g.mode && !TRAVEL_MODE_OPTIONS.includes(g.mode) ? [g.mode, ...TRAVEL_MODE_OPTIONS] : TRAVEL_MODE_OPTIONS)
                .map((m) => `<option value="${attr(m)}" ${m === g.mode ? 'selected' : ''}>${attr(m)}</option>`).join('')}
            </select>`)}
            ${editing ? '' : field('Pick-up status', '<select name="pickupStatus" class="input"><option>Pending</option><option>Picked Up</option></select>')}
          </div>`,
        mount: (form) => ['arrival', 'departure'].forEach((n) => openPickerOnTap(form.elements[n])),
        collect: (form) => {
          const v = formValues(form);
          if (!v.name) { Toast.show('Please add a name.', 'error'); return null; }
          v.email = v.email.toLowerCase();
          if (v.email && (v.email.length > 254 || !EMAIL_RE.test(v.email))) { Toast.show('Enter a valid email address, or leave it blank.', 'error'); return null; }
          if (v.arrival && v.departure && v.departure < v.arrival) { Toast.show('Departure must be after arrival.', 'error'); return null; }
          if (!editing) return v;
          // Leave untouched free-text times alone instead of wiping them.
          ['arrival', 'departure'].forEach((k) => { if (!v[k] && unparsed(g[k])) delete v[k]; });
          return { ...v, id: g.id };
        },
        submit: async (payload, key) => {
          const data = editing
            ? await this.run(key, () => Api.post('updateLogistics', payload), (r) => (r.changed?.length ? `${payload.name} updated ✎` : 'Nothing to change'))
            : await this.run(key, () => Api.post('addPickup', payload), `${payload.name} added 🚐`);
          if (data) Store.set({ logistics: data.logistics });
          return !!data;
        },
      });
    },

    openEditTravel(id) {
      const guest = Store.state.logistics.find((g) => g.id === id);
      if (guest) this.openTravelForm(guest);
    },

    openBroadcast(eventId) {
      const ev = findEvent(eventId);
      if (!ev) return;
      Modal.open(`
        <p class="eyebrow">Broadcast</p>
        <h3 class="font-display text-2xl text-kumkum-700">Set Live &amp; announce</h3>
        <p class="text-sm text-ink-600 mt-1">This will mark <b>${escapeHtml(ev.title)}</b> as Live and send a push to <b>${escapeHtml((ev.groups || []).join(', ') || 'everyone')}</b>. It also opens WhatsApp so you can forward the message to groups or chats.</p>
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
            void this.updateEvent(ev.id, 'Live', true);
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
        <p class="mt-4 text-sm text-ink-700">${s.isAdmin ? 'You are a <b>host (Admin)</b> — you can run the schedule, pick-ups &amp; drops and the guest list.' : 'You are our honoured <b>guest</b> — follow the schedule, live updates and your travel right here.'}</p>
        <button data-modal="tour" class="btn btn-ghost w-full mt-4">🪔 Replay the welcome tour</button>
        ${isStandalone() ? '' : '<button data-modal="install" class="btn btn-ghost w-full mt-2">📲 Install this app</button>'}
        ${s.isAdmin ? '<button data-modal="install-link" class="btn btn-ghost w-full mt-2">🔗 Copy the install link for guests</button>' : ''}
        <div class="grid grid-cols-2 gap-2 mt-2">
          <button data-modal="cancel" class="btn btn-ghost">Close</button>
          <button data-modal="signout" class="btn btn-danger">Sign out</button>
        </div>`, {
        onMount: (root) => {
          root.querySelector('[data-modal="cancel"]').addEventListener('click', () => Modal.close());
          root.querySelector('[data-modal="tour"]').addEventListener('click', () => { Modal.close(); setTimeout(() => Tour.start({ replay: true }), 50); });
          root.querySelector('[data-modal="signout"]').addEventListener('click', () => Auth.signOut());
          root.querySelector('[data-modal="install"]')?.addEventListener('click', () => { Modal.close(); void Install.start(); });
          root.querySelector('[data-modal="install-link"]')?.addEventListener('click', () => { void this.copyInstallLink(); });
        },
      });
    },

    async copyInstallLink() {
      const link = Install.link();
      try {
        await navigator.clipboard.writeText(link);
        Toast.show('Install link copied — share it on WhatsApp 📲', 'success');
      } catch {
        window.prompt('Copy this install link:', link);
      }
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
      if (!el) return;
      if (el.disabled) return;
      const { action, id } = el.dataset;
      switch (action) {
        case 'refresh': void Data.refresh(); break;
        case 'open-broadcast': Actions.openBroadcast(id); break;
        case 'broadcast-send': void Actions.sendBroadcast(false); break;
        case 'broadcast-whatsapp': void Actions.sendBroadcast(true); break;
        case 'add-event': Actions.openAddEvent(); break;
        case 'delete-event': void Actions.deleteEvent(id); break;
        case 'save-event-groups': void Actions.updateEventGroups(id); break;
        case 'save-member-groups': void Actions.updateMemberGroups(el.dataset.email); break;
        case 'archive-group': void Actions.archiveGroup(el.dataset.label); break;
        case 'clear-notifications': void Actions.clearNotifications(); break;
        case 'add-pickup': Actions.openTravelForm(); break;
        case 'edit-pickup': Actions.openEditTravel(id); break;
        case 'logistics-mode': Store.set({ logisticsMode: el.dataset.value === 'drop' ? 'drop' : 'pickup', pickupFilter: 'all' }); break;
        case 'share-whatsapp': {
          const ev = findEvent(id);
          if (ev) WhatsApp.open(WhatsApp.buildMessage(ev));
          break;
        }
        case 'toggle-pickup': void Actions.updatePickup(id, el.dataset.next); break;
        case 'toggle-dropoff': void Actions.updateDropoff(id, el.dataset.next); break;
        case 'remove-member': void Actions.removeMember(el.dataset.email); break;
        case 'pickup-filter': Store.set({ pickupFilter: el.dataset.value }); break;
        case 'jump-day': $(`#day-${Number(el.dataset.day)}`)?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' }); break;
        default: break;
      }
    });

    view.addEventListener('change', (e) => {
      const groupCheckbox = e.target.closest('input[type="checkbox"][data-action]');
      if (groupCheckbox?.dataset.action === 'event-groups') {
        Store.state.eventGroupsDrafts[groupCheckbox.dataset.id] = checkedGroups(groupCheckbox.closest('fieldset'));
        return;
      }
      if (groupCheckbox?.dataset.action === 'member-groups') {
        Store.state.memberGroupsDrafts[groupCheckbox.dataset.email] = checkedGroups(groupCheckbox.closest('fieldset'));
        return;
      }
      if (groupCheckbox?.dataset.action === 'broadcast-groups') {
        Store.state.broadcastDraft.groups = checkedGroups(groupCheckbox.closest('fieldset'));
        return;
      }
      const roleSel = e.target.closest('select[data-action="set-role"]');
      if (roleSel) {
        const member = Store.state.members.find((m) => m.email === roleSel.dataset.email);
        const role = roleSel.value;
        roleSel.value = member?.role || GUEST_ROLE; // revert until the server confirms
        if (member && role !== member.role) void Actions.setRole(member.email, role);
        return;
      }
      const el = e.target.closest('select[data-action="set-status"]');
      if (!el) return;
      const ev = findEvent(el.dataset.id);
      const status = el.value;
      el.value = ev?.status || 'Upcoming'; // revert until the server confirms
      if (!ev || status === ev.status) return;
      if (status === 'Live') { Actions.openBroadcast(ev.id); return; }
      if (window.confirm(`Change "${ev.title}" to ${status}?`)) void Actions.updateEvent(ev.id, status, false);
    });

    view.addEventListener('input', (e) => {
      if (e.target.matches('[data-action="pickup-search"]')) Store.set({ pickupSearch: e.target.value });
      if (e.target.matches('[data-action="member-search"]')) Store.set({ memberSearch: e.target.value });
      if (e.target.matches('[data-action="broadcast-title"]')) Store.state.broadcastDraft.title = e.target.value;
      if (e.target.matches('[data-action="broadcast-body"]')) Store.state.broadcastDraft.body = e.target.value;
    });

    view.addEventListener('submit', (e) => {
      const form = e.target.closest('form[data-action]');
      if (!form) return;
      e.preventDefault();
      if (form.dataset.action === 'add-member') void Actions.addMember(form);
      if (form.dataset.action === 'add-group') void Actions.addGroup(form);
    });

    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !Tour.active && !Welcome.open) Modal.close(); });
    window.addEventListener('online', () => { Store.set({ online: true }); void Data.refresh({ quiet: true }); });
    window.addEventListener('offline', () => {
      Store.set({ online: false });
      if (Store.state.authStatus === 'authed' && !Auth.restoreOffline()) {
        Store.set({
          authStatus: 'offline', role: GUEST_ROLE, isAdmin: false, itinerary: [], logistics: [], members: [],
          myTravel: [], notifications: [], groups: [], knownGroups: [], groupCatalog: [], pushId: '', eventGroupsDrafts: {}, memberGroupsDrafts: {},
        });
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { void Data.refresh({ quiet: true }); Push.render(); }
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
    void Auth.init();
    Auth.scheduleRenewal();
    Data.startPolling();
    fitTitle();
    if ('ResizeObserver' in window) new ResizeObserver(fitTitle).observe($('#app-title'));
    document.fonts?.ready.then(fitTitle).catch(() => {});
    let resizeTimer;
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(fitTitle, 150); });
  }

  // Pure helpers exposed for unit tests. No state or actions, so nothing here grants privileges.
  window.EventApp = Object.freeze({ WhatsApp, escapeHtml, decodeJwt, safePicture });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
