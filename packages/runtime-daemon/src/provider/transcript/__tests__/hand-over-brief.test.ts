// The hand-over brief: a kept tool call keeps its result under any budget, no private reasoning
// reaches the brief, and a delivery never places a second brief in a target, however its send ends.

import { describe, expect, it } from "vitest";

import { DECLARED_LOSS_KINDS } from "@ai-sidekicks/contracts";

import {
  DEFAULT_PROTECTED_TAIL_TOOL_EXCHANGE_COUNT,
  BRIEF_CONTINUITY_MARKER_PREFIX,
  BriefProjection,
  UnownedBriefTargetError,
  defaultBriefBudgetPolicy,
  deriveBriefIdentityKey,
  partitionIntoExchanges,
  renderBriefContinuityMarker,
  type BriefBudgetPolicy,
  type BriefRendering,
  type BriefTargetIdentity,
  type TranscriptExchange,
} from "../hand-over-brief.js";
import {
  BriefDeliveryCoordinator,
  type BriefDeliveryRequest,
  type BriefDeliverySettlement,
  type BriefOutboundFrame,
  type BriefSendSettlementBarrier,
  type BriefTargetGateway,
} from "../brief-delivery.js";
import {
  readAnyBriefContinuityMarkerOccurrences,
  targetTurnsCarryBriefMarker,
} from "../brief-marker-reader.js";
import {
  OTHER_RUN_ID,
  RUN_ID,
  SESSION_ID,
  makeFixture,
  storedEvent,
  type TranscriptFixture,
} from "./transcript-log-test-doubles.js";
import type {
  CanonicalTranscriptProjection,
  CanonicalTranscriptSegment,
  CanonicalTranscriptTurn,
} from "../../provider-driver.js";
import { OutboundTextFrame } from "../../outbound-frame.js";

const TARGET: BriefTargetIdentity = { providerSessionId: "provider-session-target-1" };
const OTHER_TARGET: BriefTargetIdentity = { providerSessionId: "provider-session-target-2" };

/** Wide enough that the whole fixture fits, so eviction is opt-in per case. */
const ROOMY_BUDGET: BriefBudgetPolicy = defaultBriefBudgetPolicy(1_000_000);

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
type DeliveryDraft = Omit<BriefDeliveryRequest, "target"> & {
  readonly target: BriefTargetIdentity;
};

function requestFor(
  projection: CanonicalTranscriptProjection,
  budget: BriefBudgetPolicy = ROOMY_BUDGET,
  target: BriefTargetIdentity = TARGET,
): DeliveryDraft {
  return { projection, target, budget };
}

/**
 * Establishes the draft's target on `coordinator`. Each call asserts the target is fresh and its
 * own; the establishment gate refuses an established handle carried to another coordinator.
 */
function addressedTo(
  coordinator: BriefDeliveryCoordinator,
  draft: DeliveryDraft,
): BriefDeliveryRequest {
  return { ...draft, target: coordinator.establishTarget(draft.target) };
}

async function deliverVia(
  coordinator: BriefDeliveryCoordinator,
  draft: DeliveryDraft,
): Promise<BriefDeliverySettlement> {
  return await coordinator.deliver(addressedTo(coordinator, draft));
}

/**
 * The target session, faked with the failure modes that matter. `readOutcomes` is consumed in
 * order, so a case can make the pre-send read succeed and the post-send readback fail.
 *
 * `apply-then-fail` lands the frame and loses the acknowledgment. `apply-late-then-fail` times out
 * while the provider is still applying the frame, so readbacks before `applyPendingSends` find no
 * marker for a brief about to land; a retry that trusts one of them sends a second brief.
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
  /** Blinds reconciliation, so only the coordinator's own register can prevent a duplicate. */
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

  async sendBriefTurn(frame: BriefOutboundFrame): Promise<void> {
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
function settlementBarrierFor(target: FakeTargetSession): BriefSendSettlementBarrier {
  return () => {
    target.applyPendingSends();
    return Promise.resolve();
  };
}

/**
 * A barrier that resolves without observing the provider. Nothing inside the delivery can tell it
 * from an honest wait, so the tests show the call that made a send never trusts it.
 */
const IMMEDIATE_BARRIER: BriefSendSettlementBarrier = () => Promise.resolve();

/** The caller's bounded wait ran out without the session going quiet. */
const EXPIRED_BARRIER: BriefSendSettlementBarrier = () =>
  Promise.reject(new Error("the bounded wait for the provider session expired"));

/**
 * Records every member name read off the gateway, so a test can show the target was never
 * touched.
 */
function recordingGateway(
  target: FakeTargetSession,
  observedMemberNames: string[],
): BriefTargetGateway {
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
  }) as unknown as BriefTargetGateway;
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

