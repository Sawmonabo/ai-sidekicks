// Rendering the hand-over brief: a kept tool call keeps its result under any budget, the brief
// fits the ceiling it reports, and no private reasoning reaches it.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROTECTED_TAIL_TOOL_EXCHANGE_COUNT,
  BriefProjection,
  defaultBriefBudgetPolicy,
  partitionIntoExchanges,
  type BriefRendering,
  type TranscriptExchange,
} from "../projection.js";
import type {
  CanonicalTranscriptProjection,
  CanonicalTranscriptTurn,
} from "../../../driver/contract.js";
import {
  projectionOf,
  requestFor,
  turn,
  type TurnSegmentFixture,
} from "./projection.test-support.js";

const PADDING = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor";

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
  it("never emits a call without its result, or a result without its call, at any budget", () => {
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

  it(
    "evicts a tool-free conversation down to its newest exchange and never overruns a ceiling " +
      "it reports fitting",
    () => {
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
            {
              kind: "text",
              text: `exchange ${index.toString().padStart(2, "0")} `.padEnd(61, "-"),
            },
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
    },
  );

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
