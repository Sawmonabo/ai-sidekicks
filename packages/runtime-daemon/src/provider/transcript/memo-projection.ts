// The memo projection floor — the daemon-side fallback that stands in when a
// conversation cannot be reconstituted natively (Plan-005 Phase 3, T3.21).
//
// `Spec-005 §Canonical Transcript Export And Replay` states four normative
// properties for this floor, and this module is shaped so each is a mechanism
// rather than a promise:
//
//   * A budget expressed as a FRACTION of the target's context window, never an
//     absolute token count, so the same rule holds across models with different
//     windows.
//   * A protected tail of the most recent tool exchanges the budget may not
//     evict, with eviction operating on WHOLE exchanges — a call and its result
//     travel together, under any budget.
//   * Once-only delivery under a DERIVED memo-identity key rather than a durable
//     claim, carried on the sent memo turn as a VISIBLE marker.
//   * Rebuilt from the log every send, like the transcript itself, rather than
//     pinned at fallback time.
//
// ---------------------------------------------------------------------------
// Why there is no claim row, and what stands in for one
// ---------------------------------------------------------------------------
//
// A claim written before the send and released on failure needs a durable owner
// and has none: `runtime_bindings` is ruled out for recovery state and the local
// schema carries no generic claim store, so a claim would mint a table to hold a
// single in-flight marker for something the event log already determines — the
// second record of an ordered fact ADR-029 rejects on its own terms.
//
// Once-only delivery therefore rests on two legs that are each inert alone:
//
//   DERIVATION supplies the key without storing it. `deriveMemoIdentityKey` is a
//   pure function of the canonical projection's CONTENT and the target session's
//   identity, so any daemon, at any time, after any restart, recomputes it from
//   state that is already durable.
//
//   CARRIAGE puts the value in the target to be found. The key is rendered into
//   the memo turn's own prose as visible ASCII — never an invisible or
//   zero-width sentinel, which `Spec-005 §Pitfalls To Avoid` prohibits outright.
//
// So EVERY send reconciles first: recompute the key, read the target's recent
// turns for it, treat a match as already delivered. The ambiguous send — a
// timeout, a dropped connection, a restart between send and acknowledgment —
// needs no special path, because the unknown resolves the way every other
// pre-send question does, by reading the target. Where the target cannot be read
// back, NOTHING is sent and the operation settles on what did land: a duplicated
// memo corrupts the conversation the participant is watching, while a missing one
// only degrades it, visibly. Rollback-then-retry is not merely discouraged here
// but unrepresentable, there being no claim to roll back.
//
// This module mints no table, no column, and no migration, and writes nothing
// durable on any path. It holds no persistence collaborator at all — the only
// injected surface is the target gateway below.
//
// ---------------------------------------------------------------------------
// Why the key is derived over the RAW projection
// ---------------------------------------------------------------------------
//
// The key identifies the SWITCH, not the rendering. Deriving it over the
// projection's turns before the portability transforms and before the budget
// means a later change to how the memo is worded, stripped, or evicted produces
// different prose under the SAME key — so one switch still yields one memo. A key
// derived over the rendered body would make every renderer change look like a new
// memo to reconciliation, and the second send would land.
//
// It is deliberately NOT derived over `CanonicalTranscriptProjection.builtAtPosition`.
// That member is the newest sequence over the WHOLE session log and moves on any
// append anywhere in the session, including one belonging to a different run — so
// a key resting on it would differ between two daemons reading the same switch a
// moment apart, which is the one property this mechanism cannot lose. Its
// instability is exactly what makes the fold's projection-not-a-store property
// observable, and it stays that way.
//
// ---------------------------------------------------------------------------
// Suppression when native replay succeeded is the CALLER's decision
// ---------------------------------------------------------------------------
//
// This module takes no dependency on the replay operation. `TranscriptReconstitutionRouter`
// below is the seam the caller routes through, and it consumes a plain
// `NativeReplayDisposition` VALUE the caller constructs — never a driver, never a
// replay call. A driver whose native replay applied never reaches the gateway at
// all.
//
// Spec coverage: `Spec-005 §Canonical Transcript Export And Replay` (the four
// normative memo properties); `Spec-005 §Fallback Behavior`. Verifies invariant
// I-005-9.
//
// Refs: Plan-005 §Phase 3 / T3.21, ADR-029.

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

