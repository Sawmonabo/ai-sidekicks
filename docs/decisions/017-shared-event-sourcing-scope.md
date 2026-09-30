# ADR-017: Shared Event-Sourcing Scope

| Field         | Value                                                    |
| ------------- | -------------------------------------------------------- |
| **Status**    | `accepted`                                               |
| **Type**      | `Type 1 (two-way door)`                                  |
| **Domain**    | `Data Architecture / Event Sourcing / Relay Trust Model` |
| **Date**      | `2026-04-17`                                             |
| **Author(s)** | `Claude (AI-assisted)`                                   |
| **Reviewers** | `Accepted 2026-04-17`                                    |

## Context

AI Sidekicks is an agentic coding runtime for one user and their agents. Per [ADR-015](./015-v1-feature-scope-definition.md), V1 ships its features on a single codebase, and the relay is the person's own, in either deployment [ADR-020](./020-v1-deployment-model-and-oss-license.md) describes. Session activity is modeled as events for replay, auditability, and determinism; [vision.md §5. Session Engine](../vision.md) names the product an "event-sourced engine where everything important is an event."

The system already has a two-store split per [ADR-004: SQLite Local State and Postgres Control Plane](./004-sqlite-local-state-and-postgres-control-plane.md):

- **Local SQLite store** — machine-scoped runtime truth owned by each daemon.
- **Shared Postgres store** — coordination truth (sessions, the device registry, device-liveness history, each machine's registration) across all of the person's devices and machines.

Per [ADR-010](./010-tokens-passkeys-and-the-remote-channel.md), each device reaches each machine over one channel of its own: the Noise Protocol Framework's `Noise_KK_25519_ChaChaPoly_SHA256` handshake and transport, with no construction of the project's own and a fresh handshake on every connection and every 10 minutes. With one person, every channel has two ends, one device and one machine, so there is no group to encrypt to. The relay is zero-knowledge: it sees the device and machine ids at connection, the channel version and profile, and frame sizes and times, never a method, a name or a byte of a session, and it has no ability to read, append to, or sequence session content. A machine's identity is its service's Ed25519 key (§Machine Identity And Reachability below).

The current schema is already de facto per-daemon: `session_events` is owned by Plan-001 in the Local SQLite schema, and `shared-postgres-schema.md` contains no `session_events_shared` or equivalent table. What has been missing is a decision document that names this scope, bounds the trade-offs, and aligns vision.md and data-architecture.md with the implementation.

## Problem Statement

Should V1 ship with a shared server-side event log where the person's daemons append session events to a single Postgres table (Option A), or with per-machine local event logs where each machine's daemon owns the authoritative log of the sessions it runs and other devices read that log over their own channel to the machine (Option B)?

### Trigger

vision.md §5. Session Engine promises event-sourcing semantics without scoping the event log's location. The absence of a `session_events_shared` table in shared-postgres-schema.md is unexplained. Downstream schema ownership, replay spec (Spec-013), and audit-log spec (Spec-005) all depend on this scope being fixed before Plan-001 Session Core begins implementation.

## Decision

**V1 ships Option B: per-machine local event logs.** Each session runs on exactly one owning machine for its whole life, and that machine's daemon owns the session's authoritative `session_events` table in its Local SQLite store, appending every event with a monotonic per-session sequence. No other daemon holds a copy of a session's log: another device reads the session, live and in its history, over its own sealed channel to the owning machine, and the relay carries those frames without reading them. Shared Postgres stores coordination records only (sessions, the device registry, device-liveness history, each machine's registration) and does not store session event streams.

Option A is rejected. The relay never holds a byte of a session, so there is no shared log for it or the control plane to keep.

### The Local Log Is Authoritative

Two consequences follow from a daemon owning its own log.

**On resume, the local log wins.** When a provider's reported session position diverges from the daemon's recorded position, the per-daemon `session_events` table with its monotonic per-session sequence is the source of truth. Divergence halts for a human rather than silently re-emitting or silently discarding events; the reconciliation semantics are in [Spec-013](../specs/013-persistence-recovery-and-replay.md) §Fallback.