describe("brief budget — whole-exchange eviction with a protected tail", () => {
  it("never emits a call without its result nor a result without its call, under any budget", () => {
    const briefProjection = new BriefProjection();
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

      const unbounded: BriefRendering = briefProjection.render(
        requestFor(generated.projection, ROOMY_BUDGET),
      );
      expect(unbounded.evictedExchangeCount).toBe(0);

      // Spans both regimes: tight windows force eviction and the wide one does not, so guard (b)
      // below can tell them apart.
      for (const contextWindowTokens of [120, 240, 480, 960, 1920, 100_000]) {
        const rendering: BriefRendering = briefProjection.render(
          requestFor(generated.projection, defaultBriefBudgetPolicy(contextWindowTokens)),
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

  it("still evicts a conversation that used no tool at all", () => {
    // The protected tail is anchored on tool exchanges, so a transcript with none must not protect
    // itself entirely; that would leave the budget unenforceable on plain back-and-forth talk.
    const briefProjection = new BriefProjection();
    const turns: CanonicalTranscriptTurn[] = [];
    for (let index = 0; index < 12; index += 1) {
      turns.push(
        turn(index + 1, index % 2 === 0 ? "user" : "assistant", [
          { kind: "text", text: `plain exchange ${index.toString()} ${PADDING}` },
        ]),
      );
    }
    const projection: CanonicalTranscriptProjection = projectionOf(turns);

    const unbounded: BriefRendering = briefProjection.render(requestFor(projection, ROOMY_BUDGET));
    expect(unbounded.evictedExchangeCount).toBe(0);
    expect(unbounded.includedExchangeCount).toBe(12);

    const bounded: BriefRendering = briefProjection.render(
      requestFor(projection, defaultBriefBudgetPolicy(600)),
    );
    expect(bounded.evictedExchangeCount).toBeGreaterThan(0);
    expect(bounded.includedExchangeCount).toBeLessThan(12);
    // The newest exchange survives whatever the budget.
    expect(bounded.includedTurns.at(-1)).toEqual(unbounded.includedTurns.at(-1));
    expect(bounded.declaredLosses).toContain("context_truncated");

    const starved: BriefRendering = briefProjection.render(
      requestFor(projection, { ...defaultBriefBudgetPolicy(8), budgetFraction: 0 }),
    );
    expect(starved.includedExchangeCount).toBe(1);
    expect(starved.includedTurns.at(-1)).toEqual(unbounded.includedTurns.at(-1));
  });

  it("never emits a brief larger than the ceiling it reports fitting under", () => {
    // Assembly joins the preamble and every admitted exchange with a newline, so pricing each
    // exchange alone under-counts by one separator per admission, and the injected estimator does
    // not owe additivity. Near the ceiling that admits a set that assembles past the budget while
    // the render reports it fits. Only a sweep of every integer ceiling finds it; one fixed budget
    // would miss it.
    const briefProjection = new BriefProjection();
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

    const unbounded: BriefRendering = briefProjection.render(requestFor(projection, ROOMY_BUDGET));
    expect(unbounded.evictedExchangeCount).toBe(0);
    expect(unbounded.includedExchangeCount).toBe(12);

    let ceilingsTheProtectedFloorOverran = 0;
    let ceilingsThatFitAfterEviction = 0;

    for (
      let ceilingTokens = 1;
      ceilingTokens <= unbounded.estimatedTokens + 4;
      ceilingTokens += 1
    ) {
      const rendering: BriefRendering = briefProjection.render(
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
    // where eviction brought the brief back under one, which is where the separators are paid.
    expect(ceilingsTheProtectedFloorOverran).toBeGreaterThan(0);
    expect(ceilingsThatFitAfterEviction).toBeGreaterThan(0);
  });
});

// Portability transforms the floor reuses

describe("brief body — portability transforms", () => {
  it("drops private reasoning and declares it, while a visible summary survives as prose", () => {
    const briefProjection = new BriefProjection();

    const withPrivateReasoning: BriefRendering = briefProjection.render(
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

    const withSummary: BriefRendering = briefProjection.render(
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
    const briefProjection = new BriefProjection();
    const rendering: BriefRendering = briefProjection.render(
      requestFor(projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])])),
    );
    expect(rendering.declaredLosses).toContain("conversation_history_summarized");
  });

  it("declares an unreadable body and names it in the prose the model reads", () => {
    const briefProjection = new BriefProjection();
    const rendering: BriefRendering = briefProjection.render(
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
    // The settlement's declaration does not reach the brief's own text, so the gap is named there
    // too: an empty body renders to nothing, and a turn of nothing reads to the model as a turn
    // that never happened.
    expect(rendering.text).toContain("could not be recovered");
    // The turn is still present, with its speaker.
    expect(rendering.includedTurns).toHaveLength(3);
    expect(rendering.text).toContain("[tool call inspect (call-1)]");
  });

  it("declares nothing of the kind when every body resolved", () => {
    const briefProjection = new BriefProjection();
    const rendering: BriefRendering = briefProjection.render(
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

describe("brief delivery — once-only under a lost acknowledgment", () => {
  it("delivers exactly once when the send lands at the target and the acknowledgment is lost", async () => {
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-then-fail";
    const coordinator = new BriefDeliveryCoordinator(target);
    const request: DeliveryDraft = requestFor(
      projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])]),
    );

    const first: BriefDeliverySettlement = await deliverVia(coordinator, request);
    // Resolved by reading the target, not by trusting the rejection.
    expect(first.disposition).toBe("delivered");

    // The caller retries, as a caller with no acknowledgment must.
    const second: BriefDeliverySettlement = await deliverVia(coordinator, request);
    expect(second.disposition).toBe("already-delivered");
    expect(second.briefIdentityKey).toBe(first.briefIdentityKey);

    // What the target holds is the load-bearing assertion, not the disposition.
    expect(target.turns).toHaveLength(1);
    expect(target.sendAttempts).toBe(1);
  });

  it("finds a brief delivered far back in the conversation and sends no second one", async () => {
    // The brief scrolls far back under a long conversation, and the caller retries after a restart
    // with no register to consult.
    const target = new FakeTargetSession();
    const request: DeliveryDraft = requestFor(
      projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])]),
    );

    const first: BriefDeliverySettlement = await deliverVia(
      new BriefDeliveryCoordinator(target),
      request,
    );
    expect(first.disposition).toBe("delivered");
    for (let turnIndex = 0; turnIndex < 200; turnIndex += 1) {
      target.turns.push(`ordinary turn ${turnIndex.toString()}`);
    }

    // A fresh coordinator, so nothing but the read decides this.
    const retry: BriefDeliverySettlement = await deliverVia(
      new BriefDeliveryCoordinator(target),
      request,
    );

    expect(retry.disposition).toBe("already-delivered");
    expect(retry.briefIdentityKey).toBe(first.briefIdentityKey);
    expect(target.sendAttempts).toBe(1);
    expect(target.turns.filter((turnText) => turnText.includes("continuity-ref:"))).toHaveLength(1);
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

describe("brief reconciliation — reading the continuity marker back", () => {
  it("reports what the delivered summary dropped, not what a later render would", async () => {
    // The delivered summary was rendered under a tight budget and left older exchanges out. A later
    // delivery under a roomier budget finds it and sends nothing, and must report the delivered
    // summary's losses rather than the fresh render's.
    const target = new FakeTargetSession();
    const projection: CanonicalTranscriptProjection = plainConversation();

    const delivered: BriefDeliverySettlement = await deliverVia(
      new BriefDeliveryCoordinator(target),
      requestFor(projection, defaultBriefBudgetPolicy(600)),
    );
    expect(delivered.disposition).toBe("delivered");
    expect(delivered.declaredLosses).toContain("context_truncated");

    // A fresh coordinator under a budget wide enough to drop nothing, so only the read decides
    // what is reported.
    const retry: BriefDeliverySettlement = await deliverVia(
      new BriefDeliveryCoordinator(target),
      requestFor(projection, ROOMY_BUDGET),
    );

    expect(retry.disposition).toBe("already-delivered");
    expect(retry.rendering.declaredLosses).not.toContain("context_truncated");
    expect(retry.declaredLossSource).toBe("delivered-brief");
    expect(retry.declaredLosses).toStrictEqual(delivered.declaredLosses);
    expect(target.sendAttempts).toBe(1);
  });

  it("declares an upper bound when the delivered summary recorded no losses of its own", async () => {
    // A key-only marker records nothing about what its summary dropped, so the report is the whole
    // loss vocabulary, stated as a bound rather than an account.
    const target = new FakeTargetSession();
    const projection: CanonicalTranscriptProjection = plainConversation();
    const request: DeliveryDraft = requestFor(projection, ROOMY_BUDGET);
    target.turns.push(
      `an older summary ${BRIEF_CONTINUITY_MARKER_PREFIX}${deriveBriefIdentityKey(projection, TARGET)}`,
    );

    const settlement: BriefDeliverySettlement = await deliverVia(
      new BriefDeliveryCoordinator(target),
      request,
    );

    expect(settlement.disposition).toBe("already-delivered");
    expect(settlement.declaredLossSource).toBe("unknown");
    expect(settlement.declaredLosses).toStrictEqual(DECLARED_LOSS_KINDS);
    expect(target.sendAttempts).toBe(0);
  });

  it("reads a continuity record strictly, over the whole loss vocabulary of the wire", async () => {
    // A record that lists nothing must not read as a brief that dropped nothing. This floor
    // declares its summarization on every path, so a record that omits it was not written by this
    // writer and its omissions cannot be accounted for.
    const projection: CanonicalTranscriptProjection = plainConversation();
    const briefIdentityKey: string = deriveBriefIdentityKey(projection, TARGET);
    const marker: string = `${BRIEF_CONTINUITY_MARKER_PREFIX}${briefIdentityKey}`;
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
      // Fail closed on a token outside the vocabulary: it could name any loss.
      `${marker};dropped=context_truncated+a_kind_from_later`,
    ];

    for (const turnText of unreadable) {
      expect(readAnyBriefContinuityMarkerOccurrences([turnText])).toStrictEqual([
        { form: "unreadable-record", briefIdentityKey },
      ]);
    }

    // The floor's own single-kind record still reads: the strictness is about records this writer
    // cannot produce, not short ones.
    expect(
      readAnyBriefContinuityMarkerOccurrences([
        `${marker};dropped=conversation_history_summarized`,
      ]),
    ).toStrictEqual([
      {
        form: "recorded",
        briefIdentityKey,
        kinds: new Set(["conversation_history_summarized"]),
      },
    ]);
    expect(
      readAnyBriefContinuityMarkerOccurrences([
        `carried in prose: ${renderBriefContinuityMarker(briefIdentityKey, [
          "context_truncated",
          "conversation_history_summarized",
        ])} and the summary follows.`,
      ]),
    ).toStrictEqual([
      {
        form: "recorded",
        briefIdentityKey,
        kinds: new Set(["context_truncated", "conversation_history_summarized"]),
      },
    ]);

    // The vocabulary is the wire's, not this build's: a peer daemon on a newer build may record a
    // kind this build never emits, and reading it as unrecognized would report a brief that dropped
    // everything.
    expect(
      readAnyBriefContinuityMarkerOccurrences([
        renderBriefContinuityMarker(briefIdentityKey, [
          "conversation_history_summarized",
          "turn_content_truncated",
        ]),
      ]),
    ).toStrictEqual([
      {
        form: "recorded",
        briefIdentityKey,
        kinds: new Set(["conversation_history_summarized", "turn_content_truncated"]),
      },
    ]);

    // Per occurrence: one readable record does not vouch for the brief beside it, since a target
    // with two markers under one key holds two summaries.
    const target = new FakeTargetSession();
    target.turns.push(
      renderBriefContinuityMarker(briefIdentityKey, [
        "context_truncated",
        "conversation_history_summarized",
      ]),
      `${marker};dropped=`,
    );
    const settlement: BriefDeliverySettlement = await deliverVia(
      new BriefDeliveryCoordinator(target),
      requestFor(projection, ROOMY_BUDGET),
    );
    expect(settlement.disposition).toBe("already-delivered");
    expect(settlement.declaredLossSource).toBe("unknown");
    expect(settlement.declaredLosses).toStrictEqual(DECLARED_LOSS_KINDS);
  });

  it("admits delivery only on a syntactically COMPLETE marker occurrence", () => {
    // Admission decides whether to skip the only context transfer there is, so a false yes leaves
    // the target with nothing while the caller reports success. A substring test says yes to any
    // text the key sits inside; the two boundaries make an occurrence this marker and not something
    // longer that contains it.
    const projection: CanonicalTranscriptProjection = plainConversation();
    const briefIdentityKey: string = deriveBriefIdentityKey(projection, TARGET);
    const marker: string = `${BRIEF_CONTINUITY_MARKER_PREFIX}${briefIdentityKey}`;

    const notThisMarker: readonly string[] = [
      // The key runs on into more token characters: a different key that begins with this one.
      `${marker}0`,
      `${marker}-second`,
      `${marker}_b`,
      // The token opened mid-word: `continuity-ref:` is ordinary lowercase text, so a longer word
      // ending in it would open a marker never written.
      `x${marker}`,
      `discontinuity-ref:${briefIdentityKey}`,
    ];
    for (const turnText of notThisMarker) {
      expect(targetTurnsCarryBriefMarker([turnText], briefIdentityKey)).toBe(false);
      // The record reader answers the same, because one grammar serves both.
      expect(readAnyBriefContinuityMarkerOccurrences([turnText])).toStrictEqual([]);
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
      expect(targetTurnsCarryBriefMarker([turnText], briefIdentityKey)).toBe(true);
    }
  });

  it("sends the brief past a pasted foreign marker rather than settling on it", async () => {
    // Marker text is plain prose, so a user can paste another conversation's complete marker into
    // the target. Matching any well-shaped key would read that as a delivery and settle
    // already-delivered over a target holding no brief. A key this coordinator never attempted
    // settles nothing.
    const target = new FakeTargetSession();
    const foreignBriefIdentityKey: string = "ab".repeat(16);
    target.turns.push(
      `the other session said: ${BRIEF_CONTINUITY_MARKER_PREFIX}${foreignBriefIdentityKey};dropped=conversation_history_summarized`,
      `and bare: ${BRIEF_CONTINUITY_MARKER_PREFIX}${"cd".repeat(16)}`,
    );

    const settlement: BriefDeliverySettlement = await deliverVia(
      new BriefDeliveryCoordinator(target),
      requestFor(plainConversation(), ROOMY_BUDGET),
    );

    expect(settlement.disposition).toBe("delivered");
    expect(target.sendAttempts).toBe(1);
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

    const settlement: BriefDeliverySettlement = await deliverVia(
      new BriefDeliveryCoordinator(target),
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
});

/**
 * A send whose acknowledgment is lost may still be landing at the provider, so a readback
 * taken at once finds no marker yet. Settling that one snapshot as a refusal would let a
 * retry send a second brief into a conversation that is already receiving the first.
 */
describe("brief delivery — an ambiguous send is held unconfirmed", () => {
  const AMBIGUOUS_REQUEST: DeliveryDraft = requestFor(
    projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])]),
  );

  it("does not let a retry race a slow-applying send into a second brief", async () => {
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-late-then-fail";
    const coordinator = new BriefDeliveryCoordinator(target);

    const first: BriefDeliverySettlement = await deliverVia(coordinator, AMBIGUOUS_REQUEST);

    // The provider has not finished applying, so the readback found nothing; that is not a refusal.
    expect(first.disposition).toBe("unconfirmed");
    expect(first.withheldReason).toBeUndefined();
    expect(target.sendAttempts).toBe(1);
    expect(target.turns).toHaveLength(0);

    // The retry's read finds nothing for the same reason.
    const retry: BriefDeliverySettlement = await deliverVia(coordinator, AMBIGUOUS_REQUEST);

    expect(retry.disposition).toBe("unconfirmed");
    expect(target.sendAttempts).toBe(1);

    target.applyPendingSends();
    expect(target.turns).toHaveLength(1);

    const afterLanding: BriefDeliverySettlement = await deliverVia(coordinator, AMBIGUOUS_REQUEST);

    // The target holds one brief from one send across three delivery calls.
    expect(afterLanding.disposition).toBe("already-delivered");
    expect(target.sendAttempts).toBe(1);
    expect(target.turns).toHaveLength(1);
  });

  it("does not double-send when a barrier is supplied and the first send lands late", async () => {
    // The call that made the ambiguous send never consults the barrier, so a barrier that
    // resolves at once cannot talk that call into a refusal.
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-late-then-fail";
    const coordinator = new BriefDeliveryCoordinator(target);
    const requestWithBarrier: DeliveryDraft = {
      ...AMBIGUOUS_REQUEST,
      sendSettlementBarrier: IMMEDIATE_BARRIER,
    };

    const first: BriefDeliverySettlement = await deliverVia(coordinator, requestWithBarrier);
    expect(first.disposition).toBe("unconfirmed");
    expect(target.sendAttempts).toBe(1);

    await deliverVia(coordinator, requestWithBarrier);
    target.applyPendingSends();

    expect(target.sendAttempts).toBe(1);
    expect(target.turns).toHaveLength(1);
  });

  it("converges on the late-landing brief when the barrier really waits for it", async () => {
    // A barrier that waits for the session to go quiet lets the first send finish, so the
    // retry's read finds the brief and settles as already delivered.
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-late-then-fail";
    const coordinator = new BriefDeliveryCoordinator(target);
    const requestWithBarrier: DeliveryDraft = {
      ...AMBIGUOUS_REQUEST,
      sendSettlementBarrier: settlementBarrierFor(target),
    };

    const first: BriefDeliverySettlement = await deliverVia(coordinator, requestWithBarrier);
    const retry: BriefDeliverySettlement = await deliverVia(coordinator, requestWithBarrier);
    const third: BriefDeliverySettlement = await deliverVia(coordinator, requestWithBarrier);

    expect(first.disposition).toBe("unconfirmed");
    expect(retry.disposition).toBe("already-delivered");
    expect(third.disposition).toBe("already-delivered");
    expect(target.sendAttempts).toBe(1);
    expect(target.turns).toHaveLength(1);
  });

  it("sends again once the caller's barrier establishes the earlier send never landed", async () => {
    // Holding the brief back forever would leave the user without a summary. Closing the old
    // ambiguity and attempting a new send are two calls: the barrier closes the first send,
    // and the ordinary reconcile that follows opens the second.
    const target = new FakeTargetSession();
    target.sendBehavior = "refuse";
    const coordinator = new BriefDeliveryCoordinator(target);
    const requestWithBarrier: DeliveryDraft = {
      ...AMBIGUOUS_REQUEST,
      sendSettlementBarrier: settlementBarrierFor(target),
    };

    const first: BriefDeliverySettlement = await deliverVia(coordinator, requestWithBarrier);
    expect(first.disposition).toBe("unconfirmed");
    expect(target.sendAttempts).toBe(1);

    const resolved: BriefDeliverySettlement = await deliverVia(coordinator, requestWithBarrier);
    expect(resolved.disposition).toBe("withheld");
    expect(resolved.withheldReason).toBe("send-refused");
    expect(target.sendAttempts).toBe(1);

    target.sendBehavior = "accept";
    const resent: BriefDeliverySettlement = await deliverVia(coordinator, requestWithBarrier);

    expect(resent.disposition).toBe("delivered");
    expect(target.sendAttempts).toBe(2);
    expect(target.turns).toHaveLength(1);
  });

  it("sends nothing when the caller's barrier expires instead of settling", async () => {
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-late-then-fail";
    const coordinator = new BriefDeliveryCoordinator(target);

    await deliverVia(coordinator, AMBIGUOUS_REQUEST);
    const retry: BriefDeliverySettlement = await deliverVia(coordinator, {
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
    const coordinator = new BriefDeliveryCoordinator(target);

    await deliverVia(coordinator, AMBIGUOUS_REQUEST);
    target.readOutcomes.push("fail");
    const retry: BriefDeliverySettlement = await deliverVia(coordinator, AMBIGUOUS_REQUEST);

    // Withheld would assert that nothing landed; an unreadable target establishes no such thing.
    expect(retry.disposition).toBe("unconfirmed");
    expect(retry.withheldReason).toBeUndefined();
    expect(target.sendAttempts).toBe(1);
  });

  it("does not duplicate even when the readback is blind, within one coordinator", async () => {
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-then-fail";
    target.reportNoTurns = true;
    const coordinator = new BriefDeliveryCoordinator(target);

    await deliverVia(coordinator, AMBIGUOUS_REQUEST);
    await deliverVia(coordinator, AMBIGUOUS_REQUEST);

    // The brief landed and the blind read cannot see it, yet no second send is attempted: an
    // unacknowledged send is remembered, not re-derived from a read that may be wrong.
    expect(target.sendAttempts).toBe(1);
    expect(target.turns).toHaveLength(1);
  });
});

describe("brief delivery — only the coordinator that established a target sends into it", () => {
  const REQUEST_DRAFT: DeliveryDraft = requestFor(
    projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])]),
  );

  it("refuses to send into a target another coordinator established", async () => {
    // A restart: the coordinator that made the ambiguous send and its register are gone, and
    // the successor inherits only the request, established target included. It knows nothing
    // about the send still applying, so it is refused before it can read an absence and act.
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-late-then-fail";
    const original = new BriefDeliveryCoordinator(target);
    const request: BriefDeliveryRequest = addressedTo(original, REQUEST_DRAFT);

    const first: BriefDeliverySettlement = await original.deliver(request);
    expect(first.disposition).toBe("unconfirmed");
    expect(target.sendAttempts).toBe(1);

    const readsBeforeTheSuccessor: number = target.readAttempts;
    const successor = new BriefDeliveryCoordinator(target);
    await expect(successor.deliver(request)).rejects.toBeInstanceOf(UnownedBriefTargetError);

    // The refusal comes before the read as well as before the send.
    expect(target.readAttempts).toBe(readsBeforeTheSuccessor);
    expect(target.sendAttempts).toBe(1);
    target.applyPendingSends();
    expect(target.turns).toHaveLength(1);
  });

  it("forgets a released target: its handle is refused and its unconfirmed send is dropped", async () => {
    // A long-running daemon must not keep every ended session's registers; the release at
    // session end is what bounds them.
    const target = new FakeTargetSession();
    target.sendBehavior = "refuse";
    const coordinator = new BriefDeliveryCoordinator(target);
    const request: BriefDeliveryRequest = addressedTo(coordinator, REQUEST_DRAFT);

    const ambiguous: BriefDeliverySettlement = await coordinator.deliver(request);
    expect(ambiguous.disposition).toBe("unconfirmed");

    coordinator.releaseTarget(TARGET.providerSessionId);

    await expect(coordinator.deliver(request)).rejects.toBeInstanceOf(UnownedBriefTargetError);

    // Established again, the target carries no unconfirmed entry, so nothing holds the send back.
    target.sendBehavior = "accept";
    const fresh: BriefDeliverySettlement = await deliverVia(coordinator, REQUEST_DRAFT);
    expect(fresh.disposition).toBe("delivered");
    expect(target.sendAttempts).toBe(2);
  });
});

describe("brief delivery — overlapping calls for one brief", () => {
  const OVERLAPPING_REQUEST: DeliveryDraft = requestFor(
    projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])]),
  );

  it("sends once when two calls for one brief overlap", async () => {
    // Both calls read the target before either send lands, so both find no marker and
    // reconciliation alone would send twice; a send cannot be taken back.
    const target = new FakeTargetSession();
    const coordinator = new BriefDeliveryCoordinator(target);

    const [first, second]: readonly BriefDeliverySettlement[] = await Promise.all([
      deliverVia(coordinator, OVERLAPPING_REQUEST),
      deliverVia(coordinator, OVERLAPPING_REQUEST),
    ]);

    expect(target.turns).toHaveLength(1);
    expect(target.sendAttempts).toBe(1);
    expect(first?.disposition).toBe("delivered");
    expect(second).toBe(first);
  });

  it("does not let a withheld delivery stand in for the next one", async () => {
    // The first call settles withheld on an unreadable target. If its in-flight entry outlived
    // it, the second call would inherit that refusal and the brief would never be sent.
    const target = new FakeTargetSession();
    target.readOutcomes.push("fail");
    const coordinator = new BriefDeliveryCoordinator(target);

    const withheld: BriefDeliverySettlement = await deliverVia(coordinator, OVERLAPPING_REQUEST);
    expect(withheld.disposition).toBe("withheld");
    expect(withheld.withheldReason).toBe("target-unreadable");
    expect(target.sendAttempts).toBe(0);

    const retry: BriefDeliverySettlement = await deliverVia(coordinator, OVERLAPPING_REQUEST);

    expect(retry.disposition).toBe("delivered");
    expect(target.sendAttempts).toBe(1);
    expect(target.turns).toHaveLength(1);
  });
});

