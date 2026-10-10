/**
 * ============================================================================
 *  Event PWA — Google Apps Script backend (Code.gs)
 * ============================================================================
 *  Paste into: Google Sheet → Extensions → Apps Script → Code.gs
 *
 *  Script Properties (Project Settings → Script properties):
 *    GOOGLE_CLIENT_ID        OAuth Web client ID (must match config.js)
 *    ONESIGNAL_APP_ID        OneSignal App ID
 *    ONESIGNAL_REST_API_KEY  OneSignal REST API key (secret — never in frontend)
 *    APP_URL                 Public PWA URL, e.g. https://<user>.github.io/<repo>/
 *
 *  Deploy: Deploy → New deployment → Web app
 *    Execute as: Me   |   Who has access: Anyone
 *
 *  Security model (login is MANDATORY):
 *    - doGet  : health check only — returns no event data.
 *    - doPost : every call carries a Google ID token, verified server-side
 *               (audience/issuer/expiry via Google tokeninfo). The verified
 *               email must exist in the "Members" tab, otherwise the request is
 *               rejected with code NOT_MEMBER. Role "Admin" unlocks mutations;
 *               role "Atithi" (guest; legacy value "Viewer") is read-only.
 *               Client-sent userEmail must match.
 *    - Every mutating action runs under a script lock and is written to
 *      "AuditLog" (Timestamp, UserEmail, ActionCategory, Details).
 *
 *  Hardening (the /exec URL is public, so treat every request as hostile):
 *    - Request body capped at MAX_BODY_BYTES; ID token shape, audience and
 *      expiry are pre-checked locally before any outbound tokeninfo call.
 *    - Per-user rate limit (RATE_LIMIT_MAX requests / minute).
 *    - Action names resolved via an own-property allow-list only.
 *    - All inputs are type/length validated; emails use a strict pattern.
 *    - Every value written to a sheet is neutralised against formula/CSV
 *      injection (leading = + - @ tab CR).
 *    - Error responses never include stack traces or internal details.
 *    - Denied admin attempts by members are recorded in AuditLog (Security).
 * ============================================================================
 */

var SHEETS = {
  ITINERARY: 'Itinerary',
  LOGISTICS: 'Logistics',
  MEMBERS: 'Members',
  AUDIT: 'AuditLog',
  NOTIFICATIONS: 'Notifications', // in-app notification centre (one row per announcement sent)
  GROUPS: 'Groups', // canonical audience label registry
  LEGACY_ADMINS: 'Admins', // migrated into Members by setup()
};

var HEADERS = {
  Itinerary: ['EventID', 'Day', 'Time', 'Title', 'Location', 'Status'],
  Logistics: ['ID', 'Name', 'Members', 'Contact', 'ArrivalDateTime', 'DepartureDateTime', 'Mode', 'PickupStatus'],
  Members: ['Email', 'Role', 'AddedBy', 'AddedDate'],
  AuditLog: ['Timestamp', 'UserEmail', 'ActionCategory', 'Details'],
  Notifications: ['Timestamp', 'Title', 'Message', 'EventID', 'Groups', 'SentBy', 'PushStatus'],
  Groups: ['Label', 'Status'],
};

// Columns added in later versions. Read paths tolerate their absence; setup()
// (or the first write that needs them) appends them to the right of existing data.
var OPTIONAL_HEADERS = {
  // MapLink: optional Google Maps link guests are taken to when they tap the ceremony's location.
  // Group: blank = for everyone; otherwise comma-separated labels ("Bride side, Family").
  Itinerary: ['MapLink', 'Group'],
  // Groups: the member's labels; NotificationsClearedAt: when they last tapped "Clear" in Notifications.
  Members: ['TourStatus', 'TourCompletedAt', 'Groups', 'NotificationsClearedAt'],
  // Email links a travel row to the Atithi who sees it on "My travel"; DropStatus tracks the departure drop-off.
  Logistics: ['Email', 'DropStatus'],
};

// Defaults written ONLY into blank cells of rows that have a key value.
var BACKFILL = {
  Itinerary: { key: 'EventID', values: { Status: 'Upcoming' } },
  Logistics: { key: 'ID', values: { PickupStatus: 'Pending', DropStatus: 'Pending' } },
  Members: { key: 'Email', values: { Role: 'Atithi', TourStatus: 'Pending' } },
};

var TOUR_STATUSES = ['Pending', 'Completed', 'Skipped'];

var ROLES = { ADMIN: 'Admin', ATITHI: 'Atithi' };
var ROLE_LIST = [ROLES.ADMIN, ROLES.ATITHI];
// Older sheets/clients used "Viewer"; it is read and accepted as Atithi, never rewritten automatically.
var LEGACY_GUEST_ROLES = ['Viewer'];
var isLegacyGuestRole_ = function (role) {
  var r = String(role || '').trim().toLowerCase();
  return LEGACY_GUEST_ROLES.some(function (l) { return l.toLowerCase() === r; });
};
var EVENT_STATUSES = ['Upcoming', 'Live', 'Completed'];
var PICKUP_STATUSES = ['Pending', 'Picked Up'];
var DROP_STATUSES = ['Pending', 'Dropped Off'];
var AUDIT_CATEGORY = { EVENT: 'Event', LOGISTICS: 'Logistics', ADMIN: 'Admin Management', SECURITY: 'Security', ONBOARDING: 'Onboarding', SCHEMA: 'Schema' };
var EMAIL_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}$/;
var MAX_EMAIL_LEN = 254;
var MAX_FIELD_LEN = 200;
var MAX_GUESTS_PER_PARTY = 500;
var CONTACT_RE = /^[0-9+()\-.\s]{3,30}$/;
var DATETIME_INPUT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
var DEFAULT_ID_PREFIX = { Itinerary: '', Logistics: 'G' };
var MAX_BODY_BYTES = 10000;
var MAX_TOKEN_LEN = 4096;
var JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
var RATE_LIMIT_MAX = 60;
var LOCK_TIMEOUT_MS = 20000;
// A verified ID token is cached until it expires (Google issues them for ~1 h), so tokeninfo
// is called about once per member per hour. Membership is still checked on every request.
var TOKEN_CACHE_SECONDS = 3600;
// The schedule is read by every poll; writes through the app clear this cache immediately.
// Edits made directly in the Sheet show up within this many seconds.
var ITINERARY_CACHE_SECONDS = 30;
var ITINERARY_CACHE_KEY = 'itinerary_v2';
var NOTIFICATIONS_CACHE_KEY = 'notifications_v1';
var NOTIFICATIONS_KEEP = 100;   // newest rows kept in cache / considered
var NOTIFICATIONS_LIMIT = 50;   // newest rows sent to a member
// Group labels: short, comma-free text. Matching is case-insensitive.
var MAX_GROUPS = 10;
var MAX_GROUP_LEN = 30;
var GROUP_RE = /^[^,<>"`\u0000-\u001f]+$/;
var MAX_PUSH_ALIASES = 2000; // OneSignal limit per request for include_aliases

/* ----------------------------------------------------------------------------
 *  HTTP entry points
 * ------------------------------------------------------------------------- */

function doGet() {
  return jsonOut_({ ok: true, data: { service: 'event-pwa', serverTime: new Date().toISOString() } });
}

function doPost(e) {
  try {
    var req = parseRequest_(e);
    var user = authenticate_(req);
    var admin = user.role === ROLES.ADMIN;

    if (req.action === 'session') return jsonOut_({ ok: true, data: buildSession_(user, admin) });

    var memberAction = resolveAction_(req.action, user, admin);
    var handler = memberAction ? MEMBER_ACTIONS_[req.action] : ACTIONS_[req.action];
    return jsonOut_({ ok: true, data: runLocked_(handler, memberAction, user, req) });
  } catch (err) {
    return errorOut_(err);
  }
}

/** Verifies the ID token, rate limit, claimed identity and Members membership. Returns the user with role. */
function authenticate_(req) {
  var user = verifyIdToken_(req.idToken);
  enforceRateLimit_(user.email);

  if (req.userEmail != null && normalizeEmail_(req.userEmail) !== user.email) {
    throw new AppError('FORBIDDEN', 'Identity mismatch between request and token.');
  }

  var member = getMember_(user.email);
  if (!member) {
    throw new AppError('NOT_MEMBER', 'This Google account is not on the guest list. Ask an organiser to add you.');
  }
  user.role = member.role;
  user.tourStatus = member.tourStatus;
  user.groups = member.groups;
  user.notificationsClearedAt = member.notificationsClearedAt;
  return user;
}

/** Validates the action name and admin rights. Returns true for member (non-admin) actions. */
function resolveAction_(action, user, admin) {
  var memberAction = Object.prototype.hasOwnProperty.call(MEMBER_ACTIONS_, action);
  if (!memberAction && !Object.prototype.hasOwnProperty.call(ACTIONS_, action)) {
    throw new AppError('BAD_REQUEST', 'Unknown action.');
  }
  if (!memberAction && !admin) {
    writeAudit_(user.email, AUDIT_CATEGORY.SECURITY, 'Denied admin action "' + action + '" for ' + ROLES.ATITHI);
    throw new AppError('FORBIDDEN', 'You are not authorized to perform admin actions.');
  }
  return memberAction;
}

/** Runs a handler under the script lock, re-checking the caller's access first. */
function runLocked_(handler, memberAction, user, req) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) throw new AppError('BUSY', 'Server is busy, please retry.');
  try {
    // Re-check the caller under the lock: a request queued before the caller
    // was removed/demoted must not run with stale privileges.
    var current = getMember_(user.email);
    if (!current) {
      writeAudit_(user.email, AUDIT_CATEGORY.SECURITY, 'Denied queued action "' + req.action + '" after access change');
      throw new AppError('NOT_MEMBER', 'This Google account is not on the guest list.');
    }
    if (!memberAction && current.role !== ROLES.ADMIN) {
      writeAudit_(user.email, AUDIT_CATEGORY.SECURITY, 'Denied queued action "' + req.action + '" after access change');
      throw new AppError('FORBIDDEN', 'You are not authorized to perform admin actions.');
    }
    user.role = current.role;
    var result = handler(req.payload || {}, user, req);
    SpreadsheetApp.flush();
    return result;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Data visible to a signed-in member. The full logistics list (personal contact data) and the
 * member list are admin-only; everyone gets just their own travel rows ("myTravel").
 */
function buildSession_(user, admin) {
  var itinerary = cachedItinerary_();
  var session = {
    email: user.email,
    name: user.name,
    picture: user.picture,
    role: user.role,
    isAdmin: admin,
    tourStatus: user.tourStatus || 'Pending',
    groups: user.groups || [],
    // Guests only get ceremonies for everyone or for one of their groups; hosts see the whole programme.
    itinerary: admin ? itinerary : itinerary.filter(function (e) { return inGroups_(e.groups, user.groups); }),
    notifications: notificationsFor_(user, admin),
    pushId: pushIdFor_(user.email),
    familyContact: familyContact_(),
    serverTime: new Date().toISOString(),
  };
  var logistics = admin ? readLogistics_() : readLogisticsSafe_();
  session.myTravel = travelFor_(logistics, user.email);
  if (admin) {
    session.logistics = logistics;
    session.members = readMembers_();
    session.knownGroups = knownGroups_(session.members, itinerary);
    session.groupCatalog = readGroupCatalog_();
  }
  return session;
}

/** Only rows linked to this email, stripped of anything about other guests. */
function travelFor_(logistics, email) {
  return logistics
    .filter(function (g) { return g.email && g.email === email; })
    .map(function (g) {
      return {
        id: g.id, name: g.name, members: g.members, contact: g.contact,
        arrival: g.arrival, departure: g.departure, mode: g.mode,
        pickupStatus: g.pickupStatus, dropStatus: g.dropStatus,
      };
    });
}

/** A guest's session must still load when the Logistics tab is missing or half set up. */
function readLogisticsSafe_() {
  try {
    return readLogistics_();
  } catch (err) {
    if (err instanceof AppError && err.code === 'CONFIG') return [];
    throw err;
  }
}

/** Optional host contact shown to guests, kept in Script Properties so it is not in the public repo. */
function familyContact_() {
  var name = getProp_('FAMILY_CONTACT_NAME', false).slice(0, MAX_FIELD_LEN);
  var phone = getProp_('FAMILY_CONTACT_PHONE', false);
  if (!CONTACT_RE.test(phone)) phone = '';
  return name || phone ? { name: name, phone: phone } : null;
}

function cachedItinerary_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(ITINERARY_CACHE_KEY);
  if (hit) return JSON.parse(hit);
  return refreshItineraryCache_();
}

