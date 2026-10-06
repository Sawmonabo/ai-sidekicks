// The beat vocabulary scripted sessions share: `composeScriptBeats`, the instant a tick lands
// on, and the run, assistant, tool and subagent entry builders. `opening-entries.ts` holds the
// session opening and reads the entry type from here.
//
// The beat builder guarantees:
//   - The row id is minted from a stem the scenario owns plus the beat's position, never
//     composed from the session id, so a projection that stops carrying the real id shows.
//   - Sequence is the position, so inserting a beat cannot leave a gap the store reads as a
//     delivery failure.
//   - `occurredAt` is derived from `atMs`, so a row's timestamp never contradicts its tick.
//   - `atMs` is non-decreasing: the engine delivers the contiguous due prefix, so a beat that
//     goes back in time would be delivered late or never. The builder throws instead.
//
// The payload builders carry the registered shapes and nothing else. `run.queued`,
// `assistant.*` and `tool.*` have `.strict()` variants in `@ai-sidekicks/contracts`,
// so an extra member is rejected on the wire; the other run transitions and `subagent.*` have
// none.

import type { AgentListEntry } from "@ai-sidekicks/contracts/agent/methods";

import type { ScenarioBeat } from "../scenarios/script.js";

/** One scripted moment, before the builder gives it a position and an instant. */
export interface ScriptEntry {
  /** Scenario time, measured from the scenario's start. Non-decreasing. */
  readonly atMs: number;
  /** A registered `SessionEventType`, verbatim. */
  readonly kind: string;
  /**
   * Who the beat is attributed to: `EventEnvelope.actor`, which holds a user id, an agent
   * id or nothing, with no discriminator. Absent for a daemon transition.
   */
  readonly actorId?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** What a script needs beyond its entries to become beats. */
interface ScriptOptions {
  readonly sessionId: string;
  /**
   * The scenario's stem for row ids: a UUID's first four groups plus the head of its last,
   * which the builder completes with the beat's position. Declared by the scenario, not
   * derived from the session id, so a lost real id cannot be silently rebuilt.
   */
  readonly eventIdStem: string;
  /** The instant tick zero stands for, in epoch milliseconds. */
  readonly startedAtMs: number;
  readonly entries: readonly ScriptEntry[];
}

/** What one run-lifecycle transition says. */
interface RunTransitionInput {
  readonly atMs: number;
  readonly sessionId: string;
  readonly runId: string;
  /** The daemon's progression counter for this run; increments per transition. */
  readonly runVersion: number;
  /** Absent only on the birth transition, which has no prior state. */
  readonly previousState?: string;
  readonly newState: string;
  /** The agent the run belongs to. Carried on the birth transition. */
  readonly agentId?: string;
  readonly actorId?: string;
  /**
   * The run that created this one. It rides the birth beat (`run.queued`) only; the builder
   * throws on any other transition rather than emit a beat the daemon does not send.
   */
  readonly parentRunId?: string;
  /** The agent this run's creation starts from its saved definition, as the agent list names it. */
  readonly resolvedAgent?: AgentListEntry;
}

/** The ISO instant `atMs` after the scenario's start. */
export function composeScenarioInstant(startedAtMs: number, atMs: number): string {
  return new Date(startedAtMs + atMs).toISOString();
}

/**
 * Turn one ordered script into beats, positioned and stamped.
 *
 * Throws on a script that goes backwards in time rather than sorting it, because the
 * scripted ordering (lanes interleaving at particular ticks) is part of what a scenario
 * tests.
 */
export function composeScriptBeats(options: ScriptOptions): readonly ScenarioBeat[] {
  let previousAtMs = 0;
  return options.entries.map((entry, entryIndex) => {
    if (entry.atMs < previousAtMs) {
      throw new RangeError(
        `script entry ${String(entryIndex)} ("${entry.kind}") is due at ${String(entry.atMs)}ms, ` +
          `behind its predecessor at ${String(previousAtMs)}ms. ` +
          `The scenario engine delivers beats in ` +
          "script order, so an entry that goes backwards is delivered late or not at all.",
      );
    }
    previousAtMs = entry.atMs;
    const eventId = `${options.eventIdStem}${String(entryIndex + 1).padStart(4, "0")}`;
    return {
      atMs: entry.atMs,
      event: {
        id: eventId,
        sessionId: options.sessionId,
        sequence: entryIndex + 1,
        // The position the scenario's stream delivers the beat at; its frames relay it verbatim.
        cursor: eventId,
        kind: entry.kind,
        occurredAt: composeScenarioInstant(options.startedAtMs, entry.atMs),
        ...(entry.actorId === undefined ? {} : { actorId: entry.actorId }),
        payload: entry.payload ?? {},
      },
    };
  });
}

/**
 * The cursor the beat at one log position is delivered with, for a reply that hands a position
 * out. Throws when the script has no beat there, since the stream refuses a cursor its log lacks.
 */
export function findBeatCursor(beats: readonly ScenarioBeat[], sequence: number): string {
  const beat = beats.find((candidate) => candidate.event.sequence === sequence);
  if (beat === undefined) {
    throw new RangeError(
      `no beat sits at log position ${String(sequence)} (the script has ` +
        `${String(beats.length)}), so a cursor for it would name no row the stream delivers.`,
    );
  }
  return beat.event.cursor;
}

/**
 * When the newest beat happened, for a reply that says when the session last changed. Throws on a
 * script with no beat, which has no such instant.
 */
export function newestBeatInstant(beats: readonly ScenarioBeat[]): string {
  const newest = beats.at(-1);
  if (newest === undefined) {
    throw new RangeError("the script has no beat, so nothing in it last changed the session.");
  }
  return newest.event.occurredAt;
}

/** The one transition a run's linkage and resolved agent ride. */
const RUN_BIRTH_STATE = "queued";

/** What one assistant-output beat says. */
interface AssistantOutputInput {
  readonly atMs: number;
  readonly sessionId: string;
  readonly runId: string;
  /** `assistant.message` or `assistant.thinking_update`. */
  readonly kind: string;
  /** Media type of the body, which the producer sets and the codec does not. */
  readonly contentType: string;
  /** Pre-truncation UTF-8 byte length of the stored body. */
  readonly contentLength: number;
}

/** What one tool-activity beat says. */
interface ToolActivityInput {
  readonly atMs: number;
  readonly sessionId: string;
  readonly runId: string;
  /** `tool.invoked`, `tool.result`, or `tool.error`. */
  readonly kind: string;
  /** Required by the registered shape. */
  readonly toolName: string;
  /** Pairs an invocation with its settlement, which is what a tool card renders. */
  readonly toolCallId: string;
  readonly durationMs?: number;
  readonly contentLength?: number;
}

/** What one provider-native subagent beat says. */
interface SubagentActivityInput {
  readonly atMs: number;
  readonly sessionId: string;
  readonly runId: string;
  /** `subagent.started` or `subagent.completed`. */
  readonly kind: string;
  /** The provider that minted the child; with `subagentId` it is the key a completion pairs on. */
  readonly provider: string;
  /** The provider-native child id. Unique only inside that provider's run scope. */
  readonly subagentId: string;
  /** The tool call the child was opened under, where the provider names one. */
  readonly parentToolCallId?: string;
}

/** The four entry builders one session's script uses, with its session bound in. */
interface RunEntryBuilders {
  readonly transition: (
    runId: string,
    input: Omit<RunTransitionInput, "sessionId" | "runId">,
  ) => ScriptEntry;
  readonly output: (
    runId: string,
    input: Omit<AssistantOutputInput, "sessionId" | "runId">,
  ) => ScriptEntry;
  readonly tool: (
    runId: string,
    input: Omit<ToolActivityInput, "sessionId" | "runId">,
  ) => ScriptEntry;
  readonly subagent: (
    runId: string,
    input: Omit<SubagentActivityInput, "sessionId" | "runId">,
  ) => ScriptEntry;
}

/**
 * One run-state transition, as `run.<state>`.
 *
 * The kind is composed from `newState` so the two cannot disagree; nothing downstream would
 * catch a `run.paused` beat carrying `newState: "running"`. Throws when the run linkage or
 * resolved agent is set on any transition but the birth one.
 */
export function runTransitionEntry(input: RunTransitionInput): ScriptEntry {
  const creation = creationRowMembers(input);
  if (Object.keys(creation).length > 0 && input.newState !== RUN_BIRTH_STATE) {
    throw new RangeError(
      `a run's linkage and resolved agent ride its ` +
        `birth beat, and this entry moves ${input.runId} ` +
        `into "${input.newState}". The taxonomy puts them on \`run.${RUN_BIRTH_STATE}\` ` +
        "alone, so a second beat carrying them would be a second record of one fact.",
    );
  }
  return {
    atMs: input.atMs,
    kind: `run.${input.newState}`,
    ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    payload: {
      sessionId: input.sessionId,
      runId: input.runId,
      runVersion: input.runVersion,
      ...(input.previousState === undefined ? {} : { previousState: input.previousState }),
      newState: input.newState,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...creation,
    },
  };
}

/**
 * One assistant turn, carrying its body's media type and length and never the body.
 *
 * The body lives in `session_events.content_payload`, and the strict
 * schema rejects prose on the payload.
 */
export function assistantOutputEntry(input: AssistantOutputInput): ScriptEntry {
  return {
    atMs: input.atMs,
    kind: input.kind,
    payload: {
      sessionId: input.sessionId,
      runId: input.runId,
      contentType: input.contentType,
      contentLength: input.contentLength,
    },
  };
}

/** One tool call, invocation or settlement, in the registered shape. */
export function toolActivityEntry(input: ToolActivityInput): ScriptEntry {
  return {
    atMs: input.atMs,
    kind: input.kind,
    payload: {
      sessionId: input.sessionId,
      runId: input.runId,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
      ...(input.contentLength === undefined ? {} : { contentLength: input.contentLength }),
    },
  };
}

/**
 * One provider-native subagent beat, started or completed.
 *
 * It has its own builder because the row is filed under tool activity but carries no
 * `toolName`. Both kinds share one shape so they carry the same `(runId, provider,
 * subagentId)` triple a completion pairs to its start on.
 */
function subagentActivityEntry(input: SubagentActivityInput): ScriptEntry {
  return {
    atMs: input.atMs,
    kind: input.kind,
    payload: {
      sessionId: input.sessionId,
      runId: input.runId,
      provider: input.provider,
      subagentId: input.subagentId,
      ...(input.parentToolCallId === undefined ? {} : { parentToolCallId: input.parentToolCallId }),
    },
  };
}

/** Bind one session id into the four entry builders, so call sites do not repeat it. */
export function createRunEntryBuilders(sessionId: string): RunEntryBuilders {
  return {
    transition: (runId, input) => runTransitionEntry({ ...input, sessionId, runId }),
    output: (runId, input) => assistantOutputEntry({ ...input, sessionId, runId }),
    tool: (runId, input) => toolActivityEntry({ ...input, sessionId, runId }),
    subagent: (runId, input) => subagentActivityEntry({ ...input, sessionId, runId }),
  };
}

/** The creation-row members this entry states, with no key for the rest. */
function creationRowMembers(input: RunTransitionInput): Readonly<Record<string, unknown>> {
  return {
    ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
    ...(input.resolvedAgent === undefined ? {} : { resolvedAgent: input.resolvedAgent }),
  };
}
