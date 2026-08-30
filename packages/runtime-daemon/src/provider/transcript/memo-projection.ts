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
// So EVERY send reconciles first: recompute the key, read the target's turns
// for it, treat a match as already delivered.
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

/**
 * A target one coordinator has ESTABLISHED, and the only thing a delivery may be
 * addressed to.
 *
 * Once-only delivery is a property of a provider session, not of a coordinator
 * instance, and this module holds no durable record of what it has sent. Its
 * whole guard against sending a memo twice is an in-memory register of ambiguous
 * sends, which a restarted daemon and a second coordinator both start empty. The
 * hole that leaves is precise: an ambiguous send is still applying, a coordinator
 * that never made it reads the target, finds no marker, and sends the same memo
 * again — both land.
 *
 * That hole is closed by making the ambiguity's OWNER the only party that can
 * send. A handle is minted by {@link MemoDeliveryCoordinator.establishTarget},
 * refused by every other coordinator, and — the load-bearing part — it is a class
 * instance carrying a private field, so it does not survive a process boundary
 * and cannot be reconstructed from anything durable. After a restart no inherited
 * handle exists to adopt; there is only a fresh establishment of a fresh target,
 * which is the replay-target lifecycle's own rule (a partially-seeded or
 * ambiguously-sent target is abandoned and never reused, and the memo settlement
 * lands in a fresh one).
 *
 * The residual is named rather than papered over: a caller may take a provider
 * session id it inherited, hand it to `establishTarget`, and assert freshness
 * that is not true. No check inside this module can catch that — the coordinator
 * does not create targets and cannot tell a fresh id from a reused one — and it
 * is a caller violating the abandon-never-reuse rule, not a gap in it. What this
 * type removes is every path that reaches a send WITHOUT that assertion.
 *
 * Constructing one directly is possible and useless: the coordinator admits only
 * handles it minted itself, by object identity. The class is nominal so a bare
 * `{ providerSessionId }` is a compile error; the identity check is what refuses
 * a handle at run time.
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

/** Separates the key from the record of what the memo carrying it dropped. */
const MEMO_CONTINUITY_LOSS_SEPARATOR = ";dropped=";

/** Joins the recorded loss kinds. Not a comma: a comma invites a space after it. */
const MEMO_CONTINUITY_LOSS_JOINER = "+";

/**
 * The exact marker text a memo renders — its key AND what that memo dropped.
 *
 * The losses ride the marker because the marker is the only trace a delivered
 * memo leaves. A later delivery that finds one has found a memo rendered at some
 * earlier moment, possibly under a tighter budget, and its own fresh render is
 * evidence about a memo the target does not hold. Recording the losses at the
 * moment they are true is the one way the later reconciliation can report what
 * the target ACTUALLY holds rather than what this call would have sent.
 *
 * One whitespace-free token, so no provider's reflow can break it in half, and
 * the key still leads — a marker written before this record existed is still
 * found by `targetTurnsCarryMemoMarker`, and a reader that predates the record
 * still finds a marker written with one.
 */
export function renderMemoContinuityMarker(
  memoIdentityKey: string,
  declaredLosses: readonly DeclaredLossKind[],
): string {
  return `${MEMO_CONTINUITY_MARKER_PREFIX}${memoIdentityKey}${MEMO_CONTINUITY_LOSS_SEPARATOR}${declaredLosses.join(
    MEMO_CONTINUITY_LOSS_JOINER,
  )}`;
}

/**
 * The loss this floor declares on EVERY path it can emit (see the settlement's
 * own `preBudgetLosses`).
 *
 * Named once and read by both halves so the writer's guarantee and the reader's
 * admissibility test cannot drift apart: the reader treats a record that omits
 * this kind as unattributable precisely because the writer can never emit one.
 */
const MEMO_FLOOR_DECLARED_LOSS_KIND: DeclaredLossKind = "conversation_history_summarized";

/** The key-only prefix of this memo's marker, which every marker form leads with. */
function renderMemoContinuityMarkerKey(memoIdentityKey: string): string {
  return `${MEMO_CONTINUITY_MARKER_PREFIX}${memoIdentityKey}`;
}

