# ADR-018: Cross-Version Compatibility

| Field         | Value                                                 |
| ------------- | ----------------------------------------------------- |
| **Status**    | `accepted`                                            |
| **Type**      | `Type 2 (one-way door)`                               |
| **Domain**    | `Persistence / Wire Format / Multi-Node Coordination` |
| **Date**      | `2026-04-18`                                          |
| **Author(s)** | `Claude (AI-assisted)`                                |
| **Reviewers** | `Accepted 2026-04-18`                                 |

## Context

AI Sidekicks is a distributed collaboration product. Multiple participants run local daemons on their own machines, and those daemons emit and consume `EventEnvelope` records via a shared control plane (Postgres) and a local audit log (SQLite). The product ships as OSS + self-hostable per [ADR-020: V1 Deployment Model and OSS License](./020-v1-deployment-model-and-oss-license.md) — participants are on different machines with different update cadences, so **mixed-version participation is the normal case, not an edge case**.

The wire format carried between participants is the `EventEnvelope`, defined in [Spec-006: Session Event Taxonomy and Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md). Spec-006 line 69 already declares `EventEnvelope` must be versioned and lists `version` as an envelope-level field in the canonical serialization order (Spec-006 line 311). What Spec-006 does not yet document is the **semantics** of that field: who sets it, who validates it, what happens on mismatch, and how event-type evolution interacts with it.

Additionally, the event log is append-only and tamper-evident — row-chained via BLAKE3 and Ed25519-signed per Spec-006 §Integrity Protocol. Any version-evolution story must preserve that immutability: we cannot rewrite the log on upgrade, and stubbed unknowns must remain signature-verifiable forever.

This ADR closes the semantics gap. It is Type 2 because the wire format is a one-way door: once an envelope version is emitted into a production audit log, it is there forever. The cost of a bad decision scales with the installed base.

## Problem Statement

How do we evolve `EventEnvelope` and event-type semantics across a bidirectionally-skewed multi-node fleet — where different participants may run different client versions simultaneously — without data loss, crashes, silent divergence, or audit-log rewrites?

### Trigger

- [Spec-006](../specs/006-session-event-taxonomy-and-audit-log.md) declares `EventEnvelope.version` as a canonical field but provides no semantics; emitters and receivers have no contract to implement against.
- Plan-001 (shared session core) needs a settled wire-format contract before authoring emitter code, per the canonical plan ordering.
- BL-064 (event-taxonomy cascade) will add ~20+ new event types mid-V1-lifecycle. The first envelope-relevant addition will arrive before Plan-015 lands, so the version scheme must be specified before then.
- BL-065 pre-decided the approach (envelope version, `min_client_version` floor, accept-and-stub unknowns, major/minor split, minor-is-additive-only). This ADR validates that approach against 2024–2026 industry precedent and closes the remaining gotchas.

## Decision

1. **`EventEnvelope.version` is a semver string `"MAJOR.MINOR"`** (no PATCH on the wire). Integer form is insufficient because it cannot distinguish additive minor bumps from breaking major bumps — and that distinction is load-bearing for the rule below.

2. **Producer writes its own outgoing wire version at emit time.** `.version` is never copied from a received event. Stubbed-unknown events record their original received version separately in stub metadata, so round-tripping cannot corrupt the field.

3. **Session metadata carries `min_client_version`** as a monotonic-raise floor. Once raised, the floor never lowers within that session's lifetime. Raising the floor disconnects any currently-connected below-floor clients, which must upgrade and rejoin. **A mistakenly-raised floor cannot be reversed within a session** (monotonicity is absolute); operators who raise a floor to a MAJOR that is subsequently retracted — e.g., a MAJOR bump re-released as a higher MAJOR after a semantic-break discovery — must abandon the affected session(s) and create new ones to recover below-floor participants.

4. **Clients below `min_client_version` may READ but NOT WRITE.** A below-floor write attempt returns typed `VERSION_FLOOR_EXCEEDED`, does not crash, and the client remains joined in read-only state (graceful degradation, not ejection).

