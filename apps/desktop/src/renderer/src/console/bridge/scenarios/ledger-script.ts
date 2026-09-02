// The ledger scenarios' shared beat vocabulary.
//
// Three files script ledger sessions — the family scenario, the first-sixty-seconds
// session, and the endurance generator — and all three need the same four things:
// a sequence that never skips, an `occurredAt` that agrees with the beat's own
// `atMs`, the registered run-lifecycle payload, and the registered assistant / tool
// payloads. `apps/desktop/AGENTS.md` hoists a helper on its second use, so the
// vocabulary lives here once rather than three times; the three scenarios are then
// only their own data, which is what a reader wants to read.
//
// WHAT THE BUILDER GUARANTEES, AND WHY EACH GUARANTEE IS WORTH A FUNCTION CALL
//
//   • **Sequence is positional.** `ScenarioEngine` and `SessionStore` both key on
//     `sequence` — the store's gap detection refuses a stream whose positions skip
//     — so a hand-numbered script that inserted a beat in the middle would either
//     renumber every line below it or ship a gap that reads as a delivery failure.
//     Here the position IS the index, so an inserted beat cannot produce either.
//   • **`occurredAt` is derived from `atMs`.** They are the same instant expressed
//     twice: one in scenario time, one on the frozen clock the fixture reports. A
//     script that let them disagree would put a row on screen whose timestamp
//     contradicted the tick it arrived at, and every reading taken from that frame
//     — the rail's density, a chapter's duration, the replay scrub — would be
//     measuring two different sessions.
//   • **Entries are held to non-decreasing `atMs`.** The engine delivers beats by
//     slicing from the delivered count and filtering by due time, so a beat whose
//     `atMs` is earlier than a predecessor's is delivered late or not at all. That
//     is a defect in the script rather than in the engine, and it is invisible in
//     a rendered frame, so it throws here.
//
// The payload builders below carry the registered shapes and nothing else.
// `run.*` has no strict variant in `packages/contracts/src/event.ts` and is held to
// the census alone; `assistant.*` and `tool.*` do have one, and it is `.strict()`,
// so a member these builders do not name is a member the wire rejects.

import type { ScenarioBeat } from "../scenario.js";

