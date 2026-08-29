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
// turns for it, treat a match as already delivered.
//
// Reading the target answers the ambiguous send — a timeout, a dropped
// connection, a restart between send and acknowledgment — only where the read is
// causally ordered AFTER the provider settled that send. A readback taken the
// instant an acknowledgment is lost is not: the provider may still be applying
// the frame, so the marker's absence there is a snapshot of a race rather than
// evidence of non-delivery. Settling that snapshot as a refusal is exactly what
// would license a sequential retry to send a second memo into a conversation
// that was about to receive the first.
//
// An ambiguous send is therefore held UNCONFIRMED rather than settled. The pair
// is remembered, every later delivery for it reconciles against the target as
// usual, and only DEFINITIVE evidence moves it: the marker appearing, or an
// absence read after the caller's own bounded settlement barrier resolved.
// Absent both, the ambiguity is reported and NOTHING further is sent — as when
// the target cannot be read at all. The operation settles on what did land: a
// duplicated memo corrupts the conversation the participant is watching, while a
// missing one only degrades it, visibly. Rollback-then-retry is not merely
// discouraged here but unrepresentable, there being no claim to roll back.
//
// This module mints no table, no column, and no migration, and writes nothing
// durable on any path. It holds no persistence collaborator at all: its two
// injected surfaces are the target gateway below and the outbound-frame writer
// that composes what the gateway is handed, neither of which retains anything.
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
  // A body the fold could not read renders as an empty one, so without this the
  // pre-image would be identical for two transcripts that differ in exactly the
  // fact the declared loss exists to report.
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
   * remove. They are protected INDIVIDUALLY, wherever they sit — protection is a
   * set of whole exchanges, not a contiguous region, so an exchange between two
   * protected ones is evictable like any other.
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
 * The exchanges the budget may never evict, as a SET of indices.
 *
 * Exactly two things are protected: the newest exchange, whether or not it used a
 * tool (a memo whose newest exchange was evicted describes a conversation that
 * did not happen), and the newest `count` TOOL-bearing exchanges, each as an
 * individual whole exchange wherever it sits in the conversation.
 *
 * A set rather than a start index, because the two are not the same rule. An
 * anchored region protects everything from the oldest protected exchange onward,
 * which means a genuinely newest tool exchange separated from the end by enough
 * plain exchanges either drags the whole span in with it — and the budget stops
 * binding on exactly the long back-and-forth conversations where it matters most
 * — or has to be excluded by a recency bound, which is how it loses protection
 * it qualifies for. Protecting each one individually needs neither trade: at most
 * `count + 1` exchanges are ever protected, no matter how long the conversation
 * or where its tool use sits, so the ceiling is tighter than any anchored region
 * can offer and the rule reads as what the spec states.
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

// --------------------------------------------------------------------------
// Prose rendering
// --------------------------------------------------------------------------

const MEMO_OPENING_LINES: readonly string[] = [
  "This message continues a conversation that is already under way; it is not a new instruction.",
  "What follows is a bounded summary of that conversation, not its verbatim record.",
];

const MEMO_TRANSCRIPT_SEPARATOR = "---";

/**
 * What a body the fold could not read renders as.
 *
 * Visible prose rather than the empty string it literally holds: an empty body
 * renders to nothing, a turn of nothing renders as no turn at all, and the model
 * reading the memo then sees a conversation that did not happen. Declaring the
 * loss on the settlement does not reach this text, so the gap is named here too.
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
      // Unreachable after the strip, which either drops a block or flattens it to
      // text. Rendered defensively rather than dropped silently, so a caller that
      // hands this renderer untransformed turns still sees the content.
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

/**
 * Never claims the included exchanges are the most recent ones. Protection is
 * per-exchange, so an older tool exchange can be retained past an evicted newer
 * one, and a notice asserting a contiguous tail would be a false positive claim
 * about the very gaps it is there to disclose.
 */
