# Admin Broadcast — Database Specification

## Entity relationship

```text
Members (Email, Role, Groups) ── audience targeting ──> Notifications
        │                                               (announcement history)
        └──────── group label references ─────────────> Groups

Authenticated Admin ── records mutation ──────────────> AuditLog
```

## Existing tables used

| Sheet | Existing columns used | Purpose |
|---|---|---|
| `Members` | `Email`, `Role`, `Groups` | Re-check Admin permission and find current group members |
| `Groups` | `Label`, `Status` | Validate selected labels are active |
| `Notifications` | `Timestamp`, `Title`, `Message`, `EventID`, `Groups`, `SentBy`, `PushStatus` | Shared announcement history; broadcast `EventID` is blank |
| `AuditLog` | `Timestamp`, `UserEmail`, `ActionCategory`, `Details` | Record authenticated actor, server timestamp, audience and action outcome |

## Migration plan

No sheet migration is needed. Reuse existing readers/writers, `safeCell_` protections, and the established `Notifications` headers. Do not rename, reorder, or delete existing tabs, headers, or rows.

## API-to-database mapping

| API field | Storage |
|---|---|
| `payload.title` | `Notifications.Title` |
| `payload.body` | `Notifications.Message` (max 500 characters) |
| `payload.groups` | `Notifications.Groups` as comma-separated canonical catalog labels |
| Authenticated admin | `Notifications.SentBy`, `AuditLog.UserEmail` |
| Server timestamp | `Notifications.Timestamp`, `AuditLog.Timestamp` |
| OneSignal delivery outcome | `Notifications.PushStatus`, `AuditLog.Details` |