/** One scripted moment, before the builder gives it a position and an instant. */
export interface LedgerScriptEntry {
  /** Scenario time, measured from the scenario's start. Non-decreasing. */
  readonly atMs: number;
  /** A registered `SessionEventType`, verbatim. */
  readonly kind: string;
  /** Who acted, where the wire names a participant. Absent for daemon transitions. */
  readonly actorParticipantId?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** What a script needs beyond its entries to become beats. */
export interface LedgerScriptOptions {
  readonly sessionId: string;
  readonly startedAtIso: string;
  readonly entries: readonly LedgerScriptEntry[];
}

/**
 * Turn one ordered script into beats, positioned and stamped.
 *
 * Throws on a script that goes backwards in time rather than sorting it: sorting
 * would silently accept a rewritten ordering, and the ordering is the design of the
 * scenario — two lanes interleaving at particular ticks is what the ledger is being
 * measured against.
 */
export function scriptLedgerBeats(options: LedgerScriptOptions): readonly ScenarioBeat[] {
  const startedAtMs = Date.parse(options.startedAtIso);
  if (Number.isNaN(startedAtMs)) {
    throw new RangeError(
      `a ledger script needs a parseable start instant; received "${options.startedAtIso}"`,
    );
  }
  let previousAtMs = 0;
  return options.entries.map((entry, entryIndex) => {
    if (entry.atMs < previousAtMs) {
      throw new RangeError(
        `ledger script entry ${String(entryIndex)} ("${entry.kind}") is due at ${String(entry.atMs)}ms, ` +
          `behind its predecessor at ${String(previousAtMs)}ms. The scenario engine delivers beats in ` +
          "script order, so an entry that goes backwards is delivered late or not at all.",
      );
    }
    previousAtMs = entry.atMs;
    return {
      atMs: entry.atMs,
      event: {
        sessionId: options.sessionId,
        sequence: entryIndex + 1,
        kind: entry.kind,
        occurredAt: new Date(startedAtMs + entry.atMs).toISOString(),
        ...(entry.actorParticipantId === undefined
          ? {}
          : { actorParticipantId: entry.actorParticipantId }),
        payload: entry.payload ?? {},
      },
    };
  });
}

/** What one run-lifecycle transition says. */
export interface RunTransitionInput {
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
  readonly actorParticipantId?: string;
}

/**
 * One run-state transition, as `run.<state>`.
 *
 * The kind is composed from `newState` rather than passed beside it, because the
 * two are one fact: a `run.paused` beat carrying `newState: "running"` names a
 * transition no daemon performs, and nothing downstream would catch it — the census
 * leg sees a registered kind and the strict layer registers no `run.*` variant.
 */
export function runTransitionEntry(input: RunTransitionInput): LedgerScriptEntry {
  return {
    atMs: input.atMs,
    kind: `run.${input.newState}`,
    ...(input.actorParticipantId === undefined
      ? {}
      : { actorParticipantId: input.actorParticipantId }),
    payload: {
      sessionId: input.sessionId,
      runId: input.runId,
      runVersion: input.runVersion,
      ...(input.previousState === undefined ? {} : { previousState: input.previousState }),
      newState: input.newState,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    },
  };
}

/** What one assistant-output beat says. */
export interface AssistantOutputInput {
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
export function assistantOutputEntry(input: AssistantOutputInput): LedgerScriptEntry {
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

/** What one tool-activity beat says. */
export interface ToolActivityInput {
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

/** One tool call, invocation or settlement, in the registered shape. */
export function toolActivityEntry(input: ToolActivityInput): LedgerScriptEntry {
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
 * One agent as three ledger scenarios all carry it.
 *
 * The `agent.attached` payload and the `agent.list` row are two views of one
 * record, so a scenario states each agent once and both views are built from it.
 */
export interface LedgerCastMember {
  readonly agentId: string;
  readonly name: string;
  readonly driverName: string;
  readonly modelId: string;
}

/** Who is in the room before any run starts. */
export interface LedgerOpeningInput {
  readonly sessionId: string;
  /** The participant who opened the session, and whose window this is. */
  readonly openedBy: string;
  /** The second person, who joins by membership. */
  readonly joinedBy: string;
  readonly membershipId: string;
  /** The cast, each attached at the tick beside it. */
  readonly cast: readonly (LedgerCastMember & { readonly attachedAtMs: number })[];
  /** When the second person joins, in scenario time. */
  readonly joinedAtMs: number;
}

/**
 * The opening of a ledger session: the room, then the cast.
 *
 * Every ledger scenario opens the same way, and the three payload shapes here are
 * the ones a mistake is quietest in — `session.created` carries no title, a person
 * joining is a `membership.created` rather than a `participant.*` the census does
 * not have, and `agent.attached` carries `name` where a reader expects
 * `displayName`. Written once, all three scenarios are right or all three are
 * wrong, and the wire-truth predicate says which.
 */
export function ledgerOpeningEntries(input: LedgerOpeningInput): readonly LedgerScriptEntry[] {
  return [
    {
      atMs: 0,
      kind: "session.created",
      actorParticipantId: input.openedBy,
      // The registered shape verbatim: the new session's id plus the resolved
      // config and metadata. Both are open records and both are empty, because
      // nothing in the corpus names a key inside either.
      payload: { sessionId: input.sessionId, config: {}, metadata: {} },
    },
    {
      atMs: input.joinedAtMs,
      kind: "membership.created",
      actorParticipantId: input.joinedBy,
      payload: {
        membershipId: input.membershipId,
        participantId: input.joinedBy,
        role: "collaborator",
        identityHandle: "priya",
      },
    },
    ...input.cast.map((agent) => ({
      atMs: agent.attachedAtMs,
      kind: "agent.attached",
      // The person who attached the agent, not the agent: an agent does not attach
      // itself, and the envelope actor is who acted.
      actorParticipantId: input.openedBy,
      payload: {
        sessionId: input.sessionId,
        agentId: agent.agentId,
        name: agent.name,
        driverName: agent.driverName,
        modelId: agent.modelId,
        state: "ready",
        actor: input.openedBy,
      },
    })),
  ];
}

/** The three entry builders one session's script uses, with its session bound in. */
export interface LedgerLaneEntryBuilders {
  readonly transition: (
    runId: string,
    input: Omit<RunTransitionInput, "sessionId" | "runId">,
  ) => LedgerScriptEntry;
  readonly output: (
    runId: string,
    input: Omit<AssistantOutputInput, "sessionId" | "runId">,
  ) => LedgerScriptEntry;
  readonly tool: (
    runId: string,
    input: Omit<ToolActivityInput, "sessionId" | "runId">,
  ) => LedgerScriptEntry;
}

/**
 * Bind one session id into the three entry builders.
 *
 * Every entry of one scenario carries that scenario's session, so repeating it at
 * every call site is both noise and the one place a copied line could name another
 * scenario's session without anything downstream noticing.
 */
export function createLedgerLaneEntries(sessionId: string): LedgerLaneEntryBuilders {
  return {
    transition: (runId, input) => runTransitionEntry({ ...input, sessionId, runId }),
    output: (runId, input) => assistantOutputEntry({ ...input, sessionId, runId }),
    tool: (runId, input) => toolActivityEntry({ ...input, sessionId, runId }),
  };
}
