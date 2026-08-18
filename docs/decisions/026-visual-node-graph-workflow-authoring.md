# ADR-026: Visual Node-Graph Workflow Authoring

| Field | Value |
| --- | --- |
| **Status** | `accepted` |
| **Type** | `Type 2 (one-way door)` |
| **Domain** | `Workflow / Authoring UX` |
| **Date** | `2026-08-10` |
| **Author(s)** | `Claude (AI-assisted)` |
| **Reviewers** | `Codex — PR #318 review round (2026-08-11), whose two mechanism-naming findings landed in the paired Spec-017 visual-builder amendment (the SA-32 topology persistence spelling and the SA-36 operator-boundary enforcement); user ratification 2026-08-18 (the ADR-026 / ADR-027 promotion closure)` |

## Context

[Spec-017](../specs/017-workflow-authoring-and-execution.md) specifies a workflow engine whose V1 execution model is a bounded multi-phase sequence: four phase types, four gate types, a within-phase parallel construct with a join policy, named resource pools, and a `go-back-to` state-reset operation that is explicitly not a cyclic edge. Definitions are content-hashed and immutably versioned; `workflow.definitionCreate` runs a cycle check and rejects a definition that fails it.

Authoring, until now, has been specified only as a file plus a typed SDK, and "full UI design for workflow editors" sat in `Spec-017 §Non-Goals`. The V1 product direction adds two requirements: workflow definitions must be reusable across the projects on one daemon as well as within a single project — the `shared` tier the Tier-8 audit ratified — and authoring must happen on a dedicated visual canvas where phases are nodes and their tools and actions are attached to them.

The system already constrains what such a surface may do. Tool governance is node-operator surface owned by [Spec-028](../specs/028-mcp-server-configuration-and-governance.md) and evaluated through Cedar per [ADR-012](./012-cedar-approval-policy-engine.md); the renderer is an untrusted process that reaches the daemon only through a preload bridge; the `Spec-017 §Truth vs projection vs ephemeral (SA-25)` hierarchy admits exactly three storage tiers (immutable truth, rebuildable projection, run-ephemeral); and the CLI is the product's first delivery track, so no authoring capability may be desktop-only.

## Problem Statement

How should the visual workflow-authoring surface be built, and what exactly should it persist, so that it delivers node-graph authoring without acquiring semantics the execution engine does not have, without becoming a second authoring dialect the CLI cannot reach, and without putting mutable presentation state into a content-hashed immutable definition?

### Trigger

The V1 product direction requires a node-graph workflow editor and a cross-project reusable definition tier, both of which land as a Spec-017 amendment. Two of the three sub-decisions are hard to reverse once definitions exist in the field — the persisted definition/layout contract and the graph-to-phase mapping — so they need a recorded decision before the amendment ships, not after.

## Decision

Adopt a visual node-graph authoring surface for workflow definitions, built on the MIT-licensed React Flow library (`@xyflow/react`, v12 line), under three binding constraints:

1. **Graph authoring over phase execution.** The builder authors the existing multi-phase model. Persisted nodes are exactly the phase set plus one non-executing entry node; gates, agent assignments, and tool bindings are properties of phase nodes; the sole edge kind is the sequence edge; `go-back-to` is rendered as an annotation and never as an edge. The graph-to-phase mapping is total and deterministic in both directions.
2. **Canonical definition bytes are layout-independent.** Canvas geometry is excluded from the canonicalized definition body and from the content-hash preimage, persists client-local on the tier already used for `human`-phase form drafts, and travels between machines only inside an optional, unhashed section of the definition file form.
3. **Tool bindings are references, not policy.** A definition carries a scope-qualified binding identity and a tool name, never a governance facet. Governance stays with the node operator through the Spec-028 surface and is resolved at phase launch.

The normative specification of all three is `Spec-017 §Visual Workflow Builder` (SA-32 … SA-37, C-17); the implementation tasks are Plan-017 T1.7, T1.8, T5.5, T5.6, and T5.7, pinned by invariants I-017-14 … I-017-16.

### Thesis — Why This Option

The library choice is settled by what a workflow canvas actually requires: hit-testing, drag with snapping, viewport transform, edge routing and re-routing, connection-drag with live validity feedback, selection and multi-select, keyboard accessibility, and correct behavior under zoom on high-DPI displays. React Flow is MIT-licensed, actively maintained, purpose-built for exactly this, and exposes the two hooks the constraints above need: a fully controlled node/edge model (so application state, not the library, is the source of truth for what gets serialized) and a connection-validity predicate evaluated **during** the connection drag (so a refused connection is never created, rather than created and then removed). Hand-rolling this is months of interaction work with no product differentiation, in exchange for avoiding one well-scoped MIT dependency in a process that already carries React.

