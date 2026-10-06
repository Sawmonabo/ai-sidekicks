# ADR-024: Visual Node-Graph Workflow Authoring

| Field         | Value                     |
| ------------- | ------------------------- |
| **Status**    | `accepted`                |
| **Type**      | `Type 2 (one-way door)`   |
| **Domain**    | `Workflow / Authoring UX` |
| **Date**      | `2026-08-10`              |
| **Author(s)** | `Claude (AI-assisted)`    |
| **Reviewers** | `Codex; User`             |

## Context

[Spec-015](../specs/015-workflow-authoring-and-execution.md) specifies a workflow engine whose execution model is a node graph: every kind in the catalog is a node with its own executor, branches join through `flow.merge`'s modes, iteration is the `flow.loop-items` kind whose body wires back into its own input, and one memory gate decides when each step starts. The node kinds `agent.run`, `agent.multi-agent`, `human.approval` and `human.form` delegate to the existing run, orchestration, approval and form machinery. Definitions are content-hashed and immutably versioned; `workflow.definitionCreate` runs a cycle check, exempting only the edge that closes a loop body into its loop's input, and rejects a definition that fails it.

Authoring has a file form and a typed SDK, which the CLI and an agent use, and the product sets two requirements beside them: workflow definitions must be reusable across the projects on one daemon as well as within a single project — one library, every workflow runnable from every chat and every project session — and authoring must happen on a dedicated visual canvas where every step is a node and the tools a step can reach are wired into it.

The system already constrains what such a surface may do. A tool's approval is set only in Settings › MCP servers, through [Spec-024](../specs/024-mcp-server-configuration-and-governance.md)'s override operations, and enforced through each provider's own tool settings ([Spec-024 §Tool-Level Overrides](../specs/024-mcp-server-configuration-and-governance.md#tool-level-overrides)); the renderer is an untrusted process that reaches the daemon only through a preload bridge; the [Spec-015 §Truth vs projection vs ephemeral (SA-24)](../specs/015-workflow-authoring-and-execution.md#truth-vs-projection-vs-ephemeral-sa-24) hierarchy admits exactly three storage tiers (immutable truth, rebuildable projection, run-ephemeral); and the CLI is the product's first delivery track, so no authoring capability may be desktop-only.

## Problem Statement

How should the visual workflow-authoring surface be built, and what exactly should it persist, so that it delivers node-graph authoring without acquiring semantics the execution engine does not have, without becoming a second authoring dialect the CLI cannot reach, and without putting mutable presentation state into a content-hashed immutable definition?

### Trigger

The product requires a node-graph workflow editor and a cross-project reusable definition tier, both specified in Spec-015. Two of the three sub-decisions are hard to reverse once definitions exist on a person's machine — the persisted definition/layout contract and the graph-to-execution mapping — so they hold from the first definition.

## Decision

Adopt a visual node-graph authoring surface for workflow definitions, built on the MIT-licensed React Flow library (`@xyflow/react`, v12 line), under three binding constraints:

1. **Graph authoring over one execution model.** The builder authors a node document. Every kind in the catalog is a first-class node with its own id, params and handles, and the kinds `agent.run`, `agent.multi-agent`, `human.approval` and `human.form` delegate at run time to the existing run, orchestration, approval and form machinery — so the saved bytes are what the author drew and nothing is compiled into a different shape at save time. The handle types are `main` and `tool`; the trigger is the document's one entry node; and iterating over items is the loop kind, `flow.loop-items`, whose body wires back into its own input. The graph-to-document mapping is the identity in both directions.
2. **Canonical definition bytes are layout-independent.** Canvas geometry and pinned data are excluded from the canonicalized definition body and from the content-hash preimage. Geometry lives in the document's own `layout` section, stored in a column beside the definition body and carried by the definition file form, so a definition an agent authored or a user exported opens as it was arranged rather than as an arrangement a machine invented.
3. **Tool bindings are references, not policy.** A definition carries a scope-qualified binding identity and a tool name, never a governance facet. A tool's approval is set only in Settings › MCP servers and is resolved when the step launches; a workflow file that sets `approvalMode` on a node is refused as an ordinary parse error naming the field.

