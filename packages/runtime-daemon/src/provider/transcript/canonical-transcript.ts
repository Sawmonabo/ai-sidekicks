// Canonical transcript fold — the daemon's authoritative record of a provider
// session's content (Plan-005 Phase 3, T3.19).
//
// The transcript is a PROJECTION, not a store: `CanonicalTranscriptFold.build()`
// walks the session log every time it is called and keeps nothing between calls.
// That is the whole point of ADR-029 — a cached transcript is a second record of
// the conversation, and the moment it disagrees with the log there is no rule
// that says which one is the session. `builtAtPosition` exists so a caller can
// SEE the fold move rather than take the property on faith.
//
// ---------------------------------------------------------------------------
// Why the content source is a separate collaborator
// ---------------------------------------------------------------------------
//
// The fold has TWO inputs, and conflating them is the trap this module is shaped
// to avoid.
//
//   * The session log supplies ORDER, IDENTITY, and PAIRING: `sequence`, event
//     type, the run a row belongs to, tool names, and tool-call ids. Every one
//     of those is a member of the CLEAR payload the event read path hands back.
//
//   * Every BODY the transcript renders — the participant's own words, assistant
//     prose, reasoning block bodies, serialized tool arguments, tool result
//     bodies — reaches the fold through the content port instead. Two different
//     reasons land in the same place, and both are deliberate:
//
//       - Assistant and tool payloads are metadata-shaped by construction, per
//         `Spec-006 §Assistant Output (assistant_output)` and
//         `Spec-006 §Tool Activity (tool_activity)` — assistant output carries
//         `contentType` / `contentLength` and never message text, tool activity
//         carries no tool output — so unbounded content always rides behind a
//         reference.
//
//       - The participant's message text IS named in the `user.message` payload
//         shape, but it is PII-bearing at that call site and the emitter routes
//         it through the encrypted `pii_payload` envelope, per
//         `Spec-006 §User Message Events`. The read path this fold walks exposes
//         only the clear half, so reading `payload.message` here would answer
//         `undefined` for every real participant row and silently erase every
//         participant turn from export and replay under no declared loss. The
//         port is the seam that keeps that decryption decision out of the fold.
//
// So the content arrives through `TranscriptContentSource`, a port this module
// declares and does not implement. Declaring it is not a stub standing in for
// missing work: it is the honest shape of a projection whose ordering source and
// content source are different surfaces, and it keeps every ordering, strip, and
// pairing rule in the transform pipeline testable and shippable today. Where that
// content durably lives is an open corpus question, and inventing an answer here
// would put a second record of the conversation exactly where ADR-029 forbids one.
//
// Spec coverage: `Spec-005 §Canonical Transcript Export And Replay` (step 1 of the
// ordered pipeline), invariant I-005-8.
//
// Refs: Plan-005 §Phase 3 / T3.19, ADR-029,
// `Spec-006 §Assistant Output (assistant_output)`,
// `Spec-006 §Tool Activity (tool_activity)`,
// `Spec-006 §User Message Events`.

import type {
  CanonicalReasoningDisclosure,
  CanonicalTranscriptProjection,
  CanonicalTranscriptRole,
  CanonicalTranscriptSegment,
  CanonicalTranscriptTurn,
  RunId,
  SessionId,
} from "@ai-sidekicks/contracts";

import type { StoredEvent } from "../../session/types.js";

// --------------------------------------------------------------------------
// The event-read port
// --------------------------------------------------------------------------

/**
 * The slice of the session store the fold reads. A `Pick` of the real service
 * rather than a hand-written signature, so a change to the read surface becomes
 * a compile error here instead of a silently divergent second declaration.
 */
export interface TranscriptEventReader {
  readEvents(sessionId: string): ReadonlyArray<StoredEvent>;
}

// --------------------------------------------------------------------------
// The content port
// --------------------------------------------------------------------------

/**
 * Identifies the one logged row whose content is being asked for. Keyed by the
 * row's own `sequence` rather than by a content hash: the log orders the
 * conversation, and a content-addressed key would collapse two identical
 * assistant replies into one lookup.
 */
export interface TranscriptContentReference {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly sequence: number;
  readonly eventType: string;
  /** Present for tool rows only, carried verbatim from the durable payload. */
  readonly toolCallId?: string | undefined;
}

/** One reasoning block an `assistant.thinking_update` row carried. */
export interface TranscriptReasoningBlock {
  readonly blockId: string;
  readonly reasoningKind: string;
  readonly disclosure: CanonicalReasoningDisclosure;
  readonly text: string;
}

/** The body a tool-result row carried, plus the block it was emitted inside. */
export interface TranscriptToolResultBody {
  readonly text: string;
  readonly enclosingReasoningBlockId?: string | undefined;
}