The three constraints are what make the surface safe rather than merely attractive. Constraint 1 means the builder's expressive power is exactly the engine's expressive power — there is no graph an author can draw that the engine cannot run, and no engine feature the graph cannot address, so the class of "the picture says something the runtime does not do" is closed by construction rather than by validation. Constraint 2 keeps the immutability guarantee honest: with geometry inside the hashed body, dragging a node would mint a content hash and a version, and a definition's version history would fill with visual noise that replay and verification would have to carry forever. Constraint 3 keeps the authoring surface from becoming a privilege-escalation path — a workflow author is not necessarily the node operator, and a definition that could carry an approval mode would let the former set policy for the latter, and would let an imported file set it on a machine whose operator never agreed.

### Antithesis — The Strongest Case Against

**A form-based phase editor is cheaper and sufficient.** The V1 execution model is a _sequence_ with a bounded parallel construct — not a general DAG. A sequence renders perfectly well as an ordered list with an add/reorder affordance and a per-phase form. That surface needs no dependency, no canvas, no viewport, no layout persistence, no auto-layout, no connection-validity predicate, and no separate file-form section; it is keyboard-accessible and screen-reader-legible for free, whereas a canvas needs deliberate work to be either. Every one of constraints 1–3 exists _because_ a graph was chosen: a list cannot draw a cycle, cannot orphan a step, and has no geometry to exclude from a hash. The graph, on this reading, manufactures its own problems and then solves them.

**Graph UIs invite semantics the engine does not have.** This is the sharper form of the objection, and it is empirically grounded: users arrive at a node canvas with expectations set by general-purpose automation editors — loops, conditional branches with expressions, retry edges, sub-workflow nodes, error-path edges, wait nodes. The V1 engine has none of these. `go-back-to` is the case in point: it _is_ semantically a loop, it is the single most natural thing to draw as an edge, and drawing it produces a definition the daemon rejects. Every such gap becomes a refusal the user experiences as the tool being broken, and the standing pressure will be to close the gap by adding engine features chosen by what looks drawable rather than by what the product needs. A form-based editor generates none of that pressure because it makes no visual promise.

**The layout separation is a real cost, not a free win.** Client-local layout means a definition opened on a second machine, or by a second author, does not look the way its author arranged it unless a file happens to travel with it. The alternative — layout in the daemon — is rejected here on storage-tier grounds, but a reviewer may reasonably read that as the tier hierarchy dictating product behavior rather than the reverse.

### Synthesis — Why It Still Holds

The list-editor objection is correct about V1's _shape_ and wrong about V1's _cost curve_. The parallel construct with a join policy is already a fan-out and a fan-in, and it is already the part of the model authors get wrong; a list renders it as a nested indent whose join policy is invisible until opened. More decisively, the surfaces authors most need to see at a glance — which phase runs which agents, which tool bindings a phase touches, which gate is human-blocking, where a `go-back-to` points — are _adjacency_ facts, and adjacency is what a graph shows and a list hides. The decision to build a canvas is a product decision this ADR records rather than relitigates; what the ADR owes is that the canvas not cost correctness, which is what constraints 1–3 buy.

The "invites absent semantics" objection is the strongest one and is met not by denial but by structure. Constraint 1 makes the node palette the enumeration of the phase-type domain — an author cannot place a loop node, a conditional node, or a wait node, because no such node exists to place. `go-back-to` is handled exactly where the objection points: it is deliberately _not_ drawable, rendered as a labelled back-reference on the node, so the refusal happens at the palette and the connection layer rather than at save time. The residual — an author who wants a loop and finds none — is a discoverability cost, not a correctness cost, and it is strictly smaller than the same author's cost under a list editor, where the feature is equally absent and less visibly so. The pressure to add engine semantics remains real; the mitigation is that any such feature must amend `Spec-017 §Phase-Type and Gate-Type Taxonomy` first, which is where that decision belongs and where the C-11 execution-model-enum precedent already lives.

The layout cost is real and is bounded by the file form: geometry travels with an exported definition, so the second-machine case is covered whenever the definition itself travels, and the uncovered case — a definition reached through the daemon on a machine that never saw the file — falls back to a deterministic auto-layout that is at least identical for every viewer. Paying that bounded cost is preferable to introducing a storage tier the spec does not define, whose contents no replay can rebuild and no audit can verify.

