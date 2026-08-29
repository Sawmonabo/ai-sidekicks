// The memo projection floor (Plan-005 Phase 3, T3.21).
//
// Four properties carry this file, and each is asserted as a MECHANISM rather
// than as a shape:
//
//   * PAIRING SURVIVES THE BUDGET. The whole-exchange rule is asserted by
//     construction over generated transcripts rather than against one fixture,
//     with both vacuity guards checked explicitly: the corpus must actually
//     contain calls and results in DIFFERENT turns, and eviction must actually
//     have fired. A pairing invariant checked over a corpus that never evicted
//     is a tautology.
//   * ONCE-ONLY DELIVERY RESTS ON RECONCILIATION, NOT ON A CLEAN RETRY. The
//     lost-acknowledgment case is asserted against BOTH duplicate-producing
//     failures — the fake target that applies the frame and then rejects, and
//     the one that rejects while the frame is STILL BEING APPLIED, which is the
//     case a sequential retry raced into a second memo. Its negative control
//     blinds the readback across two coordinators, because that is the only
//     scope where reconciliation stands alone.
//   * THE KEY IS DERIVED, NOT STORED. Recomputation across a simulated restart
//     and across two independently constructed folds is the assertion, and the
//     discriminating case is an append belonging to ANOTHER run: it moves the
//     projection's `builtAtPosition` and must not move the key.
//   * NOTHING DURABLE IS WRITTEN. Asserted twice as an ABSENCE — an exhaustive
//     allow-list over the module's own import specifiers, and a proxy recorder
//     observing that the only members touched on the target across all four
//     delivery paths are the read and the send.
//
// Refs: Plan-005 §Phase 3 / T3.21, invariant I-005-9, ADR-029,
// `Spec-005 §Canonical Transcript Export And Replay`, `Spec-005 §Fallback Behavior`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type {
  CanonicalTranscriptProjection,
  CanonicalTranscriptSegment,
  CanonicalTranscriptTurn,
  RunId,
  SessionId,
} from "@ai-sidekicks/contracts";

import type { StoredEvent } from "../../../session/types.js";
import {
  CanonicalTranscriptFold,
  type TranscriptContentReference,
  type TranscriptContentSource,
  type TranscriptEventReader,
  type TranscriptReasoningBlock,
  type TranscriptToolResultBody,
} from "../canonical-transcript.js";
import {
  DEFAULT_PROTECTED_TAIL_TOOL_EXCHANGE_COUNT,
  MEMO_CONTINUITY_MARKER_PREFIX,
  MemoDeliveryCoordinator,
  MemoProjection,
  TranscriptReconstitutionRouter,
  defaultMemoBudgetPolicy,
  deriveMemoIdentityKey,
  partitionIntoExchanges,
  renderMemoContinuityMarker,
  renderReconstitutionDisclosure,
  type MemoBudgetPolicy,
  type MemoDeliveryRequest,
  type MemoDeliverySettlement,
  type MemoOutboundFrame,
  type MemoRendering,
  type MemoSendSettlementBarrier,
  type MemoTargetGateway,
  type MemoTargetIdentity,
  type ReconstitutionSettlement,
  type TranscriptExchange,
} from "../memo-projection.js";

const SESSION_ID: SessionId = "session-memo-projection" as SessionId;
const RUN_ID: RunId = "run-memo-projection" as RunId;
const OTHER_RUN_ID: RunId = "run-memo-unrelated" as RunId;

const TARGET: MemoTargetIdentity = { providerSessionId: "provider-session-target-1" };
const OTHER_TARGET: MemoTargetIdentity = { providerSessionId: "provider-session-target-2" };

/** Wide enough that the whole fixture fits, so eviction is opt-in per case. */
const ROOMY_BUDGET: MemoBudgetPolicy = defaultMemoBudgetPolicy(1_000_000);

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

function turn(
  position: number,
  role: "participant" | "assistant",
  segments: readonly CanonicalTranscriptSegment[],
): CanonicalTranscriptTurn {
  return { position, role, segments };
}

function projectionOf(
  turns: readonly CanonicalTranscriptTurn[],
  builtAtPosition = 100,
): CanonicalTranscriptProjection {
  return { sessionId: SESSION_ID, runId: RUN_ID, builtAtPosition, turns };
}

function requestFor(
  projection: CanonicalTranscriptProjection,
  budget: MemoBudgetPolicy = ROOMY_BUDGET,
  target: MemoTargetIdentity = TARGET,
): MemoDeliveryRequest {
  return { projection, target, budget };
}

/**
 * The target session, faked with the failure modes that matter.
 *
 * `readOutcomes` is consumed in order so a case can make the PRE-send read
 * succeed and the post-send readback fail — the ambiguity the floor is specified
 * against.
 *
 * Two duplicate-producing sends, not one, because they fail at different
 * moments. `apply-then-fail` lands the frame and loses the acknowledgment, which
 * a clean-retry test would not catch. `apply-late-then-fail` is the harder case
 * and the reason the register exists: the acknowledgment times out while the
 * provider is STILL APPLYING the frame, so every readback taken before
 * `applyPendingSends` legitimately finds no marker for a memo that is about to
 * land. A retry that reads one of those snapshots as a refusal sends a second
 * memo into the same conversation.
 */
class FakeTargetSession {
  readonly turns: string[] = [];
  readonly readOutcomes: Array<"ok" | "fail"> = [];
  sendBehavior: "accept" | "apply-then-fail" | "apply-late-then-fail" | "refuse" = "accept";
  sendAttempts = 0;
  readAttempts = 0;
  /** Blinds reconciliation, so the negative control can observe the duplicate. */
  reportNoTurns = false;
  /** Frames the provider accepted and has not finished applying. */
  readonly #framesStillApplying: string[] = [];

