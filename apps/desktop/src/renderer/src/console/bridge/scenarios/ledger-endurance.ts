// The endurance scenario — a session as long as the ledger claims to survive.
//
// Not a picker scenario, and deliberately not on `scenarios/index.ts`: nobody wants
// to open a ten-thousand-row session from a menu, and a manifest entry that heavy
// would be paid for by every suite that iterates the shipped set. It is a
// GENERATOR the endurance and bench tiers call with the row count they are
// measuring, which is also why the count is a required argument rather than a
// constant here — a fixture that hard-coded ten thousand would have every caller
// measuring one number and reporting another.
//
// WHY IT IS GENERATED RATHER THAN WRITTEN
//
// Ten thousand hand-written beats would be an unreadable file, and worse, an
// unfaithful one: what the ledger has to survive is a session with MANY CHAPTERS —
// runs opening, streaming, and folding to receipts — not one run with ten thousand
// rows under it, and hand-writing that shape at scale guarantees the pattern drifts
// somewhere in the middle where nobody reads.
//
// DETERMINISM IS THE WHOLE CONTRACT. Every identifier, instant, and kind below is a
// function of the row index and nothing else: no `Math.random`, no `Date.now`, no
// iteration order over a hash. Two calls with the same arguments produce byte-equal
// scenarios, which is what makes a heap reading or a frame timing taken over this
// session comparable across runs and across machines.
//
// The beats are the same registered vocabulary the picker scenarios play — the
// census is `SESSION_EVENT_CATEGORY_BY_TYPE` and the strict layer is
// `SessionEventSchema`, both in `packages/contracts/src/event.ts` — so an endurance
// reading is taken over rows the daemon could really send. A generator that emitted
// a cheaper synthetic row would be measuring a rendering path the product does not
// have.

import {
  assistantOutputEntry,
  ledgerOpeningEntries,
  runTransitionEntry,
  scriptLedgerBeats,
  toolActivityEntry,
  type LedgerScriptEntry,
} from "./ledger-script.js";
import type { ConsoleScenario } from "../scenario.js";

export const LEDGER_ENDURANCE_SCENARIO_ID = "ledger-endurance";

/** The UUID v7 time prefix every generated identifier shares. */
const ENDURANCE_ID_PREFIX = "019b7892-1c00";

const SESSION_ID = `${ENDURANCE_ID_PREFIX}-75e5-8510-ada11a5a47a5`;

/**
 * The stem this scenario's row ids are minted from — its own namespace, not its
 * session's. `scriptLedgerBeats` completes it with the beat's position.
 */
const EVENT_ID_STEM = `${ENDURANCE_ID_PREFIX}-7ea1-8110-e5e0d115`;
const PARTICIPANT_YOU = `${ENDURANCE_ID_PREFIX}-79a4-8110-cca0117a0490`;
const PARTICIPANT_PRIYA = `${ENDURANCE_ID_PREFIX}-79a4-8120-cca0117a04a0`;
const MEMBERSHIP_PRIYA = `${ENDURANCE_ID_PREFIX}-7e3b-8110-cca0117a04b0`;
/**
 * The base instant, minted from its fields rather than read back out of a string.
 *
 * `Date.parse` is not a validator — it reads a timezone-less stamp in the host's
 * zone and normalizes a day that does not exist — so a fixture that derived its
 * milliseconds by parsing its own literal was asking a reader to trust the one
 * function the console bans. `Date.UTC` states the instant, and the ISO spelling
 * every reply carries is derived from it, so the two can never disagree. The name
 * ends `Ms` because that is what it holds — a number, not a stamp behind a name.
 */
const startedAtMs = Date.UTC(2026, 0, 1, 8, 0);

const STARTED_AT_ISO = new Date(startedAtMs).toISOString();

/** Scenario time between two consecutive beats. Even spacing, so a scrub is linear. */
const ENDURANCE_BEAT_INTERVAL_MS = 20;

/** The cast. Three lanes' worth of agents, cycled across every generated run. */
const ENDURANCE_AGENTS = [
  {
    agentId: `${ENDURANCE_ID_PREFIX}-7a6e-8110-d1a4c1150201`,
    name: "Architect",
    driverName: "claude",
    modelId: "claude-opus-5[1m]",
  },
  {
    agentId: `${ENDURANCE_ID_PREFIX}-7a6e-8120-d1a4c1150202`,
    name: "Implementer",
    driverName: "claude",
    modelId: "claude-sonnet-5",
  },
  {
    agentId: `${ENDURANCE_ID_PREFIX}-7a6e-8130-d1a4c1150203`,
    name: "Reviewer",
    driverName: "codex",
    modelId: "gpt-5.6-sol",
  },
] as const;

/** The opening beats every generated session shares: the room, then the cast. */
const OPENING_BEAT_COUNT = 2 + ENDURANCE_AGENTS.length;

/** Beats one run spends on its own lifecycle: queued, starting, running, completed. */
const RUN_LIFECYCLE_BEAT_COUNT = 4;