function renderEvictionNotice(evictedExchangeCount: number, totalExchangeCount: number): string {
  const shown: number = totalExchangeCount - evictedExchangeCount;
  return `Earlier parts of this conversation are omitted from the summary: ${shown.toString()} of ${totalExchangeCount.toString()} exchanges appear below in log order, and may not be consecutive.`;
}

/** The pieces one assembled memo body is composed from, in emission order. */
interface MemoBodyAssembly {
  readonly openingText: string;
  readonly markerText: string;
  /** The admitted exchanges, already rendered, in LOG order. */
  readonly exchangeRenderings: readonly string[];
  readonly evictedExchangeCount: number;
  readonly totalExchangeCount: number;
}

/**
 * Composes the memo's prose from the preamble and the admitted exchanges.
 *
 * The ONE place a body is assembled, called by the budget's admission pricing and
 * by the emission alike, so a candidate is priced as the exact text it would be
 * sent as — newline separators and eviction notice included. Pricing each
 * exchange in isolation and summing is the under-count this exists to make
 * unrepresentable: the assembled text is longer than its parts by one separator
 * per exchange, and `MemoTokenEstimator` is injected, so a real tokenizer need
 * not be additive at all and the sum of the parts bounds nothing.
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
   * The prose in `text` does not fit `budgetTokens`. Measured over what is
   * emitted rather than over an estimate of it, so the two cannot disagree.
   *
   * Every admission is priced the same way, so the only set that reaches here
   * over the ceiling is the protected floor itself. Reported rather than
   * resolved: the one remedy would be splitting an exchange, which the
   * whole-exchange rule forbids outright.
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

    const protectedIndices: ReadonlySet<number> = computeProtectedExchangeIndices(
      exchanges,
      request.budget.protectedTailToolExchangeCount,
    );

    const openingText: string = MEMO_OPENING_LINES.join("\n");
    const markerText: string = renderMemoContinuityMarker(memoIdentityKey);
    // Rendered once per exchange and re-joined per candidate, so the admission
    // walk below prices assemblies rather than re-rendering prose it already has.
    const exchangeRenderings: readonly string[] = exchanges.map(renderExchange);

    // Every price is taken over the ASSEMBLED candidate — the exact prose that
    // set of exchanges would be sent as, eviction notice and joining separators
    // included. Pricing each exchange alone and summing under-counts by one
    // separator per admission, and rests besides on an additivity the injected
    // estimator does not owe: near the ceiling that gap admits a set which
    // assembles to more than the budget while the render reports itself as
    // fitting.
    const assembleFor = (admittedIndices: ReadonlySet<number>): string =>
      assembleMemoBody({
        openingText,
        markerText,
        exchangeRenderings: exchangeRenderings.filter((_rendering, index) =>
          admittedIndices.has(index),
        ),
        evictedExchangeCount: exchanges.length - admittedIndices.size,
        totalExchangeCount: exchanges.length,
      });

    // The protected exchanges are admitted unconditionally — that is what
    // protection means — so the floor is priced but never refused.
    const includedIndices: Set<number> = new Set<number>(protectedIndices);
    let text: string = assembleFor(includedIndices);
    let estimatedTokens: number = this.#estimateTokens(text);

    // Admit the REMAINING exchanges newest-first, stopping at the first that does
    // not fit. Protected exchanges are already in and are skipped rather than
    // ending the walk, which is what lets eviction step over one instead of
    // protecting everything behind it. The gaps that leaves are disclosed by the
    // notice, which never claims the included exchanges are consecutive.
    for (let index = exchanges.length - 1; index >= 0; index -= 1) {
      if (protectedIndices.has(index)) {
        continue;
      }
      includedIndices.add(index);
      const candidateText: string = assembleFor(includedIndices);
      const candidateTokens: number = this.#estimateTokens(candidateText);
      if (candidateTokens > budgetTokens) {
        includedIndices.delete(index);
        break;
      }
      text = candidateText;
      estimatedTokens = candidateTokens;
    }

    // Measured over the prose the settlement carries, so the two cannot disagree.
    const exceedsBudget: boolean = estimatedTokens > budgetTokens;

    const includedExchanges: readonly TranscriptExchange[] = exchanges.filter((_exchange, index) =>
      includedIndices.has(index),
    );
    const evictedExchangeCount: number = exchanges.length - includedExchanges.length;
    const includedTurns: readonly CanonicalTranscriptTurn[] = includedExchanges.flatMap(
      (exchange) => [...exchange.turns],
    );

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
      estimatedTokens,
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

/**
 * The frame handed to the gateway. Provider-neutral: the driver owns encoding.
 *
 * The memo's prose rides the NOMINAL outbound text frame rather than a raw
 * string. A memo opens with prose the participant never typed, and the same
 * boundary that decides whether provider-bound bytes are command-shaped also
 * mints the correlation value the tripwire joins a turn back to; a gateway taking
 * a bare string lets an implementation write bytes that passed through neither,
 * and a swallowed memo would then settle as a delivered one. Passing the frame
 * makes composing it the only way to reach the gateway at all.
 *
 * Minted `system_narration`: the memo is the daemon's own narration of a prior
 * conversation, which is neither the participant's text nor a driver command.
 */
