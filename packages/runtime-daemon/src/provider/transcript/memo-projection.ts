// The memo floor: the fallback that stands in when a conversation cannot be reconstituted
// natively. It renders the canonical projection as bounded prose and delivers it at most once.
//
//   * The budget is a fraction of the target's context window, never an absolute token count.
//   * Eviction removes whole exchanges only, and the newest tool exchanges are protected.
//   * The once-only key derives from the raw projection (before the transforms and the budget) and
//     the target session, and rides as visible ASCII in the memo turn. It leaves out
//     `builtAtPosition`, which moves on any append. Nothing durable is written.
//   * An ambiguous send stays unconfirmed until the marker appears or an absence is read after the
//     caller's settlement barrier: a duplicate memo corrupts the conversation, a missing one only
//     degrades it. The caller decides whether native replay already succeeded.

import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type {
  CanonicalTranscriptProjection,
  CanonicalTranscriptSegment,
  CanonicalTranscriptTurn,
  DeclaredLossKind,
  DriverTranscriptReplayResult,
} from "@ai-sidekicks/contracts";

import { DECLARED_LOSS_KINDS } from "@ai-sidekicks/contracts";

import type { OutboundTextFrame } from "../drivers/outbound-frame.js";
import { OutboundTextFrameWriter } from "../drivers/outbound-frame.js";

import {
  createTranscriptPipelineState,
  foldTurns,
  repairPairingIntegrity,
  segmentContentIsUnavailable,
  stripNonPortableContent,
  type TranscriptPipelineState,
} from "./transform-pipeline.js";

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
const MEMO_IDENTITY_KEY_BYTE_LENGTH = 16;

/** The visible marker prefix: lowercase ASCII with no punctuation a provider would reflow. */
export const MEMO_CONTINUITY_MARKER_PREFIX: string = "continuity-ref:";

/** Separates the key from the record of what the memo carrying it dropped. */
const MEMO_CONTINUITY_LOSS_SEPARATOR = ";dropped=";

/** Joins the recorded loss kinds. Not a comma: a comma invites a space after it. */
const MEMO_CONTINUITY_LOSS_JOINER = "+";

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
const MEMO_FLOOR_DECLARED_LOSS_KIND: DeclaredLossKind = "conversation_history_summarized";

/**
 * Characters that continue a token, so a marker abutting one is part of something longer. Without
 * the boundary, a memo whose key merely extends ours would read as this memo delivered.
 */
const MEMO_MARKER_TOKEN_CHARACTER = /[A-Za-z0-9_-]/;

/** One syntactically complete marker occurrence in a target turn, whatever memo wrote it. */
type MemoContinuityMarkerOccurrence =
  | {
      readonly form: "recorded";
      readonly memoIdentityKey: string;
      readonly kinds: ReadonlySet<DeclaredLossKind>;
    }
  | { readonly form: "key-only"; readonly memoIdentityKey: string }
  | { readonly form: "unreadable-record"; readonly memoIdentityKey: string };

/** A record's parse, before the scanner attaches the key that carried it. */
type MemoContinuityRecordReading =
  | { readonly form: "recorded"; readonly kinds: ReadonlySet<DeclaredLossKind> }
  | { readonly form: "unreadable-record" };

/** The identity key's exact wire shape: lowercase hex, two characters per digest byte. */
const MEMO_IDENTITY_KEY_TEXT_PATTERN: RegExp = new RegExp(
  `^[0-9a-f]{${String(MEMO_IDENTITY_KEY_BYTE_LENGTH * 2)}}`,
);

/**
 * Every complete continuity marker in the target's turns, whichever memo wrote it, in read order.
 * It scans for any key because a grown projection derives a new key. A key counts only in its
 * exact shape at token boundaries; a complete marker with a garbage record is still a marker.
 */