describe("brief delivery — once-only is per target, not per brief", () => {
  const FIRST_PROJECTION: CanonicalTranscriptProjection = projectionOf([
    turn(1, "user", [{ kind: "text", text: "hello" }]),
  ]);
  const GROWN_PROJECTION: CanonicalTranscriptProjection = projectionOf([
    turn(1, "user", [{ kind: "text", text: "hello" }]),
    turn(2, "assistant", [{ kind: "text", text: "hello to you" }]),
  ]);

  it("settles a grown projection already-delivered on a target seeded under an earlier one", async () => {
    const target = new FakeTargetSession();
    const coordinator = new BriefDeliveryCoordinator(target);

    const first: BriefDeliverySettlement = await deliverVia(
      coordinator,
      requestFor(FIRST_PROJECTION),
    );
    expect(first.disposition).toBe("delivered");

    const grown: BriefDeliverySettlement = await deliverVia(
      coordinator,
      requestFor(GROWN_PROJECTION),
    );

    // The keys differ; a read scoped to (target, brief) would miss the seeded target and send a
    // second summary.
    expect(grown.briefIdentityKey).not.toBe(first.briefIdentityKey);
    expect(grown.disposition).toBe("already-delivered");
    expect(target.sendAttempts).toBe(1);
    // The marker found belongs to another brief and cannot account for this projection's
    // omissions, so the losses are the conservative ceiling.
    expect(grown.declaredLossSource).toBe("unknown");
  });

  it("collapses overlapping deliveries of two different briefs into one send", async () => {
    const target = new FakeTargetSession();
    const coordinator = new BriefDeliveryCoordinator(target);

    const [first, grown] = await Promise.all([
      deliverVia(coordinator, requestFor(FIRST_PROJECTION)),
      deliverVia(coordinator, requestFor(GROWN_PROJECTION)),
    ]);

    expect(first.disposition).toBe("delivered");
    expect(grown.disposition).toBe("already-delivered");
    expect(target.sendAttempts).toBe(1);
    expect(target.turns.filter((turnText) => turnText.includes("continuity-ref:"))).toHaveLength(1);
  });

  it("holds a grown projection unconfirmed while an earlier brief's send is still ambiguous", async () => {
    // The register is scoped to the target; scoped to (target, brief), the grown projection's new
    // key would miss the outstanding send and send beside a brief still landing.
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-late-then-fail";
    const coordinator = new BriefDeliveryCoordinator(target);

    const first: BriefDeliverySettlement = await deliverVia(
      coordinator,
      requestFor(FIRST_PROJECTION),
    );
    expect(first.disposition).toBe("unconfirmed");

    const grown: BriefDeliverySettlement = await deliverVia(
      coordinator,
      requestFor(GROWN_PROJECTION),
    );

    expect(grown.disposition).toBe("unconfirmed");
    expect(target.sendAttempts).toBe(1);
  });
});