export interface MemoOutboundFrame {
  readonly targetProviderSessionId: string;
  readonly memoIdentityKey: string;
  readonly frame: OutboundTextFrame;
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

/**
 * A bounded wait the CALLER supplies that resolves once the target provider
 * session has settled whatever an earlier ambiguous send may still have been
 * applying — the session reaching a quiescent or terminal state, a turn the
 * caller drove to completion, or any other ordering the caller can actually
 * establish.
 *
 * It exists to make one question answerable: is a readback that finds no marker
 * looking at a delivery that did not happen, or at one that has not happened
 * YET? Resolving means the first — an absence read afterwards is definitive, and
 * a send is authorized. Rejecting, or not being supplied at all, means the
 * question is still open, and the delivery stays unconfirmed rather than being
 * settled as refused.
 *
 * Consulted ONLY on a delivery that follows an ambiguous one, before that call's
 * read, and never inside the call whose own send just failed. Nothing can
 * establish that a send made moments ago has settled, so a barrier asked there
 * would be trusted on a claim it cannot hold: one that resolves without
 * observing the provider is indistinguishable from one that waited, and the
 * refusal it licensed would clear the way for the very duplicate this exists to
 * prevent. Ordered behind a send that COMPLETED IN AN EARLIER CALL, the same
 * barrier is answering a question that has an answer.
 *
 * Deliberately a caller-supplied value on the request rather than a third
 * operation on `MemoTargetGateway`: the gateway's two operations are the read
 * this floor reconciles with and the send it performs, and the knowledge of when
 * a provider session has gone quiet belongs to the caller driving it, not to the
 * narrow surface this module holds. It never participates in the memo-identity
 * key, so supplying one cannot move which memo is being delivered.
 *
 * The residual this leaves is named rather than hidden: a barrier that resolves
 * while an earlier send is still applying is a caller lying about its own
 * provider, and no check inside this module can catch it.
 */
export type MemoSendSettlementBarrier = () => Promise<void>;

export interface MemoDeliveryRequest {
  readonly projection: CanonicalTranscriptProjection;
  readonly target: MemoTargetIdentity;
  readonly budget: MemoBudgetPolicy;
  /**
   * Optional. Without it an ambiguous send is never resolvable to a refusal, so
   * the delivery reports itself unconfirmed and no later call may send again —
   * the fail-closed arm. Every later call still reads the target, so a memo that
   * lands late is found and settles `already-delivered` with or without a
   * barrier; only a memo that never landed at all needs one.
   */
  readonly sendSettlementBarrier?: MemoSendSettlementBarrier | undefined;
}

/**
 * What became of this memo. Four arms, because the honest answers are four:
 *
 *   `delivered`         the target holds it, confirmed by the send resolving or
 *                       by a readback finding the marker after an ambiguous send;
 *   `already-delivered` a reconcile found the marker already there — including
 *                       the retry that finds an earlier ambiguous send's own memo
 *                       arriving late;
 *   `withheld`          nothing reached the target and that is KNOWN: the target
 *                       was never sent to, or an absence was read after the
 *                       caller's settlement barrier made it definitive;
 *   `unconfirmed`       a send is outstanding, whether it applied is unknown, and
 *                       NOTHING further was sent — the ambiguity is reported
 *                       rather than resolved by a duplicate.
 *
 * `unconfirmed` is a standing state, not a one-call verdict: it persists across
 * `deliver` calls for the pair until evidence moves it, which is what keeps a
 * retry from sending into a provider still applying the first send.
 */
export type MemoDeliveryDisposition =
  | "delivered"
  | "already-delivered"
  | "withheld"
  | "unconfirmed";

/**
 * Why nothing reached the target, on the arm where that is known.
 *
 * `send-refused` is deliberately hard to reach: a gateway rejection alone never
 * earns it, because a rejection is ambiguous by construction. It takes a LATER
 * delivery whose settlement barrier ordered its read behind the earlier send —
 * the one reading that can distinguish a refused send from a slow one — and so
 * it is never the settlement of the call that attempted the send.
 */
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
 * At most ONE `sendMemoTurn` call is attempted per `deliver` call, and only after
 * a successful read that did not find the marker and left no earlier send
 * unresolved. A caller that retries calls `deliver` again, which reconciles
 * again; a target that already holds the memo is never sent a second one.
 *
 * OVERLAPPING calls for one memo into one target are one delivery: the second
 * awaits the first's settlement rather than starting a delivery of its own.
 * Reconciliation cannot close that window on its own, because both reads
 * legitimately find no marker — the first send has not landed when the second
 * read is taken — and the send is the one act here that cannot be taken back.
 *
 * SEQUENTIAL calls after an ambiguous send are that same hazard displaced in
 * time, and the flight map cannot close it: the flight in question has already
 * settled. The pair is carried in an unconfirmed register instead, and while it
 * sits there no `deliver` call may send. An ambiguous send enters that register
 * UNCONDITIONALLY — nothing a caller can pass makes its own call able to clear
 * it — so the protection does not rest on anything being answered correctly in
 * the moment the answer is unavailable.
 *
 * It leaves the register only on evidence a LATER call can hold: the marker read
 * off the target, or an absence read behind that call's settlement barrier. The
 * second reports `withheld` and sends nothing, so resolving an old ambiguity and
 * attempting a new send are never the same act; the call after it sends as an
 * ordinary first attempt. A retry racing a slow-applying send therefore reports
 * the ambiguity rather than doubling the memo, and a memo that genuinely never
 * landed is still eventually sent.
 *
 * Both exclusions are scoped to THIS coordinator and claim nothing wider. Two
 * coordinators over one target, two processes, or a restart mid-flight all fall
 * back to the pre-send reconcile, which is the mechanism the header describes and
 * the only one that survives a restart at all: the key is derived rather than
 * stored precisely so any daemon can recompute it and read the target for it.
 * Nothing here is a lease, nothing here is durable, and no lock leaves this
 * object.
 */
export class MemoDeliveryCoordinator {
  readonly #gateway: MemoTargetGateway;
  readonly #projection: MemoProjection;
  readonly #frameWriter: OutboundTextFrameWriter;
  /** Deliveries this coordinator has started and not yet settled. */
  readonly #deliveriesInFlight: Map<string, Promise<MemoDeliverySettlement>> = new Map<
    string,
    Promise<MemoDeliverySettlement>
  >();
  /**
   * Pairs whose last send was AMBIGUOUS, and whose delivery is therefore not
   * known either way. Held in memory and scoped to this coordinator exactly as
   * the flight map above is: it is a refusal to send twice, never a claim, and
   * nothing about it outlives the process.
   *
   * Deliberately UNBOUNDED and never swept on age or size. An entry is one
   * fixed-length key, at most one per memo this coordinator ever attempted, and
   * evicting one would hand back precisely the guarantee it holds — the next
   * call would read the target, find nothing, and send. Entries leave on
   * evidence or not at all.
   */
  readonly #unconfirmedDeliveries: Set<string> = new Set<string>();