function readAnyMemoContinuityMarkerOccurrences(
  targetTurns: readonly string[],
): readonly MemoContinuityMarkerOccurrence[] {
  const occurrences: MemoContinuityMarkerOccurrence[] = [];
  for (const turnText of targetTurns) {
    for (
      let markerStart: number = turnText.indexOf(MEMO_CONTINUITY_MARKER_PREFIX);
      markerStart >= 0;
      markerStart = turnText.indexOf(
        MEMO_CONTINUITY_MARKER_PREFIX,
        markerStart + MEMO_CONTINUITY_MARKER_PREFIX.length,
      )
    ) {
      const precedingCharacter: string = turnText.slice(Math.max(0, markerStart - 1), markerStart);
      if (precedingCharacter !== "" && MEMO_MARKER_TOKEN_CHARACTER.test(precedingCharacter)) {
        continue;
      }
      const afterPrefix: string = turnText.slice(
        markerStart + MEMO_CONTINUITY_MARKER_PREFIX.length,
      );
      const memoIdentityKey: string | undefined =
        MEMO_IDENTITY_KEY_TEXT_PATTERN.exec(afterPrefix)?.[0];
      if (memoIdentityKey === undefined) {
        continue;
      }
      const tail: string = afterPrefix.slice(memoIdentityKey.length);
      if (!tail.startsWith(MEMO_CONTINUITY_LOSS_SEPARATOR)) {
        // The key-only form is complete only where the token ends.
        const followingCharacter: string = tail.slice(0, 1);
        if (followingCharacter !== "" && MEMO_MARKER_TOKEN_CHARACTER.test(followingCharacter)) {
          continue;
        }
        occurrences.push({ form: "key-only", memoIdentityKey });
        continue;
      }
      occurrences.push({
        ...readMemoContinuityRecord(tail.slice(MEMO_CONTINUITY_LOSS_SEPARATOR.length)),
        memoIdentityKey,
      });
    }
  }
  return occurrences;
}

/** The occurrences of one memo's marker: the any-key grammar, filtered by key. */
function readMemoContinuityMarkerOccurrences(
  targetTurns: readonly string[],
  memoIdentityKey: string,
): readonly MemoContinuityMarkerOccurrence[] {
  return readAnyMemoContinuityMarkerOccurrences(targetTurns).filter(
    (occurrence) => occurrence.memoIdentityKey === memoIdentityKey,
  );
}

/**
 * Parses one record (the text after `;dropped=`) strictly: a `+`-joined list of recognized kinds
 * that includes the floor's own kind. This writer never emits a list without it, so reading one as
 * "nothing lost" would be a false guarantee.
 */
function readMemoContinuityRecord(record: string): MemoContinuityRecordReading {
  // Anything but lowercase ASCII, `_` and `+` (a space, a newline, following prose) ends the
  // record.
  const tokenRun: string = /^[a-z_+]*/.exec(record)?.[0] ?? "";
  if (tokenRun.length === 0) {
    return { form: "unreadable-record" };
  }
  const kinds: Set<DeclaredLossKind> = new Set<DeclaredLossKind>();
  for (const component of tokenRun.split(MEMO_CONTINUITY_LOSS_JOINER)) {
    const kind: DeclaredLossKind | undefined = DECLARED_LOSS_KINDS.find(
      (candidate) => candidate === component,
    );
    if (kind === undefined) {
      return { form: "unreadable-record" };
    }
    kinds.add(kind);
  }
  if (!kinds.has(MEMO_FLOOR_DECLARED_LOSS_KIND)) {
    return { form: "unreadable-record" };
  }
  return { form: "recorded", kinds };
}

/**
 * Whether any target turn carries a complete marker for an attributable key: one attempted
 * against this target (a grown projection derives a new key) or the one being delivered now. Any
 * key would let a pasted foreign marker pass; a false yes loses the context transfer, while a
 * false no costs one extra summary.
 */