/** Re-reads the schedule and refreshes the cache. Called after every itinerary write. */
function refreshItineraryCache_() {
  var itinerary = readItinerary_();
  var json = JSON.stringify(itinerary);
  // CacheService values are capped at 100 KB; a larger schedule is simply read each time.
  if (json.length < 90000) CacheService.getScriptCache().put(ITINERARY_CACHE_KEY, json, ITINERARY_CACHE_SECONDS);
  return itinerary;
}

/* ----------------------------------------------------------------------------
 *  Action handlers (all run under lock and write to AuditLog)
 * ------------------------------------------------------------------------- */

var ACTIONS_ = {
  updateEvent: function (payload, user, req) {
    var eventId = requireString_(payload.eventId, 'eventId');
    var status = requireOneOf_(payload.status, EVENT_STATUSES, 'status');

    var table = readTable_(SHEETS.ITINERARY);
    var row = findRow_(table, 'EventID', eventId);
    if (!row) throw new AppError('NOT_FOUND', 'Event ' + eventId + ' not found.');
    assertSameEvent_(row, payload.title);

    var previous = String(row.values.Status || '');
    setCell_(table, row, 'Status', status);

    var event = toEvent_(row.values, status);
    var push = { attempted: false };
    if (status === 'Live' && payload.notify !== false) {
      push = sendLivePush_(event);
    }

    var details = 'Changed Event ' + eventId + ' ("' + event.title + '") from ' +
      (previous || 'blank') + ' to ' + status;
    if (push.attempted) {
      details += (push.ok ? ' — push sent' : ' — push FAILED: ' + push.error) + ' to ' + audienceLabel_(event.groups);
      // The in-app Notifications list shows the announcement even if the push itself failed.
      logNotification_(push.message, event, user.email, push);
    }
    writeAudit_(user.email, AUDIT_CATEGORY.EVENT, details, req.timestamp);

    return { event: event, push: push, itinerary: refreshItineraryCache_() };
  },

  broadcastNotification: function (payload, user, req) {
    var title = requireString_(payload.title, 'title');
    var body = requireString_(payload.body, 'body', 500);
    if (!Array.isArray(payload.groups)) throw new AppError('BAD_REQUEST', '"groups" must be an array.');
    var groups = resolveGroups_(payload.groups);
    var message = { title: title, body: body };
    var push = sendPush_(message, groups, '');

    logNotification_(message, { id: '', groups: groups }, user.email, push);
    var result = push.ok ? 'push sent' : 'push FAILED: ' + push.error;
    writeAudit_(user.email, AUDIT_CATEGORY.EVENT,
      'Broadcast "' + title + '" to ' + audienceLabel_(groups) + ' — ' + result, req.timestamp);

    return { push: push, notifications: notificationsFor_(user, true) };
  },

  updatePickup: function (payload, user, req) {
    return setTravelStatus_(payload, user, req, 'PickupStatus', PICKUP_STATUSES);
  },

  updateDropoff: function (payload, user, req) {
    return setTravelStatus_(payload, user, req, 'DropStatus', DROP_STATUSES);
  },

  /** Edits an existing travel row (guests' plans change). Status columns are left alone. */
  updateLogistics: function (payload, user, req) {
    var id = requireString_(payload.id, 'id');
    var input = parseTravelInput_(payload);
    ensureColumns_(SHEETS.LOGISTICS, OPTIONAL_HEADERS.Logistics);
    var table = readTable_(SHEETS.LOGISTICS);
    var row = findRow_(table, 'ID', id);
    if (!row) throw new AppError('NOT_FOUND', 'Guest record ' + id + ' not found.');

    var changed = [];
    // Only fields the client sent are touched, so a value the form cannot show is never wiped.
    Object.keys(TRAVEL_FIELDS_).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(payload, key)) return;
      var column = TRAVEL_FIELDS_[key];
      if (sameCell_(row.values[column], input[key])) return;
      setCell_(table, row, column, input[key]);
      changed.push(key);
    });
    if (changed.length) {
      writeAudit_(user.email, AUDIT_CATEGORY.LOGISTICS, 'Updated ' + input.name + ' (ID ' + id + '): ' + changed.join(', '), req.timestamp);
    }
    return { id: id, changed: changed, logistics: readLogistics_() };
  },

  /**
   * Deletes a ceremony row, then shifts the numeric EventIDs of the rows below it down by one
   * (e.g. deleting 3 turns 4→3, 5→4) so the schedule stays 1..N. `title` (when sent) must match,
   * so a stale screen can never delete a different, already-renumbered event.
   */
  deleteEvent: function (payload, user, req) {
    var eventId = requireString_(payload.eventId, 'eventId');
    var table = readTable_(SHEETS.ITINERARY);
    var row = findRow_(table, 'EventID', eventId);
    if (!row) throw new AppError('NOT_FOUND', 'Event ' + eventId + ' not found. Refresh and try again.');
    var title = String(row.values.Title || '').trim();
    if (payload.title != null && String(payload.title).trim() !== title) {
      throw new AppError('CONFLICT', 'The schedule changed since you opened it. Refresh and try again.');
    }

    var renumber = planEventRenumber_(table, row);
    table.sheet.deleteRow(row.rowIndex);
    // Rows below the deleted one moved up by one; address them by position, not by ID,
    // because IDs are being rewritten as we go.
    renumber.forEach(function (change) {
      setCell_(table, { rowIndex: change.row.rowIndex - 1, values: change.row.values }, 'EventID', change.to);
    });

    var details = 'Deleted Event ' + eventId + ' ("' + title + '")' +
      (row.values.Status ? ' [' + String(row.values.Status).trim() + ']' : '');
    if (renumber.length) {
      details += '; renumbered ' + renumber.map(function (c) { return c.from + '→' + c.to; }).join(', ');
    }
    writeAudit_(user.email, AUDIT_CATEGORY.EVENT, details, req.timestamp);

    return {
      deletedId: eventId,
      renumbered: renumber.map(function (c) { return { from: c.from, to: c.to }; }),
      itinerary: refreshItineraryCache_(),
    };
  },

  addEvent: function (payload, user, req) {
    var title = requireString_(payload.title, 'title');
    var day = requireString_(payload.day, 'day');
    var time = optionalString_(payload.time, 'time');
    var location = optionalString_(payload.location, 'location');
    var mapLink = optionalMapLink_(payload.mapLink);
    var groups = resolveGroups_(payload.groups, []);
    if (mapLink || groups.length) ensureColumns_(SHEETS.ITINERARY, OPTIONAL_HEADERS.Itinerary);

    // New events always start as Upcoming; going Live (with push) is a separate, deliberate action.
    var table = readTable_(SHEETS.ITINERARY);
    var id = nextId_(table, 'EventID', DEFAULT_ID_PREFIX.Itinerary);
    appendRecord_(table, { EventID: id, Day: day, Time: time, Title: title, Location: location, MapLink: mapLink, Group: groups.join(', '), Status: 'Upcoming' });
    writeAudit_(user.email, AUDIT_CATEGORY.EVENT, 'Added Event ' + id + ' ("' + title + '") on ' + day +
      (time ? ' at ' + time : '') + (location ? ' @ ' + location : '') + (mapLink ? ' (map: ' + mapLink + ')' : '') +
      (groups.length ? ' for ' + audienceLabel_(groups) : ''), req.timestamp);

    return { eventId: id, itinerary: refreshItineraryCache_() };
  },

  addPickup: function (payload, user, req) {
    var input = parseTravelInput_(payload);
    var status = requireOneOf_(payload.pickupStatus || 'Pending', PICKUP_STATUSES, 'pickupStatus');

    // Older sheets may not have Email/DropStatus yet; add them so nothing typed is lost.
    ensureColumns_(SHEETS.LOGISTICS, OPTIONAL_HEADERS.Logistics);
    var table = readTable_(SHEETS.LOGISTICS);
    var id = nextId_(table, 'ID', DEFAULT_ID_PREFIX.Logistics);
    appendRecord_(table, {
      ID: id, Name: input.name, Members: input.members, Contact: input.contact, Email: input.email,
      ArrivalDateTime: input.arrival, DepartureDateTime: input.departure, Mode: input.mode,
      PickupStatus: status, DropStatus: 'Pending',
    });
    writeAudit_(user.email, AUDIT_CATEGORY.LOGISTICS, 'Added ' + input.name + ' (ID ' + id + ')' +
      (input.members ? ', ' + input.members + ' guest(s)' : '') + (input.mode ? ', ' + input.mode : '') +
      (input.email ? ', linked to ' + input.email : '') + ' as ' + status, req.timestamp);

    return { id: id, logistics: readLogistics_() };
  },

  addMember: function (payload, user, req) {
    var email = requireEmail_(payload.email);
    var role = requireRole_(payload.role || ROLES.ATITHI);
    var groups = resolveGroups_(payload.groups, []);
    if (getMember_(email)) throw new AppError('CONFLICT', email + ' is already a member.');

    if (groups.length) ensureColumns_(SHEETS.MEMBERS, OPTIONAL_HEADERS.Members);
    appendRecord_(readTable_(SHEETS.MEMBERS), { Email: email, Role: role, AddedBy: user.email, AddedDate: new Date(), Groups: groups.join(', ') });
    writeAudit_(user.email, AUDIT_CATEGORY.ADMIN, 'Added ' + email + ' to Members as ' + role +
      (groups.length ? ' in groups ' + groups.join(', ') : ''), req.timestamp);

    return { members: readMembers_() };
  },

  /** Replaces a member's group labels (blank = no groups: they then see only ceremonies for everyone). */
  updateMemberGroups: function (payload, user, req) {
    var email = requireEmail_(payload.email, true);
    var groups = requireGroups_(payload.groups);
    ensureColumns_(SHEETS.MEMBERS, OPTIONAL_HEADERS.Members);
    var table = readTable_(SHEETS.MEMBERS);
    var row = findMemberRow_(table, email);
    if (!row) throw new AppError('NOT_FOUND', email + ' is not a member.');

    var previous = parseGroups_(row.values.Groups);
    groups = resolveGroups_(groups, previous);
    if (sameGroups_(previous, groups)) return { members: readMembers_() };
    setCell_(table, row, 'Groups', groups.join(', '));
    writeAudit_(user.email, AUDIT_CATEGORY.ADMIN, 'Changed groups of ' + email + ' from ' +
      (previous.join(', ') || 'none') + ' to ' + (groups.join(', ') || 'none'), req.timestamp);

    return { members: readMembers_() };
  },

  /** Sets who a ceremony is for. Blank = all current Members; otherwise only matching group members. */
  updateEventGroup: function (payload, user, req) {
    var eventId = requireString_(payload.eventId, 'eventId');
    var groups = requireGroups_(payload.groups);
    ensureColumns_(SHEETS.ITINERARY, OPTIONAL_HEADERS.Itinerary);
    var table = readTable_(SHEETS.ITINERARY);
    var row = findRow_(table, 'EventID', eventId);
    if (!row) throw new AppError('NOT_FOUND', 'Event ' + eventId + ' not found.');
    assertSameEvent_(row, payload.title);

    var previous = parseGroups_(row.values.Group);
    groups = resolveGroups_(groups, previous);
    if (!sameGroups_(previous, groups)) {
      setCell_(table, row, 'Group', groups.join(', '));
      writeAudit_(user.email, AUDIT_CATEGORY.EVENT, 'Changed audience of Event ' + eventId + ' ("' +
        String(row.values.Title || '').trim() + '") from ' + audienceLabel_(previous) + ' to ' + audienceLabel_(groups), req.timestamp);
    }
    return { itinerary: refreshItineraryCache_() };
  },

  addGroup: function (payload, user, req) {
    var label = requireGroupLabel_(payload.label);
    var catalog = readGroupCatalog_();
    if (catalog.some(function (group) { return group.label.toLowerCase() === label.toLowerCase(); })) {
      throw new AppError('CONFLICT', 'A group with that label already exists.');
    }
    var table = readTable_(SHEETS.GROUPS);
    appendRecord_(table, { Label: label, Status: 'Active' });
    writeAudit_(user.email, AUDIT_CATEGORY.ADMIN, 'Added group "' + label + '"', req.timestamp);
    return { groupCatalog: readGroupCatalog_() };
  },

  archiveGroup: function (payload, user, req) {
    var label = requireGroupLabel_(payload.label);
    var table = readTable_(SHEETS.GROUPS);
    var row = table.rows.find(function (candidate) {
      return String(candidate.values.Label || '').trim().toLowerCase() === label.toLowerCase();
    });
    if (!row) throw new AppError('NOT_FOUND', 'Group "' + label + '" does not exist.');
    if (String(row.values.Status || '').trim() !== 'Archived') {
      setCell_(table, row, 'Status', 'Archived');
      writeAudit_(user.email, AUDIT_CATEGORY.ADMIN, 'Archived group "' + String(row.values.Label).trim() + '"', req.timestamp);
    }
    return { groupCatalog: readGroupCatalog_() };
  },

  updateMemberRole: function (payload, user, req) {
    var email = requireEmail_(payload.email, true);
    var role = requireRole_(payload.role);
    if (email === user.email) throw new AppError('FORBIDDEN', 'You cannot change your own role.');

    var table = readTable_(SHEETS.MEMBERS);
    var row = findMemberRow_(table, email);
    if (!row) throw new AppError('NOT_FOUND', email + ' is not a member.');

    var previous = normalizeRole_(row.values.Role);
    if (previous === role) return { members: readMembers_() };
    if (previous === ROLES.ADMIN && countAdmins_(table) <= 1) {
      throw new AppError('FORBIDDEN', 'At least one admin must remain.');
    }

    setCell_(table, row, 'Role', role);
    writeAudit_(user.email, AUDIT_CATEGORY.ADMIN, 'Changed role of ' + email + ' from ' + previous + ' to ' + role, req.timestamp);

    return { members: readMembers_() };
  },

  removeMember: function (payload, user, req) {
    var email = requireEmail_(payload.email, true);
    if (email === user.email) throw new AppError('FORBIDDEN', 'You cannot remove your own access.');

    var table = readTable_(SHEETS.MEMBERS);
    var matches = table.rows.filter(function (r) { return normalizeEmail_(r.values.Email) === email; });
    if (!matches.length) throw new AppError('NOT_FOUND', email + ' is not a member.');

    var removedAdmins = matches.filter(function (r) { return normalizeRole_(r.values.Role) === ROLES.ADMIN; }).length;
    if (removedAdmins && countAdmins_(table) - removedAdmins < 1) {
      throw new AppError('FORBIDDEN', 'At least one admin must remain.');
    }

    // Delete bottom-up so row indexes stay valid.
    matches.sort(function (a, b) { return b.rowIndex - a.rowIndex; }).forEach(function (r) {
      table.sheet.deleteRow(r.rowIndex);
    });
    var role = normalizeRole_(matches[0].values.Role);
    writeAudit_(user.email, AUDIT_CATEGORY.ADMIN, 'Removed ' + email + ' (' + role + ') from Members', req.timestamp);

    return { members: readMembers_() };
  },
};