describe("brief delivery — an unreadable target", () => {
  it("sends nothing when the target cannot be read before the send", async () => {
    const target = new FakeTargetSession();
    target.readOutcomes.push("fail");
    const coordinator = new BriefDeliveryCoordinator(target);

    const settlement: BriefDeliverySettlement = await deliverVia(
      coordinator,
      requestFor(projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])])),
    );

    expect(settlement.disposition).toBe("withheld");
    expect(settlement.withheldReason).toBe("target-unreadable");
    expect((settlement.cause as Error).message).toBe("target session could not be read");
    expect(target.sendAttempts).toBe(0);
    expect(target.turns).toHaveLength(0);
  });

  it("sends nothing further when the target cannot be read after an ambiguous send", async () => {
    const target = new FakeTargetSession();
    target.readOutcomes.push("ok", "fail");
    target.sendBehavior = "apply-then-fail";
    const coordinator = new BriefDeliveryCoordinator(target);

    const settlement: BriefDeliverySettlement = await deliverVia(
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
    const coordinator = new BriefDeliveryCoordinator(target);
    const request: DeliveryDraft = {
      ...requestFor(projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])])),
      sendSettlementBarrier: settlementBarrierFor(target),
    };

    const attempted: BriefDeliverySettlement = await deliverVia(coordinator, request);
    expect(attempted.disposition).toBe("unconfirmed");

    const settlement: BriefDeliverySettlement = await deliverVia(coordinator, request);

    expect(settlement.disposition).toBe("withheld");
    expect(settlement.withheldReason).toBe("send-refused");
    expect(target.turns).toHaveLength(0);
  });

  it("reports the ambiguity, not a refusal, when no barrier orders the readback", async () => {
    const target = new FakeTargetSession();
    target.sendBehavior = "refuse";
    const coordinator = new BriefDeliveryCoordinator(target);

    const settlement: BriefDeliverySettlement = await deliverVia(
      coordinator,
      requestFor(projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])])),
    );

    expect(settlement.disposition).toBe("unconfirmed");
    expect(settlement.withheldReason).toBeUndefined();
    expect(target.turns).toHaveLength(0);
  });
});