export function targetTurnsCarryAttributableMemoMarker(
  targetTurns: readonly string[],
  attributableMemoIdentityKeys: ReadonlySet<string>,
): boolean {
  return readAnyMemoContinuityMarkerOccurrences(targetTurns).some((occurrence) =>
    attributableMemoIdentityKeys.has(occurrence.memoIdentityKey),
  );
}

/**
 * Whether any target turn carries a complete marker for this memo's key, that is, whether the send
 * just made landed. Deliveries are serialized per target, so a readback can only newly find it.
 */
export function targetTurnsCarryMemoMarker(
  targetTurns: readonly string[],
  memoIdentityKey: string,
): boolean {
  return readMemoContinuityMarkerOccurrences(targetTurns, memoIdentityKey).length > 0;
}

/**
 * The union of the loss kinds the memo already in the target recorded as dropped, or `undefined`
 * with no marker or any occurrence lacking a readable record; the caller then owes the
 * conservative answer.
 */
export function readDeliveredMemoDeclaredLosses(
  targetTurns: readonly string[],
  memoIdentityKey: string,
): readonly DeclaredLossKind[] | undefined {
  const occurrences: readonly MemoContinuityMarkerOccurrence[] =
    readMemoContinuityMarkerOccurrences(targetTurns, memoIdentityKey);
  if (occurrences.length === 0) {
    return undefined;
  }
  const recorded: Set<DeclaredLossKind> = new Set<DeclaredLossKind>();
  for (const occurrence of occurrences) {
    if (occurrence.form !== "recorded") {
      return undefined;
    }
    for (const kind of occurrence.kinds) {
      recorded.add(kind);
    }
  }
  return DECLARED_LOSS_KINDS.filter((kind) => recorded.has(kind));
}

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

/** The frame handed to the gateway, minted `system_narration`; the driver owns encoding. */
export interface MemoOutboundFrame {
  readonly targetProviderSessionId: string;
  readonly memoIdentityKey: string;
  readonly frame: OutboundTextFrame;
}

/** The target as this floor sees it: the read reconciliation rests on, and the one send. */
export interface MemoTargetGateway {
  /**
   * Turns of the named session (the id `sendMemoTurn` is handed) as text, to decide whether the
   * marker is present. Must cover the whole session, not a tail, or a scrolled-out marker causes a
   * second memo. Rejecting means unreadable and never licenses a send.
   */
  readTurnsForMarkerReconciliation(targetProviderSessionId: string): Promise<readonly string[]>;
  /** Delivers the memo turn. A rejection is ambiguous: the frame may have been applied. */
  sendMemoTurn(frame: MemoOutboundFrame): Promise<void>;
}

/**
 * A caller-supplied bounded wait that resolves once the target has settled any earlier ambiguous
 * send, so an absent marker read afterwards is definitive. Rejecting or absent leaves delivery
 * unconfirmed; a barrier that resolves early is a caller error nothing here can catch.
 */
export type MemoSendSettlementBarrier = () => Promise<void>;

/** One delivery: the projection, the established target, the budget, and an optional barrier. */
export interface MemoDeliveryRequest {
  readonly projection: CanonicalTranscriptProjection;
  /** An established handle, not a bare identity: only its minting coordinator may deliver. */
  readonly target: EstablishedMemoTarget;
  readonly budget: MemoBudgetPolicy;
  /** Optional. Without it an ambiguous send stays unconfirmed; a late memo still settles. */
  readonly sendSettlementBarrier?: MemoSendSettlementBarrier | undefined;
}

/**
 * `delivered` and `already-delivered` mean the target holds the memo; `withheld` means nothing was
 * sent; `unconfirmed` means a send is outstanding and unknown, and persists across calls until
 * evidence moves it.
 */
type MemoDeliveryDisposition = "delivered" | "already-delivered" | "withheld" | "unconfirmed";

/** Why nothing reached the target; `send-refused` needs a later call's barrier, not a rejection. */
type MemoWithheldReason = "target-unreadable" | "send-refused";

