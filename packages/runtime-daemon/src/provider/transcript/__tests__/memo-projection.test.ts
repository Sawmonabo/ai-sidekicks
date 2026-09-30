// Memo projection floor: the properties memo rendering and delivery must hold, by mechanism.
//
//   * Pairing survives the budget: a kept tool call always keeps its result, checked over generated
//     transcripts. The corpus must contain calls and results in different turns and eviction must
//     fire, or the invariant is a tautology.
//   * Once-only delivery rests on reading the target back, not on a clean retry. Covered against a
//     send that lands and then rejects and one that rejects while the frame is still being applied;
//     the negative control blinds the readback across two coordinators.
//   * The identity key is derived, not stored: recomputed after a restart and across two folds, and
//     an append from another run moves `builtAtPosition` but not the key.
//   * Nothing durable is written: a proxy shows the only target members used are the read and send.

import { describe, expect, it } from "vitest";

import type {
  CanonicalTranscriptProjection,
  CanonicalTranscriptSegment,
  CanonicalTranscriptTurn,
  RunId,
  SessionId,
} from "@ai-sidekicks/contracts";
import { DECLARED_LOSS_KINDS } from "@ai-sidekicks/contracts";

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
  ContradictoryReplayDispositionError,
  TranscriptReconstitutionRouter,
  memoSettlementAsReplayResult,
  renderReconstitutionDisclosure,
  type ReconstitutionSettlement,
} from "../transcript-reconstitution.js";
import {
  DEFAULT_PROTECTED_TAIL_TOOL_EXCHANGE_COUNT,
  EstablishedMemoTarget,
  MEMO_CONTINUITY_MARKER_PREFIX,
  MemoProjection,
  UnownedMemoTargetError,
  defaultMemoBudgetPolicy,
  deriveMemoIdentityKey,
  partitionIntoExchanges,
  renderMemoContinuityMarker,
  type MemoBudgetPolicy,
  type MemoRendering,
  type MemoTargetIdentity,
  type TranscriptExchange,
} from "../memo-projection.js";
import {
  MemoDeliveryCoordinator,
  MemoDeliveryNotEstablishedError,
  type MemoDeliveryRequest,
  type MemoDeliverySettlement,
  type MemoOutboundFrame,
  type MemoSendSettlementBarrier,
  type MemoTargetGateway,
} from "../memo-delivery.js";
import {
  readDeliveredMemoDeclaredLosses,
  targetTurnsCarryAttributableMemoMarker,
  targetTurnsCarryMemoMarker,
} from "../memo-marker-reader.js";

const SESSION_ID: SessionId = "session-memo-projection" as SessionId;
const RUN_ID: RunId = "run-memo-projection" as RunId;
const OTHER_RUN_ID: RunId = "run-memo-unrelated" as RunId;

const TARGET: MemoTargetIdentity = { providerSessionId: "provider-session-target-1" };
const OTHER_TARGET: MemoTargetIdentity = { providerSessionId: "provider-session-target-2" };

/** Wide enough that the whole fixture fits, so eviction is opt-in per case. */
const ROOMY_BUDGET: MemoBudgetPolicy = defaultMemoBudgetPolicy(1_000_000);

// Fixtures

// A fixture omits each segment's position: `turn` stamps the turn's position onto all of them, as
// the fold does. Distributive, because a bare `Omit` over a union keeps only the members its arms
// share and would let a `tool_call` fixture drop its identifier.
type WithoutPosition<TSegment> = TSegment extends unknown ? Omit<TSegment, "position"> : never;
type TurnSegmentFixture = WithoutPosition<CanonicalTranscriptSegment>;

function turn(
  position: number,
  role: "user" | "assistant",
  segments: readonly TurnSegmentFixture[],
): CanonicalTranscriptTurn {
  return {
    position,
    role,
    segments: segments.map((segment): CanonicalTranscriptSegment => ({ ...segment, position })),
  };
}

function projectionOf(
  turns: readonly CanonicalTranscriptTurn[],
  builtAtPosition = 100,
): CanonicalTranscriptProjection {
  return { sessionId: SESSION_ID, runId: RUN_ID, builtAtPosition, turns };
}

/** A delivery request before a coordinator has established its target and minted the handle. */
type DeliveryDraft = Omit<MemoDeliveryRequest, "target"> & {
  readonly target: MemoTargetIdentity;
};

function requestFor(
  projection: CanonicalTranscriptProjection,
  budget: MemoBudgetPolicy = ROOMY_BUDGET,
  target: MemoTargetIdentity = TARGET,
): DeliveryDraft {
  return { projection, target, budget };
}

/**
 * Establishes the draft's target on `coordinator`. Each call asserts the target is fresh and its
 * own; the establishment gate refuses an established handle carried to another coordinator.
 */
function addressedTo(
  coordinator: MemoDeliveryCoordinator,
  draft: DeliveryDraft,
): MemoDeliveryRequest {
  return { ...draft, target: coordinator.establishTarget(draft.target) };
}

async function deliverVia(
  coordinator: MemoDeliveryCoordinator,
  draft: DeliveryDraft,
): Promise<MemoDeliverySettlement> {
  return await coordinator.deliver(addressedTo(coordinator, draft));
}

/**
 * The target session, faked with the failure modes that matter. `readOutcomes` is consumed in
 * order, so a case can make the pre-send read succeed and the post-send readback fail.
 *
 * `apply-then-fail` lands the frame and loses the acknowledgment. `apply-late-then-fail` times out
 * while the provider is still applying the frame, so readbacks before `applyPendingSends` find no
 * marker for a memo about to land; a retry that trusts one of them sends a second memo.
 */
class FakeTargetSession {
  readonly turns: string[] = [];
  readonly readOutcomes: Array<"ok" | "fail"> = [];
  /** The session each reconciliation read was asked about, in order. */
  readonly readTargetIds: string[] = [];
  /** The session each send named, in order. */
  readonly sentTargetIds: string[] = [];
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

  /**
   * Answers the target's whole turn history, never a tail: the port requires a set sufficient to
   * decide marker presence for the entire session.
   */
  async readTurnsForMarkerReconciliation(
    targetProviderSessionId: string,
  ): Promise<readonly string[]> {
    this.readAttempts += 1;
    this.readTargetIds.push(targetProviderSessionId);
    if (this.readOutcomes.shift() === "fail") {
      throw new Error("target session could not be read");
    }
    return this.reportNoTurns ? [] : [...this.turns];
  }