/**
 * Supplies every body the clear durable payloads do not carry — see the header
 * for the two distinct reasons they do not, one per method group.
 *
 * Every method may answer "nothing", and every one of them means one thing: the
 * row's content is UNAVAILABLE, which the fold renders as an EMPTY body marked
 * `contentUnavailable` rather than by inventing text or by dropping the row.
 * Dropping it would erase a turn that happened, and the pipeline would then
 * declare no loss over it — the one reading the declared-loss rule forbids.
 *
 * `readReasoningBlocks` answers a LIST, so it has two distinct empty answers and
 * both are load-bearing: an empty list is a row that carried no blocks, and an
 * ABSENT list is a row whose blocks could not be read. One return type for both
 * is how summary-disclosure reasoning — participant-visible history that step 3
 * flattens and keeps under no declared loss — leaves an export in silence.
 */
export interface TranscriptContentSource {
  readAssistantText(reference: TranscriptContentReference): string | undefined;
  readParticipantText(reference: TranscriptContentReference): string | undefined;
  readReasoningBlocks(
    reference: TranscriptContentReference,
  ): readonly TranscriptReasoningBlock[] | undefined;
  readToolCallArguments(reference: TranscriptContentReference): string | undefined;
  readToolResultBody(reference: TranscriptContentReference): TranscriptToolResultBody | undefined;
}

// --------------------------------------------------------------------------
// Scope
// --------------------------------------------------------------------------

/**
 * The event types that contribute transcript content, in the taxonomy's own
 * spelling. `run.turn_started` contributes no segment but IS in scope: it is the
 * only row that separates two consecutive assistant turns with no participant
 * message between them, and without it they would coalesce into one.
 */
export const TRANSCRIPT_BEARING_EVENT_TYPES: readonly string[] = [
  "run.turn_started",
  "user.message",
  "assistant.message",
  "assistant.thinking_update",
  "tool.invoked",
  "tool.result",
  "tool.error",
];

const TRANSCRIPT_BEARING_EVENT_TYPE_SET: ReadonlySet<string> = new Set(
  TRANSCRIPT_BEARING_EVENT_TYPES,
);

/**
 * Whether a logged row belongs to the named run's transcript.
 *
 * A single named predicate rather than an inline condition, because it is the
 * one place the run boundary is decided and a transcript that silently widened
 * its scope would export another run's conversation into this run's replay
 * target. A row qualifies only when its payload NAMES the run — there is no
 * carve-out for rows that omit `runId`, since a row that names no run cannot be
 * proven to belong to this one.
 */
export function isEventInRunScope(event: StoredEvent, runId: RunId): boolean {
  if (!TRANSCRIPT_BEARING_EVENT_TYPE_SET.has(event.type)) {
    return false;
  }
  const payloadRunId: unknown = event.payload["runId"];
  return typeof payloadRunId === "string" && payloadRunId === (runId as string);
}

// --------------------------------------------------------------------------
// Unkeyed tool rows
// --------------------------------------------------------------------------

/** The two outcomes a tool row can report, in the segment union's spelling. */
type CanonicalToolResultOutcome = "succeeded" | "failed";

/**
 * How a tool row with NO pairing key is rendered into the one segment kind that
 * needs no key: text.
 *
 * The vocabulary is the memo renderer's, minus the identifier — a reader of an
 * exported transcript sees the same shape of line for an unkeyed row as for a
 * keyed one, so nothing about the row LOOKS like prose the assistant wrote.
 * They are deliberately visible ASCII: an invisible marker would be a second,
 * unreadable channel inside a record whose whole point is that a person can
 * read it.
 *
 * Module-private: the exported transcript is the contract, so a test that
 * imported this to compare against would assert nothing about the text a
 * target actually receives.
 */
function renderUnkeyedToolCallText(toolName: string | undefined, argumentsJson: string): string {
  const heading: string = toolName === undefined ? "[tool call]" : `[tool call ${toolName}]`;
  return argumentsJson.length === 0 ? heading : `${heading} ${argumentsJson}`;
}

/** The answer half of {@link renderUnkeyedToolCallText}. */
function renderUnkeyedToolResultText(outcome: CanonicalToolResultOutcome, body: string): string {
  const heading: string = `[tool result ${outcome}]`;
  return body.length === 0 ? heading : `${heading} ${body}`;
}

/**
 * A legacy answer the provider emitted INSIDE a named reasoning block, held
 * until the turn that carried it is complete.
 *
 * Enclosure alone settles nothing. A `summary` block is participant-visible
 * history, so an answer carried inside one is portable content, and withholding
 * it would drop a body the participant already read AND declare a loss that did
 * not happen. What settles it is the enclosing block's OWN disclosure — and the
 * row carrying that block may be logged after the answer it enclosed, so the
 * lookup is taken at turn close rather than row by row.
 */
interface DeferredEnclosedToolResult {
  readonly enclosingReasoningBlockId: string;
  readonly outcome: CanonicalToolResultOutcome;
  readonly bodyText: string;
}