import {
  createTranscriptPipelineState,
  foldTurns,
  repairPairingIntegrity,
  stripNonPortableContent,
  type TranscriptPipelineState,
} from "./transform-pipeline.js";

// --------------------------------------------------------------------------
// Target identity
// --------------------------------------------------------------------------

/**
 * The target session the memo is being delivered into. Only the provider's own
 * session identifier participates in the key: a resume handle is an opaque
 * credential-shaped value a provider may rotate for one unchanged session, and a
 * key that moved with it would make one switch look like two.
 */
export interface MemoTargetIdentity {
  readonly providerSessionId: string;
}

// --------------------------------------------------------------------------
// The derived memo-identity key
// --------------------------------------------------------------------------

/** Hex characters of the derived key. 128 bits, which is a collision domain far
 * beyond the number of switches any session performs, rendered short enough that
 * a human reading the target conversation is not looking at a wall of hex. */
const MEMO_IDENTITY_KEY_BYTE_LENGTH = 16;

/**
 * The visible marker prefix the key rides behind in the memo's own prose.
 *
 * Plain lowercase ASCII with no punctuation a provider is likely to reflow, and
 * deliberately self-describing: a person reading the target conversation should
 * be able to tell what the token is for without consulting anything.
 */
export const MEMO_CONTINUITY_MARKER_PREFIX: string = "continuity-ref:";

/** The exact marker text a memo carrying `memoIdentityKey` renders. */
export function renderMemoContinuityMarker(memoIdentityKey: string): string {
  return `${MEMO_CONTINUITY_MARKER_PREFIX}${memoIdentityKey}`;
}

/** Whether any of the target's recent turns already carries this memo's marker. */
export function targetTurnsCarryMemoMarker(
  recentTargetTurns: readonly string[],
  memoIdentityKey: string,
): boolean {
  const marker: string = renderMemoContinuityMarker(memoIdentityKey);
  return recentTargetTurns.some((turnText) => turnText.includes(marker));
}

/**
 * Serialize one field into the key's pre-image UNAMBIGUOUSLY.
 *
 * Length-prefixed rather than separator-joined: a segment whose text happens to
 * contain the separator would otherwise let two different transcripts produce one
 * pre-image, and a key collision here is a memo that silently never sends. The
 * length is of the JSON encoding, so the encoding is injective for every string
 * and every number the projection can hold.
 */
function appendKeyField(parts: string[], value: string | number): void {
  const encoded: string = JSON.stringify(value);
  parts.push(`${encoded.length.toString()}:${encoded}`);
}

function appendSegmentToKeyPreimage(parts: string[], segment: CanonicalTranscriptSegment): void {
  appendKeyField(parts, segment.kind);
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
      return;
    default:
      return;
  }
}

/**
 * The memo-identity key: a deterministic, pure function of the canonical
 * projection's CONTENT and the target session's identity.
 *
 * Recomputable by any daemon at any time from state that is already durable, and
 * persisted nowhere. See the header for why `builtAtPosition` is excluded and why
 * the raw projection rather than the rendered body is the input.
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

// --------------------------------------------------------------------------
// Budget
// --------------------------------------------------------------------------

/**
 * Estimates how much of the target's window a rendered fragment consumes.
 *
 * Injected rather than fixed because a driver that knows its provider's tokenizer
 * can supply the real count; the default is a deterministic character-rate
 * approximation, which is enough for a budget expressed as a fraction and is
 * stable across processes (a memo that rendered differently on two daemons would
 * not itself break once-only delivery — the key is derived before the render —
 * but it would make two participants reading one conversation see two summaries).
 */
export type MemoTokenEstimator = (text: string) => number;