  async sendMemoTurn(frame: MemoOutboundFrame): Promise<void> {
    this.sendAttempts += 1;
    this.sentTargetIds.push(frame.targetProviderSessionId);
    // `wireText`, not the authored prose: the readback reconciles against what the provider got.
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

/** An honest barrier: waits for the provider session to go quiet, so pending sends finish first. */
function settlementBarrierFor(target: FakeTargetSession): MemoSendSettlementBarrier {
  return () => {
    target.applyPendingSends();
    return Promise.resolve();
  };
}

/**
 * A barrier that resolves without observing the provider. Nothing inside the delivery can tell it
 * from an honest wait, so the tests show the call that made a send never trusts it.
 */
const IMMEDIATE_BARRIER: MemoSendSettlementBarrier = () => Promise.resolve();

/** The caller's bounded wait ran out without the session going quiet. */
const EXPIRED_BARRIER: MemoSendSettlementBarrier = () =>
  Promise.reject(new Error("the bounded wait for the provider session expired"));

/**
 * Records every member name read off the gateway, so an implementation that grew a claim, lease or
 * marker operation shows up even if it never imported a database.
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
 * Whether every turn of `candidate` appears in `whole` in the same order. Positions are unique and
 * ascending, so identity is by position.
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
 * The turns no budget may evict, derived here from the exchange partition rather than read off the
 * module under test: the newest exchange plus the newest `toolExchangeCount` tool-bearing ones.
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

// Generated transcripts: the pairing property's corpus

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
  /** Pairs whose call and result landed in different turns; the corpus must contain some. */
  readonly crossTurnPairCount: number;
}

const PADDING = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor";

/**
 * Generates a transcript whose tool pairs straddle turn boundaries, with unpaired calls and
 * orphaned results mixed in so the repair step runs too. Deterministic in `seed`.
 */
function generateTranscript(seed: number): GeneratedTranscript {
  const random = createSeededRandom(seed);
  const turns: CanonicalTranscriptTurn[] = [];
  let position = 0;
  let toolCallOrdinal = 0;
  let crossTurnPairCount = 0;

  const pushTurn = (role: "user" | "assistant", segments: readonly TurnSegmentFixture[]): void => {
    position += 1;
    turns.push(turn(position, role, segments));
  };

  const exchangeCount: number = 4 + Math.floor(random() * 6);
  for (let exchangeIndex = 0; exchangeIndex < exchangeCount; exchangeIndex += 1) {
    pushTurn("user", [
      { kind: "text", text: `user utterance ${exchangeIndex.toString()} ${PADDING}` },
    ]);

    const callSegments: TurnSegmentFixture[] = [];
    const callIds: string[] = [];
    // Reaches zero on purpose: a corpus where every exchange used a tool never exercises a
    // protected tail that cannot be filled.
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
      // A reasoning block the strip must remove; it orphans nothing but runs the reused transform.
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
      // Repair synthesizes the result in the call's own turn, so this pair never straddles; the
      // whole-exchange rule must hold for the repaired pair too.
      pushTurn("assistant", callSegments);
      continue;
    }

    const resultSegments: TurnSegmentFixture[] = callIds.map((toolCallId) => ({
      kind: "tool_result",
      toolCallId,
      outcome: "succeeded",
      provenance: "provider",
      text: `result for ${toolCallId} ${PADDING}`,
    }));

    if (resultsInLaterTurn) {
      pushTurn("assistant", callSegments);
      if (random() < 0.5) {
        // A user turn between the call and its result: a per-turn partition splits the pair, the
        // straddle rule does not.
        pushTurn("user", [
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

// The pairing property, over generated transcripts

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

      // Spans both regimes: tight windows force eviction and the wide one does not, so guard (b)
      // below can tell them apart.
      for (const contextWindowTokens of [120, 240, 480, 960, 1920, 100_000]) {
        const rendering: MemoRendering = memoProjection.render(
          requestFor(generated.projection, defaultMemoBudgetPolicy(contextWindowTokens)),
        );
        renderCount += 1;
        if (rendering.evictedExchangeCount > 0) {
          rendersThatEvicted += 1;
        }

        expect(toolCallIdsIn(rendering.includedTurns)).toEqual(
          toolResultIdsIn(rendering.includedTurns),
        );

        // An order-preserving subsequence of the unbounded render: never a reordering or a turn the
        // transforms did not produce. Not a contiguous suffix, because protection is per exchange
        // and an older tool exchange may be kept past an evicted newer one.
        expect(isOrderPreservingSubsequence(rendering.includedTurns, unbounded.includedTurns)).toBe(
          true,
        );

        // Every protected exchange survives any budget: the newest exchange and the newest
        // tool-bearing ones wherever they sit.
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

    // Vacuity guard (a): the corpus straddles turn boundaries.
    expect(totalCrossTurnPairs).toBeGreaterThan(0);
    // Vacuity guard (b): eviction fired.
    expect(rendersThatEvicted).toBeGreaterThan(0);
    expect(rendersThatEvicted).toBeLessThan(renderCount);
    // Vacuity guard (c): some transcripts have fewer tool-bearing exchanges than the protected tail
    // wants, the input on which the tail is only partly satisfiable.
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
    // Older exchanges were evicted here, so the truncation is real.
    expect(rendering.evictedExchangeCount).toBeGreaterThan(0);
    expect(rendering.declaredLosses).toContain("context_truncated");
  });

  it("declares no truncation when a single over-budget exchange arrived whole", () => {
    // Over budget is not truncated: nothing was evicted, so claiming truncation would report a loss
    // against a conversation that arrived intact.
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
    // The protected tail is anchored on tool exchanges, so a transcript with none must not protect
    // itself entirely; that would leave the budget unenforceable on plain back-and-forth talk.
    const memoProjection = new MemoProjection();
    const turns: CanonicalTranscriptTurn[] = [];
    for (let index = 0; index < 12; index += 1) {
      turns.push(
        turn(index + 1, index % 2 === 0 ? "user" : "assistant", [
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
    // The only tool exchange is also the newest, so it qualifies for the protected tail. It is
    // protected as one whole exchange without dragging later turns in: eviction steps over it and
    // the budget still binds on the plain run that follows.
    const memoProjection = new MemoProjection();
    const turns: CanonicalTranscriptTurn[] = [
      turn(1, "user", [{ kind: "text", text: `opening ${PADDING}` }]),
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
        turn(index + 3, index % 2 === 0 ? "user" : "assistant", [
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
    // The budget still binds: eviction fired around the protected exchange.
    expect(bounded.evictedExchangeCount).toBeGreaterThan(0);
    expect(bounded.declaredLosses).toContain("context_truncated");
    // The ancient exchange is protected where it sits, both halves together.
    expect(toolCallIdsIn(bounded.includedTurns)).toEqual(["call-ancient"]);
    expect(toolResultIdsIn(bounded.includedTurns)).toEqual(["call-ancient"]);
    expect(bounded.includedTurns.at(-1)).toEqual(unbounded.includedTurns.at(-1));

    // The included set is not a contiguous suffix: it has a gap between the protected exchange and
    // the retained tail, which an anchored protected region could not produce without also
    // protecting everything in the gap.
    const includedPositions: readonly number[] = bounded.includedTurns.map(
      (includedTurn) => includedTurn.position,
    );
    expect(includedPositions).toContain(2);
    expect(includedPositions.at(-1)).toBe(12);
    const contiguous: boolean = includedPositions.every(
      (position, index) => index === 0 || position === (includedPositions[index - 1] ?? 0) + 1,
    );
    expect(contiguous).toBe(false);
    // The notice does not claim the retained exchanges are the most recent.
    expect(bounded.text).toContain("may not be consecutive");
  });

  it("keeps a user turn that sits between a call and its result inside the exchange", () => {
    const exchanges = partitionIntoExchanges([
      turn(1, "assistant", [
        { kind: "tool_call", toolCallId: "call-1", toolName: "inspect", argumentsJson: "{}" },
      ]),
      turn(2, "user", [{ kind: "text", text: "hold on" }]),
      turn(3, "assistant", [
        {
          kind: "tool_result",
          toolCallId: "call-1",
          outcome: "succeeded",
          provenance: "provider",
          text: "done",
        },
      ]),
      turn(4, "user", [{ kind: "text", text: "carry on" }]),
    ]);

    expect(exchanges.map((exchange) => exchange.turns.length)).toEqual([3, 1]);
    expect(exchanges[0]?.carriesToolActivity).toBe(true);
    expect(exchanges[1]?.carriesToolActivity).toBe(false);
  });

  it("never emits a memo larger than the ceiling it reports fitting under", () => {
    // Assembly joins the preamble and every admitted exchange with a newline, so pricing each
    // exchange alone under-counts by one separator per admission, and the injected estimator does
    // not owe additivity. Near the ceiling that admits a set that assembles past the budget while
    // the render reports it fits. Only a sweep of every integer ceiling finds it; one fixed budget
    // would miss it.
    const memoProjection = new MemoProjection();
    const turns: CanonicalTranscriptTurn[] = [];
    for (let index = 0; index < 12; index += 1) {
      // Each rendered turn is exactly 72 characters, a whole multiple of the default estimator's
      // four characters per token, so rounding adds no slack and the separators are measured.
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
      // A render that reports itself within its ceiling is within it, measured over the prose the
      // settlement carries.
      expect(rendering.estimatedTokens).toBeLessThanOrEqual(ceilingTokens);
      if (rendering.evictedExchangeCount > 0) {
        ceilingsThatFitAfterEviction += 1;
      }
    }

    // Vacuity guards: the sweep spans ceilings the protected floor alone overruns and ceilings
    // where eviction brought the memo back under one, which is where the separators are paid.
    expect(ceilingsTheProtectedFloorOverran).toBeGreaterThan(0);
    expect(ceilingsThatFitAfterEviction).toBeGreaterThan(0);
  });
});

// Portability transforms the floor reuses

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
      requestFor(projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])])),
    );
    expect(rendering.declaredLosses).toContain("conversation_history_summarized");
  });

  it("declares an unreadable body and names it in the prose the model reads", () => {
    const memoProjection = new MemoProjection();
    const rendering: MemoRendering = memoProjection.render(
      requestFor(
        projectionOf([
          turn(1, "user", [{ kind: "text", text: "what did that return?" }]),
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
    // The settlement's declaration does not reach the memo's own text, so the gap is named there
    // too: an empty body renders to nothing, and a turn of nothing reads to the model as a turn
    // that never happened.
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
          turn(1, "user", [{ kind: "text", text: "what did that return?" }]),
          turn(2, "assistant", [{ kind: "text", text: "an empty list" }]),
        ]),
      ),
    );
    expect(rendering.declaredLosses).not.toContain("turn_content_unavailable");
    expect(rendering.text).not.toContain("could not be recovered");
  });
});

// Reconcile before every send

describe("memo delivery — once-only under a lost acknowledgment", () => {
  it("delivers exactly once when the send lands at the target and the acknowledgment is lost", async () => {
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-then-fail";
    const coordinator = new MemoDeliveryCoordinator(target);
    const request: DeliveryDraft = requestFor(
      projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])]),
    );

    const first: MemoDeliverySettlement = await deliverVia(coordinator, request);
    // Resolved by reading the target, not by trusting the rejection.
    expect(first.disposition).toBe("delivered");

    // The caller retries, as a caller with no acknowledgment must.
    const second: MemoDeliverySettlement = await deliverVia(coordinator, request);
    expect(second.disposition).toBe("already-delivered");
    expect(second.memoIdentityKey).toBe(first.memoIdentityKey);

    // What the target holds is the load-bearing assertion, not the disposition.
    expect(target.turns).toHaveLength(1);
    expect(target.sendAttempts).toBe(1);
  });

  it("negative control — blinding the readback across two coordinators produces the duplicate", async () => {
    // Blinded across two coordinators, the only scope where reconciliation stands alone: one
    // coordinator remembers its own send went unacknowledged and will not resend on an absence it
    // cannot trust. Two coordinators, two processes or a restart have only the readback, which this
    // blinds.
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-then-fail";
    target.reportNoTurns = true;
    const request: DeliveryDraft = requestFor(
      projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])]),
    );

    await deliverVia(new MemoDeliveryCoordinator(target), request);
    await deliverVia(new MemoDeliveryCoordinator(target), request);

    expect(target.turns).toHaveLength(2);
    expect(target.sendAttempts).toBe(2);
  });

  it("finds a memo delivered far back in the conversation and sends no second one", async () => {
    // The memo scrolls far back under a long conversation, and the caller retries after a restart
    // with no register to consult.
    const target = new FakeTargetSession();
    const request: DeliveryDraft = requestFor(
      projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])]),
    );

    const first: MemoDeliverySettlement = await deliverVia(
      new MemoDeliveryCoordinator(target),
      request,
    );
    expect(first.disposition).toBe("delivered");
    for (let turnIndex = 0; turnIndex < 200; turnIndex += 1) {
      target.turns.push(`ordinary turn ${turnIndex.toString()}`);
    }

    // A fresh coordinator, so nothing but the read decides this.
    const retry: MemoDeliverySettlement = await deliverVia(
      new MemoDeliveryCoordinator(target),
      request,
    );

    expect(retry.disposition).toBe("already-delivered");
    expect(retry.memoIdentityKey).toBe(first.memoIdentityKey);
    expect(target.sendAttempts).toBe(1);
    expect(target.turns.filter((turnText) => turnText.includes("continuity-ref:"))).toHaveLength(1);
  });

  it("documents the cost of a windowed read — a marker-incomplete answer duplicates", async () => {
    // Not a control for the read's naming. The port's obligation to answer for the whole session is
    // all that separates the case above from this one; an obligation with no demonstrated cost
    // reads as a preference.
    class WindowedTargetSession extends FakeTargetSession {
      static readonly WINDOW_TURN_COUNT: number = 20;

      override async readTurnsForMarkerReconciliation(
        targetProviderSessionId: string,
      ): Promise<readonly string[]> {
        const wholeHistory: readonly string[] = await super.readTurnsForMarkerReconciliation(
          targetProviderSessionId,
        );
        return wholeHistory.slice(-WindowedTargetSession.WINDOW_TURN_COUNT);
      }
    }

    const target = new WindowedTargetSession();
    const request: DeliveryDraft = requestFor(
      projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])]),
    );

    await deliverVia(new MemoDeliveryCoordinator(target), request);
    for (let turnIndex = 0; turnIndex < 200; turnIndex += 1) {
      target.turns.push(`ordinary turn ${turnIndex.toString()}`);
    }
    const retry: MemoDeliverySettlement = await deliverVia(
      new MemoDeliveryCoordinator(target),
      request,
    );

    // The marker is still in the conversation; the window cannot see it, so the user reads the
    // same summary twice.
    expect(retry.disposition).toBe("delivered");
    expect(target.sendAttempts).toBe(2);
    expect(target.turns.filter((turnText) => turnText.includes("continuity-ref:"))).toHaveLength(2);
  });
});

