// The hand-over brief: what stands in for a conversation a new provider session cannot
// continue. It renders the canonical projection as bounded prose and names the target it goes
// to; `brief-delivery.ts` sends it, at most once.
//
//   * The budget is a fraction of the target's context window, never an absolute token count.
//   * Eviction removes whole exchanges only, and the newest tool exchanges are protected.

import type { DeclaredLossKind } from "@ai-sidekicks/contracts/provider/driver/transcript";
import {
  orderDeclaredLosses,
  segmentContentIsUnavailable,
  transformTranscript,
  type TransformedTranscript,
} from "./transform-pipeline.js";
import type {
  CanonicalTranscriptProjection,
  CanonicalTranscriptSegment,
  CanonicalTranscriptTurn,
} from "../provider-driver.js";

/**
 * The target session a brief is delivered into, named by its provider session id alone: a resume
 * handle may rotate for one unchanged session, which would make one switch look like two.
 */
export interface BriefTargetIdentity {
  readonly providerSessionId: string;
}

/**
 * A target one coordinator established; only that coordinator may send to it, as its in-memory
 * record of the one send into each target is the only duplicate guard. A caller passing an
 * inherited session id to `establishTarget` as fresh cannot be detected.
 */
export class EstablishedBriefTarget {
  readonly #providerSessionId: string;

  constructor(providerSessionId: string) {
    this.#providerSessionId = providerSessionId;
  }

  get providerSessionId(): string {
    return this.#providerSessionId;
  }
}

/** Thrown when a coordinator is handed a target it did not itself establish. */
export class UnownedBriefTargetError extends Error {
  readonly providerSessionId: string;

  constructor(providerSessionId: string) {
    super(
      `Refusing to deliver a brief into provider session "${providerSessionId}": this ` +
        `coordinator did not establish that target, so it holds no record of what may already ` +
        `have been sent into it.`,
    );
    this.name = "UnownedBriefTargetError";
    this.providerSessionId = providerSessionId;
  }
}

/** The loss this floor declares on every path. */
const BRIEF_FLOOR_DECLARED_LOSS_KIND: DeclaredLossKind = "conversation_history_summarized";

/**
 * Estimates the tokens a rendered fragment consumes; injected so a driver can supply its real
 * tokenizer. The default (four characters per token) is deterministic, so daemons agree.
 */
export type BriefTokenEstimator = (text: string) => number;

const DEFAULT_BRIEF_TOKEN_ESTIMATOR: BriefTokenEstimator = (text: string): number =>
  Math.ceil(text.length / 4);

/** The brief's budget as a fraction of the target's context window, so it holds across models. */
export interface BriefBudgetPolicy {
  readonly targetContextWindowTokens: number;
  readonly budgetFraction: number;
  /** How many of the newest tool-bearing exchanges eviction never removes, each individually. */
  readonly protectedTailToolExchangeCount: number;
}

const DEFAULT_BRIEF_BUDGET_FRACTION: number = 0.2;

/** How many of the newest tool-bearing exchanges the default budget protects. */
export const DEFAULT_PROTECTED_TAIL_TOOL_EXCHANGE_COUNT: number = 2;

/** The budget policy for a target whose context window is `contextWindowTokens`. */
export function defaultBriefBudgetPolicy(contextWindowTokens: number): BriefBudgetPolicy {
  return {
    targetContextWindowTokens: contextWindowTokens,
    budgetFraction: DEFAULT_BRIEF_BUDGET_FRACTION,
    protectedTailToolExchangeCount: DEFAULT_PROTECTED_TAIL_TOOL_EXCHANGE_COUNT,
  };
}

/**
 * A group of consecutive turns that eviction treats as one unit. A cut before turn `k` is allowed
 * only when no tool-call id's first-to-last span straddles it, so a call and its result travel
 * together.
 */
export interface TranscriptExchange {
  readonly turns: readonly CanonicalTranscriptTurn[];
  readonly carriesToolActivity: boolean;
}