// Backwards-compatible aliases for the original admin-only API.
ACTIONS_.addAdmin = function (payload, user, req) {
  return ACTIONS_.addMember({ email: payload.email, role: ROLES.ADMIN }, user, req);
};
ACTIONS_.removeAdmin = ACTIONS_.removeMember;

/** Actions any member may call. Each one may only touch the caller's own row. */
var MEMBER_ACTIONS_ = {
  completeTour: function (payload, user, req) {
    var status = requireOneOf_(payload.status, ['Completed', 'Skipped'], 'status');
    ensureColumns_(SHEETS.MEMBERS, OPTIONAL_HEADERS.Members);

    var table = readTable_(SHEETS.MEMBERS);
    var row = findMemberRow_(table, user.email);
    if (!row) throw new AppError('NOT_MEMBER', 'This Google account is not on the guest list.');
    if (normalizeTour_(row.values.TourStatus) !== 'Pending') return { tourStatus: normalizeTour_(row.values.TourStatus) };

    setCell_(table, row, 'TourStatus', status);
    setCell_(table, row, 'TourCompletedAt', new Date());
    writeAudit_(user.email, AUDIT_CATEGORY.ONBOARDING, 'Welcome tour ' + status.toLowerCase(), req.timestamp);
    return { tourStatus: status };
  },

  /**
   * "Clear" in the Notifications tab: hides everything sent so far for this member, on every device.
   * Only the caller's own row is touched. Not audited: it is a personal view preference, not an admin change.
   */
  clearNotifications: function (payload, user) {
    ensureColumns_(SHEETS.MEMBERS, OPTIONAL_HEADERS.Members);
    var table = readTable_(SHEETS.MEMBERS);
    var row = findMemberRow_(table, user.email);
    if (!row) throw new AppError('NOT_MEMBER', 'This Google account is not on the guest list.');
    var now = new Date();
    setCell_(table, row, 'NotificationsClearedAt', now);
    user.notificationsClearedAt = now.toISOString();
    return { notifications: notificationsFor_(user, normalizeRole_(row.values.Role) === ROLES.ADMIN) };
  },
};