/** A conversation long enough that a tight budget must evict some of it. */
function plainConversation(): CanonicalTranscriptProjection {
  const turns: CanonicalTranscriptTurn[] = [];
  for (let index = 0; index < 12; index += 1) {
    turns.push(
      turn(index + 1, index % 2 === 0 ? "user" : "assistant", [
        { kind: "text", text: `plain exchange ${index.toString()} ${PADDING}` },
      ]),
    );
  }
  return projectionOf(turns);
}

describe("memo reconciliation — the losses reported are the DELIVERED summary's", () => {
  it("reports what the delivered summary dropped, not what a later render would", async () => {
    // The delivered summary was rendered under a tight budget and left older exchanges out. A later
    // delivery under a roomier budget finds it and sends nothing, and must report the delivered
    // summary's losses rather than the fresh render's.
    const target = new FakeTargetSession();
    const projection: CanonicalTranscriptProjection = plainConversation();

    const delivered: MemoDeliverySettlement = await deliverVia(
      new MemoDeliveryCoordinator(target),
      requestFor(projection, defaultMemoBudgetPolicy(600)),
    );
    expect(delivered.disposition).toBe("delivered");
    expect(delivered.declaredLosses).toContain("context_truncated");

    // A fresh coordinator under a budget wide enough to drop nothing, so only the read decides
    // what is reported.
    const retry: MemoDeliverySettlement = await deliverVia(
      new MemoDeliveryCoordinator(target),
      requestFor(projection, ROOMY_BUDGET),
    );

    expect(retry.disposition).toBe("already-delivered");
    expect(retry.rendering.declaredLosses).not.toContain("context_truncated");
    expect(retry.declaredLossSource).toBe("delivered-memo");
    expect(retry.declaredLosses).toStrictEqual(delivered.declaredLosses);
    expect(target.sendAttempts).toBe(1);
  });

  it("declares an upper bound when the delivered summary recorded no losses of its own", async () => {
    // A summary placed before summaries recorded what they dropped teaches nothing, so the report
    // is the whole loss vocabulary, stated as a bound rather than an account.
    const target = new FakeTargetSession();
    const projection: CanonicalTranscriptProjection = plainConversation();
    const request: DeliveryDraft = requestFor(projection, ROOMY_BUDGET);
    target.turns.push(
      `an older summary ${MEMO_CONTINUITY_MARKER_PREFIX}${deriveMemoIdentityKey(projection, TARGET)}`,
    );

    const settlement: MemoDeliverySettlement = await deliverVia(
      new MemoDeliveryCoordinator(target),
      request,
    );

    expect(settlement.disposition).toBe("already-delivered");
    expect(settlement.declaredLossSource).toBe("unknown");
    expect(settlement.declaredLosses).toStrictEqual(DECLARED_LOSS_KINDS);
    expect(target.sendAttempts).toBe(0);

    const disclosure: string = renderReconstitutionDisclosure({
      route: "memo",
      memo: settlement,
    });
    expect(disclosure).toContain("not recorded");
    expect(disclosure).toContain("at most");
  });

  it("refuses a record that lists nothing, or lists it malformed", async () => {
    // A record that lists nothing must not read as a memo that dropped nothing. This floor declares
    // its summarization on every path, so a record that omits it was not written by this writer and
    // its omissions cannot be accounted for.
    const projection: CanonicalTranscriptProjection = plainConversation();
    const memoIdentityKey: string = deriveMemoIdentityKey(projection, TARGET);
    const marker: string = `${MEMO_CONTINUITY_MARKER_PREFIX}${memoIdentityKey}`;
    const unreadable: readonly string[] = [
      // No record at all after the separator.
      `${marker};dropped=`,
      `${marker};dropped= conversation_history_summarized`,
      // Empty components, from a leading, trailing, or doubled joiner.
      `${marker};dropped=+conversation_history_summarized`,
      `${marker};dropped=conversation_history_summarized+`,
      `${marker};dropped=context_truncated++conversation_history_summarized`,
      // A well-formed list that omits the kind this floor always declares.
      `${marker};dropped=context_truncated`,
    ];

    for (const turnText of unreadable) {
      expect(readDeliveredMemoDeclaredLosses([turnText], memoIdentityKey)).toBeUndefined();
    }

    // Per occurrence: one readable record does not vouch for the memo beside it, since a target
    // with two markers under one key holds two summaries.
    expect(
      readDeliveredMemoDeclaredLosses(
        [
          renderMemoContinuityMarker(memoIdentityKey, [
            "context_truncated",
            "conversation_history_summarized",
          ]),
          `${marker};dropped=`,
        ],
        memoIdentityKey,
      ),
    ).toBeUndefined();

    // The floor's own single-kind record still reads: the strictness is about records this writer
    // cannot produce, not short ones.
    expect(
      readDeliveredMemoDeclaredLosses(
        [`${marker};dropped=conversation_history_summarized`],
        memoIdentityKey,
      ),
    ).toStrictEqual(["conversation_history_summarized"]);
  });

  it("admits delivery only on a syntactically COMPLETE marker occurrence", () => {
    // Admission decides whether to skip the only context transfer there is, so a false yes leaves
    // the target with nothing while the caller reports success. A substring test says yes to any
    // text the key sits inside; the two boundaries make an occurrence this marker and not something
    // longer that contains it.
    const projection: CanonicalTranscriptProjection = plainConversation();
    const memoIdentityKey: string = deriveMemoIdentityKey(projection, TARGET);
    const marker: string = `${MEMO_CONTINUITY_MARKER_PREFIX}${memoIdentityKey}`;

    const notThisMarker: readonly string[] = [
      // The key runs on into more token characters: a different key that begins with this one.
      `${marker}0`,
      `${marker}-second`,
      `${marker}_b`,
      // The token opened mid-word: `continuity-ref:` is ordinary lowercase text, so a longer word
      // ending in it would open a marker never written.
      `x${marker}`,
      `discontinuity-ref:${memoIdentityKey}`,
    ];
    for (const turnText of notThisMarker) {
      expect(targetTurnsCarryMemoMarker([turnText], memoIdentityKey)).toBe(false);
      // The record reader answers the same, because one grammar serves both.
      expect(readDeliveredMemoDeclaredLosses([turnText], memoIdentityKey)).toBeUndefined();
    }

    const thisMarker: readonly string[] = [
      marker,
      `an older summary ${marker}`,
      `${marker} and then some prose`,
      `(${marker})`,
      `${marker};dropped=conversation_history_summarized`,
      // Complete with an unreadable record is still this marker, so still delivered: presence says
      // a summary is in the target, and resending on an unparseable record would add a second.
      // What the record cannot say is reported as the upper bound, the arm asserted above.
      `${marker};dropped=`,
    ];
    for (const turnText of thisMarker) {
      expect(targetTurnsCarryMemoMarker([turnText], memoIdentityKey)).toBe(true);
    }
  });

  it("sends the memo into a target whose text merely EXTENDS the marker key", async () => {
    // Through the coordinator: a near-miss must not settle the delivery, or the context transfer
    // silently does not happen.
    const target = new FakeTargetSession();
    const projection: CanonicalTranscriptProjection = plainConversation();
    target.turns.push(
      `${MEMO_CONTINUITY_MARKER_PREFIX}${deriveMemoIdentityKey(projection, TARGET)}-second`,
    );

    const settlement: MemoDeliverySettlement = await deliverVia(
      new MemoDeliveryCoordinator(target),
      requestFor(projection, ROOMY_BUDGET),
    );

    expect(settlement.disposition).toBe("delivered");
    expect(target.sendAttempts).toBe(1);
  });

  it("sends the memo past a pasted foreign marker rather than settling on it", async () => {
    // Marker text is plain prose, so a user can paste another conversation's complete marker into
    // the target. Matching any well-shaped key would read that as a delivery and settle
    // already-delivered over a target holding no memo. A key this coordinator never attempted
    // settles nothing.
    const target = new FakeTargetSession();
    const foreignMemoIdentityKey: string = "ab".repeat(16);
    target.turns.push(
      `the other session said: ${MEMO_CONTINUITY_MARKER_PREFIX}${foreignMemoIdentityKey};dropped=conversation_history_summarized`,
      `and bare: ${MEMO_CONTINUITY_MARKER_PREFIX}${"cd".repeat(16)}`,
    );

    const settlement: MemoDeliverySettlement = await deliverVia(
      new MemoDeliveryCoordinator(target),
      requestFor(plainConversation(), ROOMY_BUDGET),
    );

    expect(settlement.disposition).toBe("delivered");
    expect(target.sendAttempts).toBe(1);
  });

  it("still settles already-delivered on its own marker beside pasted foreign ones", async () => {
    const target = new FakeTargetSession();
    const coordinator = new MemoDeliveryCoordinator(target);
    const request: DeliveryDraft = requestFor(plainConversation(), ROOMY_BUDGET);

    const first: MemoDeliverySettlement = await deliverVia(coordinator, request);
    expect(first.disposition).toBe("delivered");
    target.turns.push(`quoted: ${MEMO_CONTINUITY_MARKER_PREFIX}${"ef".repeat(16)}`);

    const retry: MemoDeliverySettlement = await deliverVia(coordinator, request);

    expect(retry.disposition).toBe("already-delivered");
    expect(target.sendAttempts).toBe(1);
  });

  it("admits exactly the attributable keys, at the predicate level", () => {
    const attributedKey: string = "12".repeat(16);
    const foreignKey: string = "34".repeat(16);
    const attributable: ReadonlySet<string> = new Set([attributedKey]);
    expect(
      targetTurnsCarryAttributableMemoMarker(
        [`${MEMO_CONTINUITY_MARKER_PREFIX}${attributedKey}`],
        attributable,
      ),
    ).toBe(true);
    expect(
      targetTurnsCarryAttributableMemoMarker(
        [`${MEMO_CONTINUITY_MARKER_PREFIX}${foreignKey}`],
        attributable,
      ),
    ).toBe(false);
    // The grammar is still the strict shared one: an attributable key in a non-marker shape is not
    // an occurrence at all.
    expect(
      targetTurnsCarryAttributableMemoMarker(
        [`${MEMO_CONTINUITY_MARKER_PREFIX}${attributedKey}0`],
        attributable,
      ),
    ).toBe(false);
  });

  it("names the target session on every reconciliation read, as the send does", async () => {
    // Reconciliation decides whether to send into the session the frame names, so an untargeted
    // read could let an absent marker in one session license a send into another. The identity key
    // is derived over the target session id, so such an answer would not be about the same key
    // either. Both reads are asserted, including the post-send readback that settles an ambiguous
    // send.
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-then-fail";
    const projection: CanonicalTranscriptProjection = plainConversation();
    // Not the default target, so the id is shown to come from the request.
    const request: DeliveryDraft = requestFor(projection, ROOMY_BUDGET, OTHER_TARGET);

    const settlement: MemoDeliverySettlement = await deliverVia(
      new MemoDeliveryCoordinator(target),
      request,
    );

    expect(settlement.disposition).toBe("delivered");
    expect(target.readAttempts).toBe(2);
    expect(target.readTargetIds).toStrictEqual([
      OTHER_TARGET.providerSessionId,
      OTHER_TARGET.providerSessionId,
    ]);
    // One session, read and written: the two must agree or the reconciliation is not about the
    // send it guards.
    expect(target.sentTargetIds).toStrictEqual([OTHER_TARGET.providerSessionId]);
  });

  it("declares the upper bound when the delivered memo's record is vacuous", async () => {
    // An unreadable record settles as the whole closed vocabulary, stated as a bound. The
    // vocabulary, not this build's producible subset: only the wider set is a bound.
    const target = new FakeTargetSession();
    const projection: CanonicalTranscriptProjection = plainConversation();
    const request: DeliveryDraft = requestFor(projection, ROOMY_BUDGET);
    target.turns.push(
      `an older summary ${MEMO_CONTINUITY_MARKER_PREFIX}${deriveMemoIdentityKey(
        projection,
        TARGET,
      )};dropped=`,
    );

    const settlement: MemoDeliverySettlement = await deliverVia(
      new MemoDeliveryCoordinator(target),
      request,
    );

    expect(settlement.disposition).toBe("already-delivered");
    expect(settlement.declaredLossSource).toBe("unknown");
    expect(settlement.declaredLosses).toStrictEqual(DECLARED_LOSS_KINDS);
  });

  it("refuses to read a record it does not fully understand", async () => {
    // Fail closed on the parse, as the fold does on an unknown disclosure: understanding a record
    // partly is worse than not claiming to, and the unrecognized token could name any loss.
    const projection: CanonicalTranscriptProjection = plainConversation();
    const memoIdentityKey: string = deriveMemoIdentityKey(projection, TARGET);

    expect(
      readDeliveredMemoDeclaredLosses(
        [
          `${MEMO_CONTINUITY_MARKER_PREFIX}${memoIdentityKey};dropped=context_truncated+a_kind_from_later`,
        ],
        memoIdentityKey,
      ),
    ).toBeUndefined();
    expect(
      readDeliveredMemoDeclaredLosses(
        [
          `carried in prose: ${renderMemoContinuityMarker(memoIdentityKey, [
            "context_truncated",
            "conversation_history_summarized",
          ])} and the summary follows.`,
        ],
        memoIdentityKey,
      ),
    ).toStrictEqual(["context_truncated", "conversation_history_summarized"]);
  });

  it("reads a record naming a kind this build produces NOWHERE", () => {
    // The vocabulary is the wire's, not this workspace's. A peer daemon on a newer build may write
    // a kind this build never emits, and the reader places the token rather than asking whether
    // this build produces it. Unrecognized, the record would settle as the whole bound and report
    // a memo that dropped everything, from a writer that said precisely what it dropped. That is
    // why the vocabulary is carried complete and not trimmed to what this build emits.
    const projection: CanonicalTranscriptProjection = plainConversation();
    const memoIdentityKey: string = deriveMemoIdentityKey(projection, TARGET);

    expect(
      readDeliveredMemoDeclaredLosses(
        [
          renderMemoContinuityMarker(memoIdentityKey, [
            "conversation_history_summarized",
            "turn_content_truncated",
          ]),
        ],
        memoIdentityKey,
      ),
    ).toStrictEqual(["conversation_history_summarized", "turn_content_truncated"]);
  });

  it("reports the delivered summary's losses on an acknowledgment lost after it landed", async () => {
    // The same rule where a settlement rests on a marker read rather than on this call's own
    // acknowledged send. A marker with no record under this memo's key is provably not the memo
    // this call composed, so the rule is read off the marker.
    const target = new FakeTargetSession();
    const projection: CanonicalTranscriptProjection = plainConversation();
    const request: DeliveryDraft = requestFor(projection, ROOMY_BUDGET);
    target.sendBehavior = "apply-then-fail";
    target.readOutcomes.push("ok");
    // The pre-send read sees nothing, so the send is attempted and its readback settles the
    // delivery.
    const priorTurn = `an older summary ${MEMO_CONTINUITY_MARKER_PREFIX}${deriveMemoIdentityKey(
      projection,
      TARGET,
    )}`;

    const settlement: MemoDeliverySettlement = await deliverVia(
      new MemoDeliveryCoordinator({
        readTurnsForMarkerReconciliation: async (): Promise<readonly string[]> =>
          target.sendAttempts === 0 ? [] : [priorTurn, ...target.turns],
        sendMemoTurn: async (frame: MemoOutboundFrame): Promise<void> => {
          await target.sendMemoTurn(frame);
        },
      }),
      request,
    );

    expect(settlement.disposition).toBe("delivered");
    expect(settlement.declaredLossSource).toBe("unknown");
    expect(settlement.declaredLosses).toStrictEqual(DECLARED_LOSS_KINDS);
  });
});

