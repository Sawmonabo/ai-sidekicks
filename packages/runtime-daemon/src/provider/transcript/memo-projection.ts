// The memo floor: the fallback that stands in when a conversation cannot be reconstituted
// natively. It renders the canonical projection as bounded prose and delivers it at most once.
//
//   * The budget is a fraction of the target's context window, never an absolute token count.
//   * Eviction removes whole exchanges only, and the newest tool exchanges are protected.
//   * The once-only key derives from the raw projection (before the transforms and the budget) and
//     the target session, so a later change to how the memo is worded, stripped or evicted never
//     makes a second memo for one switch. It rides as visible ASCII in the memo turn and leaves out
//     `builtAtPosition`, which moves on any append. Nothing durable is written.
//   * An ambiguous send stays unconfirmed until the marker appears or an absence is read after the
//     caller's settlement barrier: a duplicate memo corrupts the conversation, a missing one only
//     degrades it. The caller decides whether native replay already succeeded.

import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { DeclaredLossKind } from "@ai-sidekicks/contracts";
import { DECLARED_LOSS_KINDS } from "@ai-sidekicks/contracts";
import {
  createTranscriptPipelineState,
  foldTurns,
  repairPairingIntegrity,
  segmentContentIsUnavailable,
  stripNonPortableContent,
  type TranscriptPipelineState,
} from "./transform-pipeline.js";
import type {
  CanonicalTranscriptProjection,
  CanonicalTranscriptSegment,
  CanonicalTranscriptTurn,
} from "../provider-driver.js";

/**
 * The target session a memo is delivered into. Only the provider session id is in the key: a
 * resume handle may rotate for one unchanged session, which would make one switch look like two.
 */
export interface MemoTargetIdentity {
  readonly providerSessionId: string;
}

/**
 * A target one coordinator established; only that coordinator may send to it, as its in-memory
 * register of ambiguous sends is the only duplicate guard. A caller passing an inherited session
 * id to `establishTarget` as fresh cannot be detected.
 */
export class EstablishedMemoTarget {
  readonly #providerSessionId: string;

  constructor(providerSessionId: string) {
    this.#providerSessionId = providerSessionId;
  }

  get providerSessionId(): string {
    return this.#providerSessionId;
  }
}

/** Thrown when a coordinator is handed a target it did not itself establish. */
export class UnownedMemoTargetError extends Error {
  readonly providerSessionId: string;

  constructor(providerSessionId: string) {
    super(
      `Refusing to deliver a memo into provider session "${providerSessionId}": this coordinator did not establish that target, so it holds no record of what may already have been sent into it.`,
    );
    this.name = "UnownedMemoTargetError";
    this.providerSessionId = providerSessionId;
  }
}

/** Digest size in bytes (128 bits): collision-safe for a session's switches, short to read. */
export const MEMO_IDENTITY_KEY_BYTE_LENGTH = 16;

/** The visible marker prefix: lowercase ASCII with no punctuation a provider would reflow. */
export const MEMO_CONTINUITY_MARKER_PREFIX: string = "continuity-ref:";

/** Separates the key from the record of what the memo carrying it dropped. */
export const MEMO_CONTINUITY_LOSS_SEPARATOR = ";dropped=";

/** Joins the recorded loss kinds. Not a comma: a comma invites a space after it. */
export const MEMO_CONTINUITY_LOSS_JOINER = "+";

/**
 * The exact marker text a memo renders: its key and what that memo dropped. One whitespace-free
 * token, so no reflow splits it; it is the only trace a delivered memo leaves.
 */
export function renderMemoContinuityMarker(
  memoIdentityKey: string,
  declaredLosses: readonly DeclaredLossKind[],
): string {
  return `${MEMO_CONTINUITY_MARKER_PREFIX}${memoIdentityKey}${MEMO_CONTINUITY_LOSS_SEPARATOR}${declaredLosses.join(
    MEMO_CONTINUITY_LOSS_JOINER,
  )}`;
}

/** The loss this floor declares on every path; a record without it cannot come from the writer. */
export const MEMO_FLOOR_DECLARED_LOSS_KIND: DeclaredLossKind = "conversation_history_summarized";

/**
 * Appends one field to the key's pre-image, length-prefixed so a text containing a separator
 * cannot let two transcripts share a pre-image (a collision means a memo that never sends).
 */
function appendKeyField(parts: string[], value: string | number): void {
  const encoded: string = JSON.stringify(value);
  parts.push(`${encoded.length.toString()}:${encoded}`);
}

