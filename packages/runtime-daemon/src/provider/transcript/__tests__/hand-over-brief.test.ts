// The hand-over brief: a kept tool call keeps its result under any budget, the brief fits the
// ceiling it reports, no private reasoning reaches it, and a delivery never places a second brief
// in a target, however its send ends.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROTECTED_TAIL_TOOL_EXCHANGE_COUNT,
  BRIEF_CONTINUITY_MARKER_PREFIX,
  BriefProjection,
  UnownedBriefTargetError,
  defaultBriefBudgetPolicy,
  deriveBriefIdentityKey,
  partitionIntoExchanges,
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
} from "../brief-delivery.js";
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

const TARGET: BriefTargetIdentity = { providerSessionId: "provider-session-target-1" };
const OTHER_TARGET: BriefTargetIdentity = { providerSessionId: "provider-session-target-2" };

/** Wide enough that the whole fixture fits, so eviction is opt-in per case. */
const ROOMY_BUDGET: BriefBudgetPolicy = defaultBriefBudgetPolicy(1_000_000);

const PADDING = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor";

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

function projectionOf(turns: readonly CanonicalTranscriptTurn[]): CanonicalTranscriptProjection {
  return { sessionId: SESSION_ID, runId: RUN_ID, builtAtPosition: 100, turns };
}

const HELLO: CanonicalTranscriptProjection = projectionOf([
  turn(1, "user", [{ kind: "text", text: "hello" }]),
]);
const GROWN_HELLO: CanonicalTranscriptProjection = projectionOf([
  turn(1, "user", [{ kind: "text", text: "hello" }]),
  turn(2, "assistant", [{ kind: "text", text: "hello to you" }]),
]);

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

/** A delivery request before a coordinator has established its target and minted the handle. */
type DeliveryDraft = Omit<BriefDeliveryRequest, "target"> & {
  readonly target: BriefTargetIdentity;
};

function requestFor(
  projection: CanonicalTranscriptProjection,
  budget: BriefBudgetPolicy = ROOMY_BUDGET,
): DeliveryDraft {
  return { projection, target: TARGET, budget };
}

/** Establishes the draft's target on `coordinator`, which refuses a handle another one minted. */
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

  /** Answers the target's whole turn history, never a tail, as the port requires. */
  async readTurnsForMarkerReconciliation(): Promise<readonly string[]> {
    this.readAttempts += 1;
    if (this.readOutcomes.shift() === "fail") {
      throw new Error("target session could not be read");
    }
    return this.reportNoTurns ? [] : [...this.turns];
  }

  async sendBriefTurn(frame: BriefOutboundFrame): Promise<void> {
    this.sendAttempts += 1;
    // `wireText`, not the authored prose: the readback reconciles against what the provider got.
    switch (this.sendBehavior) {
      case "apply-then-fail":
        this.turns.push(frame.frame.wireText);
        throw new Error("acknowledgment lost after the frame was applied");
      case "apply-late-then-fail":
        this.#framesStillApplying.push(frame.frame.wireText);
        throw new Error("acknowledgment timed out while the frame was still being applied");
      case "refuse":
        throw new Error("target session refused the frame");
      case "accept":
        this.turns.push(frame.frame.wireText);
    }
  }
}

type SendBehavior = FakeTargetSession["sendBehavior"];

function briefsIn(target: FakeTargetSession): number {
  return target.turns.filter((turnText) => turnText.includes(BRIEF_CONTINUITY_MARKER_PREFIX))
    .length;
}

/** An honest barrier: waits for the provider session to go quiet, so pending sends finish first. */
function settlementBarrierFor(target: FakeTargetSession): BriefSendSettlementBarrier {
  return () => {
    target.applyPendingSends();
    return Promise.resolve();
  };
}

// The pairing property's helpers

function toolCallIdsIn(turns: readonly CanonicalTranscriptTurn[]): string[] {
  return turns
    .flatMap((includedTurn) => includedTurn.segments)
    .flatMap((segment) => (segment.kind === "tool_call" ? [segment.toolCallId] : []))
    .sort();
}