/**
 * A send whose acknowledgment is lost may still be landing at the provider, so a readback
 * taken at once finds no marker yet. Settling that one snapshot as a refusal would let a
 * retry send a second memo into a conversation that is already receiving the first.
 */
describe("memo delivery — an ambiguous send is held unconfirmed", () => {
  const AMBIGUOUS_REQUEST: DeliveryDraft = requestFor(
    projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])]),
  );

  it("does not let a retry race a slow-applying send into a second memo", async () => {
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-late-then-fail";
    const coordinator = new MemoDeliveryCoordinator(target);

    const first: MemoDeliverySettlement = await deliverVia(coordinator, AMBIGUOUS_REQUEST);

    // The provider has not finished applying, so the readback found nothing; that is not a refusal.
    expect(first.disposition).toBe("unconfirmed");
    expect(first.withheldReason).toBeUndefined();
    expect(target.sendAttempts).toBe(1);
    expect(target.turns).toHaveLength(0);

    // The retry's read finds nothing for the same reason.
    const retry: MemoDeliverySettlement = await deliverVia(coordinator, AMBIGUOUS_REQUEST);

    expect(retry.disposition).toBe("unconfirmed");
    expect(target.sendAttempts).toBe(1);

    target.applyPendingSends();
    expect(target.turns).toHaveLength(1);

    const afterLanding: MemoDeliverySettlement = await deliverVia(coordinator, AMBIGUOUS_REQUEST);

    // The target holds one memo from one send across three delivery calls.
    expect(afterLanding.disposition).toBe("already-delivered");
    expect(target.sendAttempts).toBe(1);
    expect(target.turns).toHaveLength(1);
  });

  it("does not double-send when a barrier is supplied and the first send lands late", async () => {
    // The call that made the ambiguous send never consults the barrier, so a barrier that
    // resolves at once cannot talk that call into a refusal.
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-late-then-fail";
    const coordinator = new MemoDeliveryCoordinator(target);
    const requestWithBarrier: DeliveryDraft = {
      ...AMBIGUOUS_REQUEST,
      sendSettlementBarrier: IMMEDIATE_BARRIER,
    };

    const first: MemoDeliverySettlement = await deliverVia(coordinator, requestWithBarrier);
    expect(first.disposition).toBe("unconfirmed");
    expect(target.sendAttempts).toBe(1);

    await deliverVia(coordinator, requestWithBarrier);
    target.applyPendingSends();

    expect(target.sendAttempts).toBe(1);
    expect(target.turns).toHaveLength(1);
  });

  it("converges on the late-landing memo when the barrier really waits for it", async () => {
    // A barrier that waits for the session to go quiet lets the first send finish, so the
    // retry's read finds the memo and settles as already delivered.
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-late-then-fail";
    const coordinator = new MemoDeliveryCoordinator(target);
    const requestWithBarrier: DeliveryDraft = {
      ...AMBIGUOUS_REQUEST,
      sendSettlementBarrier: settlementBarrierFor(target),
    };

    const first: MemoDeliverySettlement = await deliverVia(coordinator, requestWithBarrier);
    const retry: MemoDeliverySettlement = await deliverVia(coordinator, requestWithBarrier);
    const third: MemoDeliverySettlement = await deliverVia(coordinator, requestWithBarrier);

    expect(first.disposition).toBe("unconfirmed");
    expect(retry.disposition).toBe("already-delivered");
    expect(third.disposition).toBe("already-delivered");
    expect(target.sendAttempts).toBe(1);
    expect(target.turns).toHaveLength(1);
  });

  it("sends again once the caller's barrier establishes the earlier send never landed", async () => {
    // Holding the memo back forever would leave the user without a summary. Closing the old
    // ambiguity and attempting a new send are two calls: the barrier closes the first send,
    // and the ordinary reconcile that follows opens the second.
    const target = new FakeTargetSession();
    target.sendBehavior = "refuse";
    const coordinator = new MemoDeliveryCoordinator(target);
    const requestWithBarrier: DeliveryDraft = {
      ...AMBIGUOUS_REQUEST,
      sendSettlementBarrier: settlementBarrierFor(target),
    };

    const first: MemoDeliverySettlement = await deliverVia(coordinator, requestWithBarrier);
    expect(first.disposition).toBe("unconfirmed");
    expect(target.sendAttempts).toBe(1);

    const resolved: MemoDeliverySettlement = await deliverVia(coordinator, requestWithBarrier);
    expect(resolved.disposition).toBe("withheld");
    expect(resolved.withheldReason).toBe("send-refused");
    expect(target.sendAttempts).toBe(1);

    target.sendBehavior = "accept";
    const resent: MemoDeliverySettlement = await deliverVia(coordinator, requestWithBarrier);

    expect(resent.disposition).toBe("delivered");
    expect(target.sendAttempts).toBe(2);
    expect(target.turns).toHaveLength(1);
  });

  it("sends nothing when the caller's barrier expires instead of settling", async () => {
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-late-then-fail";
    const coordinator = new MemoDeliveryCoordinator(target);

    await deliverVia(coordinator, AMBIGUOUS_REQUEST);
    const retry: MemoDeliverySettlement = await deliverVia(coordinator, {
      ...AMBIGUOUS_REQUEST,
      sendSettlementBarrier: EXPIRED_BARRIER,
    });

    // An expired wait establishes nothing, so no send follows.
    expect(retry.disposition).toBe("unconfirmed");
    expect(target.sendAttempts).toBe(1);
  });

  it("does not downgrade an outstanding send to a refusal when the target goes unreadable", async () => {
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-late-then-fail";
    const coordinator = new MemoDeliveryCoordinator(target);

    await deliverVia(coordinator, AMBIGUOUS_REQUEST);
    target.readOutcomes.push("fail");
    const retry: MemoDeliverySettlement = await deliverVia(coordinator, AMBIGUOUS_REQUEST);

    // Withheld would assert that nothing landed; an unreadable target establishes no such thing.
    expect(retry.disposition).toBe("unconfirmed");
    expect(retry.withheldReason).toBeUndefined();
    expect(target.sendAttempts).toBe(1);
  });

  it("does not duplicate even when the readback is blind, within one coordinator", async () => {
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-then-fail";
    target.reportNoTurns = true;
    const coordinator = new MemoDeliveryCoordinator(target);

    await deliverVia(coordinator, AMBIGUOUS_REQUEST);
    await deliverVia(coordinator, AMBIGUOUS_REQUEST);

    // The memo landed and the blind read cannot see it, yet no second send is attempted: an
    // unacknowledged send is remembered, not re-derived from a read that may be wrong.
    expect(target.sendAttempts).toBe(1);
    expect(target.turns).toHaveLength(1);
  });

  it("negative control — a successor that claims the same target afresh duplicates", async () => {
    // The register lives in one coordinator and is not durable. A successor that establishes
    // the still-applying target as its own passes the establishment gate, reads an absence
    // that is only an unfinished apply, and sends the summary again. Nothing can tell a fresh
    // provider session id from a reused one; the caller must abandon an ambiguously-sent
    // target, never reuse it.
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-late-then-fail";

    await deliverVia(new MemoDeliveryCoordinator(target), AMBIGUOUS_REQUEST);
    await deliverVia(new MemoDeliveryCoordinator(target), AMBIGUOUS_REQUEST);

    expect(target.sendAttempts).toBe(2);
    target.applyPendingSends();
    expect(target.turns).toHaveLength(2);
  });
});