/**
 * Characters that CONTINUE a token, so a marker abutting one of them is part of
 * something longer rather than a marker.
 *
 * The boundary is what makes an occurrence syntactically complete. Without it a
 * plain substring search reports this memo as delivered on a target holding a
 * DIFFERENT memo whose key merely extends ours, and on any turn where the token
 * was pasted into the middle of a longer word — and the consequence of a false
 * positive here is the one failure this whole floor exists to prevent: the
 * caller skips the only context transfer and the target holds nothing.
 *
 * Digits and letters cover the key's own alphabet and any longer identifier the
 * token could be embedded in; `_` and `-` are the two separators that read as
 * part of a word rather than as punctuation ending one. Everything else —
 * whitespace, `;`, `.`, quotes, brackets, end of string — ends the token, which
 * is what lets a marker be carried mid-sentence exactly as the record parser
 * below already allows.
 */
const MEMO_MARKER_TOKEN_CHARACTER = /[A-Za-z0-9_-]/;

/** One syntactically complete occurrence of this memo's marker in a target turn. */
type MemoContinuityMarkerOccurrence =
  /** The marker carried a record, and every component of it parsed. */
  | { readonly form: "recorded"; readonly kinds: ReadonlySet<DeclaredLossKind> }
  /** The key-only form, written before the record existed. */
  | { readonly form: "key-only" }
  /** A marker whose record is present and does not parse. */
  | { readonly form: "unreadable-record" };

/**
 * THE grammar. Every occurrence of this memo's marker the target's turns carry,
 * classified, in the order they were read.
 *
 * One producer, two consumers. `targetTurnsCarryMemoMarker` asks whether the
 * list is non-empty and `readDeliveredMemoDeclaredLosses` asks what the entries
 * say, so the admission decision and the record read can no longer disagree
 * about what counts as a marker — which is exactly how a substring admission
 * came to settle a delivery the strict parser beside it would have refused.
 *
 * A boundary failure yields NO entry rather than a rejected one, and that is
 * what keeps this a single grammar: an occurrence that is not this marker is not
 * evidence about this marker, so neither consumer should see it. A complete
 * occurrence whose RECORD is garbage is the opposite — it is this marker, so it
 * counts as delivered and is simultaneously unreadable, which is the pair of
 * answers the two consumers already give it.
 *
 * The left boundary is checked as well as the right. `continuity-ref:` is
 * ordinary lowercase text, so a longer word ending in it would otherwise open a
 * marker that was never written.
 */
function readMemoContinuityMarkerOccurrences(
  targetTurns: readonly string[],
  memoIdentityKey: string,
): readonly MemoContinuityMarkerOccurrence[] {
  const markerKey: string = renderMemoContinuityMarkerKey(memoIdentityKey);
  const occurrences: MemoContinuityMarkerOccurrence[] = [];
  for (const turnText of targetTurns) {
    for (
      let markerStart: number = turnText.indexOf(markerKey);
      markerStart >= 0;
      markerStart = turnText.indexOf(markerKey, markerStart + markerKey.length)
    ) {
      const precedingCharacter: string = turnText.slice(Math.max(0, markerStart - 1), markerStart);
      if (precedingCharacter !== "" && MEMO_MARKER_TOKEN_CHARACTER.test(precedingCharacter)) {
        continue;
      }
      const tail: string = turnText.slice(markerStart + markerKey.length);
      if (!tail.startsWith(MEMO_CONTINUITY_LOSS_SEPARATOR)) {
        // No record follows. The key-only form is complete only where the token
        // ENDS: a key that runs on into more token characters is a different
        // key that happens to begin with this one.
        const followingCharacter: string = tail.slice(0, 1);
        if (followingCharacter !== "" && MEMO_MARKER_TOKEN_CHARACTER.test(followingCharacter)) {
          continue;
        }
        occurrences.push({ form: "key-only" });
        continue;
      }
      occurrences.push(readMemoContinuityRecord(tail.slice(MEMO_CONTINUITY_LOSS_SEPARATOR.length)));
    }
  }
  return occurrences;
}