function seedConversation(fixture: TranscriptFixture): void {
  // The row carries no message: the emitter routes the user's words through the encrypted
  // envelope and the read path returns only the clear half, so the fold reads them from the
  // content port.
  fixture.log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "user" }));
  fixture.contentSource.userTextBySequence.set(1, "run the tests");
  fixture.log.append(storedEvent(2, "assistant.message", { runId: RUN_ID }));
}

describe("brief identity key — derived, never stored", () => {
  it("two independently built folds over one log derive the same key", () => {
    const first = makeFixture();
    seedConversation(first);
    const second = makeFixture();
    seedConversation(second);

    const firstKey: string = deriveBriefIdentityKey(
      first.fold.build({ sessionId: SESSION_ID, runId: RUN_ID }),
      TARGET,
    );
    const secondKey: string = deriveBriefIdentityKey(
      second.fold.build({ sessionId: SESSION_ID, runId: RUN_ID }),
      TARGET,
    );

    expect(firstKey).toBe(secondKey);
    expect(firstKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it("survives a restart — a fold rebuilt from the same durable rows derives the same key", () => {
    const before = makeFixture();
    seedConversation(before);
    const keyBeforeRestart: string = deriveBriefIdentityKey(
      before.fold.build({ sessionId: SESSION_ID, runId: RUN_ID }),
      TARGET,
    );

    // A restart keeps the durable rows and the content the port reads; carrying only the log
    // across would model a restart that lost half the conversation.
    const after = makeFixture();
    for (const event of before.log.readEvents()) {
      after.log.append(event);
    }
    for (const [sequence, text] of before.contentSource.userTextBySequence) {
      after.contentSource.userTextBySequence.set(sequence, text);
    }
    for (const [sequence, text] of before.contentSource.assistantTextBySequence) {
      after.contentSource.assistantTextBySequence.set(sequence, text);
    }
    const keyAfterRestart: string = deriveBriefIdentityKey(
      after.fold.build({ sessionId: SESSION_ID, runId: RUN_ID }),
      TARGET,
    );

    expect(keyAfterRestart).toBe(keyBeforeRestart);
  });

  it("does not move when an append in ANOTHER run moves the projection's built position", () => {
    const fixture = makeFixture();
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
    expect(deriveBriefIdentityKey(after, TARGET)).toBe(deriveBriefIdentityKey(before, TARGET));
  });

  it("moves when an appended event changes the transcript's own content", () => {
    const fixture = makeFixture();
    seedConversation(fixture);
    const before: string = deriveBriefIdentityKey(
      fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID }),
      TARGET,
    );

    fixture.log.append(storedEvent(3, "user.message", { runId: RUN_ID, actor: "user" }));
    // Content is seeded so the key moves on new words, not on an unavailability marker.
    fixture.contentSource.userTextBySequence.set(3, "and now deploy");
    const after: string = deriveBriefIdentityKey(
      fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID }),
      TARGET,
    );

    expect(after).not.toBe(before);
  });

  it("distinguishes targets, and is unaffected by the budget that shapes the body", () => {
    const projection: CanonicalTranscriptProjection = generateTranscript(3).projection;
    const briefProjection = new BriefProjection();

    expect(deriveBriefIdentityKey(projection, TARGET)).not.toBe(
      deriveBriefIdentityKey(projection, OTHER_TARGET),
    );

    const roomy: BriefRendering = briefProjection.render(requestFor(projection, ROOMY_BUDGET));
    const tight: BriefRendering = briefProjection.render(
      requestFor(projection, defaultBriefBudgetPolicy(160)),
    );
    expect(tight.evictedExchangeCount).toBeGreaterThan(0);
    expect(tight.briefIdentityKey).toBe(roomy.briefIdentityKey);
    expect(roomy.briefIdentityKey).toBe(deriveBriefIdentityKey(projection, TARGET));
  });
});

