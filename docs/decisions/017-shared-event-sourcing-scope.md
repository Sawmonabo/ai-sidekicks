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

AI Sidekicks is a collaborative operating system for AI coding sessions. Per [ADR-015](./015-v1-feature-scope-definition.md), V1 ships 17 features across two deployment options (OSS self-host plus hosted SaaS) on a single codebase. Session activity is modeled as events for replay, auditability, and determinism; [vision.md §Session Engine](../vision.md) names the product an "event-sourced engine where everything important is an event."

The system already has a two-store split per [ADR-004: SQLite Local State and Postgres Control Plane](./004-sqlite-local-state-and-postgres-control-plane.md):

- **Local SQLite store** — machine-scoped runtime truth owned by each daemon.
- **Shared Postgres store** — coordination truth (sessions, memberships, invites, presence history, runtime node attachments, cross-node coordination records) across all participants.

Per [ADR-010](./010-paseto-webauthn-mls-auth.md) as rewritten by BL-048, V1 relay encryption is pairwise X25519 ECDH with XChaCha20-Poly1305 via audited `@noble/curves` and `@noble/ciphers`. The relay is zero-knowledge — it sees ciphertext only and has no ability to read, append to, or sequence plaintext session content. MLS (RFC 9420) group encryption is the V1.1 upgrade path, gated on the three ADR-010 promotion gates (named external audit, interop tests against ≥ 1 other implementation, ≥ 4 weeks production soak under feature flag).

The current schema is already de facto per-daemon: `session_events` is owned by Plan-001 in the Local SQLite schema, and `shared-postgres-schema.md` contains no `session_events_shared` or equivalent table. What has been missing is a decision document that names this scope, bounds the trade-offs, and aligns vision.md and data-architecture.md with the implementation.

## Problem Statement

Should V1 ship with a shared server-side event log where all participants' daemons append session events to a single Postgres table (Option A), or with per-daemon local event logs where each daemon owns its own authoritative log and the relay distributes encrypted event payloads for peers to append to their own logs (Option B)?

### Trigger

BL-046 (P0) from the pre-implementation architecture audit (session `2026-04-16-arch-audit-163537`). vision.md §Session Engine promises event-sourcing semantics without scoping the event log's location. The absence of a `session_events_shared` table in shared-postgres-schema.md is unexplained. Downstream schema ownership, replay spec (Spec-015), and audit-log spec (Spec-006) all depend on this scope being fixed before Plan-001 Shared Session Core begins implementation.

## Decision

**V1 ships Option B: per-daemon local event logs.** Each daemon owns an authoritative `session_events` table in its Local SQLite store. Events originating on that daemon are appended with a monotonic per-session sequence. Cross-participant events are distributed by the relay as pairwise-encrypted payloads; each receiving daemon decrypts the payload, validates it, and appends it to its own local log with its own per-session sequence number. Shared Postgres stores coordination records only (sessions, memberships, invites, presence history, runtime node attachments, cross-node dispatch records) and does not store session event streams.

Option A is rejected for V1 but **retained as a V1.1 candidate** gated on ADR-010's MLS promotion gates.

### Thesis — Why This Option

V1's zero-knowledge relay cannot read payloads. A shared append-only event log under that constraint has two unhappy shapes: either (a) the server stores ciphertext envelopes it cannot interpret or index — which forecloses shared audit, the only reason to pick Option A — or (b) plaintext reaches the relay, which violates ADR-010's explicit trust model. Neither is viable.

Local-first and collaborative-editor systems predominantly use per-replica or per-client logs. Primary-source survey of the closest architectural precedents:

