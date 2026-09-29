// The scripted sessions' shared beat vocabulary.
//
// Every scenario that scripts runs into a session (transcript-states, concurrent-streaming
// and the endurance generator) needs the same four things: a sequence that never skips,
// an `occurredAt` that agrees with the beat's own `atMs`, the registered run-lifecycle
// payload, and the registered machine-activity payloads (assistant, tool, and the
// provider-native subagent rows filed beside them). They live here once, so each
// scenario is only its own data.
//
// Who is in the room before any run starts is `opening-entries.ts`, which reads the
// entry type from here and is read back by nothing here: a session's opening is not a
// run's, so the run entry builders never compose one.
//
// WHAT THE BUILDER GUARANTEES, AND WHY EACH GUARANTEE IS WORTH A FUNCTION CALL
//
//   • **The row id is positional too, and minted from the scenario's own stem.**
//     `ProjectedSessionEvent.id` is the daemon's opaque row id, and the hydrated-event
//     read is keyed by it — so a beat without one is a row nothing can ask about. It
//     is minted from a stem the scenario owns rather than from its session id,
//     because a caller that composed the id back out of `{sessionId, sequence}` would
//     never notice the projection had stopped carrying the real one.
//   • **Sequence is positional.** `ScenarioEngine` and `SessionStore` both key on
//     `sequence` — the store's gap detection refuses a stream whose positions skip
//     — so a hand-numbered script that inserted a beat in the middle would either
//     renumber every line below it or ship a gap that reads as a delivery failure.
//     Here the position IS the index, so an inserted beat cannot produce either.
//   • **`occurredAt` is derived from `atMs`.** They are the same instant expressed
//     twice: one in scenario time, one on the frozen clock the fixture reports. A
//     script that let them disagree would put a row on screen whose timestamp
//     contradicted the tick it arrived at, and every reading taken from that frame
//     — a run group's duration, a seam's position in the log — would be measuring two
//     different sessions.
//   • **Entries are held to non-decreasing `atMs`.** The engine delivers beats by
//     slicing from the delivered count and filtering by due time, so a beat whose
//     `atMs` is earlier than a predecessor's is delivered late or not at all. That
//     is a defect in the script rather than in the engine, and it is invisible in
//     a rendered frame, so it throws here.
//
// The payload builders below carry the registered shapes and nothing else.
// `run.*` and `subagent.*` have no strict variant in `packages/contracts/src/event.ts`
// and are held to the census and to the per-type payload rows of the taxonomy;
// `assistant.*` and `tool.*` do have one, and it is `.strict()`, so a member those
// builders do not name is a member the wire rejects.

import type { ScenarioBeat } from "../scenario.js";