export const DEFAULT_MEMO_TOKEN_ESTIMATOR: MemoTokenEstimator = (text: string): number =>
  Math.ceil(text.length / 4);

/**
 * The memo's budget. A FRACTION of the target's context window, per the spec's
 * first normative property — the absolute ceiling is derived here rather than
 * supplied, so the same policy holds across models with different windows.
 */
export interface MemoBudgetPolicy {
  readonly targetContextWindowTokens: number;
  readonly budgetFraction: number;
  /**
   * How many of the most recent TOOL-bearing exchanges eviction may never
   * remove. Everything from the oldest of those to the end of the conversation is
   * protected, so the protected region is always contiguous and always a whole
   * number of exchanges.
   */
  readonly protectedTailToolExchangeCount: number;
}

export const DEFAULT_MEMO_BUDGET_FRACTION: number = 0.2;
export const DEFAULT_PROTECTED_TAIL_TOOL_EXCHANGE_COUNT: number = 2;

/** The budget policy for a target whose context window is `contextWindowTokens`. */
export function defaultMemoBudgetPolicy(contextWindowTokens: number): MemoBudgetPolicy {
  return {
    targetContextWindowTokens: contextWindowTokens,
    budgetFraction: DEFAULT_MEMO_BUDGET_FRACTION,
    protectedTailToolExchangeCount: DEFAULT_PROTECTED_TAIL_TOOL_EXCHANGE_COUNT,
  };
}

// --------------------------------------------------------------------------
// Exchanges
// --------------------------------------------------------------------------

/**
 * A group of consecutive turns that eviction treats as ONE unit.
 *
 * The boundary rule is a straddle test rather than a role pattern: for every
 * tool-call identifier appearing anywhere in the transcript, take the first and
 * last turn indices it appears at; a cut before turn `k` is admissible only when
 * no identifier's span straddles it. That is what makes "a call and its result
 * travel together" structural — including the case where a participant turn sits
 * BETWEEN a call and its result, which a turn-role partition would happily split.
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
 * The index of the first exchange the budget may not evict.
 *
 * Anchored on the OLDEST of the most recent tool-bearing exchanges, so the
 * protected region is contiguous, is a whole number of exchanges, and always
 * includes the most recent exchange whether or not it used a tool (a memo whose
 * newest exchange was evicted describes a conversation that did not happen).
 *
 * "Most recent" is bounded, and the bound is what keeps the budget binding.
 * Tool-bearing exchanges are searched only inside a window of the newest
 * `2 * count` exchanges; a tool exchange older than that is no longer recent and
 * is evictable as a whole exchange like any other. Without the window a
 * transcript that carries FEWER tool exchanges than the tail wants — one near
 * the front of a long conversation, or none at all — would anchor the protected
 * region at that exchange, or at the transcript's own start, and protect
 * everything after it: the budget would stop binding on exactly the long, plain,
 * back-and-forth conversations where it matters most. Where the window holds no
 * tool exchange the newest exchange alone is protected.
 */
function computeProtectedTailStartIndex(
  exchanges: readonly TranscriptExchange[],
  protectedTailToolExchangeCount: number,
): number {
  if (exchanges.length === 0) {
    return 0;
  }
  const newestExchangeIndex: number = exchanges.length - 1;
  const wantedToolExchanges: number = Math.max(0, protectedTailToolExchangeCount);
  if (wantedToolExchanges === 0) {
    return newestExchangeIndex;
  }

  const recencyWindowStartIndex: number = Math.max(
    0,
    newestExchangeIndex - (2 * wantedToolExchanges - 1),
  );
  const recentToolExchangeIndices: number[] = [];
  exchanges.forEach((exchange, index) => {
    if (exchange.carriesToolActivity && index >= recencyWindowStartIndex) {
      recentToolExchangeIndices.push(index);
    }
  });
  if (recentToolExchangeIndices.length === 0) {
    return newestExchangeIndex;
  }

  const oldestProtectedToolIndex: number | undefined =
    recentToolExchangeIndices[Math.max(0, recentToolExchangeIndices.length - wantedToolExchanges)];
  return Math.min(newestExchangeIndex, oldestProtectedToolIndex ?? newestExchangeIndex);
}

