// The session log and content port a canonical transcript fold reads, held in memory.

import type { RunId, SessionId } from "@ai-sidekicks/contracts";

import type { StoredEvent } from "../../../session/types.js";
import {
  CanonicalTranscriptFold,
  type TranscriptContentReference,
  type TranscriptContentSource,
  type TranscriptEventReader,
  type TranscriptReasoningBlock,
  type TranscriptToolResultBody,
} from "../canonical-transcript.js";

/** The session every fixture row is logged under. */
export const SESSION_ID: SessionId = "session-transcript" as SessionId;
/** The run a fixture folds. */
export const RUN_ID: RunId = "run-transcript" as RunId;
/** A second run in the same session, whose rows the fold must leave out. */
export const OTHER_RUN_ID: RunId = "run-unrelated" as RunId;

/** One logged row; the fold reads only its sequence, type and payload. */
export function storedEvent(
  sequence: number,
  type: string,
  payload: Record<string, unknown>,
): StoredEvent {
  return {
    id: `evt-${sequence.toString()}`,
    sessionId: SESSION_ID,
    sequence,
    occurredAt: "2026-08-26T00:00:00.000Z",
    monotonicNs: BigInt(sequence),
    category: "provider",
    type,
    actor: null,
    payload,
    correlationId: null,
    causationId: null,
    version: "1.0",
  };
}

/** A mutable in-memory log; appending moves the fold's position without a rebuilt fixture. */
class RecordedEventLog implements TranscriptEventReader {
  readonly #events: StoredEvent[] = [];

  append(event: StoredEvent): void {
    this.#events.push(event);
  }

  readEvents(): ReadonlyArray<StoredEvent> {
    return [...this.#events];
  }
}

/**
 * The content the durable payloads do not carry, keyed by the logged row's sequence. The content
 * port has no shipped implementation, so the tests supply this one.
 */
class RecordedContentSource implements TranscriptContentSource {
  readonly assistantTextBySequence: Map<number, string> = new Map<number, string>();
  readonly userTextBySequence: Map<number, string> = new Map<number, string>();
  readonly reasoningBlocksBySequence: Map<number, readonly TranscriptReasoningBlock[]> = new Map<
    number,
    readonly TranscriptReasoningBlock[]
  >();
  readonly toolArgumentsBySequence: Map<number, string> = new Map<number, string>();
  readonly toolResultBodyBySequence: Map<number, TranscriptToolResultBody> = new Map<
    number,
    TranscriptToolResultBody
  >();

  readAssistantText(reference: TranscriptContentReference): string | undefined {
    return this.assistantTextBySequence.get(reference.sequence);
  }

  readUserText(reference: TranscriptContentReference): string | undefined {
    return this.userTextBySequence.get(reference.sequence);
  }

  /** Answers absent for an unseeded row, meaning unreadable; an empty list would hide that arm. */
  readReasoningBlocks(
    reference: TranscriptContentReference,
  ): readonly TranscriptReasoningBlock[] | undefined {
    return this.reasoningBlocksBySequence.get(reference.sequence);
  }

  readToolCallArguments(reference: TranscriptContentReference): string | undefined {
    return this.toolArgumentsBySequence.get(reference.sequence);
  }

  readToolResultBody(reference: TranscriptContentReference): TranscriptToolResultBody | undefined {
    return this.toolResultBodyBySequence.get(reference.sequence);
  }
}

/** A log, its content and the fold that reads both. */
export interface TranscriptFixture {
  readonly log: RecordedEventLog;
  readonly contentSource: RecordedContentSource;
  readonly fold: CanonicalTranscriptFold;
}

/** An empty log and content source, with a fold over them. */
export function makeFixture(): TranscriptFixture {
  const log = new RecordedEventLog();
  const contentSource = new RecordedContentSource();
  const fold = new CanonicalTranscriptFold({ eventReader: log, contentSource });
  return { log, contentSource, fold };
}
