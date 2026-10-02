// Endurance test support: a session log as long as the transcript claims to survive.
//
// Not a picker scenario and not in `fixtures/index.ts`: a ten-thousand-row session in the
// manifest would be paid for by every suite that iterates the shipped set. It is a generator
// `transcript-endurance.test.ts` calls with the row count it measures, so the count is a required
// argument: a fixture that hard-coded ten thousand would have callers measuring one number and
// reporting another.
//
// It is generated because the shape the transcript must survive is many run groups (runs
// opening, streaming and folding to receipts), not one run with ten thousand rows, and
// hand-writing that at scale would drift somewhere nobody reads.
//
// Determinism is the contract: every identifier, instant and kind is a function of the row index
// alone (no `Math.random`, `Date.now` or hash iteration order), so a heap reading or frame
// timing is comparable across runs and machines.
//
// The beats use the registered vocabulary the picker scenarios play (the census
// `SESSION_EVENT_CATEGORY_BY_TYPE` and the strict layer `SessionEventSchema`, both in
// `packages/contracts/src/event.ts`), so a reading is taken over rows the daemon could send.

import {
  composeOpeningEntry,
  composeResolvedAgent,
  composeScenarioInstant,
} from "../../fixtures/data/opening-entries.js";
import {
  assistantOutputEntry,
  runTransitionEntry,
  composeScriptBeats,
  toolActivityEntry,
  type ScriptEntry,
} from "../../fixtures/data/script-entries.js";
import type { ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";

/** The UUID v7 time prefix every generated identifier shares. */
const ENDURANCE_ID_PREFIX = "019b7892-1c00";

const SESSION_ID = `${ENDURANCE_ID_PREFIX}-75e5-8510-ada11a5a47a5`;

/**
 * The stem this log's row ids are minted from, its own namespace rather than its
 * session's. `composeScriptBeats` completes it with the beat's position.
 */
const EVENT_ID_STEM = `${ENDURANCE_ID_PREFIX}-7ea1-8110-e5e0d115`;
const USER_YOU = `${ENDURANCE_ID_PREFIX}-79a4-8110-cca0117a0490`;
/**
 * The base instant, minted from its fields rather than parsed from a string: `Date.parse` is not
 * a validator (it reads a timezone-less stamp in the host's zone and normalizes a day that does
 * not exist), and the console bans it. The ISO spelling every reply carries is derived from this
 * value so the two cannot disagree.
 */
const startedAtMs = Date.UTC(2026, 0, 1, 8, 0);

const STARTED_AT_ISO = new Date(startedAtMs).toISOString();

/** Time between two consecutive events. Even spacing, so the stream is steady. */
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
    definitionId: `${ENDURANCE_ID_PREFIX}-7de1-8120-d1a4c1150222`,
  },
  {
    agentId: `${ENDURANCE_ID_PREFIX}-7a6e-8130-d1a4c1150203`,
    name: "Reviewer",
    driverName: "codex",
    modelId: "gpt-5.6-sol",
    definitionId: `${ENDURANCE_ID_PREFIX}-7de1-8130-d1a4c1150223`,
  },
] as const;

/** The opening beat every generated session shares: the room, born with its lead. */
const OPENING_BEAT_COUNT = 1;

/** Beats one run spends on its own lifecycle: queued, starting, running, completed. */
const RUN_LIFECYCLE_BEAT_COUNT = 4;

/**
 * The body a run streams between `running` and `completed`, as a repeating cycle.
 *
 * Eight entries so the log is not two alternating rows: a run group carries thinking, prose,
 * three tool calls of which one fails, and one compaction seam. That mix is what the run group
 * fold folds, the find field searches and the row-height ledger measures; a uniform body would
 * have each measuring its easiest case.
 */
const ENDURANCE_BODY_CYCLE_LENGTH = 8;

