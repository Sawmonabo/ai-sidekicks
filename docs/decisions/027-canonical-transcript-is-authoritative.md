# ADR-027: The Canonical Transcript Is Authoritative For Provider Sessions

| Field         | Value                                                     |
| ------------- | --------------------------------------------------------- |
| **Status**    | `accepted`                                                |
| **Type**      | `Type 2 (one-way door)`                                   |
| **Domain**    | `Provider Integration / Persistence / Session Continuity` |
| **Date**      | `2026-08-26`                                              |
| **Author(s)** | `Claude (AI-assisted)`                                    |
| **Reviewers** | `Codex`                                                   |

## Context

Every provider the runtime drives keeps its own record of the conversation, and each exposes its own verbs for continuing that record. At the versions this project pins, Claude Code resumes a stored session with `--resume`, branches it with `--fork-session`, and can be told not to store one at all with `--no-session-persistence` ([Claude wire reference §CLI / wire surface](../reference/provider-wire/claude.md#cli--wire-surface), all three Verified in the `2.1.245` census); codex-cli keeps threads inside its app-server process, cuts a thread's own history before a turn through `thread/revert {threadId, beforeTurnId}`, and branches through `thread/fork` with an inclusive `lastTurnId` boundary ([§`thread/revert`](../reference/provider-wire/codex.md#threadrevert--the-undos-conversation-cut), Verified by binary probe at `0.155.1` and `0.156.0`). What none of them expose is a documented, versioned **format** for the stored record itself. The stores are private, and free to change in a patch release — the same reference file records a Codex method, `thread/rollback`, that was a client request at `0.150.1`, was refused as an unknown method at `0.156.0` and is gone from the API since, and a Claude flag string that survives in the binary five versions after the feature it named was removed.

The daemon keeps its own record too. [ADR-016](./016-shared-event-sourcing-scope.md) already rules that the local `session_events` log is authoritative for the session, and [Spec-005](../specs/005-session-event-taxonomy-and-audit-log.md) defines the normalized event shapes every driver emits into it through the [Spec-004](../specs/004-provider-driver-contract-and-capabilities.md) boundary. The transcript a user sees on screen ([Spec-011](../specs/011-transcript-and-reasoning.md)) renders from that log and from nothing else.

So two records of the same conversation exist side by side, and nothing in the corpus says which one is the authority — or, more sharply, what the runtime is permitted to _depend on_ the provider to supply. The question stays theoretical only while every capability that touches continuity has a provider-native path.

## Problem Statement

When the daemon's canonical record and a provider's own session store disagree — or when the provider session is gone, unreachable, refuses the operation, or belongs to a different vendor entirely — which record is the authority, and what may a capability depend on the provider to supply?

### Trigger

The same-agent provider switch ([Spec-014 §Same-Agent Provider Switch](../specs/014-multi-agent-orchestration.md#same-agent-provider-switch)). Moving an agent from one provider to another mid-session has no provider-native path **by construction**: no vendor's resume verb accepts another vendor's session, and none ever will. Either the daemon can carry the conversation from its own record, or the capability cannot ship. Three other V1 capabilities lean on the same answer — undo, which reads the point it forks at from the daemon's own record of the stream ([Spec-003](../specs/003-queue-steer-pause-resume.md)), recovery ([Spec-013](../specs/013-persistence-recovery-and-replay.md)), and forking a session ([Spec-001](../specs/001-session-core.md)'s `session.fork`) — and without one ruling each would answer it locally and by implication.

---

## Decision

**We will treat the daemon's canonical transcript — a projection rebuilt from the `session_events` log — as the sole authority for the content of a provider session, and no transcript is replayed into a fresh provider session.** The provider's own continuity verbs — its resume, its cut and its fork — are the paths, each behind its capability flag. Where one cannot apply, the capability reports what did not apply, with its cause, rather than substituting an approximation, and the one thing built from the record for a new process is the hand-over brief (§Enumerated Gates And Fallbacks).

### Thesis — Why This Option

**It is the only design under which the trigger is expressible.** A cross-vendor continuation has no shortcut to gate on. If the canonical record is not sufficient to reconstitute a conversation, the provider switch is not a hard feature — it is an impossible one.

**It extends a ruling the corpus already made rather than making a new one.** ADR-016 rules that the local log is authoritative for the session. This decision says the provider's copy is not a second authority that happens to agree; it is where the provider continues the conversation, and the daemon's record is what the conversation contains. That is the same ruling, applied to the one record ADR-016 did not name.

**It refuses to make a vendor's private format a load-bearing schema.** [ADR-017](./017-cross-version-compatibility.md) governs compatibility for shapes we define. It cannot govern a provider's on-disk session store, whose format we neither own nor pin. A design that depends on that store makes a vendor patch release a data-loss event in a product whose central promise is an auditable record.

**It costs no new store.** The canonical transcript is a projection of events the runtime already persists — [ADR-005](./005-provider-drivers-use-a-normalized-interface.md)'s normalized boundary is what makes it derivable at all. Nothing is written twice.

**It names what each continuity capability does without a provider path.** The provider switch, and a recovery the person continues with a hand-over, take the hand-over brief built from the canonical record; undo and fork use the provider's own cut and fork and, where those cannot apply, report it with its cause (§Enumerated Gates And Fallbacks).

### Antithesis — The Strongest Case Against [T2]

**(a) Native rewind is exact; a reconstruction is an approximation.** A provider unwinding its own store knows precisely what the model saw. Ours is a re-derivation: private reasoning stripped and the conversation summarized, from shapes we normalized on the way in. Giving up exactness is a strange trade in a product that sells auditability.

**(b) The sufficiency claim cannot be proved for state we cannot see.** Provider-private state — encrypted reasoning, server-side memory, cached tool schemas, per-session model configuration — has no canonical representation. Asserting that the transcript is sufficient asserts something about the invisible.

### Synthesis — Why It Still Holds [T2]

**(a) is accepted with the exactness preserved where it exists.** Undo goes back through the provider's own verbs at every point — the provider's conversation cut, and before Claude Code's last compaction the provider's own copy of the conversation resumed in place ([Spec-003](../specs/003-queue-steer-pause-resume.md)) — so the conversation it puts back is exactly what the model saw. Where those verbs cannot apply, the undo says so with its cause rather than substituting a replay (§Why recovery and undo never replay). The hand-over brief is for what can take an approximation and declare it: a switch to a different provider, and a recovery the person continues with a hand-over. We keep the exact path, and we never present an approximation as it.

**(b) is the strongest objection, and it narrows the claim rather than being rebutted.** We do not claim the transcript reproduces provider-private state. We claim, and this decision requires, three narrower things:

1. **Visibility sufficiency** — every fact a user can see in the on-screen transcript is present in the daemon's canonical transcript, because the two render from the same log.
2. **Declared loss** — whatever is not portable is declared _at the moment of the operation that drops it_ (the `declaredLosses[]` list on a switch), never silently lost.
3. **Named non-portability** — provider-private reasoning is declared non-portable **here**, as a decision, rather than discovered later as a bug. Visible reasoning summaries carry forward as plain text; private reasoning does not carry at all.

A capability that cannot honor all three refuses, or reports `degraded` with the loss named. It never reports `applied`.

### Enumerated Gates And Fallbacks

The synthesis above is only checkable if "what each capability does without its provider verb" is an enumeration rather than a posture. It is:

| Provider-native shortcut | Capability gate ([Spec-004 §Per-Driver Capability Matrix](../specs/004-provider-driver-contract-and-capabilities.md#per-driver-capability-matrix)) | What happens when the gate is false or the call refuses |
| --- | --- | --- |
| Continue an existing session | `resume` | No replay: a resume that cannot load fails the run, and one whose record diverged from the daemon's halts for the person's choice, `Continue with a hand-over` among its arms ([Spec-013 §Fallback Behavior](../specs/013-persistence-recovery-and-replay.md#fallback-behavior)) |
| Unwind to an earlier point | `rollback` — the provider's own conversation cut (Claude Code `rewind_conversation`, Codex `thread/revert`), and before Claude Code's last compaction the provider's own copy of the conversation, resumed in place | No replay: the conversation part is reported not applied with its cause, and the files go back through the daemon's own checkpoint store |
| Branch a session | `session_fork`, registered together with its caller, [Spec-001](../specs/001-session-core.md)'s `session.fork`, through the driver's `forkConversation`: Codex `thread/fork` at an inclusive turn, Claude Code `--resume-session-at` with `--fork-session` | No replay: `session.fork` is refused with `driver.capability_unsupported` |
| Continue under a different provider | none exists, by construction | A **hand-over brief** built from the canonical record, with the whole canonical transcript written beside it as one plain file the new provider reads on demand — the case this decision was triggered by |

**How much of the canonical record travels inside a message is a delivery question, not an authority question.** Where a fresh process of the **same** provider can reopen its own conversation, it does, and nothing is re-sent as text; where the new process belongs to a **different** provider, the brief above carries the summary and the tail while the whole transcript sits beside it as a file the new provider opens for itself; and no transcript is replayed as text into a fresh session. In both the canonical record is the source and the authority — the expensive thing is not pushed into the message, and it is still reachable. What this decision rules is that the record is sufficient to carry the conversation, not that the whole of it must be pasted into one ([Spec-004 §The Canonical Transcript And The Hand-Over Brief](../specs/004-provider-driver-contract-and-capabilities.md#the-canonical-transcript-and-the-hand-over-brief), [Spec-014 §Continuity, and what is declared rather than dropped](../specs/014-multi-agent-orchestration.md#continuity-and-what-is-declared-rather-than-dropped)).

#### Why recovery and undo never replay

Recovery and undo are the two rows where a replay of the canonical record might look like an answer, and each consuming spec names why it is not one:

- **Row 1, recovery.** [Spec-013 §Fallback Behavior](../specs/013-persistence-recovery-and-replay.md#fallback-behavior) transitions an unresumable run to `failed` rather than replaying it into a fresh session. The reason is this decision's own boundary: the canonical transcript is authoritative for the **conversation** and never for the **world**. A crashed run's in-flight turn may have executed tool calls whose effects are on disk, and replaying the conversation that requested them reconstructs the request, not the result — file-state restore is the daemon's own checkpoint store, never the driver's ([Spec-004 §Per-Driver Capability Matrix](../specs/004-provider-driver-contract-and-capabilities.md#per-driver-capability-matrix), the `rollback` row). Not replaying is what keeps a recovered run from asserting a world state nothing produced.
- **Row 2, undo.** [Spec-003 §Required Behavior](../specs/003-queue-steer-pause-resume.md#required-behavior) never substitutes a prefix replay for the provider's own conversation cut. Undo reaches every point through the provider's own verbs — the cut, and before Claude Code's last compaction the provider's own copy of the conversation resumed in place — and when the conversation part cannot apply, it reports that part not applied with its cause, beside the files, which the daemon's checkpoint store puts back on its own. A prefix replay would put back an approximation of the conversation under a result that says the conversation went back, and the undo's result has no outcome for an approximation. Not replaying is fail-closed against that disagreement.

What this decision forbids is a capability that silently depends on a provider-native verb and has no answer at all when the verb is absent: each row above names its answer.

---

## Alternatives Considered

### Option A: Canonical transcript authoritative; the provider continues its own conversation (Chosen)

- **What:** The `session_events` projection is the authority. The provider's own resume, cut and fork are the continuity paths, each behind its flag; no transcript is replayed into a fresh provider session, and a different provider starts from the hand-over brief built from the record.
- **Steel man:** It is the only option under which a cross-vendor continuation exists; it extends ADR-016 rather than competing with it; it introduces no new durable store; and it names what undo, recovery, fork and the provider switch each do when the provider's verb cannot apply.
- **Weaknesses:** Pays a prompt-cache miss on every hand-over brief; keeps undo's conversation part and the fork on the provider's own verbs, with no replay behind them.

### Option B: Provider session authoritative; the daemon log is an audit copy (Rejected)

- **What:** The provider owns conversational state. The daemon records events for display and audit, and continuity is always the vendor's resume path.
- **Steel man:** [T2] It is the cheapest and the least code — one flag per provider instead of two code paths. It is _exact_ in a way nothing else can be: the provider's store is, by definition, what the model actually saw, including the private state we can never represent. It keeps the prompt cache warm on every operation, which on long sessions is the dominant cost. And it is honest about the division of labor — the vendor is better placed to maintain its own session semantics than we are to re-derive them.
- **Why rejected:** It makes the provider switch and recovery after the provider's own store is gone unimplementable rather than merely expensive — there is no vendor path for either. It contradicts ADR-016's ruling on the same records. And it promotes an undocumented, unversioned vendor file format to a load-bearing schema, which ADR-017's compatibility discipline cannot reach.

### Option C: Dual authority with reconciliation (Rejected)

- **What:** Trust the provider's store while the session lives, fall back to the log when it does not, and reconcile the two on divergence.
- **Steel man:** [T2] It appears to take the best of both: warm caches and exact rewind in the common case, survivability in the uncommon one. It matches how caches are normally treated — authoritative while valid, rebuilt when not — and it needs no new claim about sufficiency, because the log is only consulted when the provider cannot answer.
- **Why rejected:** Two authorities require a divergence policy, and there is no signal by which to adjudicate one: the provider's store is opaque, so "reconcile" degenerates to "believe one of them", which is an authority decision made per incident instead of once. It also doubles the failure surface in exactly the place with the least observability, and the fallback path — being rare — is the one least exercised and most likely to be broken when finally needed.

### Option D: A separate durable transcript store (Rejected)

- **What:** Maintain the canonical transcript as its own durable artifact — a `transcripts` table written alongside the event log.
- **Steel man:** [T2] An explicit store is easy to reason about, cheap to read, and needs no projection logic on the read path. It would let the transcript carry provider-shaped detail the normalized event taxonomy deliberately drops, and it would make the brief's read a table read rather than a fold.
- **Why rejected:** It is a second record of facts the log already holds, which must then be kept in step with it — Option C's divergence problem relocated inside our own process, where it would be our bug rather than the vendor's. The canonical transcript is therefore specified as a **projection rebuilt from the log**, never a store, and never a one-shot migration.

### Option E: Adopt an existing interchange format as the canonical transcript (Rejected)

- **What:** Rather than specifying a projection of our own, adopt a published conversation format — the Agent Client Protocol, OpenTelemetry's GenAI message model, or a widely-used framework shape such as the Vercel AI SDK's `UIMessage` — and treat it as the canonical transcript.
- **Steel man:** [T2] Reuse beats invention, especially for an interchange format, where the whole value is that someone else already argued the edge cases. ACP is versioned, cross-vendor, and has real implementations against both of our providers. OTel GenAI is genuinely vendor-neutral, JSON-Schema'd, and this stack already emits OpenTelemetry, so the transcript and the telemetry would share a vocabulary for free. Adopting either would make our record legible to tooling we did not write, and would let us inherit a migration story rather than author one.
- **Why rejected:** The premise fails on inspection — none of the candidates is a specified, versioned, cross-vendor _persisted transcript_ format, and every one is lossy on the exact axis that matters here. [ACP](https://agentclientprotocol.com/protocol/session-setup) replays agent→client only; its `session/new` and `LoadSessionRequest` accept no history payload, so an ACP-shaped record cannot be used to _seed_ an agent, and its content model carries reasoning only as a plaintext streaming chunk with no signature or encrypted-content representation. [MCP](https://modelcontextprotocol.io/) has no transcript concept at all and its sampling shapes are deprecated. [OTel GenAI's message model](https://github.com/open-telemetry/semantic-conventions-genai) is `stability: development` with Opt-In requirement level, and its reasoning part is exactly `{type, content}` — no signature, no provider envelope. The [Vercel AI SDK's `UIMessage`](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence) carries no version discriminator and has taken breaking shape changes across successive majors, with the vendor's own guidance for unparseable stored history being to start from an empty array.

  Two market actors settle it. Vercel built harness adapters for both of the CLIs this project drives and **declined to define a portable transcript**: its harness contract states that the harness session owns its own history and prior turns are never replayed across the contract, and its resume state is an opaque adapter-scoped payload that adapters refuse when mismatched. OpenAI ships an importer that migrates Claude Code and Cursor sessions into Codex, and it **flattens them to plain text and drops reasoning entirely**. When the two organizations best placed to define this format have each looked at it and chosen not to, "adopt the standard" has no standard to adopt.

  What is reused is everything below the format: the **shape vocabulary** aligns with OTel GenAI's part kinds so the projection into `gen_ai.*` telemetry stays cheap; and the **boundary disciplines** in [Spec-004 §The Canonical Transcript And The Hand-Over Brief](../specs/004-provider-driver-contract-and-capabilities.md#the-canonical-transcript-and-the-hand-over-brief) are taken from what shipped implementations converged on independently, not derived from first principles.

---

## Assumptions Audit [T2]

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | The normalized event stream is lossless with respect to **user-visible** content. | The on-screen transcript renders from the same log and from nothing else ([Spec-011 §Transcript Entry Types](../specs/011-transcript-and-reasoning.md#transcript-entry-types)); a fact absent from the log is a fact no user saw. | The brief would carry a conversation the user did not see — the one failure this decision cannot tolerate, which is why sufficiency is scoped to visibility rather than to totality. |
| 2 | Provider-private reasoning has no portable representation across providers or across models. | **Both vendors state it as a rule.** Anthropic: on switching between any two models, strip `thinking` and `redacted_thinking` blocks from prior assistant turns, because [thinking blocks are tied to the model that produced them](https://platform.claude.com/docs/en/build-with-claude/thinking). OpenAI: [persisted reasoning can be reused only within the same model family](https://developers.openai.com/api/docs/guides/reasoning). This is therefore a **Verified** constraint, not a conservative guess. | Nothing breaks — a portable representation would only widen what the brief can carry. |
| 3 | A provider switch is an unconditional prompt-cache miss. | **Vendor-documented on both sides, and true even for a same-vendor model change.** Anthropic: each model has its own cache, so switching means [the next request reads the entire conversation history with no cache hits, even though the content is identical](https://code.claude.com/docs/en/prompt-caching). OpenAI: cache reuse requires the entire rendered prefix to match, and [`model` is a row in the cache-key table](https://developers.openai.com/api/docs/guides/prompt-caching). A cross-_provider_ switch differs additionally in system preamble and tool schemas, so the prefix cannot match by construction. | Nothing breaks: the miss is not a consequence of how the conversation is carried, it is a consequence of switching at all. |

## Failure Mode Analysis [T2]

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| The canonical transcript exceeds the target provider's context window. | High | Med | The context-window telemetry already carried by [Spec-005 §Usage Telemetry](../specs/005-session-event-taxonomy-and-audit-log.md#usage-telemetry-usage_telemetry). | The hand-over brief, whose verbatim tail is bounded as a fraction of the target's own window and whose tool exchanges are evicted whole or not at all, with the rest of the transcript reachable as the file beside it; the truncation is a declared loss, not a silent one. |
| A switch is performed while the target model's own last assistant turn is still the newest content. | Med | Med | Pre-dispatch, from the transcript's own tail. | Switches apply at a **turn boundary after the last assistant turn has completed** ([Spec-014 §Same-Agent Provider Switch](../specs/014-multi-agent-orchestration.md#same-agent-provider-switch)). The asymmetry is the reason: a vendor may silently ignore stale reasoning on _prior_ assistant turns, but modifying the _latest_ assistant turn's reasoning sequence is a hard refusal — so the boundary default is a correctness rule, not only a courtesy to work in flight. |
| Both records survive but disagree (e.g. a provider-side compaction the daemon did not observe). | Low | Med | The provider's own compaction is already evented as `usage.context_compacted`. | The run halts for the person's choice ([Spec-013 §Fallback Behavior](../specs/013-persistence-recovery-and-replay.md#fallback-behavior)): continue from the provider's record, the daemon's extra rows kept visible and marked `not in the agent's context`, or continue with a hand-over built from the canonical record; nothing is replayed. |

## Reversibility Assessment

- **Reversal cost:** Weeks. Reversing takes away the provider switch's one route, the hand-over brief built from the canonical record, and the cross-vendor case has no provider-native path at all — so a true reversal is a scope reduction, not a refactor.
- **Blast radius:** Spec-001 (the fork), Spec-003 (undo), Spec-004 (driver boundary and capabilities), Spec-005 (the event shapes the projection folds), Spec-013 (recovery and replay), Spec-014 (the provider switch).
- **Migration path:** Pin each capability to a provider-native verb, drop the cross-vendor switch, and re-declare the provider store authoritative — i.e. adopt Option B and lose its rejected consequences.

## Consequences

### Positive

- A provider switch becomes expressible, and with it the whole class of "continue this conversation somewhere else".
- Undo, recovery, fork and switch each name what they do when the provider's verb cannot apply.
- No vendor's private file format is load-bearing; a vendor patch release cannot destroy session content.
- Losses become declared rather than discovered: what cannot be carried is named at the operation that drops it.

### Negative (accepted trade-offs)

- A prompt-cache miss on every hand-over brief. Accepted because every such path is one where continuity was already broken.
- Undo's conversation part rests on the provider's own verbs and has no replay behind it: when they cannot apply, that part is reported not applied with its cause. Accepted because a replayed conversation is an approximation, and an undo that says the conversation went back must mean exactly that.

### Unknowns

- Whether a future vendor exposes a portable reasoning representation. If one does, Assumption 2's conservative arm relaxes and nothing else moves.

---

## Decision Validation [T2]

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Continuity capabilities that name what happens without their provider verb | Every row in §Enumerated Gates And Fallbacks | Direct count against §Enumerated Gates And Fallbacks itself; a row whose gate cell names no flag is verified against its last cell alone. Deliberately not a count against the Spec-004 capability matrix: one row registers no flag there, by construction, so a matrix-scoped count would miss that row and report a table that is complete as incomplete | At Plan-003 Phase 3 merge |
| Switch operations that drop a fact without declaring it | 0 | Every switch carries `declaredLosses[]`; an empty list asserts nothing was dropped | At Plan-013 Phase 2 merge |

---

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| [Codex wire reference §`thread/revert`](../reference/provider-wire/codex.md#threadrevert--the-undos-conversation-cut) | In-tree pinned wire reference (**Verified** by binary probe at `0.155.1` and `0.156.0`) | The provider's own rewind, `thread/revert {threadId, beforeTurnId}`, cuts the conversation only and does not revert local file changes; the branch verb is `thread/fork` with an inclusive `lastTurnId` boundary. Both facts are why a provider verb is one part of an operation here and never the whole of it. | In-tree |
| [Claude wire reference §CLI / wire surface](../reference/provider-wire/claude.md#cli--wire-surface) | In-tree pinned wire reference (**Verified** binary census at `2.1.245`) | The resume-behavior family (`--resume`, `--fork-session`, `--resume-session-at`, `--resume-drops-turn`, `--reply-on-resume`, `--no-session-persistence`) is present at the pin, and the reference deliberately asserts **presence, not semantics** for the probed members. Presence is not availability — the file's own worked counterexample is a removed feature whose flag string survives in the binary. | In-tree |
| [Claude wire reference §Gaps recorded](../reference/provider-wire/claude.md#gaps-recorded) | In-tree pinned wire reference | The rewind target flag is Verified present in the binary and Verified **absent** from that build's own `--help` and from the live CLI reference — a documented divergence between what a vendor ships and what a vendor documents, and the concrete case for not depending on either. | In-tree |
| [Anthropic — Extended thinking](https://platform.claude.com/docs/en/build-with-claude/thinking) | Vendor documentation | On switching between any two models, prior assistant turns' `thinking` and `redacted_thinking` blocks must be stripped: thinking blocks are tied to the model that produced them. Stale prior-turn blocks are ignored (a token cost), but the **latest** assistant turn's reasoning sequence cannot be modified — the asymmetry behind the turn-boundary rule. | Accessed 2026-08-26 |
| [OpenAI — Reasoning](https://developers.openai.com/api/docs/guides/reasoning) | Vendor documentation | Persisted reasoning is reusable only within the same model family; stateless replay carries it as encrypted content. Together with the Anthropic rule, this makes reasoning non-portability a documented constraint rather than an assumption. | Accessed 2026-08-26 |
| [Anthropic — Prompt caching (Claude Code)](https://code.claude.com/docs/en/prompt-caching) and [OpenAI — Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) | Vendor documentation | Each model has its own cache, so a switch reads the whole history with no cache hits even when the content is identical; OpenAI lists `model` in its cache-key table and requires an exact rendered-prefix match. Assumption 3 is documented, not inferred. | Accessed 2026-08-26 |
| [ACP — Session setup](https://agentclientprotocol.com/protocol/session-setup) and [OTel GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai) | Specification | The two strongest candidates for an off-the-shelf transcript format: ACP replays agent→client only and accepts no history on session creation; OTel GenAI is `stability: development` and models reasoning as plain `{type, content}`. The evidence base for Option E's rejection. | Accessed 2026-08-26 |
| [Vercel AI SDK — harness contract](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-adapters) | Repository source / documentation | A vendor that built adapters for both of this project's providers and declined to define a portable transcript: the harness session owns its history and prior turns are never replayed across the contract. The revealed industry bar. | Accessed 2026-08-26 |
| [Spec-005 §Event Type Summary](../specs/005-session-event-taxonomy-and-audit-log.md#event-type-summary) | Corpus primary source | The normalized event taxonomy is the complete set of facts a driver may report, and therefore the complete set the canonical transcript can fold. | In-tree |
| [Spec-011 §Transcript Entry Types](../specs/011-transcript-and-reasoning.md#transcript-entry-types) | Corpus primary source | The user-visible transcript renders from the session event log and from nothing else — the structural ground for Assumption 1. | In-tree |

### Related ADRs

- [ADR-005: Provider Drivers Use A Normalized Interface](./005-provider-drivers-use-a-normalized-interface.md) — supplies the normalized boundary that makes a canonical transcript derivable; this decision adds the hand-over brief to that boundary.
- [ADR-016: Shared Event Sourcing Scope](./016-shared-event-sourcing-scope.md) — ruled the local event log authoritative for the session; this decision applies that ruling to the one record ADR-016 did not name, the provider's own session store.
- [ADR-017: Cross-Version Compatibility](./017-cross-version-compatibility.md) — governs compatibility for shapes the corpus defines; a provider's private session format is outside its reach, which is the compatibility argument for not depending on one.
- [ADR-006: Worktree-First Execution Mode](./006-worktree-first-execution-mode.md) — where a session's files live; they go back through the daemon's own checkpoint store ([Spec-013 §Required Behavior](../specs/013-persistence-recovery-and-replay.md#required-behavior)), never through a provider verb, which puts back the conversation only, and never through the git snapshot.