/** One scripted moment, before the builder gives it a position and an instant. */
export interface ScriptEntry {
  /** Scenario time, measured from the scenario's start. Non-decreasing. */
  readonly atMs: number;
  /** A registered `SessionEventType`, verbatim. */
  readonly kind: string;
  /**
   * Who the beat is attributed to, where the wire names anyone.
   *
   * `EventEnvelope.actor`, under the console's own name for it: the wire's member
   * holds a user id, an AGENT id, or nothing, and carries no discriminator, so
   * the scenario states whichever id acted and claims nothing about which kind it is.
   * Absent for a daemon transition, which is the system arm.
   */
  readonly actorId?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** What a script needs beyond its entries to become beats. */
interface ScriptOptions {
  readonly sessionId: string;
  /**
   * The scenario's own stem for the row ids it mints — a UUID's first four groups
   * plus the head of its last, which the builder completes with the beat's position.
   *
   * A stem the scenario declares rather than one derived from its session id: the
   * two identify different things, and a row id composed out of the session would be
   * reconstructible by any caller that had lost it, which is how a projection that
   * stopped carrying the real id goes unnoticed.
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
  /** The daemon's progression counter for this run. Increments per transition. */
  readonly runVersion: number;
  /** Absent only on the birth transition, where no document names a prior state. */
  readonly previousState?: string;
  readonly newState: string;
  /** The agent the run belongs to. Carried on the birth transition. */
  readonly agentId?: string;
  readonly actorId?: string;
  /**
   * The run that created this one, and the fact that rides beside it.
   *
   * The two orchestration-linkage members, on the BIRTH beat and nowhere else. The
   * taxonomy's run-lifecycle rows put them on `run.queued`, so the parent is named
   * where the child is created — a second beat announcing the link would be a second
   * record of one fact and the projection reading it would have to choose which. The
   * builder refuses them on any other transition rather than emitting a beat the
   * daemon does not send.
   */
  readonly parentRunId?: string;
  /** Whether the child is the parent's own helper rather than a user's run. */
  readonly internalHelper?: boolean;
}

/**
 * Turn one ordered script into beats, positioned and stamped.
 *
 * Throws on a script that goes backwards in time rather than sorting it: sorting
 * would silently accept a rewritten ordering, and the ordering is the design of the
 * scenario — two lanes interleaving at particular ticks is what the transcript is being
 * measured against.
 */
export function composeScriptBeats(options: ScriptOptions): readonly ScenarioBeat[] {
  let previousAtMs = 0;
  return options.entries.map((entry, entryIndex) => {
    if (entry.atMs < previousAtMs) {
      throw new RangeError(
        `script entry ${String(entryIndex)} ("${entry.kind}") is due at ${String(entry.atMs)}ms, ` +
          `behind its predecessor at ${String(previousAtMs)}ms. The scenario engine delivers beats in ` +
          "script order, so an entry that goes backwards is delivered late or not at all.",
      );
    }
    previousAtMs = entry.atMs;
    return {
      atMs: entry.atMs,
      event: {
        id: `${options.eventIdStem}${String(entryIndex + 1).padStart(4, "0")}`,
        sessionId: options.sessionId,
        sequence: entryIndex + 1,
        kind: entry.kind,
        occurredAt: new Date(options.startedAtMs + entry.atMs).toISOString(),
        ...(entry.actorId === undefined ? {} : { actorId: entry.actorId }),
        payload: entry.payload ?? {},
      },
    };
  });
}

/** The one transition the orchestration linkage rides. */
const RUN_BIRTH_STATE = "queued";

/** What one assistant-output beat says. */
interface AssistantOutputInput {
  readonly atMs: number;
  readonly sessionId: string;
  readonly runId: string;
  /** `assistant.message` or `assistant.thinking_update`. */
  readonly kind: string;
  /** Media type of the body, which the PRODUCER sets and the codec does not. */
  readonly contentType: string;
  /** Pre-truncation UTF-8 byte length of the body that was sealed. */
  readonly contentLength: number;
}

/** What one tool-activity beat says. */
interface ToolActivityInput {
  readonly atMs: number;
  readonly sessionId: string;
  readonly runId: string;
  /** `tool.invoked`, `tool.result`, or `tool.error`. */
  readonly kind: string;
  /** REQUIRED by the registered shape: a tool row with no name is unattributable. */
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
  /** The provider that minted the child. Half of the key a completion pairs on. */
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
 * The kind is composed from `newState` rather than passed beside it, because the
 * two are one fact: a `run.paused` beat carrying `newState: "running"` names a
 * transition no daemon performs, and nothing downstream would catch it — the census
 * leg sees a registered kind and the strict layer registers no `run.*` variant.
 */
export function runTransitionEntry(input: RunTransitionInput): ScriptEntry {
  const linkage = orchestrationLinkageMembers(input);
  if (Object.keys(linkage).length > 0 && input.newState !== RUN_BIRTH_STATE) {
    throw new RangeError(
      `a run's orchestration linkage rides its birth beat, and this entry moves ${input.runId} ` +
        `into "${input.newState}". The taxonomy puts the linkage on \`run.${RUN_BIRTH_STATE}\` ` +
        "alone, so a second beat carrying it would be a second record of one fact.",
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
      ...linkage,
    },
  };
}

/**
 * One assistant turn, carrying its body's DESCRIPTION and never its body.
 *
 * The body lives in `session_events.content_payload`, sealed per session, and no
 * bridge namespace serves the hydrated projection that opens it — so a fixture that
 * put prose on the payload would be teaching every card to read a member the strict
 * layer rejects outright. What a scenario can honestly state is what the descriptor
 * carries: the media type and the length, which is exactly what a machine body's
 * named absence renders.
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
 * One provider-native subagent beat, started or completed, in the registered shape.
 *
 * A NON-TOOL ROW UNDER A TOOL CATEGORY, which is the whole reason it has a builder of
 * its own rather than riding the tool one: the taxonomy files both kinds under tool
 * activity and then states in terms that these two are per-type and carry no
 * `toolName`. A scenario that reached for the tool builder would ship a member the
 * daemon does not send on this row.
 *
 * THE TWO KINDS TAKE THE SAME SHAPE, deliberately, because a completion pairs to its
 * start on `(runId, provider, subagentId)` — the id alone never pairs across runs or
 * providers. One builder is what makes the two beats carry the same triple; two
 * literals are how a fixture ships a completion that pairs with nothing.
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

/**
 * Bind one session id into the four entry builders.
 *
 * Every entry of one scenario carries that scenario's session, so repeating it at
 * every call site is both noise and the one place a copied line could name another
 * scenario's session without anything downstream noticing.
 */
export function createRunEntryBuilders(sessionId: string): RunEntryBuilders {
  return {
    transition: (runId, input) => runTransitionEntry({ ...input, sessionId, runId }),
    output: (runId, input) => assistantOutputEntry({ ...input, sessionId, runId }),
    tool: (runId, input) => toolActivityEntry({ ...input, sessionId, runId }),
    subagent: (runId, input) => subagentActivityEntry({ ...input, sessionId, runId }),
  };
}

/** Whichever of the two linkage members this entry stated, and no key for the rest. */
function orchestrationLinkageMembers(input: RunTransitionInput): Readonly<Record<string, unknown>> {
  return {
    ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
    ...(input.internalHelper === undefined ? {} : { internalHelper: input.internalHelper }),
  };
}