/** Payload key → Logistics column, for the fields an admin can type in. */
var TRAVEL_FIELDS_ = {
  name: 'Name', members: 'Members', contact: 'Contact', email: 'Email',
  arrival: 'ArrivalDateTime', departure: 'DepartureDateTime', mode: 'Mode',
};

/** Validates the editable travel fields shared by addPickup and updateLogistics. */
function parseTravelInput_(payload) {
  var input = {
    name: requireString_(payload.name, 'name'),
    members: optionalCount_(payload.members, 'members'),
    contact: optionalString_(payload.contact, 'contact'),
    email: payload.email == null || String(payload.email).trim() === '' ? '' : requireEmail_(payload.email),
    arrival: optionalDateTime_(payload.arrival, 'arrival'),
    departure: optionalDateTime_(payload.departure, 'departure'),
    mode: optionalString_(payload.mode, 'mode'),
  };
  if (input.contact && !CONTACT_RE.test(input.contact)) throw new AppError('BAD_REQUEST', 'Please provide a valid phone number.');
  if (input.arrival && input.departure && input.departure < input.arrival) throw new AppError('BAD_REQUEST', 'Departure must be after arrival.');
  return input;
}

function setTravelStatus_(payload, user, req, column, allowed) {
  var id = requireString_(payload.id, 'id');
  var status = requireOneOf_(payload.status, allowed, 'status');
  if (column !== 'PickupStatus') ensureColumns_(SHEETS.LOGISTICS, [column]);

  var table = readTable_(SHEETS.LOGISTICS);
  var row = findRow_(table, 'ID', id);
  if (!row) throw new AppError('NOT_FOUND', 'Guest record ' + id + ' not found.');

  setCell_(table, row, column, status);
  var name = String(row.values.Name || id);
  var what = column === 'DropStatus' ? 'drop-off' : 'pick-up';
  var details = column === 'PickupStatus'
    ? 'Marked ' + name + ' (ID ' + id + ') as ' + status
    : 'Marked ' + name + ' (ID ' + id + ') ' + what + ' as ' + status;
  writeAudit_(user.email, AUDIT_CATEGORY.LOGISTICS, details, req.timestamp);
  return { logistics: readLogistics_() };
}

/** True when a sheet cell already holds the value about to be written (dates compared by time). */
function sameCell_(current, next) {
  if (current instanceof Date && next instanceof Date) return current.getTime() === next.getTime();
  return String(current == null ? '' : current).trim() === String(next == null ? '' : next).trim();
}

function normalizeTour_(v) {
  var s = String(v || '').trim();
  return TOUR_STATUSES.indexOf(s) >= 0 ? s : 'Pending';
}

/* ----------------------------------------------------------------------------
 *  Authentication
 * ------------------------------------------------------------------------- */

/** Cheap local checks so garbage/expired/foreign tokens never cost a UrlFetch call. */
function precheckIdToken_(idToken, clientId) {
  if (!idToken || typeof idToken !== 'string') throw new AppError('AUTH_REQUIRED', 'Please sign in with Google.');
  if (idToken.length > MAX_TOKEN_LEN || !JWT_RE.test(idToken)) throw new AppError('AUTH_INVALID', 'Invalid sign-in token.');
  var claims = null;
  try {
    var seg = idToken.split('.')[1];
    seg += new Array((4 - (seg.length % 4)) % 4 + 1).join('=');
    claims = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(seg)).getDataAsString());
  } catch {
    // Undecodable payload: reject without echoing parser details back to the client.
    throw new AppError('AUTH_INVALID', 'Invalid sign-in token.');
  }
  if (!claims || claims.aud !== clientId) throw new AppError('AUTH_INVALID', 'Invalid sign-in token.');
  var expMs = Number(claims.exp) * 1000;
  // Missing/NaN exp counts as expired.
  if (!Number.isFinite(expMs) || expMs <= Date.now()) throw new AppError('AUTH_EXPIRED', 'Your sign-in has expired. Please sign in again.');
}

function verifyIdToken_(idToken) {
  var clientId = getProp_('GOOGLE_CLIENT_ID', true);
  precheckIdToken_(idToken, clientId);

  var cache = CacheService.getScriptCache();
  var cacheKey = 'tok_' + sha256_(idToken);
  var cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  var res = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 200) {
    throw new AppError('AUTH_EXPIRED', 'Your sign-in has expired. Please sign in again.');
  }

  var info = safeJson_(res.getContentText()) || {};
  var validIssuer = info.iss === 'accounts.google.com' || info.iss === 'https://accounts.google.com';
  var notExpired = Number(info.exp) * 1000 > Date.now();
  var verified = info.email_verified === true || info.email_verified === 'true';

  if (info.aud !== clientId || !validIssuer || !notExpired) {
    throw new AppError('AUTH_INVALID', 'Invalid sign-in token.');
  }
  if (!info.email || !verified) throw new AppError('AUTH_INVALID', 'Google account email is not verified.');

  var picture = /^https:\/\/[a-z0-9.-]+\.googleusercontent\.com\//i.test(info.picture || '') ? info.picture : '';
  var user = { email: normalizeEmail_(info.email), name: String(info.name || '').slice(0, MAX_FIELD_LEN), picture: picture };
  var ttl = Math.min(TOKEN_CACHE_SECONDS, Math.floor((Number(info.exp) * 1000 - Date.now()) / 1000));
  if (ttl > 0) cache.put(cacheKey, JSON.stringify(user), ttl);
  return user;
}