## Alternatives Considered

### Option A: React Flow canvas with the three constraints (Chosen)

- **What:** Node-graph authoring on `@xyflow/react`, with the node set pinned to the phase-type domain, layout excluded from canonical bytes, and tool bindings reference-only.
- **Steel man:** Delivers the requested product capability with adjacency visible at a glance; the three constraints hold the correctness line structurally rather than by validation; the dependency is MIT, browser-only, and enters a process that already carries React; all meaning lives in shared contracts, so the rendering layer is swappable.
- **Weaknesses:** One production dependency in the renderer bundle plus its transitive packages; the library's attribution mark is displayed unless a paid tier is purchased; canvas accessibility must be built deliberately where a list would have had it for free; standing product pressure toward engine semantics that merely "look drawable".

### Option B: Form-based phase-list editor (Rejected)

- **What:** An ordered list of phases with per-phase forms and an add/reorder affordance.
- **Steel man:** Cheapest to build and the best accessibility story for free — keyboard and screen-reader legible with no extra work; zero dependencies; no viewport, no layout persistence, no auto-layout, no connection predicate, and no unhashed file section, because a list has no geometry and cannot draw an invalid shape at all. Every constraint in this ADR exists only because a graph was chosen.
- **Why rejected:** It does not deliver the requested capability — it shows sequence but hides adjacency, which is precisely what an author needs when a workflow's phases fan out, bind tools, and gate on humans. Its genuine advantages are recorded as obligations on Option A rather than as reasons to prefer it: the canvas owes keyboard-reachable node creation, connection, and inspection.

### Option C: Hand-rolled SVG/Canvas graph editor (Rejected)

- **What:** The same visual model implemented directly, with no third-party rendering dependency.
- **Steel man:** Total control over the interaction model and the serialized shape; no third-party upgrade treadmill; no attribution mark; no transitive packages entering the renderer bundle.
- **Why rejected:** The interaction surface a usable canvas needs — hit-testing, drag with snapping, viewport transform under high-DPI, edge routing, connection-drag validity feedback, multi-select, keyboard navigation — is months of work whose failure modes are subtle and whose value is entirely undifferentiated. The dependency being avoided is MIT-licensed and self-contained.

### Option D: Embed an existing automation product's editor wholesale (Rejected)