/**
 * Parses one occurrence's record — the text after `;dropped=` — strictly.
 *
 * A record parses only when it is a `+`-joined list of at least one recognized
 * kind, carries no empty component (so a leading, trailing, or doubled joiner
 * is malformed rather than ignored), and names the kind this floor declares on
 * EVERY path. The last is what makes an empty or partial list unreadable rather
 * than believable: this writer cannot emit a memo that dropped nothing, so a
 * record claiming as much was written by something else, and reading it as "the
 * summary lost nothing" would turn a marker this reader cannot account for into
 * a positive guarantee.
 *
 * Deliberately NOT rejected: trailing prose after the token run. The record ends
 * where the token does, so `...+conversation_history_summarizedX` reads the kind
 * and treats `X` as the prose that follows the marker — the same rule that lets
 * a marker be carried mid-sentence.
 *
 * Parsed strictly against the closed enum: an unrecognized token is a record
 * this reader does not understand, and understanding it partly is worse than
 * not claiming to understand it at all.
 */
function readMemoContinuityRecord(record: string): MemoContinuityMarkerOccurrence {
  // Loss kinds are lowercase ASCII with underscores, so anything else — a
  // newline, a space, the prose that follows — is outside the marker.
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
 * Whether any of the target's turns already carries a COMPLETE occurrence of
 * this memo's marker.
 *
 * Reads the shared grammar rather than searching for the key: this answer skips
 * the only context transfer, so admitting an occurrence the record parser would
 * refuse means believing a memo was delivered on the strength of text that is
 * not a marker at all. The two directions are not symmetric — a false yes leaves
 * the target with no context while the caller reports success, and a false no
 * costs one redundant summary — so the grammar is the strict one and both
 * readers share it.
 */
export function targetTurnsCarryMemoMarker(
  targetTurns: readonly string[],
  memoIdentityKey: string,
): boolean {
  return readMemoContinuityMarkerOccurrences(targetTurns, memoIdentityKey).length > 0;
}

/**
 * Reads back what the memo the target ALREADY holds recorded as dropped, or
 * ABSENT where that record cannot be trusted.
 *
 * Absent covers readings that all mean the same thing to a caller: no marker at
 * all, a marker written before this record existed, and — since a target holding
 * two markers under one key holds two summaries — ANY occurrence lacking a
 * readable record. Every one of them is a memo whose omissions this reader
 * cannot account for, and the caller owes the conservative answer for all of
 * them.
 *
 * The occurrences come from the SAME grammar the admission decision reads, so a
 * marker good enough to settle a delivery is exactly one good enough to be read
 * here. The strictness lives in `readMemoContinuityRecord`, per occurrence, on
 * the same ground the any-occurrence rule rests on.
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
      // The enclosure VERDICT, beside the block id it resolves. Both are hashed
      // and neither substitutes for the other: the id names a sibling segment a
      // positional bound may cut away, while this member rides the result it
      // governs and is what decides whether the body travels at all.
      //
      // Two projections of one conversation can agree on every other field here
      // and differ in exactly this member. A fold whose reasoning row was
      // unreadable resolves the enclosure `unknown` and withholds the result; a
      // later fold that could read the row ships the real body. Omitting the
      // member gives those two renderings ONE once-only key, so the corrected
      // memo is settled as already-delivered and the target keeps the diminished
      // one permanently — the exact failure the key exists to prevent, in the
      // one direction that never self-repairs.
      //
      // The cost is stated rather than discovered: adding a field re-keys every
      // transcript holding a tool result, so a memo already delivered under the
      // old key is not found and is sent once more. That is the direction this
      // file's admission rule already prices as acceptable — a false no costs
      // one redundant summary, a false yes leaves the target with no context at
      // all — and it settles at the first re-render.
      appendKeyField(parts, segment.enclosureDisclosure ?? "");
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
    // Rendered once per exchange and re-joined per candidate, so the admission
    // walk below prices assemblies rather than re-rendering prose it already has.
    const exchangeRenderings: readonly string[] = exchanges.map(renderExchange);

    // Every loss but truncation is settled before the walk runs: the transforms
    // have already reported theirs, and the floor's own loss holds on every path.
    const preBudgetLosses: readonly DeclaredLossKind[] = orderDeclaredLosses([
      ...transformed.losses,
      // The floor's OWN loss, on every path. Without it a memo settlement could
      // carry an empty list, and an empty list is the positive claim that
      // nothing was dropped.
      MEMO_FLOOR_DECLARED_LOSS_KIND,
    ]);
    // Truncation is the ONE loss the walk can move, and the marker records it —
    // so the marker's own length depends on an outcome the marker's length helps
    // decide. Broken by pricing every candidate against the truncation-inclusive
    // marker, which is the longer of the exactly two the walk can produce: a
    // walk that evicts priced the marker it emits, and one that does not priced a
    // marker no shorter than the one it emits. The emitted text is then measured
    // in its own right below, so a tokenizer that is not monotone in length
    // surfaces as `exceedsBudget` rather than as a body that quietly overran.
    const pricingMarkerText: string = renderMemoContinuityMarker(
      memoIdentityKey,
      orderDeclaredLosses([...preBudgetLosses, "context_truncated"]),
    );

    // Every price is taken over the ASSEMBLED candidate — the exact prose that
    // set of exchanges would be sent as, eviction notice and joining separators
    // included. Pricing each exchange alone and summing under-counts by one
    // separator per admission, and rests besides on an additivity the injected
    // estimator does not owe: near the ceiling that gap admits a set which
    // assembles to more than the budget while the render reports itself as
    // fitting.
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

    // The protected exchanges are admitted unconditionally — that is what
    // protection means — so the floor is priced but never refused.
    const includedIndices: Set<number> = new Set<number>(protectedIndices);

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
      // Declared on eviction alone. An over-budget render that evicted nothing
      // dropped nothing either, and claiming truncation there would be a loss
      // reported against a conversation that arrived whole.
      ...(evictedExchangeCount > 0 ? (["context_truncated"] as const) : []),
    ]);

    // Assembled and measured with the marker it will actually be SENT with, so
    // the memo carries a record of its own losses and `estimatedTokens` prices
    // the emitted bytes rather than the pricing candidate.
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
      // Measured over the prose the settlement carries, so the two cannot
      // disagree.
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
   * The turns of the NAMED provider session, as text, for deciding whether this
   * memo's marker is already there.
   *
   * The session is a parameter rather than a property of the gateway, and it is
   * the same id `sendMemoTurn` is handed on `MemoOutboundFrame`. The two must
   * name one session: reconciliation decides whether to send INTO the session
   * the frame names, so a gateway free to answer for a different one — a
   * long-lived implementation serving several sessions, or one whose notion of
   * "current" moved between the read and the send — would let an absent marker
   * in session A license a send into session B, and the memo's identity key is
   * derived over the target session id, so the answer would not even be about
   * the same key. Naming the session on the read is what makes the once-only
   * guarantee a property of a session rather than of a gateway instance.
   *
   * The returned set MUST be sufficient to decide marker presence for that
   * ENTIRE provider session — not a recent tail. An implementor may answer with
   * the whole transcript, or with any subset it can prove marker-complete; a
   * bounded window of the newest N turns satisfies neither and violates this
   * port.
   *
   * The obligation is stated here rather than left to each implementor because
   * of what a false negative costs. Once-only rests entirely on this read: a
   * marker that has scrolled out of the answered window reads exactly like a
   * memo that was never delivered, so a retry — or the first call after a
   * restart, which has no register to consult — sends a second memo into a
   * conversation the participant is watching. The guarantee would then hold for
   * as long as the window, and silently expire with it.
   *
   * Rejecting means the target could not be read — which is a settlement, never
   * a reason to send anyway.
   */
  readTurnsForMarkerReconciliation(targetProviderSessionId: string): Promise<readonly string[]>;
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
  /**
   * An ESTABLISHED target, never a bare identity: the coordinator that delivers
   * this request must be the one that minted the handle. See
   * {@link EstablishedMemoTarget} for what that closes and what it does not.
   */
  readonly target: EstablishedMemoTarget;
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

/**
 * Which memo the settlement's declared-loss list describes.
 *
 * The two are not interchangeable and the distinction is not cosmetic. A
 * settlement resting on this call's own send describes prose this call rendered.
 * A settlement resting on a marker READ off the target describes a memo some
 * earlier moment rendered — possibly under a tighter budget, dropping more — and
 * reporting this render's list there would tell the participant the target holds
 * a summary it does not hold.
 *
 * `unknown` is the fail-closed arm: the delivered memo's record could not be read
 * or did not parse, so the list is the floor's whole producible set — an upper
 * bound stated AS an upper bound, never a fresh render passed off as the
 * delivered one.
 */
export type MemoDeclaredLossSource = "this-delivery" | "delivered-memo" | "unknown";

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
  /** Which memo {@link declaredLosses} describes. Required: a list whose subject
   * is ambiguous cannot be disclosed honestly. */
  readonly declaredLossSource: MemoDeclaredLossSource;
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
  /**
   * The targets this coordinator established, by provider session id.
   *
   * Serves both halves of the gate: idempotence, so a caller may establish the
   * same target twice and get one handle rather than a refusal, and ownership, so
   * a handle from another coordinator — or from a bare `new` — is refused by
   * object identity rather than by comparing the id it carries.
   */
  readonly #establishedTargets: Map<string, EstablishedMemoTarget> = new Map<
    string,
    EstablishedMemoTarget
  >();
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
   * A SAME-LIFETIME guard, stated as what it is — and sufficient because of the
   * establishment gate rather than in spite of it. Every send this module can
   * perform goes through a handle this coordinator minted, so the set of sends
   * this register is answerable for is exactly the set it can see. A coordinator
   * that never sent into a target can never send into it either, so the empty
   * register a restart starts from is not a register that lost anything.
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

  /**
   * Claims a target for this coordinator and mints the handle a delivery is
   * addressed to. The caller asserts by calling it that the target is FRESH —
   * this coordinator neither created it nor can verify that, and the residual is
   * named on {@link EstablishedMemoTarget}.
   *
   * Idempotent per provider session: a second call for the same id returns the
   * first handle rather than refusing, because a caller re-establishing a target
   * it already owns is an ordinary retry and refusing it would push callers into
   * caching handles themselves. It deliberately does NOT touch the unconfirmed
   * register — re-establishing a target must not hand back the guarantee that
   * register holds, which is precisely what a reset here would do.
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
    // Before anything is rendered, read, or sent: a target this coordinator did
    // not establish is one whose send history it cannot see, so it is dead to
    // this coordinator. Thrown rather than settled `withheld` — that arm asserts
    // the target was never sent to, and a coordinator holding a foreign handle is
    // in no position to claim that about anyone's send but its own.
    if (this.#establishedTargets.get(request.target.providerSessionId) !== request.target) {
      throw new UnownedMemoTargetError(request.target.providerSessionId);
    }

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
      priorTurns = await this.#gateway.readTurnsForMarkerReconciliation(
        request.target.providerSessionId,
      );
    } catch {
      // The target cannot be read, so whether it already holds this memo is
      // unknowable. Nothing is sent: a duplicate corrupts the conversation the
      // participant is watching, a missing memo only degrades it, visibly. Where
      // a send is already outstanding the honest arm is the ambiguous one —
      // calling that withheld would assert non-delivery nobody established.
      return priorSendUnconfirmed
        ? settle(rendering, "unconfirmed", undefined, thisDeliveryLosses(rendering))
        : settle(rendering, "withheld", "target-unreadable", thisDeliveryLosses(rendering));
    }

    if (targetTurnsCarryMemoMarker(priorTurns, rendering.memoIdentityKey)) {
      // Definitive, and the one evidence that needs no barrier: an outstanding
      // send is now known to have applied, so the pair leaves the register.
      this.#unconfirmedDeliveries.delete(deliveryPairKey);
      return settle(
        rendering,
        "already-delivered",
        undefined,
        deliveredMemoLosses(priorTurns, rendering.memoIdentityKey),
      );
    }

    if (priorSendUnconfirmed) {
      if (!priorSendSettled) {
        // The marker is absent and the earlier send may still be applying. This
        // is the sequential retry the whole register exists for: it reports the
        // ambiguity again and sends nothing, rather than racing a memo that is
        // already on its way in.
        return settle(rendering, "unconfirmed", undefined, thisDeliveryLosses(rendering));
      }
      // The barrier ordered this read behind a send that completed in an earlier
      // call, and the marker is not there: that send did not land. The ambiguity
      // is resolved and REPORTED, and nothing is sent here — evidence about the
      // old send is not evidence about a new one, and folding the two into one
      // act is what would let a barrier's single word both close a delivery and
      // open another. The pair leaves the register, so the caller's next
      // delivery reconciles and sends as an ordinary first attempt.
      this.#unconfirmedDeliveries.delete(deliveryPairKey);
      return settle(rendering, "withheld", "send-refused", thisDeliveryLosses(rendering));
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
      return settle(rendering, "delivered", undefined, thisDeliveryLosses(rendering));
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
        turnsAfterSend = await this.#gateway.readTurnsForMarkerReconciliation(
          request.target.providerSessionId,
        );
      } catch {
        return settle(rendering, "unconfirmed", undefined, thisDeliveryLosses(rendering));
      }
      if (targetTurnsCarryMemoMarker(turnsAfterSend, rendering.memoIdentityKey)) {
        // The one evidence that needs no ordering at all: the memo is visibly
        // there, so the send that just failed to acknowledge in fact applied.
        this.#unconfirmedDeliveries.delete(deliveryPairKey);
        // The same rule as the reconciliation above, and it is one rule: the
        // losses come from the MARKER wherever the settlement rests on reading
        // one. A found marker carrying no record is provably not the memo this
        // call just composed, so it takes the conservative arm rather than this
        // render's list.
        return settle(
          rendering,
          "delivered",
          undefined,
          deliveredMemoLosses(turnsAfterSend, rendering.memoIdentityKey),
        );
      }
      // One absent snapshot, read while the provider may still be applying the
      // frame. It is not evidence of non-delivery, so it settles nothing.
      return settle(rendering, "unconfirmed", undefined, thisDeliveryLosses(rendering));
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

/** A declared-loss list paired with the memo it describes. */
interface MemoDeclaredLossRecord {
  readonly source: MemoDeclaredLossSource;
  readonly losses: readonly DeclaredLossKind[];
}

/** What THIS call rendered — the honest subject wherever the settlement rests on
 * this call's own send. */
function thisDeliveryLosses(rendering: MemoRendering): MemoDeclaredLossRecord {
  return { source: "this-delivery", losses: rendering.declaredLosses };
}

/**
 * What the memo the target ALREADY holds recorded, for every settlement that
 * rests on having read a marker rather than on having sent one.
 *
 * The unreadable arm declares the whole CLOSED VOCABULARY, which is the only
 * honest bound available to it: the record it could not read was written by some
 * other rendering, and nothing about that rendering is knowable from a token run
 * this parser rejected. Conservative on purpose and not merely defensive —
 * understating it would let a participant believe a summary carries reasoning or
 * exchanges it may not.
 *
 * The vocabulary rather than the subset this build can currently PRODUCE, and
 * the two are not the same set: a loss kind is admitted to the vocabulary before
 * its producer lands, by the ordering the canonical contract prescribes. The
 * difference falls in the direction that costs nothing — a peer daemon that
 * already emits such a kind writes it into a marker this daemon then reads, so a
 * bound drawn around this build's own producers would be too small for exactly
 * the records it cannot parse.
 */
function deliveredMemoLosses(
  targetTurns: readonly string[],
  memoIdentityKey: string,
): MemoDeclaredLossRecord {
  const recorded: readonly DeclaredLossKind[] | undefined = readDeliveredMemoDeclaredLosses(
    targetTurns,
    memoIdentityKey,
  );
  return recorded === undefined
    ? { source: "unknown", losses: DECLARED_LOSS_KINDS }
    : { source: "delivered-memo", losses: recorded };
}

/**
 * Thrown when a settlement that established no delivery is asked for a
 * driver-boundary result.
 *
 * Carries the settlement so the caller can still disclose what happened — a
 * failure to reconstitute is exactly the moment the participant most needs to
 * be told which summary did not land, and why.
 */
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
 * The driver-boundary result a memo settlement reports. Never `applied`, and
 * never produced at all for a settlement that established no delivery.
 *
 * TWO of the four dispositions are results and two are failures, and the split
 * is the whole contract here. `degraded` at the driver boundary means the memo
 * floor STOOD IN — the new session holds a summary and the conversation can
 * continue on it. `withheld` means nothing reached the target (a read that
 * failed before any send, or a barrier that proved the send refused) and
 * `unconfirmed` means the daemon does not know whether anything did. Stamping
 * `degraded` for those, as this function once did for every disposition, tells
 * the caller a provider switch succeeded on a summary while the new session may
 * hold no prior context at all — and `DriverTranscriptReplayResult` has no arm
 * to walk that back, because its own contract reserves the failure case for a
 * THROW: "a target that cannot be reached at all throws".
 *
 * So the failure is thrown, with the settlement on it. The disposition is
 * preserved rather than discarded, and a caller cannot reach a result without
 * passing the split — there is no nullable to coalesce past.
 *
 * The list travels unqualified because the driver result declares no subject for
 * it — deliberately, since widening that contract to carry one would make every
 * driver a reader of this floor's internals. Where the subject matters, it is the
 * DISCLOSURE that says so: `renderReconstitutionDisclosure` reads the settlement
 * itself and states the upper bound as an upper bound.
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
      // Exhaustive by construction: a disposition added to the union lands here
      // as a type error rather than defaulting into the established arm, which
      // is the direction a new arm must never silently take.
      void (settlement.disposition satisfies never);
      throw new MemoDeliveryNotEstablishedError(settlement);
    }
  }
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

