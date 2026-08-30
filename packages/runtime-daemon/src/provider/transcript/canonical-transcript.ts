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
 * Every method may answer "nothing": an absent body is a row whose
 * content is unavailable, which the fold renders as an EMPTY body marked
 * `contentUnavailable` rather than by inventing text or by dropping the row.
 * Dropping it would erase a turn that happened, and the pipeline would then
 * declare no loss over it — the one reading the declared-loss rule forbids.
 *
 * `readReasoningBlocks` is the exception and returns no unavailability signal,
 * because its return type has no absent arm to answer with: a block list is
 * total and every block's body is required, so there is nothing here to mark.
 * Should a block body ever become expressibly absent, this arm owes the same
 * treatment as the others — a non-private block is FLATTENED and kept by step 3
 * under no declared loss, so an unreadable one would go out silently.
 */
export interface TranscriptContentSource {
  readAssistantText(reference: TranscriptContentReference): string | undefined;
  readParticipantText(reference: TranscriptContentReference): string | undefined;
  readReasoningBlocks(reference: TranscriptContentReference): readonly TranscriptReasoningBlock[];
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
 * The segment an unkeyed tool RESULT contributes.
 *
 * Two rows land on the empty-body-marked disposition rather than on rendered
 * text, and the second is the load-bearing one:
 *
 *   * An unreadable body has no content to carry, exactly as everywhere else in
 *     this fold.
 *
 *   * A body the provider emitted INSIDE a reasoning block cannot ride a text
 *     segment at all. Step 3 of the pipeline decides a tool result's
 *     portability from `enclosingReasoningBlockId`, and a `text` segment has no
 *     such member to carry — so rendering the body as text would walk private
 *     provider reasoning straight past the strip that exists to remove it. The
 *     content is therefore withheld and MARKED, never silently dropped: the
 *     reader learns a body was here and is not in this transcript, which is the
 *     honest reading, and the pipeline declares the loss over the turn.
 */
function unkeyedToolResultSegment(
  position: number,
  outcome: CanonicalToolResultOutcome,
  body: TranscriptToolResultBody | undefined,
): CanonicalTranscriptSegment {
  if (body === undefined || body.enclosingReasoningBlockId !== undefined) {
    return { kind: "text", position, text: "", contentUnavailable: true };
  }
  return { kind: "text", position, text: renderUnkeyedToolResultText(outcome, body.text) };
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

    const closeOpenTurn = (): void => {
      if (openTurn !== undefined && openTurn.segments.length > 0) {
        turns.push({
          position: openTurn.position,
          role: openTurn.role,
          segments: openTurn.segments,
        });
      }
      openTurn = undefined;
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

      appendSegments("assistant", event.sequence, this.#assistantSegmentsFor(event, reference));
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
        return this.#contentSource.readReasoningBlocks(reference).map(
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
          return [unkeyedToolResultSegment(reference.sequence, outcome, body)];
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