- **What:** Adopt a complete workflow editor from an existing automation product rather than a graph-rendering library.
- **Steel man:** Largest capability jump for the least authoring work; a mature, user-tested interaction model arrives complete rather than assembled.
- **Why rejected:** Such editors ship their own execution semantics — loops, conditionals, expression languages, trigger types — which is exactly the failure mode the antithesis names, arriving pre-installed and with that engine's vocabulary baked into the persisted format. A rendering library that knows nothing about workflows is the correct dependency depth: it supplies interaction, and this system supplies meaning.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | React Flow v12's controlled model lets application state, not library state, be the serialization source of truth. | The controlled node/edge/change-handler model is the library's documented primary mode (§Research Conducted row 1). | The mapping layer would have to read library-internal state, weakening constraint 2's typed layout/body split. Mitigation: the mapping is a pure function over application state, unit-tested without rendering. |
| 2 | A connection-validity predicate evaluated during the drag makes all seven refusal rules edit-time. | The predicate covers per-connection rules; the whole-graph rules (orphan phase, entry-node count, unjoined fan-out) are evaluated on the post-change graph rather than during the drag. **Partly unvalidated** — validated at T5.5 against the real component. | Some rules become save-time rather than drag-time refusals. Product degradation only: the daemon check is authoritative regardless (I-017-16), so no invalid definition persists. |
| 3 | The V1 phase-type domain is stable enough that a palette pinned to it needs no fifth kind during V1. | The four-value domain was re-ratified by the Tier-8 audit and is CHECK-pinned in the DDL and conformance-tested by T1.6; the counter-pressure toward loops and conditionals is real and named in §Antithesis. | The palette gains a member, which requires a Spec-017 taxonomy amendment first. That ordering is the intended control, not a failure. |
| 4 | Client-local layout is acceptable for V1 collaboration. | Precedent in-tree: `human`-phase form drafts already ship client-local on this tier per `Spec-017 §Ship-empty tables (SA-28)`. **Unvalidated for multi-author use** — validated by product feedback after T5.5 ships. | Layout becomes a product complaint. Reversal path: a daemon-side layout tier, which requires an SA-25 amendment and a table-census move. Deliberately deferred, not foreclosed. |
| 5 | No governance facet will ever need to live in a definition. | Facets are per node-operator and per binding scope in `Spec-028 §Tool-Level Overrides`; a portable definition carrying them is a privilege-escalation vector by construction. | I-017-14 would have to be re-cut, which is a security decision requiring its own ADR. |
| 6 | Attribution branding in the canvas is acceptable in-product. | Attribution removal is gated behind a paid subscription tier (§Research Conducted row 3); no such subscription is assumed available. | A subscription decision, not an engineering one. Recorded so no reader assumes the attribution is hideable for free. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| Layout leaks into the hashed body (a geometry field added to the definition type) | Med | High — every drag mints a version; replay and verification carry visual noise permanently | The layout-perturbation property test asserting byte-identical canonical output under arbitrary coordinates (T1.8) | A typed split between body and layout so the canonicalizer cannot structurally see geometry (I-017-15) |
| Builder emits a definition the daemon rejects (`go-back-to` drawn as an edge, or a cycle) | Med | Med — save-time failure, no data corruption | Round-trip property tests plus a rejecting fixture and an accepting neighbor per refusal rule (T1.8) | `go-back-to` has no drawable spelling; the connection predicate refuses cycle-closing connections (I-017-16) |
| A governance facet is added to the binding type "for convenience" | Low-Med | High — privilege escalation, and a definition that carries policy across machines | A contract test asserting each of the three facet names is rejected at parse (T1.8) | Parse-time rejection rather than launch-time ignore; I-017-14 names the three facets explicitly |
| Renderer trust boundary violated by a canvas dependency reaching for Node APIs | Low | High — breaks the untrusted-renderer stance | The renderer import-boundary lint gate run over the builder subtree (T5.5) | The lint boundary bans Node, Electron, main, and preload imports from renderer sources; the library is browser-only |
| Renderer Content-Security-Policy blocks the canvas's inline transforms | Low | Med — canvas renders unusably | Renderer smoke test with the production CSP applied | The specified renderer CSP already allows inline styles; the canvas needs no `script-src` widening and loads no remote asset |
| Library major version bumps and breaks the controlled-flow API | Med over V1's life | Low-Med | Typecheck plus the round-trip property suite, both library-agnostic | Mapping and refusal logic live in shared contracts, not in components; only the rendering layer touches the library |
| Transitive state library in the renderer bundle conflicts with app state management | Low | Low | Bundle inspection at adoption | It is the canvas's internal store, not an app-level one; the app's node/edge state is its own |
| Auto-layout is non-deterministic, so two viewers of a layout-less definition disagree | Low | Low | A test asserting two runs over one definition produce identical coordinates (T5.5) | Topological layout derived from the phase sequence — no randomness, no timing input |

## Reversibility Assessment

**Mixed, which is why this is Type 2.** The library choice is a two-way door; the persisted contracts are one-way doors. That asymmetry — cheap to swap the renderer, expensive to change what is stored — is the whole reason this ADR completes the Type-2 sections rather than resting on the library swap being easy.

- **Reversal cost:** Low for the rendering layer — all meaning (the mapping, the refusal set, the file form, the layout boundary) lives in shared contracts that import nothing from the rendering library, so swapping the canvas is a component-layer rewrite with no persisted-data consequence and no migration. High for the three persisted commitments: (1) the graph-to-phase mapping, since changing what a graph shape means changes what existing definitions execute; (2) the canonical-bytes/layout boundary, since moving anything across it changes the content hash of every existing definition and breaks version chains, run pins, and every verification anchored to them; (3) the scope-ref binding shape, since `(scope, scope_ref, content_hash)` determines definition identity and changing it re-partitions stored definitions.
- **Blast radius:** `packages/contracts/src/workflows/` (mapping, refusal set, file form, entry record, tool-binding reference), `packages/runtime-daemon/src/workflows/` (definition service and migration), `packages/client-sdk/src/workflowClient.ts`, `apps/desktop/src/renderer/src/workflows/builder/`, `apps/cli/src/commands/workflow-*.ts`, and every stored `workflow_definitions` / `workflow_versions` row.
- **Migration path:** Swapping the library is a rewrite of the builder subtree only, with the contract-layer tests unchanged as the correctness anchor. Reversing any of the three persisted commitments requires a Spec-017 amendment plus a data migration that re-canonicalizes and re-hashes every stored definition, re-pins every run bound to an affected version, and re-keys the dedupe index — with no way to preserve existing content hashes across the change.
- **Point of no return:** The first definition authored on a user's machine. Before that, all three commitments are implementation-cost only; after it, each carries a migration.