// --------------------------------------------------------------------------
// Prose rendering
// --------------------------------------------------------------------------

const MEMO_OPENING_LINES: readonly string[] = [
  "This message continues a conversation that is already under way; it is not a new instruction.",
  "What follows is a bounded summary of that conversation, not its verbatim record.",
];

const MEMO_TRANSCRIPT_SEPARATOR = "---";

function renderSegment(segment: CanonicalTranscriptSegment): string | undefined {
  switch (segment.kind) {
    case "text":
      return segment.text.length === 0 ? undefined : segment.text;
    case "reasoning":
      // Unreachable after the strip, which either drops a block or flattens it to
      // text. Rendered defensively rather than dropped silently, so a caller that
      // hands this renderer untransformed turns still sees the content.
      return segment.text.length === 0 ? undefined : segment.text;
    case "tool_call":
      return `[tool call ${segment.toolName} (${segment.toolCallId})] ${segment.argumentsJson}`;
    case "tool_result":
      return `[tool result ${segment.outcome} (${segment.toolCallId})] ${segment.text}`;
    default:
      return undefined;
  }
}

function renderTurn(turn: CanonicalTranscriptTurn): string {
  const speaker: string = turn.role === "participant" ? "Participant" : "Assistant";
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

function renderEvictionNotice(evictedExchangeCount: number, totalExchangeCount: number): string {
  const shown: number = totalExchangeCount - evictedExchangeCount;
  return `Earlier parts of this conversation are omitted from the summary: ${shown.toString()} of ${totalExchangeCount.toString()} exchanges appear below, the most recent ones.`;
}

// --------------------------------------------------------------------------
// The rendering
// --------------------------------------------------------------------------

export interface MemoRenderRequest {
  readonly projection: CanonicalTranscriptProjection;
  readonly target: MemoTargetIdentity;
  readonly budget: MemoBudgetPolicy;
}

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
  /**
   * The protected tail alone did not fit. Reported rather than resolved: the one
   * remedy would be splitting an exchange, which the whole-exchange rule forbids
   * outright.
   */
  readonly exceedsBudget: boolean;
  readonly declaredLosses: readonly DeclaredLossKind[];
}

/**
 * Renders the canonical projection into the bounded prose the memo floor sends.
 *
 * Stateless between calls by construction: `render` reads only its argument, so
 * the memo is rebuilt from the log every send exactly as the transcript is, and
 * a caller cannot hold a rendering across turns and get a stale answer that looks
 * fresh.
 */
export class MemoProjection {
  readonly #estimateTokens: MemoTokenEstimator;

  constructor(estimateTokens: MemoTokenEstimator = DEFAULT_MEMO_TOKEN_ESTIMATOR) {
    this.#estimateTokens = estimateTokens;
  }

  render(request: MemoRenderRequest): MemoRendering {
    const memoIdentityKey: string = deriveMemoIdentityKey(request.projection, request.target);

    // The two PORTABILITY transforms, in the order the spec states them: the
    // strip removes what no other model may be shown and records the class, and
    // the pairing repair — strictly after it — answers the orphaned results the
    // strip just created. Both are content facts, not properties of the frame
    // export: reasoning is tied to the model that produced it wherever it is
    // sent, and an unpaired call is accepted silently and rejected on every later
    // request. Identity mapping and frame rendering are deliberately NOT applied
    // — those are target-frame steps, and this floor emits prose.
    const transformed: {
      turns: readonly CanonicalTranscriptTurn[];
      losses: readonly DeclaredLossKind[];
    } = applyPortabilityTransforms(request.projection);

    const exchanges: readonly TranscriptExchange[] = partitionIntoExchanges(transformed.turns);
    const budgetTokens: number = Math.max(
      0,
      Math.floor(request.budget.targetContextWindowTokens * request.budget.budgetFraction),
    );

    const protectedStartIndex: number = computeProtectedTailStartIndex(
      exchanges,
      request.budget.protectedTailToolExchangeCount,
    );

    const openingText: string = MEMO_OPENING_LINES.join("\n");
    const markerText: string = renderMemoContinuityMarker(memoIdentityKey);
    // Priced against the WORST-CASE preamble, which is the one carrying the
    // eviction notice: pricing against the shorter preamble and then adding the
    // notice would push a memo over the ceiling exactly when it is tightest.
    const worstCasePreambleTokens: number = this.#estimateTokens(
      [
        openingText,
        markerText,
        renderEvictionNotice(1, Math.max(1, exchanges.length)),
        MEMO_TRANSCRIPT_SEPARATOR,
      ].join("\n"),
    );

