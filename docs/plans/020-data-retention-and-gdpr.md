# Plan-020: Data Retention, Export And Deletion

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `020` |
| **Slug** | `data-retention-and-gdpr` |
| **Date** | `2026-04-17` |
| **Author(s)** | `Claude Opus 4.7` |
| **Spec** | [Spec-020: Data Retention, Export And Deletion](../specs/020-data-retention-and-gdpr.md) |
| **Required ADRs** | [ADR-015: V1 Feature Scope Definition](../decisions/015-v1-feature-scope-definition.md); [ADR-021: Machine Identity Key Custody](../decisions/021-cli-identity-key-storage-custody.md) — the machine's identity key, which this plan's store keeps as a credential-store item; [ADR-039: Kept Sessions Keep Their Provider Files](../decisions/039-kept-sessions-keep-their-provider-files.md) — a kept session and its provider files stay until the person deletes them |
| **Dependencies** | Plan-001 (the daemon's one schema, whose session rows the purge deletes, and `ManagedWorkspaceService.delete`); Plan-005 (the append path the purge records `session.purged` through, CP-020-5); Plan-006 (the daemon JSON-RPC host for the data verbs; Phase R1 serves `daemon.retentionPurge`, whose erasure step this plan owns (CP-020-5); Phase R2 ships the `DaemonKeyStore` interface this plan's store implements (reciprocates CP-006-8); Phase R3 carries the command-line verbs (CP-020-9); Phase R4 is the service's Windows half that the credential store's Windows arm runs in (CP-020-8)); Plan-016 (**non-blocking** — Plan-016 Phase 5 builds `account.delete`, `account.export` and the token denylist, CP-020-6) |
| **Cross-Plan Deps** | Cross-Plan Dependency Graph |

## Goal

Ship the Spec-020 data acts and the daemon's secrets: every daemon secret is its own item in the operating system's credential store, and nothing in the daemon's database is encrypted by the app; the session purge deletes a session's rows with `secure_delete` on and checkpoints the write-ahead log with `TRUNCATE`, so no freed page and no log keeps a readable word of it; and the person can export everything the machine keeps and erase it, from Settings › Runtime and from the command line.

## Scope