describe("brief delivery — nothing durable is written", () => {
  it("touches only the read and the send on the target, across all four delivery paths", async () => {
    const observedMemberNames: string[] = [];
    const request: DeliveryDraft = requestFor(
      projectionOf([turn(1, "user", [{ kind: "text", text: "hello" }])]),
    );

    // delivered
    const deliveredTarget = new FakeTargetSession();
    await deliverVia(
      new BriefDeliveryCoordinator(recordingGateway(deliveredTarget, observedMemberNames)),
      request,
    );
    // already-delivered
    const repeatSettlement: BriefDeliverySettlement = await deliverVia(
      new BriefDeliveryCoordinator(recordingGateway(deliveredTarget, observedMemberNames)),
      request,
    );
    expect(repeatSettlement.disposition).toBe("already-delivered");

    // withheld
    const withheldTarget = new FakeTargetSession();
    withheldTarget.readOutcomes.push("fail");
    await deliverVia(
      new BriefDeliveryCoordinator(recordingGateway(withheldTarget, observedMemberNames)),
      request,
    );

    // unconfirmed
    const unconfirmedTarget = new FakeTargetSession();
    unconfirmedTarget.readOutcomes.push("ok", "fail");
    unconfirmedTarget.sendBehavior = "apply-then-fail";
    await deliverVia(
      new BriefDeliveryCoordinator(recordingGateway(unconfirmedTarget, observedMemberNames)),
      request,
    );

    expect([...new Set(observedMemberNames)].sort()).toEqual([
      "readTurnsForMarkerReconciliation",
      "sendBriefTurn",
    ]);
  });
});