/**
 * Which memo `declaredLosses` describes: this call's render, the memo already on the target
 * (possibly rendered under a tighter budget), or `unknown` when its record was unreadable, where
 * the list is the whole producible set as an upper bound.
 */
type MemoDeclaredLossSource = "this-delivery" | "delivered-memo" | "unknown";

/** The outcome of one delivery: its disposition, the declared losses, and the rendering. */
export interface MemoDeliverySettlement {
  /** Always `degraded`: `applied` would tell the user the model sees the conversation. */
  readonly status: "degraded";
  readonly disposition: MemoDeliveryDisposition;
  readonly memoIdentityKey: string;
  readonly declaredLosses: readonly DeclaredLossKind[];
  /** Which memo `declaredLosses` describes. */
  readonly declaredLossSource: MemoDeclaredLossSource;
  readonly withheldReason?: MemoWithheldReason | undefined;
  /** What was rendered, whether or not it was sent. Held in memory only. */
  readonly rendering: MemoRendering;
}

/**
 * Reconciles, then sends, then settles: at most one send per call, only after a read that found no
 * marker and no unresolved earlier send. Guards are in-memory and per coordinator (one delivery
 * per target at a time; an ambiguous send blocks the target); a restart relies on the reconcile.
 */
export class MemoDeliveryCoordinator {
  readonly #gateway: MemoTargetGateway;
  readonly #projection: MemoProjection;
  readonly #frameWriter: OutboundTextFrameWriter;
  /** Targets by provider session id; a foreign handle or a bare `new` is refused by identity. */
  readonly #establishedTargets: Map<string, EstablishedMemoTarget> = new Map<
    string,
    EstablishedMemoTarget
  >();
  /**
   * The delivery in flight into each target id, with the key of the memo it rendered. Target-scoped
   * because two overlapping calls with different keys would each find no marker and both send.
   */
  readonly #deliveriesInFlight: Map<string, MemoDeliveryInFlight> = new Map<
    string,
    MemoDeliveryInFlight
  >();
  /**
   * Targets whose last send was ambiguous (memory only). Keyed by target, not (target, memo), since
   * a grown projection derives a new key. Unbounded on purpose: evicting an entry would give up the
   * guarantee, so entries leave on evidence only.
   */
  readonly #unconfirmedDeliveries: Set<string> = new Set<string>();
  /**
   * Memo keys attempted per target, recorded before dispatch so an ambiguous send's marker is
   * attributable. A marker under an unrecorded key is foreign prose and settles nothing. Unbounded
   * on purpose, like the register above.
   */
  readonly #attemptedMemoIdentityKeysByTarget: Map<string, Set<string>> = new Map<
    string,
    Set<string>
  >();

  /**
   * The frame writer defaults to `emulated`, which neutralizes; a `native` caller supplies its own
   * writer, so an undeclared caller cannot opt out of the boundary.
   */
  constructor(
    gateway: MemoTargetGateway,
    projection: MemoProjection = new MemoProjection(),
    frameWriter: OutboundTextFrameWriter = new OutboundTextFrameWriter({
      mechanismGrade: "emulated",
    }),
  ) {
    this.#gateway = gateway;
    this.#projection = projection;
    this.#frameWriter = frameWriter;
  }

