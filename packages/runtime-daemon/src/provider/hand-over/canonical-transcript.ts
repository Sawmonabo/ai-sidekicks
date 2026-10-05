// The canonical transcript fold: a provider session's content as ordered turns, rebuilt from the
// session log on every call.
//
// - The transcript is a projection, not a store. `CanonicalTranscriptFold.build()` keeps nothing
//   between calls, so it cannot disagree with the log; `builtAtPosition` lets a caller see the
//   fold move.
// - The log supplies order, identity and pairing (sequence, event type, run, tool names, tool
//   call ids) from the clear payload of each event.
// - The person's words are the `user.message` payload's own `message`. Every machine-authored
//   body (assistant text, reasoning blocks, tool arguments, tool results) comes from
//   `TranscriptContentSource`, which this module declares and does not implement.

import type { RunId } from "@ai-sidekicks/contracts/provider/driver/driver";
import type { SessionId } from "@ai-sidekicks/contracts/session/session";

import type { StoredEvent } from "../../session/types.js";
import type {
  CanonicalReasoningDisclosure,
  CanonicalTranscriptProjection,
  CanonicalTranscriptRole,
  CanonicalTranscriptSegment,
  CanonicalTranscriptTurn,
} from "../driver/provider-driver.js";

/**
 * The slice of the session store the fold reads: the signature of `SessionService.readEvents`.
 */
export interface TranscriptEventReader {
  readEvents(sessionId: string): ReadonlyArray<StoredEvent>;
}

/**
 * Identifies the one logged row whose content is asked for. Keyed by the row's `sequence`, not a
 * content hash, so two identical assistant replies stay two lookups.
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
 * Supplies every machine-authored body, which the log keeps beside the payload.
 *
 * A method answering `undefined` means the row's content is unavailable; the fold then renders an
 * empty body marked `contentUnavailable` rather than inventing text or dropping the row, because
 * dropping a turn that happened would leave the export declaring no loss. `readReasoningBlocks`
 * separates an empty list (the row carried no blocks) from `undefined` (its blocks could not be
 * read), so summary reasoning the user already saw cannot vanish from an export in silence.
 */
export interface TranscriptContentSource {
  readAssistantText(reference: TranscriptContentReference): string | undefined;
  readReasoningBlocks(
    reference: TranscriptContentReference,
  ): readonly TranscriptReasoningBlock[] | undefined;
  readToolCallArguments(reference: TranscriptContentReference): string | undefined;
  readToolResultBody(reference: TranscriptContentReference): TranscriptToolResultBody | undefined;
}

/**
 * The event types that contribute transcript content. `run.turn_started` adds no segment but is in
 * scope: it is the only row that separates two consecutive assistant turns, which would otherwise
 * coalesce.
 */