    const exchangeCosts: number[] = exchanges.map((exchange) =>
      this.#estimateTokens(renderExchange(exchange)),
    );

    let consumedTokens: number = worstCasePreambleTokens;
    for (let index = protectedStartIndex; index < exchanges.length; index += 1) {
      consumedTokens += exchangeCosts[index] ?? 0;
    }
    const exceedsBudget: boolean = consumedTokens > budgetTokens;

    // Admit older exchanges newest-first, stopping at the FIRST that does not
    // fit: keeping an older exchange after skipping a newer one would present the
    // participant with a summary that has a hole in the middle and no way to see
    // it.
    let firstIncludedIndex: number = protectedStartIndex;
    for (let index = protectedStartIndex - 1; index >= 0; index -= 1) {
      const cost: number = exchangeCosts[index] ?? 0;
      if (consumedTokens + cost > budgetTokens) {
        break;
      }
      consumedTokens += cost;
      firstIncludedIndex = index;
    }

    const includedExchanges: readonly TranscriptExchange[] = exchanges.slice(firstIncludedIndex);
    const evictedExchangeCount: number = firstIncludedIndex;
    const includedTurns: readonly CanonicalTranscriptTurn[] = includedExchanges.flatMap(
      (exchange) => [...exchange.turns],
    );

    const bodyLines: string[] = [openingText, markerText];
    if (evictedExchangeCount > 0) {
      bodyLines.push(renderEvictionNotice(evictedExchangeCount, exchanges.length));
    }
    bodyLines.push(MEMO_TRANSCRIPT_SEPARATOR);
    for (const exchange of includedExchanges) {
      bodyLines.push(renderExchange(exchange));
    }
    const text: string = bodyLines.join("\n");

    const declaredLosses: DeclaredLossKind[] = [...transformed.losses];
    // The floor's OWN loss, on every path. Without it a memo settlement could
    // carry an empty list, and an empty list is the positive claim that nothing
    // was dropped.
    declaredLosses.push("conversation_history_summarized");
    if (evictedExchangeCount > 0) {
      // Declared on eviction alone. An over-budget render that evicted nothing
      // dropped nothing either, and claiming truncation there would be a loss
      // reported against a conversation that arrived whole.
      declaredLosses.push("context_truncated");
    }