  /**
   * Mints the handle a delivery is addressed to, asserting the target is fresh (which this
   * coordinator cannot verify; see {@link EstablishedMemoTarget}). Idempotent per provider session
   * and never touches the unconfirmed register.
   */
  establishTarget(target: MemoTargetIdentity): EstablishedMemoTarget {
    const alreadyEstablished: EstablishedMemoTarget | undefined = this.#establishedTargets.get(
      target.providerSessionId,
    );
    if (alreadyEstablished !== undefined) {
      return alreadyEstablished;
    }
    const established: EstablishedMemoTarget = new EstablishedMemoTarget(target.providerSessionId);
    this.#establishedTargets.set(target.providerSessionId, established);
    return established;
  }

  async deliver(request: MemoDeliveryRequest): Promise<MemoDeliverySettlement> {
    // Before anything is rendered, read or sent. Thrown, not settled `withheld`, which would assert
    // the target was never sent to.
    if (this.#establishedTargets.get(request.target.providerSessionId) !== request.target) {
      throw new UnownedMemoTargetError(request.target.providerSessionId);
    }

    // Rendering is pure, so overlapping callers may both do it.
    const rendering: MemoRendering = this.#projection.render({
      projection: request.projection,
      target: request.target,
      budget: request.budget,
    });

    const targetProviderSessionId: string = request.target.providerSessionId;
    // One delivery per target at a time. The same key shares the in-flight settlement, even under
    // another budget; a different key waits the flight out, then reconciles against what it seeded.
    // Terminates: an entry leaves the map when its owner settles.
    for (;;) {
      const inFlight: MemoDeliveryInFlight | undefined =
        this.#deliveriesInFlight.get(targetProviderSessionId);
      if (inFlight === undefined) {
        break;
      }
      if (inFlight.memoIdentityKey === rendering.memoIdentityKey) {
        return await inFlight.settlement;
      }
      // Awaited for completion only; this call derives its own settlement from the target.
      await inFlight.settlement.then(
        () => undefined,
        () => undefined,
      );
    }

    const flight: Promise<MemoDeliverySettlement> = this.#reconcileThenSend(request, rendering);
    this.#deliveriesInFlight.set(targetProviderSessionId, {
      memoIdentityKey: rendering.memoIdentityKey,
      settlement: flight,
    });
    try {
      return await flight;
    } finally {
      // Cleared however the flight ended. The unconfirmed register is kept on purpose: an ambiguous
      // send outlives its call.
      this.#deliveriesInFlight.delete(targetProviderSessionId);
    }
  }

  async #reconcileThenSend(
    request: MemoDeliveryRequest,
    rendering: MemoRendering,
  ): Promise<MemoDeliverySettlement> {
    // A target left ambiguous is possibly applied until evidence says otherwise. The barrier is
    // awaited before the read, which is definitive only after the provider settled that send.
    const priorSendUnconfirmed: boolean = this.#unconfirmedDeliveries.has(
      request.target.providerSessionId,
    );
    const priorSendSettled: boolean = priorSendUnconfirmed
      ? await awaitSendSettlement(request)
      : false;

    let priorTurns: readonly string[];
    try {
      priorTurns = await this.#gateway.readTurnsForMarkerReconciliation(
        request.target.providerSessionId,
      );
    } catch {
      // Unreadable: nothing is sent, since a duplicate corrupts the conversation and a missing memo
      // only degrades it. With a send outstanding the honest arm is unconfirmed, not withheld.
      return priorSendUnconfirmed
        ? settle(rendering, "unconfirmed", undefined, thisDeliveryLosses(rendering))
        : settle(rendering, "withheld", "target-unreadable", thisDeliveryLosses(rendering));
    }

    const attributableMemoIdentityKeys: Set<string> = new Set<string>(
      this.#attemptedMemoIdentityKeysByTarget.get(request.target.providerSessionId),
    );
    attributableMemoIdentityKeys.add(rendering.memoIdentityKey);
    if (targetTurnsCarryAttributableMemoMarker(priorTurns, attributableMemoIdentityKeys)) {
      // The one evidence needing no barrier: the target is seeded by this memo, an earlier key this
      // coordinator attempted, or an outstanding send now known applied (it is the only sender
      // into an established target). The target leaves the register and nothing more is sent.
      this.#unconfirmedDeliveries.delete(request.target.providerSessionId);
      return settle(
        rendering,
        "already-delivered",
        undefined,
        deliveredMemoLosses(priorTurns, rendering.memoIdentityKey),
      );
    }

    if (priorSendUnconfirmed) {
      if (!priorSendSettled) {
        // Marker absent and the earlier send may still be applying: report again, send nothing.
        return settle(rendering, "unconfirmed", undefined, thisDeliveryLosses(rendering));
      }
      // The barrier ordered this read behind the earlier send and no marker is there: it did not
      // land. Nothing is sent here, since that is no evidence about a new send; the target leaves
      // the register, so the next delivery is an ordinary first attempt.
      this.#unconfirmedDeliveries.delete(request.target.providerSessionId);
      return settle(rendering, "withheld", "send-refused", thisDeliveryLosses(rendering));
    }

    // Recorded before dispatch so the marker of a send that throws below is attributable.
    let attemptedKeysForTarget: Set<string> | undefined =
      this.#attemptedMemoIdentityKeysByTarget.get(request.target.providerSessionId);
    if (attemptedKeysForTarget === undefined) {
      attemptedKeysForTarget = new Set<string>();
      this.#attemptedMemoIdentityKeysByTarget.set(
        request.target.providerSessionId,
        attemptedKeysForTarget,
      );
    }
    attemptedKeysForTarget.add(rendering.memoIdentityKey);
    try {
      await this.#gateway.sendMemoTurn({
        targetProviderSessionId: request.target.providerSessionId,
        memoIdentityKey: rendering.memoIdentityKey,
        frame: this.#frameWriter.compose({
          text: rendering.text,
          origin: "system_narration",
        }),
      });
      return settle(rendering, "delivered", undefined, thisDeliveryLosses(rendering));
    } catch {
      // Ambiguous; registered before anything can throw. The barrier is not consulted here: nothing
      // proves a send just made has settled, and an unobserved resolve would clear the register and
      // let the next call send a duplicate.
      this.#unconfirmedDeliveries.add(request.target.providerSessionId);
      let turnsAfterSend: readonly string[];
      try {
        turnsAfterSend = await this.#gateway.readTurnsForMarkerReconciliation(
          request.target.providerSessionId,
        );
      } catch {
        return settle(rendering, "unconfirmed", undefined, thisDeliveryLosses(rendering));
      }
      if (targetTurnsCarryMemoMarker(turnsAfterSend, rendering.memoIdentityKey)) {
        // The memo is visibly there, so the unacknowledged send applied; no ordering is needed.
        this.#unconfirmedDeliveries.delete(request.target.providerSessionId);
        // Losses come from the marker; one with no record is not the memo this call composed, so it
        // takes the conservative arm.
        return settle(
          rendering,
          "delivered",
          undefined,
          deliveredMemoLosses(turnsAfterSend, rendering.memoIdentityKey),
        );
      }
      // One absent snapshot while the provider may still be applying is not evidence.
      return settle(rendering, "unconfirmed", undefined, thisDeliveryLosses(rendering));
    }
  }
}