5. **Unknown event types MUST persist as version stubs, never dropped.** A version stub is a distinct artifact from the compaction stubs defined in [Spec-006 §Event Compaction Policy](../specs/006-session-event-taxonomy-and-audit-log.md#event-compaction-policy) — a compaction stub has had its `payload` removed, whereas a version stub preserves the full original canonical bytes verbatim. The version stub preserves those canonical bytes (so the Ed25519 signature remains verifiable per Spec-006 §Integrity Protocol) plus a version-stub-metadata record (`original_version`, `original_type`, `received_at`, `stub_reason`). The canonical row's `.version` field stays the producer's original — version-stubbing is a read-side behavior, not a rewrite.

6. **Upcaster chain on read, never log rewrite.** When a client upgrades and can now interpret previously-version-stubbed events, transformation happens at dispatch time via an explicit upcaster chain keyed on `(original_version, original_type)`. The upcaster chain is a sequence of pure functions, each registered for a specific `(original_version, original_type) → (target_version, target_type)` transformation; on read, the receiver looks up the matching chain entry by the stub's metadata and produces the typed event for application-layer dispatch. The immutable log is never rewritten. This matches event-sourcing discipline established by [event-driven.io's versioning guidance](https://event-driven.io/en/how_to_do_event_versioning/).

7. **MAJOR envelope bumps are breaking.** They require a `min_client_version` floor raise and cluster-wide upgrade coordination. Minor versions within the same MAJOR MUST be bidirectionally forward-compatible.

8. **MINOR envelope bumps are additive-only.** Additive = new optional fields with defaults, new event types, new enum values. Forbidden: renaming fields, changing field types, changing field semantics, adding required fields, adding required semantic invariants (e.g., "field X must now be a valid URL"). Semantic invariant changes REQUIRE a MAJOR bump — this is author discipline enforced via the reviewer checklist in §Decision Validation; there is no automated semantic-equivalence gate (Schema Registry cannot catch this either, per precedent).

9. **Event-type registry governance for V1 uses an accept-and-stub model.** Receivers stub anything they don't recognize; there is no central event-type registration gate. A control-plane-hosted registry is deferred to V1.1 — see Tripwire 2.

10. **Negotiation failures surface as typed errors, never crashes.** Join-time `VERSION_CEILING_EXCEEDED` (client above server max) and `VERSION_FLOOR_EXCEEDED` (client below server min) each carry a human-readable upgrade/downgrade path in the error payload. Both codes are forward-declared here and MUST be registered in [Error Contracts](../architecture/contracts/error-contracts.md) alongside the existing typed error registry before the first Plan-001 emitter lands.

11. **Retro-replay durability contract.** Version stubs remain parseable for the full audit-retention lifetime. The version-stub-metadata schema is versioned separately from envelope `.version` so future stub-schema evolution is itself versionable. Compaction policy (Spec-006 §Event Compaction Policy) MUST NOT compact a version stub while it remains un-re-interpreted — compaction would remove the `payload` bytes that later upcasters need as input. Once a version stub has been re-interpreted at least once (the upcaster chain for its `(original_version, original_type)` has fired in at least one client session), the row is eligible for compaction on the normal Spec-006 schedule, and its Ed25519 signature-verifiability is relinquished at that point (the same trade-off every compacted event accepts — Spec-006 already documents that compaction removes `payload` from the signed canonical form).

### Thesis — Why This Option

The pre-decided approach composes three proven 2024–2026 industry patterns against the specific constraints of a peer-to-peer multi-node product:

- **Kubernetes version-skew policy** (v1.35) establishes the asymmetric read-tolerance principle — old components may read newer peers' output but may not write newer-format messages. AI Sidekicks borrows the asymmetry and the "no-skip-minors" discipline. ([Kubernetes Version Skew Policy](https://kubernetes.io/releases/version-skew-policy/), accessed 2026-04-18.)
- **Confluent Schema Registry's FORWARD_TRANSITIVE** compatibility class establishes the additive-only-minor-bump discipline checked against _all_ historical versions, not just the immediately-prior one. AI Sidekicks borrows the transitivity (our event log is immutable, so every historical envelope must remain parseable by every future client). ([Schema Evolution and Compatibility](https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html), accessed 2026-04-18.)
- **Protobuf unknown-field preservation** (Editions / proto3) establishes the ignore-and-preserve round-trip discipline that makes stubs work. AI Sidekicks lifts this to the event-type granularity — whole unknown events are persisted verbatim for later re-interpretation. ([Proto Best Practices](https://protobuf.dev/best-practices/dos-donts/), accessed 2026-04-18.)

Together, these give us a scheme that handles bidirectional multi-node skew without requiring a central schema-registration gate (which we cannot justify for V1 scope) and without sacrificing audit immutability (which Spec-006's integrity protocol requires). The peer-side enforcement model is the right fit for an OSS self-hostable distribution where no single operator owns all participants.

### Antithesis — The Strongest Case Against

The simpler alternative is to pin the envelope version at session creation and refuse mixed-version participation entirely. Under this model, every participant must run the exact version the session was created with; a version mismatch at join is a hard rejection. This eliminates the upcaster chain, the stub persistence, the negotiation protocol, the reviewer-checklist author discipline, and most of the failure modes in §Failure Mode Analysis. For a small-team product where all participants can be asked to upgrade together, this is cheap operationally and defensible on simplicity grounds. The asymmetric read/write tolerance only pays off if mixed-version participation is empirically common — and we don't yet have V1 data to prove it will be.

### Synthesis — Why It Still Holds

Pin-at-session is a single-tenant assumption being pushed into a multi-tenant product. V1 ships as OSS and self-hostable ([ADR-020](./020-v1-deployment-model-and-oss-license.md)). Self-hosted operators will roll upgrades on their own schedule; guest participants joining from a different self-hosted instance will often be on a different version than the host. There is no "tell everyone to upgrade" channel for an OSS product. The Kubernetes version-skew policy exists precisely because heterogeneous deployment is the reality of distributed systems — treating mixed versions as "the bad case" rather than "the normal case" has historically produced systems that are brittle at exactly the moment they need to be flexible. Taking on the upcaster chain and stub persistence now is the cost of shipping a product that can evolve its wire format at all after V1. The alternative is either a frozen wire format (no new event types ever) or a forced-lockstep upgrade model that breaks the self-hosted guest-join path.

## Alternatives Considered

### Option A: Envelope version + `min_client_version` + accept-and-stub + upcaster chain on read (Chosen)

- **What:** The decision above.
- **Steel man:** Composes three proven industry patterns. Handles bidirectional multi-node skew. Preserves audit immutability. Avoids central-registry dependency in V1. Peer-side enforcement matches OSS self-hostable distribution model.
- **Weaknesses:** Author discipline burden (semantic breaks can slip past the structural checker). Upcaster chain grows with every MAJOR bump and must be actively maintained. Stub storage is unbounded until re-interpretation.

### Option B: Pin session version at creation; refuse mixed-version participation (Rejected)

- **What:** Session metadata carries `wire_version` set at creation. All participants must run exactly that version. Version mismatch at join is a hard rejection.
- **Steel man:** Dramatically simpler. No upcaster chain. No stub persistence. No negotiation protocol. No reviewer-checklist author discipline. Failure modes collapse to a single "version mismatch" error.
- **Why rejected:** Single-tenant assumption incompatible with V1 OSS self-hostable distribution. Guest participants joining from a different self-hosted instance will often be on a different version than the host. Forces cluster-wide lockstep upgrades across organizational boundaries, which is operationally unrealistic for an OSS product with no forced-update channel.

### Option C: Central control-plane event-type registry with publish-time rejection (Deferred to V1.1)

- **What:** Like Confluent Schema Registry — a control-plane-hosted registry accepts new event-type schemas and rejects incompatible registrations at publish time.
- **Steel man:** Catches 100% of structural breaks before they reach the wire. Schema Registry's TRANSITIVE-compatibility enforcement is the gold standard for producer-side evolution.
- **Disposition:** Deferred, not rejected. V1 uses accept-and-stub (Option A behavior) because the registry requires control-plane-hosted validation logic and a schema-submission UX that is not in V1 scope per [ADR-015](./015-v1-feature-scope-definition.md). Tripwire 2 below names the revisit gate.

### Option D: Integer version field instead of semver (Rejected)

- **What:** `EventEnvelope.version` is a monotonically-increasing integer.
- **Steel man:** Simpler to parse, no format ambiguity, trivial comparison.
- **Why rejected:** Loses the MAJOR/MINOR distinction that makes the forward-compat rule ("minors must be additive-only") expressible. An integer scheme either treats every bump as breaking (equivalent to MAJOR-only) or requires a parallel "breaking vs. additive" flag — both of which are worse than just using semver.

### Option E: Global wire version without session-level floor (Rejected)

- **What:** There is one global `wire_version`; all sessions share it.
- **Steel man:** Trivially consistent across the entire product installation.
- **Why rejected:** Forces cluster-wide freeze for any upgrade because all sessions must upgrade together. Breaks the independent-session-lifecycle invariant in the session model. A 10-year-old session and a just-created session would be forced to share a wire version — either the old session's audit log gets invalidated on upgrade, or new sessions are blocked from using new event types until the oldest audit log retires.

## Assumptions Audit

| #   | Assumption                                                                                                                                             | Evidence                                                                                                                                                                                                    | What Breaks If Wrong                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | Mixed-version participation is common in V1.                                                                                                           | V1 ships as OSS + self-hostable ([ADR-020](./020-v1-deployment-model-and-oss-license.md)); participants are on independently-managed machines; guest joins cross self-hosted-instance boundaries.           | Pin-at-session (Option B) becomes the better choice; most of this ADR collapses to "version must match exactly." |
| 2   | Event-log durability guarantees stubs remain parseable for the full audit-retention lifetime.                                                          | Event-sourcing immutability rule; SQLite forward-only migrations; Postgres migration tool with required-up migrations per [data-architecture.md](../architecture/data-architecture.md) §Migration Strategy. | Stubs become unparseable on storage-format evolution; upcaster chain loses its input.                            |
| 3   | Semver is sufficient to distinguish additive vs. breaking changes when paired with reviewer discipline.                                                | Schema Registry FORWARD_TRANSITIVE uses exactly this split; Protobuf Editions relies on author discipline for semantic-equivalence.                                                                         | Authors ship semantic breaks inside MINOR bumps; receivers crash or silently misinterpret.                       |
| 4   | Receivers can safely persist unknown-type payloads without schema validation, because envelope-level Ed25519 signature still covers the payload bytes. | Spec-006 §Canonical Serialization Rules lists `payload` as a signed field regardless of type-registry state; signature verification is independent of type-handler registration.                            | Stubs persist unverified payloads; attack surface opens via unsigned-content replay.                             |
| 5   | The upcaster chain can be authored and maintained safely enough to run on every replay without introducing non-determinism.                            | `event-driven.io` versioning guidance establishes the pattern; upcasters are pure functions over typed inputs, versioned and tested independently.                                                          | Upcaster bugs cause replay drift; audit-log-derived projections diverge across clients.                          |

## Failure Mode Analysis

| Scenario                                                             | Likelihood      | Impact | Detection                                                                                                                                                                | Mitigation                                                                                                                              |
| -------------------------------------------------------------------- | --------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Below-floor client write rejected with typed error                   | High (expected) | Low    | `VERSION_FLOOR_EXCEEDED` error telemetry                                                                                                                                 | UX prompt displays upgrade path; client remains joined read-only                                                                        |
| MINOR bump ships a semantic invariant change (author mistake)        | Low             | High   | Reviewer checklist miss; CI compat-test suite; bug report from below-floor client                                                                                        | Patch-release as MAJOR bump; issue advisory; invalidate the MINOR and re-release as MAJOR                                               |
| Version stub storage grows unbounded because MAJOR bumps are rare    | Low             | Med    | Storage metrics on `session_events.version_stub_metadata` column                                                                                                         | Version stubs excluded from compaction until re-interpreted once; expected acceptable overhead at expected MAJOR cadence (1–2 per year) |
| Upcaster chain bug corrupts replay                                   | Low             | High   | Replay-vs-canonical diff in CI; per-upcaster unit tests                                                                                                                  | Upcasters versioned and rollback-able; halt replay and surface `audit_integrity_failed` event                                           |
| Two peers cannot agree on `min_client_version` at join               | Med             | Low    | `VERSION_FLOOR_EXCEEDED` / `VERSION_CEILING_EXCEEDED` typed errors                                                                                                       | UX displays mutual upgrade path; session metadata shows which participant is below/above                                                |
| `min_client_version` raise mid-session disconnects in-flight writers | Med             | Med    | Disconnect telemetry with `VERSION_FLOOR_EXCEEDED` reason                                                                                                                | Clients surface re-join prompt; in-flight writes lost per session's at-most-once delivery contract                                      |
| Session-metadata floor field desync across nodes                     | Low             | Med    | Control-plane is authoritative for session metadata ([ADR-004](./004-sqlite-local-state-and-postgres-control-plane.md)); reconciliation via Spec-003 runtime-node-attach | Peer reads floor from control plane at join; never trusts peer-reported floor                                                           |

## Reversibility Assessment

- **Reversal cost:** HIGH. The wire format is a one-way door. Once MAJOR version N is in the field (emitted to any production audit log), it exists forever — there is no "un-ship" path. Changing the semver/integer decision or the stub-persistence rule after V1 launch would require a coordinated cluster-wide migration with a separate ADR.
- **Blast radius:** Every envelope ever written in every deployment. Every local SQLite audit log. Every control-plane `session_events` row. Every upcaster implementation in the daemon.
- **Migration path:** The upcaster chain IS the migration path. There is no separate rollback mechanism — rolling back means shipping an upcaster that transforms the newer version to the older.
- **Point of no return:** First `EventEnvelope` emitted with `version = "1.0"` in a non-test environment. Realistically this happens the first time any production daemon starts and emits `session.created`.

## Consequences

### Positive

- Mixed-version fleet supported without forced-lockstep upgrades; self-hosted operators can roll independently.
- Wire format is evolvable post-V1 without user-visible breakage on additive changes.
- Audit log immutability preserved — stubs persist verbatim, upcasters run on read.
- Enforcement is local-to-peer; no central event-type registry dependency in V1.
- Typed errors (`VERSION_FLOOR_EXCEEDED`, `VERSION_CEILING_EXCEEDED`) make version mismatches debuggable rather than crash-producing.

### Negative (accepted trade-offs)

- Authors bear semantic-equivalence discipline burden. Reviewer checklist catches most; it will not catch 100%.
- Upcaster chain grows with every MAJOR bump and must be actively maintained.
- Stub storage is unbounded until re-interpretation; bounded by MAJOR-bump cadence (expected 1–2 per year).
- Receivers must validate envelope signatures on stubs despite not understanding the payload — non-trivial crypto work runs on untrusted content.

### Unknowns

- Empirical cadence of MAJOR bumps post-V1; drives storage growth of stubs.
- Actual upcaster-chain replay cost at scale; measured once Plan-015 and the first MINOR bump ship.
- Whether the reviewer checklist catches semantic breaks reliably enough in practice.

## Decision Validation

### Pre-Implementation Checklist

- [x] All unvalidated assumptions have a validation plan (Plan-015 replay tests; MINOR-bump compat-test suite; Tripwire 1 revisit)
- [x] At least one alternative was seriously considered and steel-manned (Options B and C both steel-manned; Options D and E documented)
- [x] Antithesis was reviewed (Thesis/Antithesis/Synthesis triad in the Decision section)
- [x] Failure modes have detection mechanisms
- [x] Point of no return is identified (first production `session.created` emission)

### Reviewer Checklist for MINOR Bumps

Every proposed MINOR bump MUST be reviewed against this checklist before landing. A failed item flips the bump to MAJOR:

- [ ] No renamed fields (`old_name` → `new_name` is breaking; use a separate new field and deprecate the old).
- [ ] No changed field types (`int` → `string` is breaking).
- [ ] No changed field semantics (the field MUST mean the same thing to BOTH a reader that ignored the bump AND a reader that parsed it — a change that coincidentally reads OK for the bump-ignoring path but shifts meaning for the bump-aware path is still a semantic break and requires a MAJOR bump).
- [ ] No new required fields (every new field has a default or is optional).
- [ ] No new required semantic invariants on existing fields (e.g., "field X must now be a valid URL" is breaking even if X was always a string).
- [ ] No removed event types (use deprecation path; retire event-type strings permanently per Protobuf reserved-tag precedent).
- [ ] No removed enum values (as above).
- [ ] New event types have a payload schema registered in Spec-006.
- [ ] Upcaster-chain entry added if the new minor introduces typed behaviors that older clients must be able to stub.

### Success Criteria

| Metric                                                                              | Target                                                                                      | Measurement Method      | Check Date               |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------- | ------------------------ |
| MINOR bump (e.g., `1.0` → `1.1`) preserves all existing replay output               | 100% of replay test suite passes across all historical MINOR versions within the same MAJOR | CI replay-diff suite    | First MINOR bump post-V1 |
| Below-floor client write attempt yields typed `VERSION_FLOOR_EXCEEDED`, never crash | 100% of below-floor write attempts in contract-test matrix                                  | CI contract tests       | Plan-015 landing         |
| Version stub re-interpretation replay output equals native replay                   | Byte-identical diff = 0 across reserved event-type test fixtures                            | CI upcaster-chain tests | First MAJOR bump         |
| Unknown-type events persist as version stubs with verifiable Ed25519 signatures     | 100% of version stubs pass Spec-006 §Integrity Protocol verification                        | CI integrity test       | First MINOR bump         |

### Tripwires (Revisit Triggers)

1. **MAJOR bump required within 12 months of V1 launch.** — Reassess whether per-session wire-version pinning (Option B) is simpler in practice than ongoing upcaster-chain maintenance. Quantitative input: cost of upcaster maintenance vs. cost of cluster-wide forced upgrade.
2. **Self-hosted operator reports stub storage >5% of session event log size, or a provider driver ships an event type that triggers receiver stubbing across >10% of sessions.** — Evaluate promoting Option C (control-plane event-type registry) to V1.1. Operators signal pain; registry becomes worth its scope cost.
3. **Upcaster-chain bug causes data-integrity issue in production.** — Treat as Sev-1. Immediate rollback of the offending chain entry. Reassess whether the upcaster-chain-on-read pattern is empirically safe enough versus a frozen-wire alternative.
4. **Two peers from different self-hosted instances repeatedly fail to join due to floor mismatches.** — Evaluate whether `min_client_version` should relax from a hard floor to a soft warning for cross-instance joins; informs the OSS-ecosystem coordination story.

## References

### Research Conducted

| Source                                                         | Type                                 | Key Finding                                                                                                                                                       | URL/Location                                                                                                          |
| -------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Kubernetes Version Skew Policy (v1.35)                         | Upstream policy                      | Asymmetric read-tolerance (old reads new OK; old writes new NOT OK); no-skip-minors; anchor-at-apiserver model                                                    | <https://kubernetes.io/releases/version-skew-policy/> (accessed 2026-04-18)                                           |
| Confluent Schema Registry — Schema Evolution and Compatibility | Platform documentation               | FORWARD_TRANSITIVE compatibility class matches additive-only minor-bump pattern, checked against all historical versions                                          | <https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html> (accessed 2026-04-18) |
| Protobuf — Proto Best Practices                                | Language guide                       | Unknown-field preservation discipline; reserved-tag rule; "changing a field number is equivalent to deletion and re-addition"                                     | <https://protobuf.dev/best-practices/dos-donts/> (accessed 2026-04-18)                                                |
| Protobuf — Language Guide (Editions)                           | Language guide                       | Editions-based evolution; forward-compat discipline for wire-format changes                                                                                       | <https://protobuf.dev/programming-guides/editions/> (accessed 2026-04-18)                                             |
| CloudEvents v1.0.2 Specification                               | Specification                        | `specversion` attribute; silent-ignore discipline for unknown content (weaker precedent; spec has never bumped from 1.0, so no field-tested MAJOR-bump precedent) | <https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md> (accessed 2026-04-18)                           |
| How to (not) do the events versioning?                         | Industry commentary (event sourcing) | Upcaster-chain on read; never rewrite log; events immutable                                                                                                       | <https://event-driven.io/en/how_to_do_event_versioning/> (accessed 2026-04-18)                                        |

### Related ADRs

- [ADR-004: SQLite Local State and Postgres Control Plane](./004-sqlite-local-state-and-postgres-control-plane.md) — persistence substrates; both sides observe the wire format, control plane is authoritative for session metadata including `min_client_version`.
- [ADR-015: V1 Feature Scope Definition](./015-v1-feature-scope-definition.md) — V1 scope gate; Option C (central registry) deferred out of V1 per this scope decision.
- [ADR-017: Shared Event-Sourcing Scope](./017-shared-event-sourcing-scope.md) — V1 local-per-daemon audit-log topology; establishes that event log is not replicated to control plane, which amplifies the peer-side enforcement requirement.
- [ADR-020: V1 Deployment Model and OSS License](./020-v1-deployment-model-and-oss-license.md) — OSS + self-hostable distribution model; load-bearing for Assumption #1 (mixed-version participation is common).

### Related Specs

- [Spec-006: Session Event Taxonomy and Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md) — `EventEnvelope.version` field declaration; §EventEnvelope Version Semantics subsection documents the semantics this ADR establishes.
- [Spec-015: Persistence, Recovery, and Replay](../specs/015-persistence-recovery-and-replay.md) — replay path for upcaster chain; audit-log hydration semantics.

### Related Architecture Docs

- [Data Architecture §Cross-Version Compatibility](../architecture/data-architecture.md#cross-version-compatibility) — runtime wire-format skew tolerance; distinguishes from §Migration Strategy (DDL / schema migrations).

### Related Backlog Items

- [BL-064: Phase 6 event-type cascade](../archive/backlog-archive.md) — first MINOR bump candidate; adds ~20+ new types under the additive-only rule.
- [BL-065: Write ADR-018 Cross-Version Multi-Node Compatibility](../archive/backlog-archive.md) — this ADR closes this backlog item.

## Decision Log

| Date       | Event              | Notes                                                                                                                                                                                                                                             |
| ---------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-04-18 | Research conducted | Opus 4.7 subagent validated pre-decided approach against Kubernetes Version Skew Policy, Confluent Schema Registry FORWARD_TRANSITIVE, Protobuf unknown-field preservation, and CloudEvents v1.0.2; 7 gotchas surfaced and addressed in §Decision |
| 2026-04-18 | Proposed           | Drafted against BL-065 exit criteria                                                                                                                                                                                                              |
| 2026-04-18 | Accepted           | ADR accepted as cross-version compatibility contract for `EventEnvelope` evolution                                                                                                                                                                |
