# Local Persistence Repair And Restore

## Purpose

Repair or restore the Local Runtime Daemon SQLite store when the service's own repair at a start could not heal it, or when a session's history stays damaged after that repair.

The service heals first, on its own ([Spec-013 §Fallback Behavior](../specs/013-persistence-and-recovery.md#fallback-behavior)). It checks the file's structure at every start, beside its work after a clean stop or any other end of its last run, and before it takes any write on a file something else changed since a clean stop or one with no record of the last run; damage that check or any read or write meets stops the service, and its next start repairs the file before it opens it: a damaged file is copied aside untouched into a folder under `~/.ai-sidekicks/damaged/` with its write-ahead log, recovered into a fresh file with SQLite's own recovery (`sqlite3_recover`) and checked with `PRAGMA integrity_check` before it is used, a session the newest backup holds more events of taking them from that backup; a session whose events still cannot be read opens at its last good point, read-only, with `Continue from here` and `Delete session`, and only that session refuses writes. This runbook starts where that repair ends.

## Symptoms

- The service stops on its own, and its log reads `The database file is damaged: <reason>. The service stops; its next start repairs the file`; the next start then repairs it
- The service does not start, and its log reads `The database file is damaged and could not be repaired` with the reason and the folder its files were copied aside to
- The service reads `degraded` and takes writes unchecked, and its log reads `The database file could not be checked` with the reason (the service's own `sqlite3` shell is missing or damaged); its next start checks the file again before it writes
- The `recovery` field on `daemon.status.read` stays `blocked` because local persistence failed during the restart's recovery pass
- A session reads `degraded` (at its last good point) or `damaged` (no readable event) in that field's session list, and Settings › Runtime names it
- Local Runtime Daemon logs show SQLite open, lock, integrity, or WAL-related failure
- Projection rebuild fails before projections become queryable
- Scope and blast radius: the machine's daemon-owned canonical local store

## Detection

- Read `sidekicks daemon status` on the machine, whose `recovery` field (from `daemon.status.read`) states healthy, rebuilding, degraded or blocked, before mutating any files.
- Inspect Local Runtime Daemon logs for SQLite open failure, WAL replay failure, integrity error, or projection-rebuild failure.
- Confirm whether the failure is limited to one session's history or whether the canonical SQLite store itself is unreadable or corrupt: a start's check that passes logs `The database file's check found it sound`; damage logs `The database file is damaged`, and the repair at the next start then logs either `The database file was recovered` or `The database file could not be repaired` with the reason.

## Preconditions

- Access to the affected user machine and daemon-owned SQLite files
- Permission to stop the Local Runtime Daemon
- Access to the most recent known-good backup, where the person turned backups on: `Back up automatically` on Settings › Runtime is off by default ([Spec-013 §Backup Policy](../specs/013-persistence-and-recovery.md#backup-policy)). While it is on, 7 daily and 4 weekly database copies and one mirror of the session files are kept in `~/.ai-sidekicks/backups` or the folder the person picked (on a Windows computer whose service runs in WSL 2, the Windows home's `.ai-sidekicks\backups`), and a restore is at most 25 hours stale.

### Backup Constraints

A backup is a plain copy of what it lists — the service's database, copied online; the machine's settings file; each chat session's workspace; each kept session's file checkpoint copies; each kept session's conversation files in every account home it ran in; and the agent memory folder ([Spec-013 §Backup Policy](../specs/013-persistence-and-recovery.md#backup-policy)) — and holds no credential. The daemon keeps each secret as its own item in the operating system's credential store, never in its database or in a backup.

**Restore**:

- Restore the app's own backup: `Restore…` on Settings › Runtime, or `sidekicks db restore <backup>` on a machine with no app, refused while the service holds the data folder. Restoring on the machine that wrote it needs nothing more.
- A restore on another computer reads the backup directly; the person then signs in to providers and links devices again ([Spec-013 §Backup Policy](../specs/013-persistence-and-recovery.md#backup-policy)). A Windows computer is one machine whichever side runs its service, so a backup made on one side restores on the other as a same-machine restore.

**Validation**:

- After a successful restore, `sidekicks daemon status` reads the service as running with its store open, and a restored session opens with its history.

## Recovery Steps

1. For one damaged session, choose in the session: `Continue from here` makes the last good point the session's end so it takes new work again, the damaged events staying stored and skipped; `Delete session` removes the session. A session with no readable event offers `Delete session` only. Nothing else on the machine needs to stop.
2. For a service that does not start on a damaged file, or a store that stays `blocked`, stop the Local Runtime Daemon before modifying any SQLite, WAL, or SHM files. The service already copied the damaged files aside into a folder under `~/.ai-sidekicks/damaged/` before its repair; keep that folder. A file the repair failed on because the service's own `sqlite3` shell is missing or damaged — its log says the install is damaged — heals at the next start after the app is reinstalled, which restores the shell.
3. Start the service and read `sidekicks daemon status`: the service checks the file's structure at every start, and a file it found damaged is repaired at the start after, before it opens it; a start on a file it could not repair fails with the reason in its log. A store is structurally healthy once its log says the check found it sound.
4. If integrity is healthy, restart the daemon: every session's projections rebuild from canonical events, so the database is not replaced.
5. If the repair failed, restore the latest backup with `sidekicks db restore <backup>` (or `Restore…` on Settings › Runtime) from the backup folder — `~/.ai-sidekicks/backups` by default, or the folder the person picked — per [Spec-013 §Backup Policy](../specs/013-persistence-and-recovery.md#backup-policy); the restore replaces the database, the settings file, the workspaces, the checkpoint copies, the conversation files and the agent memory folder, starts the service again, and the projection rebuild runs.
6. If integrity fails AND there is no backup — backups are off until the person turns them on ([Spec-013 §Backup Policy](../specs/013-persistence-and-recovery.md#backup-policy)) — or the backup folder is itself unreadable, preserve the broken files for later analysis, keep new mutable work blocked, and escalate rather than creating a fresh empty database.

## Validation

- The `recovery` field on `daemon.status.read` moves out of `blocked` and the projection rebuild completes
- A session continued from its last good point leaves the field's session list and takes a new message
- Session projections become queryable again through the typed client SDK or CLI
- One affected session can be rebuilt from canonical events without missing history or duplicate side effects

## Escalation

- Escalate when the service's repair fails and no viable backup exists, restore does not unblock the rebuild, or repaired storage diverges again immediately after restart: the store is reported to the project as a bug, with the daemon's logs and the preserved broken files attached.
- The machine belongs to one person, who runs this procedure on it; there is no paging, no chat alert and no on-call rotation.

## CLI Commands

```bash
sidekicks db restore <backup>
```

A backup is taken with `Back up now` on Settings › Runtime; the service's health is read with `sidekicks daemon status`.

## SLOs and Thresholds

| Metric | Target |
| --- | --- |
| The service's structural check, which holds writes only on a file something else changed or one with no record of the last run | < 3s at a million messages; about 2 minutes at ten million, 140 s at worst on an M1 Pro |
| The service's repair of a damaged store | < 60s at a million messages, 28 s on an M1 Pro; about 8 minutes at ten million, 473 s on an M1 Pro at a load average of 18.4 at its start. The minute cannot hold ten million: reading the damaged file alone takes 125 s, the steps that ready the fresh file, the full integrity check it must pass among them, took 137 s, and the fresh file's unique index on a session and its sequence outgrows the writing shell's cache. That cache, a sixth of the file, took the writing shell to 2.24 GiB at ten million; it is a child process's memory, released when the repair ends, and the daemon's 256 MB operating target covers the daemon alone |
| Backup restore | < 60s |
| Projection rebuild after restore | < 120s |

## Related Architecture Docs

- [Data Architecture](../architecture/data-architecture.md)
- [Daemon Architecture](../architecture/daemon.md)
- [Observability Architecture](../architecture/observability-architecture.md)

## Related Specs

- [Session Event Taxonomy And Audit Log](../specs/005-session-event-taxonomy-and-audit-log.md)
- [Persistence And Recovery](../specs/013-persistence-and-recovery.md)
- [Observability And Failure Recovery](../specs/018-observability-and-failure-recovery.md)

## Related Plans

- [Session Core](../plans/001-session-core.md)
- [Persistence And Recovery](../plans/012-persistence-and-recovery.md)
- [Observability And Failure Recovery](../plans/017-observability-and-failure-recovery.md)