describe("brief frame — the key is carried as visible characters", () => {
  it("renders the derived key into the frame the target receives", async () => {
    const sentFrames: BriefOutboundFrame[] = [];
    const gateway: BriefTargetGateway = {
      readTurnsForMarkerReconciliation: async (): Promise<readonly string[]> => [],
      sendBriefTurn: async (frame: BriefOutboundFrame): Promise<void> => {
        sentFrames.push(frame);
      },
    };
    const projection: CanonicalTranscriptProjection = generateTranscript(11).projection;

    const settlement: BriefDeliverySettlement = await deliverVia(
      new BriefDeliveryCoordinator(gateway),
      requestFor(projection),
    );

    const marker: string = renderBriefContinuityMarker(
      settlement.briefIdentityKey,
      settlement.declaredLosses,
    );
    const frame: BriefOutboundFrame | undefined = sentFrames[0];
    expect(frame).toBeDefined();
    // Asserted on the frame the target receives, not on the projection or the settlement.
    expect(frame?.frame.wireText).toContain(marker);
    expect(frame?.briefIdentityKey).toBe(settlement.briefIdentityKey);

    const markerIndex: number = (frame?.frame.wireText ?? "").indexOf(marker);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    // The whole marker, loss record included, is one whitespace-free run of printable ASCII so
    // that it survives a provider's reflow.
    expect(marker).toMatch(/^[\x21-\x7E]+$/);
  });

  it("reaches the gateway only through a composed frame, minted as system narration", async () => {
    const sentFrames: BriefOutboundFrame[] = [];
    const gateway: BriefTargetGateway = {
      readTurnsForMarkerReconciliation: async (): Promise<readonly string[]> => [],
      sendBriefTurn: async (frame: BriefOutboundFrame): Promise<void> => {
        sentFrames.push(frame);
      },
    };
    const projection: CanonicalTranscriptProjection = generateTranscript(13).projection;

    const settlement: BriefDeliverySettlement = await deliverVia(
      new BriefDeliveryCoordinator(gateway),
      requestFor(projection),
    );

    const frame: BriefOutboundFrame | undefined = sentFrames[0];
    // A brief is the daemon narrating a prior conversation, neither the user's text nor a
    // driver command.
    expect(frame?.frame.origin).toBe("system_narration");
    expect(frame?.frame.tripwireExempt).toBe(false);
    // Only the frame writer mints a frame, so the brief cannot bypass neutralization.
    expect(frame?.frame).toBeInstanceOf(OutboundTextFrame);
    // Neutralization is transport-only: the authored text equals the rendering byte for byte.
    expect(frame?.frame.authoredText).toBe(settlement.rendering.text);
    // The correlation id the tripwire joins a turn back on is present.
    expect((frame?.frame.correlationId ?? "").length).toBeGreaterThan(0);
  });

  it("uses no invisible or zero-width character anywhere in the frame", async () => {
    const sentFrames: BriefOutboundFrame[] = [];
    const gateway: BriefTargetGateway = {
      readTurnsForMarkerReconciliation: async (): Promise<readonly string[]> => [],
      sendBriefTurn: async (frame: BriefOutboundFrame): Promise<void> => {
        sentFrames.push(frame);
      },
    };

    await deliverVia(
      new BriefDeliveryCoordinator(gateway),
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
    expect(BRIEF_CONTINUITY_MARKER_PREFIX).toMatch(/^[\x21-\x7E]+$/);
  });
});

describe("brief floor — a result whose enclosure cannot be resolved is withheld", () => {
  /**
   * A tool result citing a reasoning block the content port could not read. It uses its own
   * content source because the suite's answers the empty list for every reasoning row, which
   * means a row with no blocks, not one whose blocks could not be read.
   */
  function foldUnreadableEnclosure(): CanonicalTranscriptProjection {
    const fixture = makeFixture();
    fixture.log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "user" }));
    fixture.contentSource.userTextBySequence.set(1, "run the tests");
    // No blocks are seeded for this row, so the port answers that they could not be read.
    fixture.log.append(storedEvent(2, "assistant.thinking_update", { runId: RUN_ID }));
    fixture.log.append(
      storedEvent(3, "tool.invoked", {
        runId: RUN_ID,
        toolCallId: "call-1",
        toolName: "run_tests",
      }),
    );
    fixture.contentSource.toolArgumentsBySequence.set(3, '{"suite":"unit"}');
    fixture.log.append(storedEvent(4, "tool.result", { runId: RUN_ID, toolCallId: "call-1" }));
    fixture.contentSource.toolResultBodyBySequence.set(4, {
      text: "42 passed",
      enclosingReasoningBlockId: "block-private-1",
    });
    return fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });
  }

  it("keeps the body out of the summary the new session is handed", async () => {
    // The brief runs the same strip as the transcript transform, so the withholding applies: a
    // brief is prose the target model reads, and content that may be private reasoning's must not
    // appear in it.
    const projection: CanonicalTranscriptProjection = foldUnreadableEnclosure();

    const target = new FakeTargetSession();
    const settlement: BriefDeliverySettlement = await deliverVia(
      new BriefDeliveryCoordinator(target),
      requestFor(projection),
    );

    expect(settlement.disposition).toBe("delivered");
    expect(settlement.rendering.text).not.toContain("42 passed");
    expect(settlement.rendering.declaredLosses).toContain("turn_content_unavailable");
    // The call still renders, so the body is withheld but the exchange is not erased.
    expect(settlement.rendering.text).toContain("[tool call run_tests (call-1)]");
    expect(target.turns[0]).not.toContain("42 passed");
  });

  it("keeps a withheld private-enclosed unkeyed answer out of the summary", () => {
    // The fold's stand-in for an unkeyed tool result whose reasoning block is private, beside a
    // real sibling so the turn survives the strip.
    const withMarker: CanonicalTranscriptProjection = projectionOf([
      turn(1, "user", [{ kind: "text", text: "run the tests" }]),
      turn(2, "assistant", [
        { kind: "text", text: "", withheldEnclosure: "private" },
        { kind: "text", text: "all green" },
      ]),
    ]);

    const rendering: BriefRendering = new BriefProjection().render(requestFor(withMarker));

    // The marker is consumed before rendering, adds no prose, and declares the private-reasoning
    // loss.
    expect(rendering.text).toContain("all green");
    expect(rendering.text).not.toContain("withheldEnclosure");
    expect(rendering.declaredLosses).toContain("provider_private_reasoning");
  });
});