/**
 * The body a run streams between `running` and `completed`, as a repeating cycle.
 *
 * Eight entries rather than four, so the generated log is not two alternating rows
 * repeated forever: a chapter carries thinking, prose, three tool calls of which
 * one fails, and one compaction seam. That mix is what the rail folds, what the
 * find field searches, and what the row-height ledger has to measure — a uniform
 * body would have every one of them measuring its easiest case.
 */
const ENDURANCE_BODY_CYCLE_LENGTH = 8;

/** What the generator needs to know. */
export interface LedgerEnduranceScenarioOptions {
  /** Exactly how many beats the generated scenario plays. */
  readonly rowCount: number;
  /** How many run chapters those beats are spread across. Defaults to 24. */
  readonly runCount?: number;
}

/** The default chapter count: enough that no fold, cap, or index sees one run. */
const DEFAULT_ENDURANCE_RUN_COUNT = 24;

/** A generated run's identifier, a function of its index and nothing else. */
function enduranceRunId(runIndex: number): string {
  return `${ENDURANCE_ID_PREFIX}-740e-8110-${runIndex.toString(16).padStart(12, "0")}`;
}

/** One body beat, chosen from the cycle by its position within the run. */
function enduranceBodyEntry(atMs: number, runId: string, bodyIndex: number): LedgerScriptEntry {
  const callId = `call-endurance-${String(bodyIndex)}`;
  switch (bodyIndex % ENDURANCE_BODY_CYCLE_LENGTH) {
    case 0:
      return assistantOutputEntry({
        atMs,
        sessionId: SESSION_ID,
        runId,
        kind: "assistant.thinking_update",
        contentType: "text/plain",
        contentLength: 256 + (bodyIndex % 64),
      });
    case 1:
    case 4:
      return assistantOutputEntry({
        atMs,
        sessionId: SESSION_ID,
        runId,
        kind: "assistant.message",
        contentType: "text/markdown",
        contentLength: 512 + (bodyIndex % 512),
      });
    case 2:
    case 5:
      return toolActivityEntry({
        atMs,
        sessionId: SESSION_ID,
        runId,
        kind: "tool.invoked",
        toolName: "edit_file",
        toolCallId: callId,
      });
    case 3:
      return toolActivityEntry({
        atMs,
        sessionId: SESSION_ID,
        runId,
        kind: "tool.result",
        toolName: "edit_file",
        toolCallId: `call-endurance-${String(bodyIndex - 1)}`,
        durationMs: 40 + (bodyIndex % 200),
        contentLength: 128 + (bodyIndex % 1_024),
      });
    case 6:
      return toolActivityEntry({
        atMs,
        sessionId: SESSION_ID,
        runId,
        kind: "tool.error",
        toolName: "edit_file",
        toolCallId: `call-endurance-${String(bodyIndex - 1)}`,
        durationMs: 20 + (bodyIndex % 80),
        contentLength: 96,
      });
    default:
      return {
        atMs,
        kind: "usage.context_compacted",
        // The two members every run-scoped payload in the corpus carries. The
        // boundary position a compaction seam would render is named nowhere in
        // `packages/contracts`, so this beat does not claim one.
        payload: { sessionId: SESSION_ID, runId },
      };
  }
}

/** How many body beats each run gets, and how many the last run absorbs. */
function planRunBodies(
  rowCount: number,
  runCount: number,
): { readonly bodyPerRun: number; readonly lastRunExtraBody: number } {
  const bodyBudget = rowCount - OPENING_BEAT_COUNT - runCount * RUN_LIFECYCLE_BEAT_COUNT;
  const minimumRowCount = rowCount - bodyBudget + runCount;
  if (bodyBudget < runCount) {
    throw new RangeError(
      `a ledger endurance scenario of ${String(runCount)} runs needs at least ` +
        `${String(minimumRowCount)} rows — ${String(OPENING_BEAT_COUNT)} to open the session, ` +
        `${String(RUN_LIFECYCLE_BEAT_COUNT)} per run for its lifecycle, and one body row each. ` +
        `Received ${String(rowCount)}.`,
    );
  }
  const bodyPerRun = Math.floor(bodyBudget / runCount);
  return { bodyPerRun, lastRunExtraBody: bodyBudget - bodyPerRun * runCount };
}

/**
 * A generated session of exactly `rowCount` beats, spread over `runCount` chapters.
 *
 * The count is EXACT rather than approximate, and that is what makes it useful: an
 * endurance reading names the row count it was taken at, and a generator that
 * produced "about ten thousand" would have two runs of one measurement disagreeing
 * for a reason nobody could see in the number.
 */
