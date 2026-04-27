# Local Persistence Repair And Restore

## Purpose

Repair or restore the Local Runtime Daemon SQLite store when daemon startup, replay rebuild, or local mutation is blocked by persistence failure.

## Symptoms

- `RecoveryStatusRead` remains `blocked` because local persistence is unavailable
- Local Runtime Daemon logs show SQLite open, lock, integrity, or WAL-related failure
- Replay rebuild fails before projections become queryable
- Scope and blast radius: one participant node and the daemon-owned canonical local store for that node

## Detection

- Read `RecoveryStatusRead` and `FailureDetailRead` for the affected node before mutating any files.
- Inspect Local Runtime Daemon logs for SQLite open failure, WAL replay failure, integrity error, or projection-rebuild failure.
- Confirm whether the failure is limited to projection rebuild or whether the canonical SQLite store itself is unreadable or corrupt.

## Preconditions

- Access to the affected participant machine and daemon-owned SQLite files
- Permission to stop the Local Runtime Daemon
- Access to the most recent known-good local persistence backup (daily backups are always available per [Spec-015 §Backup Policy](../specs/015-persistence-recovery-and-replay.md#backup-policy) — 7-daily + 4-weekly retention; restore SLO ≤ 24h staleness)

### Backup Constraints

The daemon master key that wraps all `participant_keys.encrypted_key_blob` entries has a deliberately-narrow custody model (see [Spec-022 §Daemon Master Key](../specs/022-data-retention-and-gdpr.md#daemon-master-key)). This creates backup constraints that diverge from normal database-backup hygiene.

**Separation rule**:

- The plaintext daemon master key must never be present in any backup. It lives only in `sodium_mlock`-locked memory and is zeroed on shutdown or idle wipe.
- The wrapped master key blob (tier 1 OS keystore or tier 2 `$XDG_DATA_HOME/ai-sidekicks/daemon-master.enc`) must be excluded from any backup that also captures the SQLite event log. Capturing both together would re-introduce the master key into the backup-recoverable state space after a credential destruction, defeating crypto-shred.
- Operator responsibility:
  - macOS: `tmutil addexclusion ~/Library/Keychains` and `tmutil addexclusion "$HOME/Library/Application Support/ai-sidekicks/daemon-master.enc"`.
  - Linux: exclude `~/.local/share/keyrings/` (libsecret) and `$XDG_DATA_HOME/ai-sidekicks/daemon-master.enc` from the home-directory backup set.
  - Windows: set the daemon master credential to `CRED_PERSIST_LOCAL_MACHINE` (not `CRED_PERSIST_ENTERPRISE`) so it is not roamed by File History or OneDrive Folder Backup; exclude `%APPDATA%\ai-sidekicks\daemon-master.enc` from the same mechanisms.

**Restore recovery path (normal case)**:

- When a host is restored from backup, the `participant_keys` table is present but the daemon master key is NOT recovered from the backup (per separation rule above).
- The daemon at startup attempts to read the wrapped master blob from tier 1 (OS keystore). Because keystores are host-local and were not backed up, tier 1 read fails on a restored host.
- The daemon falls back to tier 2 (`$XDG_DATA_HOME/ai-sidekicks/daemon-master.enc`). Because this file was excluded from backup per the separation rule, tier 2 read also fails.
- The daemon prompts the participant for their credential (WebAuthn assertion or CLI passphrase). On first successful assertion, the daemon re-wraps the master under the restored credential and writes to tier 1 + tier 2. Normal operation resumes.
- Operator must transfer the wrapped master blob from the source host to the restored host via an out-of-band channel before the participant credential prompt can succeed. Typical channels: a fresh WebAuthn credential enrollment on the new host (for desktop), or a manual passphrase re-entry plus `daemon-master.enc` file copy (for CLI).

**Restore failure mode (crypto-shred preservation)**:

- If the source host is unavailable AND no out-of-band transfer of the wrapped master blob has occurred, the restored host cannot reconstitute the master key. The `participant_keys.encrypted_key_blob` entries remain ciphertext under a master that no credential can unwrap.
- **This is the correct crypto-shred outcome, not a recovery bug**. If the original master was rotated-and-destroyed due to a participant deletion, a backup restore must not resurrect the pre-rotation state. The on-call engineer MUST NOT attempt to "fix" this by extracting the master from any other location. There is no other location; the master was designed to live only where a valid credential can reach it.
- Operational signal: daemon logs `daemon_master_key_unavailable cause=restore_without_oob_transfer` at startup. On-call routes this to the Data Protection Officer, not to the SRE on-call, because the triage decision is policy (confirm crypto-shred was intended) not technical.
- If the source host IS available and the operator intended to preserve participant data across the restore, the operator re-enrolls the participant credential on the restored host AND copies `daemon-master.enc` from the source host. The daemon then re-wraps the master under the new credential and resumes.

**Validation**:

- After a successful restore, run `ai-sidekicks daemon diagnose master-key` to verify:
  - Tier 1 and tier 2 blobs are present and byte-identical.
  - The master key unwraps under the current credential.
  - A sample decrypt of one `participant_keys` row succeeds.

## Recovery Steps

1. Stop the Local Runtime Daemon before modifying any SQLite, WAL, or SHM files.
2. Create a timestamped backup copy of the current SQLite database, WAL, and SHM files before attempting repair or restore.
3. Run a SQLite integrity check against the copied database to determine whether the canonical local store is structurally healthy.
4. If integrity is healthy, restart the daemon and run `ProjectionRebuild` from canonical events instead of replacing the database.
5. If integrity fails, restore the last known-good SQLite, WAL, and SHM set from the backup tree at `$XDG_STATE_HOME/ai-sidekicks/backups/` (host) or the operator's bind-mounted backup path (container) per [Spec-015 §Backup Policy](../specs/015-persistence-recovery-and-replay.md#backup-policy), then restart the daemon and allow replay rebuild to run.
6. If integrity fails AND the backup tree is itself unreadable (catastrophic filesystem loss — not the normal case, since Spec-015 §Backup Policy guarantees daily backups by default), preserve the broken files for later analysis, keep new mutable work blocked, and escalate rather than creating a fresh empty database.

## Validation

- `RecoveryStatusRead` moves out of `blocked` and replay rebuild completes
- Session projections become queryable again through the typed client SDK or CLI
- One affected session can replay from canonical events without missing history or duplicate side effects

## Escalation

- Escalate when integrity check fails and no viable backup exists, restore does not unblock replay, or repaired storage diverges again immediately after restart

## CLI Commands

```bash
sidekicks db status
sidekicks db integrity-check
sidekicks db backup --output <path>
sidekicks db restore --from <path>
sidekicks db wal-status
sidekicks db vacuum
```

## SLOs and Thresholds

| Metric                           | Target |
| -------------------------------- | ------ |
| SQLite integrity check           | < 30s  |
| Backup restore                   | < 60s  |
| Projection rebuild after restore | < 120s |
| WAL checkpoint latency           | < 5s   |

## On-Call Routing

- **Severity 1** (service down): Page on-call engineer immediately. Escalate to team lead after 15min.
- **Severity 2** (degraded): Alert on-call via Slack. Investigate within 30min.
- **Severity 3** (warning): Log alert. Review during business hours.
- **Domain routing**: Local persistence issues route to **platform on-call**.

## Related Architecture Docs

- [Data Architecture](../architecture/data-architecture.md)
- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Observability Architecture](../architecture/observability-architecture.md)

## Related Specs

- [Session Event Taxonomy And Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md)
- [Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md)
- [Observability And Failure Recovery](../specs/020-observability-and-failure-recovery.md)

## Related Plans

- [Shared Session Core](../plans/001-shared-session-core.md)
- [Persistence Recovery And Replay](../plans/015-persistence-recovery-and-replay.md)
- [Observability And Failure Recovery](../plans/020-observability-and-failure-recovery.md)