function appendSegmentToKeyPreimage(parts: string[], segment: CanonicalTranscriptSegment): void {
  appendKeyField(parts, segment.kind);
  // A body the fold could not read renders as an empty one; without this, two transcripts
  // differing only in that would share a pre-image.
  appendKeyField(parts, segmentContentIsUnavailable(segment) ? "unavailable" : "available");
  switch (segment.kind) {
    case "text":
      appendKeyField(parts, segment.text);
      return;
    case "reasoning":
      appendKeyField(parts, segment.blockId);
      appendKeyField(parts, segment.reasoningKind);
      appendKeyField(parts, segment.disclosure);
      appendKeyField(parts, segment.text);
      return;
    case "tool_call":
      appendKeyField(parts, segment.toolCallId);
      appendKeyField(parts, segment.toolName);
      appendKeyField(parts, segment.argumentsJson);
      return;
    case "tool_result":
      appendKeyField(parts, segment.toolCallId);
      appendKeyField(parts, segment.outcome);
      appendKeyField(parts, segment.provenance);
      appendKeyField(parts, segment.text);
      appendKeyField(parts, segment.enclosingReasoningBlockId ?? "");
      // Hashed beside the block id it resolves: the id names a sibling a positional bound may cut
      // away, the verdict decides whether the body travels. A fold that could not read the
      // reasoning row withholds the result, and without this field the corrected memo would share
      // the key.
      appendKeyField(parts, segment.enclosureDisclosure ?? "");
      return;
    default:
      return;
  }
}

/**
 * The memo-identity key: a pure function of the raw projection's content and the target session,
 * recomputed by any daemon and persisted nowhere. It excludes `builtAtPosition` (see the header).
 */
export function deriveMemoIdentityKey(
  projection: CanonicalTranscriptProjection,
  target: MemoTargetIdentity,
): string {
  const parts: string[] = [];
  appendKeyField(parts, projection.sessionId as string);
  appendKeyField(parts, projection.runId as string);
  appendKeyField(parts, target.providerSessionId);
  appendKeyField(parts, projection.turns.length);
  for (const turn of projection.turns) {
    appendKeyField(parts, turn.position);
    appendKeyField(parts, turn.role);
    appendKeyField(parts, turn.segments.length);
    for (const segment of turn.segments) {
      appendSegmentToKeyPreimage(parts, segment);
    }
  }
  const digest: Uint8Array = blake3(new TextEncoder().encode(parts.join("")), {
    dkLen: MEMO_IDENTITY_KEY_BYTE_LENGTH,
  });
  return bytesToHex(digest);
}

/**
 * Estimates the tokens a rendered fragment consumes; injected so a driver can supply its real
 * tokenizer. The default (four characters per token) is deterministic, so daemons agree.
 */
export type MemoTokenEstimator = (text: string) => number;

const DEFAULT_MEMO_TOKEN_ESTIMATOR: MemoTokenEstimator = (text: string): number =>
  Math.ceil(text.length / 4);

/** The memo's budget as a fraction of the target's context window, so it holds across models. */
export interface MemoBudgetPolicy {
  readonly targetContextWindowTokens: number;
  readonly budgetFraction: number;
  /** How many of the newest tool-bearing exchanges eviction never removes, each individually. */
  readonly protectedTailToolExchangeCount: number;
}

const DEFAULT_MEMO_BUDGET_FRACTION: number = 0.2;

/** How many of the newest tool-bearing exchanges the default budget protects. */
export const DEFAULT_PROTECTED_TAIL_TOOL_EXCHANGE_COUNT: number = 2;