/**
 * The segment an unkeyed tool RESULT contributes, registering the deferral an
 * enclosed one owes.
 *
 * Three arms, and the first two are different facts:
 *
 *   * An UNREADABLE body has no content to carry, exactly as everywhere else in
 *     this fold, and no disclosure lookup could rescue it — so it registers no
 *     deferral.
 *
 *   * A body the provider emitted inside a named reasoning block is withheld
 *     PROVISIONALLY, and the withholding is what the turn close then replaces,
 *     removes, or keeps. It may not ride text before the disclosure is known:
 *     step 3 decides a tool result's portability from
 *     `enclosingReasoningBlockId`, a `text` segment has no such member to carry,
 *     and rendering the body early would walk private provider reasoning
 *     straight past the strip that exists to remove it.
 *
 *     The marker on this provisional segment is NOT a claim that the body was
 *     unreadable — it was read. It survives into the export only on the
 *     unknown-block arm, where nothing else would record a loss; see the turn
 *     close for why the `private` arm drops the segment instead.
 *
 *   * Everything else is ordinary legacy history and rides text directly.
 *
 * The deferral is keyed by the row's own `sequence`, which is exactly the
 * `position` its segment carries: an unkeyed result row contributes ONE segment,
 * so that key names one segment in the whole fold. A row that ever contributed
 * two would break the property the turn close patches by.
 */
function unkeyedToolResultSegment(
  position: number,
  outcome: CanonicalToolResultOutcome,
  body: TranscriptToolResultBody | undefined,
  deferredEnclosedResults: Map<number, DeferredEnclosedToolResult>,
): CanonicalTranscriptSegment {
  if (body === undefined) {
    return { kind: "text", position, text: "", contentUnavailable: true };
  }
  const enclosingReasoningBlockId: string | undefined = body.enclosingReasoningBlockId;
  if (enclosingReasoningBlockId !== undefined) {
    deferredEnclosedResults.set(position, {
      enclosingReasoningBlockId,
      outcome,
      bodyText: body.text,
    });
    return { kind: "text", position, text: "", contentUnavailable: true };
  }
  return { kind: "text", position, text: renderUnkeyedToolResultText(outcome, body.text) };
}

/**
 * What a block id resolves to when one turn carries it MORE THAN ONCE under
 * disagreeing disclosures.
 *
 * The segment contract does not require block ids to be unique within a turn,
 * and a last-write-wins lookup over them silently resolves every enclosed
 * result to whichever occurrence the fold happened to read last. A private
 * block followed by a summary block reusing its id therefore erased the private
 * resolution, and an export bounded between the answer and the reasoning — the
 * one case where the stamp is the only surviving defence, since the bound cuts
 * away the in-turn floor the strip otherwise applies — shipped the enclosed
 * body.
 *
 * There is no honest occurrence-specific answer available: the enclosed result
 * names its enclosure by BLOCK ID and by nothing else, so a turn carrying two
 * different answers under one id offers the reader no way to say which one it
 * meant. Position cannot break the tie either — the enclosing row may be logged
 * after the answer it encloses, which is the whole reason this settles at turn
 * close. So the disagreement is resolved to AMBIGUOUS and both consumers take
 * their fail-closed arm: the keyed result is stamped `unknown` and withheld by
 * the strip, and the deferred legacy answer keeps its placeholder rather than
 * being rendered.
 *
 * A repeated id whose occurrences AGREE is not ambiguous. Two identical
 * disclosures answer the citation identically, so there is nothing to fail over
 * and no reason to withhold portable content.
 *
 * A unique symbol rather than a third string, so the sentinel cannot collide
 * with a member a later widening of `CanonicalReasoningDisclosure` adds. The
 * lookup's three string tests then reject it structurally rather than by
 * agreeing not to use the same word.
 */
const AMBIGUOUS_ENCLOSURE_DISCLOSURE: unique symbol = Symbol("ambiguous-enclosure-disclosure");

/** One block id's settled disclosure, or the statement that the turn disagrees. */
type ResolvedEnclosureDisclosure =
  | CanonicalReasoningDisclosure
  | typeof AMBIGUOUS_ENCLOSURE_DISCLOSURE;

/**
 * Records on a KEYED enclosed result what the turn close resolved its enclosure
 * to, for the two resolutions that withhold it and for no other.
 *
 * The stamp exists because the block id ALONE is not evidence a later reader can
 * act on. Two ways it stops being enough, and the second is why this is not a
 * lookup the strip could simply repeat:
 *
 *   * The turn's reasoning row was UNREADABLE. There are then no block ids in the
 *     turn at all — not even the one this result names — so the citation is
 *     indistinguishable from a portable one and from a citation of another turn's
 *     block. The fold knows which of the three it is, at this moment and nowhere
 *     later, so it must say so here.
 *
 *   * A positional bound is applied to the projection BEFORE the pipeline runs,
 *     and it filters by segment position. An enclosing reasoning row logged after
 *     the answer it enclosed sits at a HIGHER position than that answer, so a
 *     bound between the two keeps the result and cuts away the only segment that
 *     could classify it. The stamp rides the result it governs and survives any
 *     bound the result itself survives.
 *
 * Silent on the portable arm deliberately: a `summary` enclosure and a citation
 * of a block from another turn both leave the member absent, because nothing
 * branches on either and a stamp nothing reads is one every later fold has to
 * keep true. What IS stamped is the closed set of results that must not travel.
 *
 * A disclosure this fold does not classify stamps `unknown` rather than passing,
 * for the reason the turn close gives on its own third arm:
 * `CanonicalReasoningDisclosure` is closed at two members today, the strip
 * removes reasoning at `private` ALONE, and a third member would otherwise carry
 * an enclosed body past a strip that never claimed it. An AMBIGUOUS resolution —
 * a block id this turn carries twice under disagreeing disclosures — stamps
 * `unknown` on that same arm and for the same reason: there is no answer to
 * pass, and the reading that would let the body travel is the one no evidence
 * supports. See {@link AMBIGUOUS_ENCLOSURE_DISCLOSURE}.
 */