function collectToolCallSpans(
  turns: readonly CanonicalTranscriptTurn[],
): ReadonlyMap<string, { first: number; last: number }> {
  const spans: Map<string, { first: number; last: number }> = new Map<
    string,
    { first: number; last: number }
  >();
  turns.forEach((turn, turnIndex) => {
    for (const segment of turn.segments) {
      if (segment.kind !== "tool_call" && segment.kind !== "tool_result") {
        continue;
      }
      const existing: { first: number; last: number } | undefined = spans.get(segment.toolCallId);
      if (existing === undefined) {
        spans.set(segment.toolCallId, { first: turnIndex, last: turnIndex });
        continue;
      }
      existing.last = turnIndex;
    }
  });
  return spans;
}

function turnCarriesToolActivity(turn: CanonicalTranscriptTurn): boolean {
  return turn.segments.some(
    (segment) => segment.kind === "tool_call" || segment.kind === "tool_result",
  );
}

/** Partition turns into whole exchanges at every admissible (un-straddled) cut. */
export function partitionIntoExchanges(
  turns: readonly CanonicalTranscriptTurn[],
): readonly TranscriptExchange[] {
  if (turns.length === 0) {
    return [];
  }

  const spans: ReadonlyMap<string, { first: number; last: number }> = collectToolCallSpans(turns);
  const cutIndices: number[] = [0];
  for (let candidateCut = 1; candidateCut < turns.length; candidateCut += 1) {
    let straddled = false;
    for (const span of spans.values()) {
      if (span.first < candidateCut && candidateCut <= span.last) {
        straddled = true;
        break;
      }
    }
    if (!straddled) {
      cutIndices.push(candidateCut);
    }
  }
  cutIndices.push(turns.length);

  const exchanges: TranscriptExchange[] = [];
  for (let boundary = 0; boundary + 1 < cutIndices.length; boundary += 1) {
    const start: number = cutIndices[boundary] ?? 0;
    const end: number = cutIndices[boundary + 1] ?? turns.length;
    const exchangeTurns: readonly CanonicalTranscriptTurn[] = turns.slice(start, end);
    exchanges.push({
      turns: exchangeTurns,
      carriesToolActivity: exchangeTurns.some(turnCarriesToolActivity),
    });
  }
  return exchanges;
}

/**
 * Indices of the exchanges eviction never removes: the newest one (a brief without it describes a
 * conversation that did not happen) and the newest `count` tool-bearing ones, each wherever it
 * sits. At most `count + 1` are protected, so the budget still binds on long conversations.
 */
function computeProtectedExchangeIndices(
  exchanges: readonly TranscriptExchange[],
  protectedTailToolExchangeCount: number,
): ReadonlySet<number> {
  const protectedIndices: Set<number> = new Set<number>();
  if (exchanges.length === 0) {
    return protectedIndices;
  }
  protectedIndices.add(exchanges.length - 1);

  const wantedToolExchanges: number = Math.max(0, protectedTailToolExchangeCount);
  let claimedToolExchanges = 0;
  for (
    let index = exchanges.length - 1;
    index >= 0 && claimedToolExchanges < wantedToolExchanges;
    index -= 1
  ) {
    if (exchanges[index]?.carriesToolActivity === true) {
      protectedIndices.add(index);
      claimedToolExchanges += 1;
    }
  }
  return protectedIndices;
}

const BRIEF_OPENING_LINES: readonly string[] = [
  "This message continues a conversation that is already under way; it is not a new instruction.",
  "What follows is a bounded summary of that conversation, not its verbatim record.",
];

const BRIEF_TRANSCRIPT_SEPARATOR = "---";

/**
 * What a body the fold could not read renders as: an empty body would render as no turn at all,
 * and the declared loss does not reach this text.
 */
const BRIEF_UNAVAILABLE_BODY_TEXT: string = "(this content could not be recovered)";