const TRANSCRIPT_BEARING_EVENT_TYPES: readonly string[] = [
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
 * Whether a logged row belongs to the named run's transcript. A row qualifies only when its
 * payload names the run: a row naming no run cannot be proven to belong to this one, and admitting
 * it could carry another run's conversation into this run's hand-over brief.
 */
function isEventInRunScope(event: StoredEvent, runId: RunId): boolean {
  if (!TRANSCRIPT_BEARING_EVENT_TYPE_SET.has(event.type)) {
    return false;
  }
  const payloadRunId: unknown = event.payload["runId"];
  return typeof payloadRunId === "string" && payloadRunId === (runId as string);
}

/** The two outcomes a tool row can report, in the segment union's spelling. */
type CanonicalToolResultOutcome = "succeeded" | "failed";

/**
 * Renders a tool row that has no pairing key as visible ASCII text, in the brief renderer's line
 * shape minus the identifier, so it reads as a tool line and never as prose the assistant wrote.
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
 * An unkeyed tool result the provider emitted inside a named reasoning block, held until the turn
 * closes. Whether it may travel depends on that block's disclosure, and the block's row can be
 * logged after the result.
 */
interface DeferredEnclosedToolResult {
  readonly enclosingReasoningBlockId: string;
  readonly outcome: CanonicalToolResultOutcome;
  readonly bodyText: string;
}

/**
 * The segment an unkeyed tool result contributes, registering the deferral an enclosed one owes.
 *
 * - An unreadable body yields an empty `contentUnavailable` text segment and no deferral.
 * - A body emitted inside a named reasoning block yields the same empty placeholder plus a
 *   deferral keyed by `position`. Rendering it before the block's disclosure is known could carry
 *   private reasoning past the strip, and a text segment has no enclosure member to let the strip
 *   catch it. The marker there does not mean the body was unreadable; it survives into the export
 *   only when the block's disclosure is unknown.
 * - Anything else is rendered as text directly.
 *
 * An unkeyed result row contributes one segment, so `position` names exactly one segment.
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
 * What a block id resolves to when one turn carries it more than once under disagreeing
 * disclosures. Block ids need not be unique within a turn, and an enclosed result names its block
 * by id alone. Position cannot break the tie either, since the enclosing row may be logged after
 * the answer. Both consumers therefore fail closed: a keyed result is stamped `unknown` and
 * withheld by the strip, and a deferred unkeyed result keeps its placeholder. Repeated ids whose
 * disclosures agree are not ambiguous. A unique symbol, so a future disclosure value cannot
 * collide with it.
 */
const AMBIGUOUS_ENCLOSURE_DISCLOSURE: unique symbol = Symbol("ambiguous-enclosure-disclosure");

/** One block id's settled disclosure, or the statement that the turn disagrees. */
type ResolvedEnclosureDisclosure =
  | CanonicalReasoningDisclosure
  | typeof AMBIGUOUS_ENCLOSURE_DISCLOSURE;

/**
 * Stamps `enclosureDisclosure` on a keyed enclosed result when its enclosure resolved to
 * `private`, or to anything not provably portable (`unknown`). The block id alone is not enough
 * for a later reader:
 *
 * - If the turn's reasoning row was unreadable, the turn has no block ids at all, so a citation
 *   cannot be told from a portable one or from a citation of another turn's block.
 * - A positional bound applied before the pipeline can keep the result while cutting away the
 *   reasoning segment that would classify it, since that row may be logged after the answer.
 *
 * A `summary` enclosure and a citation of a block from another turn stay unstamped, because
 * nothing reads a stamp on the portable path. A disclosure this fold does not classify, and an
 * ambiguous one, stamp `unknown`: the strip removes reasoning at `private` alone, so passing such
 * a result would let its body travel.
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
    // A block this turn never carried, in a turn whose reasoning was read in full: retained as
    // provider output, as the strip does for a cross-turn citation.
    return segment;
  }
  return { ...segment, enclosureDisclosure: "unknown" };
}

/**
 * The bound one export is taken under: an inclusive position ceiling, or `"unbounded"` for the
 * whole projection. Not an optional number, so a caller that forgets to forward the bound gets a
 * type error instead of silently exporting the entire conversation.
 */
export type TranscriptExportBound = number | "unbounded";

/**
 * The projection an export bounded at `bound` may see: only the segments whose `position` is at
 * or below the bound, dropping turns left empty. `"unbounded"` returns the projection unchanged.
 *
 * - Filtering is per segment, not per turn: a turn is positioned at its first event, so a
 *   turn-level filter would carry later events across the bound.
 * - `builtAtPosition` stays as the fold set it. It records where the fold was taken, and moving
 *   it would make a bounded export look stale.
 * - The bound is applied before the pipeline, so content past it cannot decide the declared
 *   losses or be paired with a call inside the bound.
 * - It is applied after the whole fold, not while walking the log, because enclosure resolution
 *   needs the whole turn. That makes `build({ boundary: n })` equal
 *   `boundProjectionToPosition(build({}), n)`.
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
   * Fold up to and including this normalized session position, the vocabulary
   * `ForkConversationParams.position` uses. Absent means the whole run. Applied by
   * {@link boundProjectionToPosition} to the finished fold, not by skipping rows while walking
   * the log.
   */
  readonly boundary?: number | undefined;
}