- The daemon's secrets ([Spec-020 §Daemon Secrets](../specs/020-data-retention-and-gdpr.md#daemon-secrets)): each is its own item in the operating system's credential store through `@napi-rs/keyring` — the login keychain on macOS, Credential Manager on Windows, the Secret Service on Linux, opened explicitly with `{linux: {store: "secret-service"}}` so the kernel keyring, which is cleared at every restart, is never used. When no Secret Service answers, the daemon keeps its items in one file in its own data folder, readable only by the person (mode `0600`), as `gh` and Codex do, and never silently: the person can see where secrets are kept. On Windows, native and WSL alike, every item goes through the service's Windows half at `CRED_PERSIST_LOCAL_MACHINE` (CP-020-8), whichever unit keeps it. (`keytar` is archived/unmaintained and is not used.) Shipped behind Plan-006's `DaemonKeyStore` interface, reciprocating CP-006-8 (see [§Cross-Plan Obligations](#cross-plan-obligations)).
- The items this plan's store keeps: the machine's Remote Control identity key and its channel key, the hosted sign-in's refresh token and DPoP key. The units that own the others — a pasted provider token, a workflow secret, the notification web address and its signing secret, the mail password, each tool server sign-in's refresh token and DPoP key — keep them as items the same way.
- Nothing in the daemon's database is encrypted by the app: the person's messages, every queued message's body and a steer's text sit in plain columns, as `content_payload` does ([Spec-020 §Erasure In The Daemon's Database](../specs/020-data-retention-and-gdpr.md#erasure-in-the-daemons-database)).
- The data acts, as daemon JSON-RPC verbs over the contracts in `packages/contracts/src/daemon-data.ts`: `daemon.dataExport {destination}` with `daemon.dataExportSubscribe` (`Export all data`) and `daemon.dataErase {}` (`Erase all data`). Host is daemon-bound (data-locality); shape per D-020-3.
- The purge's erasure step: `daemon.retentionPurge` (Plan-006 Phase R1) deletes a session's rows in one transaction with `secure_delete` on, then checkpoints the write-ahead log with `TRUNCATE` (CP-020-5).

## Non-Goals

- **The retention bounds and `Delete old data`.** `daemon.retentionRead`, `daemon.retentionUpdate` and `daemon.retentionPurge` are Plan-006 Phase R1's, with the purge's capture folder, base pins and managed workspace; this plan owns only the purge's erasure step (CP-020-5). Nothing deletes a session by age: the service drops only the diagnostic logs on its own, past `Keep diagnostic logs for`, and that bound is not a switch. Background compaction never removes anything a person could see ([Spec-020 §Retention Policy](../specs/020-data-retention-and-gdpr.md#retention-policy)).
- **The provider's own files.** `"cleanupPeriodDays": 36500` in every Claude Code process and account home, the `settings_ignored` read-back, and the provider files a purge removes are Plan-004's and Plan-001's ([ADR-039](../decisions/039-kept-sessions-keep-their-provider-files.md)).
- **Deleting the hosted account.** `account.delete`, `account.export` and the token denylist are Plan-016 Phase 5's control-plane account work; this plan carries the Path-2 closure it must cover (CP-020-6).

## Preconditions

- ADR-015 V1 Feature Scope Definition places the data acts in the V1 scope.

## Target Areas

- `packages/runtime-daemon/src/crypto/` — **new subsystem directory created by this plan**: `keychain-entry.ts` (one credential-store item through `@napi-rs/keyring`, the Secret Service opened explicitly on Linux, and the one file when no Secret Service answers); `windows-credential-store.ts` (`WindowsCredentialStore`), which carries every call to the service's Windows half; `data-export.ts` and `data-erase.ts`
- `packages/runtime-daemon/src/bootstrap/daemon-key-store.ts` — Plan-006 T-006r-2-4 creates it in the `bootstrap/` composition root with the `DaemonKeyStore` interface; this plan adds the production store, which keeps each daemon secret as its own credential-store item through `keychain-entry.ts` and, on Windows, `WindowsCredentialStore`, reciprocating Plan-006 CP-006-8
- `packages/runtime-daemon/src/ipc/handlers/data-handlers.ts` — **created by this plan** in the shipped `ipc/handlers/` host: the data verbs registered on Plan-006's `MethodRegistry`, over the schemas in `packages/contracts/src/daemon-data.ts`
- Plan-006's retention handlers — **extended** with the purge's erasure step: `secure_delete` on for the delete of the session's rows, and the `TRUNCATE` checkpoint after commit
- `docs/architecture/contracts/api-payload-contracts.md` — kept in step with the data verbs this plan builds (T22.4.5)

## Data And Storage Changes

### PII Data Map

Per [Spec-020 §PII Data Map](../specs/020-data-retention-and-gdpr.md#pii-data-map), the PII the data acts reach sits in two durability tiers, and nothing is exported off the machine through telemetry. Plan-020 owns the erasure of the durable-tier SQLite side (below), the purge's erasure step and the erase; the Postgres side of the durable tier is owned plan-by-plan — Plan-016 (`users`, `webauthn_credentials`, `webauthn_challenges`) and Plan-028 (`devices`, `runtime_nodes`, `trust_statements`) — and deleted by Plan-016's `account.delete`; Plan-018 owns the bounded-retention tier, which drops past `Keep diagnostic logs for`. These tiers classify the user's **PII content** by where it lives; account deletion's **relational** obligation is a distinct, broader lens — the complete `REFERENCES users(id)` inbound-FK closure of CP-020-6, which additionally reaches the token denylist (`revoked_jtis`/`revoked_token_families`) that FK-links to the user without carrying a PII column.

**Durable tier** (Plan-020 owns the SQLite side; Plan-016's `account.delete` removes the Postgres side, CP-020-6):

| Table | Column | Owner Plan | Shred Path |
| --- | --- | --- | --- |
| `session_events` (SQLite) | `payload` | Plan-005 write path; the daemon's one schema | Session lifetime; at purge the session's rows are deleted with `secure_delete` on and a `TRUNCATE` checkpoint after commit (CP-020-5), so neither a freed page nor the write-ahead log keeps a readable copy; Path 1 — deleted with the store by `Erase all data` |
| `interventions` (SQLite) | `payload` | Plan-003 (T1.4 CREATE; the [Spec-003](../specs/003-queue-steer-pause-resume.md) user-authored intervention body: a steer's directive text) | Session lifetime; deleted at purge in the same transaction as `session_events.payload`, and with the store by `Erase all data` |
| `queue_items` (SQLite) | `payload` | Plan-003 (T1.4 CREATE; the [Spec-003](../specs/003-queue-steer-pause-resume.md) queued body at-rest copy, a person's send or an orchestration-authored prompt) | Session lifetime; deleted at purge in the same transaction as `session_events.payload`, and with the store by `Erase all data`. Queue rows are durable and never deleted on drain, so the body persists until its session is deleted or the machine erased |
| _(not a table row)_ — the [ADR-028](../decisions/028-provider-credential-custody-posture.md) D2 pasted provider token | n/a — one credential-store item keyed by `accountId`, kept as every daemon secret is ([Spec-020 §Daemon Secrets](../specs/020-data-retention-and-gdpr.md#daemon-secrets)); a token the store cannot take is refused and stored nowhere else — **in no column of any table** | Plan-026 (T2.7) | **Not a selector's target** — the token is a credential, not personal data, so neither the export nor a session's purge reaches it and none is invented. Its lifecycle obligation is **deletion of its credential-store item with its account registration**, in the same operation, and `Erase all data` deletes every credential-store item the app made (an inventory entry — Plan-020 owns no write-path here). Listed in this table precisely because it is _not_ a row: an unlisted secret is one nothing audits |
| `session_events` (SQLite) | `content_payload` | Plan-005 (Phase 3B CREATE + write path; an inventory entry, Plan-020 owning no write-path here) | **Not a per-person selector's target** — machine-authored session content in plain text, with no user linkage, so no selector reaches it and none is invented ([Spec-020 §PII Data Map](../specs/020-data-retention-and-gdpr.md#pii-data-map), the artifact-payload posture). It lives as long as its session: it is deleted at purge with the session's rows (CP-020-5), and with the store by `Erase all data`. Background compaction never removes it. Listed here for the same reason the token above is — the exhaustiveness claim is only checkable if the paths a selector deliberately does **not** reach are enumerated with their dispositions. |
| `users` (PG) | `display_name`, `identity_ref` | Plan-016 (identity model) | Path 2 — hard DELETE row |

**Bounded-retention diagnostic tier** (daemon-local SQLite tables and the engine record's files, non-canonical per [Spec-018 §Required Behavior](../specs/018-observability-and-failure-recovery.md#required-behavior); `Keep diagnostic logs for`, 7 days by default; Plan-018 ownership):

| Table | Column | Owner Plan | Shred Path |
| --- | --- | --- | --- |
| `driver_raw_events` (SQLite, daemon-local) | `raw_payload` | Plan-018 | Path 3 — dropped past `Keep diagnostic logs for`; deleted with the store on erase |
| `command_output` (SQLite, daemon-local) | `stdout`, `stderr` | Plan-018 | Path 3 — dropped past `Keep diagnostic logs for`; deleted with the store on erase |
| `tool_traces` (SQLite, daemon-local) | `args`, `result_body` | Plan-018 | Path 3 — dropped past `Keep diagnostic logs for`; deleted with the store on erase |
| `workflow_engine_events` (newline-delimited JSON files, one per day, daemon-local) | each record's engine decision and its typed values | Plan-018 (T2.9) | Path 3 — a day's file deleted past `Keep diagnostic logs for`; deleted with the data folder on erase |

> **D-020-4.** The bounded-retention column names above say what each bucket carries; each diagnostic table stores it in a single `bucket_payload BLOB`, the shape [local-sqlite-schema.md](../architecture/schemas/local-sqlite-schema.md) defines and [Spec-020 §PII Data Map](../specs/020-data-retention-and-gdpr.md#pii-data-map) records. See [§Design Decisions](#design-decisions) D-020-4.

**No telemetry tier.** The app sends no telemetry and has no outbound telemetry sink: a crash report stays on the machine that crashed and is deleted with the diagnostic logs, and each provider's own telemetry export is received on loopback and written to the service's own diagnostic logs, dropped past `Keep diagnostic logs for`; each request the daemon prices from it becomes an event on its session, the same spend event stream-priced requests write, and never a transcript row ([Spec-020 §PII Data Map](../specs/020-data-retention-and-gdpr.md#pii-data-map)).

### Credential store: the daemon's secrets

Per [Spec-020 §Daemon Secrets](../specs/020-data-retention-and-gdpr.md#daemon-secrets), each daemon secret is its own item in the operating system's credential store, and nothing in the daemon's database is encrypted by the app. The store is the production `DaemonKeyStore` at `bootstrap/daemon-key-store.ts`, composing `keychain-entry.ts` and `WindowsCredentialStore` in `crypto/`.

- **macOS and Linux.** One item per secret through `@napi-rs/keyring`: the login keychain on macOS; on Linux the Secret Service, every item opened with `{linux: {store: "secret-service"}}`, because the binding falls back on its own to the kernel keyring, which is cleared at every restart, when no Secret Service answers.
- **Linux with no Secret Service.** The daemon keeps its items in one file in its own data folder, readable only by the person (mode `0600`), as `gh` and Codex do; never the kernel keyring, and never silently: the person can see where secrets are kept.
- **Windows, native and WSL alike.** One Credential Manager generic credential per item at `CRED_PERSIST_LOCAL_MACHINE`, written and read by the service's Windows half through `windows-native-keyring-store` 1.1.0 with `persistence=local`, because the `@napi-rs/keyring` 2.1.0 binding's Windows path writes Enterprise (CP-020-8). A daemon inside a WSL 2 distribution keeps its items there too, so a Windows computer has one place for secrets on either side.
- **A locked store** refuses with its cause, `locked` or `unavailable`, and the secret is stored nowhere else.
- **Erase** deletes every credential-store item the app made (T22.4.2).

## API And Transport Changes

### Data verbs (daemon JSON-RPC via Plan-006's host)

Methods registered by Plan-020 on Plan-006's JSON-RPC `MethodRegistry` (`ipc/handlers/data-handlers.ts`), each with its params and result schemas in `packages/contracts/src/daemon-data.ts`. The host is **daemon-bound, not the control plane**: the handlers read the daemon's own database and its credential-store items, which a Cloudflare-Workers control plane cannot reach (data-locality — see [§Design Decisions](#design-decisions) D-020-3). Errors ride the [ADR-009](../decisions/009-json-rpc-ipc-wire-format.md) JSON-RPC envelope.

- `daemon.dataExport {destination}` → a job; `daemon.dataExportSubscribe` carries its progress. `destination` is the path the save dialog hands back, named `sidekicks-export-<date>`, or the command line's folder. The folder holds `sessions/<id>.jsonl` (every event, one per line, in the canonical event shape), `files/<session id>/…`, `sidekicks/`, `workflows/`, `accounts.json` with no credential, `hosted-account.json` when signed in (the control plane's `account.export`), and `README.txt`; never a settings value, a credential, a pasted token, a workflow secret, a key or a diagnostic log. One session at a time within 64 MiB, one job at a time; an export writes one line to the diagnostic log and no event.
- `daemon.dataErase {}` — `Erase all data`, in order: stop every run and shell as `Stop` does; sign each provider account out (`claude auth logout` in each Claude Code account home, `account/logout` on each Codex service); revoke this machine's refresh family when signed in to the hosted account; delete every credential-store item the app made; delete the data folder, the account homes it made included; start again empty. Project folders stay, and a backup taken earlier keeps what it held.

## Invariants

Behavioral invariants this plan must preserve; the §Implementation Phase Sequence Tasks cite them in `Verifies invariant`.

- **I-020-15 — The export carries no secret.** An export folder holds no settings value, credential, pasted token, workflow secret, key or diagnostic log, and it streams one session at a time within 64 MiB, one export at a time. ([Spec-020 §Data Export](../specs/020-data-retention-and-gdpr.md#data-export).) Tasks: T22.4.1.
- **I-020-16 — Erase runs in its order.** `daemon.dataErase` stops work, signs providers out and revokes the refresh family before it deletes any credential-store item, and deletes every credential-store item the app made before it deletes the data folder; project folders are never touched. ([Spec-020 §Erasure Paths](../specs/020-data-retention-and-gdpr.md#erasure-paths) Path 1; [Spec-020 §Ordering And Atomicity](../specs/020-data-retention-and-gdpr.md#ordering-and-atomicity).) Tasks: T22.4.2.
- **I-020-19 — Reciprocal completeness.** Every CP-020 obligation has a reciprocal entry in its owner plan; no one-sided cross-plan edge ships. For CP-020-6 (the `REFERENCES users(id)` Path-2 closure), every owner table's plan carries a live reciprocal, so the closure is complete with no silent gap. Tasks: T22.5.1.
- **I-020-20 — Nothing readable after a purge.** The purge deletes the session's rows in one transaction with `secure_delete` on and checkpoints the write-ahead log with `TRUNCATE` once it commits, so a byte scan of the database file and its log finds none of the deleted session's text. ([Spec-020 §Erasure In The Daemon's Database](../specs/020-data-retention-and-gdpr.md#erasure-in-the-daemons-database); [Spec-020 §Ordering And Atomicity](../specs/020-data-retention-and-gdpr.md#ordering-and-atomicity).) Tasks: T22.5.1.
- **I-020-21 — No phantom PII columns.** Every column named in the §PII Data Map resolves to a real column in its owner plan's schema. (D-020-4.) Tasks: T22.5.1.
- **I-020-22 — One purge.** `daemon.retentionPurge` is the only path that deletes a session, and it runs this plan's erasure step; nothing deletes a session by age. ([Spec-020 §Retention Policy](../specs/020-data-retention-and-gdpr.md#retention-policy); [Spec-020 §Ordering And Atomicity](../specs/020-data-retention-and-gdpr.md#ordering-and-atomicity).) Tasks: T22.5.1.
- **I-020-23 — Each secret is its own credential-store item.** Every daemon secret — the identity key, the channel key, the hosted sign-in's refresh token and DPoP key — is its own item in the operating system's credential store, and nothing in the daemon's database is encrypted by the app; on Linux the store is the Secret Service, opened explicitly, or, when none answers, one file in the data folder at mode `0600`, never the kernel keyring and never silently. ([Spec-020 §Daemon Secrets](../specs/020-data-retention-and-gdpr.md#daemon-secrets).) Tasks: T22.1.1, T22.1.2.
- **I-020-24 — Windows items stay in the Windows half.** On a Windows computer, native or WSL, every Credential Manager item is written, read and deleted in the service's Windows half at `CRED_PERSIST_LOCAL_MACHINE`, whichever unit keeps it — a daemon secret, a pasted token, a workflow secret, a tool server's refresh token or DPoP key — and none at a roaming persistence; the items stay in Windows' Credential Manager whichever side runs the service. ([Spec-020 §Daemon Secrets](../specs/020-data-retention-and-gdpr.md#daemon-secrets).) Tasks: T22.1.6.

## Cross-Plan Obligations

- **CP-020-2 — `DaemonKeyStore` (→ Plan-006 CP-006-8).** Plan-020 ships the production `DaemonKeyStore` (`bootstrap/daemon-key-store.ts`), which keeps each daemon secret as its own credential-store item, satisfying Plan-006's CP-006-8 store contract. Reciprocal: Plan-006 CP-006-8.
- **CP-020-5 — The purge's erasure step (⇄ Plan-006 Phase R1, Plan-005, Plan-001).** Plan-006's `daemon.retentionPurge` (Phase R1) deletes the session's rows outright in one transaction with SQLite's `secure_delete` on, so their freed pages hold nothing readable. Once the transaction commits the purge checkpoints the write-ahead log with `TRUNCATE`, retrying while a reader holds an older snapshot, so the log keeps no copy of the deleted rows. After that the purge reclaims the session's artifacts, its capture folder with its snapshot refs and base pins, a chat's managed workspace (Plan-001's `ManagedWorkspaceService.delete`), and the provider's files for the session (Plan-004), and records `session.purged` ([Spec-005](../specs/005-session-event-taxonomy-and-audit-log.md)). Reciprocal: Plan-006 Phase R1. Verified at code time per Implementation Step 5.
- **CP-020-6 — Path-2 closure (⇄ Plan-016/028) — the complete inbound-FK closure `account.delete` covers.** Plan-016 Phase 5's `account.delete` deletes the hosted account over the **complete `REFERENCES users(id)` inbound-foreign-key closure** in [shared-postgres-schema.md](../architecture/schemas/shared-postgres-schema.md) — derived from the schema, not a hand-maintained list, so the set cannot silently drift: the `users` anchor itself plus every table carrying a `REFERENCES users(id)` column, each table counted **once** however many such columns it bears. Re-derive the set from the schema whenever a table is added or dropped. `webauthn_challenges` and `webauthn_credentials` are hard-DELETE class: a challenge row is a live ceremony transaction and a credential row is verified live, so nothing retained re-verifies either after deletion. [Spec-020 §Erasure Paths](../specs/020-data-retention-and-gdpr.md#erasure-paths) Path-2 Mechanism names this closure ([§Design Decisions](#design-decisions) D-020-7). Each owner carries the reciprocal:
  - **Plan-016** — `users` hard-DELETE (CP-016-11); `webauthn_credentials` and `webauthn_challenges` hard-DELETE; `refresh_token_families` hard-DELETE (one row per live sign-in; revoking a family deletes its row, and `user_id` cascades); `revoked_token_families` hard-DELETE: a refresh token has no expiry of its own, so a revoked family's row stays for the account's life and goes with it; and `revoked_jtis`, which Plan-016 Phase 5 builds nullable + `ON DELETE SET NULL` on `user_id` — anonymize `user_id` and retain the `jti` key to its natural `expires_at + 24h` reap, a margin past the access token's lifetime (security-survival per [Spec-020 §Erasure Paths](../specs/020-data-retention-and-gdpr.md#erasure-paths)). `account.delete` revokes the account's refresh families before it deletes.
  - **Plan-028** — `devices`, `runtime_nodes` and `trust_statements` hard-DELETE: the account's linked devices and its machines' registrations with their public keys, and its append-only chain of signed trust statements; deletion is safe at live-verification semantics, since every machine verifies the chain it keeps itself.

  The control plane holds no notification table and no artifact copy: a push is sealed on the machine to the device's push key and the relay stores nothing that opens it, and a session's artifacts stay on the machine that ran it, so neither adds a leg to this closure.

- **CP-020-7 — Path-3 bound (⇄ Plan-018, Plan-006 Phase R1).** Plan-018's diagnostic buckets drop their rows past `Keep diagnostic logs for` on the service's one scheduler (Plan-006 Phase R1); `Erase all data` deletes them with the data folder. There is no per-person flush. Reciprocal: Plan-018 CP-018-2.
- **CP-020-8 — The credential store's Windows arm (⇄ Plan-006 Phase R4).** On both kinds of Windows computer, the service's Windows half writes, reads and deletes every credential-store item: Credential Manager at `CRED_PERSIST_LOCAL_MACHINE` through `windows-native-keyring-store` 1.1.0 with `persistence=local` — over its channel while the service runs, and one-shot (`sidekicks-windows-half.exe keystore get|set|delete <entry>`, the item on stdin and stdout) while it does not, for `sidekicks sign-in`, `sidekicks db restore` and `sidekicks erase-data`. This plan's `WindowsCredentialStore` is its only caller, and every other unit that keeps an item — the pasted provider tokens, the workflow secrets, the notification web address and its signing secret, the mail password, each tool server's refresh token and DPoP key — keeps it through `WindowsCredentialStore`. Reciprocal: Plan-006 Phase R4.
- **CP-020-9 — The command-line verbs (⇄ Plan-006 Phase R3).** `sidekicks export-data <folder>` calls this plan's verb with the service running; `sidekicks erase-data` does what `daemon.dataErase` does and is refused while the service holds the data folder; `sidekicks delete-account` calls Plan-016's `account.delete`. Reciprocal: Plan-006 Phase R3.

> **Reciprocal obligations owed on sibling plans**: (1) **Plan-006** — register the data verbs on `MethodRegistry` (mirror CP-006-6/7). (2) **Spec-020** carries: the daemon's secrets in [§Daemon Secrets](../specs/020-data-retention-and-gdpr.md#daemon-secrets), the purge's erasure in [§Erasure In The Daemon's Database](../specs/020-data-retention-and-gdpr.md#erasure-in-the-daemons-database), and the bucket-column shape (D-020-4).

## Design Decisions

The design decisions behind the plan body above.

- **D-020-3 — Data verbs → daemon JSON-RPC on the `daemon` root.** `daemon.dataExport`, `daemon.dataExportSubscribe` and `daemon.dataErase` are **daemon JSON-RPC methods** on Plan-006's `MethodRegistry` (data-locality: the handlers reach the daemon's own database and its credential-store items, which a Cloudflare-Workers control plane cannot). Each registers its strict params schema from `packages/contracts/src/daemon-data.ts`, which Plan-006's `MethodRegistry.dispatch` Zod-parses before the handler body runs ([Plan-006 §I-006-7 — Schema validation runs before handler dispatch](./006-local-ipc-and-daemon-control.md#i-006-7--schema-validation-runs-before-handler-dispatch)). The names follow the `daemon` root's `<noun><Verb>` form, and the progress stream is `<noun>Subscribe` beside `daemon.dataExport`. **Type 1.**
- **D-020-4 — Diagnostic bucket-PII shape: one `bucket_payload BLOB`.** Each diagnostic bucket stores its PII in a single `bucket_payload BLOB`, the shape `local-sqlite-schema.md` defines and [Spec-020 §PII Data Map](../specs/020-data-retention-and-gdpr.md#pii-data-map) records; the per-field column names in this plan's §PII Data Map bounded tier are a documentation gloss on what each bucket carries. **Type 1.**
- **D-020-7 — Path-2 fan-out is the complete `REFERENCES users(id)` inbound-FK closure.** Path-2 is anchored to the **schema-derived FK closure** (see CP-020-6 for the counting rule) rather than a hand-maintained list, so the set is verifiable against [shared-postgres-schema.md](../architecture/schemas/shared-postgres-schema.md) and cannot silently drift. [Spec-020 §Erasure Paths](../specs/020-data-retention-and-gdpr.md#erasure-paths) Path 2 names the full closure + per-table disposition, and its "Scope: exhaustive" claim is anchored to the FK closure rather than to the §PII Data Map, which lists PII-content columns and not the FK-linkage tables. Owner: Plan-016 Phase 5's `account.delete`, which deletes the whole closure (CP-020-6). Plan-016 Phase 5 builds the token denylist with its disposition named in CP-020-6. The `revoked_*` disposition is anonymize-`user_id`-with-denylist-survival: the denylist lookup is keyed on `jti` / `family_id` (the table PRIMARY KEY), **not** on `user_id`, so anonymizing `user_id` severs the data-subject linkage without touching the revocation check — the row stays denied to its natural `expires_at` reap, so erasure does not resurrect a revoked token within its validity window. **FK-safety mechanism.** "anonymize" is realized by `ON DELETE SET NULL`, not a tombstone identifier. The one anonymize-class FK, `revoked_jtis.user_id`, which Plan-016 Phase 5 adds, is nullable with `ON DELETE SET NULL` in the control plane's one schema, so the `users` hard-DELETE auto-nulls the reference DB-side: FK-safe, and a no-op on the PRIMARY-KEY `jti`. `revoked_token_families` rows are hard-DELETEd with the account. A reserved _tombstone user row_ was rejected: it spawns a ghost-row subsystem for no gain over `SET NULL`. [Spec-020 §Erasure Paths](../specs/020-data-retention-and-gdpr.md#erasure-paths) Path 2 FK-safety is the canonical statement. **Type 1.**

## Implementation Steps

1. Add `@napi-rs/keyring` to `packages/runtime-daemon/package.json`, the credential store for every daemon secret. `keytar` is not used (archived/unmaintained).
2. Implement `packages/runtime-daemon/src/crypto/keychain-entry.ts`, `packages/runtime-daemon/src/crypto/windows-credential-store.ts` (`WindowsCredentialStore`) and the production `DaemonKeyStore` in `packages/runtime-daemon/src/bootstrap/daemon-key-store.ts`: each daemon secret is its own credential-store item; on Linux the Secret Service is opened explicitly with `{linux: {store: "secret-service"}}` and, when none answers, the items go into one file in the data folder at mode `0600`, never the kernel keyring and never silently; on Windows every item goes through the Windows half (CP-020-8); a locked store refuses with its cause ([Spec-020 §Daemon Secrets](../specs/020-data-retention-and-gdpr.md#daemon-secrets)). Reciprocates Plan-006 CP-006-8.
3. Implement `packages/runtime-daemon/src/ipc/handlers/data-handlers.ts` with `crypto/data-export.ts` and `crypto/data-erase.ts`: the data verbs, registered on Plan-006's `MethodRegistry` over the schemas in `packages/contracts/src/daemon-data.ts` ([§Design Decisions](#design-decisions) D-020-3). Export streams one session at a time within 64 MiB and writes no secret; erase runs its six steps in order. Plan-006 reciprocates registration (see [§Cross-Plan Obligations](#cross-plan-obligations)).
4. Keep `docs/architecture/contracts/api-payload-contracts.md` in step with what this plan builds: the data verbs' shapes.
5. **The purge's erasure step and the account-deletion alignment.** Extend Plan-006's retention handlers with the purge's erasure step: the delete of the session's rows runs in one transaction with SQLite's `secure_delete` on, and a `TRUNCATE` checkpoint of the write-ahead log follows the commit, called by Plan-006's `daemon.retentionPurge` (CP-020-5). Then verify at code time: (a) the complete `REFERENCES users(id)` inbound-FK closure (CP-020-6) is enumerable from [shared-postgres-schema.md](../architecture/schemas/shared-postgres-schema.md) and Plan-016's `account.delete` covers every table of it with its disposition — hard-DELETE `users`, `devices`, `trust_statements`, `webauthn_credentials`, `webauthn_challenges`, `runtime_nodes`, `revoked_token_families`; anonymize `revoked_jtis.user_id` via `ON DELETE SET NULL`, each `jti` key surviving to its reap — in one Postgres transaction after the account's refresh families are revoked; (b) Plan-018's diagnostic buckets drop past `Keep diagnostic logs for` (CP-020-7). The reciprocal obligations on Plan-001/005/006/016/018/028 are [§Cross-Plan Obligations](#cross-plan-obligations) CP-020-5 to CP-020-9; each owner plan carries its half.

## Implementation Phase Sequence

The Implementation Steps regroup into three buildable phases: Phase 1 (the daemon's secrets), Phase 4 (the data acts) and Phase 5 (the purge's erasure step with the account-deletion alignment). Each task names **Files**, **Spec coverage**, **Verifies invariant** and **Consumes** (upstream symbols/rows + provider). Sequencing maps to §Rollout Order.

### Phase 1 — The daemon's secrets (Steps 1–2)

**Precondition:** Plan-006 Phase R2 merged — T-006r-2-4 ships the `DaemonKeyStore` interface + test-only stub at `bootstrap/daemon-key-store.ts` (CP-006-8); this phase's production store (T22.1.2) implements that interface and must not author Plan-006's file. Plan-006 Phase R4 merged — T-006r-4-10 builds the Windows half's credential verbs, which this phase's `WindowsCredentialStore` (T22.1.6) calls over the Windows half's channel and one-shot (CP-020-8).

#### Tasks

- **T22.1.1 — Credential-store dependency.**
  - Files: `packages/runtime-daemon/package.json` (EXTEND)
  - **Spec coverage:** Spec-020 §Daemon Secrets
  - **Verifies invariant:** I-020-23
  - Consumes: `@napi-rs/keyring`.
- **T22.1.2 — The production `DaemonKeyStore`.**
  - Files: `packages/runtime-daemon/src/bootstrap/daemon-key-store.ts` (EXTEND — Plan-006 T-006r-2-4 creates the file with the `DaemonKeyStore` interface and its test-only stub); `packages/runtime-daemon/src/crypto/keychain-entry.ts` (CREATE)
  - **Spec coverage:** Spec-020 §Daemon Secrets (one item per secret; the Secret Service opened explicitly on Linux, and the one file when none answers; a locked store)
  - **Verifies invariant:** I-020-23
  - Consumes: `@napi-rs/keyring` (T22.1.1) and, on Windows, `WindowsCredentialStore` (T22.1.6); the daemon composition root in the shipped `bootstrap/` dir; Plan-006 CP-006-8 store contract (reciprocates it).
- **T22.1.6 — The Windows arm.**
  - Files: `packages/runtime-daemon/src/crypto/windows-credential-store.ts` (CREATE, `WindowsCredentialStore`)
  - **Spec coverage:** Spec-020 §Daemon Secrets (Windows, native and WSL alike)
  - **Verifies invariant:** I-020-24
  - Consumes: the Windows half's Credential Manager verbs, over its channel and one-shot (Plan-006 Phase R4, CP-020-8).

### Phase 4 — The data acts (Steps 3–4)

**Precondition:** Phase 1 merged (the erase deletes the credential-store items) + Plan-006 Phase 2 merged (the JSON-RPC `MethodRegistry` the verbs register on, per D-020-3 — already shipped) + the contracts in `packages/contracts/src/daemon-data.ts`.

#### Tasks

- **T22.4.1 — `Export all data`.**
  - Files: `packages/runtime-daemon/src/crypto/data-export.ts` (CREATE); `packages/runtime-daemon/src/ipc/handlers/data-handlers.ts` (CREATE)
  - **Spec coverage:** Spec-020 §Data Export
  - **Verifies invariant:** I-020-15
  - Consumes: `daemon.dataExport {destination}` and `daemon.dataExportSubscribe` schemas; each session's rows as the store holds them; Plan-016's `account.export` for `hosted-account.json` when signed in.
- **T22.4.2 — `Erase all data`.**
  - Files: `packages/runtime-daemon/src/crypto/data-erase.ts` (CREATE); `data-handlers.ts` (same)
  - **Spec coverage:** Spec-020 §Erasure Paths (Path 1), Spec-020 §Ordering And Atomicity
  - **Verifies invariant:** I-020-16
  - Consumes: `daemon.dataErase {}` schema; Plan-006's `Stop`; each provider's own sign-out (`claude auth logout`, Codex `account/logout`); the hosted refresh-family revocation; the credential store's delete (T22.1.2, T22.1.6), through the Windows half's one-shot verbs when the service is stopped (CP-020-8).
- **T22.4.4 — Register the data verbs on `MethodRegistry`.**
  - Files: `data-handlers.ts` (same); daemon registry wiring
  - **Spec coverage:** Spec-020 §Interfaces And Contracts
  - **Verifies invariant:** I-020-16
  - Consumes: Plan-006 `MethodRegistry`. Plan-006 reciprocates the registration.
- **T22.4.5 — Contract doc in step.**
  - Files: `docs/architecture/contracts/api-payload-contracts.md` (EXTEND)
  - **Spec coverage:** Spec-020 §Interfaces And Contracts (the data verbs' shapes)
  - **Verifies invariant:** none (a documentation task)
  - Consumes: the data verbs (T22.4.1, T22.4.2, T22.4.4).

### Phase 5 — The purge's erasure step and the account-deletion alignment (Step 5)

**Precondition:** Phase 4 merged (the task spans the CP-020-5 to CP-020-9 reciprocals per I-020-19 to I-020-22, so it lands after every other Plan-020 phase; Phase 4 merged implies Phase 1 via its own precondition) + Plan-006 Phase R1's `daemon.retentionPurge`.

#### Tasks

- **T22.5.1 — The purge's erasure step and the account-deletion alignment.**
  - Files: Plan-006's retention handlers (EXTEND — `secure_delete` on for the delete of the session's rows inside the purge's transaction, and the `TRUNCATE` checkpoint after commit); the cross-plan alignment per Implementation Step 5
  - **Spec coverage:** Spec-020 §Retention Policy (the purge), Spec-020 §Erasure In The Daemon's Database, Spec-020 §Erasure Paths (Path 2), Spec-020 §Ordering And Atomicity
  - **Verifies invariant:** I-020-19, I-020-20, I-020-21, I-020-22
  - Consumes: Plan-006 Phase R1's purge transaction (CP-020-5); the CP-020-6 closure's owners (Plan-016 `users`, `webauthn_credentials`, `webauthn_challenges`, `refresh_token_families`, `revoked_jtis` and `revoked_token_families`, Plan-028 `devices`, `runtime_nodes` and `trust_statements`); Plan-018's bound (CP-020-7).

## Parallelization Notes

- Steps 1–2 (the daemon's secrets) wait on no other plan's schema work.
- Step 3 (the data verbs) depends on Phase 1's store and Plan-006's IPC host; export and erase can be built in parallel with each other.

## Test And Verification Plan

- **Integration, credential store**: each daemon secret round-trips as its own credential-store item, and no secret is in the daemon's database; on Linux an item lands in the Secret Service and never in the kernel keyring, and with no Secret Service answering it lands in the one file in the data folder at mode `0600`; a locked store refuses with cause `locked`. **Manual**: on Windows confirm each item is a local-machine Credential Manager credential and not Enterprise, from both a native and a WSL service.
- **Integration, export**: the folder holds every session's events and none of the excluded classes (a seeded pasted token, workflow secret and key are searched for and absent); memory stays within 64 MiB on a store larger than it.
- **Integration, erase**: the six steps run in order; afterward no credential-store item the app made remains, the data folder is gone, a project folder is untouched, and the next start opens as on first launch.
- **Integration, purge erasure**: after a purge, a byte scan of the database file and the write-ahead log finds none of the session's typed messages, queue item bodies, steer text or machine-authored bodies.

## Rollout Order

1. Land the credential-store dependency, the production store and the Windows arm with their tests (Steps 1–2) — no schema impact.
2. Land the data verbs in `data-handlers.ts` (`packages/runtime-daemon/src/ipc/handlers/`, registered on Plan-006's `MethodRegistry` per D-020-3) + documentation updates (Steps 3–4), then the purge's erasure step (Step 5).

## Rollback Or Fallback

- A Linux machine with no Secret Service keeps the daemon's items in the one file in the data folder at mode `0600` — no code change required; the kernel keyring is never a fallback. A locked store refuses with its cause, and the secret is stored nowhere else.

## Risks And Blockers

- **Risk**: no Secret Service on a headless Linux host. **Mitigation**: the items go into the one file at mode `0600`, never the kernel keyring, and the person can see where secrets are kept.
- **A deleted row's bytes stay in its freed page.** Measured on SQLite 3.53.4, the version the pinned `better-sqlite3` embeds, in write-ahead-log mode: ten rows removed by `DELETE` alone stayed byte-for-byte in the database file after a `TRUNCATE` checkpoint. The purge therefore deletes with `secure_delete` on and checkpoints with `TRUNCATE` after commit, and the purge's byte-scan test proves on every SQLite the build pins that no deleted session's text stays in the database file or the log.

## Done Checklist

- Each daemon secret — the identity key, the channel key, the hosted sign-in's refresh token and DPoP key — is its own credential-store item, and nothing in the daemon's database is encrypted by the app
- On Linux the Secret Service is opened explicitly, and with no Secret Service the items sit in one file in the data folder at mode `0600`, never the kernel keyring and never silently; on Windows every item goes through the Windows half at `CRED_PERSIST_LOCAL_MACHINE`
- [§PII Data Map](#pii-data-map) enumerates the durable and bounded-retention tiers with owner-plan attribution (Plan-016 / Plan-018 / Plan-020) per [Spec-020 §PII Data Map](../specs/020-data-retention-and-gdpr.md#pii-data-map)
- The purge deletes a session's rows in one transaction with `secure_delete` on, then checkpoints the write-ahead log with `TRUNCATE` (CP-020-5)
- Cross-plan alignment confirmed: Plan-016's `account.delete` covers every table of the CP-020-6 closure with its disposition; Plan-018's buckets drop past `Keep diagnostic logs for`
- `Export all data` and `Erase all data` pass their integration tests, and the export holds no secret
- Cross-plan obligations CP-020-2 and CP-020-5 to CP-020-9 carried by their owner plans (Plan-006 the store interface, the data verbs' registration, the purge, the command line and the Windows half; Plan-016 the account closure; Plan-028 Path-2 targets; Plan-018 the diagnostic bound)

## Schema And Code-Path Ownership

Plan-020 adds no table to the daemon's one schema; its code paths (the credential store, export, erase and the purge's erasure step) ship here. Plan-020's place in the build order is the dispatch group [cross-plan-dependencies §Dispatch groups](../architecture/cross-plan-dependencies.md#dispatch-groups) lists it in.

## References

- [Spec-020: Data Retention, Export And Deletion](../specs/020-data-retention-and-gdpr.md)
- [ADR-015: V1 Feature Scope Definition](../decisions/015-v1-feature-scope-definition.md)
- [ADR-021: Machine Identity Key Custody](../decisions/021-cli-identity-key-storage-custody.md) — **Required**: the machine's identity key, which this plan's store keeps
- [ADR-039: Kept Sessions Keep Their Provider Files](../decisions/039-kept-sessions-keep-their-provider-files.md) — a kept session and its provider files stay until the person deletes them
- [ADR-009: JSON-RPC IPC Wire Format](../decisions/009-json-rpc-ipc-wire-format.md) — the daemon error envelope the data verbs return
- Cross-Plan Dependency Graph
- [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md)
- [SQLite `PRAGMA secure_delete`](https://www.sqlite.org/pragma.html#pragma_secure_delete) and [`PRAGMA wal_checkpoint(TRUNCATE)`](https://www.sqlite.org/pragma.html#pragma_wal_checkpoint) — the purge's erasure