**The log never truncates and never rewrites.** Undo (V1 feature 19 per [ADR-015](./015-v1-feature-scope-definition.md)) is recorded **forward**: every undo appends one `session.restore_finished` event carrying what applied and the cause of what did not, and a conversation cut also appends `run.rolled_back`, registered in the `run_lifecycle` category as **non-terminal** by [Spec-005](../specs/005-session-event-taxonomy-and-audit-log.md). The undo itself is [Spec-003](../specs/003-queue-steer-pause-resume.md)'s. The provider's conversation cut — Claude Code's `rewind_conversation`, Codex's `thread/revert`, and, before Claude Code's last compaction, the provider's own copy of the conversation resumed in place — is an execution detail beneath the log. The files go back through the daemon's own checkpoint store ([Spec-013 §Required Behavior](../specs/013-persistence-recovery-and-replay.md#required-behavior)), never through the git snapshot. Turns after an undo point stay queryable history, marked superseded by projection when the conversation went back.

### Machine Identity And Reachability

A machine's identity is its service's Ed25519 key, minted at the service's first start together with the machine's id, and again only at `sidekicks rotate-keys` and when a removed machine is linked again; it is sealed under the master key and never leaves the machine. The machine's registration with the control plane, keyed by the machine and its owning user, carries its id, its public key, its name, its platform and its service version. Every device pins the key and checks it in every handshake. A machine that answers under a known id with a different key is refused outright unless a `runtimenode.key_rotated` statement, signed by the old key and the new one, or a later `runtimenode.added` for that id stands behind the change: `sidekicks rotate-keys` writes the first, and a removed machine that is linked again first mints a new key under its same id and records the second, which moves every device's pin for that id as a rotation does, its store, sessions and id staying as they were.

A machine's health is its reachability and its version, and nothing else. A machine keeps one outbound connection to the relay while its service runs: it is reachable while that connection is up, and after 45 seconds without a frame it is not reachable, read from the relay connection itself with no heartbeat table. The version decides whether a device may only read.

**None of this is a session event.** Nothing about a machine is recorded on a session's log: there are no `runtime_node.*` session events — no `registered`, `online`, `offline`, `degraded` or `revoked`, and no capability declarations. A machine's driver capabilities are current state, held in the daemon's capability tables and rebuilt from them at start, never replayed from events. So no party has to author a machine's lifecycle on a session's log, and none does.

**Where a machine's changes are seen.** Control-plane events carry the changes to the person's machines, devices and passkeys: one for each statement in the account's chain, carrying its kind as its name (`device.linked`, `device.renamed`, `device.revoked`, `passkey.added`, `passkey.removed`, `runtimenode.added`, `runtimenode.renamed`, `runtimenode.removed` and `runtimenode.key_rotated`), beside `device.forgotten` and `runtimenode.registered`. The control plane's `device.list` live read delivers them to every linked device as they happen, with no polling ([Spec-028](../specs/028-remote-control.md)); none of them is written on a session's log.

### Thesis — Why This Option

V1's zero-knowledge relay cannot read payloads. A shared append-only event log under that constraint has two unhappy shapes: either (a) the server stores ciphertext envelopes it cannot interpret or index — which forecloses shared audit, the only reason to pick Option A — or (b) plaintext reaches the relay, which violates ADR-010's explicit trust model. Neither is viable.

Local-first and collaborative-editor systems predominantly use per-replica or per-client logs. Primary-source survey of the closest architectural precedents:

- **Kleppmann et al., "Local-First Software" (Ink & Switch, Onward! 2019):** "In cloud apps, the data on the server is treated as the primary, authoritative copy… In local-first applications we swap these roles: we treat the copy of the data on your local device… as the primary copy." ([inkandswitch.com/essay/local-first](https://www.inkandswitch.com/essay/local-first/), [martin.kleppmann.com/papers/local-first.pdf](https://martin.kleppmann.com/papers/local-first.pdf))
- **Automerge (CRDT, Kleppmann et al.):** "Automerge is a Conflict-Free Replicated Data Type (CRDT), which allows concurrent changes on different devices to be merged automatically without requiring any central server." Per-replica hash-DAG, merge by commutativity, no central sequencer. ([automerge.org/docs/hello](https://automerge.org/docs/hello))
- **Zed collaboration:** per-replica CRDT logs routed by a central server that does not own the merge. Zed's CRDT design "allows individuals to edit their own replicas of a document independently" and then "replicas apply each other's operations." Closest topological precedent for V1 — central routing, no central log ownership. ([zed.dev/blog/crdts](https://zed.dev/blog/crdts), [zed.dev/blog/full-spectrum-of-collaboration](https://zed.dev/blog/full-spectrum-of-collaboration))
- **Replicache / Rocicorp:** per-client mutation log plus server-authoritative canonical state. "Pending mutations applied on the client are speculative until applied on the server. In Replicache, the server is authoritative." Legitimizes the per-user-pending plus server-merge split. ([doc.replicache.dev/concepts/how-it-works](https://doc.replicache.dev/concepts/how-it-works))

Four of four directly analogous systems use per-replica logs. The ecosystem norm for replicated-log software is Option B. Combined with the cryptographic constraint, V1 has no defensible path to Option A.

### Antithesis — The Strongest Case Against

Linear's sync engine is the clean counterexample. A collaborative, offline-capable, real-time system that nevertheless runs a shared server-authoritative log with a single global monotonic `lastSyncId` spanning the workspace. A CTO-endorsed reverse-engineering reference states: "the local database is a subset of the server database (the SSOT)… When a transaction is successfully executed by the server, the global `lastSyncId` increments by 1." Clients hold pending transactions client-side until the server's delta package arrives. ([linear.app/now/scaling-the-linear-sync-engine](https://linear.app/now/scaling-the-linear-sync-engine), [github.com/wzhudev/reverse-linear-sync-engine](https://github.com/wzhudev/reverse-linear-sync-engine))

A hypothetical V1 that chose Option A — with group encryption plus server-stamped global sequence numbers on ciphertext envelopes — would offer two benefits Option B cannot: (1) audit across every machine through one SQL query rather than one read per machine, and (2) one canonical ordering of events across machines.

The antithesis's strongest form is: Linear proves shared-log is viable for collaborative + offline + real-time software; AI Sidekicks should adopt the Linear pattern rather than the Zed/Automerge pattern.

### Synthesis — Why It Still Holds

The antithesis is load-bearing only if one of two premises is true: either (a) Linear-style plaintext on the server is acceptable — it is not, by ADR-010's trust model — or (b) the relay may keep session content as group-encrypted envelopes — it may not: every channel has two ends, one device and one machine, there is no group to encrypt to, and the relay never holds a byte of a session.

Option A is not available. Choosing Option B is not a preference for per-machine logs over shared logs in the abstract; it is the only option compatible with a relay that sees no session content. The accepted trade-off below, one read per machine instead of one query across them, is the price of that relay, and it is small for one person, whose sessions each live on one machine.

The Linear pattern stays on record as the counterexample for a server that may read the data, which this relay may not.

## Alternatives Considered

### Option B: Per-machine local event logs (Chosen)

- **What:** Each machine's daemon owns a `session_events` table in its Local SQLite (already declared in [local-sqlite-schema.md](../architecture/schemas/local-sqlite-schema.md), owned by Plan-001), holding the sessions that machine runs. Every event of a session is appended there, with `UNIQUE(session_id, sequence)` monotonic per session. Other devices read a session over their own channel to its owning machine (ADR-010); no other daemon appends a copy.
- **Steel man:** Cryptographically coherent with the zero-knowledge relay. Matches the ecosystem norm for replicated-log and collaborative-editor systems (Kleppmann, Automerge, Zed, Replicache). Each daemon is authoritative for its own view and can replay offline. No trust is placed in the relay beyond message routing. Schema already de facto implements this.
- **Weaknesses:** No single query spans all of the person's machines: each machine answers for the sessions it runs, and an audit or export covering several machines reads each one.

### Option A: Shared Postgres event log (Rejected)

- **What:** One `session_events_shared` append-only table in Postgres. The person's daemons append session events with a server-stamped global monotonic sequence.
- **Steel man:** Audit across machines is a single SQL query, with one canonical event sequence. Linear proves the pattern is viable for collaborative + offline + real-time software with server-held plaintext.
- **Why rejected:** The relay carries per-connection channels between one device and one machine and never holds a byte of a session (ADR-010). A shared table would hold either ciphertext the server cannot index, query, or audit — which removes the only reason to choose Option A — or plaintext, which the relay is never given.

## Reversibility Assessment

- **Reversal cost:** A `session_events_shared` table would be an additive table, but filling it means the relay or the control plane holding session content, which [ADR-010](./010-tokens-passkeys-and-the-remote-channel.md)'s channel rules out; a reversal therefore starts with a change to that channel, not to this schema.
- **Blast radius:** `shared-postgres-schema.md` (one new table), [Spec-005](../specs/005-session-event-taxonomy-and-audit-log.md) (audit semantics across machines), [Spec-013](../specs/013-persistence-recovery-and-replay.md) (a shared log as a replay source), ADR-010 and [Spec-028](../specs/028-remote-control.md) (what the relay may carry). No local schema churn.
- **Migration path:** None planned. The local logs stay authoritative whatever is added beside them.
- **Point of no return:** None. The local logs remain the record under any later addition.

## Consequences

### Positive

- A session's content never leaves its owning machine except over a device's own sealed channel.
- Cryptographically coherent with the zero-knowledge relay: the relay sees ciphertext and routes it; it does not own any log.
- Matches replicated-log ecosystem precedent (Kleppmann, Automerge, Zed, Replicache).
- Each daemon is authoritative for its own view and can replay offline.
- Reduces the shared-Postgres write path from per-event to per-coordination-record, lowering the load on the person's own relay.

### Negative (accepted trade-offs)

- **One read per machine.** A question about one session is answered by its owning machine's log alone. A question that spans sessions on two machines — every session touched this week, say — reads each machine and combines the answers; there is no single-query shortcut. This is the accepted cost of a relay that holds no session content.
- **No ordering across machines.** A session's `sequence` is monotonic within its owning machine's log, and nothing orders events across machines. Nothing needs to, because no session spans two machines; a consumer that lines up two machines' sessions by time uses wall-clock timestamps, never raw sequence numbers.

### Unknowns

- None open: a session's events live only on its owning machine, so no question of ordering or collecting one session's events across machines arises.

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| Kleppmann, Wiggins, van Hardenberg, McGregor — "Local-First Software" (Ink & Switch / Onward! 2019) | Academic paper | Per-device copy is the primary authoritative copy; cloud copies are secondary | [inkandswitch.com/essay/local-first](https://www.inkandswitch.com/essay/local-first/), [martin.kleppmann.com/papers/local-first.pdf](https://martin.kleppmann.com/papers/local-first.pdf) |
| Automerge documentation | Official documentation | Per-replica hash-DAG; merge by commutativity; no central sequencer | [automerge.org](https://automerge.org/), [automerge.org/docs/hello](https://automerge.org/docs/hello) |
| Zed — "CRDTs for mutable trees" and "The full spectrum of collaboration" | Engineering blog (Zed Industries) | Per-replica CRDT logs with central routing server — closest topology match to V1 | [zed.dev/blog/crdts](https://zed.dev/blog/crdts), [zed.dev/blog/full-spectrum-of-collaboration](https://zed.dev/blog/full-spectrum-of-collaboration) |
| Replicache — "How it works" | Official documentation (Rocicorp) | Split: per-client mutation log plus server-authoritative canonical state — legitimizes the per-user-pending plus server-merge split | [doc.replicache.dev/concepts/how-it-works](https://doc.replicache.dev/concepts/how-it-works) |
| Linear sync engine — scaling blog + CTO-endorsed reverse-engineering repo | Engineering blog + RE repo | Counterexample: shared server-authoritative log with global monotonic `lastSyncId`; viable because server sees plaintext | [linear.app/now/scaling-the-linear-sync-engine](https://linear.app/now/scaling-the-linear-sync-engine), [github.com/wzhudev/reverse-linear-sync-engine](https://github.com/wzhudev/reverse-linear-sync-engine) |
| Oskar Dudycz — event-sourcing antipatterns (event-driven.io) | Community blog | Partial null result — Dudycz's named antipatterns (State Obsession, Property Sourcing, Clickbait Events, Passive Aggressive Events, CRUD Sourcing) do not include "shared event log across users" — **cited as `unverified — cite needed`** for the "shared-log is an event-sourcing antipattern" claim; not load-bearing for this ADR | [event-driven.io/en/anti-patterns](https://event-driven.io/en/anti-patterns/) |

### Related ADRs

- [ADR-004 — SQLite Local State And Postgres Control Plane](./004-sqlite-local-state-and-postgres-control-plane.md) — establishes the two-store split this ADR scopes event-sourcing against.
- [ADR-010 — Tokens, Passkeys And The Remote Channel](./010-tokens-passkeys-and-the-remote-channel.md) — the per-connection `Noise_KK_25519_ChaChaPoly_SHA256` channel between each device and each machine, and what the relay may see; also PASETO v4 tokens with a device-code sign-in for the control plane, and passkeys only in the web client, the phone apps and the device-code page.
- [ADR-015 — V1 Feature Scope Definition](./015-v1-feature-scope-definition.md) — the V1 feature scope this decision respects.

### Related Specs And Docs

- [Spec-005 — Session Event Taxonomy and Audit Log](../specs/005-session-event-taxonomy-and-audit-log.md) — event taxonomy the per-daemon logs carry.
- [Spec-013 — Persistence, Recovery, and Replay](../specs/013-persistence-recovery-and-replay.md) — replay semantics over per-daemon logs.
- [Data Architecture §Event-Sourcing Scope](../architecture/data-architecture.md#event-sourcing-scope) — aligned with this ADR.
- [vision.md §5. Session Engine](../vision.md) — aligned with this ADR.