function stampEnclosureDisclosure(
  segment: CanonicalTranscriptSegment,
  disclosureByBlockId: ReadonlyMap<string, ResolvedEnclosureDisclosure>,
  turnHoldsUnreadableReasoning: boolean,
): CanonicalTranscriptSegment {
  if (segment.kind !== "tool_result" || segment.enclosingReasoningBlockId === undefined) {
    return segment;
  }
  const disclosure: ResolvedEnclosureDisclosure | undefined = disclosureByBlockId.get(
    segment.enclosingReasoningBlockId,
  );
  if (disclosure === "summary") {
    return segment;
  }
  if (disclosure === "private") {
    return { ...segment, enclosureDisclosure: "private" };
  }
  if (disclosure === undefined && !turnHoldsUnreadableReasoning) {
    // A citation of a block this turn never carried, in a turn whose reasoning
    // was read in full. Deliberately retained as provider output — the strip's
    // cross-turn rule, unchanged.
    return segment;
  }
  return { ...segment, enclosureDisclosure: "unknown" };
}

// --------------------------------------------------------------------------
// The export bound
// --------------------------------------------------------------------------

/**
 * The bound one export is taken under: an inclusive position ceiling, or the
 * EXPLICIT statement that the caller wants the whole projection.
 *
 * Deliberately not an optional number. The export contract's `boundary` member
 * is required, so every production caller holds a value and only has to forward
 * it — and an optional parameter is precisely the seam where forwarding is
 * forgettable: a caller that omits it would silently export the entire
 * conversation, which is the leak this bound exists to prevent. Requiring
 * `"unbounded"` turns that omission into a type error and makes the whole-
 * projection arm a decision a reader can see at the call site.
 */
export type TranscriptExportBound = number | "unbounded";

/**
 * The projection an export bounded at `bound` is entitled to see.
 *
 * INCLUSIVE, matching the export contract: an export carries exactly the
 * SEGMENTS whose `position` is at or below the bound, and a turn left with none
 * is dropped. `"unbounded"` means the whole projection — stated, never
 * defaulted; see {@link TranscriptExportBound}.
 *
 * Per segment and not per turn, because the fold coalesces consecutive same-role
 * events into ONE turn positioned at the first of them: a turn opened at 5 and
 * holding a segment from position 7 passes a `turn.position <= 5` filter whole,
 * carrying the later event's content straight across the boundary. Filtering the
 * segments instead yields exactly the turn the fold bounded at the same position
 * would have built, because the fold walks the log in ascending order, so within
 * a turn it builds the over-bound segments are always a suffix.
 *
 * `builtAtPosition` is deliberately left where the fold put it. It records the
 * position the projection was TAKEN at — evidence of the fold's liveness — and a
 * bound is a question about what this one export may carry, not a claim that the
 * conversation stopped there. Moving it would make a bounded export
 * indistinguishable from a stale one.
 *
 * Applied BEFORE the first pipeline step, never after. Every later step reads
 * the turn list: the export declares `turn_content_unavailable` over it, the
 * strip removes non-portable content from it, and pairing repair reasons about
 * which calls have answers within it. Filtering afterwards would let content the
 * export may not carry decide the declared losses — and would pair a call inside
 * the bound with a result outside it, so the bound would silently repair itself
 * away. It is also why the suffix property above is stated of the FOLD's output
 * and not of any turn: pairing repair re-homes a result behind the call it
 * answers, which can leave a repaired turn's positions out of order.
 *
 * Applied AFTER the whole fold, equally deliberately, and that is why this lives
 * here rather than beside the pipeline it feeds. A bounded fold that skipped
 * over-bound events as it walked would settle each turn's enclosures against a
 * truncated view of that turn: a keyed result at position 3 enclosed by private
 * reasoning logged at position 4 would never meet the row that condemns it, so
 * it would leave the fold unstamped and the strip would ship its body. The
 * enclosure resolution is a property of the whole turn, and the fold has to see
 * the whole turn to settle it. Bounding the finished projection is what makes
 * `build({boundary: n})` equal to `boundProjectionToPosition(build({}), n)` by
 * construction rather than by convention.
 */
