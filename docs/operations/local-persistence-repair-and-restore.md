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

The daemon master key that wraps every session's content key and seals every daemon private key has a deliberately narrow custody model (see [Spec-020 §Daemon Master Key](../specs/020-data-retention-and-gdpr.md#daemon-master-key)). This creates backup constraints that diverge from normal database-backup hygiene.

**Separation rule**:

- The plaintext daemon master key is never present in any backup. It lives only in `sodium_mlock`-locked memory while the service runs ([Spec-020 §Daemon Master Key](../specs/020-data-retention-and-gdpr.md#daemon-master-key)).
- The app's own backups never carry the master key's day-to-day custody — its hardware wrap, its keychain entry or its passphrase file `daemon-master.<key id>.enc`. Once the person sets `Recovery passphrase` on Settings › Runtime, every backup after that carries the 98-byte envelope, which opens only with that passphrase.
- Backups the person makes with other tools: on macOS, exclude `~/Library/Keychains/` from Time Machine via `tmutil addexclusion`; on Linux with libsecret, exclude `~/.local/share/keyrings/` from home-directory backups. On Windows the entry's `CRED_PERSIST_LOCAL_MACHINE` keeps it out of File History and OneDrive Folder Backup.

**Restore recovery path (normal case)**:

- When a host is restored from an operating-system backup, the database may be present but the daemon master key is NOT recovered from it (per separation rule above): the key that opens the data day to day is bound to the machine that made it.
- Restore the app's own backup instead: `Restore…` on Settings › Runtime, or `sidekicks db restore <backup>` on a machine with no app, refused while the service holds the data folder. On the machine that wrote it, the restore reads everything: a rotation keeps each replaced key `retired` in this machine's custody until the last backup sealed with it ages out.
- On another computer the restore finds the master key the backup was sealed with by the key id in the backup's manifest: on a Mac from the person's iCloud Keychain, when `Keep the backup key in iCloud Keychain` was on, with nothing asked; then with the recovery passphrase against the 98-byte envelope a backup carries once a passphrase was set, typed once in the restore's in-place confirm. Once the key is found, every backup in the folder sealed with it opens, those taken before the passphrase was set included ([Spec-013 §Backup Policy](../specs/013-persistence-recovery-and-replay.md#backup-policy)).

**Restore failure mode (crypto-shred preservation)**:

- If no recovery passphrase was set and no iCloud Keychain copy of the key exists, a backup made on another computer cannot be opened: `Restore…` reads `Made on <computer> without a recovery passphrase, so only that computer can open it.` and offers no `Restore`. The session content keys in `session_content_keys` remain ciphertext under a master that nothing on this machine can unwrap.
- **This is the correct crypto-shred outcome, not a recovery bug**. If `Erase all data` destroyed the original master on the machine that made it, no copy of it is left there: a backup taken earlier opens again only through the recovery passphrase, where a backup sealed with that key carries its envelope, and otherwise stays ciphertext. Do not attempt to "fix" this by extracting the master from any other location. There is no other location; the master was designed to live only where a valid credential can reach it.
- Operational signal: the daemon logs `daemon_master_key_unavailable` at startup. What follows is the person's decision — whether that data was meant to be gone — not a technical repair.
- If the machine that wrote the backups is still available, set a recovery passphrase there and let it take one more backup: that backup carries the envelope, and once the new machine finds the key through it, every backup sealed with the same key opens there too.

**Validation**:

- After a successful restore, `sidekicks daemon status` reads the service as running with its store open, which it reaches only once the master key has unwrapped, and a restored session opens with its history.

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