    return {
      memoIdentityKey,
      text,
      includedTurns,
      includedExchangeCount: includedExchanges.length,
      evictedExchangeCount,
      estimatedTokens: this.#estimateTokens(text),
      budgetTokens,
      exceedsBudget,
      declaredLosses: orderDeclaredLosses(declaredLosses),
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

// --------------------------------------------------------------------------
// Delivery
// --------------------------------------------------------------------------

/** The frame handed to the gateway. Provider-neutral: the driver owns encoding. */
export interface MemoOutboundFrame {
  readonly targetProviderSessionId: string;
  readonly memoIdentityKey: string;
  readonly text: string;
}

/**
 * The target session, as this floor needs to see it.
 *
 * Two operations and no third: the READ is what reconciliation rests on, and the
 * SEND is the only mutation this module performs anywhere. There is deliberately
 * no claim, lease, or marker operation — a gateway offering one would be the
 * durable claim this design exists without.
 */
export interface MemoTargetGateway {
  /**
   * The target session's own recent turns, as text. Rejecting means the target
   * could not be read — which is a settlement, never a reason to send anyway.
   */
  readRecentTurns(): Promise<readonly string[]>;
  /**
   * Deliver the memo turn. A rejection is AMBIGUOUS by construction: the frame
   * may have been applied before the acknowledgment was lost.
   */
  sendMemoTurn(frame: MemoOutboundFrame): Promise<void>;
}

export interface MemoDeliveryRequest {
  readonly projection: CanonicalTranscriptProjection;
  readonly target: MemoTargetIdentity;
  readonly budget: MemoBudgetPolicy;
}

/**
 * What became of this memo. Four arms, because the honest answers are four:
 *
 *   `delivered`         the target holds it, confirmed by the send resolving or
 *                       by a readback finding the marker after an ambiguous send;
 *   `already-delivered` the pre-send reconcile found the marker already there;
 *   `withheld`          nothing reached the target and that is known;
 *   `unconfirmed`       a send was attempted, its outcome is unknown, and NOTHING
 *                       further was sent — the ambiguity is reported rather than
 *                       resolved by a duplicate.
 */
export type MemoDeliveryDisposition =
  | "delivered"
  | "already-delivered"
  | "withheld"
  | "unconfirmed";

export type MemoWithheldReason = "target-unreadable" | "send-refused";

export interface MemoDeliverySettlement {
  /**
   * A literal, not a union: every operation settled on this floor reports
   * `degraded`. There is no code path here that can report `applied`, which is
   * the point — a floor that could render as a full replay would let the
   * participant believe the model can see a conversation it cannot.
   */
  readonly status: "degraded";
  readonly disposition: MemoDeliveryDisposition;
  readonly memoIdentityKey: string;
  readonly declaredLosses: readonly DeclaredLossKind[];
  readonly withheldReason?: MemoWithheldReason | undefined;
  /** What was rendered, whether or not it was sent. Held in memory only. */
  readonly rendering: MemoRendering;
}

/**
 * Reconciles, then sends, then settles — in that order, on every path.
 *
 * Exactly ONE `sendMemoTurn` call is attempted per `deliver` call, and only after
 * a successful read that did not find the marker. A caller that retries calls
 * `deliver` again, which reconciles again; a target that already holds the memo
 * is never sent a second one.
 */
export class MemoDeliveryCoordinator {
  readonly #gateway: MemoTargetGateway;
  readonly #projection: MemoProjection;

  constructor(gateway: MemoTargetGateway, projection: MemoProjection = new MemoProjection()) {
    this.#gateway = gateway;
    this.#projection = projection;
  }

  async deliver(request: MemoDeliveryRequest): Promise<MemoDeliverySettlement> {
    const rendering: MemoRendering = this.#projection.render({
      projection: request.projection,
      target: request.target,
      budget: request.budget,
    });

    let priorTurns: readonly string[];
    try {
      priorTurns = await this.#gateway.readRecentTurns();
    } catch {
      // The target cannot be read, so whether it already holds this memo is
      // unknowable. Nothing is sent: a duplicate corrupts the conversation the
      // participant is watching, a missing memo only degrades it, visibly.
      return settle(rendering, "withheld", "target-unreadable");
    }

    if (targetTurnsCarryMemoMarker(priorTurns, rendering.memoIdentityKey)) {
      return settle(rendering, "already-delivered", undefined);
    }

    try {
      await this.#gateway.sendMemoTurn({
        targetProviderSessionId: request.target.providerSessionId,
        memoIdentityKey: rendering.memoIdentityKey,
        text: rendering.text,
      });
      return settle(rendering, "delivered", undefined);
    } catch {
      // Ambiguous. The unknown resolves the way every other pre-send question
      // does — by reading the target — and never by sending again.
      let turnsAfterSend: readonly string[];
      try {
        turnsAfterSend = await this.#gateway.readRecentTurns();
      } catch {
        return settle(rendering, "unconfirmed", undefined);
      }
      return targetTurnsCarryMemoMarker(turnsAfterSend, rendering.memoIdentityKey)
        ? settle(rendering, "delivered", undefined)
        : settle(rendering, "withheld", "send-refused");
    }
  }
}

