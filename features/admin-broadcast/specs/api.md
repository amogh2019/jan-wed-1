# Admin Broadcast — API Specification

## Base path and authentication

The app uses the existing Google Apps Script web-app `doPost` JSON endpoint; this feature adds no URL or deployment. The request carries the existing Google ID token. Apps Script verifies the token, loads the caller's current Members role, and permits this action only for Admins. Never use client-supplied email or role for authorization or audit identity.

## Action contract

### `broadcastNotification` — admin only

**Request envelope:**

```json
{
  "action": "broadcastNotification",
  "idToken": "<Google ID token>",
  "userEmail": "<existing client identity field; server verifies against token>",
  "timestamp": "<client ISO timestamp; server time remains authoritative>",
  "payload": {
    "title": "Schedule update",
    "body": "Meet at the east gate.",
    "groups": ["Bride side", "Family"]
  }
}
```

`groups` must be an array of active catalog labels. An empty array means all current members. Multiple labels use any-match semantics and target the union of member device identities.

**Validation:**

| Field | Rules |
|---|---|
| `title` | Required non-blank string; maximum 200 characters |
| `body` | Required non-blank string; maximum 500 characters |
| `groups` | Required array; up to the existing maximum of 10 active catalog labels, each matched case-insensitively and normalized to catalog spelling |

**Success response:**

```json
{
  "ok": true,
  "data": {
    "push": { "attempted": true, "ok": true, "id": "<optional OneSignal id>" },
    "notifications": [
      {
        "id": "<sheet row>",
        "at": "<ISO timestamp>",
        "title": "Schedule update",
        "message": "Meet at the east gate.",
        "eventId": "",
        "groups": ["Bride side", "Family"],
        "sentBy": "<authenticated admin email>",
        "pushStatus": "Sent"
      }
    ]
  }
}
```

The server returns the refreshed admin notification history after logging. A OneSignal failure is still a successful action response when the announcement and audit record were saved; `push.ok` is false with admin-only diagnostic text, and the Notifications row has a failed push status.

**Errors:**

| Code | Meaning |
|---|---|
| `AUTH_REQUIRED` / `AUTH_INVALID` / `AUTH_EXPIRED` | Missing or invalid Google credential |
| `NOT_MEMBER` | Authenticated account is not in Members |
| `FORBIDDEN` | Caller is not an Admin |
| `BAD_REQUEST` | Missing/invalid/oversized message or unknown/inactive group |
| `BUSY` | Script lock unavailable; retry through the normal UI error state |

## UI/API contract

| UI Element | API Field | Notes |
|---|---|---|
| Title input | `payload.title` | Sent without rewriting |
| Body textarea | `payload.body` | Same text is used for push and WhatsApp |
| Group picker | `payload.groups` | Empty array = all current members |
| Admin delivery feedback | `data.push.ok`, `data.push.error` | Diagnostics visible only on admin screen |
| Admin history update | `data.notifications` | Refreshed admin-only history projection |

No new response is exposed to guests. Their existing `session` response continues to audience-filter announcements and omit `sentBy` / `pushStatus`.