/** Fixed-window per-user limiter; protects sheet/UrlFetch quotas from a compromised or buggy client. */
function enforceRateLimit_(email) {
  var cache = CacheService.getScriptCache();
  var key = 'rl_' + sha256_(email) + '_' + Math.floor(Date.now() / 60000);
  var count = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(count), 120);
  if (count > RATE_LIMIT_MAX) throw new AppError('RATE_LIMITED', 'Too many requests. Please wait a minute and try again.');
}

function getMember_(email) {
  var target = normalizeEmail_(email);
  if (!target) return null;
  var members = readMembers_();
  for (var i = 0; i < members.length; i++) {
    if (members[i].email === target) return members[i];
  }
  return null;
}

function findMemberRow_(table, email) {
  for (var i = 0; i < table.rows.length; i++) {
    if (normalizeEmail_(table.rows[i].values.Email) === email) return table.rows[i];
  }
  return null;
}

function countAdmins_(table) {
  return table.rows.filter(function (r) {
    return normalizeEmail_(r.values.Email) && normalizeRole_(r.values.Role) === ROLES.ADMIN;
  }).length;
}

/** Unknown/blank/legacy "Viewer" roles are treated as Atithi (least privilege). */
function normalizeRole_(role) {
  return String(role || '').trim().toLowerCase() === 'admin' ? ROLES.ADMIN : ROLES.ATITHI;
}

/** Validates a role sent by a client; the legacy name "Viewer" is accepted as Atithi. */
function requireRole_(value) {
  var s = requireString_(value, 'role');
  if (isLegacyGuestRole_(s)) return ROLES.ATITHI;
  return requireOneOf_(s, ROLE_LIST, 'role');
}

/* ----------------------------------------------------------------------------
 *  OneSignal push (REST key never leaves the server)
 * ------------------------------------------------------------------------- */

/**
 * Live push. Ceremonies with no group go to all current members; labelled ones go only to the
 * devices of members in those groups (OneSignal external_id = pushIdFor_(email), set by the app).
 * The result always carries `message` ({title, body}) so it can be logged in Notifications.
 */
function sendLivePush_(event) {
  var message = {
    title: '\uD83E\uDE94 Live now: ' + event.title,
    body: [event.title, event.location ? '@ ' + event.location : '', event.time ? '(' + event.time + ')' : '']
      .filter(String).join(' ') + ' \u2014 please gather at the venue!',
  };
  return sendPush_(message, event.groups || [], 'event-live');
}

/** Sends an already-composed message to the opaque IDs matching its audience. */
function sendPush_(message, groups, topic) {
  groups = groups || [];
  var fail = function (error) { return { attempted: true, ok: false, error: error, message: message }; };

  var appId = getProp_('ONESIGNAL_APP_ID', false);
  var apiKey = getProp_('ONESIGNAL_REST_API_KEY', false);
  if (!appId || !apiKey) return fail('OneSignal is not configured in Script Properties.');

  var body = {
    app_id: appId,
    target_channel: 'push',
    headings: { en: message.title },
    contents: { en: message.body },
  };
  if (topic) body.web_push_topic = topic;
  var ids = groupPushIds_(groups);
  if (!ids.length) return fail(groups.length ? 'No members are in group ' + groups.join(', ') + ' yet.' : 'There are no current members to notify.');
  if (ids.length > MAX_PUSH_ALIASES) {
    return fail('This audience has ' + ids.length + ' members, above OneSignal\'s ' + MAX_PUSH_ALIASES + '-recipient limit. Split it into smaller groups.');
  }
  body.include_aliases = { external_id: ids };
  var appUrl = getProp_('APP_URL', false);
  if (appUrl) {
    var separator = /[?&]$/.test(appUrl) ? '' : (appUrl.indexOf('?') >= 0 ? '&' : '?');
    body.url = appUrl + separator + 'open=notifications';
  }

  try {
    var res = UrlFetchApp.fetch('https://api.onesignal.com/notifications?c=push', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Key ' + apiKey },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });
    var code = res.getResponseCode();
    var parsed = safeJson_(res.getContentText()) || {};
    if (code >= 200 && code < 300 && !parsed.errors) {
      return { attempted: true, ok: true, id: parsed.id || null, message: message };
    }
    var msg = parsed.errors ? JSON.stringify(parsed.errors) : 'HTTP ' + code;
    if (/not subscribed/i.test(msg)) {
      msg += ' \u2014 no device has finished subscribing yet. If phones did tap "Notify me", check OneSignal'
        + ' \u2192 Settings \u2192 Push & In-App \u2192 Web: integration must be "Custom Code" (see DEVELOPER_GUIDE "Push").';
      if (groups.length) msg = 'None of the devices of group ' + groups.join(', ') + ' are subscribed yet (members must open the updated app once with notifications on). ' + msg;
    }
    return fail(msg.slice(0, 400));
  } catch (err) {
    return fail(String(err && err.message || err).slice(0, 300));
  }
}

/* ----------------------------------------------------------------------------
 *  Group labels
 * ------------------------------------------------------------------------- */

/** "Bride side, bride side ,Family" -> ['Bride side', 'Family'] (first spelling wins, case-insensitive). */
function parseGroups_(value) {
  var seen = Object.create(null);
  var out = [];
  String(value == null ? '' : value).split(',').forEach(function (part) {
    var g = part.replace(/\s+/g, ' ').trim();
    var key = g.toLowerCase();
    if (!g || seen[key]) return;
    seen[key] = true;
    out.push(g);
  });
  return out;
}

/** Validates labels sent by a client: an array of strings or one comma-separated string. Blank = none. */
function requireGroups_(value) {
  if (value == null) return [];
  var parts = Array.isArray(value) ? value : [value];
  parts.forEach(function (p) {
    if (typeof p !== 'string') throw new AppError('BAD_REQUEST', '"groups" must be text.');
  });
  var groups = parseGroups_(parts.join(','));
  if (groups.length > MAX_GROUPS) throw new AppError('BAD_REQUEST', 'At most ' + MAX_GROUPS + ' groups are allowed.');
  groups.forEach(function (g) {
    if (g.length > MAX_GROUP_LEN || !GROUP_RE.test(g)) {
      throw new AppError('BAD_REQUEST', 'Group "' + g.slice(0, MAX_GROUP_LEN) + '" must be up to ' + MAX_GROUP_LEN + ' characters without < > " or `.');
    }
  });
  return groups;
}

/** Resolves user selections to catalog spelling; archived labels can only be retained if already assigned. */
function resolveGroups_(value, previous) {
  var requested = requireGroups_(value);
  var catalog = readGroupCatalog_();
  var existing = (previous || []).map(function (label) { return label.toLowerCase(); });
  return requested.map(function (label) {
    var group = catalog.find(function (candidate) { return candidate.label.toLowerCase() === label.toLowerCase(); });
    if (!group) throw new AppError('BAD_REQUEST', 'Choose a group from the active group list.');
    if (group.status !== 'Active' && existing.indexOf(group.label.toLowerCase()) < 0) {
      throw new AppError('BAD_REQUEST', 'Archived groups cannot be assigned to new members or ceremonies.');
    }
    return group.label;
  });
}

function requireGroupLabel_(value) {
  var label = requireString_(value, 'label').replace(/\s+/g, ' ').trim();
  if (label.length > MAX_GROUP_LEN || label.indexOf(',') >= 0 || !GROUP_RE.test(label)) {
    throw new AppError('BAD_REQUEST', 'Group label must be up to ' + MAX_GROUP_LEN + ' characters without commas or unsafe characters.');
  }
  return label;
}

function readGroupCatalog_() {
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.GROUPS)) return [];
  return readTable_(SHEETS.GROUPS).rows
    .map(function (row) {
      var label = String(row.values.Label || '').trim();
      var status = String(row.values.Status || '').trim();
      return label ? { label: label, status: status === 'Active' ? 'Active' : 'Archived' } : null;
    })
    .filter(function (group) { return group !== null; })
    .sort(function (a, b) {
      var lowerA = a.label.toLowerCase();
      var lowerB = b.label.toLowerCase();
      return lowerA < lowerB ? -1 : lowerA > lowerB ? 1 : 0;
    });
}

function seedGroupCatalog_() {
  var table = readTable_(SHEETS.GROUPS);
  var existing = Object.create(null);
  table.rows.forEach(function (row) {
    var label = String(row.values.Label || '').trim();
    if (label) existing[label.toLowerCase()] = true;
  });
  var labels = [];
  readMembers_().forEach(function (member) { labels = labels.concat(member.groups); });
  readItinerary_().forEach(function (event) { labels = labels.concat(event.groups); });
  var seeded = 0;
  parseGroups_(labels.join(',')).forEach(function (label) {
    var key = label.toLowerCase();
    if (existing[key]) return;
    appendRecord_(table, { Label: label, Status: 'Active' });
    existing[key] = true;
    seeded += 1;
  });
  return seeded;
}