export function createLedgerEnduranceScenario(
  options: LedgerEnduranceScenarioOptions,
): ConsoleScenario {
  const runCount = options.runCount ?? DEFAULT_ENDURANCE_RUN_COUNT;
  if (!Number.isInteger(runCount) || runCount < 1) {
    throw new RangeError(
      `a ledger endurance scenario needs a whole, positive run count; received ${String(runCount)}.`,
    );
  }
  if (!Number.isInteger(options.rowCount)) {
    throw new RangeError(
      `a ledger endurance scenario needs a whole row count; received ${String(options.rowCount)}.`,
    );
  }
  const { bodyPerRun, lastRunExtraBody } = planRunBodies(options.rowCount, runCount);
  const entries: LedgerScriptEntry[] = [];
  const at = (): number => entries.length * ENDURANCE_BEAT_INTERVAL_MS;

  entries.push(
    ...ledgerOpeningEntries({
      sessionId: SESSION_ID,
      openedBy: PARTICIPANT_YOU,
      joinedBy: PARTICIPANT_PRIYA,
      membershipId: MEMBERSHIP_PRIYA,
      joinedAtMs: ENDURANCE_BEAT_INTERVAL_MS,
      cast: ENDURANCE_AGENTS.map((agent, agentIndex) => ({
        ...agent,
        attachedAtMs: (2 + agentIndex) * ENDURANCE_BEAT_INTERVAL_MS,
      })),
    }),
  );

  for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
    const runId = enduranceRunId(runIndex);
    const agent = ENDURANCE_AGENTS[runIndex % ENDURANCE_AGENTS.length];
    if (agent === undefined) {
      throw new RangeError("the endurance cast is empty, so no run can be attributed.");
    }
    // The two people take turns opening runs, so attribution alternates rather than
    // giving one participant every chapter in a ten-thousand-row session.
    const opener = runIndex % 2 === 0 ? PARTICIPANT_YOU : PARTICIPANT_PRIYA;
    entries.push(
      runTransitionEntry({
        atMs: at(),
        sessionId: SESSION_ID,
        runId,
        runVersion: 1,
        newState: "queued",
        agentId: agent.agentId,
        actorId: opener,
      }),
    );
    entries.push(
      runTransitionEntry({
        atMs: at(),
        sessionId: SESSION_ID,
        runId,
        runVersion: 2,
        previousState: "queued",
        newState: "starting",
      }),
    );
    entries.push(
      runTransitionEntry({
        atMs: at(),
        sessionId: SESSION_ID,
        runId,
        runVersion: 3,
        previousState: "starting",
        newState: "running",
      }),
    );
    const bodyCount = bodyPerRun + (runIndex === runCount - 1 ? lastRunExtraBody : 0);
    for (let bodyIndex = 0; bodyIndex < bodyCount; bodyIndex += 1) {
      entries.push(enduranceBodyEntry(at(), runId, bodyIndex));
    }
    entries.push(
      runTransitionEntry({
        atMs: at(),
        sessionId: SESSION_ID,
        runId,
        runVersion: 4,
        previousState: "running",
        newState: "completed",
      }),
    );
  }

  return {
    id: LEDGER_ENDURANCE_SCENARIO_ID,
    label: "Endurance",
    purpose: `A generated session of ${String(options.rowCount)} rows across ${String(runCount)} run chapters, for the tiers that measure the ledger at scale.`,
    sessionId: SESSION_ID,
    participantIdsInJoinOrder: [
      PARTICIPANT_YOU,
      PARTICIPANT_PRIYA,
      ...ENDURANCE_AGENTS.map((agent) => agent.agentId),
    ],
    viewingParticipantId: PARTICIPANT_YOU,
    // The roster every role gate resolves through. The viewer is an owner, which is what
    // lets a role-gated control be driven in this scenario at all; Priya's
    // `collaborator` is the same value her `membership.created` beat carries — one fact,
    // stated where the roster is read from and replayed where the log records it
    // arriving. The agents are absent on purpose: an agent is attached rather than
    // admitted and holds no membership, so a row here would resolve to a role no daemon
    // granted.
    membershipRoleByParticipantId: {
      [PARTICIPANT_YOU]: "owner",
      [PARTICIPANT_PRIYA]: "collaborator",
    },
    startedAtIso: STARTED_AT_ISO,
    beats: scriptLedgerBeats({
      sessionId: SESSION_ID,
      eventIdStem: EVENT_ID_STEM,
      startedAtIso: STARTED_AT_ISO,
      entries,
    }),
    replies: [
      {
        call: "session.read",
        result: {
          session: {
            id: SESSION_ID,
            state: "active",
            config: {},
            metadata: {},
            createdAt: STARTED_AT_ISO,
            updatedAt: new Date(
              startedAtMs + entries.length * ENDURANCE_BEAT_INTERVAL_MS,
            ).toISOString(),
          },
          timelineCursors: { latest: `ledger-endurance-cursor-${String(entries.length)}` },
        },
      },
      {
        call: "agent.list",
        result: {
          agents: ENDURANCE_AGENTS.map((agent) => ({
            agentId: agent.agentId,
            name: agent.name,
            driverName: agent.driverName,
            modelId: agent.modelId,
            config: {},
            state: "ready",
            createdAt: STARTED_AT_ISO,
          })),
        },
      },
    ],
  };
}