/** What the generator needs to know. */
interface TranscriptEnduranceFixtureOptions {
  /** Exactly how many events the generated log holds. */
  readonly rowCount: number;
  /** How many run groups those beats are spread across. Defaults to 24. */
  readonly runCount?: number;
}

/** The default run group count: enough that no fold, cap, or index sees one run. */
const DEFAULT_ENDURANCE_RUN_COUNT = 24;

/**
 * A generated session log of exactly `rowCount` events, spread over `runCount` run groups.
 *
 * The count is exact because an endurance reading names the row count it was taken at. Throws a
 * `RangeError` for a non-integer row or run count, or a row count too small to give every run
 * group a body.
 */
export function createTranscriptEnduranceFixture(
  options: TranscriptEnduranceFixtureOptions,
): readonly ProjectedSessionEvent[] {
  const runCount = options.runCount ?? DEFAULT_ENDURANCE_RUN_COUNT;
  if (!Number.isInteger(runCount) || runCount < 1) {
    throw new RangeError(
      `a transcript endurance log needs a whole, positive run count; received ${String(runCount)}.`,
    );
  }
  if (!Number.isInteger(options.rowCount)) {
    throw new RangeError(
      `a transcript endurance log needs a whole row count; received ${String(options.rowCount)}.`,
    );
  }
  const { bodyPerRun, lastRunExtraBody } = planRunBodies(options.rowCount, runCount);
  const entries: ScriptEntry[] = [];
  const at = (): number => entries.length * ENDURANCE_BEAT_INTERVAL_MS;

  entries.push(
    composeOpeningEntry({
      sessionId: SESSION_ID,
      shape: "project",
      openedBy: USER_YOU,
      lead: ENDURANCE_AGENTS[0],
      createdAt: STARTED_AT_ISO,
    }),
  );

  for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
    const runId = enduranceRunId(runIndex);
    const agent = ENDURANCE_AGENTS[runIndex % ENDURANCE_AGENTS.length];
    if (agent === undefined) {
      throw new RangeError("the endurance cast is empty, so no run can be attributed.");
    }
    const queuedAtMs = at();
    // An agent other than the lead enters the session with its first run, started from
    // its saved definition.
    const startsItsAgent = runIndex > 0 && runIndex < ENDURANCE_AGENTS.length;
    entries.push(
      runTransitionEntry({
        atMs: queuedAtMs,
        sessionId: SESSION_ID,
        runId,
        runVersion: 1,
        newState: "queued",
        actorId: USER_YOU,
        // A run names an agent already in the session, or brings one in; never both.
        ...(startsItsAgent
          ? {
              resolvedAgent: composeResolvedAgent({
                agent,
                lead: ENDURANCE_AGENTS[0],
                resolvedAt: composeScenarioInstant(startedAtMs, queuedAtMs),
              }),
            }
          : { agentId: agent.agentId }),
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

  return composeScriptBeats({
    sessionId: SESSION_ID,
    eventIdStem: EVENT_ID_STEM,
    startedAtMs,
    entries,
  }).map((beat) => beat.event);
}

/** A generated run's identifier, a function of its index and nothing else. */
function enduranceRunId(runIndex: number): string {
  return `${ENDURANCE_ID_PREFIX}-740e-8110-${runIndex.toString(16).padStart(12, "0")}`;
}

/** One body beat, chosen from the cycle by its position within the run. */
function enduranceBodyEntry(atMs: number, runId: string, bodyIndex: number): ScriptEntry {
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
      `a transcript endurance log of ${String(runCount)} runs needs at least ` +
        `${String(minimumRowCount)} rows — ${String(OPENING_BEAT_COUNT)} to open the session, ` +
        `${String(RUN_LIFECYCLE_BEAT_COUNT)} per run for its lifecycle, and one body row each. ` +
        `Received ${String(rowCount)}.`,
    );
  }
  const bodyPerRun = Math.floor(bodyBudget / runCount);
  return { bodyPerRun, lastRunExtraBody: bodyBudget - bodyPerRun * runCount };
}
