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
 * an enclosed body past a strip that never claimed it.
 */
function stampEnclosureDisclosure(
  segment: CanonicalTranscriptSegment,
  disclosureByBlockId: ReadonlyMap<string, CanonicalReasoningDisclosure>,
  turnHoldsUnreadableReasoning: boolean,
): CanonicalTranscriptSegment {
  if (segment.kind !== "tool_result" || segment.enclosingReasoningBlockId === undefined) {
    return segment;
  }
  const disclosure: CanonicalReasoningDisclosure | undefined = disclosureByBlockId.get(
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
     *   * `private` — the answer is REMOVED, exactly as the strip removes a
     *     KEYED enclosed result along with the block that carried it. Keeping
     *     the provisional placeholder here would put a false statement in the
     *     record: the body was read successfully and then deliberately withheld,
     *     so a retained `contentUnavailable` marker declares an unavailability
     *     that never happened, and both consumers repeat it — the export adds
     *     `turn_content_unavailable` beside a loss it already declared, and the
     *     memo renders the body as content that could not be recovered. The real
     *     loss belongs to the enclosing block, and both consumers already
     *     declare THAT one: the strip drops the private block and declares
     *     `provider_private_reasoning`, and the memo floor runs that same strip.
     *     A turn cannot go empty on this arm — the disclosure was read off a
     *     reasoning segment in THIS array and reasoning segments are never
     *     deferred, so the enclosing segment always survives the settle.
     *
     *   * anything else — FAIL-CLOSED: the placeholder stays, because this is
     *     the block the turn does not carry and there is no enclosing segment
     *     for a loss to ride. Stricter than the strip's rule for a keyed result,
     *     which survives citing a block from another turn, and the asymmetry is
     *     erasure: a keyed result carries its enclosure member forward so a
     *     later reader can still act on it, while rendering a legacy answer to
     *     text drops the member for good.
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
      const disclosureByBlockId: Map<string, CanonicalReasoningDisclosure> = new Map();
      for (const segment of segments) {
        if (segment.kind === "reasoning") {
          disclosureByBlockId.set(segment.blockId, segment.disclosure);
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
        const disclosure: CanonicalReasoningDisclosure | undefined = disclosureByBlockId.get(
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
      // arm always leaves its enclosing reasoning segment behind. What this
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
      if (request.boundary !== undefined && event.sequence > request.boundary) {
        continue;
      }

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

    return {
      sessionId: request.sessionId,
      runId: request.runId,
      builtAtPosition: newestLoggedPosition,
      turns,
    };
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