function toolResultIdsIn(turns: readonly CanonicalTranscriptTurn[]): string[] {
  return turns
    .flatMap((includedTurn) => includedTurn.segments)
    .flatMap((segment) => (segment.kind === "tool_result" ? [segment.toolCallId] : []))
    .sort();
}

/** Whether every turn of `candidate` appears in `whole` in the same order, by unique position. */
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

// Rendering

describe("brief rendering", () => {
  it("never emits a call without its result nor a result without its call, under any budget", () => {
    const briefProjection = new BriefProjection();
    let totalCrossTurnPairs = 0;
    let rendersThatEvicted = 0;
    let renderCount = 0;
    let transcriptsWithFewerToolExchangesThanProtected = 0;

    for (let seed = 1; seed <= 60; seed += 1) {
      const generated: GeneratedTranscript = generateTranscript(seed);
      totalCrossTurnPairs += generated.crossTurnPairCount;
      const generatedToolExchangeCount: number = partitionIntoExchanges(
        generated.projection.turns,
      ).filter((exchange) => exchange.carriesToolActivity).length;
      if (generatedToolExchangeCount < DEFAULT_PROTECTED_TAIL_TOOL_EXCHANGE_COUNT) {
        transcriptsWithFewerToolExchangesThanProtected += 1;
      }

      const unbounded: BriefRendering = briefProjection.render(requestFor(generated.projection));
      expect(unbounded.evictedExchangeCount).toBe(0);

      // Spans both regimes: tight windows force eviction and the wide one does not.
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

        // An order-preserving subsequence of the unbounded render, not a contiguous suffix:
        // protection is per exchange, so an older tool exchange may outlive an evicted newer one.
        expect(isOrderPreservingSubsequence(rendering.includedTurns, unbounded.includedTurns)).toBe(
          true,
        );

        // Every protected exchange survives any budget.
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

    // The corpus straddles turn boundaries, eviction both fired and did not, and some transcripts
    // carry fewer tool exchanges than the protected tail wants.
    expect(totalCrossTurnPairs).toBeGreaterThan(0);
    expect(rendersThatEvicted).toBeGreaterThan(0);
    expect(rendersThatEvicted).toBeLessThan(renderCount);
    expect(transcriptsWithFewerToolExchangesThanProtected).toBeGreaterThan(0);
  });

  it("evicts a tool-free conversation down to its newest exchange and never overruns a ceiling it reports fitting", () => {
    // Assembly joins the preamble and every admitted exchange with a newline, so pricing each
    // exchange alone under-counts by one separator per admission. Only a sweep of every integer
    // ceiling finds the ceiling where that admits a set that assembles past the budget.
    const briefProjection = new BriefProjection();
    const turns: CanonicalTranscriptTurn[] = [];
    for (let index = 0; index < 12; index += 1) {
      // Each rendered turn is 72 characters, a whole multiple of the default estimator's four
      // characters per token, so rounding adds no slack and the separators are measured.
      turns.push(
        turn(index + 1, "assistant", [
          { kind: "text", text: `exchange ${index.toString().padStart(2, "0")} `.padEnd(61, "-") },
        ]),
      );
    }
    const projection: CanonicalTranscriptProjection = projectionOf(turns);
    const unbounded: BriefRendering = briefProjection.render(requestFor(projection));
    expect(unbounded.includedExchangeCount).toBe(12);

    let ceilingsTheNewestExchangeOverran = 0;
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

      // With no tool exchange to protect, the newest exchange is the whole floor; the protected
      // tail must not swallow the conversation and leave the budget unenforceable.
      expect(rendering.includedTurns.at(-1)).toEqual(unbounded.includedTurns.at(-1));
      if (rendering.exceedsBudget) {
        ceilingsTheNewestExchangeOverran += 1;
        expect(rendering.includedExchangeCount).toBe(1);
        continue;
      }
      expect(rendering.estimatedTokens).toBeLessThanOrEqual(ceilingTokens);
      if (rendering.evictedExchangeCount > 0) {
        ceilingsThatFitAfterEviction += 1;
        expect(rendering.declaredLosses).toContain("context_truncated");
      }
    }

    expect(ceilingsTheNewestExchangeOverran).toBeGreaterThan(0);
    expect(ceilingsThatFitAfterEviction).toBeGreaterThan(0);
  });

  it("lets no private reasoning into the brief and declares what it withheld", () => {
    const briefProjection = new BriefProjection();

    const withPrivateBlock: BriefRendering = briefProjection.render(
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
    expect(withPrivateBlock.text).not.toContain("SECRET-DELIBERATION");
    expect(withPrivateBlock.declaredLosses).toContain("provider_private_reasoning");

    // The fold's stand-in for an answer withheld for its private enclosure, beside a real sibling
    // so the turn survives the strip.
    const withWithheldAnswer: BriefRendering = briefProjection.render(
      requestFor(
        projectionOf([
          turn(1, "user", [{ kind: "text", text: "run the tests" }]),
          turn(2, "assistant", [
            { kind: "text", text: "", withheldEnclosure: "private" },
            { kind: "text", text: "all green" },
          ]),
        ]),
      ),
    );
    expect(withWithheldAnswer.declaredLosses).toContain("provider_private_reasoning");
  });
});

// Identity

function seedConversation(fixture: TranscriptFixture): void {
  // The user's words travel in the encrypted envelope, so the fold reads them from the content port.
  fixture.log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "user" }));
  fixture.contentSource.userTextBySequence.set(1, "run the tests");
  fixture.log.append(storedEvent(2, "assistant.message", { runId: RUN_ID }));
}