function settle(
  rendering: MemoRendering,
  disposition: MemoDeliveryDisposition,
  withheldReason: MemoWithheldReason | undefined,
): MemoDeliverySettlement {
  return {
    status: "degraded",
    disposition,
    memoIdentityKey: rendering.memoIdentityKey,
    declaredLosses: rendering.declaredLosses,
    withheldReason,
    rendering,
  };
}

/** The driver-boundary result a memo settlement reports. Never `applied`. */
export function memoSettlementAsReplayResult(
  settlement: MemoDeliverySettlement,
): DriverTranscriptReplayResult {
  return { status: "degraded", declaredLosses: [...settlement.declaredLosses] };
}

// --------------------------------------------------------------------------
// The caller's routing seam
// --------------------------------------------------------------------------

/**
 * What the caller's native-replay attempt came to, expressed as a VALUE.
 *
 * This module never calls a driver and never imports one: suppression when native
 * replay succeeded is the caller's decision, and this is the shape it hands over.
 * Keeping it a value rather than a callback is what stops a replay dependency
 * from arriving here through the back door.
 */
export type NativeReplayDisposition =
  | { readonly outcome: "applied"; readonly declaredLosses: readonly DeclaredLossKind[] }
  | { readonly outcome: "unavailable" }
  | { readonly outcome: "refused" }
  | { readonly outcome: "context-window-exceeded" };

export type ReconstitutionSettlement =
  | { readonly route: "native-replay"; readonly result: DriverTranscriptReplayResult }
  | {
      readonly route: "memo";
      readonly memo: MemoDeliverySettlement;
      readonly result: DriverTranscriptReplayResult;
    };

/**
 * Routes a reconstitution to native replay's own settlement or to the memo floor.
 *
 * On the `applied` arm the memo coordinator is never consulted, so the gateway is
 * never touched — the suppression is structural rather than a flag checked inside
 * the memo path.
 */
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
      return {
        route: "native-replay",
        result: { status: "applied", declaredLosses: [...disposition.declaredLosses] },
      };
    }
    const memo: MemoDeliverySettlement = await this.#coordinator.deliver(request);
    return { route: "memo", memo, result: memoSettlementAsReplayResult(memo) };
  }
}

// --------------------------------------------------------------------------
// Participant-facing disclosure
// --------------------------------------------------------------------------

/**
 * The single renderer both routes pass through.
 *
 * One function rather than two so the never-identical property is a fact about
 * the code rather than a convention two call sites are trusted to keep: an
 * applied replay and a memo settlement CANNOT produce the same sentence, and a
 * memo that reached the target cannot produce the same sentence as one that did
 * not. A degraded settlement that read like an applied one would take from the
 * participant the one thing they are entitled to — knowing that the conversation
 * the model can see is a summary.
 */
export function renderReconstitutionDisclosure(settlement: ReconstitutionSettlement): string {
  const losses: string =
    settlement.result.declaredLosses.length === 0
      ? "nothing was dropped"
      : settlement.result.declaredLosses.join(", ");

  if (settlement.route === "native-replay") {
    return `The prior conversation was replayed into the new session in full (${losses}).`;
  }

  switch (settlement.memo.disposition) {
    case "delivered":
      return `The prior conversation was summarized rather than replayed; the new session holds a bounded summary of it (${losses}).`;
    case "already-delivered":
      return `The prior conversation was summarized rather than replayed; the new session already held that summary and it was not sent again (${losses}).`;
    case "withheld":
      return `The prior conversation was summarized rather than replayed, and the summary did not reach the new session (${losses}).`;
    case "unconfirmed":
      return `The prior conversation was summarized rather than replayed, and whether the summary reached the new session could not be confirmed (${losses}).`;
    default:
      return `The prior conversation was summarized rather than replayed (${losses}).`;
  }
}
