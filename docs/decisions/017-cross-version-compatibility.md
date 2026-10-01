# ADR-017: Cross-Version Compatibility

| Field         | Value                                                 |
| ------------- | ----------------------------------------------------- |
| **Status**    | `accepted`                                            |
| **Type**      | `Type 2 (one-way door)`                               |
| **Domain**    | `Persistence / Wire Format / Multi-Node Coordination` |
| **Date**      | `2026-04-18`                                          |
| **Author(s)** | `Claude (AI-assisted)`                                |
| **Reviewers** | `Accepted 2026-04-18`                                 |

## Context

AI Sidekicks is a distributed product. One user runs the background service on their own machines and drives it from their own devices through their own relay ([ADR-019: V1 Deployment Model and OSS License](./019-v1-deployment-model-and-oss-license.md)); the service writes `EventEnvelope` records to its local audit log (SQLite) and serves them to every client. The app and the service are updated separately, and a phone app takes each linked machine's console from that machine, staged for its next start, so **mixed versions are the normal case, not an edge case**.

The wire format the service writes and its clients read is the `EventEnvelope`, defined in [Spec-005: Session Event Taxonomy and Audit Log](../specs/005-session-event-taxonomy-and-audit-log.md). [Spec-005 §Interfaces And Contracts](../specs/005-session-event-taxonomy-and-audit-log.md#interfaces-and-contracts) declares `EventEnvelope` must be versioned and lists `version` as an envelope-level field. This record sets the **semantics** of that field — who sets it, who validates it, what happens on mismatch, and how event-type evolution interacts with it — which [Spec-005 §EventEnvelope Version Semantics](../specs/005-session-event-taxonomy-and-audit-log.md#eventenvelope-version-semantics) carries.

Additionally, the event log is append-only. Any version-evolution story must preserve that immutability: we cannot rewrite the log on upgrade.

It is Type 2 because the wire format is a one-way door: once an envelope version is emitted into a production audit log, it is there forever. The cost of a bad decision scales with the installed base.

## Problem Statement

How do we evolve `EventEnvelope` and event-type semantics when the app, the background service and the phone front ends are updated separately — so a user's devices and machines run different versions at the same time — without data loss, crashes, silent divergence, or audit-log rewrites?

### Trigger

- Every emitter and receiver of `EventEnvelope.version` ([Spec-005](../specs/005-session-event-taxonomy-and-audit-log.md)) implements against one contract.
- Plan-001 (session core) writes its emitter code against the wire-format contract, so the contract comes first.
- The event taxonomy keeps growing through V1, and the first envelope-relevant addition arrives before Plan-012 lands, so the version scheme is specified before then.

## Decision

1. **`EventEnvelope.version` is a semver string `"MAJOR.MINOR"`** (no PATCH on the wire). Integer form is insufficient because it cannot distinguish additive minor bumps from breaking major bumps — and that distinction is load-bearing for the rule below.

2. **Producer writes its own outgoing wire version at emit time.** `.version` is never copied from a received event. Stubbed-unknown events record their original received version separately in stub metadata, so round-tripping cannot corrupt the field.

3. **The app and the service agree a version range at the handshake.** Each app accepts its own service version and the previous one. The range is checked once per connection, in the `DaemonHello` / `DaemonHelloAck` exchange; a session carries no version floor of its own.

4. **Outside the range, the console is read-only and names the side that is behind.** The service answers an out-of-range `DaemonHello` with `DaemonHelloAck { compatible: false, reason }`, where `reason` is `version.floor_exceeded` (the app is older than the service accepts) or `version.ceiling_exceeded` (the app is newer than the service knows). The app draws that machine read-only ([Spec-021](../specs/021-desktop-app-and-renderer.md)), and the working line names the side that is behind, the app or the service, with a press to its fix: the app's own update, or `Update the background service` on Runtime. Nothing crashes and nothing is disconnected.

5. **Unknown event types MUST persist as version stubs, never dropped.** A version stub preserves the full original canonical bytes verbatim, plus a version-stub-metadata record (`original_version`, `original_type`, `received_at`, `stub_reason`). The canonical row's `.version` field stays the producer's original — version-stubbing is a read-side behavior, not a rewrite.

6. **Upcaster chain on read, never log rewrite.** When a client upgrades and can now interpret previously-version-stubbed events, transformation happens at dispatch time via an explicit upcaster chain keyed on `(original_version, original_type)`. The upcaster chain is a sequence of pure functions, each registered for a specific `(original_version, original_type) → (target_version, target_type)` transformation; on read, the receiver looks up the matching chain entry by the stub's metadata and produces the typed event for application-layer dispatch. The immutable log is never rewritten. This matches event-sourcing discipline established by [event-driven.io's versioning guidance](https://event-driven.io/en/how_to_do_event_versioning/).

7. **MAJOR envelope bumps are breaking.** A MAJOR bump ships in a release whose app still reads the previous service version's envelopes, so the version range in item 3 holds across it. Minor versions within the same MAJOR MUST be bidirectionally forward-compatible.

8. **MINOR envelope bumps are additive-only.** Additive = new optional fields with defaults, new event types, new enum values. Forbidden: renaming fields, changing field types, changing field semantics, adding required fields, adding required semantic invariants (e.g., "field X must now be a valid URL"). Semantic invariant changes REQUIRE a MAJOR bump — this is author discipline enforced via the reviewer checklist in §Decision Validation; there is no automated semantic-equivalence gate (Schema Registry cannot catch this either, per precedent).

9. **The event union in `packages/contracts` is the event-type registry, and receivers accept and stub.** Receivers stub anything they don't recognize. No central registry exists, because the app talks only to its own service version and the one before, so a central registry would govern nothing.

10. **Version failures surface as handshake reasons, never crashes.** The only version refusals are the `version.floor_exceeded` and `version.ceiling_exceeded` reasons on `DaemonHelloAck`, registered in [Error Contracts](../architecture/contracts/error-contracts.md), and the app reads each as the side that is behind (item 4). No write, join or envelope read carries a typed version error.

11. **Retro-replay durability contract.** Version stubs remain parseable for the full audit-retention lifetime. The version-stub-metadata schema is versioned separately from envelope `.version` so future stub-schema evolution is itself versionable. A version stub keeps its bytes until its session is deleted, which deletes it with the session's other rows; background compaction never removes a version stub's bytes.

12. **Provider-CLI skew is a different axis and is not governed here.** This ADR governs skew in shapes this corpus defines — the `EventEnvelope` between the user's own service and its clients, where the version range applies and unknowns are stubbed and re-emitted. A provider vendor owns its own surface and ships it faster than we re-verify, so [Spec-004 §Required Behavior](../specs/004-provider-driver-contract-and-capabilities.md#required-behavior) sets that axis separately: below the floor, refuse; at or above it, admit and decide every capability individually by a zero-turn probe of the running build. Accept-and-stub has no analogue there, because a provider surface that moved cannot be stubbed and replayed, only detected and degraded. Its enforcement is runtime and lives in the daemon's spawn-time floor gate.

13. **Until the first release, nothing is kept for an older daemon.** The additive-only MINOR rule, version stubs and the upcaster chain protect envelopes already written to a production audit log, and they apply from the point of no return ([§Reversibility Assessment](#reversibility-assessment)). Before it, no daemon has shipped: a shape changes in place, and no field is made optional, and no arm is kept, for an older daemon.

### Thesis — Why This Option

The approach composes three proven 2024–2026 industry patterns against the constraints of a product whose app, background service and phone front ends are updated separately:

- **Kubernetes version-skew policy** (v1.35) establishes the asymmetric read-tolerance principle — old components may read newer peers' output but may not write newer-format messages. AI Sidekicks borrows the asymmetry and the "no-skip-minors" discipline. ([Kubernetes Version Skew Policy](https://kubernetes.io/releases/version-skew-policy/), accessed 2026-04-18.)
- **Confluent Schema Registry's FORWARD_TRANSITIVE** compatibility class establishes the additive-only-minor-bump discipline checked against _all_ historical versions, not just the immediately-prior one. AI Sidekicks borrows the transitivity (our event log is immutable, so every historical envelope must remain parseable by every future client). ([Schema Evolution and Compatibility](https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html), accessed 2026-04-18.)
- **Protobuf unknown-field preservation** (Editions / proto3) establishes the ignore-and-preserve round-trip discipline that makes stubs work. AI Sidekicks lifts this to the event-type granularity — whole unknown events are persisted verbatim for later re-interpretation. ([Proto Best Practices](https://protobuf.dev/best-practices/dos-donts/), accessed 2026-04-18.)

Together, these give us a scheme that handles skew in both directions without a central schema-registration gate (which would govern nothing when the app talks only to its own service version and the one before) and without rewriting the log. Enforcement at each end fits a product whose one user updates the app and the service separately.

### Antithesis — The Strongest Case Against

The simpler alternative is to pin the envelope version at session creation and refuse mixed-version participation entirely. Under this model, every device and daemon must run the exact version the session was created with; a version mismatch when one connects is a hard rejection. This eliminates the upcaster chain, the stub persistence, the negotiation protocol, the reviewer-checklist author discipline, and most of the failure modes in §Failure Mode Analysis. For a product where every device and daemon can be upgraded in one step, this is cheap operationally and defensible on simplicity grounds. The asymmetric read/write tolerance only pays off if mixed-version participation is empirically common — and we don't yet have V1 data to prove it will be.

### Synthesis — Why It Still Holds

Pin-at-session assumes every client updates in the same step as the service, and nothing in the product does. The app and the service are updated separately — the app from its own update, the service from Runtime — and a phone app takes each linked machine's console from that machine, staged for its next start. There is no forced-update channel. The Kubernetes version-skew policy exists precisely because heterogeneous deployment is the reality of distributed systems — treating mixed versions as "the bad case" rather than "the normal case" has historically produced systems that are brittle at exactly the moment they need to be flexible. Taking on the upcaster chain and stub persistence now is the cost of shipping a product that can evolve its wire format at all after release. The alternative is either a frozen wire format (no new event types ever) or a forced-lockstep upgrade that leaves a device unable to reach its own machine between updates.

## Alternatives Considered

### Option A: Envelope version + the handshake version range + accept-and-stub + upcaster chain on read (Chosen)

- **What:** The decision above.
- **Steel man:** Composes three proven industry patterns. Handles skew in both directions between the app, the service and the phone front ends. Preserves audit immutability. Needs no central registry. Enforcement at each end fits an app and a service that are updated separately.
- **Weaknesses:** Author discipline burden (semantic breaks can slip past the structural checker). Upcaster chain grows with every MAJOR bump and must be actively maintained. Stub storage is unbounded until re-interpretation.

### Option B: Pin session version at creation; refuse mixed-version participation (Rejected)

- **What:** Session metadata carries `wire_version` set at creation. Every device and daemon must run exactly that version. A version mismatch when one connects is a hard rejection.
- **Steel man:** Dramatically simpler. No upcaster chain. No stub persistence. No negotiation protocol. No reviewer-checklist author discipline. Failure modes collapse to a single "version mismatch" error.
- **Why rejected:** Forces lockstep upgrades across every device and machine at once. The app and the service are updated separately and a phone app's console for a machine can trail that machine until the phone app's next start, so a pinned session would lock a device out of its own machine between updates; the product has no forced-update channel.

### Option C: Central control-plane event-type registry with publish-time rejection (Rejected)

- **What:** Like Confluent Schema Registry — a control-plane-hosted registry accepts new event-type schemas and rejects incompatible registrations at publish time.
- **Steel man:** Catches 100% of structural breaks before they reach the wire. Schema Registry's TRANSITIVE-compatibility enforcement is the gold standard for producer-side evolution.
- **Why rejected:** The event union in `packages/contracts` is already the registry for every shape the service and its clients exchange, and the app talks only to its own service version and the one before, so a control-plane registry would govern nothing.

### Option D: Integer version field instead of semver (Rejected)

- **What:** `EventEnvelope.version` is a monotonically-increasing integer.
- **Steel man:** Simpler to parse, no format ambiguity, trivial comparison.
- **Why rejected:** Loses the MAJOR/MINOR distinction that makes the forward-compat rule ("minors must be additive-only") expressible. An integer scheme either treats every bump as breaking (equivalent to MAJOR-only) or requires a parallel "breaking vs. additive" flag — both of which are worse than just using semver.

### Option E: One global wire version instead of a version on each envelope (Rejected)

- **What:** There is one global `wire_version` for the whole installation; envelopes carry none of their own, and all sessions share it.
- **Steel man:** Trivially consistent across the entire product installation.
- **Why rejected:** Every upgrade would move every session at once. Breaks the independent-session-lifecycle invariant in the session model. A 10-year-old session and a just-created session would be forced to share a wire version — either the old session's audit log gets invalidated on upgrade, or new sessions are blocked from using new event types until the oldest audit log retires. A version on each envelope lets every row keep the version it was written with.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | Mixed versions are common in V1. | The app and the service are updated separately; a phone app's console for a machine may trail that machine until the phone app's next start; the user's devices and machines update independently. | Pin-at-session (Option B) becomes the better choice; most of this ADR collapses to "version must match exactly." |
| 2 | Event-log durability guarantees stubs remain parseable for the full audit-retention lifetime. | Event-sourcing immutability rule; the daemon's one schema, with no upgrade steps, per [data-architecture.md §Schema Evolution](../architecture/data-architecture.md#schema-evolution). | Stubs become unparseable on storage-format evolution; upcaster chain loses its input. |
| 3 | Semver is sufficient to distinguish additive vs. breaking changes when paired with reviewer discipline. | Schema Registry FORWARD_TRANSITIVE uses exactly this split; Protobuf Editions relies on author discipline for semantic-equivalence. | Authors ship semantic breaks inside MINOR bumps; receivers crash or silently misinterpret. |
| 4 | The upcaster chain can be authored and maintained safely enough to run on every replay without introducing non-determinism. | `event-driven.io` versioning guidance establishes the pattern; upcasters are pure functions over typed inputs, versioned and tested independently. | Upcaster bugs cause replay drift; audit-log-derived projections diverge across clients. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| App outside the service's version range | High (expected) | Low | `DaemonHelloAck` with `version.floor_exceeded` or `version.ceiling_exceeded` | The console draws the machine read-only; the working line names the side that is behind, with a press to its fix |
| MINOR bump ships a semantic invariant change (author mistake) | Low | High | Reviewer checklist miss; CI compat-test suite; bug report from an older client | Patch-release as MAJOR bump; issue advisory; invalidate the MINOR and re-release as MAJOR |
| Version stub storage grows unbounded because MAJOR bumps are rare | Low | Med | Storage metrics on `session_events.version_stub_metadata` column | Version stubs keep their bytes and are removed only with their session; expected acceptable overhead at expected MAJOR cadence (1–2 per year) |
| Upcaster chain bug corrupts replay | Low | High | Replay-vs-canonical diff in CI; per-upcaster unit tests | Upcasters versioned and rollback-able |

## Reversibility Assessment

- **Reversal cost:** HIGH. The wire format is a one-way door. Once MAJOR version N is in the field (emitted to any production audit log), it exists forever — there is no "un-ship" path. Changing the semver/integer decision or the stub-persistence rule after the first release would need an upcaster for every envelope already written.
- **Blast radius:** Every envelope ever written on every machine. Every local SQLite audit log. Every upcaster implementation in the daemon.
- **Migration path:** The upcaster chain IS the migration path. There is no separate rollback mechanism — rolling back means shipping an upcaster that transforms the newer version to the older.
- **Point of no return:** First `EventEnvelope` emitted with `version = "1.0"` in a non-test environment. Realistically this happens the first time any production daemon starts and emits `session.created`.

## Consequences

### Positive

- Mixed versions supported without forced-lockstep upgrades; the app and the service update independently.
- Wire format is evolvable after release without user-visible breakage on additive changes.
- Audit log immutability preserved — stubs persist verbatim, upcasters run on read.
- Enforcement is at each end; the event union in `packages/contracts` is the only registry.
- The handshake reasons (`version.floor_exceeded`, `version.ceiling_exceeded`) turn a version mismatch into a read-only console that names the side behind, rather than a crash.

### Negative (accepted trade-offs)

- Authors bear semantic-equivalence discipline burden. Reviewer checklist catches most; it will not catch 100%.
- Upcaster chain grows with every MAJOR bump and must be actively maintained.
- Stub storage is unbounded until re-interpretation; bounded by MAJOR-bump cadence (expected 1–2 per year).

### Unknowns

- Empirical cadence of MAJOR bumps after release; drives storage growth of stubs.
- Actual upcaster-chain replay cost at scale; measured once Plan-012 and the first MINOR bump ship.
- Whether the reviewer checklist catches semantic breaks reliably enough in practice.

## Decision Validation

### Reviewer Checklist for MINOR Bumps

Every proposed MINOR bump MUST be reviewed against this checklist before landing. A failed item flips the bump to MAJOR:

- No renamed fields (`old_name` → `new_name` is breaking; use a separate new field and deprecate the old).
- No changed field types (`int` → `string` is breaking).
- No changed field semantics (the field MUST mean the same thing to BOTH a reader that ignored the bump AND a reader that parsed it — a change that coincidentally reads OK for the bump-ignoring path but shifts meaning for the bump-aware path is still a semantic break and requires a MAJOR bump).
- No new required fields (every new field has a default or is optional).
- No new required semantic invariants on existing fields (e.g., "field X must now be a valid URL" is breaking even if X was always a string).
- No removed event types (use deprecation path; retire event-type strings permanently per Protobuf reserved-tag precedent).
- No removed enum values (as above).
- New event types have a payload schema registered in Spec-005.
- Upcaster-chain entry added if the new minor introduces typed behaviors that older clients must be able to stub.

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| MINOR bump (e.g., `1.0` → `1.1`) preserves all existing replay output | 100% of replay test suite passes across all historical MINOR versions within the same MAJOR | CI replay-diff suite | First MINOR bump after release |
| An app outside the service's version range gets `DaemonHelloAck` with the matching reason and a read-only console, never a crash | 100% of out-of-range handshakes in the contract-test matrix | CI contract tests | The handshake's landing (Plan-005) |
| Version stub re-interpretation replay output equals native replay | Byte-identical diff = 0 across reserved event-type test fixtures | CI upcaster-chain tests | First MAJOR bump |
| Unknown-type events persist as version stubs, never dropped | 100% of version stubs keep their original canonical bytes byte-identical | CI version-stub persistence tests | First MINOR bump |

### Tripwires (Revisit Triggers)

1. **MAJOR bump required within 12 months of V1 launch.** — Reassess whether per-session wire-version pinning (Option B) is simpler in practice than ongoing upcaster-chain maintenance. Quantitative input: cost of upcaster maintenance vs. cost of a forced app-and-service upgrade.
2. **Stub storage exceeds 5% of a session event log's size, or a provider driver ships an event type that triggers receiver stubbing across more than 10% of sessions.** — Reassess the stub-retention rule (item 11) and the MAJOR-bump cadence.
3. **Upcaster-chain bug causes data-integrity issue in production.** — The next release fixes the offending chain entry. Reassess whether the upcaster-chain-on-read pattern is empirically safe enough versus a frozen-wire alternative.
4. **Apps repeatedly land outside their service's version range** (the person updates one side and not the other). — Reassess whether the range should reach further back than the previous service version.

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| Kubernetes Version Skew Policy (v1.35) | Upstream policy | Asymmetric read-tolerance (old reads new OK; old writes new NOT OK); no-skip-minors; anchor-at-apiserver model | <https://kubernetes.io/releases/version-skew-policy/> (accessed 2026-04-18) |
| Confluent Schema Registry — Schema Evolution and Compatibility | Platform documentation | FORWARD_TRANSITIVE compatibility class matches additive-only minor-bump pattern, checked against all historical versions | <https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html> (accessed 2026-04-18) |
| Protobuf — Proto Best Practices | Language guide | Unknown-field preservation discipline; reserved-tag rule; "changing a field number is equivalent to deletion and re-addition" | <https://protobuf.dev/best-practices/dos-donts/> (accessed 2026-04-18) |
| Protobuf — Language Guide (Editions) | Language guide | Editions-based evolution; forward-compat discipline for wire-format changes | <https://protobuf.dev/programming-guides/editions/> (accessed 2026-04-18) |
| CloudEvents v1.0.2 Specification | Specification | `specversion` attribute; silent-ignore discipline for unknown content (weaker precedent; spec has never bumped from 1.0, so no field-tested MAJOR-bump precedent) | <https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md> (accessed 2026-04-18) |
| How to (not) do the events versioning? | Industry commentary (event sourcing) | Upcaster-chain on read; never rewrite log; events immutable | <https://event-driven.io/en/how_to_do_event_versioning/> (accessed 2026-04-18) |

### Related ADRs

- [ADR-004: SQLite Local State and Postgres Control Plane](./004-sqlite-local-state-and-postgres-control-plane.md) — persistence substrates; the service's SQLite audit log holds the envelopes this ADR versions.
- [ADR-016: Shared Event-Sourcing Scope](./016-shared-event-sourcing-scope.md) — V1 local-per-daemon audit-log topology; establishes that event log is not replicated to control plane, which keeps version checks on each machine's service.
- [ADR-019: V1 Deployment Model and OSS License](./019-v1-deployment-model-and-oss-license.md) — the relay the person deploys for themself; nothing in the deployment makes the app and the service update together (Assumption #1).

### Related Specs

- [Spec-005: Session Event Taxonomy and Audit Log](../specs/005-session-event-taxonomy-and-audit-log.md) — `EventEnvelope.version` field declaration; §EventEnvelope Version Semantics subsection documents the semantics this ADR establishes.
- [Spec-013: Persistence, Recovery, and Replay](../specs/013-persistence-recovery-and-replay.md) — replay path for upcaster chain; audit-log hydration semantics.

### Related Architecture Docs

- [Data Architecture §Cross-Version Compatibility](../architecture/data-architecture.md#cross-version-compatibility) — runtime wire-format skew tolerance; distinguishes from [§Schema Evolution](../architecture/data-architecture.md#schema-evolution) (each database's one schema).