The normative specification of all three is [Spec-015 §Visual Workflow Builder](../specs/015-workflow-authoring-and-execution.md#visual-workflow-builder) (SA-30 … SA-35, C-17); the implementation tasks are Plan-014 T1.6, T1.7, T5.4, T5.5, and T5.6, pinned by invariants I-014-10 … I-014-12.

A definition is saved in the app's own graph format; the Open Workflow Specification and n8n's format were weighed and cannot hold that graph.

### Thesis — Why This Option

The library choice is settled by what a workflow canvas actually requires: hit-testing, drag with snapping, viewport transform, edge routing and re-routing, connection-drag with live validity feedback, selection and multi-select, keyboard accessibility, and correct behavior under zoom on high-DPI displays. React Flow is MIT-licensed, actively maintained, purpose-built for exactly this, and exposes the two hooks the constraints above need: a fully controlled node/edge model (so application state, not the library, is the source of truth for what gets serialized) and a connection-validity predicate evaluated **during** the connection drag (so a refused connection is never created, rather than created and then removed). Hand-rolling this is months of interaction work with no product differentiation, in exchange for avoiding one well-scoped MIT dependency in a process that already carries React.

The three constraints are what make the surface safe rather than merely attractive. Constraint 1 means the builder's expressive power is exactly the engine's expressive power — there is no graph an author can draw that the engine cannot run, and no engine feature the graph cannot address, so the class of "the picture says something the runtime does not do" is closed by construction rather than by validation. Constraint 2 keeps the immutability guarantee honest: with geometry inside the hashed body, dragging a node would mint a content hash and a version, and a definition's version history would fill with visual noise that every re-run and verification would have to carry forever. Constraint 3 keeps a tool's approval in one place, Settings › MCP servers, so a definition never becomes a second place that sets it.

### Antithesis — The Strongest Case Against

**A form-based step editor is cheaper and more accessible.** A list of steps with an add-and-reorder affordance and a per-step form needs no dependency, no canvas, no viewport, no layout persistence, no layout engine, no connection-validity predicate, and no separate file-form section; it is keyboard-accessible and screen-reader-legible for free, whereas a canvas needs deliberate work to be either. Every one of constraints 1–3 exists _because_ a graph was chosen: a list cannot draw a cycle, cannot orphan a step, and has no geometry to exclude from a hash. The graph, on this reading, manufactures its own problems and then solves them.

**The kind catalog is a large surface to keep honest, and it invites parity expectations.** This is the sharper objection. Each kind is its own executor, its own param spec, its own refusal set and its own states, and each one a user can see on the palette is a promise the engine has to keep — the opposite failure from a palette that is too narrow, and a more expensive one. A canvas that reads like a general-purpose automation editor also invites comparison with one: a user who finds an If, a Switch, a Merge and a loop will look for the next twenty kinds that product has, and the standing pressure becomes feature parity chosen by what a competitor draws rather than by what this product needs. The seam left inside the catalog sharpens the point: iterating over items is drawable as the loop kind, while a cycle drawn any other way — the most natural thing to reach for — is refused, so two things a user reads as the same shape behave differently.

**The layout section is a real cost, not a free win.** A document gains a section that carries no executable meaning, and the store gains a column beside an immutable body that a later edit may mutate under it. A document written with no layout at all still opens through a machine's arrangement rather than someone's. A reviewer may reasonably ask why the geometry is not simply hashed with everything else and the version churn accepted.

### Synthesis — Why It Still Holds

The list-editor objection is right about accessibility and wrong about capability. The model this surface authors has branches, loops, merges and capability attachments; a list renders a fan-out as a nested indent whose join is invisible until it is opened, and renders a loop as nothing at all. The facts an author most needs at a glance — which step runs which agent, which tools a step can reach, which gate blocks on a person, where a branch rejoins — are _adjacency_ facts, and adjacency is what a graph shows and a list hides. Accessibility is therefore taken as an obligation on the canvas rather than a reason to choose the list: keyboard-reachable node creation, connection and inspection, one live announcer for every structural change, and the library's own keyboard handling switched off so a second announcer is never created.

The catalog objection is met by structure, not by restraint. One declarative description per kind drives its palette row, its ports, its parameter form, its summary line and its validation, so a kind is one registry entry plus one executor plus its tests rather than a bespoke surface; the palette is that registry serialized, so a kind added in the daemon appears with no renderer change and no kind is ever hand-listed twice. Parity pressure is answered where it belongs: a new kind is a catalog entry with an executor and a test, and a new _semantic_ — a second execution order, a second error spelling, a second expression dialect — changes [Spec-015 §Node-Kind Taxonomy](../specs/015-workflow-authoring-and-execution.md#node-kind-taxonomy) first, which is where that decision belongs and where the C-11 execution-model-enum precedent already lives. Iteration is the loop kind, `flow.loop-items`, drawn and labeled with both of its ways out, done and loop; any other cycle is a refusal the builder computes locally and shows in its validation strip.

The layout cost is bounded by the document itself: geometry is part of what is saved and part of what is exported, so a definition opens as it was arranged wherever it is opened. The only uncovered case is a document written with no layout at all — through the SDK, the CLI or an agent — and that one is laid out deterministically, left to right, by the same layout library in the daemon and in the renderer, so it is never unopenable and looks the same on every device. Keeping geometry out of the hash is what keeps dragging free: it changes no byte, mints no hash and creates no version.

## Alternatives Considered

### Option A: React Flow canvas with the three constraints (Chosen)

- **What:** Node-graph authoring on `@xyflow/react`, with the node set drawn from the kind registry, layout excluded from the canonical bytes but carried by the document, and tool bindings reference-only.
- **Steel man:** Delivers the requested product capability with adjacency visible at a glance; the three constraints hold the correctness line structurally rather than by validation; the dependency is MIT, browser-only, and enters a process that already carries React; all meaning lives in shared contracts, so the rendering layer is swappable.
- **Weaknesses:** One production dependency in the renderer bundle plus its transitive packages; the library's attribution mark is displayed unless a paid tier is purchased; canvas accessibility must be built deliberately where a list would have had it for free; standing product pressure toward engine semantics that merely "look drawable".

### Option B: Form-based step-list editor (Rejected)

- **What:** An ordered list of steps with per-step forms and an add/reorder affordance.
- **Steel man:** Cheapest to build and the best accessibility story for free — keyboard and screen-reader legible with no extra work; zero dependencies; no viewport, no layout persistence, no auto-layout, no connection predicate, and no unhashed file section, because a list has no geometry and cannot draw an invalid shape at all. Every constraint in this ADR exists only because a graph was chosen.
- **Why rejected:** It does not deliver the requested capability — it shows sequence but hides adjacency, which is precisely what an author needs when a workflow's steps fan out, bind tools, and wait on people. Its genuine advantages are recorded as obligations on Option A rather than as reasons to prefer it: the canvas owes keyboard-reachable node creation, connection, and inspection.

### Option C: Hand-rolled SVG/Canvas graph editor (Rejected)

- **What:** The same visual model implemented directly, with no third-party rendering dependency.
- **Steel man:** Total control over the interaction model and the serialized shape; no third-party upgrade treadmill; no attribution mark; no transitive packages entering the renderer bundle.
- **Why rejected:** The interaction surface a usable canvas needs — hit-testing, drag with snapping, viewport transform under high-DPI, edge routing, connection-drag validity feedback, multi-select, keyboard navigation — is months of work whose failure modes are subtle and whose value is entirely undifferentiated. The dependency being avoided is MIT-licensed and self-contained.

### Option D: Embed an existing automation product's editor wholesale (Rejected)

- **What:** Adopt a complete workflow editor from an existing automation product rather than a graph-rendering library.
- **Steel man:** Largest capability jump for the least authoring work; a mature, user-tested interaction model arrives complete rather than assembled.
- **Why rejected:** on license and on ownership of meaning. The mature editors in this space ship under source-available licenses that are neither OSI licenses nor compatible with this repository's, and they arrive with their own runtime and their own vocabulary baked into the persisted format — so the bytes this product stores would be another product's schema, and the steps would run on another product's engine rather than on the user's own provider accounts and agent definitions. A rendering library that knows nothing about workflows is the correct dependency depth: it supplies interaction, and this system supplies meaning. The mechanics are studied from a primary-source reading of one such product and re-expressed; no code and no branding is taken.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | React Flow v12's controlled model lets application state, not library state, be the serialization source of truth. | The controlled node/edge/change-handler model is the library's documented primary mode (§Research Conducted row 1). | The mapping layer would have to read library-internal state, weakening constraint 2's typed layout/body split. Mitigation: the mapping is a pure function over application state, unit-tested without rendering. |
| 2 | A connection-validity predicate evaluated during the drag makes the per-connection refusal rules edit-time. | The predicate covers per-connection rules; the whole-graph rules — an orphan node, the trigger count, an empty document — are evaluated on the post-change graph rather than during the drag. **Partly unvalidated** — validated at T5.4 against the real component. | Some rules become save-time rather than drag-time refusals. Product degradation only: the daemon check is authoritative regardless (I-014-12), so no invalid definition persists. |
| 3 | The node catalog is the palette's only source, so no kind is ever hand-listed in the renderer. | One declarative description per kind drives the palette row, the ports, the parameter form, the summary and the validation, and the daemon serves that registry over `workflow.kindList`; the counter-pressure toward parity with a general automation editor is real and named in §Antithesis. | A kind could appear on the palette with no executor behind it, or an executor could ship unreachable. Both are caught by the registry being the one list, which is why nothing renders from a literal. |
| 4 | Layout outside the hash, but inside the document, is the right split. | Dragging must be free of version churn, which requires exclusion from the preimage; a definition must open as it was arranged, which requires the geometry to travel with it — and [Spec-015 §Canvas layout is not definition bytes (SA-33)](../specs/015-workflow-authoring-and-execution.md#canvas-layout-is-not-definition-bytes-sa-33) is the rule that holds both. | Either dragging mints versions, or a definition opens rearranged. The layout-perturbation property test holds the first half; the deterministic layout of a document with no layout section holds the second. |
| 5 | No governance facet will ever need to live in a definition. | Facets are set only in Settings › MCP servers, per binding scope in [Spec-024 §Tool-Level Overrides](../specs/024-mcp-server-configuration-and-governance.md#tool-level-overrides); a definition carrying them would be a second place that sets a tool's approval. | I-014-10 would have to be re-cut, and a tool's approval would then be set in two places that can disagree. |
| 6 | Attribution branding in the canvas is acceptable in-product. | Attribution removal is gated behind a paid subscription tier (§Research Conducted row 3); no such subscription is assumed available. | A subscription decision, not an engineering one. Recorded so no reader assumes the attribution is hideable for free. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| Layout leaks into the hashed body (a geometry field added to the definition type) | Med | High — every drag mints a version; re-runs and verification carry visual noise permanently | The layout-perturbation property test asserting byte-identical canonical output under arbitrary coordinates (T1.7) | A typed split between body and layout so the canonicalizer cannot structurally see geometry (I-014-11) |
| Builder emits a definition the daemon rejects (a cycle outside a loop body) | Med | Med — save-time failure, no data corruption | Round-trip property tests plus a rejecting fixture and an accepting neighbor per refusal rule (T1.7) | The connection predicate refuses cycle-closing connections, exempting only the edge that closes a loop body into the loop's own input (I-014-12) |
| A governance facet is added to the binding type "for convenience" | Low-Med | High — a tool's approval set from a definition rather than from Settings › MCP servers | A contract test asserting each facet name is refused at parse as an ordinary parse error naming the field (T1.7) | Parse-time refusal rather than launch-time ignore; I-014-10 names each facet explicitly |
| Renderer trust boundary violated by a canvas dependency reaching for Node APIs | Low | High — breaks the untrusted-renderer stance | The renderer import-boundary lint gate run over the builder subtree (T5.4) | The lint boundary bans Node, Electron, main, and preload imports from renderer sources; the library is browser-only |
| Renderer Content-Security-Policy blocks the canvas's inline transforms | Low | Med — canvas renders unusably | Renderer smoke test with the production CSP applied | The specified renderer CSP already allows inline styles; the canvas needs no `script-src` widening and loads no remote asset |
| Library major version bumps and breaks the controlled-flow API | Med over V1's life | Low-Med | Typecheck plus the round-trip property suite, both library-agnostic | Mapping and refusal logic live in shared contracts, not in components; only the rendering layer touches the library |
| Transitive state library in the renderer bundle conflicts with app state management | Low | Low | Bundle inspection at adoption | It is the canvas's internal store, not an app-level one; the app's node/edge state is its own |
| The layout of a document with no layout section is non-deterministic, so two devices disagree | Low | Low | A test asserting two runs over one definition produce identical coordinates (T5.4) | One layered layout library, left to right, in the renderer and the daemon alike, with each kind's node size stated so no measurement pass is needed — no randomness and no timing input |

## Reversibility Assessment

**Mixed, which is why this is Type 2.** The library choice is a two-way door; the persisted contracts are one-way doors. That asymmetry — cheap to swap the renderer, expensive to change what is stored — is the whole reason this ADR completes the Type-2 sections rather than resting on the library swap being easy.

- **Reversal cost:** Low for the rendering layer — all meaning (the mapping, the refusal set, the file form, the layout boundary) lives in shared contracts that import nothing from the rendering library, so swapping the canvas is a component-layer rewrite with no persisted-data consequence and no migration. High for the three persisted commitments: (1) the graph-to-execution mapping, since changing what a graph shape means changes what existing definitions execute; (2) the canonical-bytes/layout boundary, since moving anything across it changes the content hash of every existing definition and breaks version chains, run pins, and every verification anchored to them; (3) the scope-ref binding shape, since `(scope, scope_ref, content_hash)` determines definition identity and changing it re-partitions stored definitions.
- **Blast radius:** `packages/contracts/src/workflow/definition/definition.ts` and `packages/contracts/src/workflow/definition/methods.ts` (mapping, refusal set, file form, entry record, tool-binding reference), `packages/runtime-daemon/src/workflow/` (definition service), the workflow tables in the daemon's one local schema, the workflow client Plan-014 creates (`packages/client-sdk/src/workflow-client.ts`), the workflow builder in the desktop's workflows feature (`features/workflows/`), `apps/cli/src/commands/workflow-*.ts`, and every stored `workflow_definitions` / `workflow_versions` row.
- **Migration path:** Swapping the library is a rewrite of the builder subtree only, with the contract-layer tests unchanged as the correctness anchor. Reversing any of the three persisted commitments requires a change to Spec-015 plus a data migration that re-canonicalizes and re-hashes every stored definition, re-pins every run bound to an affected version, and re-keys the dedupe index — with no way to preserve existing content hashes across the change.
- **Point of no return:** The first definition authored on a user's machine. Before that, all three commitments are implementation-cost only; after it, each carries a migration.

## Consequences

### Positive

- The requested node-graph authoring capability ships at V1, with adjacency facts (fan-out, joins, tool bindings, the steps that wait on a person, loop bodies) visible at a glance.
- The builder's expressive power equals the engine's by construction, so there is no class of drawable-but-unrunnable definitions.
- Definitions stay byte-stable under visual editing: no version churn, no re-run noise, no verification cost from geometry.
- A tool's approval is set only in Settings › MCP servers; no authoring path can set one, and a workflow file that sets `approvalMode` is refused as a parse error naming the field.
- CLI parity is structural rather than promised: one file form, one canonical byte sequence, one set of SDK operations behind both surfaces, and every CLI verb resolves to a named SDK operation rather than one the client derives.
- Duplicate and file import both ride the one definition-create operation, so an import passes the same parse as any save and carries no `approvalMode`.

### Negative (accepted trade-offs)

- One production dependency enters the renderer bundle, with its transitive state and utility packages; it resolves under the workspace's minimum-release-age and sub-dependency policies and needs no build-allowlist entry.
- The canvas carries the library's attribution mark; removal requires a paid subscription tier that is not assumed available.
- A document written with no layout at all — through the SDK, the CLI or an agent — opens through the deterministic layout rather than as someone arranged it, and the definition body gains a section that carries no executable meaning.
- Canvas accessibility must be built deliberately — keyboard-reachable node creation, connection, and inspection — where a list editor would have had it for free. Recorded as an obligation on the implementation.
- Standing product pressure to add engine semantics that "look drawable"; the mitigation is procedural (the Spec-015 taxonomy changes first), not technical.

### Unknowns

- Whether the catalog's size settles where it is. Each further kind is a registry entry, an executor and its tests; a further _semantic_ changes the taxonomy first, and which of the two a request is will not always be obvious on first reading.
- Whether the canvas's keyboard and announcer surface reaches the standard a list editor would have had for free. It is an obligation on the implementation rather than a property of the library.

## Decision Validation

### Success Criteria

Measurement is by named Plan-014 test rather than by calendar date: this decision's correctness is a property of the shipped surface, and the check dates below are the task merges that first make each property assertable.

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Graph ↔ definition round-trip fidelity | 100% — definition → graph → definition byte-identical; graph → definition → graph isomorphic | `fast-check` property suite over generated valid definitions and generated valid graphs | T1.7 merge |
| Canonical-byte stability under geometry perturbation | 0 byte changes and 0 versions minted across arbitrary coordinates | Layout-perturbation property test (I-014-11) | T1.7 merge |
| Refusal-rule coverage | Every refused shape with a rejecting fixture, an accepting neighbor, and a daemon re-refusal | Per-rule fixture suite plus the client-skips-a-rule daemon test (I-014-12) | T5.4 merge |
| Cross-surface content-hash identity | Identical hash for builder → export → CLI import on a fresh store → re-export | End-to-end round-trip test over the canonical file form | T5.6 merge |
| CLI-authored definition opens in the builder with no loss | 0 missing fields; deterministic auto-layout | Auto-layout determinism test plus a CLI-authored fixture opened through the builder path | T5.4 merge |

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| React Flow | Official documentation | MIT-licensed React library for node-based editors; controlled node/edge model with change handlers, a connection-validity predicate evaluated during the connection drag, custom node and edge types, and viewport control | https://reactflow.dev/ |
| `@xyflow/react` package metadata | Registry record | v12 line; peer requirements `react >= 17` / `react-dom >= 17`, satisfied by the desktop app's `^19` on both; transitive dependencies are the project's own system package plus a small state library and a class-name utility; no install script | https://www.npmjs.com/package/@xyflow/react |
| React Flow — subscription tiers | Vendor pricing page | Attribution removal is gated behind a paid subscription tier; the MIT library itself is free to use with attribution displayed | https://reactflow.dev/pro |

### Related ADRs

- [ADR-014](./014-v1-feature-scope-definition.md) — V1 feature scope; workflow authoring and execution is feature #14
- [ADR-017](./017-cross-version-compatibility.md) — additive-MINOR evolution; a new node kind, or a new `kindVersion` of one, extends the catalog under these rules
- [ADR-012](./012-cedar-approval-policy-engine.md) — Cedar authorization; tool-governance facets live in Settings › MCP servers ([Spec-024 §Tool-Level Overrides](../specs/024-mcp-server-configuration-and-governance.md#tool-level-overrides)), never in a definition
- [ADR-009](./009-json-rpc-ipc-wire-format.md) — JSON-RPC IPC; the workflow operations both surfaces call
- [ADR-004](./004-sqlite-local-state-and-postgres-control-plane.md) — local SQLite; the definition and version tables
- [ADR-015](./015-electron-desktop-app.md) — the Electron desktop app and its untrusted-renderer stance the canvas inherits

### Related Docs

- [Spec-015 — Workflow Authoring And Execution](../specs/015-workflow-authoring-and-execution.md) — `§Visual Workflow Builder` is the normative specification of this decision (SA-30 … SA-35, C-17)
- [Plan-014 — Workflow Authoring And Execution](../plans/014-workflow-authoring-and-execution.md) — T1.6 / T1.7 / T5.4 / T5.5 / T5.6 and invariants I-014-10 … I-014-12 implement it
- [Spec-024 — MCP Server Configuration and Governance](../specs/024-mcp-server-configuration-and-governance.md) — owns the scope-qualified binding identity and the governance facets constraint 3 keeps out of definitions
