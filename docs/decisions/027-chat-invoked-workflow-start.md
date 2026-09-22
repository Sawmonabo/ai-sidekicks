# ADR-027: Chat-Invoked Workflow Start and Start Authorization

| Field         | Value                                      |
| ------------- | ------------------------------------------ |
| **Status**    | `accepted`                                 |
| **Type**      | `Type 2 (one-way door)`                    |
| **Domain**    | `Workflow / Invocation UX + Authorization` |
| **Date**      | `2026-08-11`                               |
| **Author(s)** | `Claude (AI-assisted)`                     |
| **Reviewers** | `Codex; User`                              |

## Context

[Spec-015](../specs/015-workflow-authoring-and-execution.md) ships a full workflow engine whose triggers are its entry node's own kinds ([Spec-015 §Entry node and the V1 trigger surface (SA-37)](../specs/015-workflow-authoring-and-execution.md#entry-node-and-the-v1-trigger-surface-sa-37)), one of which is a message in a session. The V1 product direction makes the conversation a first-class place workflows are reached from in both directions — the user and their agents already work there — without minting a new wire contract or a second authorization model, and without workflow text ever reaching a provider's own command layer.

Three existing constraints shape any answer. First, [Spec-014 §Turn Policies](../specs/014-multi-agent-channels-and-orchestration.md#turn-policies) fixes that activation is addressing-gated and that a client-surface `@mention` is sugar resolving to a typed operation, introducing no new wire contract — the repo's established shape for chat-typed affordances. Second, [Spec-010](../specs/010-approvals-permissions-and-trust-boundaries.md) provides exactly two authorization shapes: approval categories (a closed nine-member enum whose requests traverse the approval pipeline and whose grants are remember-able) and named Cedar operation actions (adjudicated per call, no pipeline traversal, never remembered — the `Action::"intervene"` and `Action::"dispatch::<capability>"` precedents). Third, the daemon-curated session callback-tool registry ([api-payload-contracts.md](../architecture/contracts/api-payload-contracts.md)) already defines how an agent invokes a daemon capability under Cedar adjudication — fail-closed while the approval seam is unregistered — but no concrete callback tool exists anywhere in the corpus yet.

One external fact forces part of the design rather than merely informing it: the reference provider CLIs dispatch leading-`/` user input as their own commands. Text beginning with a slash that reaches a provider turn is interpreted by the provider's command layer, outside this system's governance — so a chat command surface that forwards its text to agents is not merely awkward but structurally unsafe.

## Problem Statement

How do the user and their agents reach a workflow from inside a session conversation — starting one, reading one, and having one built or fixed — and who is authorized to do so, without a new wire contract (the Spec-014 sugar precedent), without a tenth approval category (Spec-010's closed enum), and without slash text ever reaching a provider's own command dispatch?

### Trigger

The V1 product direction puts workflows in the conversation, which forces two decisions at once: the command grammar and the authorization shape. The command grammar is user-visible surface whose shape users build habits on — the Airflow rename precedent [Spec-015 §Terminology discipline (SA-17 / C-12)](../specs/015-workflow-authoring-and-execution.md#terminology-discipline-sa-17--c-12) already records what late grammar changes cost — and the authorization shape determines whether starts are remembered, so both are one-way enough to need a recorded decision before the surface ships.

## Decision

Two coordinated decisions, normatively specified in [Spec-015 §Chat-Invoked Start and Start Authorization](../specs/015-workflow-authoring-and-execution.md#chat-invoked-start-and-start-authorization) (SA-38, SA-39, C-18), implemented by Plan-015 T5.8–T5.10 under invariants I-015-17 and I-015-18.

1. **Chat-start surface — the full hybrid, in both directions.** Workflows are reachable from a conversation through three kinds of caller, every one of them resolving to the typed operations Spec-015 already registers:
   - one registered command root, **`/workflow`**, carrying thirteen verbs — `run`, `list`, `runs`, `results`, `open`, `create`, `edit`, `fix`, `schedule`, `cancel`, `resume`, `enable`, `disable` — intercepted and executed by the client composer with autocomplete over `workflow.definitionList`, and never forwarded to a channel message, an agent's context, or a provider turn. One root is what keeps the command namespace collision-free, and verbs are additive under it; ten of them are direct calls to typed operations, while `create`, `edit` and `fix` hand the instruction to the session's own agent with a structured intent hint;
   - a visible **composer affordance** enumerating startable definitions by name over the same list operation, issuing the same start;
   - an **agent leg**: sixteen daemon-curated session callback tools, the corpus's first concrete ones, each Cedar-adjudicated per invocation and landing as an ordinary `tool_activity` row. An agent that builds or fixes a workflow needs to read the catalog, read a definition, validate one, read a run and read a step, so a starter subset would make it guess; `workflow_run` is the one that starts a run.

   The reserved-`/` rule (C-18) makes interception structural for the words the console owns: a console word — `/workflow` and its verbs among them — is executed by the client and never composes into a channel message, an agent's context or a provider turn, on any path. What the console does not own is not the runtime's to refuse: a word the bound provider's own enumeration carries is forwarded to that provider exactly as typed, and anything else goes as the user's own prose, neutralized at the driver's outbound frame boundary ([Spec-004 §Required Behavior](../specs/004-provider-driver-contract-and-capabilities.md#required-behavior), built by Plan-004 T3.18). There is no literal-slash escape and no unknown-command refusal of the product's own invention; what makes a chat-borne start collision-proof is that `/workflow` is a console word, not that the prefix is closed. A run's progress and its results return to **the session that asked for it and to no other** — as ordinary transcript rows, a progress row updating in place while the run is live and a results row when it ends — so a start's own channel binds its progress surface only after the daemon validates that the channel belongs to that session, and no node and no method posts into a session that did not ask. `@` remains the addressing namespace (who — Spec-014); `/` is the command namespace (what).

2. **Start authorization — a named Cedar operation action.** Starting a workflow run adjudicates `Action::"workflow::start"` per start, in the Spec-010 named-operation-action shape — deliberately not a tenth approval category. Defaults: the session's user Yes; an agent only through its governed `workflow_run` callback tool, adjudicated per invocation — mirrored as one row in the security-architecture Permission Matrix. The other capabilities the tool set reaches — authoring a definition, cancelling a run, resuming one — adjudicate named actions of their own on the same shape, so "may start a workflow" never silently means "may rewrite one". One rule governs the user and their agents: CLI, desktop, chat, and the callback tool all adjudicate the same action. The chat-borne path carries its authoring user as a **daemon-resolved value, never a client-supplied body field**, and fails closed — refusing with the registered `workflow.start_denied` code — for any principal the transport cannot resolve, until the Spec-010/Plan-010 carrier registration lands.

### Thesis — Why This Option

The interception model is forced by the provider-collision fact: the only collision-proof-by-construction design is the one where the runtime owns its command namespace and slash text never reaches a provider — the model the registered-command platforms converged on after abandoning text-parsing bots ([Discord — Application Commands](https://discord.com/developers/docs/interactions/application-commands), accessed 2026-08-11). The hybrid surface (visible affordance + typed accelerator) is the settled modern pattern: the button makes workflows discoverable to users who don't know the grammar, the command serves users who do, and both collapse onto one typed operation so there is exactly one start semantics to test and govern ([Slack — Slash commands](https://api.slack.com/interactivity/slash-commands), accessed 2026-08-11). The agent leg as a governed tool call puts agents under the same permission plane as the user — the 2025–2026 agentic convention — and reuses contracts that already exist: the callback-tool registry, its Cedar route, and its fail-closed withholding are all shipped surface awaiting their first concrete tool.

The named action wins on width and on cost. A remembered grant keys on its approval category, so a category-shaped "workflow start" grant would silently cover **every** definition on the daemon — the wrong width for an operation whose blast radius is per-definition. A named action is adjudicated fresh per start by construction, matches the static matrix answer (no pipeline latency, no modal friction for an operation that is not a risk-graded tool execution), and adds no governance vehicle this surface does not already require: the chat-borne principal carrier forces a Spec-010/Plan-010 targeted delta regardless of which authorization shape is chosen, and the named action rides that same delta as an additive registration in the open named-operation-action family Spec-010 already sanctions — whereas a tenth category would additionally widen the closed nine-member category enum, the remember-pipeline semantics, and the approval UI surfaces.

### Antithesis — The Strongest Case Against

**A tenth approval category buys the whole approvals apparatus for free.** Categories get the approval pipeline, the pending-approval UI, audit rows, and remembered grants — all shipped, all tested. A named action gets none of that: a denied start is just a refusal, with no escalation path. Under the category model an agent's start could be approval-mediated (`Yes (with approval)`) rather than flatly denied, which is arguably the safer default for an operation that can spawn a multi-phase run.

**Prose intent beats grammar.** A user who types "kick off the release workflow" gets nothing from a command grammar; a model-mediated runtime could interpret intent and skip the grammar entirely. Committing to a verb grammar freezes a 1970s-shaped surface into a product whose differentiator is model mediation.

**A word the console does not own simply leaves.** The rule keeps no net under the composer. A slash word this product does not own — a mistyped console word, a provider word the bound process did not enumerate, a Unix path pasted as a message's first character (`/etc/hosts — what does this line do?`) — is sent onward as typed, and what answers is the provider rather than the console: one provider's client replies that the command does not exist and spends a paid turn doing so, the other reads the words as prose. The same rule lets the console's own words shadow provider words of the same spelling, so a user who knows that provider's terminal gets the console's act rather than the one they typed. And while the driver-boundary neutralization is still owed, free text arriving from the steer and queue paths can still reach a provider client that dispatches leading-`/` text as its own command. A closed prefix — an unknown-command refusal, with an escape for literal slash text — would stop the first two before anything left the machine, and the same refusal on the steer path would stop the third.

### Synthesis — Why It Still Holds

The category's apparatus is exactly what a start should not have. Remembered grants are category-wide, so the apparatus's convenience feature is a per-definition-width authorization bug here; and an approval-mediated start ("Yes (with approval)") reintroduces per-start modal latency for an operation that is flatly gated on who the caller is. Nothing is lost by dropping the escalation path: the only principal who could approve a start is the user, who is already permitted. If a future V1.x wants risk-graded starts (e.g., a workflow whose phases carry destructive tools), the right vehicle is the tool-execution categories those phases already traverse at execution time — governance where the risk is, not at the doorway.

Prose intent is not forgone — it is exactly what the agent leg is. A user can say "kick off the release workflow" **to an agent**, and the agent resolves intent and invokes `workflow_run`, Cedar-adjudicated, visible as `tool_activity`; "build me a workflow that …" reaches the authoring tools the same way. The grammar is the deterministic path; the model-mediated path composes on top of it rather than replacing it — richer than either alone, which is why the hybrid is the shape this decision takes.

The three classes are not a net with holes; they are a boundary drawn where the values live. A word belongs to the console exactly when a console control holds the value it would change, which is what makes the console's words shadow provider words of the same spelling: forwarding the provider's own word for a value a chip owns would move the provider's state and leave the chip reading the old one, so shadowing is the requirement rather than the price. What the console does not own is not the runtime's to answer — a word the bound provider's own enumeration carries is that provider's to dispatch, and a word on nobody's list is the user's own prose, which is why the command list closes on a word no row matches instead of refusing it. A product-invented refusal would have to guess, and would guess wrong in both directions: it would block every provider word the live process's enumeration did not carry and every legitimate message that opens with a slash, and it would have to be taught before it helped anyone. A literal-slash escape is a second grammar for the same purpose that buys nothing the fall-through does not already give, since the provider answers slash prose in its own words either way; neither of the registered-command platforms this design took interception from ships one. The fall-through's cost is bounded and lands where it can be read — an error reply and a spent turn on one provider, prose on the other — and the one case where the runtime does answer for itself is the case it owns: a console word given an argument its control cannot take answers with one flow row saying what the word accepts and presses nothing, never forwarded as text instead. The real residual is the path this decision does not own: until the driver's outbound frame boundary neutralizes leading-`/` prose ([Spec-004 §Required Behavior](../specs/004-provider-driver-contract-and-capabilities.md#required-behavior), built by Plan-004 T3.18), free text arriving from the steer and queue surfaces keeps the provider-dispatch hazard — a bounded residual with a named gate rather than a silent one, and one a composer-side refusal would never have closed, because that text never passes the composer.

## Alternatives Considered

### Option A: Full hybrid + named Cedar operation action (Chosen)

Registered intercepted command + visible composer affordance + governed agent callback tool, all resolving to `workflow.runStart`; authorization as `Action::"workflow::start"` with its matrix row — the session's user Yes, an agent only through the governed callback tool. Chosen for the reasons above: collision-proof by construction, one start semantics across four paths, one authorization rule for the user and their agents, and no governance vehicle beyond the carrier delta the chat-borne principal already requires.

### Option B: Slash command only, no composer affordance (Rejected)

The minimal surface: grammar without discoverability. Rejected because a command grammar's audience is users who already know the feature exists; workflows are the product's headline authoring surface and their invocation must be discoverable in the place the work happens. The affordance costs one enumeration over an operation that already exists (`workflow.definitionList`) — refusing that trade is volume-lazy, not lean.

### Option C: Workflows as @-mentionable pseudo-users (Rejected)

`@release-workflow go` — reuse the addressing namespace. Rejected structurally: [Spec-014 §Turn Policies](../specs/014-multi-agent-channels-and-orchestration.md#turn-policies) defines `@` as the addressing act resolving to `OrchestrationRunCreate` naming a `targetAgentId`; workflows are not users, hold no agent identity, and take no turns. Overloading the addressing act would put a non-user in every surface that lists who can be addressed, force the addressing-gated activation invariant to carve out an exception, and collide names across two namespaces (an agent and a workflow sharing a name becomes ambiguous). `@` is who; `/` is what.

### Option D: A tenth approval category for starting a workflow (Rejected)

Authorization through the Spec-010 category enum and approval pipeline. Rejected per the Antithesis/Synthesis exchange: remembered grants have category width (wrong for per-definition blast radius), the pipeline adds latency and modality to a statically answerable question, and the change is wider — both shapes ride the Spec-010/Plan-010 delta the chat-borne carrier forces anyway, but a tenth category would additionally change the closed nine-member enum, the remember-pipeline semantics, and the approval UI, where the named action is an additive registration in a family Spec-010 already sanctions as open.

### Option E: Agent-mediated start via an appended provider-payload context block (Rejected)

No start surface of the runtime's own — append a context block to the provider payload announcing that a workflow CLI exists, and let the model decide when to invoke it. Rejected because it relocates the start decision into model prose: the model, not the daemon, decides whether a run starts, and the daemon learns of the start only as an already-executed side effect, with no typed call for `Action::"workflow::start"` to adjudicate against — no principal, no definition id, no pre-start refusal point — and no audit row attributing the start to an actor, so Option A's matrix row would bind nothing on the agent path. Discoverability is not the trade here either: a context block is prompt text the model may ignore or paraphrase, where the composer affordance enumerates real definitions. This is exactly the gap the `workflow_run` callback tool closes — it makes the agent path a typed caller of `workflow.runStart` like the user-driven paths, adjudicated by the same named action over all callers and recorded with the same attribution, rather than an unpoliced consequence of what the model was told.

## Assumptions Audit

- **Provider CLIs dispatch leading-`/` user input as commands.** Live-verified against the reference provider CLI on 2026-08-11 (forwarded slash text errors as an unknown command rather than reaching the model as prose); the headless second provider ignores slash commands entirely, so degrade-honestly parity holds. If a future provider treats slash text as prose, interception remains correct — it is a superset defense.
- **The callback-tool registry's fail-closed contract holds as documented:** spawn withholds the registry while the `approval.requestCreate` seam is unregistered, and a stray invocation answers `denied`. The agent leg is born-withheld and activates with CP-004-7, with no code change on the workflow side.
- **The local-socket principal collapse is real and durable:** every local JSON-RPC caller binds to the node-owner user, so the matrix row discriminates only on identity-carrying paths until the Spec-010/Plan-010 carrier lands. The amendment treats this as a named fail-closed gate, not a footnote.
- **`workflow.definitionList` scope filtering (I-015-13) is the enumeration the autocomplete and affordance ride** — no new disclosure surface is created by listing.
- **The named-operation-action family is open, not a closed enumeration.** Verified 2026-08-11 against [Spec-010 §Implementation Notes](../specs/010-approvals-permissions-and-trust-boundaries.md#implementation-notes) (the Cedar principal-action-resource-context mapping bullet): the family is presented as prose with per-owning-spec attributions (`Action::"intervene"` per Spec-003, `Action::"dispatch::<capability>"` per Spec-022), not a closed table — so `Action::"workflow::start"` is an additive registration whose attribution joins that same enumeration, carried by the same Spec-010/Plan-010 delta the chat-borne carrier already requires (the delta changes the Spec-010 sentence and the Cedar schema together). Were the family ever closed into a table, the delta would amend that table in the same diff — the vehicle does not change.

## Failure Mode Analysis

- **The carrier delta never lands.** Chat-borne starts stay node-owner-only; every other-principal chat start refuses `workflow.start_denied`. Bounded and honest: the CLI and desktop node-owner paths, the affordance, and the agent leg are unaffected, and the matrix row never claims enforcement it lacks (the fail-closed refusal _is_ the enforcement).
- **The approval seam stays unregistered.** No workflow callback tool is exposed; a stray invocation is answered `denied` with a diagnostic record — never `completed` without Cedar, never silent. Shipped-state honesty is written into the spec text.
- **A user types `/workflow` before the feature ships.** Pre-feature composers have no command registry; the input is ordinary text today, and the C-18 rule takes effect only with the surface that registers commands — no retroactive behavior change.
- **An agent emits `/workflow run x` as channel text.** Inert by two independent rules: the command grammar exists only at the user's composer (C-18), and channel messages activate nothing (Spec-014 addressing-gated activation). Defense in depth, not coincidence.
- **A forged `channelId` names a channel the starter cannot see.** Refused: after the authorization adjudication admits the start, the daemon validates that the named channel belongs to the session the resolved starter owns before the field binds a progress surface (`workflow.start_denied`), so a start can never surface run progress into — or inject a progress card into — a channel the starter is not a member of. The field is provenance, not authorization, and not an unvalidated router.
- **Steer/queue text beginning with `/` reaches a provider.** The known residual — outside this surface, on the Spec-003/Spec-005 paths — is answered by [Spec-004 §Required Behavior](../specs/004-provider-driver-contract-and-capabilities.md#required-behavior) and built by Plan-004 T3.18 (transport-only neutralization at the driver's outbound frame boundary plus a runtime tripwire; the command-dispatch-disabled-spawn variant is rejected there as a provider promise rather than a daemon guarantee). C-18 names the residual rather than silently absorbing it: a console word never reaches a provider on any path, a word the bound provider's own enumeration carries is dispatched through that provider's own client rather than composed into a text frame, and everything else travels as the user's prose across the neutralized boundary — so leading-`/` text the user meant as prose cannot arrive at a provider as a command.
- **Grammar regret (a second verb or command root is needed).** Additive: the registry admits new commands and verbs without breaking `start`; what cannot be cheaply changed is the interception rule itself, which is the part the collision fact forces anyway.

## Reversibility Assessment

The interception rule and the `@`/`/` namespace split are the one-way parts: once users rely on either behavior of leading-slash text, flipping it is a breaking UX change (the Airflow-rename cost class). The verb set and command roster are additive and reversible. The named action is additive to the Cedar schema; migrating to a category later would be additive too (categories and named actions coexist by design), though remembered grants issued after such a migration could not be retro-narrowed — a reason to be right now rather than migrate later. The callback tool is registry-curated and removable per session with no contract break.

## Consequences

### Positive

- Workflows become startable where the work happens, by the user and by their agents, under one typed operation and one authorization rule — no new wire method, no new start mode, no governance-enum amendment.
- The corpus gains its first concrete `SessionCallbackTool`s — sixteen of them — exercising the shipped registry, Cedar route, and fail-closed withholding end to end.
- The provider-collision class is closed by construction on the composer path, and the residual (steer/queue) is named and tracked rather than latent.
- `error-contracts.md §Workflow` gains its first authorization refusal code, beginning the A-015-15 owed extension with a registered landing instead of an unregistered mint.

### Negative (accepted trade-offs)

- A word the console owns cannot be sent to a provider at all, so where a provider's own command names something a console control already holds, the console's control wins and the provider's version is unreachable from the composer (accepted: forwarding it would move the provider's state and leave the control reading the old value). Leading-`/` prose goes to the provider as the user's own text, and one provider's client spends a turn replying that the command does not exist.
- A denied agent has no in-product approval escalation for starts (accepted: risk-graded governance belongs at phase execution time).
- Chat-borne starts for non-node-owner principals wait on the chat-borne user carrier (accepted: fail-closed, named gate, named vehicle).

### Unknowns

- Whether V1.x wants per-definition start policies (e.g., a definition startable only from its authoring project). The named action composes with resource-scoped Cedar policies if so; nothing here forecloses it.
- The exact composer module the interception hook lands in — named at Plan-015 T5.8 dispatch from the shipped Plan-021 composer surface, not invented here.

## Decision Validation

### Pre-Implementation Checklist

- [x] All unvalidated assumptions have a validation plan (§Assumptions Audit; the two load-bearing ones — that the composer owns command interception and that no shipped provider path consumes leading-slash text — are validated by Plan-015 T5.8's grammar tests and by the Plan-004 T3.18 gate respectively)
- [x] At least one alternative was seriously considered and steel-manned (§Alternatives Considered Options A–E)
- [x] Antithesis was reviewed by someone other than the author. Each of the three counter-arguments ("a tenth approval category buys the whole approvals apparatus for free", "prose intent beats grammar", "a word the console does not own simply leaves") is answered in §Synthesis, and the third is answered by _bounding_ rather than dismissing it — the class rule that draws the boundary where the values live, plus the Plan-004 T3.18 gate on the steer and queue paths.
- [x] Failure modes have detection mechanisms (§Failure Mode Analysis; every entry names either a typed refusal the caller observes — `workflow.start_denied` for the forged-`channelId` and unresolvable-principal arms — or a structural inertness argument that a test can assert, and the one residual it cannot detect in-product is named and gated on Plan-004 T3.18 rather than absorbed)
- [x] Point of no return is identified — §Reversibility Assessment: the leading-`/` interception rule and the `@`/`/` namespace split, one-way once users rely on either behavior; the verb set, command roster, and named action are all additive
- [x] `workflow.start_denied` registered in `error-contracts.md §Workflow` before any handler mints it (C-12) — the A-015-15 owed extension's first landed entry.
- [x] The Spec-010/Plan-010 targeted delta registering `Action::"workflow::start"` and the chat-borne user carrier is queued with a named vehicle before any chat-borne non-node-owner start is claimed as supported — the vehicle is named in [Plan-015 §Registrations Authored By Other Plans](../plans/015-workflow-authoring-and-execution.md#registrations-authored-by-other-plans) and held by the born-unchecked `Chat-borne user carrier + workflow::start action registered` box; until it lands, T5.8–T5.10 ship the fail-closed I-015-18 state and no such support is claimed.
- [ ] Every workflow callback tool's registration is conditional on the callback-tool host's fail-closed contract — no bypass, no direct dispatch (build-time; Plan-015 T5.10 — resolves when that code lands, not at promotion)

### Success Criteria

- A `/workflow run <name>` composer input starts the named definition's run and renders its progress in the session that asked, as a transcript row that updates in place and becomes the results row when the run ends; the text never appears in any provider turn, and no other session receives anything.
- A leading-`/` word the console owns executes and is never forwarded, on every path including the provider-bound composer surfaces; a word the bound provider's own enumeration carries is forwarded to that provider exactly as typed and only through the binding it was read under; anything else is sent as the user's own prose over the neutralized boundary, with no escape sequence to type and no refusal of the product's own invention. A console word given an argument its control cannot take answers with one flow row saying what the word accepts — user-facing copy carrying no internal tracking id — and presses nothing.
- Every start path adjudicates `Action::"workflow::start"`; a principal the matrix denies, a chat-borne principal the transport cannot resolve, or a `channelId` naming a channel outside the session the resolved starter owns refuses with `workflow.start_denied` — the authorization arm first with an authorization-level message, the channel-scope validation second (only for a matrix-admitted start) with its out-of-session and nonexistent-channel outcomes byte-identical — surfaced verbatim to the caller.
- An agent's `workflow_run` invocation lands as `tool_activity`, Cedar-adjudicated, and is answered `denied` (never silently dropped, never `completed`) when the approval seam is unregistered.

## References

### Research Conducted

- Live provider-CLI collision verification (2026-08-11): forwarded leading-slash text errors as unknown-command in the reference interactive CLI; the headless provider CLI does not dispatch slash commands. Conducted against the installed CLIs; behavior is the design-forcing fact recorded in §Context.
- [Discord — Application Commands](https://discord.com/developers/docs/interactions/application-commands) (accessed 2026-08-11) — the registered, typed, autocompleted, per-command-permission model; platform-owned interception.
- [Slack — Slash commands](https://api.slack.com/interactivity/slash-commands) (accessed 2026-08-11) — command payloads are delivered to the app, never echoed as channel text; workflows surfaced by name in the composer menu.
- [Microsoft Teams — channel and group conversations](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-and-group-conversations) (accessed 2026-08-03, via Spec-014) — mention-gating as the channel-bot activation default; the `@`-namespace precedent.

### Related ADRs

- [ADR-012 — Cedar Approval Policy Engine](./012-cedar-approval-policy-engine.md) — the adjudication substrate; named operation actions.
- [ADR-026 — Visual Node-Graph Workflow Authoring](./026-visual-node-graph-workflow-authoring.md) — the sibling authoring-surface decision.
- [ADR-015 — V1 Feature Scope Definition](./015-v1-feature-scope-definition.md) — feature #17 scope.
- [ADR-018 — Cross-Version Compatibility](./018-cross-version-compatibility.md) — the additive-optional rule the `channelId` widening rides.

### Related Docs

- [Spec-015 §Chat-Invoked Start and Start Authorization](../specs/015-workflow-authoring-and-execution.md#chat-invoked-start-and-start-authorization) (SA-38, SA-39, C-18) — the normative surface this ADR governs.
- [Spec-014 §Turn Policies](../specs/014-multi-agent-channels-and-orchestration.md#turn-policies) — the `@mention` sugar precedent and addressing-gated activation.
- [Spec-010 §Required Behavior](../specs/010-approvals-permissions-and-trust-boundaries.md#required-behavior) (the approval-category enum this decision deliberately does not extend) and [Spec-010 §Implementation Notes](../specs/010-approvals-permissions-and-trust-boundaries.md#implementation-notes) (the named-operation-action family `Action::"workflow::start"` joins).
- [security-architecture.md §Permission Matrix](../architecture/security-architecture.md#permission-matrix) — the mirrored permission row.
- [Spec-004 §Required Behavior](../specs/004-provider-driver-contract-and-capabilities.md#required-behavior) — where the steer/queue slash-neutralization rule lives; [Plan-004](../plans/004-provider-driver-contract-and-capabilities.md) T3.18 builds it.