/**
 * What one reconstitution came to, on whichever route carried it.
 *
 * The memo arm deliberately carries NO `DriverTranscriptReplayResult`. It once
 * did, mirroring the settlement's own loss list, and that mirror was how a
 * `withheld` settlement came to hold a `degraded` result: the value existed, so
 * it had to be filled in on every arm, including the arms where there is no
 * result to state. The settlement is the record, `memoSettlementAsReplayResult`
 * is the one producer of a boundary result from it, and it refuses the arms that
 * have none — so this type can no longer carry a result for a memo that never
 * landed, whatever a caller does.
 *
 * The disclosure loses nothing by the removal: it reads the loss list off the
 * settlement, which is where the list and its subject both live.
 */
export type ReconstitutionSettlement =
  | { readonly route: "native-replay"; readonly result: DriverTranscriptReplayResult }
  | { readonly route: "memo"; readonly memo: MemoDeliverySettlement };

/**
 * Raised when a caller reports native replay applied while ALSO declaring that a
 * bounded prose summary stood in for the conversation.
 *
 * The two claims are mutually exclusive by construction — the summary standing in
 * IS the memo floor, and the memo floor is the `degraded` settlement — so the
 * value states no reachable outcome. `DriverTranscriptReplayResultSchema` refuses
 * it at parse, but this router is a SECOND producer of a boundary result and it
 * constructs one in TypeScript rather than parsing it, so the schema alone leaves
 * the contradiction reachable on exactly the path that publishes continuity.
 *
 * Thrown rather than corrected. Rewriting the outcome to `degraded` would invent
 * a settlement the caller never reported, and dropping the kind from the list
 * would hide a loss the caller did report — both of which answer "which of the
 * caller's two claims is the true one?" by guessing. The caller knows; this
 * module does not.
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
      // Checked here rather than left to the schema because this construction
      // never passes one. The result below is assembled from a TypeScript
      // literal, and `DriverTranscriptReplayResult` is flat by design, so the
      // arm-scoping the schema enforces has no structural counterpart the
      // compiler can hold us to. Absent this guard the one path that publishes
      // native-replay continuity is precisely the path that skips the parse.
      if (disposition.declaredLosses.includes("conversation_history_summarized")) {
        throw new ContradictoryReplayDispositionError(disposition);
      }
      return {
        route: "native-replay",
        result: { status: "applied", declaredLosses: [...disposition.declaredLosses] },
      };
    }
    // Returned for EVERY disposition, the unlanded ones included. This method is
    // the reporting seam, and a withheld or unconfirmed delivery is a report the
    // participant is owed rather than an exception that erases it. The caller
    // that owes its own boundary a `DriverTranscriptReplayResult` asks
    // `memoSettlementAsReplayResult` for one and takes the throw when the memo
    // established nothing; the caller that owes a disclosure renders this value.
    const memo: MemoDeliverySettlement = await this.#coordinator.deliver(request);
    return { route: "memo", memo };
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
  // Read off whichever record the route actually kept. On the memo arm that is
  // the settlement, which is also what carries the list's SUBJECT — the two
  // belong together, and reading the list from a mirrored boundary result was
  // what let the two drift apart in the first place.
  const declaredLosses: readonly DeclaredLossKind[] =
    settlement.route === "native-replay"
      ? settlement.result.declaredLosses
      : settlement.memo.declaredLosses;
  const losses: string =
    declaredLosses.length === 0 ? "nothing was dropped" : declaredLosses.join(", ");

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

  // A settlement resting on a summary the new session ALREADY holds knows only
  // what that summary recorded about itself, and where it recorded nothing the
  // honest report is an upper bound stated as one. Rendering the list
  // unqualified there would present what this call happened to render as an
  // account of a summary it did not compose.
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