/** The budget policy for a target whose context window is `contextWindowTokens`. */
export function defaultMemoBudgetPolicy(contextWindowTokens: number): MemoBudgetPolicy {
  return {
    targetContextWindowTokens: contextWindowTokens,
    budgetFraction: DEFAULT_MEMO_BUDGET_FRACTION,
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
 * Indices of the exchanges eviction never removes: the newest one (a memo without it describes a
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

const MEMO_OPENING_LINES: readonly string[] = [
  "This message continues a conversation that is already under way; it is not a new instruction.",
  "What follows is a bounded summary of that conversation, not its verbatim record.",
];

const MEMO_TRANSCRIPT_SEPARATOR = "---";

/**
 * What a body the fold could not read renders as: an empty body would render as no turn at all,
 * and the declared loss does not reach this text.
 */
const MEMO_UNAVAILABLE_BODY_TEXT: string = "(this content could not be recovered)";

function renderSegment(segment: CanonicalTranscriptSegment): string | undefined {
  const contentUnavailable: boolean = segmentContentIsUnavailable(segment);
  switch (segment.kind) {
    case "text":
      if (contentUnavailable) {
        return MEMO_UNAVAILABLE_BODY_TEXT;
      }
      return segment.text.length === 0 ? undefined : segment.text;
    case "reasoning":
      // Unreachable after the strip, which drops private reasoning and flattens visible reasoning.
      return segment.text.length === 0 ? undefined : segment.text;
    case "tool_call": {
      const body: string = contentUnavailable ? MEMO_UNAVAILABLE_BODY_TEXT : segment.argumentsJson;
      return `[tool call ${segment.toolName} (${segment.toolCallId})] ${body}`;
    }
    case "tool_result": {
      const body: string = contentUnavailable ? MEMO_UNAVAILABLE_BODY_TEXT : segment.text;
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
  return `Earlier parts of this conversation are omitted from the summary: ${shown.toString()} of ${totalExchangeCount.toString()} exchanges appear below in log order, and may not be consecutive.`;
}

/** The pieces one assembled memo body is composed from, in emission order. */
interface MemoBodyAssembly {
  readonly openingText: string;
  readonly markerText: string;
  /** Already rendered, in log order. */
  readonly exchangeRenderings: readonly string[];
  readonly evictedExchangeCount: number;
  readonly totalExchangeCount: number;
}

/**
 * Composes the memo prose from the preamble and the admitted exchanges. Admission pricing and
 * emission both use it, so a candidate is priced as the exact text sent, separators included.
 */
function assembleMemoBody(assembly: MemoBodyAssembly): string {
  const bodyLines: string[] = [assembly.openingText, assembly.markerText];
  if (assembly.evictedExchangeCount > 0) {
    bodyLines.push(
      renderEvictionNotice(assembly.evictedExchangeCount, assembly.totalExchangeCount),
    );
  }
  bodyLines.push(MEMO_TRANSCRIPT_SEPARATOR);
  bodyLines.push(...assembly.exchangeRenderings);
  return bodyLines.join("\n");
}

/** What `MemoProjection.render` reads: the projection, the target and the budget. */
export interface MemoRenderRequest {
  readonly projection: CanonicalTranscriptProjection;
  readonly target: MemoTargetIdentity;
  readonly budget: MemoBudgetPolicy;
}

/** The bounded memo prose plus what the budget kept and dropped. */
export interface MemoRendering {
  readonly memoIdentityKey: string;
  /** The exact prose the memo turn carries, marker included. */
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
 * Renders the canonical projection into the bounded prose the memo floor sends. Stateless:
 * `render` reads only its argument, so the memo is rebuilt from the log on every send and a
 * caller cannot hold a stale rendering.
 */
export class MemoProjection {
  readonly #estimateTokens: MemoTokenEstimator;

  constructor(estimateTokens: MemoTokenEstimator = DEFAULT_MEMO_TOKEN_ESTIMATOR) {
    this.#estimateTokens = estimateTokens;
  }

  render(request: MemoRenderRequest): MemoRendering {
    const memoIdentityKey: string = deriveMemoIdentityKey(request.projection, request.target);

    // Strip what no other model may be shown, then repair the results the strip orphaned (an
    // unpaired call is accepted silently and rejected on every later request). Prose needs no frame
    // steps.
    const transformed: {
      turns: readonly CanonicalTranscriptTurn[];
      losses: readonly DeclaredLossKind[];
    } = applyPortabilityTransforms(request.projection);

    const exchanges: readonly TranscriptExchange[] = partitionIntoExchanges(transformed.turns);
    const budgetTokens: number = Math.max(
      0,
      Math.floor(request.budget.targetContextWindowTokens * request.budget.budgetFraction),
    );

    const protectedIndices: ReadonlySet<number> = computeProtectedExchangeIndices(
      exchanges,
      request.budget.protectedTailToolExchangeCount,
    );

    const openingText: string = MEMO_OPENING_LINES.join("\n");
    // Rendered once; the admission walk re-joins them per candidate.
    const exchangeRenderings: readonly string[] = exchanges.map(renderExchange);

    const preBudgetLosses: readonly DeclaredLossKind[] = orderDeclaredLosses([
      ...transformed.losses,
      // Always declared: an empty list would claim nothing was dropped.
      MEMO_FLOOR_DECLARED_LOSS_KIND,
    ]);
    // The marker records truncation, so its length depends on the outcome it helps decide: price
    // every candidate against the longer, truncation-inclusive marker. The emitted text is measured
    // separately below, so a non-monotone tokenizer shows as `exceedsBudget`, not a silent overrun.
    const pricingMarkerText: string = renderMemoContinuityMarker(
      memoIdentityKey,
      orderDeclaredLosses([...preBudgetLosses, "context_truncated"]),
    );

    // Priced over the whole assembled candidate: summing per-exchange prices undercounts separators
    // and assumes an additivity the injected estimator does not owe.
    const assembleFor = (admittedIndices: ReadonlySet<number>, markerText: string): string =>
      assembleMemoBody({
        openingText,
        markerText,
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
      if (this.#estimateTokens(assembleFor(includedIndices, pricingMarkerText)) > budgetTokens) {
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

    // Measured with the marker it will be sent with, so `estimatedTokens` prices the emitted text.
    const text: string = assembleFor(
      includedIndices,
      renderMemoContinuityMarker(memoIdentityKey, declaredLosses),
    );
    const estimatedTokens: number = this.#estimateTokens(text);

    return {
      memoIdentityKey,
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

function applyPortabilityTransforms(projection: CanonicalTranscriptProjection): {
  turns: readonly CanonicalTranscriptTurn[];
  losses: readonly DeclaredLossKind[];
} {
  let state: TranscriptPipelineState = createTranscriptPipelineState(projection);
  state = foldTurns(state);
  state = stripNonPortableContent(state);
  state = repairPairingIntegrity(state);
  return { turns: state.turns, losses: state.declaredLosses };
}

function orderDeclaredLosses(losses: readonly DeclaredLossKind[]): readonly DeclaredLossKind[] {
  const present: Set<DeclaredLossKind> = new Set<DeclaredLossKind>(losses);
  return DECLARED_LOSS_KINDS.filter((kind) => present.has(kind));
}