describe("brief identity key", () => {
  it("is derived from the transcript and target alone, so a restarted daemon finds its own brief", () => {
    // A fresh coordinator recognizes a delivered brief only by this key, so a key that moved across
    // a restart would send a second brief, and a key that ignored content or target would let any
    // other brief's marker stand in for this one.
    const request = { sessionId: SESSION_ID, runId: RUN_ID };
    const first = makeFixture();
    seedConversation(first);
    const second = makeFixture();
    seedConversation(second);
    const before: CanonicalTranscriptProjection = first.fold.build(request);
    const key: string = deriveBriefIdentityKey(before, TARGET);

    expect(deriveBriefIdentityKey(second.fold.build(request), TARGET)).toBe(key);
    expect(deriveBriefIdentityKey(before, OTHER_TARGET)).not.toBe(key);

    first.log.append(storedEvent(3, "user.message", { runId: OTHER_RUN_ID, actor: "user" }));
    first.contentSource.userTextBySequence.set(3, "unrelated");
    const afterOtherRun: CanonicalTranscriptProjection = first.fold.build(request);
    expect(afterOtherRun.builtAtPosition).toBeGreaterThan(before.builtAtPosition);
    expect(deriveBriefIdentityKey(afterOtherRun, TARGET)).toBe(key);

    first.log.append(storedEvent(4, "user.message", { runId: RUN_ID, actor: "user" }));
    first.contentSource.userTextBySequence.set(4, "and now deploy");
    expect(deriveBriefIdentityKey(first.fold.build(request), TARGET)).not.toBe(key);
  });
});

// Delivery