/** True when an item for `targetGroups` is meant for someone in `memberGroups`. No target groups = everyone. */
function inGroups_(targetGroups, memberGroups) {
  if (!targetGroups || !targetGroups.length) return true;
  var mine = (memberGroups || []).map(function (g) { return g.toLowerCase(); });
  return targetGroups.some(function (g) { return mine.indexOf(g.toLowerCase()) >= 0; });
}

function sameGroups_(a, b) {
  var norm = function (list) { return list.map(function (g) { return g.toLowerCase(); }).sort().join(','); };
  return a.length === b.length && norm(a) === norm(b);
}

function audienceLabel_(groups) {
  return groups && groups.length ? 'group ' + groups.join(', ') : 'everyone';
}

/** Every label in use (members and ceremonies), for the admin pickers. */
function knownGroups_(members, itinerary) {
  var all = [];
  members.forEach(function (m) { all = all.concat(m.groups || []); });
  itinerary.forEach(function (e) { all = all.concat(e.groups || []); });
  return parseGroups_(all.join(',')).sort(function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : 1; });
}

/* ----------------------------------------------------------------------------
 *  Push identity: each member's device is tagged in OneSignal with an opaque
 *  external_id derived from their email, so labelled pushes reach only that
 *  group. The HMAC secret stays in Script Properties, so nobody can compute
 *  another member's ID from their email.
 * ------------------------------------------------------------------------- */

var pushSecretMemo_ = null;

function pushSecret_() {
  if (pushSecretMemo_) return pushSecretMemo_;
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('PUSH_ID_SECRET');
  if (!secret) {
    // setup() creates it up front; this fallback only runs if setup() was not re-run after upgrading.
    // (No lock here: callers may already hold the script lock.)
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('PUSH_ID_SECRET', secret);
  }
  pushSecretMemo_ = secret;
  return secret;
}

function pushIdFor_(email) {
  var sig = Utilities.computeHmacSha256Signature(normalizeEmail_(email), pushSecret_());
  return 'm_' + sig.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('').slice(0, 40);
}

function groupPushIds_(groups) {
  return readMembers_()
    .filter(function (m) { return inGroups_(groups, m.groups); })
    .map(function (m) { return pushIdFor_(m.email); });
}

/* ----------------------------------------------------------------------------
 *  Notification centre (one row per announcement; read by every session)
 * ------------------------------------------------------------------------- */

/** Appends an announcement, creating the Notifications tab on first use (never touches existing data). */
function logNotification_(message, event, senderEmail, push) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.NOTIFICATIONS);
  if (!sheet) sheet = ss.insertSheet(SHEETS.NOTIFICATIONS);
  if (sheet.getLastRow() === 0 && sheet.getLastColumn() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.Notifications.length).setValues([HEADERS.Notifications]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  } else {
    ensureColumns_(SHEETS.NOTIFICATIONS, HEADERS.Notifications);
  }
  appendRecord_(readTable_(SHEETS.NOTIFICATIONS), {
    Timestamp: new Date(),
    Title: String(message.title).slice(0, MAX_FIELD_LEN),
    Message: String(message.body).slice(0, 500),
    EventID: event.id || '',
    Groups: (event.groups || []).join(', '),
    SentBy: normalizeEmail_(senderEmail),
    PushStatus: push.ok ? 'Sent' : ('Failed: ' + push.error).slice(0, 300),
  });
  return refreshNotificationsCache_();
}

function cachedNotifications_() {
  var hit = CacheService.getScriptCache().get(NOTIFICATIONS_CACHE_KEY);
  if (hit) return JSON.parse(hit);
  return refreshNotificationsCache_();
}

/** Newest first. A missing or half-set-up tab simply means "no notifications yet". */
function refreshNotificationsCache_() {
  var list = [];
  try {
    var rows = readTable_(SHEETS.NOTIFICATIONS).rows.filter(function (r) {
      return String(r.values.Title || '').trim() !== '';
    });
    list = rows.slice(-NOTIFICATIONS_KEEP).reverse().map(function (r) {
      var v = r.values;
      return {
        id: String(r.rowIndex),
        at: toIso_(v.Timestamp),
        title: String(v.Title || '').trim(),
        message: String(v.Message || '').trim(),
        eventId: String(v.EventID == null ? '' : v.EventID).trim(),
        groups: parseGroups_(v.Groups),
        sentBy: normalizeEmail_(v.SentBy),
        pushStatus: String(v.PushStatus || '').trim(),
      };
    });
  } catch (err) {
    if (!(err instanceof AppError && err.code === 'CONFIG')) throw err;
  }
  var json = JSON.stringify(list);
  if (json.length < 90000) CacheService.getScriptCache().put(NOTIFICATIONS_CACHE_KEY, json, ITINERARY_CACHE_SECONDS);
  return list;
}

/** What this member sees: their groups only (hosts see all), newer than their last "Clear". */
function notificationsFor_(user, admin) {
  var clearedAt = user.notificationsClearedAt ? Date.parse(user.notificationsClearedAt) : 0;
  return cachedNotifications_()
    .filter(function (n) { return admin || inGroups_(n.groups, user.groups); })
    .filter(function (n) { return !clearedAt || !n.at || Date.parse(n.at) > clearedAt; })
    .slice(0, NOTIFICATIONS_LIMIT)
    .map(function (n) {
      var out = { id: n.id, at: n.at, title: n.title, message: n.message, eventId: n.eventId, groups: n.groups };
      if (admin) { out.sentBy = n.sentBy; out.pushStatus = n.pushStatus; }
      return out;
    });
}

function toIso_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString();
  var t = Date.parse(String(v == null ? '' : v));
  return isNaN(t) ? '' : new Date(t).toISOString();
}

/* ----------------------------------------------------------------------------
 *  Audit log
 * ------------------------------------------------------------------------- */

function writeAudit_(email, category, details, clientTimestamp) {
  // Server time is authoritative; the client timestamp is recorded only if it drifts > 2 min.
  var now = new Date();
  var text = String(details);
  var clientTs = clientTimestamp ? new Date(clientTimestamp) : null;
  if (clientTs && !isNaN(clientTs) && Math.abs(clientTs - now) > 120000) {
    text += ' [client time: ' + clientTs.toISOString() + ']';
  }
  appendSafe_(SHEETS.AUDIT, [now, normalizeEmail_(email), category, text.slice(0, 1000)]);
}

/* ----------------------------------------------------------------------------
 *  Data readers
 * ------------------------------------------------------------------------- */

function readItinerary_() {
  return readTable_(SHEETS.ITINERARY).rows
    .filter(function (r) { return String(r.values.EventID || '').trim() !== ''; })
    .map(function (r) { return toEvent_(r.values); });
}

function toEvent_(v, statusOverride) {
  var status = statusOverride || String(v.Status || 'Upcoming').trim();
  return {
    id: String(v.EventID).trim(),
    day: formatDay_(v.Day),
    time: formatTime_(v.Time),
    title: String(v.Title || '').trim(),
    location: String(v.Location || '').trim(),
    mapLink: isMapsUrl_(String(v.MapLink || '').trim()) ? String(v.MapLink).trim() : '',
    groups: parseGroups_(v.Group),
    status: EVENT_STATUSES.indexOf(status) >= 0 ? status : 'Upcoming',
  };
}

function readLogistics_() {
  return readTable_(SHEETS.LOGISTICS).rows
    .filter(function (r) { return String(r.values.ID || '').trim() !== ''; })
    .map(function (r) {
      var v = r.values;
      var pickup = String(v.PickupStatus || 'Pending').trim();
      var drop = String(v.DropStatus || 'Pending').trim();
      return {
        id: String(v.ID).trim(),
        name: String(v.Name || '').trim(),
        members: v.Members === '' ? '' : String(v.Members),
        contact: String(v.Contact || '').trim(),
        email: normalizeEmail_(v.Email),
        arrival: formatDateTime_(v.ArrivalDateTime),
        departure: formatDateTime_(v.DepartureDateTime),
        mode: String(v.Mode || '').trim(),
        pickupStatus: PICKUP_STATUSES.indexOf(pickup) >= 0 ? pickup : 'Pending',
        dropStatus: DROP_STATUSES.indexOf(drop) >= 0 ? drop : 'Pending',
      };
    });
}

function readMembers_() {
  return readTable_(SHEETS.MEMBERS).rows
    .map(function (r) {
      return {
        email: normalizeEmail_(r.values.Email),
        role: normalizeRole_(r.values.Role),
        addedBy: String(r.values.AddedBy || ''),
        addedDate: formatDateTime_(r.values.AddedDate),
        tourStatus: normalizeTour_(r.values.TourStatus),
        groups: parseGroups_(r.values.Groups),
        notificationsClearedAt: toIso_(r.values.NotificationsClearedAt),
      };
    })
    .filter(function (m) { return m.email; });
}

/* ----------------------------------------------------------------------------
 *  Sheet helpers (header-driven, so column order in the sheet may vary)
 * ------------------------------------------------------------------------- */