function renderSegment(segment: CanonicalTranscriptSegment): string | undefined {
  const contentUnavailable: boolean = segmentContentIsUnavailable(segment);
  switch (segment.kind) {
    case "text":
      if (contentUnavailable) {
        return BRIEF_UNAVAILABLE_BODY_TEXT;
      }
      return segment.text.length === 0 ? undefined : segment.text;
    case "reasoning":
      // Unreachable after the strip, which drops private reasoning and flattens visible reasoning.
      return segment.text.length === 0 ? undefined : segment.text;
    case "tool_call": {
      const body: string = contentUnavailable ? BRIEF_UNAVAILABLE_BODY_TEXT : segment.argumentsJson;
      return `[tool call ${segment.toolName} (${segment.toolCallId})] ${body}`;
    }
    case "tool_result": {
      const body: string = contentUnavailable ? BRIEF_UNAVAILABLE_BODY_TEXT : segment.text;
      return `[tool result ${segment.outcome} (${segment.toolCallId})] ${body}`;
    }
    default:
      return undefined;
  }
}

function renderTurn(turn: CanonicalTranscriptTurn): string {
  const speaker: string = turn.role === "user" ? "User" : "Assistant";
  const renderedSegments: string[] = [];
  for (const segment of turn.segments) {
    const rendered: string | undefined = renderSegment(segment);
    if (rendered !== undefined) {
      renderedSegments.push(rendered);
    }
  }
  return `${speaker}: ${renderedSegments.join("\n")}`;
}

function renderExchange(exchange: TranscriptExchange): string {
  return exchange.turns.map(renderTurn).join("\n");
}

/** Never claims the shown exchanges are the newest: protection is per exchange, so gaps occur. */
function renderEvictionNotice(evictedExchangeCount: number, totalExchangeCount: number): string {
  const shown: number = totalExchangeCount - evictedExchangeCount;
  return (
    `Earlier parts of this conversation are omitted from the summary: ${shown.toString()} of ` +
    `${totalExchangeCount.toString()} exchanges appear below in log order, and may not be ` +
    `consecutive.`
  );
}

/** The pieces one assembled brief body is composed from, in emission order. */
interface BriefBodyAssembly {
  readonly openingText: string;
  /** Already rendered, in log order. */
  readonly exchangeRenderings: readonly string[];
  readonly evictedExchangeCount: number;
  readonly totalExchangeCount: number;
}

/**
 * Composes the brief prose from the preamble and the admitted exchanges. Admission pricing and
 * emission both use it, so a candidate is priced as the exact text sent, separators included.
 */
function assembleBriefBody(assembly: BriefBodyAssembly): string {
  const bodyLines: string[] = [assembly.openingText];
  if (assembly.evictedExchangeCount > 0) {
    bodyLines.push(
      renderEvictionNotice(assembly.evictedExchangeCount, assembly.totalExchangeCount),
    );
  }
  bodyLines.push(BRIEF_TRANSCRIPT_SEPARATOR);
  bodyLines.push(...assembly.exchangeRenderings);
  return bodyLines.join("\n");
}

/** What `BriefProjection.render` reads: the projection and the budget. */
export interface BriefRenderRequest {
  readonly projection: CanonicalTranscriptProjection;
  readonly budget: BriefBudgetPolicy;
}

/** The bounded brief prose plus what the budget kept and dropped. */
export interface BriefRendering {
  /** The exact prose the brief turn carries. */
  readonly text: string;
  /** The turns that survived the transforms and the budget, in log order. */
  readonly includedTurns: readonly CanonicalTranscriptTurn[];
  readonly includedExchangeCount: number;
  readonly evictedExchangeCount: number;
  readonly estimatedTokens: number;
  readonly budgetTokens: number;
  /** The emitted prose exceeds `budgetTokens`; only the protected floor can, and it is reported. */
  readonly exceedsBudget: boolean;
  readonly declaredLosses: readonly DeclaredLossKind[];
}