  /** The provider finishes applying whatever it was still working on. */
  applyPendingSends(): void {
    this.turns.push(...this.#framesStillApplying);
    this.#framesStillApplying.length = 0;
  }

  async readRecentTurns(): Promise<readonly string[]> {
    this.readAttempts += 1;
    if (this.readOutcomes.shift() === "fail") {
      throw new Error("target session could not be read");
    }
    return this.reportNoTurns ? [] : [...this.turns];
  }

  async sendMemoTurn(frame: MemoOutboundFrame): Promise<void> {
    this.sendAttempts += 1;
    // `wireText` rather than the authored prose: the readback must reconcile
    // against what the provider was actually handed.
    if (this.sendBehavior === "apply-then-fail") {
      this.turns.push(frame.frame.wireText);
      throw new Error("acknowledgment lost after the frame was applied");
    }
    if (this.sendBehavior === "apply-late-then-fail") {
      this.#framesStillApplying.push(frame.frame.wireText);
      throw new Error("acknowledgment timed out while the frame was still being applied");
    }
    if (this.sendBehavior === "refuse") {
      throw new Error("target session refused the frame");
    }
    this.turns.push(frame.frame.wireText);
  }
}

/**
 * An HONEST barrier: it waits for the provider session to go quiet, which means
 * anything still being applied finishes first. A readback taken after it is
 * therefore ordered behind the earlier send rather than racing it — which is the
 * whole of what a caller promises when it supplies one.
 */
function settlementBarrierFor(target: FakeTargetSession): MemoSendSettlementBarrier {
  return () => {
    target.applyPendingSends();
    return Promise.resolve();
  };
}

/**
 * A barrier that resolves without observing the provider at all — the shape a
 * caller reaches for first, and one no check inside the delivery could tell from
 * an honest wait. Present so the tests can show that the call which made a send
 * never trusts it, rather than hoping no caller ever writes it.
 */
const IMMEDIATE_BARRIER: MemoSendSettlementBarrier = () => Promise.resolve();

/** The caller's bounded wait ran out without the session going quiet. */
const EXPIRED_BARRIER: MemoSendSettlementBarrier = () =>
  Promise.reject(new Error("the bounded wait for the provider session expired"));

/**
 * Records every member name read off the gateway. The proxy is the stronger of
 * the two absence assertions: an implementation that grew a claim, lease, or
 * marker operation would show it here even if it never imported a database.
 */
function recordingGateway(
  target: FakeTargetSession,
  observedMemberNames: string[],
): MemoTargetGateway {
  return new Proxy(target, {
    get(recordedTarget: FakeTargetSession, propertyName: string | symbol): unknown {
      if (typeof propertyName === "string") {
        observedMemberNames.push(propertyName);
      }
      const value: unknown = Reflect.get(recordedTarget, propertyName);
      return typeof value === "function"
        ? (value as (...callArguments: never[]) => unknown).bind(recordedTarget)
        : value;
    },
  }) as unknown as MemoTargetGateway;
}

function segmentsIn(turns: readonly CanonicalTranscriptTurn[]): CanonicalTranscriptSegment[] {
  return turns.flatMap((includedTurn) => [...includedTurn.segments]);
}

function toolCallIdsIn(turns: readonly CanonicalTranscriptTurn[]): string[] {
  return segmentsIn(turns)
    .filter((segment) => segment.kind === "tool_call")
    .map((segment) => (segment.kind === "tool_call" ? segment.toolCallId : ""))
    .sort();
}

function toolResultIdsIn(turns: readonly CanonicalTranscriptTurn[]): string[] {
  return segmentsIn(turns)
    .filter((segment) => segment.kind === "tool_result")
    .map((segment) => (segment.kind === "tool_result" ? segment.toolCallId : ""))
    .sort();
}

/**
 * Whether every turn of `candidate` appears in `whole` in the same relative
 * order. Positions are unique and ascending, so identity is by position.
 */
function isOrderPreservingSubsequence(
  candidate: readonly CanonicalTranscriptTurn[],
  whole: readonly CanonicalTranscriptTurn[],
): boolean {
  let wholeIndex = 0;
  for (const candidateTurn of candidate) {
    while (wholeIndex < whole.length && whole[wholeIndex]?.position !== candidateTurn.position) {
      wholeIndex += 1;
    }
    if (wholeIndex >= whole.length) {
      return false;
    }
    wholeIndex += 1;
  }
  return true;
}

/**
 * The turns no budget may evict, derived HERE from the exchange partition rather
 * than read off the module under test: the newest exchange, plus the newest
 * `toolExchangeCount` tool-bearing exchanges wherever they sit.
 */
function protectedTurnsOf(
  turns: readonly CanonicalTranscriptTurn[],
  toolExchangeCount: number,
): readonly CanonicalTranscriptTurn[] {
  const exchanges: readonly TranscriptExchange[] = partitionIntoExchanges(turns);
  if (exchanges.length === 0) {
    return [];
  }
  const protectedIndices: Set<number> = new Set<number>([exchanges.length - 1]);
  let claimed = 0;
  for (let index = exchanges.length - 1; index >= 0 && claimed < toolExchangeCount; index -= 1) {
    if (exchanges[index]?.carriesToolActivity === true) {
      protectedIndices.add(index);
      claimed += 1;
    }
  }
  return exchanges
    .filter((_exchange, index) => protectedIndices.has(index))
    .flatMap((exchange) => [...exchange.turns]);
}

// --------------------------------------------------------------------------
// Generated transcripts — the pairing property's corpus
// --------------------------------------------------------------------------

function createSeededRandom(seed: number): () => number {
  let state: number = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed: number = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface GeneratedTranscript {
  readonly projection: CanonicalTranscriptProjection;
  /** Pairs whose call and result landed in DIFFERENT turns. Vacuity guard (a). */
  readonly crossTurnPairCount: number;
}

const PADDING = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor";

/**
 * Generates a transcript whose tool pairs deliberately straddle turn boundaries,
 * with unpaired calls and orphaned results mixed in so the repair step is
 * exercised too. Deterministic in `seed`, so a failure is reproducible.
 */
function generateTranscript(seed: number): GeneratedTranscript {
  const random = createSeededRandom(seed);
  const turns: CanonicalTranscriptTurn[] = [];
  let position = 0;
  let toolCallOrdinal = 0;
  let crossTurnPairCount = 0;

  const pushTurn = (
    role: "participant" | "assistant",
    segments: readonly CanonicalTranscriptSegment[],
  ): void => {
    position += 1;
    turns.push(turn(position, role, segments));
  };

  const exchangeCount: number = 4 + Math.floor(random() * 6);
  for (let exchangeIndex = 0; exchangeIndex < exchangeCount; exchangeIndex += 1) {
    pushTurn("participant", [
      { kind: "text", text: `participant utterance ${exchangeIndex.toString()} ${PADDING}` },
    ]);

    const callSegments: CanonicalTranscriptSegment[] = [];
    const callIds: string[] = [];
    // Deliberately reaches ZERO: a corpus in which every exchange used a tool
    // never exercises the protected tail's unsatisfiable-anchor arms.
    const callCount: number = Math.floor(random() * 3);
    for (let callIndex = 0; callIndex < callCount; callIndex += 1) {
      toolCallOrdinal += 1;
      const toolCallId = `call-${toolCallOrdinal.toString()}`;
      callIds.push(toolCallId);
      callSegments.push({
        kind: "tool_call",
        toolCallId,
        toolName: "inspect",
        argumentsJson: `{"seed":${seed.toString()},"ordinal":${toolCallOrdinal.toString()}}`,
      });
    }

    if (random() < 0.35) {
      // A reasoning block the strip must remove, which orphans nothing but does
      // exercise the transform this floor reuses.
      callSegments.unshift({
        kind: "reasoning",
        blockId: `block-${exchangeIndex.toString()}`,
        reasoningKind: "thinking",
        disclosure: random() < 0.5 ? "private" : "summary",
        text: `deliberation ${exchangeIndex.toString()} ${PADDING}`,
      });
    }

    if (callIds.length === 0) {
      pushTurn("assistant", [
        ...callSegments,
        { kind: "text", text: `assistant reply ${exchangeIndex.toString()} ${PADDING}` },
      ]);
      continue;
    }

    const leaveUnpaired: boolean = random() < 0.15;
    const resultsInLaterTurn: boolean = random() < 0.55;

    if (leaveUnpaired) {
      // Repair synthesizes the result IN THE CALL'S OWN TURN, so this pair never
      // straddles — deliberately, since the whole-exchange rule must hold for the
      // repaired pair too.
      pushTurn("assistant", callSegments);
      continue;
    }

    const resultSegments: CanonicalTranscriptSegment[] = callIds.map((toolCallId) => ({
      kind: "tool_result",
      toolCallId,
      outcome: "succeeded",
      provenance: "provider",
      text: `result for ${toolCallId} ${PADDING}`,
    }));

    if (resultsInLaterTurn) {
      pushTurn("assistant", callSegments);
      if (random() < 0.5) {
        // A participant turn BETWEEN the call and its result — the case a
        // per-turn partition splits and the straddle rule does not.
        pushTurn("participant", [
          { kind: "text", text: `interjection ${exchangeIndex.toString()} ${PADDING}` },
        ]);
      }
      pushTurn("assistant", resultSegments);
      crossTurnPairCount += callIds.length;
    } else {
      pushTurn("assistant", [...callSegments, ...resultSegments]);
    }

    if (random() < 0.12) {
      // An orphaned result the repair removes.
      pushTurn("assistant", [
        {
          kind: "tool_result",
          toolCallId: `orphan-${exchangeIndex.toString()}`,
          outcome: "failed",
          provenance: "provider",
          text: `orphaned result ${PADDING}`,
        },
      ]);
    }
  }

  return { projection: projectionOf(turns), crossTurnPairCount };
}

// --------------------------------------------------------------------------
// 1 — the pairing property, over generated transcripts
// --------------------------------------------------------------------------

describe("memo budget — whole-exchange eviction with a protected tail", () => {
  it("never emits a call without its result nor a result without its call, under any budget", () => {
    const memoProjection = new MemoProjection();
    let totalCrossTurnPairs = 0;
    let rendersThatEvicted = 0;
    let renderCount = 0;
    let transcriptsWithFewerToolExchangesThanProtected = 0;

    for (let seed = 1; seed <= 60; seed += 1) {
      const generated: GeneratedTranscript = generateTranscript(seed);
      totalCrossTurnPairs += generated.crossTurnPairCount;
      const generatedExchanges: readonly TranscriptExchange[] = partitionIntoExchanges(
        generated.projection.turns,
      );
      const generatedToolExchangeCount: number = generatedExchanges.filter(
        (exchange) => exchange.carriesToolActivity,
      ).length;
      if (generatedToolExchangeCount < DEFAULT_PROTECTED_TAIL_TOOL_EXCHANGE_COUNT) {
        transcriptsWithFewerToolExchangesThanProtected += 1;
      }

      const unbounded: MemoRendering = memoProjection.render(
        requestFor(generated.projection, ROOMY_BUDGET),
      );
      expect(unbounded.evictedExchangeCount).toBe(0);

      // Spans both regimes on purpose: the tight windows force eviction, the
      // wide one does not, so guard (b) below distinguishes them rather than
      // reporting that every render happened to evict.
      for (const contextWindowTokens of [120, 240, 480, 960, 1920, 100_000]) {
        const rendering: MemoRendering = memoProjection.render(
          requestFor(generated.projection, defaultMemoBudgetPolicy(contextWindowTokens)),
        );
        renderCount += 1;
        if (rendering.evictedExchangeCount > 0) {
          rendersThatEvicted += 1;
        }

        // The property itself.
        expect(toolCallIdsIn(rendering.includedTurns)).toEqual(
          toolResultIdsIn(rendering.includedTurns),
        );

        // An order-preserving SUBSEQUENCE of the unbounded render — never a
        // reordering, and never a turn the transforms did not produce. It is
        // deliberately not a contiguous suffix: protection is per-exchange, so an
        // older tool exchange may be retained past an evicted newer one.
        expect(isOrderPreservingSubsequence(rendering.includedTurns, unbounded.includedTurns)).toBe(
          true,
        );

        // Every protected exchange survives, whatever the budget: the newest
        // exchange, and the newest tool-bearing ones WHEREVER they sit.
        expect(rendering.includedTurns.length).toBeGreaterThan(0);
        expect(rendering.includedTurns.at(-1)).toEqual(unbounded.includedTurns.at(-1));
        const includedPositions: ReadonlySet<number> = new Set<number>(
          rendering.includedTurns.map((includedTurn) => includedTurn.position),
        );
        for (const protectedTurn of protectedTurnsOf(
          unbounded.includedTurns,
          DEFAULT_PROTECTED_TAIL_TOOL_EXCHANGE_COUNT,
        )) {
          expect(includedPositions.has(protectedTurn.position)).toBe(true);
        }
      }
    }

    // Vacuity guard (a): the corpus really does straddle turn boundaries.
    expect(totalCrossTurnPairs).toBeGreaterThan(0);
    // Vacuity guard (b): eviction really did fire.
    expect(rendersThatEvicted).toBeGreaterThan(0);
    expect(rendersThatEvicted).toBeLessThan(renderCount);
    // Vacuity guard (c): the corpus contains transcripts carrying FEWER
    // tool-bearing exchanges than the protected tail wants — the input class on
    // which the tail is only partly satisfiable, and which a corpus where every
    // exchange used a tool silently never reaches.
    expect(transcriptsWithFewerToolExchangesThanProtected).toBeGreaterThan(0);
  });

  it("retains the protected tail whole under an unreachable budget, splitting no exchange", () => {
    const memoProjection = new MemoProjection();
    const projection: CanonicalTranscriptProjection = generateTranscript(7).projection;

    const rendering: MemoRendering = memoProjection.render(
      requestFor(projection, { ...defaultMemoBudgetPolicy(8), budgetFraction: 0 }),
    );

    expect(rendering.budgetTokens).toBe(0);
    expect(rendering.exceedsBudget).toBe(true);
    expect(rendering.includedTurns.length).toBeGreaterThan(0);
    expect(toolCallIdsIn(rendering.includedTurns)).toEqual(
      toolResultIdsIn(rendering.includedTurns),
    );
    // Older exchanges WERE evicted here, so the truncation is real.
    expect(rendering.evictedExchangeCount).toBeGreaterThan(0);
    expect(rendering.declaredLosses).toContain("context_truncated");
  });

  it("declares no truncation when a single over-budget exchange arrived whole", () => {
    // The one place the module's honesty rule is observable: over budget is not
    // the same as truncated. Nothing was evicted, so nothing was dropped, and
    // claiming truncation would report a loss against a conversation that
    // arrived intact.
    const memoProjection = new MemoProjection();

    const rendering: MemoRendering = memoProjection.render(
      requestFor(
        projectionOf([turn(1, "assistant", [{ kind: "text", text: PADDING.repeat(20) }])]),
        {
          ...defaultMemoBudgetPolicy(8),
          budgetFraction: 0,
        },
      ),
    );

    expect(rendering.exceedsBudget).toBe(true);
    expect(rendering.evictedExchangeCount).toBe(0);
    expect(rendering.includedExchangeCount).toBe(1);
    expect(rendering.declaredLosses).not.toContain("context_truncated");
    expect(rendering.declaredLosses).toContain("conversation_history_summarized");
  });

  it("still evicts a conversation that used no tool at all", () => {
    // The protected tail is anchored on tool exchanges, so a transcript with
    // none must not protect itself entirely — that would make the budget
    // unenforceable on exactly the plain back-and-forth conversations where it
    // matters most.
    const memoProjection = new MemoProjection();
    const turns: CanonicalTranscriptTurn[] = [];
    for (let index = 0; index < 12; index += 1) {
      turns.push(
        turn(index + 1, index % 2 === 0 ? "participant" : "assistant", [
          { kind: "text", text: `plain exchange ${index.toString()} ${PADDING}` },
        ]),
      );
    }
    const projection: CanonicalTranscriptProjection = projectionOf(turns);

    const unbounded: MemoRendering = memoProjection.render(requestFor(projection, ROOMY_BUDGET));
    expect(unbounded.evictedExchangeCount).toBe(0);
    expect(unbounded.includedExchangeCount).toBe(12);

    const bounded: MemoRendering = memoProjection.render(
      requestFor(projection, defaultMemoBudgetPolicy(600)),
    );
    expect(bounded.evictedExchangeCount).toBeGreaterThan(0);
    expect(bounded.includedExchangeCount).toBeLessThan(12);
    // The newest exchange survives whatever the budget.
    expect(bounded.includedTurns.at(-1)).toEqual(unbounded.includedTurns.at(-1));
    expect(bounded.declaredLosses).toContain("context_truncated");

    const starved: MemoRendering = memoProjection.render(
      requestFor(projection, { ...defaultMemoBudgetPolicy(8), budgetFraction: 0 }),
    );
    expect(starved.includedExchangeCount).toBe(1);
    expect(starved.includedTurns.at(-1)).toEqual(unbounded.includedTurns.at(-1));
  });

  it("protects the newest tool exchange far from the end, and still evicts around it", () => {
    // The exchange below is the conversation's ONLY tool exchange, so it is also
    // its newest one and qualifies for the protected tail on the plain reading of
    // the rule. Protecting it must not drag everything after it in with it: it is
    // protected as ONE whole exchange, eviction steps over it, and the budget goes
    // on binding on the long plain run that follows.
    const memoProjection = new MemoProjection();
    const turns: CanonicalTranscriptTurn[] = [
      turn(1, "participant", [{ kind: "text", text: `opening ${PADDING}` }]),
      turn(2, "assistant", [
        {
          kind: "tool_call",
          toolCallId: "call-ancient",
          toolName: "inspect",
          argumentsJson: "{}",
        },
        {
          kind: "tool_result",
          toolCallId: "call-ancient",
          outcome: "succeeded",
          provenance: "provider",
          text: `ancient result ${PADDING}`,
        },
      ]),
    ];
    for (let index = 0; index < 10; index += 1) {
      turns.push(
        turn(index + 3, index % 2 === 0 ? "participant" : "assistant", [
          { kind: "text", text: `plain exchange ${index.toString()} ${PADDING}` },
        ]),
      );
    }
    const projection: CanonicalTranscriptProjection = projectionOf(turns);

    const unbounded: MemoRendering = memoProjection.render(requestFor(projection, ROOMY_BUDGET));
    expect(unbounded.evictedExchangeCount).toBe(0);
    expect(toolCallIdsIn(unbounded.includedTurns)).toEqual(["call-ancient"]);

    const bounded: MemoRendering = memoProjection.render(
      requestFor(projection, defaultMemoBudgetPolicy(600)),
    );
    // The budget still binds — eviction fired around the protected exchange.
    expect(bounded.evictedExchangeCount).toBeGreaterThan(0);
    expect(bounded.declaredLosses).toContain("context_truncated");
    // The ancient exchange is protected WHERE IT SITS, both halves together.
    expect(toolCallIdsIn(bounded.includedTurns)).toEqual(["call-ancient"]);
    expect(toolResultIdsIn(bounded.includedTurns)).toEqual(["call-ancient"]);
    expect(bounded.includedTurns.at(-1)).toEqual(unbounded.includedTurns.at(-1));

    // The included set is therefore NOT a contiguous suffix: it holds a gap
    // between the protected exchange and the retained tail. That gap is the
    // point — an anchored protected region could not produce it without also
    // protecting everything the gap contains.
    const includedPositions: readonly number[] = bounded.includedTurns.map(
      (includedTurn) => includedTurn.position,
    );
    expect(includedPositions).toContain(2);
    expect(includedPositions.at(-1)).toBe(12);
    const contiguous: boolean = includedPositions.every(
      (position, index) => index === 0 || position === (includedPositions[index - 1] ?? 0) + 1,
    );
    expect(contiguous).toBe(false);
    // And the notice does not claim the retained exchanges are the most recent.
    expect(bounded.text).toContain("may not be consecutive");
  });

  it("keeps a participant turn that sits between a call and its result inside the exchange", () => {
    const exchanges = partitionIntoExchanges([
      turn(1, "assistant", [
        { kind: "tool_call", toolCallId: "call-1", toolName: "inspect", argumentsJson: "{}" },
      ]),
      turn(2, "participant", [{ kind: "text", text: "hold on" }]),
      turn(3, "assistant", [
        {
          kind: "tool_result",
          toolCallId: "call-1",
          outcome: "succeeded",
          provenance: "provider",
          text: "done",
        },
      ]),
      turn(4, "participant", [{ kind: "text", text: "carry on" }]),
    ]);

    expect(exchanges.map((exchange) => exchange.turns.length)).toEqual([3, 1]);
    expect(exchanges[0]?.carriesToolActivity).toBe(true);
    expect(exchanges[1]?.carriesToolActivity).toBe(false);
  });

  it("never emits a memo larger than the ceiling it reports fitting under", () => {
    // Assembly joins the preamble and every admitted exchange with a newline, so
    // pricing each exchange ALONE and summing under-counts by one separator per
    // admission — and the estimator is injected, so nothing entitles the caller
    // to assume the parts sum to the whole in the first place. Near the ceiling
    // that gap admits a set which assembles to more than the budget while the
    // render still reports itself as fitting. Sweeping every integer ceiling
    // across the transcript's range is what lands on it; one fixed budget would
    // miss it by construction.
    const memoProjection = new MemoProjection();
    const turns: CanonicalTranscriptTurn[] = [];
    for (let index = 0; index < 12; index += 1) {
      // Each rendered turn is exactly 72 characters — a whole multiple of the
      // default estimator's character rate, so per-exchange rounding contributes
      // no slack of its own and the separators are what the sweep measures.
      turns.push(
        turn(index + 1, "assistant", [
          { kind: "text", text: `exchange ${index.toString().padStart(2, "0")} `.padEnd(61, "-") },
        ]),
      );
    }
    const projection: CanonicalTranscriptProjection = projectionOf(turns);

    const unbounded: MemoRendering = memoProjection.render(requestFor(projection, ROOMY_BUDGET));
    expect(unbounded.evictedExchangeCount).toBe(0);
    expect(unbounded.includedExchangeCount).toBe(12);

    let ceilingsTheProtectedFloorOverran = 0;
    let ceilingsThatFitAfterEviction = 0;

    for (
      let ceilingTokens = 1;
      ceilingTokens <= unbounded.estimatedTokens + 4;
      ceilingTokens += 1
    ) {
      const rendering: MemoRendering = memoProjection.render(
        requestFor(projection, {
          targetContextWindowTokens: ceilingTokens,
          budgetFraction: 1,
          protectedTailToolExchangeCount: DEFAULT_PROTECTED_TAIL_TOOL_EXCHANGE_COUNT,
        }),
      );

      expect(rendering.budgetTokens).toBe(ceilingTokens);
      if (rendering.exceedsBudget) {
        ceilingsTheProtectedFloorOverran += 1;
        continue;
      }
      // The property: a render that reports itself within its ceiling IS within
      // it, measured over the prose the settlement actually carries.
      expect(rendering.estimatedTokens).toBeLessThanOrEqual(ceilingTokens);
      if (rendering.evictedExchangeCount > 0) {
        ceilingsThatFitAfterEviction += 1;
      }
    }

    // Vacuity guards: the sweep spans both regimes — ceilings the protected
    // floor alone overruns, and ceilings where eviction brought the memo back
    // under one, which is the regime the separators are paid in.
    expect(ceilingsTheProtectedFloorOverran).toBeGreaterThan(0);
    expect(ceilingsThatFitAfterEviction).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------
// The two portability transforms this floor reuses
// --------------------------------------------------------------------------

describe("memo body — portability transforms", () => {
  it("drops private reasoning and declares it, while a visible summary survives as prose", () => {
    const memoProjection = new MemoProjection();

    const withPrivateReasoning: MemoRendering = memoProjection.render(
      requestFor(
        projectionOf([
          turn(1, "assistant", [
            {
              kind: "reasoning",
              blockId: "block-1",
              reasoningKind: "thinking",
              disclosure: "private",
              text: "SECRET-DELIBERATION",
            },
            { kind: "text", text: "the visible answer" },
          ]),
        ]),
      ),
    );
    expect(withPrivateReasoning.text).not.toContain("SECRET-DELIBERATION");
    expect(withPrivateReasoning.text).toContain("the visible answer");
    expect(withPrivateReasoning.declaredLosses).toContain("provider_private_reasoning");

    const withSummary: MemoRendering = memoProjection.render(
      requestFor(
        projectionOf([
          turn(1, "assistant", [
            {
              kind: "reasoning",
              blockId: "block-1",
              reasoningKind: "thinking",
              disclosure: "summary",
              text: "VISIBLE-SUMMARY",
            },
          ]),
        ]),
      ),
    );
    expect(withSummary.text).toContain("VISIBLE-SUMMARY");
    expect(withSummary.declaredLosses).not.toContain("provider_private_reasoning");
  });

  it("always declares that the conversation was summarized", () => {
    const memoProjection = new MemoProjection();
    const rendering: MemoRendering = memoProjection.render(
      requestFor(projectionOf([turn(1, "participant", [{ kind: "text", text: "hello" }])])),
    );
    expect(rendering.declaredLosses).toContain("conversation_history_summarized");
  });

  it("declares an unreadable body and names it in the prose the model reads", () => {
    const memoProjection = new MemoProjection();
    const rendering: MemoRendering = memoProjection.render(
      requestFor(
        projectionOf([
          turn(1, "participant", [{ kind: "text", text: "what did that return?" }]),
          turn(2, "assistant", [{ kind: "text", text: "", contentUnavailable: true }]),
          turn(3, "assistant", [
            {
              kind: "tool_call",
              toolCallId: "call-1",
              toolName: "inspect",
              argumentsJson: "",
              contentUnavailable: true,
            },
            {
              kind: "tool_result",
              toolCallId: "call-1",
              outcome: "succeeded",
              provenance: "provider",
              text: "",
              contentUnavailable: true,
            },
          ]),
        ]),
      ),
    );

    expect(rendering.declaredLosses).toContain("turn_content_unavailable");
    // The settlement's declaration does not reach the memo's own text, so the
    // gap is named there too: an empty body renders to nothing, and a turn of
    // nothing reads to the model as a turn that never happened.
    expect(rendering.text).toContain("could not be recovered");
    // The turn is still present, with its speaker.
    expect(rendering.includedTurns).toHaveLength(3);
    expect(rendering.text).toContain("[tool call inspect (call-1)]");
  });

  it("declares nothing of the kind when every body resolved", () => {
    const memoProjection = new MemoProjection();
    const rendering: MemoRendering = memoProjection.render(
      requestFor(
        projectionOf([
          turn(1, "participant", [{ kind: "text", text: "what did that return?" }]),
          turn(2, "assistant", [{ kind: "text", text: "an empty list" }]),
        ]),
      ),
    );
    expect(rendering.declaredLosses).not.toContain("turn_content_unavailable");
    expect(rendering.text).not.toContain("could not be recovered");
  });
});

// --------------------------------------------------------------------------
// 2 + 3 — reconcile-before-every-send
// --------------------------------------------------------------------------

describe("memo delivery — once-only under a lost acknowledgment", () => {
  it("delivers exactly once when the send lands at the target and the acknowledgment is lost", async () => {
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-then-fail";
    const coordinator = new MemoDeliveryCoordinator(target);
    const request: MemoDeliveryRequest = requestFor(
      projectionOf([turn(1, "participant", [{ kind: "text", text: "hello" }])]),
    );

    const first: MemoDeliverySettlement = await coordinator.deliver(request);
    // Resolved by reading the target, not by trusting the rejection.
    expect(first.disposition).toBe("delivered");

    // The caller retries, as a caller with no acknowledgment must.
    const second: MemoDeliverySettlement = await coordinator.deliver(request);
    expect(second.disposition).toBe("already-delivered");
    expect(second.memoIdentityKey).toBe(first.memoIdentityKey);

    // The load-bearing assertion is what the TARGET holds, not the disposition.
    expect(target.turns).toHaveLength(1);
    expect(target.sendAttempts).toBe(1);
  });

  it("negative control — blinding the readback across two coordinators produces the duplicate", async () => {
    // Blinded and split across two coordinators, because reconciliation only
    // stands alone there. One coordinator would not duplicate even blinded: it
    // remembers that its own send went unacknowledged and will not send again on
    // an absence it cannot trust. Two of them, two processes, or a restart
    // mid-flight have nothing but the readback, which is what this blinds.
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-then-fail";
    target.reportNoTurns = true;
    const request: MemoDeliveryRequest = requestFor(
      projectionOf([turn(1, "participant", [{ kind: "text", text: "hello" }])]),
    );

    await new MemoDeliveryCoordinator(target).deliver(request);
    await new MemoDeliveryCoordinator(target).deliver(request);

    expect(target.turns).toHaveLength(2);
    expect(target.sendAttempts).toBe(2);
  });
});

// --------------------------------------------------------------------------
// 2b — an ambiguous send is held unconfirmed, never settled off one snapshot
// --------------------------------------------------------------------------

/**
 * The hazard these pin, in product terms: a send whose acknowledgment is lost may
 * still be landing at the provider. A readback taken the same instant finds no
 * marker — not because the memo will not arrive, but because it has not arrived
 * yet. Treating that one snapshot as proof of refusal is what let a retry send a
 * second memo into a conversation that was already receiving the first, leaving
 * the participant reading the same summary twice.
 */
describe("memo delivery — an ambiguous send is held unconfirmed", () => {
  const AMBIGUOUS_REQUEST: MemoDeliveryRequest = requestFor(
    projectionOf([turn(1, "participant", [{ kind: "text", text: "hello" }])]),
  );

  it("does not let a retry race a slow-applying send into a second memo", async () => {
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-late-then-fail";
    const coordinator = new MemoDeliveryCoordinator(target);

    const first: MemoDeliverySettlement = await coordinator.deliver(AMBIGUOUS_REQUEST);

    // The acknowledgment timed out and the provider has not finished applying,
    // so the readback that followed it found nothing. That is not a refusal.
    expect(first.disposition).toBe("unconfirmed");
    expect(first.withheldReason).toBeUndefined();
    expect(target.sendAttempts).toBe(1);
    expect(target.turns).toHaveLength(0);

    // The caller retries, as a caller with no acknowledgment must. Its own read
    // still finds nothing, for exactly the same reason.
    const retry: MemoDeliverySettlement = await coordinator.deliver(AMBIGUOUS_REQUEST);

    expect(retry.disposition).toBe("unconfirmed");
    expect(target.sendAttempts).toBe(1);

    // The provider finishes applying the FIRST send.
    target.applyPendingSends();
    expect(target.turns).toHaveLength(1);

    const afterLanding: MemoDeliverySettlement = await coordinator.deliver(AMBIGUOUS_REQUEST);

    // The load-bearing assertion is what the TARGET holds: exactly one memo,
    // from exactly one send, across three delivery calls.
    expect(afterLanding.disposition).toBe("already-delivered");
    expect(target.sendAttempts).toBe(1);
    expect(target.turns).toHaveLength(1);
  });

  it("does not double-send when a barrier is supplied and the first send lands late", async () => {
    // A barrier cannot answer for the send its own call just made — nothing has
    // happened yet that it could have waited for. The call that made the
    // ambiguous send therefore never consults it, so a caller supplying the most
    // obvious barrier there is cannot talk that call into a refusal.
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-late-then-fail";
    const coordinator = new MemoDeliveryCoordinator(target);
    const requestWithBarrier: MemoDeliveryRequest = {
      ...AMBIGUOUS_REQUEST,
      sendSettlementBarrier: IMMEDIATE_BARRIER,
    };

    const first: MemoDeliverySettlement = await coordinator.deliver(requestWithBarrier);
    expect(first.disposition).toBe("unconfirmed");
    expect(target.sendAttempts).toBe(1);

    await coordinator.deliver(requestWithBarrier);
    target.applyPendingSends();

    expect(target.sendAttempts).toBe(1);
    expect(target.turns).toHaveLength(1);
  });

  it("converges on the late-landing memo when the barrier really waits for it", async () => {
    // The honest barrier's whole job: waiting for the session to go quiet lets
    // the first send finish, so the retry's read finds the memo and settles as
    // the delivery it already is.
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-late-then-fail";
    const coordinator = new MemoDeliveryCoordinator(target);
    const requestWithBarrier: MemoDeliveryRequest = {
      ...AMBIGUOUS_REQUEST,
      sendSettlementBarrier: settlementBarrierFor(target),
    };

    const first: MemoDeliverySettlement = await coordinator.deliver(requestWithBarrier);
    const retry: MemoDeliverySettlement = await coordinator.deliver(requestWithBarrier);
    const third: MemoDeliverySettlement = await coordinator.deliver(requestWithBarrier);

    expect(first.disposition).toBe("unconfirmed");
    expect(retry.disposition).toBe("already-delivered");
    expect(third.disposition).toBe("already-delivered");
    expect(target.sendAttempts).toBe(1);
    expect(target.turns).toHaveLength(1);
  });

  it("sends again once the caller's barrier establishes the earlier send never landed", async () => {
    // Holding the memo back forever would be its own failure — the participant
    // would silently get no summary. Resolving the old ambiguity and attempting
    // a new send are two calls, not one: the barrier's word closes the first
    // send, and the ordinary reconcile that follows opens the second.
    const target = new FakeTargetSession();
    target.sendBehavior = "refuse";
    const coordinator = new MemoDeliveryCoordinator(target);
    const requestWithBarrier: MemoDeliveryRequest = {
      ...AMBIGUOUS_REQUEST,
      sendSettlementBarrier: settlementBarrierFor(target),
    };

    const first: MemoDeliverySettlement = await coordinator.deliver(requestWithBarrier);
    expect(first.disposition).toBe("unconfirmed");
    expect(target.sendAttempts).toBe(1);

    const resolved: MemoDeliverySettlement = await coordinator.deliver(requestWithBarrier);
    expect(resolved.disposition).toBe("withheld");
    expect(resolved.withheldReason).toBe("send-refused");
    expect(target.sendAttempts).toBe(1);

    target.sendBehavior = "accept";
    const resent: MemoDeliverySettlement = await coordinator.deliver(requestWithBarrier);

    expect(resent.disposition).toBe("delivered");
    expect(target.sendAttempts).toBe(2);
    expect(target.turns).toHaveLength(1);
  });

  it("sends nothing when the caller's barrier expires instead of settling", async () => {
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-late-then-fail";
    const coordinator = new MemoDeliveryCoordinator(target);

    await coordinator.deliver(AMBIGUOUS_REQUEST);
    const retry: MemoDeliverySettlement = await coordinator.deliver({
      ...AMBIGUOUS_REQUEST,
      sendSettlementBarrier: EXPIRED_BARRIER,
    });

    // A bounded wait running out answers nothing, so it authorizes nothing.
    expect(retry.disposition).toBe("unconfirmed");
    expect(target.sendAttempts).toBe(1);
  });

  it("does not downgrade an outstanding send to a refusal when the target goes unreadable", async () => {
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-late-then-fail";
    const coordinator = new MemoDeliveryCoordinator(target);

    await coordinator.deliver(AMBIGUOUS_REQUEST);
    target.readOutcomes.push("fail");
    const retry: MemoDeliverySettlement = await coordinator.deliver(AMBIGUOUS_REQUEST);

    // Withheld asserts that nothing landed. Nobody established that here.
    expect(retry.disposition).toBe("unconfirmed");
    expect(retry.withheldReason).toBeUndefined();
    expect(target.sendAttempts).toBe(1);
  });

  it("does not duplicate even when the readback is blind, within one coordinator", async () => {
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-then-fail";
    target.reportNoTurns = true;
    const coordinator = new MemoDeliveryCoordinator(target);

    await coordinator.deliver(AMBIGUOUS_REQUEST);
    await coordinator.deliver(AMBIGUOUS_REQUEST);

    // The memo landed and the blinded read cannot see it, yet no second send is
    // attempted: an unacknowledged send is remembered, not re-derived from a
    // reading that may be wrong.
    expect(target.sendAttempts).toBe(1);
    expect(target.turns).toHaveLength(1);
  });

  it("negative control — the unconfirmed pair is scoped to one coordinator, like the flight", async () => {
    // The register claims nothing wider than the object holding it, and is not
    // durable. A second coordinator falls back to the pre-send reconcile, which
    // is the mechanism that survives a restart and the only one that ever did.
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-late-then-fail";

    await new MemoDeliveryCoordinator(target).deliver(AMBIGUOUS_REQUEST);
    await new MemoDeliveryCoordinator(target).deliver(AMBIGUOUS_REQUEST);

    expect(target.sendAttempts).toBe(2);
  });
});

describe("memo delivery — overlapping calls for one memo", () => {
  const OVERLAPPING_REQUEST: MemoDeliveryRequest = requestFor(
    projectionOf([turn(1, "participant", [{ kind: "text", text: "hello" }])]),
  );

  it("sends once when two calls for one memo overlap", async () => {
    // Both calls read the target before either send lands, so both legitimately
    // find no marker: reconciliation cannot separate them, and the send is the
    // one act here that cannot be taken back.
    const target = new FakeTargetSession();
    const coordinator = new MemoDeliveryCoordinator(target);

    const [first, second]: readonly MemoDeliverySettlement[] = await Promise.all([
      coordinator.deliver(OVERLAPPING_REQUEST),
      coordinator.deliver(OVERLAPPING_REQUEST),
    ]);

    // The load-bearing assertion is what the TARGET holds.
    expect(target.turns).toHaveLength(1);
    expect(target.sendAttempts).toBe(1);
    expect(first?.disposition).toBe("delivered");
    expect(second).toBe(first);
  });

  it("negative control — two coordinators over one target do not share a delivery", async () => {
    // The exclusion is scoped to one coordinator and claims nothing wider. Two
    // of them, two processes, or a restart mid-flight all fall back to the
    // pre-send reconcile, whose window this is.
    const target = new FakeTargetSession();

    await Promise.all([
      new MemoDeliveryCoordinator(target).deliver(OVERLAPPING_REQUEST),
      new MemoDeliveryCoordinator(target).deliver(OVERLAPPING_REQUEST),
    ]);

    expect(target.sendAttempts).toBe(2);
    expect(target.turns).toHaveLength(2);
  });

  it("reconciles afresh once the delivery it shared has settled", async () => {
    const target = new FakeTargetSession();
    const coordinator = new MemoDeliveryCoordinator(target);

    await Promise.all([
      coordinator.deliver(OVERLAPPING_REQUEST),
      coordinator.deliver(OVERLAPPING_REQUEST),
    ]);
    const readsBeforeRetry: number = target.readAttempts;

    const retry: MemoDeliverySettlement = await coordinator.deliver(OVERLAPPING_REQUEST);

    // A settled delivery is not a standing answer: the retry reads the target
    // again and finds the marker there, rather than being handed the settlement
    // the earlier pair produced.
    expect(target.readAttempts).toBeGreaterThan(readsBeforeRetry);
    expect(retry.disposition).toBe("already-delivered");
    expect(target.sendAttempts).toBe(1);
  });

  it("does not let a withheld delivery stand in for the next one", async () => {
    // The first settles WITHHELD on an unreadable target. If the flight it
    // occupied outlived it, the second caller would inherit that refusal and the
    // memo would never be sent at all.
    const target = new FakeTargetSession();
    target.readOutcomes.push("fail");
    const coordinator = new MemoDeliveryCoordinator(target);

    const withheld: MemoDeliverySettlement = await coordinator.deliver(OVERLAPPING_REQUEST);
    expect(withheld.disposition).toBe("withheld");
    expect(withheld.withheldReason).toBe("target-unreadable");
    expect(target.sendAttempts).toBe(0);

    const retry: MemoDeliverySettlement = await coordinator.deliver(OVERLAPPING_REQUEST);

    expect(retry.disposition).toBe("delivered");
    expect(target.sendAttempts).toBe(1);
    expect(target.turns).toHaveLength(1);
  });
});

describe("memo delivery — an unreadable target", () => {
  it("sends nothing when the target cannot be read before the send", async () => {
    const target = new FakeTargetSession();
    target.readOutcomes.push("fail");
    const coordinator = new MemoDeliveryCoordinator(target);

    const settlement: MemoDeliverySettlement = await coordinator.deliver(
      requestFor(projectionOf([turn(1, "participant", [{ kind: "text", text: "hello" }])])),
    );

    expect(settlement.disposition).toBe("withheld");
    expect(settlement.withheldReason).toBe("target-unreadable");
    expect(target.sendAttempts).toBe(0);
    expect(target.turns).toHaveLength(0);
  });

  it("sends nothing further when the target cannot be read after an ambiguous send", async () => {
    const target = new FakeTargetSession();
    target.readOutcomes.push("ok", "fail");
    target.sendBehavior = "apply-then-fail";
    const coordinator = new MemoDeliveryCoordinator(target);

    const settlement: MemoDeliverySettlement = await coordinator.deliver(
      requestFor(projectionOf([turn(1, "participant", [{ kind: "text", text: "hello" }])])),
    );

    // The ambiguity is reported, never resolved by sending again.
    expect(settlement.disposition).toBe("unconfirmed");
    expect(settlement.status).toBe("degraded");
    expect(target.sendAttempts).toBe(1);
  });

  it("settles withheld only on a later call, once the barrier orders the read behind the send", async () => {
    // Rewritten for the round-4 finding: a rejected send may still be applying,
    // so a readback that finds nothing is not proof the memo was refused. The
    // refusal arm now takes a SECOND delivery — one whose barrier is ordered
    // behind a send that completed before that call began. The call that made
    // the send cannot reach it at all, whatever the caller passes.
    const target = new FakeTargetSession();
    target.sendBehavior = "refuse";
    const coordinator = new MemoDeliveryCoordinator(target);
    const request: MemoDeliveryRequest = {
      ...requestFor(projectionOf([turn(1, "participant", [{ kind: "text", text: "hello" }])])),
      sendSettlementBarrier: settlementBarrierFor(target),
    };

    const attempted: MemoDeliverySettlement = await coordinator.deliver(request);
    expect(attempted.disposition).toBe("unconfirmed");

    const settlement: MemoDeliverySettlement = await coordinator.deliver(request);

    expect(settlement.disposition).toBe("withheld");
    expect(settlement.withheldReason).toBe("send-refused");
    expect(target.turns).toHaveLength(0);
  });

  it("reports the ambiguity, not a refusal, when no barrier orders the readback", async () => {
    const target = new FakeTargetSession();
    target.sendBehavior = "refuse";
    const coordinator = new MemoDeliveryCoordinator(target);

    const settlement: MemoDeliverySettlement = await coordinator.deliver(
      requestFor(projectionOf([turn(1, "participant", [{ kind: "text", text: "hello" }])])),
    );

    expect(settlement.disposition).toBe("unconfirmed");
    expect(settlement.withheldReason).toBeUndefined();
    expect(target.turns).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------
// 4 — key purity
// --------------------------------------------------------------------------

class RecordedEventLog implements TranscriptEventReader {
  readonly #events: StoredEvent[] = [];

  append(event: StoredEvent): void {
    this.#events.push(event);
  }

  readEvents(): ReadonlyArray<StoredEvent> {
    return [...this.#events];
  }
}

class RecordedContentSource implements TranscriptContentSource {
  readonly assistantTextBySequence: Map<number, string> = new Map<number, string>();
  readonly participantTextBySequence: Map<number, string> = new Map<number, string>();

  readAssistantText(reference: TranscriptContentReference): string | undefined {
    return this.assistantTextBySequence.get(reference.sequence);
  }

  readParticipantText(reference: TranscriptContentReference): string | undefined {
    return this.participantTextBySequence.get(reference.sequence);
  }

  readReasoningBlocks(): readonly TranscriptReasoningBlock[] {
    return [];
  }

  readToolCallArguments(): string | undefined {
    return undefined;
  }

  readToolResultBody(): TranscriptToolResultBody | undefined {
    return undefined;
  }
}

function storedEvent(
  sequence: number,
  type: string,
  payload: Record<string, unknown>,
): StoredEvent {
  return {
    id: `evt-${sequence.toString()}`,
    sessionId: SESSION_ID,
    sequence,
    occurredAt: "2026-08-29T00:00:00.000Z",
    monotonicNs: BigInt(sequence),
    category: "provider",
    type,
    actor: null,
    payload,
    correlationId: null,
    causationId: null,
    version: "1.0",
  };
}

interface FoldFixture {
  readonly log: RecordedEventLog;
  readonly contentSource: RecordedContentSource;
  readonly fold: CanonicalTranscriptFold;
}

function makeFoldFixture(): FoldFixture {
  const log = new RecordedEventLog();
  const contentSource = new RecordedContentSource();
  return {
    log,
    contentSource,
    fold: new CanonicalTranscriptFold({ eventReader: log, contentSource }),
  };
}

function seedConversation(fixture: FoldFixture): void {
  // No message member on the row: the participant's words reach the fold through
  // the content port, because the emitter routes them through the encrypted
  // envelope and the read path returns only the clear half.
  fixture.log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "participant" }));
  fixture.contentSource.participantTextBySequence.set(1, "run the tests");
  fixture.log.append(storedEvent(2, "assistant.message", { runId: RUN_ID }));
}

describe("memo identity key — derived, never stored", () => {
  it("two independently built folds over one log derive the same key", () => {
    const first = makeFoldFixture();
    seedConversation(first);
    const second = makeFoldFixture();
    seedConversation(second);

    const firstKey: string = deriveMemoIdentityKey(
      first.fold.build({ sessionId: SESSION_ID, runId: RUN_ID }),
      TARGET,
    );
    const secondKey: string = deriveMemoIdentityKey(
      second.fold.build({ sessionId: SESSION_ID, runId: RUN_ID }),
      TARGET,
    );

    expect(firstKey).toBe(secondKey);
    expect(firstKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it("survives a restart — a fold rebuilt from the same durable rows derives the same key", () => {
    const before = makeFoldFixture();
    seedConversation(before);
    const keyBeforeRestart: string = deriveMemoIdentityKey(
      before.fold.build({ sessionId: SESSION_ID, runId: RUN_ID }),
      TARGET,
    );

    // A restart: nothing in memory survives, the durable rows do — and so does
    // the content the port reads, which is durable for the same reason the rows
    // are. Carrying the log across without the content would model a restart
    // that lost half the conversation, not a restart.
    const after = makeFoldFixture();
    for (const event of before.log.readEvents()) {
      after.log.append(event);
    }
    for (const [sequence, text] of before.contentSource.participantTextBySequence) {
      after.contentSource.participantTextBySequence.set(sequence, text);
    }
    for (const [sequence, text] of before.contentSource.assistantTextBySequence) {
      after.contentSource.assistantTextBySequence.set(sequence, text);
    }
    const keyAfterRestart: string = deriveMemoIdentityKey(
      after.fold.build({ sessionId: SESSION_ID, runId: RUN_ID }),
      TARGET,
    );

    expect(keyAfterRestart).toBe(keyBeforeRestart);
  });

  it("does not move when an append in ANOTHER run moves the projection's built position", () => {
    const fixture = makeFoldFixture();
    seedConversation(fixture);

    const before: CanonicalTranscriptProjection = fixture.fold.build({
      sessionId: SESSION_ID,
      runId: RUN_ID,
    });
    fixture.log.append(
      storedEvent(3, "user.message", { runId: OTHER_RUN_ID, actor: "participant" }),
    );
    fixture.contentSource.participantTextBySequence.set(3, "unrelated");
    const after: CanonicalTranscriptProjection = fixture.fold.build({
      sessionId: SESSION_ID,
      runId: RUN_ID,
    });

    // The projection's own position moved, which is why it cannot key the memo.
    expect(after.builtAtPosition).toBeGreaterThan(before.builtAtPosition);
    expect(deriveMemoIdentityKey(after, TARGET)).toBe(deriveMemoIdentityKey(before, TARGET));
  });

  it("moves when an appended event changes the transcript's own content", () => {
    const fixture = makeFoldFixture();
    seedConversation(fixture);
    const before: string = deriveMemoIdentityKey(
      fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID }),
      TARGET,
    );

    fixture.log.append(storedEvent(3, "user.message", { runId: RUN_ID, actor: "participant" }));
    // Seeded, so the key moves because the CONTENT changed — an unseeded row
    // would move it too, on an unavailability marker rather than on new words.
    fixture.contentSource.participantTextBySequence.set(3, "and now deploy");
    const after: string = deriveMemoIdentityKey(
      fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID }),
      TARGET,
    );

    expect(after).not.toBe(before);
  });

  it("distinguishes targets, and is unaffected by the budget that shapes the body", () => {
    const projection: CanonicalTranscriptProjection = generateTranscript(3).projection;
    const memoProjection = new MemoProjection();

    expect(deriveMemoIdentityKey(projection, TARGET)).not.toBe(
      deriveMemoIdentityKey(projection, OTHER_TARGET),
    );

    const roomy: MemoRendering = memoProjection.render(requestFor(projection, ROOMY_BUDGET));
    const tight: MemoRendering = memoProjection.render(
      requestFor(projection, defaultMemoBudgetPolicy(160)),
    );
    expect(tight.evictedExchangeCount).toBeGreaterThan(0);
    expect(tight.memoIdentityKey).toBe(roomy.memoIdentityKey);
    expect(roomy.memoIdentityKey).toBe(deriveMemoIdentityKey(projection, TARGET));
  });

  it("serializes fields unambiguously — text carrying a delimiter does not collide", () => {
    const left: CanonicalTranscriptProjection = projectionOf([
      turn(1, "participant", [{ kind: "text", text: 'a"b' }]),
      turn(2, "participant", [{ kind: "text", text: "c" }]),
    ]);
    const right: CanonicalTranscriptProjection = projectionOf([
      turn(1, "participant", [{ kind: "text", text: "a" }]),
      turn(2, "participant", [{ kind: "text", text: 'b"c' }]),
    ]);

    expect(deriveMemoIdentityKey(left, TARGET)).not.toBe(deriveMemoIdentityKey(right, TARGET));
  });
});

// --------------------------------------------------------------------------
// 5 — no durable claim on any path
// --------------------------------------------------------------------------

const MODULE_SOURCE: string = readFileSync(
  fileURLToPath(new URL("../memo-projection.ts", import.meta.url)),
  "utf8",
);

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("memo delivery — nothing durable is written", () => {
  it("imports nothing that could persist — an exhaustive allow-list, not a denylist", () => {
    const importSpecifiers: Set<string> = new Set<string>();
    for (const match of MODULE_SOURCE.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)) {
      importSpecifiers.add(match[1] ?? "");
    }

    expect([...importSpecifiers].sort()).toEqual([
      "../drivers/outbound-frame.js",
      "./transform-pipeline.js",
      "@ai-sidekicks/contracts",
      "@noble/hashes/blake3.js",
      "@noble/hashes/utils.js",
    ]);
  });

  it("contains no persistence call, path, or statement in executable code", () => {
    const executableSource: string = withoutComments(MODULE_SOURCE);
    for (const forbidden of [
      "better-sqlite3",
      "node:fs",
      "node:sqlite",
      "migrations",
      "runtime_bindings",
      "INSERT",
      "UPDATE ",
      "DELETE FROM",
      "CREATE TABLE",
      "writeFile",
      "localStorage",
      "prepare(",
    ]) {
      expect(executableSource).not.toContain(forbidden);
    }
  });

  it("touches only the read and the send on the target, across all four delivery paths", async () => {
    const observedMemberNames: string[] = [];
    const request: MemoDeliveryRequest = requestFor(
      projectionOf([turn(1, "participant", [{ kind: "text", text: "hello" }])]),
    );

    // delivered
    const deliveredTarget = new FakeTargetSession();
    await new MemoDeliveryCoordinator(
      recordingGateway(deliveredTarget, observedMemberNames),
    ).deliver(request);
    // already-delivered
    const repeatSettlement: MemoDeliverySettlement = await new MemoDeliveryCoordinator(
      recordingGateway(deliveredTarget, observedMemberNames),
    ).deliver(request);
    expect(repeatSettlement.disposition).toBe("already-delivered");

    // withheld
    const withheldTarget = new FakeTargetSession();
    withheldTarget.readOutcomes.push("fail");
    await new MemoDeliveryCoordinator(
      recordingGateway(withheldTarget, observedMemberNames),
    ).deliver(request);

    // unconfirmed
    const unconfirmedTarget = new FakeTargetSession();
    unconfirmedTarget.readOutcomes.push("ok", "fail");
    unconfirmedTarget.sendBehavior = "apply-then-fail";
    await new MemoDeliveryCoordinator(
      recordingGateway(unconfirmedTarget, observedMemberNames),
    ).deliver(request);

    expect([...new Set(observedMemberNames)].sort()).toEqual(["readRecentTurns", "sendMemoTurn"]);
  });
});

// --------------------------------------------------------------------------
// 6 — the key rides the outbound frame, visibly
// --------------------------------------------------------------------------

describe("memo frame — the key is carried as visible characters", () => {
  it("renders the derived key into the frame the target receives", async () => {
    const sentFrames: MemoOutboundFrame[] = [];
    const gateway: MemoTargetGateway = {
      readRecentTurns: async (): Promise<readonly string[]> => [],
      sendMemoTurn: async (frame: MemoOutboundFrame): Promise<void> => {
        sentFrames.push(frame);
      },
    };
    const projection: CanonicalTranscriptProjection = generateTranscript(11).projection;

    const settlement: MemoDeliverySettlement = await new MemoDeliveryCoordinator(gateway).deliver(
      requestFor(projection),
    );

    const frame: MemoOutboundFrame | undefined = sentFrames[0];
    expect(frame).toBeDefined();
    // Asserted on the FRAME, not on the projection or the settlement.
    expect(frame?.frame.wireText).toContain(renderMemoContinuityMarker(settlement.memoIdentityKey));
    expect(frame?.memoIdentityKey).toBe(settlement.memoIdentityKey);

    const markerIndex: number = (frame?.frame.wireText ?? "").indexOf(
      renderMemoContinuityMarker(settlement.memoIdentityKey),
    );
    expect(markerIndex).toBeGreaterThanOrEqual(0);
  });

  it("reaches the gateway only through a composed frame, minted as system narration", async () => {
    const sentFrames: MemoOutboundFrame[] = [];
    const gateway: MemoTargetGateway = {
      readRecentTurns: async (): Promise<readonly string[]> => [],
      sendMemoTurn: async (frame: MemoOutboundFrame): Promise<void> => {
        sentFrames.push(frame);
      },
    };
    const projection: CanonicalTranscriptProjection = generateTranscript(13).projection;

    const settlement: MemoDeliverySettlement = await new MemoDeliveryCoordinator(gateway).deliver(
      requestFor(projection),
    );

    const frame: MemoOutboundFrame | undefined = sentFrames[0];
    // A memo is the daemon narrating a prior conversation — neither the
    // participant's own text nor a driver command.
    expect(frame?.frame.origin).toBe("system_narration");
    expect(frame?.frame.tripwireExempt).toBe(false);
    // Only the writer mints one, so the memo cannot reach the provider around
    // the neutralization boundary.
    expect(frame?.frame.mintedByWriter).toBe(true);
    // The boundary is TRANSPORT-only: the authored prose is the rendering,
    // byte for byte, whatever the wire bytes turn out to be.
    expect(frame?.frame.authoredText).toBe(settlement.rendering.text);
    // And the correlation value the tripwire joins a turn back on is present.
    expect((frame?.frame.correlationId ?? "").length).toBeGreaterThan(0);
  });

  it("uses no invisible or zero-width character anywhere in the frame", async () => {
    const sentFrames: MemoOutboundFrame[] = [];
    const gateway: MemoTargetGateway = {
      readRecentTurns: async (): Promise<readonly string[]> => [],
      sendMemoTurn: async (frame: MemoOutboundFrame): Promise<void> => {
        sentFrames.push(frame);
      },
    };

    await new MemoDeliveryCoordinator(gateway).deliver(
      requestFor(generateTranscript(12).projection),
    );

    const frameText: string = sentFrames[0]?.frame.wireText ?? "";
    expect(frameText.length).toBeGreaterThan(0);
    // Zero-width, word-joiner, BOM, variation selectors, and Unicode tag
    // characters — the sentinel classes the spec prohibits outright. Scanned by
    // code point rather than by a character class, because a class holding
    // combining characters is itself misleading to read.
    const invisibleCodePoints: number[] = [...frameText]
      .map((character) => character.codePointAt(0) ?? 0)
      .filter(
        (codePoint) =>
          (codePoint >= 0x200b && codePoint <= 0x200f) ||
          (codePoint >= 0x2060 && codePoint <= 0x2064) ||
          codePoint === 0xfeff ||
          (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
          (codePoint >= 0xe0000 && codePoint <= 0xe007f),
      );
    expect(invisibleCodePoints).toEqual([]);
    // The marker itself is plain printable ASCII.
    expect(MEMO_CONTINUITY_MARKER_PREFIX).toMatch(/^[\x21-\x7E]+$/);
  });
});

// --------------------------------------------------------------------------
// 7 — suppression is the caller's routing decision
// --------------------------------------------------------------------------

describe("reconstitution routing — the memo is the caller's fallback", () => {
  it("emits no memo when native replay applied — the target is never touched", async () => {
    const observedMemberNames: string[] = [];
    const target = new FakeTargetSession();
    const router = new TranscriptReconstitutionRouter(
      new MemoDeliveryCoordinator(recordingGateway(target, observedMemberNames)),
    );

    const settlement: ReconstitutionSettlement = await router.route(
      { outcome: "applied", declaredLosses: ["provider_private_reasoning"] },
      requestFor(projectionOf([turn(1, "participant", [{ kind: "text", text: "hello" }])])),
    );

    expect(settlement.route).toBe("native-replay");
    expect(settlement.result.status).toBe("applied");
    expect(observedMemberNames).toEqual([]);
    expect(target.sendAttempts).toBe(0);
    expect(target.readAttempts).toBe(0);
  });

  it("falls to the memo on every non-applied replay outcome", async () => {
    for (const outcome of ["unavailable", "refused", "context-window-exceeded"] as const) {
      const target = new FakeTargetSession();
      const router = new TranscriptReconstitutionRouter(new MemoDeliveryCoordinator(target));

      const settlement: ReconstitutionSettlement = await router.route(
        { outcome },
        requestFor(projectionOf([turn(1, "participant", [{ kind: "text", text: "hello" }])])),
      );

      expect(settlement.route).toBe("memo");
      expect(settlement.result.status).toBe("degraded");
      expect(settlement.result.declaredLosses).toContain("conversation_history_summarized");
      expect(target.sendAttempts).toBe(1);
    }
  });
});

// --------------------------------------------------------------------------
// 8 — a memo settlement never renders identically to an applied one
// --------------------------------------------------------------------------

async function collectMemoSettlements(): Promise<MemoDeliverySettlement[]> {
  const request: MemoDeliveryRequest = requestFor(
    projectionOf([turn(1, "participant", [{ kind: "text", text: "hello" }])]),
  );

  const deliveredTarget = new FakeTargetSession();
  const delivered: MemoDeliverySettlement = await new MemoDeliveryCoordinator(
    deliveredTarget,
  ).deliver(request);
  const alreadyDelivered: MemoDeliverySettlement = await new MemoDeliveryCoordinator(
    deliveredTarget,
  ).deliver(request);

  const withheldTarget = new FakeTargetSession();
  withheldTarget.readOutcomes.push("fail");
  const withheld: MemoDeliverySettlement = await new MemoDeliveryCoordinator(
    withheldTarget,
  ).deliver(request);

  const unconfirmedTarget = new FakeTargetSession();
  unconfirmedTarget.readOutcomes.push("ok", "fail");
  unconfirmedTarget.sendBehavior = "apply-then-fail";
  const unconfirmed: MemoDeliverySettlement = await new MemoDeliveryCoordinator(
    unconfirmedTarget,
  ).deliver(request);

  return [delivered, alreadyDelivered, withheld, unconfirmed];
}

describe("settlement disclosure — a degraded settlement never reads like an applied one", () => {
  it("renders every memo disposition differently from an applied replay", async () => {
    const memoSettlements: MemoDeliverySettlement[] = await collectMemoSettlements();
    expect(memoSettlements.map((settlement) => settlement.disposition)).toEqual([
      "delivered",
      "already-delivered",
      "withheld",
      "unconfirmed",
    ]);

    // The hard case: an APPLIED replay that itself declared a loss. An
    // implementation that inferred DEGRADED from a non-empty loss list dies
    // here. (The applied arm does read that list — to choose between claiming
    // the replay was in full and naming what it omitted — but the route it
    // reports never comes from it.)
    const appliedWithLoss: ReconstitutionSettlement = {
      route: "native-replay",
      result: { status: "applied", declaredLosses: ["provider_private_reasoning"] },
    };
    const appliedWithoutLoss: ReconstitutionSettlement = {
      route: "native-replay",
      result: { status: "applied", declaredLosses: [] },
    };

    const renderings: string[] = [
      renderReconstitutionDisclosure(appliedWithLoss),
      renderReconstitutionDisclosure(appliedWithoutLoss),
      ...memoSettlements.map((settlement) =>
        renderReconstitutionDisclosure({
          route: "memo",
          memo: settlement,
          result: { status: "degraded", declaredLosses: [...settlement.declaredLosses] },
        }),
      ),
    ];

    // Every rendering is distinct — the applied ones from every memo one, and
    // each memo disposition from every other.
    expect(new Set(renderings).size).toBe(renderings.length);

    const appliedRenderings: string[] = renderings.slice(0, 2);
    for (const memoRendering of renderings.slice(2)) {
      expect(appliedRenderings).not.toContain(memoRendering);
    }
  });

  it("claims a replay was in full only when the declared-loss list is empty", () => {
    const disclosure: string = renderReconstitutionDisclosure({
      route: "native-replay",
      result: { status: "applied", declaredLosses: [] },
    });

    expect(disclosure).toContain("in full");
    expect(disclosure).toContain("nothing was dropped");
  });

  it("names what an applied replay omitted, and does not call that replay in full", () => {
    const disclosure: string = renderReconstitutionDisclosure({
      route: "native-replay",
      result: {
        status: "applied",
        declaredLosses: ["provider_private_reasoning", "turn_content_unavailable"],
      },
    });

    // "In full" beside a list of what was dropped tells the participant two
    // contradictory things in one sentence. The claim is reserved for the case
    // that earns it, and the omissions are named on the case that does not.
    expect(disclosure).not.toContain("in full");
    expect(disclosure).toContain("provider_private_reasoning");
    expect(disclosure).toContain("turn_content_unavailable");
    expect(disclosure).not.toContain("nothing was dropped");
    // Still an applied replay, never reworded into a summary.
    expect(disclosure).toContain("replayed into the new session");
    expect(disclosure).not.toContain("summarized");
  });

  it("says plainly, on every memo path, that the conversation was summarized", async () => {
    for (const settlement of await collectMemoSettlements()) {
      const disclosure: string = renderReconstitutionDisclosure({
        route: "memo",
        memo: settlement,
        result: { status: "degraded", declaredLosses: [...settlement.declaredLosses] },
      });
      expect(disclosure).toContain("summarized");
      expect(settlement.status).toBe("degraded");
    }
  });
});