export function boundProjectionToPosition(
  projection: CanonicalTranscriptProjection,
  bound: TranscriptExportBound,
): CanonicalTranscriptProjection {
  if (bound === "unbounded") {
    return projection;
  }
  const boundedTurns: CanonicalTranscriptTurn[] = [];
  for (const turn of projection.turns) {
    const segments: readonly CanonicalTranscriptSegment[] = turn.segments.filter(
      (segment) => segment.position <= bound,
    );
    if (segments.length > 0) {
      boundedTurns.push({ ...turn, segments });
    }
  }
  return { ...projection, turns: boundedTurns };
}

// --------------------------------------------------------------------------
// The fold
// --------------------------------------------------------------------------

/** Construction inputs for {@link CanonicalTranscriptFold}. */
export interface CanonicalTranscriptFoldDependencies {
  readonly eventReader: TranscriptEventReader;
  readonly contentSource: TranscriptContentSource;
}

/** What {@link CanonicalTranscriptFold.build} is asked for. */
export interface CanonicalTranscriptFoldRequest {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  /**
   * Fold up to and including this normalized session position — the same
   * position vocabulary `RollbackToParams.position` uses, so a rewind and the
   * export that reconstitutes the session past it name boundaries the same way.
   * ABSENT means the whole run.
   *
   * The same value `ExportTranscriptParams.boundary` carries, in the same
   * vocabulary: an export of this projection is bounded by the position the fold
   * that built it was bounded to, and where this fold ran unbounded, by the
   * projection's newest turn position. The two are not answers that can
   * disagree, because the driver is handed the reconciliation rule rather than a
   * choice — it retains exactly the SEGMENTS whose `position` is at or below the
   * bound, dropping any turn that leaves empty. Per segment and not per turn,
   * because this fold coalesces consecutive same-role events into one turn
   * positioned at the first of them: a turn-level filter would carry every later
   * event folded into it across the boundary. That is a deterministic filter over
   * segments it already holds: it opens no log, and mints no second record of the
   * session's order. A projection this fold already bounded filters to itself.
   *
   * Honoured by running {@link boundProjectionToPosition} over the FINISHED fold
   * rather than by skipping over-bound rows as the log is walked, so a bounded
   * build is the bound of the unbounded one by construction. The reason the
   * distinction matters — enclosure resolution being a property of the whole turn
   * — is on that function.
   */
  readonly boundary?: number | undefined;
}

export class CanonicalTranscriptFold {
  readonly #eventReader: TranscriptEventReader;
  readonly #contentSource: TranscriptContentSource;

  constructor(dependencies: CanonicalTranscriptFoldDependencies) {
    this.#eventReader = dependencies.eventReader;
    this.#contentSource = dependencies.contentSource;
  }

  /**
   * Rebuild the run's canonical transcript from the log. Called twice with no
   * intervening append, this returns an equal projection; called again after an
   * append, `builtAtPosition` moves. Nothing is memoized between calls.
   */
  build(request: CanonicalTranscriptFoldRequest): CanonicalTranscriptProjection {
    const loggedEvents: ReadonlyArray<StoredEvent> = this.#eventReader.readEvents(
      request.sessionId as string,
    );

    // Taken over the WHOLE log, not over the run's in-scope rows: an event
    // appended anywhere in the session moves the position, which is what makes
    // the member evidence that this is a live fold rather than a cached one.
    let newestLoggedPosition = 0;
    for (const event of loggedEvents) {
      if (event.sequence > newestLoggedPosition) {
        newestLoggedPosition = event.sequence;
      }
    }

    const turns: CanonicalTranscriptTurn[] = [];
    let openTurn:
      | { role: CanonicalTranscriptRole; position: number; segments: CanonicalTranscriptSegment[] }
      | undefined;

    // Legacy enclosed answers awaiting the disclosure of the block that carried
    // them. Build-scoped like everything else here: the fold memoizes nothing.
    const deferredEnclosedResults: Map<number, DeferredEnclosedToolResult> = new Map();

    // Positions of `assistant.thinking_update` rows whose blocks could not be
    // read. Build-scoped like the map above, and read only at turn close.
    const unreadableReasoningPositions: Set<number> = new Set<number>();