  /**
   * The frame writer defaults to the `emulated` grade, which is the arm that
   * neutralizes. A leg whose provider verbatim-delivers declares `native` and
   * supplies its own writer; defaulting the other way would let an undeclared leg
   * silently opt out of the boundary this seam exists to route through.
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

  async deliver(request: MemoDeliveryRequest): Promise<MemoDeliverySettlement> {
    // Rendering reads only its argument and writes nothing, so two overlapping
    // callers may both perform it; what may not happen twice is what follows.
    const rendering: MemoRendering = this.#projection.render({
      projection: request.projection,
      target: request.target,
      budget: request.budget,
    });

    const deliveryPairKey: string = renderDeliveryPairKey(
      request.target.providerSessionId,
      rendering.memoIdentityKey,
    );
    const alreadyInFlight: Promise<MemoDeliverySettlement> | undefined =
      this.#deliveriesInFlight.get(deliveryPairKey);
    if (alreadyInFlight !== undefined) {
      // One memo into one target is one delivery, so both callers settle on what
      // that delivery did — including the caller whose own rendering carried a
      // different budget, whose memo is exactly the one that must not also land.
      return await alreadyInFlight;
    }

    const flight: Promise<MemoDeliverySettlement> = this.#reconcileThenSend(
      request,
      rendering,
      deliveryPairKey,
    );
    this.#deliveriesInFlight.set(deliveryPairKey, flight);
    try {
      return await flight;
    } finally {
      // Cleared however the flight ended, refusal included: a settled delivery
      // must never keep the next call from reconciling against the target afresh.
      // The unconfirmed register is deliberately NOT cleared here — an ambiguous
      // send outlives the call that made it, and that is the whole point of it.
      this.#deliveriesInFlight.delete(deliveryPairKey);
    }
  }

  async #reconcileThenSend(
    request: MemoDeliveryRequest,
    rendering: MemoRendering,
    deliveryPairKey: string,
  ): Promise<MemoDeliverySettlement> {
    // A pair an earlier call left ambiguous is treated as POSSIBLY-APPLIED until
    // something definitive says otherwise. The barrier is awaited before the read
    // rather than after it, because what makes the read definitive is its
    // position after the provider settled that send — a barrier consulted
    // afterwards would order nothing.
    const priorSendUnconfirmed: boolean = this.#unconfirmedDeliveries.has(deliveryPairKey);
    const priorSendSettled: boolean = priorSendUnconfirmed
      ? await awaitSendSettlement(request)
      : false;

    let priorTurns: readonly string[];
    try {
      priorTurns = await this.#gateway.readRecentTurns();
    } catch {
      // The target cannot be read, so whether it already holds this memo is
      // unknowable. Nothing is sent: a duplicate corrupts the conversation the
      // participant is watching, a missing memo only degrades it, visibly. Where
      // a send is already outstanding the honest arm is the ambiguous one —
      // calling that withheld would assert non-delivery nobody established.
      return priorSendUnconfirmed
        ? settle(rendering, "unconfirmed", undefined)
        : settle(rendering, "withheld", "target-unreadable");
    }

    if (targetTurnsCarryMemoMarker(priorTurns, rendering.memoIdentityKey)) {
      // Definitive, and the one evidence that needs no barrier: an outstanding
      // send is now known to have applied, so the pair leaves the register.
      this.#unconfirmedDeliveries.delete(deliveryPairKey);
      return settle(rendering, "already-delivered", undefined);
    }

    if (priorSendUnconfirmed) {
      if (!priorSendSettled) {
        // The marker is absent and the earlier send may still be applying. This
        // is the sequential retry the whole register exists for: it reports the
        // ambiguity again and sends nothing, rather than racing a memo that is
        // already on its way in.
        return settle(rendering, "unconfirmed", undefined);
      }
      // The barrier ordered this read behind a send that completed in an earlier
      // call, and the marker is not there: that send did not land. The ambiguity
      // is resolved and REPORTED, and nothing is sent here — evidence about the
      // old send is not evidence about a new one, and folding the two into one
      // act is what would let a barrier's single word both close a delivery and
      // open another. The pair leaves the register, so the caller's next
      // delivery reconciles and sends as an ordinary first attempt.
      this.#unconfirmedDeliveries.delete(deliveryPairKey);
      return settle(rendering, "withheld", "send-refused");
    }

    try {
      await this.#gateway.sendMemoTurn({
        targetProviderSessionId: request.target.providerSessionId,
        memoIdentityKey: rendering.memoIdentityKey,
        frame: this.#frameWriter.compose({
          text: rendering.text,
          origin: "system_narration",
        }),
      });
      return settle(rendering, "delivered", undefined);
    } catch {
      // Ambiguous, and NOT resolvable inside this call. The pair is registered
      // FIRST, before anything that can throw or return, so no path out of here
      // leaves an outstanding send unrecorded.
      //
      // The settlement barrier is deliberately not consulted on this path. It is
      // asked to order a read behind a send that has settled, and nothing can
      // establish that of a send this very call just made: a barrier that
      // resolves without observing the provider reads identically to one that
      // waited, and the refusal it licensed would clear the register and let the
      // next call send the duplicate. Only a later call, whose barrier is
      // ordered behind a send that completed before it began, may resolve this.
      this.#unconfirmedDeliveries.add(deliveryPairKey);
      let turnsAfterSend: readonly string[];
      try {
        turnsAfterSend = await this.#gateway.readRecentTurns();
      } catch {
        return settle(rendering, "unconfirmed", undefined);
      }
      if (targetTurnsCarryMemoMarker(turnsAfterSend, rendering.memoIdentityKey)) {
        // The one evidence that needs no ordering at all: the memo is visibly
        // there, so the send that just failed to acknowledge in fact applied.
        this.#unconfirmedDeliveries.delete(deliveryPairKey);
        return settle(rendering, "delivered", undefined);
      }
      // One absent snapshot, read while the provider may still be applying the
      // frame. It is not evidence of non-delivery, so it settles nothing.
      return settle(rendering, "unconfirmed", undefined);
    }
  }
}

/**
 * Awaits the caller's settlement barrier, reporting whether a readback taken
 * NEXT is definitive.
 *
 * A barrier that was not supplied and a barrier that rejected are one answer —
 * the caller could not establish the ordering — and both leave the delivery
 * unconfirmed rather than refused. The rejection is deliberately swallowed into
 * that answer rather than propagated: a bounded wait expiring is the ordinary
 * way this question goes unanswered, not a failure of the delivery.
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

/**
 * The key one delivery — one memo into one target — is tracked under, by both
 * the in-flight map and the unconfirmed register.
 *
 * The memo-identity key is derived over the target's own session identifier, so
 * it already separates two targets; naming the target here as well keeps the
 * pair's scope legible where it is read and true independently of what the
 * derivation happens to cover. The identity key is fixed-length hex, so the pair
 * admits one reading. One spelling for both structures, so a pair held
 * unconfirmed cannot be missed by a later call that looked it up differently.
 */
function renderDeliveryPairKey(providerSessionId: string, memoIdentityKey: string): string {
  return `${memoIdentityKey}:${providerSessionId}`;
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
    // "In full" is a CLAIM, and an applied replay is entitled to make it only
    // when the declared-loss list is empty. An applied replay may legitimately
    // carry losses — private reasoning stripped, a body this fold could not
    // read — and saying "in full" beside a parenthesized list of what was
    // dropped tells the participant two contradictory things in one sentence.
    return settlement.result.declaredLosses.length === 0
      ? `The prior conversation was replayed into the new session in full (${losses}).`
      : `The prior conversation was replayed into the new session, apart from what could not be carried across (${losses}).`;
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