- **Kleppmann et al., "Local-First Software" (Ink & Switch, Onward! 2019):** "In cloud apps, the data on the server is treated as the primary, authoritative copy… In local-first applications we swap these roles: we treat the copy of the data on your local device… as the primary copy." ([inkandswitch.com/essay/local-first](https://www.inkandswitch.com/essay/local-first/), [martin.kleppmann.com/papers/local-first.pdf](https://martin.kleppmann.com/papers/local-first.pdf))
- **Automerge (CRDT, Kleppmann et al.):** "Automerge is a Conflict-Free Replicated Data Type (CRDT), which allows concurrent changes on different devices to be merged automatically without requiring any central server." Per-replica hash-DAG, merge by commutativity, no central sequencer. ([automerge.org/docs/hello](https://automerge.org/docs/hello))
- **Zed collaboration:** per-replica CRDT logs routed by a central server that does not own the merge. Zed's CRDT design "allows individuals to edit their own replicas of a document independently" and then "replicas apply each other's operations." Closest topological precedent for V1 — central routing, no central log ownership. ([zed.dev/blog/crdts](https://zed.dev/blog/crdts), [zed.dev/blog/full-spectrum-of-collaboration](https://zed.dev/blog/full-spectrum-of-collaboration))
- **Replicache / Rocicorp:** per-client mutation log plus server-authoritative canonical state. "Pending mutations applied on the client are speculative until applied on the server. In Replicache, the server is authoritative." Legitimizes the per-participant-pending plus server-merge split. ([doc.replicache.dev/concepts/how-it-works](https://doc.replicache.dev/concepts/how-it-works))

Four of four directly analogous systems use per-replica logs. The ecosystem norm for local-first collaborative software is Option B. Combined with the cryptographic constraint, V1 has no defensible path to Option A.

### Antithesis — The Strongest Case Against

Linear's sync engine is the clean counterexample. A collaborative, offline-capable, real-time system that nevertheless runs a shared server-authoritative log with a single global monotonic `lastSyncId` spanning the workspace. A CTO-endorsed reverse-engineering reference states: "the local database is a subset of the server database (the SSOT)… When a transaction is successfully executed by the server, the global `lastSyncId` increments by 1." Clients hold pending transactions client-side until the server's delta package arrives. ([linear.app/now/scaling-the-linear-sync-engine](https://linear.app/now/scaling-the-linear-sync-engine), [github.com/wzhudev/reverse-linear-sync-engine](https://github.com/wzhudev/reverse-linear-sync-engine))

A hypothetical V1 that chose Option A — with MLS group encryption already shipped plus server-stamped global sequence numbers on ciphertext envelopes — would offer three benefits Option B cannot: (1) cross-participant audit via one SQL query rather than federated log-collection, (2) canonical event ordering with deterministic interleaving, (3) a single durable point of truth for "what happened in this session" rather than N participant-specific reconstructions.

The antithesis's strongest form is: Linear proves shared-log is viable for collaborative + offline + real-time software; AI Sidekicks should adopt the Linear pattern rather than the Zed/Automerge pattern.

### Synthesis — Why It Still Holds

The antithesis is load-bearing only if one of two premises is true: either (a) Linear-style plaintext on the server is acceptable — it is not, by ADR-010's explicit trust model — or (b) MLS group encryption with audit + interop + 4-week soak promotion gates is already cleared — it is not, per ADR-010 which names these exact gates as V1.1 preconditions and not V1 preconditions.

Option A is not available for V1. It becomes available in V1.1 if and when MLS promotion gates clear. Choosing Option B for V1 is not a preference for per-device logs over shared logs in the abstract; it is the only option cryptographically compatible with the zero-knowledge relay V1 ships. The federated-audit accepted trade-off below is the price of shipping pairwise encryption in V1 rather than deferring V1 until MLS ships.

The Linear pattern is retained as the reference architecture for Option A's V1.1 candidate. ADR-010's MLS promotion gate completion is the re-evaluation trigger.

## Alternatives Considered

### Option B: Per-daemon local event logs (Chosen)

- **What:** Each daemon owns a `session_events` table in its Local SQLite (already declared in [local-sqlite-schema.md](../architecture/schemas/local-sqlite-schema.md), owned by Plan-001). Events originating on that daemon are appended with `UNIQUE(session_id, sequence)` monotonic per session. Cross-participant events are delivered by the relay as pairwise-encrypted payloads per ADR-010; each receiving daemon validates the sender signature, decrypts, and appends the event to its own log with its own per-session sequence number.
- **Steel man:** Cryptographically coherent with the zero-knowledge relay. Matches the ecosystem norm for local-first and collaborative-editor systems (Kleppmann local-first, Automerge, Zed, Replicache). Each daemon is authoritative for its own view and can replay offline. No trust is placed in the relay beyond message routing. Schema already de facto implements this.
- **Weaknesses:** Cross-participant audit is federated — no single query spans all peers. Daemons may disagree on the interleaving of events that arrived concurrently from different peers. Audit export is a multi-daemon collection operation.

### Option A: Shared Postgres event log (Rejected for V1; retained as V1.1 candidate)

- **What:** One `session_events_shared` append-only table in Postgres. All participants' daemons append session events with a server-stamped global monotonic sequence. Under MLS group encryption (V1.1), events are stored as MLS ciphertext envelopes the server cannot read but can sequence and route.
- **Steel man:** Cross-participant audit is a single SQL query. Canonical event sequence with deterministic interleaving. No federated-log reconciliation. Linear proves the pattern is viable for collaborative + offline + real-time software with server-held plaintext.
- **Why rejected for V1:** V1's relay encryption (pairwise X25519 + XChaCha20-Poly1305 per ADR-010) produces per-recipient ciphertexts, not a group-encrypted envelope. Appending per-recipient ciphertexts to a shared table produces a log the server cannot index, query, or audit coherently — which removes the only reason to choose Option A. Appending plaintext to a shared server table violates ADR-010's relay trust model.
- **Why retained as V1.1 candidate:** Once ADR-010's MLS promotion gates clear (audit + interop + 4-week soak), the relay can participate in group-key distribution and store a single MLS-ciphertext envelope per event. At that point the cross-participant audit argument becomes evaluable on its merits against the federated model's empirical trade-offs.

## Reversibility Assessment

- **Reversal cost:** Adding a `session_events_shared` table at V1.1 is a strictly additive migration. Per-daemon logs remain authoritative for local replay; the shared log is populated in parallel for cross-participant audit. No V1 behavior is removed.
- **Blast radius:** `shared-postgres-schema.md` (one new table), [Spec-006](../specs/006-session-event-taxonomy-and-audit-log.md) (adds cross-participant audit semantics), [Spec-015](../specs/015-persistence-recovery-and-replay.md) (optional: shared log as a cross-participant replay source). No local schema churn.
- **Migration path:** V1.1 introduces the shared log alongside per-daemon logs. Events continue to be emitted locally. A shared-log projector appends MLS-ciphertext envelopes to Postgres with global sequence numbers. Cross-participant audit queries the shared log; per-daemon replay continues unchanged.
- **Point of no return:** None at V1. The Option B → Option A path is additive. The re-evaluation trigger is ADR-010 MLS promotion gate completion.

## Consequences

### Positive

- V1 ships without waiting for MLS promotion gates.
- Cryptographically coherent with the zero-knowledge relay: the relay sees ciphertext and routes it; it does not own any log.
- Matches local-first ecosystem precedent (Kleppmann, Automerge, Zed, Replicache).
- Each daemon is authoritative for its own view and can replay offline.
- Reduces the shared-Postgres write path from per-event to per-coordination-record, lowering hosted SaaS operational load.

### Negative (accepted trade-offs)

- **Federated audit.** Cross-participant audit spans multiple daemons. An operator investigating "what happened in session X between 14:02 and 14:05?" collects log exports from every participant's daemon and merges them. There is no single-query shortcut. This is the explicit accepted cost of pairwise V1 encryption.
- **Per-daemon sequence semantics.** Each daemon's `sequence` is monotonic only within its own log. Daemons may disagree on the ordering of events that arrived from different peers at overlapping wall-clock times. Consumers that need cross-daemon ordering must use wall-clock timestamps plus origin-participant-id tiebreakers, or Hybrid Logical Clocks (BL-076) — never raw per-daemon sequence numbers.
- **Cross-participant replay is reconstruction, not canonical read.** Replay of what Alice observed is replay of Alice's local log. Replay of what Bob observed is replay of Bob's local log. There is no ground-truth "session timeline" separate from what each participant saw. Divergent views are an expected property, not a defect.

### Unknowns

- Whether V1.1 will actually promote Option A or whether the federated-audit model proves sufficient in production and Option A gets deferred further. Depends on customer demand for single-query cross-participant audit and on MLS promotion gate status.
- How [BL-076 Hybrid Logical Clocks](../archive/backlog-archive.md) interacts with per-daemon sequence numbers. BL-076 is independent of this decision and addresses the ordering problem at the event-taxonomy level.

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| Kleppmann, Wiggins, van Hardenberg, McGregor — "Local-First Software" (Ink & Switch / Onward! 2019) | Academic paper | Per-device copy is the primary authoritative copy; cloud copies are secondary | [inkandswitch.com/essay/local-first](https://www.inkandswitch.com/essay/local-first/), [martin.kleppmann.com/papers/local-first.pdf](https://martin.kleppmann.com/papers/local-first.pdf) |
| Automerge documentation | Official documentation | Per-replica hash-DAG; merge by commutativity; no central sequencer | [automerge.org](https://automerge.org/), [automerge.org/docs/hello](https://automerge.org/docs/hello) |
| Zed — "CRDTs for mutable trees" and "The full spectrum of collaboration" | Engineering blog (Zed Industries) | Per-replica CRDT logs with central routing server — closest topology match to V1 | [zed.dev/blog/crdts](https://zed.dev/blog/crdts), [zed.dev/blog/full-spectrum-of-collaboration](https://zed.dev/blog/full-spectrum-of-collaboration) |
| Replicache — "How it works" | Official documentation (Rocicorp) | Split: per-client mutation log plus server-authoritative canonical state — legitimizes the per-participant-pending plus server-merge split | [doc.replicache.dev/concepts/how-it-works](https://doc.replicache.dev/concepts/how-it-works) |
| Linear sync engine — scaling blog + CTO-endorsed reverse-engineering repo | Engineering blog + RE repo | Counterexample: shared server-authoritative log with global monotonic `lastSyncId`; viable because server sees plaintext | [linear.app/now/scaling-the-linear-sync-engine](https://linear.app/now/scaling-the-linear-sync-engine), [github.com/wzhudev/reverse-linear-sync-engine](https://github.com/wzhudev/reverse-linear-sync-engine) |
| Oskar Dudycz — event-sourcing antipatterns (event-driven.io) | Community blog | Partial null result — Dudycz's named antipatterns (State Obsession, Property Sourcing, Clickbait Events, Passive Aggressive Events, CRUD Sourcing) do not include "shared event log across participants" — **cited as `unverified — cite needed`** for the "shared-log is an event-sourcing antipattern" claim; not load-bearing for this ADR | [event-driven.io/en/anti-patterns](https://event-driven.io/en/anti-patterns/) |

### Related ADRs

- [ADR-004 — SQLite Local State And Postgres Control Plane](./004-sqlite-local-state-and-postgres-control-plane.md) — establishes the two-store split this ADR scopes event-sourcing against.
- [ADR-010 — PASETO + WebAuthn + MLS Auth](./010-paseto-webauthn-mls-auth.md) — the relay trust model and MLS promotion gates that determine Option A's V1.1 availability.
- [ADR-015 — V1 Feature Scope Definition](./015-v1-feature-scope-definition.md) — the V1 / V1.1 / V2 triage this decision respects.

### Related Specs And Docs

- [Spec-006 — Session Event Taxonomy and Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md) — event taxonomy the per-daemon logs carry.
- [Spec-015 — Persistence, Recovery, and Replay](../specs/015-persistence-recovery-and-replay.md) — replay semantics over per-daemon logs.
- [Data Architecture §Event-Sourcing Scope](../architecture/data-architecture.md) — aligned with this ADR.
- [vision.md §Session Engine](../vision.md) — aligned with this ADR.

## Decision Log

| Date | Event | Notes |
| --- | --- | --- |
| 2026-04-17 | Accepted | V1 ships Option B per-daemon local event logs; Option A retained as V1.1 candidate gated on ADR-010 MLS promotion gates; BL-046 exit criteria satisfied |
