# Local Persistence Repair And Restore

## Purpose

Repair or restore the Local Runtime Daemon SQLite store when daemon startup, replay rebuild, or local mutation is blocked by persistence failure.

## Symptoms

- `RecoveryStatusRead` remains `blocked` because local persistence is unavailable
- Local Runtime Daemon logs show SQLite open, lock, integrity, or WAL-related failure
- Replay rebuild fails before projections become queryable
- Scope and blast radius: the machine's daemon-owned canonical local store

## Detection

- Read `RecoveryStatusRead` and `sidekicks daemon status` on the machine before mutating any files.
- Inspect Local Runtime Daemon logs for SQLite open failure, WAL replay failure, integrity error, or projection-rebuild failure.
- Confirm whether the failure is limited to projection rebuild or whether the canonical SQLite store itself is unreadable or corrupt.

## Preconditions

- Access to the affected user machine and daemon-owned SQLite files
- Permission to stop the Local Runtime Daemon
- Access to the most recent known-good backup, where the person turned backups on: `Back up automatically` on Settings › Runtime is off by default ([Spec-013 §Backup Policy](../specs/013-persistence-recovery-and-replay.md#backup-policy)). While it is on, 7 daily and 4 weekly database copies and one mirror of the session files are kept in `~/.ai-sidekicks/backups` or the folder the person picked (on a Windows computer whose service runs in WSL 2, the Windows home's `.ai-sidekicks\backups`), and a restore is at most 25 hours stale.

### Backup Constraints

A backup is a plain copy of what it lists — the service's database, copied online; the machine's settings file; each chat session's workspace; each kept session's file checkpoint copies; each kept session's conversation files in every account home it ran in; and the agent memory folder ([Spec-013 §Backup Policy](../specs/013-persistence-recovery-and-replay.md#backup-policy)) — and holds no credential. The daemon keeps each secret as its own item in the operating system's credential store, never in its database or in a backup.

**Restore**:

- Restore the app's own backup: `Restore…` on Settings › Runtime, or `sidekicks db restore <backup>` on a machine with no app, refused while the service holds the data folder. Restoring on the machine that wrote it needs nothing more.
- A restore on another computer reads the backup directly; the person then signs in to providers and links devices again ([Spec-013 §Backup Policy](../specs/013-persistence-recovery-and-replay.md#backup-policy)). A Windows computer is one machine whichever side runs its service, so a backup made on one side restores on the other as a same-machine restore.

**Validation**:

- After a successful restore, `sidekicks daemon status` reads the service as running with its store open, and a restored session opens with its history.

## Recovery Steps

1. Stop the Local Runtime Daemon before modifying any SQLite, WAL, or SHM files.
2. Create a timestamped backup copy of the current SQLite database, WAL, and SHM files before attempting repair or restore.
3. Start the service and read `sidekicks daemon status`: the service checks its store's integrity when it opens it and refuses to open a damaged one, and the status names that refusal. A store it opens is structurally healthy.
4. If integrity is healthy, restart the daemon and run `ProjectionRebuild` from canonical events instead of replacing the database.
5. If integrity fails, restore the latest backup with `sidekicks db restore <backup>` (or `Restore…` on Settings › Runtime) from the backup folder — `~/.ai-sidekicks/backups` by default, or the folder the person picked — per [Spec-013 §Backup Policy](../specs/013-persistence-recovery-and-replay.md#backup-policy); the restore replaces the database, the settings file, the workspaces, the checkpoint copies, the conversation files and the agent memory folder, starts the service again, and replay rebuild runs.
6. If integrity fails AND there is no backup — backups are off until the person turns them on ([Spec-013 §Backup Policy](../specs/013-persistence-recovery-and-replay.md#backup-policy)) — or the backup folder is itself unreadable, preserve the broken files for later analysis, keep new mutable work blocked, and escalate rather than creating a fresh empty database.

## Validation

- `RecoveryStatusRead` moves out of `blocked` and replay rebuild completes
- Session projections become queryable again through the typed client SDK or CLI
- One affected session can replay from canonical events without missing history or duplicate side effects

## Escalation

- Escalate when integrity check fails and no viable backup exists, restore does not unblock replay, or repaired storage diverges again immediately after restart: the store is reported to the project as a bug, with the daemon's logs and the preserved broken files attached.
- The machine belongs to one person, who runs this procedure on it; there is no paging, no chat alert and no on-call rotation.

## CLI Commands

```bash
sidekicks db restore <backup>
```

A backup is taken with `Back up now` on Settings › Runtime; the service's health is read with `sidekicks daemon status`.

## SLOs and Thresholds

| Metric                                                | Target |
| ----------------------------------------------------- | ------ |
| The service's integrity check when it opens the store | < 30s  |
| Backup restore                                        | < 60s  |
| Projection rebuild after restore                      | < 120s |

## Related Architecture Docs

- [Data Architecture](../architecture/data-architecture.md)
- [Daemon Architecture](../architecture/daemon.md)
- [Observability Architecture](../architecture/observability-architecture.md)

## Related Specs

- [Session Event Taxonomy And Audit Log](../specs/005-session-event-taxonomy-and-audit-log.md)
- [Persistence Recovery And Replay](../specs/013-persistence-recovery-and-replay.md)
- [Observability And Failure Recovery](../specs/018-observability-and-failure-recovery.md)

## Related Plans

- [Session Core](../plans/001-session-core.md)
- [Persistence Recovery And Replay](../plans/013-persistence-recovery-and-replay.md)
- [Observability And Failure Recovery](../plans/018-observability-and-failure-recovery.md)