    /**
     * Settles every enclosure the turn carries against the turn's OWN reasoning
     * segments — the boundary the pipeline's strip already scopes enclosure to,
     * since a block id is unique only within the exchange that minted it. Taken
     * at turn close because the row carrying the enclosing block may be logged
     * AFTER the answer it enclosed.
     *
     * Two dispositions, one lookup. A deferred LEGACY answer is rendered,
     * removed, or left withheld by the three arms below. A KEYED result keeps its
     * segment either way and is stamped with the resolution instead, because its
     * removal belongs to the strip — see the stamp helper for why the resolution
     * may not simply be re-derived there.
     *
     * Returns the settled segments rather than patching them in place: one of
     * the three arms REMOVES a segment, which an index-keyed patch cannot do.
     *
     *   * `summary` — participant-visible history. The answer is portable
     *     content, rides ordinary legacy text, and loses nothing.
     *
     *   * `private` — the answer is replaced by an empty text segment carrying
     *     `withheldEnclosure`, at the position the result held. Not the
     *     provisional placeholder: the body was read successfully and then
     *     deliberately withheld, so a retained `contentUnavailable` marker
     *     declares an unavailability that never happened, and both consumers
     *     repeat it — the export adds `turn_content_unavailable` beside a loss
     *     it already declared, and the memo renders the body as content that
     *     could not be recovered. And not bare removal either, which this arm
     *     once did: removal delegated the loss declaration to the enclosing
     *     reasoning segment, and a positional bound between the result and its
     *     LATER-logged reasoning row keeps the result's position while cutting
     *     away the only segment that could declare the loss — the bounded
     *     export then declared nothing. The same geometry forced the keyed
     *     arm's stamp, and the remedy is the same carrier rule: the marker
     *     rides the position the withheld body held and survives any bound the
     *     result itself would have survived. The strip drops the marker and
     *     declares `provider_private_reasoning` — deduplicated, so the
     *     unbounded case, where the private block survives to the strip and
     *     declares the same kind, still declares once — and the memo floor runs
     *     that same strip, so the marker reaches no rendered surface.
     *
     *   * anything else — FAIL-CLOSED: the placeholder stays. Two readings
     *     land here: the block the turn does not carry, which has no enclosing
     *     segment for a loss to ride, and a block id the turn carries twice
     *     under disagreeing disclosures, which has no answer at all. Stricter
     *     than the strip's rule for a keyed result, which survives citing a
     *     block from another turn, and the asymmetry is erasure: a keyed result
     *     carries its enclosure member forward so a later reader can still act
     *     on it, while rendering a legacy answer to text drops the member for
     *     good.
     *
     * The `private` arm is an explicit test rather than the `else` of the
     * `summary` one. `CanonicalReasoningDisclosure` is closed at two members, so
     * the two forms agree today — but the strip removes reasoning at `private`
     * ALONE, so a third member would flatten to text under no declared loss, and
     * an `else`-shaped removal arm would then erase an enclosed body in silence.
     * A new member belongs on the fail-closed arm until the strip claims it.
     */
    const settleTurnEnclosures = (
      segments: CanonicalTranscriptSegment[],
    ): CanonicalTranscriptSegment[] => {
      // Accumulated rather than assigned: a block id this turn carries twice
      // under disagreeing disclosures resolves to AMBIGUOUS and both arms below
      // fail closed on it. See the sentinel's own note for why no
      // occurrence-specific answer exists to prefer instead.
      const disclosureByBlockId: Map<string, ResolvedEnclosureDisclosure> = new Map();
      for (const segment of segments) {
        if (segment.kind !== "reasoning") {
          continue;
        }
        const alreadyResolved: ResolvedEnclosureDisclosure | undefined = disclosureByBlockId.get(
          segment.blockId,
        );
        if (alreadyResolved === undefined) {
          disclosureByBlockId.set(segment.blockId, segment.disclosure);
          continue;
        }
        if (alreadyResolved !== segment.disclosure) {
          disclosureByBlockId.set(segment.blockId, AMBIGUOUS_ENCLOSURE_DISCLOSURE);
        }
      }
      // Whether any row in THIS turn carried reasoning the fold could not read.
      // The unreadable row contributes no block ids at all — not even the id the
      // enclosed result names — so an unresolved citation inside such a turn is
      // exactly the case that cannot be told apart from a portable one.
      const turnHoldsUnreadableReasoning: boolean = segments.some((segment) =>
        unreadableReasoningPositions.has(segment.position),
      );
      const settledSegments: CanonicalTranscriptSegment[] = [];
      for (const segment of segments) {
        const deferred: DeferredEnclosedToolResult | undefined = deferredEnclosedResults.get(
          segment.position,
        );
        if (deferred === undefined) {
          settledSegments.push(
            stampEnclosureDisclosure(segment, disclosureByBlockId, turnHoldsUnreadableReasoning),
          );
          continue;
        }
        deferredEnclosedResults.delete(segment.position);
        const disclosure: ResolvedEnclosureDisclosure | undefined = disclosureByBlockId.get(
          deferred.enclosingReasoningBlockId,
        );
        if (disclosure === "summary") {
          settledSegments.push({
            kind: "text",
            position: segment.position,
            text: renderUnkeyedToolResultText(deferred.outcome, deferred.bodyText),
          });
          continue;
        }
        if (disclosure === "private") {
          settledSegments.push({
            kind: "text",
            position: segment.position,
            text: "",
            withheldEnclosure: "private",
          });
          continue;
        }
        settledSegments.push(segment);
      }
      return settledSegments;
    };