function getSheet_(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new AppError('CONFIG', 'Missing sheet tab "' + name + '". Run setup() once.');
  return sheet;
}

function readTable_(name) {
  var sheet = getSheet_(name);
  var values = sheet.getDataRange().getValues();
  var known = (HEADERS[name] || []).concat(OPTIONAL_HEADERS[name] || []);
  // Map " status " / "STATUS" etc. to the canonical name without editing the sheet.
  var headers = (values[0] || []).map(function (h) { return canonicalHeader_(h, known); });
  var required = HEADERS[name] || [];
  var missing = required.filter(function (h) { return headers.indexOf(h) < 0; });
  if (missing.length) {
    throw new AppError('CONFIG', 'Sheet "' + name + '" is missing columns: ' + missing.join(', ') + '. Run setup() to add them.');
  }
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var obj = {};
    for (var c = 0; c < headers.length; c++) obj[headers[c]] = values[i][c];
    rows.push({ rowIndex: i + 1, values: obj });
  }
  return { sheet: sheet, headers: headers, rows: rows };
}

/** Guards ID-based event actions: the row must still hold the ceremony the admin was looking at. */
function assertSameEvent_(row, expectedTitle) {
  if (expectedTitle == null || String(expectedTitle).trim() === '') return;
  if (String(row.values.Title || '').trim() !== String(expectedTitle).trim()) {
    throw new AppError('CONFLICT', 'The schedule changed since you opened it. Please refresh and try again.');
  }
}

/**
 * IDs to shift after deleting `deleted`: every row below it whose ID is "<prefix><n>" with
 * n greater than the deleted number moves to n-1. If any shift would collide with an ID that
 * stays (a hand-edited, out-of-order sheet), nothing is renumbered — deleting stays safe.
 */
function planEventRenumber_(table, deleted) {
  var m = /^(\D*)(\d+)$/.exec(String(deleted.values.EventID).trim());
  if (!m) return [];
  var prefix = m[1];
  var gone = Number(m[2]);
  var changes = [];
  var staying = {};
  table.rows.forEach(function (r) {
    if (r === deleted) return;
    var id = String(r.values.EventID == null ? '' : r.values.EventID).trim();
    if (!id) return;
    var n = /^(\D*)(\d+)$/.exec(id);
    if (r.rowIndex > deleted.rowIndex && n && n[1] === prefix && Number(n[2]) > gone) {
      changes.push({ row: r, from: id, to: prefix + (Number(n[2]) - 1) });
    } else {
      staying[id.toLowerCase()] = true;
    }
  });
  var targets = {};
  var clash = changes.some(function (c) {
    var key = c.to.toLowerCase();
    if (staying[key] || targets[key]) return true;
    targets[key] = true;
    return false;
  });
  return clash ? [] : changes;
}

/** Next free ID: highest trailing number + 1, keeping the prefix the sheet already uses (e.g. G7 → G8). */
function nextId_(table, column, defaultPrefix) {
  var max = 0;
  var prefix = defaultPrefix;
  var used = {};
  table.rows.forEach(function (r) {
    var id = String(r.values[column] == null ? '' : r.values[column]).trim();
    if (!id) return;
    used[id.toLowerCase()] = true;
    var m = /^(\D*)(\d+)$/.exec(id);
    if (!m) return;
    if (Number(m[2]) >= max) { max = Number(m[2]); prefix = m[1]; }
  });
  var next = max + 1;
  while (used[(prefix + next).toLowerCase()]) next += 1;
  return prefix + next;
}

/** Appends one row laid out by the sheet's own header order; unknown/extra columns stay blank. */
function appendRecord_(table, record) {
  var row = table.headers.map(function (h) {
    return Object.prototype.hasOwnProperty.call(record, h) && record[h] != null ? record[h] : '';
  });
  table.sheet.appendRow(row.map(safeCell_));
}

function findRow_(table, column, key) {
  var target = String(key).trim();
  for (var i = 0; i < table.rows.length; i++) {
    if (String(table.rows[i].values[column]).trim() === target) return table.rows[i];
  }
  return null;
}

function setCell_(table, row, column, value) {
  var col = table.headers.indexOf(column) + 1;
  if (col < 1) throw new AppError('CONFIG', 'Sheet column "' + column + '" not found. Run setup().');
  table.sheet.getRange(row.rowIndex, col).setValue(safeCell_(value));
  row.values[column] = value;
}

function canonicalHeader_(h, known) {
  var s = String(h == null ? '' : h).trim();
  var lower = s.toLowerCase().split(/\s+/).join('');
  for (var i = 0; i < known.length; i++) {
    if (known[i].toLowerCase() === lower) return known[i];
  }
  return s;
}

/**
 * Non-destructive schema upgrade: appends any of `columns` that are missing
 * after the sheet's last used column. Never renames, reorders or clears
 * anything. Returns the list of columns that were added.
 */
function ensureColumns_(name, columns) {
  var sheet = getSheet_(name);
  var lastCol = sheet.getLastColumn();
  var known = (HEADERS[name] || []).concat(OPTIONAL_HEADERS[name] || []);
  var present = lastCol ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return canonicalHeader_(h, known); }) : [];
  var added = [];
  columns.forEach(function (c) {
    if (present.indexOf(c) >= 0) return;
    lastCol += 1;
    sheet.getRange(1, lastCol).setValue(c);
    present.push(c);
    added.push(c);
  });
  return added;
}

/** Writes defaults into BLANK cells only, for rows that have a key value. Returns cells filled. */
function backfillDefaults_(name) {
  var spec = BACKFILL[name];
  if (!spec) return 0;
  var table = readTable_(name);
  var filled = 0;
  Object.keys(spec.values).forEach(function (column) {
    var col = table.headers.indexOf(column);
    if (col < 0) return;
    table.rows.forEach(function (r) {
      var v = r.values[column];
      var hasKey = String(r.values[spec.key] == null ? '' : r.values[spec.key]).trim() !== '';
      if (hasKey && String(v == null ? '' : v).trim() === '') {
        // Cell-by-cell on purpose: rewriting a whole column would flatten formulas.
        table.sheet.getRange(r.rowIndex, col + 1).setValue(spec.values[column]);
        filled += 1;
      }
    });
  });
  return filled;
}

/* ----------------------------------------------------------------------------
 *  Utilities
 * ------------------------------------------------------------------------- */

function AppError(code, message) {
  this.name = 'AppError';
  this.code = code;
  this.message = message;
}
AppError.prototype = Object.create(Error.prototype);