describe("brief delivery — a target holds at most one brief", () => {
  it("never sends a second brief into a target that already holds one", async () => {
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-then-fail";
    const projection: CanonicalTranscriptProjection = plainConversation();
    const coordinator = new BriefDeliveryCoordinator(target);

    // The acknowledgment is lost; the readback, not the rejection, settles it.
    const delivered: BriefDeliverySettlement = await deliverVia(
      coordinator,
      requestFor(projection, defaultBriefBudgetPolicy(600)),
    );
    expect(delivered.disposition).toBe("delivered");
    expect(delivered.declaredLosses).toContain("context_truncated");
    expect((await deliverVia(coordinator, requestFor(projection))).disposition).toBe(
      "already-delivered",
    );

    // After a restart, with the brief scrolled far back and a budget wide enough to drop nothing,
    // a fresh coordinator still finds it and reports what the delivered brief dropped.
    for (let turnIndex = 0; turnIndex < 200; turnIndex += 1) {
      target.turns.push(`ordinary turn ${turnIndex.toString()}`);
    }
    const afterRestart: BriefDeliverySettlement = await deliverVia(
      new BriefDeliveryCoordinator(target),
      requestFor(projection),
    );
    expect(afterRestart.disposition).toBe("already-delivered");
    expect(afterRestart.rendering.declaredLosses).not.toContain("context_truncated");
    expect(afterRestart.declaredLosses).toStrictEqual(delivered.declaredLosses);

    // Once-only is per target: a grown projection derives a new key and still sends nothing.
    const grown: BriefDeliverySettlement = await deliverVia(
      coordinator,
      requestFor(
        projectionOf([...projection.turns, turn(13, "user", [{ kind: "text", text: "more" }])]),
      ),
    );
    expect(grown.briefIdentityKey).not.toBe(delivered.briefIdentityKey);
    expect(grown.disposition).toBe("already-delivered");

    expect(target.sendAttempts).toBe(1);
    expect(briefsIn(target)).toBe(1);
  });

  it("sends once when two deliveries into one target overlap", async () => {
    // Both calls read the target before either send lands, so reconciliation alone sends twice.
    for (const [secondProjection, secondDisposition] of [
      [HELLO, "delivered"],
      [GROWN_HELLO, "already-delivered"],
    ] as const) {
      const target = new FakeTargetSession();
      const coordinator = new BriefDeliveryCoordinator(target);

      const [first, second] = await Promise.all([
        deliverVia(coordinator, requestFor(HELLO)),
        deliverVia(coordinator, requestFor(secondProjection)),
      ]);

      expect(first.disposition).toBe("delivered");
      expect(second.disposition).toBe(secondDisposition);
      expect(target.sendAttempts).toBe(1);
      expect(briefsIn(target)).toBe(1);
    }
  });

  it("settles already-delivered only on a complete marker this coordinator could have written", async () => {
    // Settling on anything else skips the only context transfer there is while reporting success.
    const projection: CanonicalTranscriptProjection = plainConversation();
    const briefIdentityKey: string = deriveBriefIdentityKey(projection, TARGET);
    const marker = `${BRIEF_CONTINUITY_MARKER_PREFIX}${briefIdentityKey}`;

    const notThisBrief: readonly string[] = [
      // The key runs on into a longer key that begins with this one.
      `${marker}0`,
      `${marker}-second`,
      `${marker}_b`,
      // The marker opened mid-word.
      `x${marker}`,
      `discontinuity-ref:${briefIdentityKey}`,
      // A complete marker pasted from another conversation: a key this coordinator never attempted.
      `the other session said: ${BRIEF_CONTINUITY_MARKER_PREFIX}${"ab".repeat(16)};dropped=conversation_history_summarized`,
    ];
    const thisBrief: readonly string[] = [
      marker,
      `an older summary ${marker}`,
      `(${marker}) and then some prose`,
      `${marker};dropped=conversation_history_summarized`,
      // An unreadable loss record is still this marker: resending would add a second summary.
      `${marker};dropped=`,
    ];

    for (const [turnText, disposition, sendAttempts] of [
      ...notThisBrief.map((text) => [text, "delivered", 1] as const),
      ...thisBrief.map((text) => [text, "already-delivered", 0] as const),
    ]) {
      const target = new FakeTargetSession();
      target.turns.push(turnText);
      const settlement = await deliverVia(
        new BriefDeliveryCoordinator(target),
        requestFor(projection),
      );
      expect(settlement.disposition, turnText).toBe(disposition);
      expect(target.sendAttempts, turnText).toBe(sendAttempts);
    }
  });

  it("holds an ambiguous send unconfirmed and never sends beside it", async () => {
    // A send whose acknowledgment is lost may still be landing, so a readback that finds nothing is
    // no proof of refusal; settling it as one would let a retry send a second brief.
    const plain: DeliveryDraft = requestFor(HELLO);
    const cases: readonly {
      readonly name: string;
      readonly sendBehavior: SendBehavior;
      readonly readOutcomes?: readonly ("ok" | "fail")[];
      readonly reportNoTurns?: boolean;
      readonly first: DeliveryDraft;
      readonly retry: DeliveryDraft;
    }[] = [
      {
        name: "a retry with no barrier",
        sendBehavior: "apply-late-then-fail",
        first: plain,
        retry: plain,
      },
      {
        // The call that made the send never consults the barrier, so one that resolves at once
        // cannot talk it into a refusal.
        name: "a barrier that resolves at once, on the call that made the send",
        sendBehavior: "apply-late-then-fail",
        first: { ...plain, sendSettlementBarrier: () => Promise.resolve() },
        retry: plain,
      },
      {
        name: "a barrier that expires on the retry",
        sendBehavior: "apply-late-then-fail",
        first: plain,
        retry: {
          ...plain,
          sendSettlementBarrier: () => Promise.reject(new Error("the bounded wait expired")),
        },
      },
      {
        name: "a readback that fails after the send",
        sendBehavior: "apply-late-then-fail",
        readOutcomes: ["ok", "fail"],
        first: plain,
        retry: plain,
      },
      {
        name: "a target unreadable on the retry",
        sendBehavior: "apply-late-then-fail",
        readOutcomes: ["ok", "ok", "fail"],
        first: plain,
        retry: plain,
      },
      {
        // An unacknowledged send is remembered, not re-derived from a read that may be wrong.
        name: "a readback blind to the landed brief",
        sendBehavior: "apply-then-fail",
        reportNoTurns: true,
        first: plain,
        retry: plain,
      },
      {
        // The register is per target, so a new key does not miss the outstanding send.
        name: "a grown projection on the retry",
        sendBehavior: "apply-late-then-fail",
        first: plain,
        retry: requestFor(GROWN_HELLO),
      },
    ];

    for (const ambiguousCase of cases) {
      const target = new FakeTargetSession();
      target.sendBehavior = ambiguousCase.sendBehavior;
      target.readOutcomes.push(...(ambiguousCase.readOutcomes ?? []));
      target.reportNoTurns = ambiguousCase.reportNoTurns ?? false;
      const coordinator = new BriefDeliveryCoordinator(target);

      const first = await deliverVia(coordinator, ambiguousCase.first);
      const retry = await deliverVia(coordinator, ambiguousCase.retry);
      target.applyPendingSends();

      expect(first.disposition, ambiguousCase.name).toBe("unconfirmed");
      expect(retry.disposition, ambiguousCase.name).toBe("unconfirmed");
      expect(target.sendAttempts, ambiguousCase.name).toBe(1);
      expect(target.turns, ambiguousCase.name).toHaveLength(1);
    }
  });

  it("does not hold the brief back forever once the target answers", async () => {
    // An honest barrier orders the read behind the earlier send. A send that landed late settles
    // as delivered; one that never landed settles withheld, and the next delivery sends afresh.
    // A withheld delivery leaves nothing behind that would stand in for the next one.
    const cases: readonly {
      readonly name: string;
      readonly readOutcomes: readonly ("ok" | "fail")[];
      readonly sendBehaviorByCall: readonly SendBehavior[];
      readonly settlements: readonly string[];
      readonly sendAttempts: number;
    }[] = [
      {
        name: "a send that landed late",
        readOutcomes: [],
        sendBehaviorByCall: ["apply-late-then-fail", "accept"],
        settlements: ["unconfirmed", "already-delivered"],
        sendAttempts: 1,
      },
      {
        name: "a send the target refused",
        readOutcomes: [],
        sendBehaviorByCall: ["refuse", "refuse", "accept"],
        settlements: ["unconfirmed", "withheld:send-refused", "delivered"],
        sendAttempts: 2,
      },
      {
        name: "a target unreadable before the send",
        readOutcomes: ["fail"],
        sendBehaviorByCall: ["accept", "accept"],
        settlements: ["withheld:target-unreadable", "delivered"],
        sendAttempts: 1,
      },
    ];

    for (const recoveryCase of cases) {
      const target = new FakeTargetSession();
      target.readOutcomes.push(...recoveryCase.readOutcomes);
      const coordinator = new BriefDeliveryCoordinator(target);
      const draft: DeliveryDraft = {
        ...requestFor(HELLO),
        sendSettlementBarrier: settlementBarrierFor(target),
      };

      const settlements: string[] = [];
      for (const sendBehavior of recoveryCase.sendBehaviorByCall) {
        target.sendBehavior = sendBehavior;
        const settlement = await deliverVia(coordinator, draft);
        settlements.push(
          settlement.withheldReason === undefined
            ? settlement.disposition
            : `${settlement.disposition}:${settlement.withheldReason}`,
        );
      }

      expect(settlements, recoveryCase.name).toStrictEqual(recoveryCase.settlements);
      expect(target.sendAttempts, recoveryCase.name).toBe(recoveryCase.sendAttempts);
      expect(target.turns, recoveryCase.name).toHaveLength(1);
    }
  });

  it("lets only the coordinator holding a target send into it", async () => {
    // After a restart the successor inherits the established request but not the register that
    // knows a send is still applying, so it is refused before it can read an absence and act.
    const target = new FakeTargetSession();
    target.sendBehavior = "apply-late-then-fail";
    const original = new BriefDeliveryCoordinator(target);
    const request: BriefDeliveryRequest = addressedTo(original, requestFor(HELLO));
    expect((await original.deliver(request)).disposition).toBe("unconfirmed");

    const readsBeforeTheSuccessor: number = target.readAttempts;
    await expect(new BriefDeliveryCoordinator(target).deliver(request)).rejects.toBeInstanceOf(
      UnownedBriefTargetError,
    );
    expect(target.readAttempts).toBe(readsBeforeTheSuccessor);
    target.applyPendingSends();
    expect(target.sendAttempts).toBe(1);
    expect(target.turns).toHaveLength(1);

    // Releasing a target at session end refuses its handle and drops its unconfirmed send, so a
    // long-running daemon keeps no register for ended sessions.
    const releasedTarget = new FakeTargetSession();
    releasedTarget.sendBehavior = "refuse";
    const coordinator = new BriefDeliveryCoordinator(releasedTarget);
    const releasedRequest: BriefDeliveryRequest = addressedTo(coordinator, requestFor(HELLO));
    expect((await coordinator.deliver(releasedRequest)).disposition).toBe("unconfirmed");

    coordinator.releaseTarget(TARGET.providerSessionId);
    await expect(coordinator.deliver(releasedRequest)).rejects.toBeInstanceOf(
      UnownedBriefTargetError,
    );

    releasedTarget.sendBehavior = "accept";
    expect((await deliverVia(coordinator, requestFor(HELLO))).disposition).toBe("delivered");
    expect(releasedTarget.sendAttempts).toBe(2);
  });

  it("sends the brief as system narration, never exempt from the command tripwire", async () => {
    // The brief carries an earlier conversation's text; only a driver command skips the tripwire.
    const sentFrames: BriefOutboundFrame[] = [];
    const coordinator = new BriefDeliveryCoordinator({
      readTurnsForMarkerReconciliation: async (): Promise<readonly string[]> => [],
      sendBriefTurn: async (frame: BriefOutboundFrame): Promise<void> => {
        sentFrames.push(frame);
      },
    });

    await deliverVia(coordinator, requestFor(HELLO));

    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0]?.frame.origin).toBe("system_narration");
    expect(sentFrames[0]?.frame.tripwireExempt).toBe(false);
  });
});