/**
 * Awaits the caller's barrier; true means a readback taken next is definitive. An absent and a
 * rejected barrier both give false, since a bounded wait expiring is the ordinary unanswered case.
 */
async function awaitSendSettlement(request: MemoDeliveryRequest): Promise<boolean> {
  const barrier: MemoSendSettlementBarrier | undefined = request.sendSettlementBarrier;
  if (barrier === undefined) {
    return false;
  }
  try {
    await barrier();
    return true;
  } catch {
    return false;
  }
}

interface MemoDeliveryInFlight {
  readonly memoIdentityKey: string;
  readonly settlement: Promise<MemoDeliverySettlement>;
}

function settle(
  rendering: MemoRendering,
  disposition: MemoDeliveryDisposition,
  withheldReason: MemoWithheldReason | undefined,
  lossRecord: MemoDeclaredLossRecord,
): MemoDeliverySettlement {
  return {
    status: "degraded",
    disposition,
    memoIdentityKey: rendering.memoIdentityKey,
    declaredLosses: lossRecord.losses,
    declaredLossSource: lossRecord.source,
    withheldReason,
    rendering,
  };
}

interface MemoDeclaredLossRecord {
  readonly source: MemoDeclaredLossSource;
  readonly losses: readonly DeclaredLossKind[];
}