describe("memo delivery — only the coordinator that established a target sends into it", () => {
  const REQUEST_DRAFT: DeliveryDraft = requestFor(
    projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])]),
  );

  it("refuses to send into a target another coordinator established", async () => {
    // A restart: the coordinator that made the ambiguous send and its register are gone, and
    // the successor inherits only the request, established target included. It knows nothing
    // about the send still applying, so it is refused before it can read an absence and act.
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-late-then-fail";
    const original = new MemoDeliveryCoordinator(target);
    const request: MemoDeliveryRequest = addressedTo(original, REQUEST_DRAFT);

    const first: MemoDeliverySettlement = await original.deliver(request);
    expect(first.disposition).toBe("unconfirmed");
    expect(target.sendAttempts).toBe(1);

    const readsBeforeTheSuccessor: number = target.readAttempts;
    const successor = new MemoDeliveryCoordinator(target);
    await expect(successor.deliver(request)).rejects.toBeInstanceOf(UnownedMemoTargetError);

    // The refusal comes before the read as well as before the send.
    expect(target.readAttempts).toBe(readsBeforeTheSuccessor);
    expect(target.sendAttempts).toBe(1);
    target.applyPendingSends();
    expect(target.turns).toHaveLength(1);
  });

  it("refuses a handle nothing established, however well-formed", async () => {
    // The handle type is nominal, so a bare literal cannot be passed. A well-formed handle for
    // the right session is still refused: admission rests on the coordinator's own record of
    // establishing the target, not on the value the handle carries.
    const target = new FakeTargetSession();
    const coordinator = new MemoDeliveryCoordinator(target);

    await expect(
      coordinator.deliver({
        ...REQUEST_DRAFT,
        target: new EstablishedMemoTarget(TARGET.providerSessionId),
      }),
    ).rejects.toBeInstanceOf(UnownedMemoTargetError);
    expect(target.sendAttempts).toBe(0);
    expect(target.readAttempts).toBe(0);
  });

  it("hands back one handle for a target established twice, and forgets no send", async () => {
    // Re-establishing an owned target is an ordinary retry, so it returns the same handle. It
    // must not reset the unconfirmed register, which would lose the guarantee the register holds.
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-late-then-fail";
    const coordinator = new MemoDeliveryCoordinator(target);

    const established: EstablishedMemoTarget = coordinator.establishTarget(TARGET);
    expect(coordinator.establishTarget(TARGET)).toBe(established);

    await coordinator.deliver({ ...REQUEST_DRAFT, target: established });
    expect(target.sendAttempts).toBe(1);

    const retry: MemoDeliverySettlement = await coordinator.deliver({
      ...REQUEST_DRAFT,
      target: coordinator.establishTarget(TARGET),
    });
    expect(retry.disposition).toBe("unconfirmed");
    expect(target.sendAttempts).toBe(1);
  });
});

describe("memo delivery — overlapping calls for one memo", () => {
  const OVERLAPPING_REQUEST: DeliveryDraft = requestFor(
    projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])]),
  );

  it("sends once when two calls for one memo overlap", async () => {
    // Both calls read the target before either send lands, so both find no marker and
    // reconciliation alone would send twice; a send cannot be taken back.
    const target = new FakeTargetSession();
    const coordinator = new MemoDeliveryCoordinator(target);

    const [first, second]: readonly MemoDeliverySettlement[] = await Promise.all([
      deliverVia(coordinator, OVERLAPPING_REQUEST),
      deliverVia(coordinator, OVERLAPPING_REQUEST),
    ]);

    expect(target.turns).toHaveLength(1);
    expect(target.sendAttempts).toBe(1);
    expect(first?.disposition).toBe("delivered");
    expect(second).toBe(first);
  });

  it("negative control — two coordinators over one target do not share a delivery", async () => {
    // The exclusion is scoped to one coordinator. Two coordinators, two processes, or a
    // restart mid-flight fall back to the pre-send reconcile, which has this window.
    const target = new FakeTargetSession();

    await Promise.all([
      deliverVia(new MemoDeliveryCoordinator(target), OVERLAPPING_REQUEST),
      deliverVia(new MemoDeliveryCoordinator(target), OVERLAPPING_REQUEST),
    ]);

    expect(target.sendAttempts).toBe(2);
    expect(target.turns).toHaveLength(2);
  });

  it("reconciles afresh once the delivery it shared has settled", async () => {
    const target = new FakeTargetSession();
    const coordinator = new MemoDeliveryCoordinator(target);

    await Promise.all([
      deliverVia(coordinator, OVERLAPPING_REQUEST),
      deliverVia(coordinator, OVERLAPPING_REQUEST),
    ]);
    const readsBeforeRetry: number = target.readAttempts;

    const retry: MemoDeliverySettlement = await deliverVia(coordinator, OVERLAPPING_REQUEST);

    // A settled delivery is not reused: the retry reads the target again and finds the marker.
    expect(target.readAttempts).toBeGreaterThan(readsBeforeRetry);
    expect(retry.disposition).toBe("already-delivered");
    expect(target.sendAttempts).toBe(1);
  });

  it("does not let a withheld delivery stand in for the next one", async () => {
    // The first call settles withheld on an unreadable target. If its in-flight entry outlived
    // it, the second call would inherit that refusal and the memo would never be sent.
    const target = new FakeTargetSession();
    target.readOutcomes.push("fail");
    const coordinator = new MemoDeliveryCoordinator(target);

    const withheld: MemoDeliverySettlement = await deliverVia(coordinator, OVERLAPPING_REQUEST);
    expect(withheld.disposition).toBe("withheld");
    expect(withheld.withheldReason).toBe("target-unreadable");
    expect(target.sendAttempts).toBe(0);

    const retry: MemoDeliverySettlement = await deliverVia(coordinator, OVERLAPPING_REQUEST);

    expect(retry.disposition).toBe("delivered");
    expect(target.sendAttempts).toBe(1);
    expect(target.turns).toHaveLength(1);
  });
});

