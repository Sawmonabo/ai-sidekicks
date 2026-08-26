# ADR-028: The Canonical Transcript Is Authoritative For Provider Sessions

| Field | Value |
| --- | --- |
| **Status** | `accepted` |
| **Type** | `Type 2 (one-way door)` |
| **Domain** | `Provider Integration / Persistence / Session Continuity` |
| **Date** | `2026-08-26` |
| **Author(s)** | `Claude (AI-assisted)` |
| **Reviewers** | `Codex — the transcript-authority and provider-switch amendment vehicle (§6 node NS-84), which audited the enumerated gate/fallback table against the Spec-005 capability matrix and the declared-loss rule against Spec-016's switch surface` |

## Context

Every provider the runtime drives keeps its own record of the conversation, and each exposes its own verbs for continuing that record. At the versions this project pins, Claude Code resumes a stored session with `--resume`, branches it with `--fork-session`, and can be told not to store one at all with `--no-session-persistence` ([Claude wire reference §CLI / wire surface](../reference/provider-wire/claude.md#cli--wire-surface), all three Verified in the `2.1.245` census); codex-cli keeps threads inside its app-server process, appends to a thread's model-visible history through `thread/inject_items`, and branches through `thread/fork` with an inclusive turn boundary ([Codex wire reference §`thread/inject_items`](../reference/provider-wire/codex.md#threadinject_items--item-injection) and [§`thread/rollback`](../reference/provider-wire/codex.md#threadrollback--session-time-travel-conversation-leg), Verified at `0.149.1`). What none of them expose is a documented, versioned **format** for the stored record itself. The stores are private, and free to change in a patch release — the same reference file records a method carrying an upstream deprecation at the pin, and a Claude flag string that survives in the binary five versions after the feature it named was removed.

The daemon keeps its own record too. [ADR-017](./017-shared-event-sourcing-scope.md) already rules that the local `session_events` log is authoritative for the session, and [Spec-006](../specs/006-session-event-taxonomy-and-audit-log.md) defines the normalized event shapes every driver emits into it through the [Spec-005](../specs/005-provider-driver-contract-and-capabilities.md) boundary. The timeline a participant sees ([Spec-013](../specs/013-live-timeline-visibility-and-reasoning-surfaces.md)) renders from that log and from nothing else.

So two records of the same conversation exist side by side, and nothing in the corpus says which one is the authority — or, more sharply, what the runtime is permitted to _depend on_ the provider to supply. Until now the question was theoretical, because every capability that touched continuity happened to have a provider-native path.

## Problem Statement

When the daemon's canonical record and a provider's own session store disagree — or when the provider session is gone, unreachable, refuses the operation, or belongs to a different vendor entirely — which record is the authority, and what may a capability depend on the provider to supply?

### Trigger

The same-agent provider switch ([Spec-016 §Same-Agent Provider Switch](../specs/016-multi-agent-channels-and-orchestration.md#same-agent-provider-switch)). Moving an agent from one provider to another mid-session has no provider-native path **by construction**: no vendor's resume verb accepts another vendor's session, and none ever will. Either the daemon can reconstruct the conversation from its own record, or the capability cannot ship. Three already-scoped V1 capabilities lean on the same answer — rollback ([Spec-004](../specs/004-queue-steer-pause-resume.md)), recovery and replay ([Spec-015](../specs/015-persistence-recovery-and-replay.md)), and cross-node dispatch ([Spec-024](../specs/024-cross-node-dispatch-and-approval.md)) — and each currently answers it locally and by implication.

---

## Decision

**We will treat the daemon's canonical transcript — a projection rebuilt from the `session_events` log — as the sole authority for the content of a provider session, and every provider session as a replay target: derived, disposable, and reconstructible.** Provider-native continuity verbs remain the default hot path, but each is a capability-gated optimization with a named daemon-side fallback, and no capability may depend on one.

### Thesis — Why This Option

**It is the only design under which the trigger is expressible.** A cross-vendor continuation has no shortcut to gate on. If the canonical record is not sufficient to reconstitute a conversation, the provider switch is not a hard feature — it is an impossible one.

**It extends a ruling the corpus already made rather than making a new one.** ADR-017 settled that the local log is authoritative for the session. This decision says the provider's copy is not a second authority that happens to agree; it is a cache of a projection. That is the same ruling, applied to the one record ADR-017 did not name.

**It refuses to make a vendor's private format a load-bearing schema.** [ADR-018](./018-cross-version-compatibility.md) governs compatibility for shapes we define. It cannot govern a provider's on-disk session store, whose format we neither own nor pin. A design that depends on that store makes a vendor patch release a data-loss event in a product whose central promise is an auditable record.

**It costs no new store.** The canonical transcript is a projection of events the runtime already persists — [ADR-005](./005-provider-drivers-use-a-normalized-interface.md)'s normalized boundary is what makes it derivable at all. Nothing is written twice.

**It collapses four mechanisms into one.** Rollback past a provider's rewind support, recovery after a provider process dies, cross-node dispatch onto a machine that never held the session, and the provider switch are the same operation — reconstitute a session from the canonical record — rather than four provider-specific special cases.

### Antithesis — The Strongest Case Against [T2]

**(a) Prompt-cache economics are real money, paid repeatedly.** Replaying a transcript into a fresh session is a guaranteed cache miss and a full reprocess of the conversation. A provider's own resume keeps the cache warm. On a long session, choosing our record over theirs is a recurring bill charged on every rollback and every recovery.

**(b) Native rewind is exact; a reconstruction is an approximation.** A provider unwinding its own store knows precisely what the model saw. Ours is a re-derivation: private reasoning stripped, tool calls re-paired, content re-rendered from shapes we normalized on the way in. Giving up exactness is a strange trade in a product that sells auditability.

**(c) The sufficiency claim cannot be proved for state we cannot see.** Provider-private state — encrypted reasoning, server-side memory, cached tool schemas, per-session model configuration — has no canonical representation. Asserting that the transcript is sufficient asserts something about the invisible.

**(d) It is more code, in the highest-risk place.** Every provider needs an export path and a replay path, each of which must survive vendor drift. The provider's own resume is one flag.

**(e) It is a one-way door that constrains every future integration.** Once the log is the authority, a provider we cannot replay into cannot ship — a permanent narrowing of the set of providers the product can adopt.

### Synthesis — Why It Still Holds [T2]

**(a) is accepted and bounded, not denied.** The canonical transcript is the _authority_, not the routine transport. Where a provider's own resume is available and the session is intact, the driver uses it — that is the hot path and the cache stays warm. Replay runs only where continuity is already broken: a switch (an unconditional cache miss regardless, since a different vendor cannot serve our cache — Assumption 4), a recovery after the provider process is gone (no cache survives to preserve), or a rollback the provider refuses or cannot perform. In each, the alternative to a cache miss is not a warm cache; it is no capability.

**(b) is accepted with the exactness preserved where it exists.** Where a provider's native rewind is available _and its semantics are declared_, we use it — [Spec-004](../specs/004-queue-steer-pause-resume.md)'s re-verified boundary-crossing rewind declaration is precisely that mechanism, and this decision does not weaken it. Canonical replay is what happens when the declaration is absent or the call refuses. We keep the exact path; we simply do not _depend_ on it.

**(c) is the strongest objection, and it narrows the claim rather than being rebutted.** We do not claim the transcript reproduces provider-private state. We claim, and this decision requires, three narrower things:

1. **Visibility sufficiency** — every fact a participant can see in the timeline is present in the canonical transcript, because both render from the same log.
2. **Declared loss** — whatever is not portable is declared _at the moment of the operation that drops it_ (the `declaredLosses[]` list on a switch), never silently lost.
3. **Named non-portability** — provider-private reasoning is declared non-portable **here**, as a decision, rather than discovered later as a bug. Visible reasoning summaries carry forward as plain text; private reasoning does not carry at all.

A capability that cannot honour all three refuses, or reports `degraded` with the loss named. It never reports `applied`.

**(d) is accepted as a real cost.** It buys one mechanism serving four capabilities against per-provider special cases inside each of the four, and it puts the risk in code we own and test rather than in a format we neither own nor pin.

**(e) is correct and deliberate.** ADR-005 already made a normalized interface the price of admission for a driver. This adds one clause to that price. A provider we cannot replay into is a provider on which we could not offer rollback, recovery, cross-node dispatch, or a switch — so the narrowing is not a new restriction, it is the existing restriction stated honestly.

### Enumerated Gates And Fallbacks

The synthesis above is only checkable if "capability-gated optimization with a named fallback" is an enumeration rather than a posture. It is:

| Provider-native shortcut | Capability gate ([Spec-005 §Per-Driver Capability Matrix](../specs/005-provider-driver-contract-and-capabilities.md#per-driver-capability-matrix)) | Daemon-side fallback when the gate is false or the call refuses |
| --- | --- | --- |
| Continue an existing session | `resume` | Replay the canonical transcript into a fresh provider session |
| Unwind to an earlier point | `rollback`, plus Spec-004's declared boundary-crossing rewind semantics where the target crosses a compaction boundary | Replay the canonical transcript **prefix** into a fresh session |
| Branch a session | `session_fork` | Replay the canonical transcript into a **second** fresh session, leaving the first untouched |
| Continue under a different provider | none exists, by construction | Replay only — the case this decision was triggered by |
| Replay itself | `transcript_replay` | The **memo projection**: a bounded prose rendering of the canonical transcript, rebuilt every turn, with the operation reported `degraded` and the losses declared |

The last row is what keeps the decision from resting on Assumption 1. A provider whose input surface will not accept prior-turn content declares `transcript_replay: false`, and the runtime still functions — visibly diminished, never silently wrong.

#### Where a consuming spec declines the fallback

A fallback being **available** is not the same as a capability being **obliged** to take it. Two of the five rows above have a consuming spec that deliberately declines the substitution in V1, and both declines are named here rather than left to be inferred from the consuming spec's silence — the count is five rows, of which two carry a decline:

- **Row 1, recovery.** [Spec-015 §Fallback Behavior](../specs/015-persistence-recovery-and-replay.md#fallback-behavior) transitions an unresumable run to `failed` rather than replaying it into a fresh session. The reason is this decision's own boundary: the canonical transcript is authoritative for the **conversation** and never for the **world**. A crashed run's in-flight turn may have executed tool calls whose effects are on disk, and replaying the conversation that requested them reconstructs the request, not the result — file-state restore is the daemon's turn-snapshot leg, never the driver's ([Spec-005 §Per-Driver Capability Matrix](../specs/005-provider-driver-contract-and-capabilities.md#per-driver-capability-matrix), the `rollback` row). Declining here is what keeps a recovered run from asserting a world state nothing produced.
- **Row 2, boundary-crossing rewind.** [Spec-004 §Required Behavior](../specs/004-queue-steer-pause-resume.md#required-behavior) refuses a rewind target above a provider compaction boundary rather than substituting a prefix replay. The fallback would reach the pre-compaction context, but the operation asked for is a rewind of a **run** — its file leg, its binding, its normalized-position vocabulary, and its recorded `usage.context_compacted` row — and a fresh-session substitution moves the binding and the position vocabulary under a row the rewind has already marked undone. The refusal is fail-closed against that disagreement, not a claim that the prefix is unreachable.

Both declines are properties of the consuming capability, not of this decision, and either becomes a plain amendment of its own spec the day its named reason stops holding. What this decision forbids is the third option: a capability that silently depends on a provider-native verb and has no answer at all when the verb is absent.

---

## Alternatives Considered

### Option A: Canonical transcript authoritative; provider session a replay target (Chosen)

- **What:** The `session_events` projection is the authority. Provider sessions are derived, disposable, and reconstructible. Native continuity verbs are gated optimizations with named fallbacks.
- **Steel man:** It is the only option under which a cross-vendor continuation exists; it extends ADR-017 rather than competing with it; it introduces no new durable store; and it makes four capabilities one mechanism.
- **Weaknesses:** Pays a prompt-cache miss on every fallback path; gives up provider-exact rewind as a _dependency_; requires an export and replay path per driver; permanently narrows the set of adoptable providers.

### Option B: Provider session authoritative; the daemon log is an audit copy (Rejected)

- **What:** The provider owns conversational state. The daemon records events for display and audit, and continuity is always the vendor's resume path.
- **Steel man:** [T2] It is the cheapest and the least code — one flag per provider instead of two code paths. It is _exact_ in a way nothing else can be: the provider's store is, by definition, what the model actually saw, including the private state we can never represent. It keeps the prompt cache warm on every operation, which on long sessions is the dominant cost. And it is honest about the division of labour — the vendor is better placed to maintain its own session semantics than we are to re-derive them.
- **Why rejected:** It makes the provider switch, cross-node dispatch, and post-crash recovery unimplementable rather than merely expensive — there is no vendor path for any of the three. It contradicts ADR-017's ruling on the same records. And it promotes an undocumented, unversioned vendor file format to a load-bearing schema, which ADR-018's compatibility discipline cannot reach.

### Option C: Dual authority with reconciliation (Rejected)

- **What:** Trust the provider's store while the session lives, fall back to the log when it does not, and reconcile the two on divergence.
- **Steel man:** [T2] It appears to take the best of both: warm caches and exact rewind in the common case, survivability in the uncommon one. It matches how caches are normally treated — authoritative while valid, rebuilt when not — and it needs no new claim about sufficiency, because the log is only consulted when the provider cannot answer.
- **Why rejected:** Two authorities require a divergence policy, and there is no signal by which to adjudicate one: the provider's store is opaque, so "reconcile" degenerates to "believe one of them", which is an authority decision made per incident instead of once. It also doubles the failure surface in exactly the place with the least observability, and the fallback path — being rare — is the one least exercised and most likely to be broken when finally needed.

### Option D: A separate durable transcript store (Rejected)

- **What:** Maintain the canonical transcript as its own durable artifact — a `transcripts` table written alongside the event log.
- **Steel man:** [T2] An explicit store is easy to reason about, cheap to read, and needs no projection logic on the read path. It would let the transcript carry provider-shaped detail the normalized event taxonomy deliberately drops, and it would make replay a table read rather than a fold.
- **Why rejected:** It is a second record of facts the log already holds, which must then be kept in step with it — Option C's divergence problem relocated inside our own process, where it would be our bug rather than the vendor's. The canonical transcript is therefore specified as a **projection rebuilt from the log**, never a store, and never a one-shot migration.

### Option E: Adopt an existing interchange format as the canonical transcript (Rejected)

- **What:** Rather than specifying a projection of our own, adopt a published conversation format — the Agent Client Protocol, OpenTelemetry's GenAI message model, or a widely-used framework shape such as the Vercel AI SDK's `UIMessage` — and treat it as the canonical transcript.
- **Steel man:** [T2] Reuse beats invention, especially for an interchange format, where the whole value is that someone else already argued the edge cases. ACP is versioned, cross-vendor, and has real implementations against both of our providers. OTel GenAI is genuinely vendor-neutral, JSON-Schema'd, and this stack already emits OpenTelemetry, so the transcript and the telemetry would share a vocabulary for free. Adopting either would make our record legible to tooling we did not write, and would let us inherit a migration story rather than author one.
- **Why rejected:** The premise fails on inspection — none of the candidates is a specified, versioned, cross-vendor _persisted transcript_ format, and every one is lossy on the exact axis that matters here. [ACP](https://agentclientprotocol.com/protocol/session-setup) replays agent→client only; its `session/new` and `LoadSessionRequest` accept no history payload, so an ACP-shaped record cannot be used to _seed_ an agent, and its content model carries reasoning only as a plaintext streaming chunk with no signature or encrypted-content representation. [MCP](https://modelcontextprotocol.io/) has no transcript concept at all and its sampling shapes are deprecated. [OTel GenAI's message model](https://github.com/open-telemetry/semantic-conventions-genai) is `stability: development` with Opt-In requirement level, and its reasoning part is exactly `{type, content}` — no signature, no provider envelope. The [Vercel AI SDK's `UIMessage`](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence) carries no version discriminator and has taken breaking shape changes across successive majors, with the vendor's own guidance for unparseable stored history being to start from an empty array.

  Two market actors settle it. Vercel built harness adapters for both of the CLIs this project drives and **declined to define a portable transcript**: its harness contract states that the harness session owns its own history and prior turns are never replayed across the contract, and its resume state is an opaque adapter-scoped payload that adapters refuse when mismatched. OpenAI ships an importer that migrates Claude Code and Cursor sessions into Codex, and it **flattens them to plain text and drops reasoning entirely**. When the two organizations best placed to define this format have each looked at it and chosen not to, "adopt the standard" has no standard to adopt.

  What is reused is everything below the format: the **shape vocabulary** aligns with OTel GenAI's part kinds so the projection into `gen_ai.*` telemetry stays cheap; **delivery** uses each vendor's own native seeding surface rather than inventing transport; and the **boundary disciplines** in [Spec-005 §Canonical Transcript Export And Replay](../specs/005-provider-driver-contract-and-capabilities.md#canonical-transcript-export-and-replay) are taken from what shipped implementations converged on independently, not derived from first principles.

---

## Assumptions Audit [T2]

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | Both V1 providers admit prior-turn content into a session they did not themselves produce. | [Codex wire reference §`thread/inject_items`](../reference/provider-wire/codex.md#threadinject_items--item-injection) — `items: Array<JsonValue>`, documented at the pin as "Raw Responses API items to append to the thread's model-visible history" (Verified, `0.149.1`); the Claude side is **partly unvalidated** — the resume-behavior family is Verified present in the `2.1.245` census but the reference declines to assert its semantics ([§CLI / wire surface](../reference/provider-wire/claude.md#cli--wire-surface)), so the admission path is confirmed by the Plan-005 replay gate before load-bearing use, not assumed here. | Replay is unavailable for that provider; it declares `transcript_replay: false` and the memo projection becomes its floor. The decision survives; the capability degrades visibly — which is exactly why the fifth row of §Enumerated Gates And Fallbacks exists. |
| 2 | The normalized event stream is lossless with respect to **participant-visible** content. | The timeline renders from the same log and from nothing else ([Spec-013 §Timeline Entry Types](../specs/013-live-timeline-visibility-and-reasoning-surfaces.md#timeline-entry-types)); a fact absent from the log is a fact no participant saw. | Replay would produce a conversation the participant did not see — the one failure this decision cannot tolerate, which is why sufficiency is scoped to visibility rather than to totality. |
| 3 | Provider-private reasoning has no portable representation across providers or across models. | **Both vendors state it as a rule.** Anthropic: on switching between any two models, strip `thinking` and `redacted_thinking` blocks from prior assistant turns, because [thinking blocks are tied to the model that produced them](https://platform.claude.com/docs/en/build-with-claude/thinking). OpenAI: [persisted reasoning can be reused only within the same model family](https://developers.openai.com/api/docs/guides/reasoning). This is therefore a **Verified** constraint, not a conservative guess. | Nothing breaks — a portable representation would only widen what replay can carry. The narrower operational risk is the reverse: carrying reasoning across a boundary a vendor prohibits, which §Failure Mode Analysis covers. |
| 4 | A provider switch is an unconditional prompt-cache miss. | **Vendor-documented on both sides, and true even for a same-vendor model change.** Anthropic: each model has its own cache, so switching means [the next request reads the entire conversation history with no cache hits, even though the content is identical](https://code.claude.com/docs/en/prompt-caching). OpenAI: cache reuse requires the entire rendered prefix to match, and [`model` is a row in the cache-key table](https://developers.openai.com/api/docs/guides/prompt-caching). A cross-_provider_ switch differs additionally in system preamble and tool schemas, so the prefix cannot match by construction. | The cost argument in Antithesis (a) weakens further in this decision's favour, not against it: the miss is not a consequence of choosing replay, it is a consequence of switching at all. |
| 5 | Tool-call identity must be preserved across a replay, and unpaired calls must be repaired by the daemon rather than left to the provider. | The injection surface is **untyped at the wire** — `items` is `Array<JsonValue>` ([Codex wire reference §`thread/inject_items`](../reference/provider-wire/codex.md#threadinject_items--item-injection)) — so the protocol validates no call/result pairing and cannot refuse an unpaired transcript. The consequence is observed in the field and is **not recoverable by retry**: a single unpaired tool call in persisted history is rejected by protocol-strict providers on **every subsequent request**, and re-minting identifiers is a documented _cause_ rather than a fix ([opencode #44852](https://github.com/anomalyco/opencode/issues/44852)). | A replayed session carries tool history that does not match what happened, and then stops working permanently. This is why pairing-integrity repair is a **required** post-strip step, why replay never re-mints tool-call identifiers, and why a structural rejection is classified permanent rather than retried. |

## Failure Mode Analysis [T2]

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| A vendor changes its input surface and replay frames stop being accepted. | Med | High | The post-replay assertion required by [Spec-005 §Canonical Transcript Export And Replay](../specs/005-provider-driver-contract-and-capabilities.md#canonical-transcript-export-and-replay) — a replayed session that answers with zero turns, or refuses, fails the operation. The nightly provider-CLI compatibility check is the early warning. | Capability flips `transcript_replay: false` at the next probe; the memo projection takes over; the operation reports `degraded` with the losses declared. |
| A vendor **silently accepts** malformed or unpaired replay frames. | Med | High | Not detectable from the call's return value, and this is a structural property rather than a guess: the injection surface is untyped at the wire, so the protocol has nothing to validate against and a bad frame returns success. Detection is therefore the same post-replay assertion, never "the call succeeded". | Same as above; the assertion is specified as the **only** admissible evidence that a replay worked, and pairing repair runs before any frame leaves the driver. |
| The canonical transcript exceeds the target provider's context window. | High | Med | The context-window telemetry already carried by [Spec-006 §Usage Telemetry](../specs/006-session-event-taxonomy-and-audit-log.md#usage-telemetry-usage_telemetry). | The memo projection with a bounded token budget and a protected tail of recent tool exchanges; the truncation is a declared loss, not a silent one. |
| Reasoning-stripping breaks tool-call pairing. | Med | High | Pairing integrity is asserted after the transform, before the frames leave the driver boundary. | The repair pass is ordered strictly **after** the strip, and a call that cannot be paired takes a synthetic error result rather than being dropped. |
| A structurally invalid history reaches a provider and is rejected. | Med | **High** | The rejection is a protocol-level refusal on the request, and it recurs identically on every subsequent request in that session — which is itself the detection signal: a refusal that survives a retry is structural, not transient. | Classified **permanent** and never retried. The session's provider binding is discarded and rebuilt from the canonical transcript, which is the one record guaranteed not to carry the defect. Retrying a structural refusal is specified as a defect: it re-sends the same broken history and cannot recover. |
| A switch is performed while the target model's own last assistant turn is still the newest content. | Med | Med | Pre-dispatch, from the transcript's own tail. | Switches apply at a **turn boundary after the last assistant turn has completed** ([Spec-016 §Same-Agent Provider Switch](../specs/016-multi-agent-channels-and-orchestration.md#same-agent-provider-switch)). The asymmetry is the reason: a vendor may silently ignore stale reasoning on _prior_ assistant turns, but modifying the _latest_ assistant turn's reasoning sequence is a hard refusal — so the boundary default is a correctness rule, not only a courtesy to work in flight. |
| Both records survive but disagree (e.g. a provider-side compaction the daemon did not observe). | Low | Med | The provider's own compaction is already evented as `usage.context_compacted`. | The canonical record wins by this decision; the provider session is discarded and replayed rather than reconciled — the point of having a single authority. |

## Reversibility Assessment

- **Reversal cost:** Weeks. Reversing means every capability that today falls back to replay must acquire a provider-native path, which for the cross-vendor case does not exist at all — so a true reversal is a scope reduction, not a refactor.
- **Blast radius:** Spec-004 (rollback), Spec-005 (driver boundary and capabilities), Spec-006 (the event shapes the projection folds), Spec-015 (recovery and replay), Spec-016 (the provider switch), Spec-024 (cross-node dispatch).
- **Migration path:** Pin each capability to a provider-native verb, drop the cross-vendor switch, and re-declare the provider store authoritative — i.e. adopt Option B and lose its rejected consequences.
- **Point of no return:** The first shipped driver whose only continuity path is canonical replay. After that, reversing removes a capability from a shipped provider rather than changing an internal mechanism.

## Consequences

### Positive

- A provider switch becomes expressible, and with it the whole class of "continue this conversation somewhere else".
- Rollback, recovery, cross-node dispatch, and switch share one reconstitution mechanism instead of four provider-specific ones.
- No vendor's private file format is load-bearing; a vendor patch release cannot destroy session content.
- Losses become declared rather than discovered: what cannot be carried is named at the operation that drops it.

### Negative (accepted trade-offs)

- A prompt-cache miss on every fallback path. Accepted because every such path is one where continuity was already broken.
- Provider-exact rewind stops being a dependency (it remains an optimization). Accepted because depending on it makes rollback unavailable exactly where it is most needed.
- Two code paths per driver instead of one flag. Accepted because the risk moves into code we own and test.
- Every future provider must satisfy the replay contract or ship visibly diminished. Accepted, and made explicit rather than implicit.

### Unknowns

- How large a session gets before the memo projection, rather than full replay, becomes the ordinary case. This is measurable once the context-window telemetry has real sessions behind it, and it changes tuning rather than the decision.
- Whether a future vendor exposes a portable reasoning representation. If one does, Assumption 3's conservative arm relaxes by ordinary amendment and nothing else moves.

---

## Decision Validation [T2]

### Pre-Implementation Checklist

- [x] All unvalidated assumptions have a validation plan — Assumption 5 and the Codex half of Assumption 1 are pinned by the in-tree wire references and re-checked by the nightly provider-CLI compatibility check; the **Claude half of Assumption 1 is flagged unvalidated** and its validation plan is the Plan-005 replay assertion, which fails the operation rather than trusting a return value; Assumption 2 is structural (one log, one renderer); Assumptions 3 and 4 are conservative arms whose failure only widens what replay can carry.
- [x] At least one alternative was seriously considered and steel-manned — Options B, C, and D, each with a [T2] steel man written as its advocate.
- [x] Antithesis was reviewed by someone other than the author — Codex, on the NS-84 vehicle. The five counter-arguments are answered individually in §Synthesis, and (c) is answered by **narrowing the claim** to visibility sufficiency + declared loss + named non-portability rather than by dismissal.
- [x] Failure modes have detection mechanisms — every row of §Failure Mode Analysis names a detection that is an assertion about observed behavior, never a return value; the silent-acceptance row exists precisely because the return value is known to be untrustworthy.
- [x] Point of no return is identified and communicated — §Reversibility Assessment: the first shipped driver whose only continuity path is canonical replay.

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Continuity capabilities with a named daemon-side fallback | 5 of 5 rows in §Enumerated Gates And Fallbacks | Direct count against the Spec-005 capability matrix | At Plan-005 Phase 3 merge |
| Replay operations reporting `applied` on a false capability gate | 0 | The post-replay assertion is the only admissible evidence; a gate-false path reports `degraded` | At Plan-005 Phase 3 merge |
| Switch operations that drop a fact without declaring it | 0 | Every switch carries `declaredLosses[]`; an empty list asserts nothing was dropped | At Plan-016 Phase 2 merge |

---

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| [Codex wire reference §`thread/inject_items`](../reference/provider-wire/codex.md#threadinject_items--item-injection) | In-tree pinned wire reference (**Verified** at `0.149.1`, Generated-schema provenance) | A thread's model-visible history is appendable by the client, and the item payload is `Array<JsonValue>` — **untyped at the wire**. The protocol therefore validates no tool-call pairing and cannot refuse an unpaired transcript, which is the structural ground for Assumption 5 and for the second failure mode. | In-tree |
| [Codex wire reference §`thread/rollback`](../reference/provider-wire/codex.md#threadrollback--session-time-travel-conversation-leg) | In-tree pinned wire reference (**Verified** at `0.149.1`) | The provider's own rewind reverts the conversation only and explicitly does not revert local file changes; the non-deprecated branch verb is `thread/fork` with an inclusive `lastTurnId` boundary. Both facts are why a provider verb is an optimization here rather than a complete operation. | In-tree |
| [Claude wire reference §CLI / wire surface](../reference/provider-wire/claude.md#cli--wire-surface) | In-tree pinned wire reference (**Verified** binary census at `2.1.245`) | The resume-behavior family (`--resume`, `--fork-session`, `--resume-session-at`, `--resume-drops-turn`, `--reply-on-resume`, `--no-session-persistence`) is present at the pin, and the reference deliberately asserts **presence, not semantics** for the probed members. Presence is not availability — the file's own worked counterexample is a removed feature whose flag string survives in the binary. | In-tree |
| [Claude wire reference §Gaps recorded](../reference/provider-wire/claude.md#gaps-recorded) | In-tree pinned wire reference | The rewind target flag is Verified present in the binary and Verified **absent** from that build's own `--help` and from the live CLI reference — a documented divergence between what a vendor ships and what a vendor documents, and the concrete case for not depending on either. | In-tree |
| [Anthropic — Extended thinking](https://platform.claude.com/docs/en/build-with-claude/thinking) | Vendor documentation | On switching between any two models, prior assistant turns' `thinking` and `redacted_thinking` blocks must be stripped: thinking blocks are tied to the model that produced them. Stale prior-turn blocks are ignored (a token cost), but the **latest** assistant turn's reasoning sequence cannot be modified — the asymmetry behind the turn-boundary rule. | Accessed 2026-08-26 |
| [OpenAI — Reasoning](https://developers.openai.com/api/docs/guides/reasoning) | Vendor documentation | Persisted reasoning is reusable only within the same model family; stateless replay carries it as encrypted content. Together with the Anthropic rule, this makes reasoning non-portability a documented constraint rather than an assumption. | Accessed 2026-08-26 |
| [Anthropic — Prompt caching (Claude Code)](https://code.claude.com/docs/en/prompt-caching) and [OpenAI — Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) | Vendor documentation | Each model has its own cache, so a switch reads the whole history with no cache hits even when the content is identical; OpenAI lists `model` in its cache-key table and requires an exact rendered-prefix match. Assumption 4 is documented, not inferred. | Accessed 2026-08-26 |
| [ACP — Session setup](https://agentclientprotocol.com/protocol/session-setup) and [OTel GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai) | Specification | The two strongest candidates for an off-the-shelf transcript format: ACP replays agent→client only and accepts no history on session creation; OTel GenAI is `stability: development` and models reasoning as plain `{type, content}`. The evidence base for Option E's rejection. | Accessed 2026-08-26 |
| [Vercel AI SDK — harness contract](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-adapters) | Repository source / documentation | A vendor that built adapters for both of this project's providers and declined to define a portable transcript: the harness session owns its history and prior turns are never replayed across the contract. The revealed industry bar. | Accessed 2026-08-26 |
| [opencode #44852](https://github.com/anomalyco/opencode/issues/44852) | Field failure report | A single dangling tool-call id in persisted history is rejected on every subsequent request, and automatic retries cannot recover because they resend the same broken history. The evidence for classifying structural refusals permanent. | Accessed 2026-08-26 |
| [open-swe #1705](https://github.com/langchain-ai/open-swe/pull/1705) | Field fix (merged) | Stripping stale reasoning _orphans_ function calls — the coupling that makes the strip-then-repair ordering load-bearing rather than stylistic. | Accessed 2026-08-26 |
| [Spec-006 §Event Type Summary](../specs/006-session-event-taxonomy-and-audit-log.md#event-type-summary) | Corpus primary source | The normalized event taxonomy is the complete set of facts a driver may report, and therefore the complete set the canonical transcript can fold. | In-tree |
| [Spec-013 §Timeline Entry Types](../specs/013-live-timeline-visibility-and-reasoning-surfaces.md#timeline-entry-types) | Corpus primary source | The participant-visible timeline renders from the session event log and from nothing else — the structural ground for Assumption 2. | In-tree |

### Related ADRs

- [ADR-005: Provider Drivers Use A Normalized Interface](./005-provider-drivers-use-a-normalized-interface.md) — supplies the normalized boundary that makes a canonical transcript derivable; this decision adds the replay contract to that boundary's price of admission.
- [ADR-017: Shared Event Sourcing Scope](./017-shared-event-sourcing-scope.md) — ruled the local event log authoritative for the session; this decision applies that ruling to the one record ADR-017 did not name, the provider's own session store.
- [ADR-018: Cross-Version Compatibility](./018-cross-version-compatibility.md) — governs compatibility for shapes the corpus defines; a provider's private session format is outside its reach, which is the compatibility argument for not depending on one.
- [ADR-006: Worktree-First Execution Mode](./006-worktree-first-execution-mode.md) — file state is restored by the worktree layer, not by any provider rewind verb; the two restorations are separate and neither substitutes for the other.

## Decision Log

| Date | Event | Notes |
| --- | --- | --- |
| 2026-08-26 | Research conducted | The in-tree pinned wire references (`claude` 2.1.245, `codex` 0.149.1) read for the continuity surfaces each vendor exposes, establishing Assumption 5 and the confirmed half of Assumption 1; corpus survey establishing Assumption 2. Assumption 1's Claude half is recorded **unvalidated** and gated on the Plan-005 replay assertion rather than asserted. |
| 2026-08-26 | Proposed | Authored on the NS-84 vehicle, triggered by the same-agent provider switch, which has no provider-native path by construction. |
| 2026-08-26 | Accepted | Accepted in the same swap. Every antithesis point is answered in §Synthesis — (c) by narrowing the sufficiency claim to visibility + declared loss + named non-portability, and (a) by bounding replay to paths where continuity was already broken — and §Enumerated Gates And Fallbacks makes the synthesis checkable by direct count rather than by assurance. |