function thisDeliveryLosses(rendering: MemoRendering): MemoDeclaredLossRecord {
  return { source: "this-delivery", losses: rendering.declaredLosses };
}

/**
 * Losses recorded by the memo the target holds, for settlements resting on a read marker. Only
 * when every occurrence is a readable record of this memo; otherwise the whole closed vocabulary,
 * as an unparsed marker may hold kinds a newer peer daemon wrote, and understating misleads.
 */
function deliveredMemoLosses(
  targetTurns: readonly string[],
  memoIdentityKey: string,
): MemoDeclaredLossRecord {
  const occurrences: readonly MemoContinuityMarkerOccurrence[] =
    readAnyMemoContinuityMarkerOccurrences(targetTurns);
  const recorded: Set<DeclaredLossKind> = new Set<DeclaredLossKind>();
  for (const occurrence of occurrences) {
    if (occurrence.form !== "recorded" || occurrence.memoIdentityKey !== memoIdentityKey) {
      return { source: "unknown", losses: DECLARED_LOSS_KINDS };
    }
    for (const kind of occurrence.kinds) {
      recorded.add(kind);
    }
  }
  return occurrences.length === 0
    ? { source: "unknown", losses: DECLARED_LOSS_KINDS }
    : { source: "delivered-memo", losses: [...recorded] };
}

/** Thrown when a settlement that established no delivery is asked for a boundary result. */
export class MemoDeliveryNotEstablishedError extends Error {
  readonly settlement: MemoDeliverySettlement;

  constructor(settlement: MemoDeliverySettlement) {
    super(
      `The memo floor established no delivery (${settlement.disposition}${
        settlement.withheldReason === undefined ? "" : `: ${settlement.withheldReason}`
      }); there is no replay result to report.`,
    );
    this.name = "MemoDeliveryNotEstablishedError";
    this.settlement = settlement;
  }
}

/**
 * Maps a settlement to the driver-boundary result (`degraded`, never `applied`). `withheld` and
 * `unconfirmed` throw `MemoDeliveryNotEstablishedError` because the result has no failure arm. The
 * loss list is unqualified here; `renderReconstitutionDisclosure` states its subject.
 */
export function memoSettlementAsReplayResult(
  settlement: MemoDeliverySettlement,
): DriverTranscriptReplayResult {
  switch (settlement.disposition) {
    case "delivered":
    case "already-delivered":
      return { status: "degraded", declaredLosses: [...settlement.declaredLosses] };
    case "withheld":
    case "unconfirmed":
      throw new MemoDeliveryNotEstablishedError(settlement);
    default: {
      // Exhaustive: a new disposition is a type error here.
      void (settlement.disposition satisfies never);
      throw new MemoDeliveryNotEstablishedError(settlement);
    }
  }
}

/** What the caller's native-replay attempt came to, as a value; this module calls no driver. */
export type NativeReplayDisposition =
  | { readonly outcome: "applied"; readonly declaredLosses: readonly DeclaredLossKind[] }
  | { readonly outcome: "unavailable" }
  | { readonly outcome: "refused" }
  | { readonly outcome: "context-window-exceeded" };

/**
 * What one reconstitution came to, per route. The memo arm carries the settlement, not a replay
 * result, so the type cannot hold a result for a memo that never landed.
 */
export type ReconstitutionSettlement =
  | { readonly route: "native-replay"; readonly result: DriverTranscriptReplayResult }
  | { readonly route: "memo"; readonly memo: MemoDeliverySettlement };