/**
 * Builds a run's canonical transcript projection from the session log and a content source. It
 * holds no transcript state between `build()` calls.
 */
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

    // Taken over the whole log, not only the run's rows, so an append anywhere in the session moves
    // `builtAtPosition`.
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

    // Unkeyed enclosed results awaiting the disclosure of their block.
    const deferredEnclosedResults: Map<number, DeferredEnclosedToolResult> = new Map();

    // Positions of `assistant.thinking_update` rows whose blocks could not be read; read only at
    // turn close.
    const unreadableReasoningPositions: Set<number> = new Set<number>();

    /**
     * Settles every enclosure in the turn against the turn's own reasoning segments, since a block
     * id is unique only within the exchange that minted it. Runs at turn close because the row
     * carrying the enclosing block may be logged after the answer it encloses.
     *
     * A keyed result keeps its segment and is stamped with the resolution; the strip removes it
     * later. A deferred unkeyed result is settled by its block's disclosure:
     *
     * - `summary`: user-visible history, rendered as ordinary text.
     * - `private`: replaced by an empty text segment carrying `withheldEnclosure` at the same
     *   position. It is not left as the `contentUnavailable` placeholder, because the body was
     *   read and then withheld on purpose, and consumers would report an unavailability that never
     *   happened. It is not removed either: a positional bound between the result and its
     *   later-logged reasoning row would then cut away the only segment that could declare the
     *   loss. The strip drops the marker and declares `provider_private_reasoning` once, and the
     *   brief renderer runs the same strip.
     * - anything else (a block this turn does not carry, or a block id carried twice under
     *   disagreeing disclosures): fail closed, the placeholder stays. This is stricter than the
     *   strip's rule for a keyed result, because a keyed result carries its enclosure member
     *   forward while rendering an unkeyed one to text discards it for good.
     *
     * `private` is tested explicitly, not as the `else` of the `summary` arm: the strip removes
     * reasoning at `private` alone, so a new disclosure value must land on the fail-closed arm
     * until the strip claims it.
     */
    const settleTurnEnclosures = (
      segments: CanonicalTranscriptSegment[],
    ): CanonicalTranscriptSegment[] => {
      // A block id carried twice under disagreeing disclosures resolves to ambiguous, and both arms
      // below fail closed on it.
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
      // Whether any row in this turn carried reasoning the fold could not read. Such a row adds no
      // block ids, so an unresolved citation in this turn cannot be told from a portable one.
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
      // Skips a turn with no segments left after settling.
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
      // A role change closes the open turn before the empty-content discard: an empty row is still
      // a role boundary, and skipping it would coalesce the assistant turns on either side of an
      // empty user row and settle one exchange's enclosures against another's blocks. The same
      // holds for an empty assistant row, as for `run.turn_started` below. Same-role empty rows
      // still coalesce.
      if (openTurn !== undefined && openTurn.role !== role) {
        closeOpenTurn();
      }
      if (segments.length === 0) {
        return;
      }
      if (openTurn === undefined) {
        openTurn = { role, position, segments: [] };
      }
      openTurn.segments.push(...segments);
    };

    for (const event of loggedEvents) {
      if (!isEventInRunScope(event, request.runId)) {
        continue;
      }
      // The walk deliberately does not stop at the request bound: enclosure resolution settles at
      // turn close, and the row carrying an enclosing block may be logged after the answer it
      // encloses. Stopping early would leave a result unstamped and ship a private body.
      // Over-bound segments are discarded when the output is bounded below; the reader is the
      // daemon's own event store, so reading past the bound discloses nothing.

      // A turn marker closes the open turn without adding content, so two assistant turns in a row
      // stay two turns.
      if (event.type === "run.turn_started") {
        closeOpenTurn();
        continue;
      }

      if (event.type === "user.message") {
        appendSegments("user", event.sequence, this.#userSegmentsFor(event));
        continue;
      }

      const reference: TranscriptContentReference = {
        sessionId: request.sessionId,
        runId: request.runId,
        sequence: event.sequence,
        eventType: event.type,
        toolCallId: readStringMember(event.payload, "toolCallId"),
      };

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
    // The bound runs over the finished fold; `builtAtPosition` is untouched because it records
    // where the fold was taken.
    return request.boundary === undefined
      ? projection
      : boundProjectionToPosition(projection, request.boundary);
  }

  /**
   * The segment an unkeyed tool invocation contributes. The segment union has no enclosure member
   * for a call, so nothing is deferred. Unreadable arguments yield an empty `contentUnavailable`
   * segment, which costs the tool name but never invents text.
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
   * The user's words, the `user.message` payload's `message`. A row read back without one becomes
   * an empty `contentUnavailable` segment, so the turn keeps its position and the loss is
   * declared; dropping it would erase typed words silently.
   */
  #userSegmentsFor(event: StoredEvent): readonly CanonicalTranscriptSegment[] {
    const text: string | undefined = readStringMember(event.payload, "message");
    if (text === undefined) {
      return [{ kind: "text", position: event.sequence, text: "", contentUnavailable: true }];
    }
    return text.length === 0 ? [] : [{ kind: "text", position: event.sequence, text }];
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
        // An unreadable body (marked) and an empty one (the row carried none) are kept apart.
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
        // Unreadable blocks are marked on a text segment: the pipeline's unavailability check skips
        // the reasoning arm, so a reasoning-kind marker would declare no loss, and there is no
        // block to read a `disclosure` from. The position is also registered, because an
        // unreadable assistant message or tool body yields the same segment shape, and the turn
        // close must know that a result citing a block from this row cannot be classified.
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
        // A row with no pairing key cannot be a structured call, since that would mean minting an
        // id. It rides a text segment; dropping it would erase activity the user saw and declare
        // nothing.
        if (toolCallId === undefined) {
          return [this.#unkeyedToolCallSegment(reference, toolName)];
        }
        // A call with no tool name is dropped: the tool shape always names `toolName`, so the row
        // is malformed, and carrying it as text would discard a pairing key that is present and
        // orphan the sibling result under that id.
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
        // As for invocations: an unkeyed result is carried as content, not dropped.
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

function readStringMember(payload: Record<string, unknown>, member: string): string | undefined {
  const value: unknown = payload[member];
  return typeof value === "string" ? value : undefined;
}