describe("memo delivery — once-only is per target, not per memo", () => {
  const FIRST_PROJECTION: CanonicalTranscriptProjection = projectionOf([
    turn(1, "user", [{ kind: "text", text: "hello" }]),
  ]);
  const GROWN_PROJECTION: CanonicalTranscriptProjection = projectionOf([
    turn(1, "user", [{ kind: "text", text: "hello" }]),
    turn(2, "assistant", [{ kind: "text", text: "hello to you" }]),
  ]);

  it("settles a grown projection already-delivered on a target seeded under an earlier one", async () => {
    const target = new FakeTargetSession();
    const coordinator = new MemoDeliveryCoordinator(target);

    const first: MemoDeliverySettlement = await deliverVia(
      coordinator,
      requestFor(FIRST_PROJECTION),
    );
    expect(first.disposition).toBe("delivered");

    const grown: MemoDeliverySettlement = await deliverVia(
      coordinator,
      requestFor(GROWN_PROJECTION),
    );

    // The keys differ; a read scoped to (target, memo) would miss the seeded target and send a
    // second summary.
    expect(grown.memoIdentityKey).not.toBe(first.memoIdentityKey);
    expect(grown.disposition).toBe("already-delivered");
    expect(target.sendAttempts).toBe(1);
    // The marker found belongs to another memo and cannot account for this projection's
    // omissions, so the losses are the conservative ceiling.
    expect(grown.declaredLossSource).toBe("unknown");
  });

  it("still settles a restarted coordinator already-delivered on its own memo's marker", async () => {
    // Admission always includes the current rendering's key, so a restarted coordinator still
    // recognizes a predecessor's delivery of this same memo; the attempted-key register only
    // widens that for grown projections.
    const target = new FakeTargetSession();
    const first: MemoDeliverySettlement = await deliverVia(
      new MemoDeliveryCoordinator(target),
      requestFor(FIRST_PROJECTION),
    );
    expect(first.disposition).toBe("delivered");

    const restarted: MemoDeliverySettlement = await deliverVia(
      new MemoDeliveryCoordinator(target),
      requestFor(FIRST_PROJECTION),
    );

    expect(restarted.disposition).toBe("already-delivered");
    expect(target.sendAttempts).toBe(1);
  });

  it("re-sends a grown projection after a restart onto a predecessor-seeded target", async () => {
    // Known cost of attributable-key admission: the attempted-key register lives in the
    // coordinator, so a restarted coordinator rendering a grown projection does not recognize
    // its predecessor's marker and sends one redundant summary. Settling on any well-formed
    // marker instead would let pasted text forge suppression of a memo never delivered, which
    // costs the user their continuity; a duplicate summary costs less.
    const target = new FakeTargetSession();
    const first: MemoDeliverySettlement = await deliverVia(
      new MemoDeliveryCoordinator(target),
      requestFor(FIRST_PROJECTION),
    );
    expect(first.disposition).toBe("delivered");

    const restarted: MemoDeliverySettlement = await deliverVia(
      new MemoDeliveryCoordinator(target),
      requestFor(GROWN_PROJECTION),
    );

    expect(restarted.disposition).toBe("delivered");
    expect(target.sendAttempts).toBe(2);
    expect(target.turns.filter((turnText) => turnText.includes("continuity-ref:"))).toHaveLength(2);
  });

  it("collapses overlapping deliveries of two different memos into one send", async () => {
    const target = new FakeTargetSession();
    const coordinator = new MemoDeliveryCoordinator(target);

    const [first, grown] = await Promise.all([
      deliverVia(coordinator, requestFor(FIRST_PROJECTION)),
      deliverVia(coordinator, requestFor(GROWN_PROJECTION)),
    ]);

    expect(first.disposition).toBe("delivered");
    expect(grown.disposition).toBe("already-delivered");
    expect(target.sendAttempts).toBe(1);
    expect(target.turns.filter((turnText) => turnText.includes("continuity-ref:"))).toHaveLength(1);
  });

  it("holds a grown projection unconfirmed while an earlier memo's send is still ambiguous", async () => {
    // The register is scoped to the target; scoped to (target, memo), the grown projection's new
    // key would miss the outstanding send and send beside a memo still landing.
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-late-then-fail";
    const coordinator = new MemoDeliveryCoordinator(target);

    const first: MemoDeliverySettlement = await deliverVia(
      coordinator,
      requestFor(FIRST_PROJECTION),
    );
    expect(first.disposition).toBe("unconfirmed");

    const grown: MemoDeliverySettlement = await deliverVia(
      coordinator,
      requestFor(GROWN_PROJECTION),
    );

    expect(grown.disposition).toBe("unconfirmed");
    expect(target.sendAttempts).toBe(1);
  });

  it("resolves that ambiguity with the marker the earlier memo actually left", async () => {
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-late-then-fail";
    const coordinator = new MemoDeliveryCoordinator(target);
    await deliverVia(coordinator, requestFor(FIRST_PROJECTION));

    const settled: MemoDeliverySettlement = await coordinator.deliver({
      ...addressedTo(coordinator, requestFor(GROWN_PROJECTION)),
      sendSettlementBarrier: settlementBarrierFor(target),
    });

    // The target holds the earlier memo, so the loss list is the conservative ceiling, not
    // this render's own.
    expect(settled.disposition).toBe("already-delivered");
    expect(settled.declaredLossSource).toBe("unknown");
    expect(target.sendAttempts).toBe(1);
    expect(target.turns.filter((turnText) => turnText.includes("continuity-ref:"))).toHaveLength(1);
  });
});

describe("memo delivery — an unreadable target", () => {
  it("sends nothing when the target cannot be read before the send", async () => {
    const target = new FakeTargetSession();
    target.readOutcomes.push("fail");
    const coordinator = new MemoDeliveryCoordinator(target);

    const settlement: MemoDeliverySettlement = await deliverVia(
      coordinator,
      requestFor(projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])])),
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

    const settlement: MemoDeliverySettlement = await deliverVia(
      coordinator,
      requestFor(projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])])),
    );

    // The ambiguity is reported, never resolved by sending again.
    expect(settlement.disposition).toBe("unconfirmed");
    expect(settlement.status).toBe("degraded");
    expect(target.sendAttempts).toBe(1);
  });

  it("settles withheld only on a later call, once the barrier orders the read behind the send", async () => {
    // A rejected send may still be applying, so a readback that finds nothing is not proof of
    // refusal. Only a second delivery, whose barrier is ordered behind a send that completed
    // before that call began, settles withheld; the call that made the send cannot.
    const target = new FakeTargetSession();
    target.sendBehavior = "refuse";
    const coordinator = new MemoDeliveryCoordinator(target);
    const request: DeliveryDraft = {
      ...requestFor(projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])])),
      sendSettlementBarrier: settlementBarrierFor(target),
    };

    const attempted: MemoDeliverySettlement = await deliverVia(coordinator, request);
    expect(attempted.disposition).toBe("unconfirmed");

    const settlement: MemoDeliverySettlement = await deliverVia(coordinator, request);

    expect(settlement.disposition).toBe("withheld");
    expect(settlement.withheldReason).toBe("send-refused");
    expect(target.turns).toHaveLength(0);
  });

  it("reports the ambiguity, not a refusal, when no barrier orders the readback", async () => {
    const target = new FakeTargetSession();
    target.sendBehavior = "refuse";
    const coordinator = new MemoDeliveryCoordinator(target);

    const settlement: MemoDeliverySettlement = await deliverVia(
      coordinator,
      requestFor(projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])])),
    );

    expect(settlement.disposition).toBe("unconfirmed");
    expect(settlement.withheldReason).toBeUndefined();
    expect(target.turns).toHaveLength(0);
  });
});

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
  readonly userTextBySequence: Map<number, string> = new Map<number, string>();

  readAssistantText(reference: TranscriptContentReference): string | undefined {
    return this.assistantTextBySequence.get(reference.sequence);
  }

  readUserText(reference: TranscriptContentReference): string | undefined {
    return this.userTextBySequence.get(reference.sequence);
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
  // The row carries no message: the emitter routes the user's words through the encrypted
  // envelope and the read path returns only the clear half, so the fold reads them from the
  // content port.
  fixture.log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "user" }));
  fixture.contentSource.userTextBySequence.set(1, "run the tests");
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

    // A restart keeps the durable rows and the content the port reads; carrying only the log
    // across would model a restart that lost half the conversation.
    const after = makeFoldFixture();
    for (const event of before.log.readEvents()) {
      after.log.append(event);
    }
    for (const [sequence, text] of before.contentSource.userTextBySequence) {
      after.contentSource.userTextBySequence.set(sequence, text);
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
    fixture.log.append(storedEvent(3, "user.message", { runId: OTHER_RUN_ID, actor: "user" }));
    fixture.contentSource.userTextBySequence.set(3, "unrelated");
    const after: CanonicalTranscriptProjection = fixture.fold.build({
      sessionId: SESSION_ID,
      runId: RUN_ID,
    });

    // The built position moved, which is why it is not part of the key.
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

    fixture.log.append(storedEvent(3, "user.message", { runId: RUN_ID, actor: "user" }));
    // Content is seeded so the key moves on new words, not on an unavailability marker.
    fixture.contentSource.userTextBySequence.set(3, "and now deploy");
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

  /**
   * One conversation whose tool result sits inside a reasoning block, varying in
   * exactly the member under test: how the fold resolved that enclosure.
   */
  function projectionEnclosing(
    enclosureDisclosure: "private" | "unknown" | undefined,
  ): CanonicalTranscriptProjection {
    return projectionOf([
      turn(1, "user", [{ kind: "text", text: "run the tests" }]),
      turn(2, "assistant", [
        { kind: "tool_call", toolCallId: "call-1", toolName: "bash", argumentsJson: "{}" },
        {
          kind: "tool_result",
          toolCallId: "call-1",
          outcome: "succeeded",
          provenance: "provider",
          text: "42 passed",
          enclosingReasoningBlockId: "block-1",
          ...(enclosureDisclosure === undefined ? {} : { enclosureDisclosure }),
        },
      ]),
    ]);
  }

  it("moves when a WITHHELD enclosure is later resolved portable, so the repair can be sent", () => {
    // A fold whose reasoning row was unreadable resolves the enclosure `unknown` and withholds
    // the result; a fold that can read the row carries the real body. Every other hashed field
    // is identical, so a key blind to this member would settle the corrected rendering as
    // already delivered and leave the target holding the diminished memo for good.
    const withheld: string = deriveMemoIdentityKey(projectionEnclosing("unknown"), TARGET);
    const corrected: string = deriveMemoIdentityKey(projectionEnclosing(undefined), TARGET);

    expect(withheld).not.toBe(corrected);
  });

  it("distinguishes the two withholding verdicts, which are different facts", () => {
    // `private` is a block that was read and is not portable; `unknown` is a block whose
    // disclosure could not be established. They withhold the same body for different reasons and
    // the memo discloses the reason, so collapsing them would let one rendering settle the other.
    expect(deriveMemoIdentityKey(projectionEnclosing("private"), TARGET)).not.toBe(
      deriveMemoIdentityKey(projectionEnclosing("unknown"), TARGET),
    );

    // All three verdicts are pairwise distinct; a key that never moved would pass every
    // equality assertion in the neighbouring tests.
    const keysByVerdict: Set<string> = new Set<string>([
      deriveMemoIdentityKey(projectionEnclosing("private"), TARGET),
      deriveMemoIdentityKey(projectionEnclosing("unknown"), TARGET),
      deriveMemoIdentityKey(projectionEnclosing(undefined), TARGET),
    ]);

    expect(keysByVerdict.size).toBe(3);
  });

  it("stays put when the enclosure verdict AGREES, so an unchanged fold re-sends nothing", () => {
    // Two folds that resolved the enclosure the same way are the same memo; a key that moved
    // anyway would send a second summary into a target that already holds one.
    expect(deriveMemoIdentityKey(projectionEnclosing("private"), TARGET)).toBe(
      deriveMemoIdentityKey(projectionEnclosing("private"), TARGET),
    );
    expect(deriveMemoIdentityKey(projectionEnclosing(undefined), TARGET)).toBe(
      deriveMemoIdentityKey(projectionEnclosing(undefined), TARGET),
    );
  });

  it("serializes fields unambiguously — text carrying a delimiter does not collide", () => {
    const left: CanonicalTranscriptProjection = projectionOf([
      turn(1, "user", [{ kind: "text", text: 'a"b' }]),
      turn(2, "user", [{ kind: "text", text: "c" }]),
    ]);
    const right: CanonicalTranscriptProjection = projectionOf([
      turn(1, "user", [{ kind: "text", text: "a" }]),
      turn(2, "user", [{ kind: "text", text: 'b"c' }]),
    ]);

    expect(deriveMemoIdentityKey(left, TARGET)).not.toBe(deriveMemoIdentityKey(right, TARGET));
  });
});

