# ADR-027: Chat-Invoked Workflow Start and Start Authorization

| Field | Value |
| --- | --- |
| **Status** | `proposed` |
| **Type** | `Type 2 (one-way door)` |
| **Domain** | `Workflow / Invocation UX + Authorization` |
| **Date** | `2026-08-11` |
| **Author(s)** | `Claude (AI-assisted)` |
| **Reviewers** | `Proposed — rides the chat-start amendment PR alongside the Spec-017 §Chat-Invoked Start amendment for ratification at review` |

## Context

[Spec-017](../specs/017-workflow-authoring-and-execution.md) ships a full workflow engine whose only start surface is `Spec-017 §Entry node and the V1 trigger surface (SA-37)`: a run begins when a participant starts it through `workflow.runStart` or the CLI. The V1 product direction adds a third place a start must be reachable from — the session conversation itself, where humans and agents already collaborate — without minting a new start mode, a new wire contract, or a second authorization model.

Three existing constraints shape any answer. First, [Spec-016 §Turn Policies](../specs/016-multi-agent-channels-and-orchestration.md#turn-policies) fixes that activation is addressing-gated and that a client-surface `@mention` is sugar resolving to a typed operation, introducing no new wire contract — the repo's established shape for chat-typed affordances. Second, [Spec-012](../specs/012-approvals-permissions-and-trust-boundaries.md) provides exactly two authorization shapes: approval categories (a closed nine-member enum whose requests traverse the approval pipeline and whose grants are remember-able) and named Cedar operation actions (adjudicated per call, no pipeline traversal, never remembered — the `Action::"intervene"` and `Action::"dispatch::<capability>"` precedents). Third, the daemon-curated session callback-tool registry ([api-payload-contracts.md](../architecture/contracts/api-payload-contracts.md)) already defines how an agent invokes a daemon capability under Cedar adjudication — fail-closed while the approval seam is unregistered — but no concrete callback tool exists anywhere in the corpus yet.

One external fact forces part of the design rather than merely informing it: the reference provider CLIs dispatch leading-`/` user input as their own commands. Text beginning with a slash that reaches a provider turn is interpreted by the provider's command layer, outside this system's governance — so a chat command surface that forwards its text to agents is not merely awkward but structurally unsafe.

## Problem Statement

How do participants and agents start a workflow from inside a session conversation, and who is authorized to do so — without a new start mode (SA-37's C-11 discipline), without a new wire contract (the Spec-016 sugar precedent), without a tenth approval category (Spec-012's closed enum), and without slash text ever reaching a provider's own command dispatch?

### Trigger

The 2026-08-11 lead ratification of the chat-start design (two decisions, both Option A of their researched option sets). The command grammar is user-visible surface whose shape users build habits on — the Airflow rename precedent `Spec-017 §Terminology discipline (SA-17 / C-12)` already records what late grammar changes cost — and the authorization shape determines whether starts are remembered, so both are one-way enough to need a recorded decision before the amendment ships.

## Decision

Two coordinated decisions, normatively specified in `Spec-017 §Chat-Invoked Start and Start Authorization` (SA-38, SA-39, C-18), implemented by Plan-017 T5.8–T5.10 under invariants I-017-17 and I-017-18.

1. **Chat-start surface — the full hybrid.** Three new callers of the existing `workflow.runStart` operation, and no new start mode:
   - a registered **`/workflow start <name>`** command, intercepted and executed by the client composer with autocomplete over `workflow.definitionList` — never forwarded to a channel message, agent context, or provider turn;
   - a visible **composer affordance** enumerating startable definitions by name over the same list operation, issuing the same start;
   - an **agent leg**: the daemon-curated `workflow_start` session callback tool — the corpus's first concrete `SessionCallbackTool` — Cedar-adjudicated per invocation and landing as an ordinary `tool_activity` row.

   The reserved-`/` rule (C-18) makes interception structural: leading-slash composer input is command namespace; registered commands execute, unrecognized ones refuse loudly per C-12 naming the `//` escape, and neither ever composes into a provider turn. The escape — `//` sends the input as ordinary text with one leading slash stripped — is active on the channel-message path, where escaped text is inert prose; on provider-bound composer paths (steer-through-composer) every leading-`/` input, escaped included, keeps the loud refusal until BL-148's driver-boundary neutralization lands, because escaped text there would compose into a provider turn and re-enter the very hazard this rule closes. A chat-borne start's `channelId` binds its progress surface only after the daemon validates the resolved starter's membership in that channel. `@` remains the addressing namespace (who — Spec-016); `/` is the command namespace (what).

2. **Start authorization — a named Cedar operation action.** Starting a workflow run adjudicates `Action::"workflow::start"` per start, in the Spec-012 named-operation-action shape — deliberately not a tenth approval category. Role defaults: `owner` Yes, `collaborator` Yes, `runtime contributor` No, `viewer` No, mirrored as one row in the security-architecture Permission Matrix. One rule governs humans and agents: CLI, desktop, chat, and the callback tool all adjudicate the same action. The chat-borne path carries its authoring participant as a **daemon-resolved value, never a client-supplied body field**, and fails closed — refusing with the registered `workflow.start_denied` code — for any principal the transport cannot resolve, until the Spec-012/Plan-012 carrier registration lands.

### Thesis — Why This Option

The interception model is forced by the provider-collision fact: the only collision-proof-by-construction design is the one where the runtime owns its command namespace and slash text never reaches a provider — the model the registered-command platforms converged on after abandoning text-parsing bots ([Discord — Application Commands](https://discord.com/developers/docs/interactions/application-commands), accessed 2026-08-11). The hybrid surface (visible affordance + typed accelerator) is the settled modern pattern: the button makes workflows discoverable to users who don't know the grammar, the command serves users who do, and both collapse onto one typed operation so there is exactly one start semantics to test and govern ([Slack — Slash commands](https://api.slack.com/interactivity/slash-commands), accessed 2026-08-11). The agent leg as a governed tool call puts agents under the same permission plane as humans — the 2025–2026 agentic convention — and reuses contracts that already exist: the callback-tool registry, its Cedar route, and its fail-closed withholding are all shipped surface awaiting their first concrete tool.

The named action wins on width and on cost. A remembered grant keys on its approval category, so a category-shaped "workflow start" grant would silently cover **every** definition on the daemon — the wrong width for an operation whose blast radius is per-definition. A named action is adjudicated fresh per start by construction, matches the static per-role matrix answer (no pipeline latency, no modal friction for an operation that is not a risk-graded tool execution), and adds no governance vehicle the amendment does not already require: the chat-borne principal carrier forces a Spec-012/Plan-012 targeted delta regardless of which authorization shape is chosen, and the named action rides that same delta as an additive registration in the open named-operation-action family Spec-012 already sanctions — whereas a tenth category would additionally amend the closed nine-member category enum, the remember-pipeline semantics, and the approval UI surfaces.

### Antithesis — The Strongest Case Against

**A tenth approval category buys the whole approvals apparatus for free.** Categories get the approval pipeline, the pending-approval UI, expiry semantics, audit rows, and remembered grants — all shipped, all tested. A named action gets none of that: a denied start is just a refusal, with no "ask the owner to approve this one" escalation path. Under the category model a collaborator's start could be approval-mediated (`Yes (with approval)`, like message sending) rather than flatly allowed, which is arguably the safer default for an operation that can spawn multi-phase agent execution.

**Prose intent beats grammar.** A user who types "kick off the release workflow" gets nothing from a command grammar; a model-mediated runtime could interpret intent and skip the grammar entirely. Committing to `/workflow start <name>` freezes a 1970s-shaped surface into a product whose differentiator is model mediation.

**The reserved prefix takes a real character.** A user pasting a Unix path (`/etc/hosts — what does this line do?`) as the first character of a message hits the unknown-command refusal. That is friction Discord and Slack accepted because their users grew up with it; a console-first developer tool's users paste leading-slash text constantly.

### Synthesis — Why It Still Holds

The category's apparatus is exactly what a start should not have. Remembered grants are category-wide, so the apparatus's convenience feature is a per-definition-width authorization bug here; and the approval-mediated collaborator start ("Yes (with approval)") reintroduces per-start modal latency for an operation the lead ratified as flatly role-gated. Escalation is not lost: a denied participant asks a permitted one in the channel — the same social path every other role-gated action uses. If a future V1.x wants risk-graded starts (e.g., a workflow whose phases carry destructive tools), the right vehicle is the tool-execution categories those phases already traverse at execution time — governance where the risk is, not at the doorway.

Prose intent is not forgone — it is exactly what the agent leg is. A user can say "kick off the release workflow" **to an agent**, and the agent resolves intent and invokes `workflow_start`, Cedar-adjudicated, visible as `tool_activity`. The grammar is the deterministic path; the model-mediated path composes on top of it rather than replacing it — richer than either alone, which is why the hybrid is the ratified shape.

The reserved prefix binds only the composer's leading character, and the grammar carries its own way out where the way out is safe: the unknown-command refusal is loud, immediate, and instructive (C-12), and it names the `//` escape — one extra `/` sends leading-slash prose as ordinary channel text, where it is inert (activation is addressing-gated). On provider-bound composer paths the escape is deliberately inactive until BL-148 lands: escaped text there composes into a provider turn, where the reference CLIs dispatch leading-`/` text as their own commands — an active steer-path escape would convert today's loud refusal into silent provider-side command execution, which is strictly worse. Steering leading-slash prose is therefore a temporarily refused capability with a named gate (BL-148's driver-boundary neutralization gates a composer follow-up that activates the escape on those paths), not a silent hazard and not a permanent loss. The alternative — silently forwarding unrecognized slash text as prose, the rule the registered-command platforms use — is the structurally unsafe branch on every provider-bound path while the BL-148 residual is open, for exactly the inputs most likely to be typed by users who know provider CLIs. Between a visible refusal — teaching the one-keystroke escape where it is safe, and saying the path cannot carry slash text yet where it is not — and an invisible provider-side command execution, the refusal is the only defensible default. The `//` doubling itself is a local convention: neither Discord nor Slack ships an escape, because they chose the silent fall-through this design rejects.

## Alternatives Considered

### Option A: Full hybrid + named Cedar operation action (Chosen)

Registered intercepted command + visible composer affordance + governed agent callback tool, all resolving to `workflow.runStart`; authorization as `Action::"workflow::start"` with the owner/collaborator Yes, contributor/viewer No matrix row. Chosen for the reasons above: collision-proof by construction, one start semantics across four paths, one authorization rule for humans and agents, and no governance vehicle beyond the Tier-6 carrier delta the chat-borne principal already requires.

### Option B: Slash command only, no composer affordance (Rejected)

The minimal surface: grammar without discoverability. Rejected because a command grammar's audience is users who already know the feature exists; workflows are the product's headline authoring surface and their invocation must be discoverable in the place collaboration happens. The affordance costs one enumeration over an operation that already exists (`workflow.definitionList`) — refusing that trade is volume-lazy, not lean.

### Option C: Workflows as @-mentionable pseudo-participants (Rejected)

`@release-workflow go` — reuse the addressing namespace. Rejected structurally: `Spec-016 §Turn Policies` defines `@` as the addressing act resolving to `OrchestrationRunCreate` naming a `targetAgentId`; workflows are not participants, hold no agent identity, and take no turns. Overloading the addressing act would put a non-participant in every roster surface, force the addressing-gated activation invariant to carve out an exception, and collide names across two namespaces (an agent and a workflow sharing a name becomes ambiguous). `@` is who; `/` is what.

### Option D: A tenth `workflow_start` approval category (Rejected)

Authorization through the Spec-012 category enum and approval pipeline. Rejected per the Antithesis/Synthesis exchange: remembered grants have category width (wrong for per-definition blast radius), the pipeline adds latency and modality to a statically role-answerable question, and the amendment class is wider — both shapes ride the Tier-6 targeted delta the chat-borne carrier forces anyway, but a tenth category would additionally amend the closed nine-member enum, the remember-pipeline semantics, and the approval UI, where the named action is an additive registration in a family Spec-012 already sanctions as open.

## Assumptions Audit

- **Provider CLIs dispatch leading-`/` user input as commands.** Live-verified against the reference provider CLI on 2026-08-11 (forwarded slash text errors as an unknown command rather than reaching the model as prose); the headless second provider ignores slash commands entirely, so degrade-honestly parity holds. If a future provider treats slash text as prose, interception remains correct — it is a superset defense.
- **The callback-tool registry's fail-closed contract holds as documented:** spawn withholds the registry while the `approval.requestCreate` seam is unregistered, and a stray invocation answers `denied`. The agent leg is born-withheld and activates with CP-005-7, with no code change on the workflow side.
- **The local-socket principal collapse is real and durable:** every local JSON-RPC caller binds to the node-owner participant, so the matrix row discriminates only on identity-carrying paths until the Spec-012/Plan-012 carrier lands. The amendment treats this as a named fail-closed gate, not a footnote.
- **`workflow.definitionList` scope filtering (I-017-13) is the enumeration the autocomplete and affordance ride** — no new disclosure surface is created by listing.
- **The named-operation-action family is open, not a closed enumeration.** Verified 2026-08-11 against `Spec-012 §Implementation Notes` (the Cedar principal-action-resource-context mapping bullet): the family is presented as prose with per-owning-spec attributions (`Action::"intervene"` per Spec-004, `Action::"dispatch::<capability>"` per Spec-024), not a closed table — so `Action::"workflow::start"` is an additive registration whose attribution joins that same enumeration, carried by the same Tier-6 delta the chat-borne carrier already requires (the delta amends the Spec-012 sentence and the Cedar schema together). Were the family ever closed into a table, the delta would amend that table in the same diff — the vehicle does not change.

## Failure Mode Analysis

- **The Tier-6 carrier delta never lands.** Chat-borne starts stay node-owner-only; every other-principal chat start refuses `workflow.start_denied`. Bounded and honest: the CLI and desktop node-owner paths, the affordance, and the agent leg are unaffected, and the matrix row never claims enforcement it lacks (the fail-closed refusal _is_ the enforcement).
- **The approval seam stays unregistered.** The `workflow_start` tool is never exposed; a stray invocation is answered `denied` with a diagnostic record — never `completed` without Cedar, never silent. Shipped-state honesty is written into the spec text.
- **A user types `/workflow` before the feature ships.** Pre-feature composers have no command registry; the input is ordinary text today, and the amendment's C-18 rule takes effect only with the surface that registers commands — no retroactive behavior change.
- **An agent emits `/workflow start x` as channel text.** Inert by two independent rules: the command grammar exists only at the human composer (C-18), and channel messages activate nothing (Spec-016 addressing-gated activation). Defense in depth, not coincidence.
- **A forged `channelId` names a channel the starter cannot see.** Refused: after the role adjudication admits the start, the daemon validates the resolved starting participant's membership in the named channel before the field binds a progress surface (`workflow.start_denied`), so a start can never surface run progress into — or inject a progress card into — a private channel the starter is not a member of (the Spec-016 `direct`-channel disclosure class). The field is provenance, not authorization, and not an unvalidated router.
- **Steer/queue text beginning with `/` reaches a provider.** The known residual — outside this surface, on the Spec-004/Spec-006 paths — tracked as BL-148 against the Plan-005 driver build (neutralization or command-dispatch-disabled spawn). C-18 names the residual rather than silently absorbing it, and holds the composer's own provider-bound paths refusing all leading-`/` input (escape inactive) until the same gate lands — the composer is never a producer of provider-bound slash text.
- **Grammar regret (a second verb or command root is needed).** Additive: the registry admits new commands and verbs without breaking `start`; what cannot be cheaply changed is the interception rule itself, which is the part the collision fact forces anyway.

## Reversibility Assessment

The interception rule and the `@`/`/` namespace split are the one-way parts: once users rely on either behavior of leading-slash text, flipping it is a breaking UX change (the Airflow-rename cost class). The verb set and command roster are additive and reversible. The named action is additive to the Cedar schema; migrating to a category later would be additive too (categories and named actions coexist by design), though remembered grants issued after such a migration could not be retro-narrowed — a reason to be right now rather than migrate later. The callback tool is registry-curated and removable per session with no contract break.

## Consequences

### Positive

- Workflows become startable where collaboration happens, by humans and agents, under one typed operation and one authorization rule — no new wire method, no new start mode, no governance-enum amendment.
- The corpus gains its first concrete `SessionCallbackTool`, exercising the shipped registry, Cedar route, and fail-closed withholding end to end.
- The provider-collision class is closed by construction on the composer path, and the residual (steer/queue) is named and tracked rather than latent.
- `error-contracts.md §Workflow` gains its first authorization refusal code, beginning the A-017-15 owed extension with a registered landing instead of an unregistered mint.

### Negative (accepted trade-offs)

- Leading-slash prose costs one extra keystroke on the channel-message path — the `//` escape, named by the unknown-command refusal (mid-text slashes unaffected) — and cannot be sent through provider-bound composer paths at all until BL-148 lands: a temporarily refused capability with a named gate, accepted over the strictly-worse alternative of silent provider-side command dispatch.
- A denied collaborator has no in-product approval escalation for starts (accepted: the social path suffices; risk-graded governance belongs at phase execution time).
- Chat-borne starts for non-node-owner participants wait on the Tier-6 carrier delta (accepted: fail-closed, named gate, named vehicle).

### Unknowns

- Whether V1.x wants per-definition start policies (e.g., a definition startable by collaborators only in its authoring project). The named action composes with resource-scoped Cedar policies if so; nothing here forecloses it.
- The exact composer module the interception hook lands in — named at Plan-017 T5.8 dispatch from the shipped Plan-023 composer surface, not invented here.

## Decision Validation

### Pre-Implementation Checklist

- [ ] `workflow.start_denied` registered in `error-contracts.md §Workflow` before any handler mints it (C-12).
- [ ] ADR-027 promoted `accepted` before T5.8/T5.9/T5.10 dispatch (named Plan-017 §Preconditions box).
- [ ] The Spec-012/Plan-012 targeted delta registering `Action::"workflow::start"` and the chat-borne participant carrier is queued with a named vehicle before any chat-borne non-node-owner start is claimed as supported.
- [ ] The `workflow_start` tool's registration is conditional on the callback-tool host's fail-closed contract — no bypass, no direct dispatch.

### Success Criteria

- A `/workflow start <name>` composer input starts the named definition's run and renders its progress in the originating channel (membership-validated); the text never appears in any provider turn.
- An unrecognized leading-`/` composer input refuses loudly with the unknown-command form naming the `//` escape and is never forwarded; a `//`-escaped channel-message input sends as ordinary text with exactly one leading slash stripped; on provider-bound composer paths every leading-`/` input, escaped included, refuses — with user-facing copy that carries no internal tracking id — and nothing composes into a provider turn.
- Every start path adjudicates `Action::"workflow::start"`; a principal the matrix denies, a chat-borne principal the transport cannot resolve, or a `channelId` naming a channel the resolved starter is not a member of refuses with `workflow.start_denied` — the role arm first with a role-level message, the membership validation second (only for a matrix-admitted start) with its non-member and nonexistent-channel outcomes byte-identical — surfaced verbatim to the caller.
- An agent's `workflow_start` invocation lands as `tool_activity`, Cedar-adjudicated, and is answered `denied` (never silently dropped, never `completed`) when the approval seam is unregistered.

## References

### Research Conducted

- Live provider-CLI collision verification (2026-08-11): forwarded leading-slash text errors as unknown-command in the reference interactive CLI; the headless provider CLI does not dispatch slash commands. Conducted against the installed CLIs; behavior is the design-forcing fact recorded in §Context.
- [Discord — Application Commands](https://discord.com/developers/docs/interactions/application-commands) (accessed 2026-08-11) — the registered, typed, autocompleted, per-command-permission model; platform-owned interception.
- [Slack — Slash commands](https://api.slack.com/interactivity/slash-commands) (accessed 2026-08-11) — command payloads are delivered to the app, never echoed as channel text; workflows surfaced by name in the composer menu.
- [Microsoft Teams — channel and group conversations](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-and-group-conversations) (accessed 2026-08-03, via Spec-016) — mention-gating as the channel-bot activation default; the `@`-namespace precedent.

### Related ADRs

- [ADR-012 — Cedar Approval Policy Engine](./012-cedar-approval-policy-engine.md) — the adjudication substrate; named operation actions.
- [ADR-026 — Visual Node-Graph Workflow Authoring](./026-visual-node-graph-workflow-authoring.md) — the sibling authoring-surface decision; same amendment family.
- [ADR-015 — V1 Feature Scope Definition](./015-v1-feature-scope-definition.md) — feature #17 scope.
- [ADR-018 — Cross-Version Compatibility](./018-cross-version-compatibility.md) — the additive-optional rule the `channelId` widening rides.

### Related Docs

- `Spec-017 §Chat-Invoked Start and Start Authorization` (SA-38, SA-39, C-18) — the normative surface this ADR governs.
- `Spec-016 §Turn Policies` — the `@mention` sugar precedent and addressing-gated activation.
- `Spec-012 §Required Behavior` (the approval-category enum this decision deliberately does not extend) and `Spec-012 §Implementation Notes` (the named-operation-action family `Action::"workflow::start"` joins).
- [security-architecture.md §Permission Matrix (Task 5.4)](../architecture/security-architecture.md#permission-matrix-task-54) — the mirrored role row.
- [docs/backlog.md](../backlog.md) BL-148 — the steer/queue slash-neutralization residual.

## Decision Log

- **2026-08-11** — Drafted `proposed`; rides the chat-start amendment PR for ratification at review, following the ADR-026 vehicle shape.