## Consequences

### Positive

- The requested node-graph authoring capability ships at V1, with adjacency facts (fan-out, joins, tool bindings, human gates, back-references) visible at a glance.
- The builder's expressive power equals the engine's by construction, so there is no class of drawable-but-unrunnable definitions.
- Definitions stay byte-stable under visual editing: no version churn, no replay noise, no verification cost from geometry.
- Tool governance remains node-operator surface; no authoring path can set an approval posture, and no imported file can carry one.
- CLI parity is structural rather than promised: one file form, one canonical byte sequence, one set of SDK operations behind both surfaces.
- No new database table, no change to the nine-table workflow census, and no new wire operation — promotion to `shared` scope and file import both ride `workflow.definitionCreate`.

### Negative (accepted trade-offs)

- One production dependency enters the renderer bundle, with its transitive state and utility packages.
- The canvas carries the library's attribution mark; removal requires a paid subscription tier that is not assumed available.
- Client-local layout means a definition reached through the daemon on a machine that never saw its file renders through auto-layout rather than as arranged.
- Canvas accessibility must be built deliberately — keyboard-reachable node creation, connection, and inspection — where a list editor would have had it for free. Recorded as an obligation on the implementation.
- Standing product pressure to add engine semantics that "look drawable"; the mitigation is procedural (a Spec-017 taxonomy amendment first), not technical.

### Unknowns

- Whether client-local layout proves acceptable in multi-author use, or whether a daemon-side layout tier becomes necessary in V1.x. That change requires an SA-25 amendment and a table-census move and is deliberately deferred, not foreclosed.
- Whether a scheduled or triggered start mode lands in V1 through its own vehicle. The entry node is shaped to accept one additively under [ADR-018](./018-cross-version-compatibility.md); no arm is declared until an engine exists to honor it.

## Decision Validation

### Pre-Implementation Checklist

The first five rows are the decision-quality gates the `proposed → accepted` promotion discharges; all five resolved 2026-08-18. The six rows below them are **build-time** obligations this ADR imposes on the implementation, each carried by a named Plan-017 task — they resolve when that code lands, not at promotion, and are deliberately left open here rather than pre-checked.

- [x] All unvalidated assumptions have a validation plan (§Assumptions Audit rows 2 and 4 are flagged and carry theirs)
- [x] At least one alternative was seriously considered and steel-manned (Options B, C, and D)
- [x] Antithesis was reviewed by someone other than the author — Codex at the PR #318 review round (2026-08-11), which folded two mechanism-naming findings into the paired Spec-017 amendment rather than into this ADR, and user ratification 2026-08-18, the ratification this ADR's `proposed → accepted` promotion requires
- [x] Failure modes have detection mechanisms (every §Failure Mode Analysis row names one)
- [x] Point of no return is identified and communicated (the first user-authored definition)
- [ ] The graph-to-phase mapping is a pure function over shared-contract types, importing nothing from the rendering library (build-time; Plan-017 T1.7)
- [ ] A typed split makes it structurally impossible for the canonicalizer to read geometry (build-time; Plan-017 T1.7)
- [ ] The node palette enumerates exactly the phase-type domain plus the entry node, sourced from the contract union rather than hand-listed (build-time; Plan-017 T5.5)
- [ ] `go-back-to` has no drawable spelling anywhere in the connection layer (build-time; Plan-017 T5.5)
- [ ] The binding type declares no governance facet, and each facet name is rejected at parse (build-time; Plan-017 T1.8)
- [ ] The builder subtree passes the renderer import-boundary lint with no exceptions (build-time; Plan-017 T5.6)
- [ ] Every CLI verb resolves to a named SDK operation; none is client-derived
- [ ] The dependency resolves under the workspace's minimum-release-age and sub-dependency policies and needs no build-allowlist entry

### Success Criteria