describe("memo delivery — nothing durable is written", () => {
  it("touches only the read and the send on the target, across all four delivery paths", async () => {
    const observedMemberNames: string[] = [];
    const request: DeliveryDraft = requestFor(
      projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])]),
    );

    // delivered
    const deliveredTarget = new FakeTargetSession();
    await deliverVia(
      new MemoDeliveryCoordinator(recordingGateway(deliveredTarget, observedMemberNames)),
      request,
    );
    // already-delivered
    const repeatSettlement: MemoDeliverySettlement = await deliverVia(
      new MemoDeliveryCoordinator(recordingGateway(deliveredTarget, observedMemberNames)),
      request,
    );
    expect(repeatSettlement.disposition).toBe("already-delivered");

    // withheld
    const withheldTarget = new FakeTargetSession();
    withheldTarget.readOutcomes.push("fail");
    await deliverVia(
      new MemoDeliveryCoordinator(recordingGateway(withheldTarget, observedMemberNames)),
      request,
    );

    // unconfirmed
    const unconfirmedTarget = new FakeTargetSession();
    unconfirmedTarget.readOutcomes.push("ok", "fail");
    unconfirmedTarget.sendBehavior = "apply-then-fail";
    await deliverVia(
      new MemoDeliveryCoordinator(recordingGateway(unconfirmedTarget, observedMemberNames)),
      request,
    );

    expect([...new Set(observedMemberNames)].sort()).toEqual([
      "readTurnsForMarkerReconciliation",
      "sendMemoTurn",
    ]);
  });
});

describe("memo frame — the key is carried as visible characters", () => {
  it("renders the derived key into the frame the target receives", async () => {
    const sentFrames: MemoOutboundFrame[] = [];
    const gateway: MemoTargetGateway = {
      readTurnsForMarkerReconciliation: async (): Promise<readonly string[]> => [],
      sendMemoTurn: async (frame: MemoOutboundFrame): Promise<void> => {
        sentFrames.push(frame);
      },
    };
    const projection: CanonicalTranscriptProjection = generateTranscript(11).projection;

    const settlement: MemoDeliverySettlement = await deliverVia(
      new MemoDeliveryCoordinator(gateway),
      requestFor(projection),
    );

    const marker: string = renderMemoContinuityMarker(
      settlement.memoIdentityKey,
      settlement.declaredLosses,
    );
    const frame: MemoOutboundFrame | undefined = sentFrames[0];
    expect(frame).toBeDefined();
    // Asserted on the frame the target receives, not on the projection or the settlement.
    expect(frame?.frame.wireText).toContain(marker);
    expect(frame?.memoIdentityKey).toBe(settlement.memoIdentityKey);

    const markerIndex: number = (frame?.frame.wireText ?? "").indexOf(marker);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    // The whole marker, loss record included, is one whitespace-free run of printable ASCII so
    // that it survives a provider's reflow.
    expect(marker).toMatch(/^[\x21-\x7E]+$/);
  });

  it("reaches the gateway only through a composed frame, minted as system narration", async () => {
    const sentFrames: MemoOutboundFrame[] = [];
    const gateway: MemoTargetGateway = {
      readTurnsForMarkerReconciliation: async (): Promise<readonly string[]> => [],
      sendMemoTurn: async (frame: MemoOutboundFrame): Promise<void> => {
        sentFrames.push(frame);
      },
    };
    const projection: CanonicalTranscriptProjection = generateTranscript(13).projection;

    const settlement: MemoDeliverySettlement = await deliverVia(
      new MemoDeliveryCoordinator(gateway),
      requestFor(projection),
    );

    const frame: MemoOutboundFrame | undefined = sentFrames[0];
    // A memo is the daemon narrating a prior conversation, neither the user's text nor a
    // driver command.
    expect(frame?.frame.origin).toBe("system_narration");
    expect(frame?.frame.tripwireExempt).toBe(false);
    // Only the frame writer mints a frame, so the memo cannot bypass neutralization.
    expect(frame?.frame.mintedByWriter).toBe(true);
    // Neutralization is transport-only: the authored text equals the rendering byte for byte.
    expect(frame?.frame.authoredText).toBe(settlement.rendering.text);
    // The correlation id the tripwire joins a turn back on is present.
    expect((frame?.frame.correlationId ?? "").length).toBeGreaterThan(0);
  });

  it("uses no invisible or zero-width character anywhere in the frame", async () => {
    const sentFrames: MemoOutboundFrame[] = [];
    const gateway: MemoTargetGateway = {
      readTurnsForMarkerReconciliation: async (): Promise<readonly string[]> => [],
      sendMemoTurn: async (frame: MemoOutboundFrame): Promise<void> => {
        sentFrames.push(frame);
      },
    };

    await deliverVia(
      new MemoDeliveryCoordinator(gateway),
      requestFor(generateTranscript(12).projection),
    );

    const frameText: string = sentFrames[0]?.frame.wireText ?? "";
    expect(frameText.length).toBeGreaterThan(0);
    // Zero-width, word-joiner, BOM, variation-selector and Unicode tag characters must never
    // appear as sentinels. Scanned by code point because a character class holding them is
    // misleading to read.
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
    expect(MEMO_CONTINUITY_MARKER_PREFIX).toMatch(/^[\x21-\x7E]+$/);
  });
});

describe("reconstitution routing — the memo is the caller's fallback", () => {
  it("emits no memo when native replay applied — the target is never touched", async () => {
    const observedMemberNames: string[] = [];
    const target = new FakeTargetSession();
    const coordinator = new MemoDeliveryCoordinator(recordingGateway(target, observedMemberNames));
    const router = new TranscriptReconstitutionRouter(coordinator);

    const settlement: ReconstitutionSettlement = await router.route(
      { outcome: "applied", declaredLosses: ["provider_private_reasoning"] },
      addressedTo(
        coordinator,
        requestFor(projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])])),
      ),
    );

    expect(settlement.route).toBe("native-replay");
    if (settlement.route !== "native-replay") {
      throw new Error("an applied replay is the native-replay route");
    }
    expect(settlement.result.status).toBe("applied");
    expect(observedMemberNames).toEqual([]);
    expect(target.sendAttempts).toBe(0);
    expect(target.readAttempts).toBe(0);
  });

  it("falls to the memo on every non-applied replay outcome", async () => {
    for (const outcome of ["unavailable", "refused", "context-window-exceeded"] as const) {
      const target = new FakeTargetSession();
      const coordinator = new MemoDeliveryCoordinator(target);
      const router = new TranscriptReconstitutionRouter(coordinator);

      const settlement: ReconstitutionSettlement = await router.route(
        { outcome },
        addressedTo(
          coordinator,
          requestFor(projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])])),
        ),
      );

      expect(settlement.route).toBe("memo");
      if (settlement.route !== "memo") {
        throw new Error("the non-applied outcomes route to the memo floor");
      }
      // The memo arm has no result member; the result is requested from the producer, which
      // answers here because this delivery landed.
      const result = memoSettlementAsReplayResult(settlement.memo);
      expect(result.status).toBe("degraded");
      expect(result.declaredLosses).toContain("conversation_history_summarized");
      expect(target.sendAttempts).toBe(1);
    }
  });

  it("refuses an applied disposition that also declares the summarization", async () => {
    // The router builds its result from a literal and never parses one, so the schema's arm
    // scoping does not apply; unguarded, it would publish native-replay continuity for a
    // session that holds a bounded prose summary.
    const target = new FakeTargetSession();
    const coordinator = new MemoDeliveryCoordinator(target);
    const router = new TranscriptReconstitutionRouter(coordinator);

    await expect(
      router.route(
        { outcome: "applied", declaredLosses: ["conversation_history_summarized"] },
        addressedTo(
          coordinator,
          requestFor(projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])])),
        ),
      ),
    ).rejects.toBeInstanceOf(ContradictoryReplayDispositionError);

    // Refused, not rerouted: sending a summary would resolve the caller's contradiction by
    // picking one of its two claims.
    expect(target.sendAttempts).toBe(0);
  });

  it("still routes an applied disposition carrying ordinary losses", async () => {
    // The guard keys on the one loss kind that names the memo floor, not on a non-empty list;
    // an applied replay that stripped private reasoning is the ordinary case and still routes.
    const target = new FakeTargetSession();
    const coordinator = new MemoDeliveryCoordinator(target);
    const router = new TranscriptReconstitutionRouter(coordinator);

    const settlement: ReconstitutionSettlement = await router.route(
      {
        outcome: "applied",
        declaredLosses: ["provider_private_reasoning", "tool_call_history_repaired"],
      },
      addressedTo(
        coordinator,
        requestFor(projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])])),
      ),
    );

    expect(settlement.route).toBe("native-replay");
    if (settlement.route !== "native-replay") {
      throw new Error("an applied replay is the native-replay route");
    }
    expect(settlement.result.declaredLosses).toEqual([
      "provider_private_reasoning",
      "tool_call_history_repaired",
    ]);
  });
});