/**
 * Raised when a native replay is reported `applied` yet declares `conversation_history_summarized`;
 * the two are exclusive. The schema refuses it at parse, but this router builds results unparsed.
 * Thrown, not corrected: only the caller knows which claim is true.
 */
export class ContradictoryReplayDispositionError extends Error {
  readonly disposition: NativeReplayDisposition;

  constructor(disposition: NativeReplayDisposition) {
    super(
      "A native-replay disposition reported 'applied' while declaring " +
        "'conversation_history_summarized', which names the memo floor standing in for " +
        "the conversation; a replay cannot both have landed the conversation and have " +
        "been summarized away, so no reconstitution settlement is reported for it.",
    );
    this.name = "ContradictoryReplayDispositionError";
    this.disposition = disposition;
  }
}

/** Routes a reconstitution to native replay's settlement or the memo floor. */
export class TranscriptReconstitutionRouter {
  readonly #coordinator: MemoDeliveryCoordinator;

  constructor(coordinator: MemoDeliveryCoordinator) {
    this.#coordinator = coordinator;
  }

  async route(
    disposition: NativeReplayDisposition,
    request: MemoDeliveryRequest,
  ): Promise<ReconstitutionSettlement> {
    if (disposition.outcome === "applied") {
      // Checked here: this result is built from a literal, never parsed, and the flat type cannot
      // enforce the schema's arm scoping.
      if (disposition.declaredLosses.includes("conversation_history_summarized")) {
        throw new ContradictoryReplayDispositionError(disposition);
      }
      return {
        route: "native-replay",
        result: { status: "applied", declaredLosses: [...disposition.declaredLosses] },
      };
    }
    // Returned for every disposition, unlanded ones included: a withheld or unconfirmed delivery is
    // a report the user is owed. A caller owing a boundary result uses
    // `memoSettlementAsReplayResult` and takes its throw.
    const memo: MemoDeliverySettlement = await this.#coordinator.deliver(request);
    return { route: "memo", memo };
  }
}

/**
 * The one renderer both routes pass through, so an applied replay and a memo settlement (landed
 * or not) never read the same; a degraded one reading as applied would hide the summary.
 */
export function renderReconstitutionDisclosure(settlement: ReconstitutionSettlement): string {
  const declaredLosses: readonly DeclaredLossKind[] =
    settlement.route === "native-replay"
      ? settlement.result.declaredLosses
      : settlement.memo.declaredLosses;
  const losses: string =
    declaredLosses.length === 0 ? "nothing was dropped" : declaredLosses.join(", ");

  if (settlement.route === "native-replay") {
    // "In full" is a claim an applied replay may make only when its declared-loss list is empty;
    // "In full" only when nothing was dropped; beside a loss list it contradicts itself.
    return settlement.result.declaredLosses.length === 0
      ? `The prior conversation was replayed into the new session in full (${losses}).`
      : `The prior conversation was replayed into the new session, apart from what could not be carried across (${losses}).`;
  }

  // A settlement resting on an existing summary knows only what that summary recorded; where it
  // recorded nothing, state an upper bound as one.
  const memoLosses: string =
    settlement.memo.declaredLossSource === "unknown"
      ? `what that summary dropped is not recorded; at most ${losses}`
      : losses;

  switch (settlement.memo.disposition) {
    case "delivered":
      return `The prior conversation was summarized rather than replayed; the new session holds a bounded summary of it (${memoLosses}).`;
    case "already-delivered":
      return `The prior conversation was summarized rather than replayed; the new session already held that summary and it was not sent again (${memoLosses}).`;
    case "withheld":
      return `The prior conversation was summarized rather than replayed, and the summary did not reach the new session (${memoLosses}).`;
    case "unconfirmed":
      return `The prior conversation was summarized rather than replayed, and whether the summary reached the new session could not be confirmed (${memoLosses}).`;
    default:
      return `The prior conversation was summarized rather than replayed (${memoLosses}).`;
  }
}