Measurement is by named Plan-017 test rather than by calendar date: this decision's correctness is a property of the shipped surface, and the check dates below are the task merges that first make each property assertable.

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Graph ↔ definition round-trip fidelity | 100% — definition → graph → definition byte-identical; graph → definition → graph isomorphic | `fast-check` property suite over generated valid definitions and generated valid graphs | T1.8 merge |
| Canonical-byte stability under geometry perturbation | 0 byte changes and 0 versions minted across arbitrary coordinates | Layout-perturbation property test (I-017-15) | T1.8 merge |
| Refusal-rule coverage | 7 of 7 rules with a rejecting fixture, an accepting neighbor, and a daemon re-refusal | Per-rule fixture suite plus the client-skips-a-rule daemon test (I-017-16) | T5.5 merge |
| Cross-surface content-hash identity | Identical hash for builder → export → CLI import on a fresh store → re-export | End-to-end round-trip test over the canonical file form | T5.7 merge |
| CLI-authored definition opens in the builder with no loss | 0 missing fields; deterministic auto-layout | Auto-layout determinism test plus a CLI-authored fixture opened through the builder path | T5.5 merge |

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| React Flow | Official documentation | MIT-licensed React library for node-based editors; controlled node/edge model with change handlers, a connection-validity predicate evaluated during the connection drag, custom node and edge types, and viewport control | https://reactflow.dev/ |
| `@xyflow/react` package metadata | Registry record | v12 line; peer requirements `react >= 17` / `react-dom >= 17`, satisfied by the desktop app's `^19` on both; transitive dependencies are the project's own system package plus a small state library and a class-name utility; no install script | https://www.npmjs.com/package/@xyflow/react |
| React Flow — subscription tiers | Vendor pricing page | Attribution removal is gated behind a paid subscription tier; the MIT library itself is free to use with attribution displayed | https://reactflow.dev/pro |

### Related ADRs

- [ADR-015](./015-v1-feature-scope-definition.md) — V1 feature scope; workflow authoring and execution is feature #17
- [ADR-018](./018-cross-version-compatibility.md) — additive-MINOR evolution; the entry node's future start modes extend under these rules
- [ADR-012](./012-cedar-approval-policy-engine.md) — Cedar authorization; tool-governance facets are evaluated there, never in a definition
- [ADR-009](./009-json-rpc-ipc-wire-format.md) — JSON-RPC IPC; the workflow operations both surfaces call
- [ADR-004](./004-sqlite-local-state-and-postgres-control-plane.md) — local SQLite; the definition and version tables
- [ADR-016](./016-electron-desktop-shell.md) — the Electron shell and its untrusted-renderer stance the canvas inherits

### Related Docs

- [Spec-017 — Workflow Authoring And Execution](../specs/017-workflow-authoring-and-execution.md) — `§Visual Workflow Builder` is the normative specification of this decision (SA-32 … SA-37, C-17)
- [Plan-017 — Workflow Authoring And Execution](../plans/017-workflow-authoring-and-execution.md) — T1.7 / T1.8 / T5.5 / T5.6 / T5.7 and invariants I-017-14 … I-017-16 implement it
- [Spec-028 — MCP Server Configuration and Governance](../specs/028-mcp-server-configuration-and-governance.md) — owns the scope-qualified binding identity and the governance facets constraint 3 keeps out of definitions

## Decision Log

| Date | Event | Notes |
| --- | --- | --- |
| 2026-08-10 | Proposed | Drafted alongside the Spec-017 visual-builder amendment and its Plan-017 task set. Lands `proposed`; Plan-017's `ADR-026 ratified accepted` §Preconditions box holds T1.7 / T1.8 / T5.5 / T5.6 / T5.7 until it is accepted. |
| 2026-08-18 | Ratified — `proposed → accepted` | Promoted by the park-surface + operator-controls amendment PR (cross-plan §6 node NS-72), which closes the two ADR promotions Plan-017 has carried as born-unchecked §Preconditions boxes since 2026-08-10 and 2026-08-11. Nothing in the decision changes: Option A (a first-class node-graph builder over the shared contract types) stands as drafted, the three counter-arguments of §Antithesis are answered in §Synthesis as recorded, and Options B–D stay steel-manned in §Alternatives Considered. The pre-promotion sweep found **no committed campaign plan scheduling an amendment against this ADR** (`docs/superpowers/plans/` carries no ADR-026 reference), so no scheduled work vetoes the promotion. Five decision-quality Pre-Implementation Checklist rows resolved; the six build-time rows stay open by design, each annotated with the Plan-017 task that closes it. Consequential same-PR edits: Plan-017's `ADR-026 ratified accepted` box checked with its Delivered record, the Phase-1 precondition corrected from its "for T1.7 and T1.8 only" reading to the phase-wide Gate-5 truth, the box narrative's stale claim that `## Rollout Order` sequences this promotion corrected (it sequences code items; the Gate-5 `precondition_box_checked` entries are what held Phases 1 and 5), and the README ADR census re-derived 24 → 26 `accepted`. The full-phase Gate-5 hold on Phases 1 and 5 is released. |