function parseRequest_(e) {
  if (!e || !e.postData || !e.postData.contents) throw new AppError('BAD_REQUEST', 'Empty request body.');
  if (e.postData.contents.length > MAX_BODY_BYTES) throw new AppError('BAD_REQUEST', 'Request too large.');
  var req = safeJson_(e.postData.contents);
  if (!req || typeof req !== 'object' || Array.isArray(req)) throw new AppError('BAD_REQUEST', 'Body must be a JSON object.');
  if (typeof req.action !== 'string' || !/^[A-Za-z]{1,40}$/.test(req.action)) throw new AppError('BAD_REQUEST', 'Missing or invalid "action".');
  if (req.payload != null && (typeof req.payload !== 'object' || Array.isArray(req.payload))) {
    throw new AppError('BAD_REQUEST', '"payload" must be an object.');
  }
  return req;
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function errorOut_(err) {
  var known = err instanceof AppError;
  if (!known) console.error(err && err.stack || err);
  return jsonOut_({
    ok: false,
    code: known ? err.code : 'SERVER_ERROR',
    error: known ? err.message : 'Unexpected server error. Please try again.',
  });
}

function getProp_(key, required) {
  var value = PropertiesService.getScriptProperties().getProperty(key);
  if (required && !value) throw new AppError('CONFIG', 'Script property "' + key + '" is not set.');
  return value || '';
}

function requireString_(value, field, maxLength) {
  if (value != null && typeof value !== 'string' && typeof value !== 'number') {
    throw new AppError('BAD_REQUEST', '"' + field + '" must be text.');
  }
  var s = value == null ? '' : String(value).trim();
  if (!s) throw new AppError('BAD_REQUEST', '"' + field + '" is required.');
  if (s.length > (maxLength || MAX_FIELD_LEN)) throw new AppError('BAD_REQUEST', '"' + field + '" is too long.');
  return s;
}

/** Strict for new entries; `existing` relaxes the pattern so legacy rows can still be edited/removed. */
function requireEmail_(value, existing) {
  if (typeof value !== 'string') throw new AppError('BAD_REQUEST', 'Please provide a valid email address.');
  var email = normalizeEmail_(value);
  var ok = email.length <= MAX_EMAIL_LEN && (existing ? email.indexOf('@') > 0 : EMAIL_RE.test(email));
  if (!ok) throw new AppError('BAD_REQUEST', 'Please provide a valid email address.');
  return email;
}

/** Neutralise spreadsheet formula / CSV injection for any user-influenced string. */
function safeCell_(value) {
  if (typeof value !== 'string') return value;
  return /^[=+\-@\t\r]/.test(value) ? "'" + value : value;
}

function appendSafe_(sheetName, values) {
  getSheet_(sheetName).appendRow(values.map(safeCell_));
}

function optionalString_(value, field) {
  return value == null || String(value).trim() === '' ? '' : requireString_(value, field);
}

// Google Maps https links only: these become hrefs in the app, so nothing else (javascript:, other sites) is allowed.
var MAPS_URL_RE = /^https:\/\/(?:(?:www\.|maps\.)?google\.[a-z.]{2,6}\/maps|maps\.google\.[a-z.]{2,6}\/|maps\.app\.goo\.gl\/|goo\.gl\/maps\/)[^\s"'<>]*$/i;
var MAX_MAP_LINK_LENGTH = 500;

function isMapsUrl_(url) {
  return typeof url === 'string' && url.length <= MAX_MAP_LINK_LENGTH && MAPS_URL_RE.test(url);
}

function optionalMapLink_(value) {
  var url = value == null ? '' : String(value).trim();
  if (!url) return '';
  if (!isMapsUrl_(url)) {
    throw new AppError('BAD_REQUEST', '"mapLink" must be a Google Maps link (https://maps.app.goo.gl/… or https://www.google.com/maps/…).');
  }
  return url;
}

function optionalCount_(value, field) {
  if (value == null || String(value).trim() === '') return '';
  var n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_GUESTS_PER_PARTY) {
    throw new AppError('BAD_REQUEST', '"' + field + '" must be a whole number between 1 and ' + MAX_GUESTS_PER_PARTY + '.');
  }
  return n;
}

/** Accepts the browser's datetime-local value (yyyy-MM-ddTHH:mm) in the spreadsheet's time zone. */
function optionalDateTime_(value, field) {
  if (value == null || String(value).trim() === '') return '';
  var s = String(value).trim();
  if (!DATETIME_INPUT_RE.test(s)) throw new AppError('BAD_REQUEST', '"' + field + '" must be a date and time.');
  var d = Utilities.parseDate(s, tz_(), "yyyy-MM-dd'T'HH:mm");
  if (!d || isNaN(d.getTime())) throw new AppError('BAD_REQUEST', '"' + field + '" must be a date and time.');
  return d;
}

function requireOneOf_(value, allowed, field) {
  var s = requireString_(value, field);
  if (allowed.indexOf(s) < 0) throw new AppError('BAD_REQUEST', '"' + field + '" must be one of: ' + allowed.join(', '));
  return s;
}

function normalizeEmail_(email) {
  return String(email || '').trim().toLowerCase();
}

function safeJson_(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

function sha256_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); })
    .join('');
}

function tz_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || Session.getScriptTimeZone();
}

function formatDay_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'EEE, MMM d');
  return String(v == null ? '' : v).trim();
}

function formatTime_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'h:mm a');
  return String(v == null ? '' : v).trim();
}

function formatDateTime_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), "yyyy-MM-dd'T'HH:mm:ssXXX");
  return String(v == null ? '' : v).trim();
}

/* ----------------------------------------------------------------------------
 *  One-time setup & diagnostics (run manually from the Apps Script editor)
 * ------------------------------------------------------------------------- */

/**
 * Safe to run any number of times (idempotent) on a brand-new OR an existing workbook:
 *   - Missing tab            → created with headers.
 *   - Existing empty tab     → headers written in row 1.
 *   - Existing tab with data → NEVER renamed, cleared, reordered or overwritten.
 *     Missing columns are appended to the right of the last used column.
 *     Headers match case/space-insensitively ("pickup status" = "PickupStatus").
 *   - Backfill               → defaults are written only into BLANK cells of rows
 *     that have a key (EventID / ID / Email). Filled cells are left untouched.
 *   - Members empty          → legacy "Admins" tab migrated, then you are seeded as Admin.
 *   - Extra tabs/columns you added yourself are ignored and preserved.
 * Every change is summarised in the execution log and in AuditLog (category "Schema").
 */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var report = [];
  Object.keys(HEADERS).forEach(function (name) {
    var wanted = HEADERS[name].concat(OPTIONAL_HEADERS[name] || []);
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      report.push('created tab ' + name);
    }
    if (sheet.getLastRow() === 0 && sheet.getLastColumn() === 0) {
      sheet.getRange(1, 1, 1, wanted.length).setValues([wanted]).setFontWeight('bold');
      sheet.setFrozenRows(1);
      report.push('wrote headers on ' + name);
    } else {
      var added = ensureColumns_(name, wanted);
      if (added.length) report.push(name + ': added columns ' + added.join(', '));
    }
  });

  var me = normalizeEmail_(Session.getEffectiveUser().getEmail());
  if (readMembers_().length === 0) {
    var legacy = ss.getSheetByName(SHEETS.LEGACY_ADMINS);
    var migrated = [];
    if (legacy && legacy.getLastRow() > 1) {
      legacy.getRange(2, 1, legacy.getLastRow() - 1, 3).getValues().forEach(function (r) {
        var email = normalizeEmail_(r[0]);
        if (email && migrated.indexOf(email) < 0) {
          appendSafe_(SHEETS.MEMBERS, [email, ROLES.ADMIN, r[1] || 'migration', r[2] || new Date()]);
          migrated.push(email);
        }
      });
    }
    if (migrated.length) {
      writeAudit_(me, AUDIT_CATEGORY.ADMIN, 'Migrated ' + migrated.length + ' admin(s) from legacy "Admins" tab to Members');
    }
    if (me && migrated.indexOf(me) < 0) {
      appendSafe_(SHEETS.MEMBERS, [me, ROLES.ADMIN, 'setup()', new Date()]);
      writeAudit_(me, AUDIT_CATEGORY.ADMIN, 'Bootstrap: added ' + me + ' to Members as Admin via setup()');
    }
  }

  // Legacy "Viewer" stays valid so existing cells are not flagged (run migrateViewerToAtithi() to relabel them).
  applyListValidation_(SHEETS.MEMBERS, 'Role', ROLE_LIST.concat(LEGACY_GUEST_ROLES));
  applyListValidation_(SHEETS.MEMBERS, 'TourStatus', TOUR_STATUSES);
  applyListValidation_(SHEETS.ITINERARY, 'Status', EVENT_STATUSES);
  applyListValidation_(SHEETS.LOGISTICS, 'PickupStatus', PICKUP_STATUSES);
  applyListValidation_(SHEETS.LOGISTICS, 'DropStatus', DROP_STATUSES);

  Object.keys(BACKFILL).forEach(function (name) {
    var n = backfillDefaults_(name);
    if (n) report.push(name + ': backfilled ' + n + ' blank cell(s) with defaults');
  });

  var seededGroups = seedGroupCatalog_();
  if (seededGroups) report.push('Groups: seeded ' + seededGroups + ' label(s) from existing assignments');

  if (!getProp_('PUSH_ID_SECRET', false)) {
    pushSecret_();
    report.push('created Script Property PUSH_ID_SECRET (group-targeted push)');
  }

  var summary = report.length ? 'Schema check: ' + report.join('; ') : 'Schema check: no changes needed';
  if (report.length) writeAudit_(me, AUDIT_CATEGORY.SCHEMA, summary);
  console.log(summary);
  return summary;
}

function applyListValidation_(sheetName, column, values) {
  var table = readTable_(sheetName);
  var col = table.headers.indexOf(column) + 1;
  if (col < 1 || table.sheet.getMaxRows() < 2) return;
  // allowInvalid=true: legacy values outside the list are flagged, never rejected or rewritten.
  var rule = SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(true).build();
  table.sheet.getRange(2, col, table.sheet.getMaxRows() - 1, 1).setDataValidation(rule);
}

/**
 * OPTIONAL, run manually: relabels legacy "Viewer" role cells as "Atithi".
 * Only the Role cell of matching rows changes (no rows/columns are moved or
 * removed) and the change is written to AuditLog. The app works without it.
 */
function migrateViewerToAtithi() {
  var table = readTable_(SHEETS.MEMBERS);
  var changed = 0;
  table.rows.forEach(function (r) {
    if (isLegacyGuestRole_(r.values.Role)) {
      setCell_(table, r, 'Role', ROLES.ATITHI);
      changed += 1;
    }
  });
  var me = normalizeEmail_(Session.getEffectiveUser().getEmail());
  if (changed) writeAudit_(me, AUDIT_CATEGORY.SCHEMA, 'Relabelled ' + changed + ' legacy "Viewer" role(s) as "Atithi"');
  console.log('Relabelled ' + changed + ' role cell(s).');
  return changed;
}

/** Sends a test push to current Members to validate OneSignal identity/subscription configuration. */
function testPush() {
  var result = sendLivePush_({ title: 'Test notification', location: 'Main Hall', time: 'now' });
  console.log(JSON.stringify(result));
}