/**
 * Renders the canonical projection into the bounded prose the brief floor sends. Stateless:
 * `render` reads only its argument, so the brief is rebuilt from the log on every send and a
 * caller cannot hold a stale rendering.
 */
export class BriefProjection {
  readonly #estimateTokens: BriefTokenEstimator;

  constructor(estimateTokens: BriefTokenEstimator = DEFAULT_BRIEF_TOKEN_ESTIMATOR) {
    this.#estimateTokens = estimateTokens;
  }

  render(request: BriefRenderRequest): BriefRendering {
    // Strip what no other model may be shown, then repair the results the strip orphaned (an
    // unpaired call is accepted silently and rejected on every later request).
    const transformed: TransformedTranscript = transformTranscript(request.projection);

    const exchanges: readonly TranscriptExchange[] = partitionIntoExchanges(transformed.turns);
    const budgetTokens: number = Math.max(
      0,
      Math.floor(request.budget.targetContextWindowTokens * request.budget.budgetFraction),
    );

    const protectedIndices: ReadonlySet<number> = computeProtectedExchangeIndices(
      exchanges,
      request.budget.protectedTailToolExchangeCount,
    );

    const openingText: string = BRIEF_OPENING_LINES.join("\n");
    // Rendered once; the admission walk re-joins them per candidate.
    const exchangeRenderings: readonly string[] = exchanges.map(renderExchange);

    const preBudgetLosses: readonly DeclaredLossKind[] = orderDeclaredLosses([
      ...transformed.declaredLosses,
      // Always declared: an empty list would claim nothing was dropped.
      BRIEF_FLOOR_DECLARED_LOSS_KIND,
    ]);
    // Priced over the whole assembled candidate: summing per-exchange prices undercounts separators
    // and assumes an additivity the injected estimator does not owe.
    const assembleFor = (admittedIndices: ReadonlySet<number>): string =>
      assembleBriefBody({
        openingText,
        exchangeRenderings: exchangeRenderings.filter((_rendering, index) =>
          admittedIndices.has(index),
        ),
        evictedExchangeCount: exchanges.length - admittedIndices.size,
        totalExchangeCount: exchanges.length,
      });

    // Protected exchanges are always admitted, never refused.
    const includedIndices: Set<number> = new Set<number>(protectedIndices);

    // Admit the rest newest-first until the first that does not fit. Protected ones are stepped
    // over, so the notice discloses the gaps.
    for (let index = exchanges.length - 1; index >= 0; index -= 1) {
      if (protectedIndices.has(index)) {
        continue;
      }
      includedIndices.add(index);
      if (this.#estimateTokens(assembleFor(includedIndices)) > budgetTokens) {
        includedIndices.delete(index);
        break;
      }
    }

    const includedExchanges: readonly TranscriptExchange[] = exchanges.filter((_exchange, index) =>
      includedIndices.has(index),
    );
    const evictedExchangeCount: number = exchanges.length - includedExchanges.length;
    const includedTurns: readonly CanonicalTranscriptTurn[] = includedExchanges.flatMap(
      (exchange) => [...exchange.turns],
    );

    const declaredLosses: readonly DeclaredLossKind[] = orderDeclaredLosses([
      ...preBudgetLosses,
      // Declared on eviction alone: an over-budget render that evicted nothing dropped nothing.
      ...(evictedExchangeCount > 0 ? (["context_truncated"] as const) : []),
    ]);

    // Measured on the emitted text, so a non-monotone tokenizer shows as `exceedsBudget`.
    const text: string = assembleFor(includedIndices);
    const estimatedTokens: number = this.#estimateTokens(text);

    return {
      text,
      includedTurns,
      includedExchangeCount: includedExchanges.length,
      evictedExchangeCount,
      estimatedTokens,
      budgetTokens,
      exceedsBudget: estimatedTokens > budgetTokens,
      declaredLosses,
    };
  }
}
