# Admin Broadcast

## Purpose

Allow an authenticated Admin to compose a standalone announcement, send it to all current members or one or more groups, and optionally prepare the same title/body in WhatsApp.

## URL

Single-page app state: `?` (the `broadcast` bottom-navigation tab; no new route).

## Wireframe

```text
┌──────────────────────────────────┐
│ Event PWA header                  │
├──────────────────────────────────┤
│ Host console / Broadcast          │
│ Send an announcement unrelated   │
│ to a specific ceremony.           │
│                                  │
│ Title [_______________________]  │
│ Message body                     │
│ [_____________________________]  │
│ [_____________________________]  │
│                                  │
│ Audience groups (optional)        │
│ [ ] Group A  [ ] Group B          │
│ No selection means everyone.     │
│                                  │
│ [Broadcast] [Broadcast + WhatsApp]│
│ Status / request error            │
└──────────────────────────────────┘
```

## Components

| Component | Description | Data Needed |
|---|---|---|
| Broadcast navigation item | Visible only to Admins; selects `broadcast` tab | Current authenticated role |
| Title input | Required, at most 200 characters | Admin-entered text |
| Body textarea | Required, at most 500 characters | Admin-entered text |
| Audience group picker | Multi-select active catalog labels; no selection means everyone | `session.groupCatalog` |
| Broadcast button | Sends title/body/audience without opening WhatsApp | Form fields; action `push` result |
| Broadcast + WhatsApp button | Sends the same broadcast and opens WhatsApp with bold title and body; no group labels | Form fields; action result |
| Admin tour step | Explains audience controls and WhatsApp option without submitting | Existing Admin tour sequence |

## State matrix

| State | Condition | What User Sees |
|---|---|---|
| Loading | Existing app session sync | Existing shell/loading UI |
| Empty | No active groups | Composer remains usable; explanatory all-members audience text |
| Error | Invalid form or backend rejects request | Accessible error/toast; no false success state; WhatsApp popup closed |
| Sending | Broadcast action pending | Initiating button disabled with accessible spinner; duplicate sends prevented |
| Push failed | Backend accepted and logged announcement, OneSignal failed | Admin sees delivery failure feedback; WhatsApp variant still opens WhatsApp |
| Populated | Valid form | Title/body and selected audience remain available until success feedback |

## User interactions

| Action | Trigger | Result | API Call |
|---|---|---|---|
| Choose groups | Toggle group checkbox | Audience selection updates; no groups means all | None |
| Broadcast | Click Broadcast | Server sends push, logs announcement, and audits it | `broadcastNotification` |
| Broadcast + WhatsApp | Click combined button | Open temporary window immediately; send broadcast; navigate window to WhatsApp after server accepts, even if push delivery fails | `broadcastNotification` |
| Explore broadcast in tour | Advance Admin tour | Tour switches to Broadcast and highlights the overview without activating controls | None |

## Data requirements

| UI Element | API Endpoint | Response Field |
|---|---|---|
| Active group picker | `session` | `data.groupCatalog` filtered to `status === "Active"` |
| Delivery outcome feedback | `broadcastNotification` | `data.push.ok`, optional admin-only `data.push.error` |
| Newly logged announcement | `broadcastNotification` | `data.notifications` (admin history) |
