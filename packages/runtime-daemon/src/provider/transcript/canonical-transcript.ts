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
//     type, the run a row belongs to, tool names, tool-call ids, and the
//     participant's own message text — which IS a durable payload member.
//
//   * Everything else the transcript renders — assistant prose, reasoning block
//     bodies, serialized tool arguments, tool result bodies — is NOT in a
//     durable payload. Deliberate, per `Spec-006 §Assistant Output (assistant_output)`
//     and `Spec-006 §Tool Activity (tool_activity)`:
//     the payload shapes are metadata-shaped by construction, assistant output
//     carrying `contentType` / `contentLength` and never message text, tool
//     activity carrying no tool output, so unbounded content always rides
//     behind a reference.
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
// `Spec-006 §Tool Activity (tool_activity)`.

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
 * Supplies the content the durable payloads deliberately do not carry — see the
 * header. Every method may answer "nothing": an absent body is a row whose
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
   * This is the ONE place a bound is applied. `ExportTranscriptParams` carries
   * no boundary member: it takes the projection this call produced, so the turns
   * are the record of where the transcript ends and a driver cannot be handed
   * two answers to disagree about.
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
        appendSegments("participant", event.sequence, participantSegmentsFor(event));
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
          return [{ kind: "text", text: "", contentUnavailable: true }];
        }
        return text.length === 0 ? [] : [{ kind: "text", text }];
      }
      case "assistant.thinking_update": {
        return this.#contentSource.readReasoningBlocks(reference).map(
          (block): CanonicalTranscriptSegment => ({
            kind: "reasoning",
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
        // A call row missing either durable key is not a call the transcript can
        // pair or replay; it is dropped rather than rendered with a minted id,
        // because a minted id would violate the never-re-mint rule at the one
        // moment nobody could tell.
        if (toolCallId === undefined || toolName === undefined) {
          return [];
        }
        const argumentsJson: string | undefined =
          this.#contentSource.readToolCallArguments(reference);
        return [
          {
            kind: "tool_call",
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
        if (toolCallId === undefined) {
          return [];
        }
        const body: TranscriptToolResultBody | undefined =
          this.#contentSource.readToolResultBody(reference);
        return [
          {
            kind: "tool_result",
            toolCallId,
            outcome: event.type === "tool.error" ? "failed" : "succeeded",
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

/**
 * The participant's own words, read straight from the durable payload — the one
 * transcript content the log does carry, because a participant message is
 * bounded by what a person typed.
 */
function participantSegmentsFor(event: StoredEvent): readonly CanonicalTranscriptSegment[] {
  const message: string | undefined = readStringMember(event.payload, "message");
  return message === undefined || message.length === 0 ? [] : [{ kind: "text", text: message }];
}