async function collectMemoSettlements(): Promise<MemoDeliverySettlement[]> {
  const request: DeliveryDraft = requestFor(
    projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])]),
  );

  const deliveredTarget = new FakeTargetSession();
  const delivered: MemoDeliverySettlement = await deliverVia(
    new MemoDeliveryCoordinator(deliveredTarget),
    request,
  );
  const alreadyDelivered: MemoDeliverySettlement = await deliverVia(
    new MemoDeliveryCoordinator(deliveredTarget),
    request,
  );

  const withheldTarget = new FakeTargetSession();
  withheldTarget.readOutcomes.push("fail");
  const withheld: MemoDeliverySettlement = await deliverVia(
    new MemoDeliveryCoordinator(withheldTarget),
    request,
  );

  const unconfirmedTarget = new FakeTargetSession();
  unconfirmedTarget.readOutcomes.push("ok", "fail");
  unconfirmedTarget.sendBehavior = "apply-then-fail";
  const unconfirmed: MemoDeliverySettlement = await deliverVia(
    new MemoDeliveryCoordinator(unconfirmedTarget),
    request,
  );

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

    // An applied replay that itself declared a loss: an implementation that inferred degraded
    // from a non-empty loss list fails here. The applied arm reads the list only to choose
    // between claiming a full replay and naming what it omitted; the route never comes from it.
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
        renderReconstitutionDisclosure({ route: "memo", memo: settlement }),
      ),
    ];

    // Every rendering is distinct, applied and memo alike.
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

    // "In full" is reserved for a replay that dropped nothing; a replay that omitted something
    // names the omissions instead.
    expect(disclosure).not.toContain("in full");
    expect(disclosure).toContain("provider_private_reasoning");
    expect(disclosure).toContain("turn_content_unavailable");
    expect(disclosure).not.toContain("nothing was dropped");
    // It is still an applied replay, not a summary.
    expect(disclosure).toContain("replayed into the new session");
    expect(disclosure).not.toContain("summarized");
  });

  it("produces no replay result for a settlement that established no delivery", async () => {
    // `degraded` at the driver boundary means the memo floor stood in and the target holds a
    // summary. Stamping it for a settlement that established no delivery would report a
    // successful degraded switch into a session that may hold no prior context, and the result
    // type has no arm for that, so such a settlement throws.
    const [delivered, alreadyDelivered, withheld, unconfirmed] = await collectMemoSettlements();
    if (
      delivered === undefined ||
      alreadyDelivered === undefined ||
      withheld === undefined ||
      unconfirmed === undefined
    ) {
      throw new Error("every disposition is needed to state the split");
    }

    expect(memoSettlementAsReplayResult(delivered).status).toBe("degraded");
    expect(memoSettlementAsReplayResult(alreadyDelivered).status).toBe("degraded");

    for (const unestablished of [withheld, unconfirmed]) {
      expect(() => memoSettlementAsReplayResult(unestablished)).toThrow(
        MemoDeliveryNotEstablishedError,
      );
      // The error carries the settlement so a caller can tell the user what happened.
      try {
        memoSettlementAsReplayResult(unestablished);
        throw new Error("the unestablished arms must not produce a result");
      } catch (cause) {
        expect(cause).toBeInstanceOf(MemoDeliveryNotEstablishedError);
        if (!(cause instanceof MemoDeliveryNotEstablishedError)) {
          throw cause;
        }
        expect(cause.settlement).toBe(unestablished);
        expect(cause.message).toContain(unestablished.disposition);
      }
    }
    expect(withheld.withheldReason).toBe("target-unreadable");
  });

  it("still reports an unlanded memo to the user rather than erasing it", async () => {
    // Routing still settles with a memo disposition: the user must be told the summary did not
    // arrive, and a throw from the router would lose that disclosure.
    const target = new FakeTargetSession();
    target.readOutcomes.push("fail");
    const coordinator = new MemoDeliveryCoordinator(target);
    const router = new TranscriptReconstitutionRouter(coordinator);

    const settlement: ReconstitutionSettlement = await router.route(
      { outcome: "unavailable" },
      addressedTo(
        coordinator,
        requestFor(projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])])),
      ),
    );

    expect(settlement.route).toBe("memo");
    if (settlement.route !== "memo") {
      throw new Error("an unreadable target still routes to the memo floor");
    }
    expect(settlement.memo.disposition).toBe("withheld");
    expect(renderReconstitutionDisclosure(settlement)).toContain("did not reach the new session");
    // The memo arm carries no boundary result to be mistaken for one.
    expect(Object.hasOwn(settlement, "result")).toBe(false);
  });

  it("says plainly, on every memo path, that the conversation was summarized", async () => {
    for (const settlement of await collectMemoSettlements()) {
      const disclosure: string = renderReconstitutionDisclosure({
        route: "memo",
        memo: settlement,
      });
      expect(disclosure).toContain("summarized");
      expect(settlement.status).toBe("degraded");
    }
  });
});

describe("memo floor — a result whose enclosure cannot be resolved is withheld", () => {
  /**
   * A tool result citing a reasoning block the content port could not read. It uses its own
   * content source because the suite's answers the empty list for every reasoning row, which
   * means a row with no blocks, not one whose blocks could not be read.
   */
  function foldUnreadableEnclosure(): CanonicalTranscriptProjection {
    const log = new RecordedEventLog();
    log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "user" }));
    log.append(storedEvent(2, "assistant.thinking_update", { runId: RUN_ID }));
    log.append(
      storedEvent(3, "tool.invoked", {
        runId: RUN_ID,
        toolCallId: "call-1",
        toolName: "run_tests",
      }),
    );
    log.append(storedEvent(4, "tool.result", { runId: RUN_ID, toolCallId: "call-1" }));

    const contentSource: TranscriptContentSource = {
      readAssistantText: (): string | undefined => undefined,
      readUserText: (reference: TranscriptContentReference): string | undefined =>
        reference.sequence === 1 ? "run the tests" : undefined,
      // Undefined is the port's way of saying the blocks could not be read.
      readReasoningBlocks: (): readonly TranscriptReasoningBlock[] | undefined => undefined,
      readToolCallArguments: (): string | undefined => '{"suite":"unit"}',
      readToolResultBody: (): TranscriptToolResultBody | undefined => ({
        text: "42 passed",
        enclosingReasoningBlockId: "block-private-1",
      }),
    };

    return new CanonicalTranscriptFold({ eventReader: log, contentSource }).build({
      sessionId: SESSION_ID,
      runId: RUN_ID,
    });
  }

  it("keeps the body out of the summary the new session is handed", async () => {
    // The memo floor runs the same strip as the export, so the withholding applies here too: a
    // memo is prose the target model reads, and content that may be private reasoning's must not
    // appear in it.
    const projection: CanonicalTranscriptProjection = foldUnreadableEnclosure();

    const target = new FakeTargetSession();
    const settlement: MemoDeliverySettlement = await deliverVia(
      new MemoDeliveryCoordinator(target),
      requestFor(projection),
    );

    expect(settlement.disposition).toBe("delivered");
    expect(settlement.rendering.text).not.toContain("42 passed");
    expect(settlement.rendering.declaredLosses).toContain("turn_content_unavailable");
    // The call still renders, so the body is withheld but the exchange is not erased.
    expect(settlement.rendering.text).toContain("[tool call run_tests (call-1)]");
    expect(target.turns[0]).not.toContain("42 passed");
  });

  it("keeps a withheld private-enclosed legacy answer out of the summary and its key", () => {
    // The fold's stand-in for an unkeyed tool result whose reasoning block is private, beside a
    // real sibling so the turn survives the strip.
    const withMarker: CanonicalTranscriptProjection = projectionOf([
      turn(1, "user", [{ kind: "text", text: "run the tests" }]),
      turn(2, "assistant", [
        { kind: "text", text: "", withheldEnclosure: "private" },
        { kind: "text", text: "all green" },
      ]),
    ]);
    const withoutMarker: CanonicalTranscriptProjection = projectionOf([
      turn(1, "user", [{ kind: "text", text: "run the tests" }]),
      turn(2, "assistant", [{ kind: "text", text: "all green" }]),
    ]);

    const rendering: MemoRendering = new MemoProjection().render(requestFor(withMarker));

    // The marker is consumed before rendering, adds no prose, and declares the private-reasoning
    // loss.
    expect(rendering.text).toContain("all green");
    expect(rendering.text).not.toContain("withheldEnclosure");
    expect(rendering.declaredLosses).toContain("provider_private_reasoning");
    // The key hashes the raw projection, so the marker changes it. The worst case is one
    // redundant summary, which settles at the next re-render.
    expect(deriveMemoIdentityKey(withMarker, TARGET)).not.toBe(
      deriveMemoIdentityKey(withoutMarker, TARGET),
    );
  });

  it("negative control — the summary carries the body when the resolution is dropped", async () => {
    const built: CanonicalTranscriptProjection = foldUnreadableEnclosure();
    const unresolved: CanonicalTranscriptProjection = {
      ...built,
      turns: built.turns.map((foldedTurn) => ({
        ...foldedTurn,
        segments: foldedTurn.segments.map((segment) =>
          segment.kind === "tool_result" ? { ...segment, enclosureDisclosure: undefined } : segment,
        ),
      })),
    };

    const rendering: MemoRendering = new MemoProjection().render(requestFor(unresolved));

    expect(rendering.text).toContain("42 passed");
  });
});