    const closeOpenTurn = (): void => {
      const closingTurn = openTurn;
      openTurn = undefined;
      if (closingTurn === undefined) {
        return;
      }
      const settledSegments: CanonicalTranscriptSegment[] = settleTurnEnclosures(
        closingTurn.segments,
      );
      // Belt-and-braces rather than the thing carrying the `private` arm: that
      // arm always leaves its `withheldEnclosure` marker behind. What this
      // guards is every other way a turn can reach here with nothing in it.
      if (settledSegments.length > 0) {
        turns.push({
          position: closingTurn.position,
          role: closingTurn.role,
          segments: settledSegments,
        });
      }
    };

    const appendSegments = (
      role: CanonicalTranscriptRole,
      position: number,
      segments: readonly CanonicalTranscriptSegment[],
    ): void => {
      if (segments.length === 0) {
        return;
      }
      if (openTurn === undefined || openTurn.role !== role) {
        closeOpenTurn();
        openTurn = { role, position, segments: [] };
      }
      openTurn.segments.push(...segments);
    };

    for (const event of loggedEvents) {
      if (!isEventInRunScope(event, request.runId)) {
        continue;
      }
      // No boundary skip here, deliberately, and restoring one as the obvious
      // optimization reopens a real leak. Enclosure resolution is settled at
      // turn CLOSE against the turn's own reasoning segments, and the row
      // carrying an enclosing block may be logged after the answer it enclosed —
      // so a walk that stopped at the bound would settle a turn against a
      // truncated view of itself, and a result inside the bound enclosed by
      // private reasoning just past it would leave the fold unstamped and ship
      // its body. The fold reads the whole run and bounds its OUTPUT below.
      //
      // Reading past the bound is not a disclosure. The reader here is the
      // daemon's own event store, over a session the daemon already holds in
      // full; every over-bound segment is discarded before this method returns,
      // and nothing built from one survives except the enclosure verdict, which
      // is a decision to WITHHOLD.

      // A turn marker closes whatever is open WITHOUT contributing content, so
      // two assistant turns in a row stay two turns.
      if (event.type === "run.turn_started") {
        closeOpenTurn();
        continue;
      }

      const reference: TranscriptContentReference = {
        sessionId: request.sessionId,
        runId: request.runId,
        sequence: event.sequence,
        eventType: event.type,
        toolCallId: readStringMember(event.payload, "toolCallId"),
      };

      if (event.type === "user.message") {
        appendSegments("participant", event.sequence, this.#participantSegmentsFor(reference));
        continue;
      }

      appendSegments(
        "assistant",
        event.sequence,
        this.#assistantSegmentsFor(
          event,
          reference,
          deferredEnclosedResults,
          unreadableReasoningPositions,
        ),
      );
    }

    closeOpenTurn();

    const projection: CanonicalTranscriptProjection = {
      sessionId: request.sessionId,
      runId: request.runId,
      builtAtPosition: newestLoggedPosition,
      turns,
    };
    // The one place the request's bound is honoured, and it runs over the
    // FINISHED fold. `builtAtPosition` rides through untouched — it records where
    // the fold was taken, not where this projection was cut; see
    // {@link boundProjectionToPosition}.
    return request.boundary === undefined
      ? projection
      : boundProjectionToPosition(projection, request.boundary);
  }

  /**
   * The segment an unkeyed tool INVOCATION contributes.
   *
   * A call carries no enclosure member in the segment union at all — step 3
   * never drops a call — so the text arm here has no portability hazard to
   * dodge, unlike its result sibling. Unreadable arguments still take the
   * empty-body-marked disposition, because `contentUnavailable` requires an
   * empty body: inventing text is the one thing this fold may not do, and that
   * costs the tool NAME on that path in exchange for a declared loss.
   */
  #unkeyedToolCallSegment(
    reference: TranscriptContentReference,
    toolName: string | undefined,
  ): CanonicalTranscriptSegment {
    const argumentsJson: string | undefined = this.#contentSource.readToolCallArguments(reference);
    if (argumentsJson === undefined) {
      return { kind: "text", position: reference.sequence, text: "", contentUnavailable: true };
    }
    return {
      kind: "text",
      position: reference.sequence,
      text: renderUnkeyedToolCallText(toolName, argumentsJson),
    };
  }

  /**
   * The participant's own words, read through the content port for the reason
   * the header gives: the clear `user.message` payload does not carry them.
   *
   * The unavailable disposition is `assistant.message`'s, deliberately: an
   * unreadable body is carried as an EMPTY body marked `contentUnavailable`, so
   * the turn keeps its structural position and the fold declares the loss over
   * it. Dropping it instead would erase words a person actually typed and
   * declare nothing — the one reading the declared-loss rule forbids.
   */
  #participantSegmentsFor(
    reference: TranscriptContentReference,
  ): readonly CanonicalTranscriptSegment[] {
    const text: string | undefined = this.#contentSource.readParticipantText(reference);
    if (text === undefined) {
      return [{ kind: "text", position: reference.sequence, text: "", contentUnavailable: true }];
    }
    return text.length === 0 ? [] : [{ kind: "text", position: reference.sequence, text }];
  }

  #assistantSegmentsFor(
    event: StoredEvent,
    reference: TranscriptContentReference,
    deferredEnclosedResults: Map<number, DeferredEnclosedToolResult>,
    unreadableReasoningPositions: Set<number>,
  ): readonly CanonicalTranscriptSegment[] {
    switch (event.type) {
      case "assistant.message": {
        const text: string | undefined = this.#contentSource.readAssistantText(reference);
        // An UNAVAILABLE body and an EMPTY one are different facts and are kept
        // apart here: the first is a turn whose words this fold could not read,
        // the second a row that carried none.
        if (text === undefined) {
          return [
            { kind: "text", position: reference.sequence, text: "", contentUnavailable: true },
          ];
        }
        return text.length === 0 ? [] : [{ kind: "text", position: reference.sequence, text }];
      }
      case "assistant.thinking_update": {
        const blocks: readonly TranscriptReasoningBlock[] | undefined =
          this.#contentSource.readReasoningBlocks(reference);
        // Unreadable blocks are marked on a TEXT segment, and neither half of
        // that is incidental. The pipeline's unavailability predicate excludes
        // the reasoning arm, so a reasoning-kind marker would declare no loss at
        // all; and this fold has no block to read a `disclosure` from, which
        // that arm requires. Text is the one honest carrier — and it is what the
        // strip turns a kept block into anyway.
        //
        // The position is ALSO registered, because the marker alone cannot say
        // what it stands in for: an unreadable assistant message and an
        // unreadable tool body produce a segment of exactly this shape. The turn
        // close needs the distinction — a result citing a block from a row that
        // could not be read is a result whose portability is unknowable — and
        // this is the only moment the fold still knows which row it was.
        if (blocks === undefined) {
          unreadableReasoningPositions.add(reference.sequence);
          return [
            { kind: "text", position: reference.sequence, text: "", contentUnavailable: true },
          ];
        }
        return blocks.map(
          (block): CanonicalTranscriptSegment => ({
            kind: "reasoning",
            position: reference.sequence,
            blockId: block.blockId,
            reasoningKind: block.reasoningKind,
            disclosure: block.disclosure,
            text: block.text,
          }),
        );
      }
      case "tool.invoked": {
        const toolCallId: string | undefined = reference.toolCallId;
        const toolName: string | undefined = readStringMember(event.payload, "toolName");
        // A row carrying NO pairing key is legacy history rather than
        // malformation — the taxonomy made that key mandatory only for live
        // emitters, and older tool rows legally omit it — so it is a tool
        // invocation the participant actually watched happen. It cannot be
        // carried as a structured call, because the transcript would have to
        // mint the missing id and the never-re-mint rule forbids exactly that at
        // the one moment nobody could tell. Its content rides a TEXT segment
        // instead. Dropping it would erase participant-visible activity and
        // declare nothing over it, which is the reading the declared-loss rule
        // forbids of this module everywhere else.
        if (toolCallId === undefined) {
          return [this.#unkeyedToolCallSegment(reference, toolName)];
        }
        // A call whose NAME is missing keeps the drop. That row is not legal
        // history in either direction — the tool shape names `toolName`
        // unconditionally and makes only `toolCallId` optional — and carrying it
        // as text would throw away a pairing key that IS present, orphaning the
        // sibling result under that id and costing a repair loss the current
        // code does not produce.
        if (toolName === undefined) {
          return [];
        }
        const argumentsJson: string | undefined =
          this.#contentSource.readToolCallArguments(reference);
        return [
          {
            kind: "tool_call",
            position: reference.sequence,
            toolCallId,
            toolName,
            argumentsJson: argumentsJson ?? "",
            ...(argumentsJson === undefined ? { contentUnavailable: true } : {}),
          },
        ];
      }
      case "tool.result":
      case "tool.error": {
        const toolCallId: string | undefined = reference.toolCallId;
        const outcome: CanonicalToolResultOutcome =
          event.type === "tool.error" ? "failed" : "succeeded";
        const body: TranscriptToolResultBody | undefined =
          this.#contentSource.readToolResultBody(reference);
        // The invocation arm's rule, applied to the answer half: a legacy row
        // with no pairing key is carried as content rather than dropped.
        if (toolCallId === undefined) {
          return [
            unkeyedToolResultSegment(reference.sequence, outcome, body, deferredEnclosedResults),
          ];
        }
        return [
          {
            kind: "tool_result",
            position: reference.sequence,
            toolCallId,
            outcome,
            provenance: "provider",
            text: body?.text ?? "",
            enclosingReasoningBlockId: body?.enclosingReasoningBlockId,
            ...(body === undefined ? { contentUnavailable: true } : {}),
          },
        ];
      }
      default:
        return [];
    }
  }
}

// --------------------------------------------------------------------------
// Payload readers
// --------------------------------------------------------------------------

function readStringMember(payload: Record<string, unknown>, member: string): string | undefined {
  const value: unknown = payload[member];
  return typeof value === "string" ? value : undefined;
}
