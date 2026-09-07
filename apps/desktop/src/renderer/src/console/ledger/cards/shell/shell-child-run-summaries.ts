// The child runs this window's log names, summarized — the shell's half of the seam
// `ledger/structure/child-runs/` reads.
//
// WHAT WAS MISSING, AND IT WAS A GAP BETWEEN TWO CORRECT MODULES. `ChildRunIndex`
// finds every row carrying `childRunSummary` and draws it; the shell projection
// carried that member on no row it ever built, so the child-run treatment was
// reachable from hand-written fixtures and from nothing a scenario could play. The
// member is a PROJECTION's, not an event's — no registered payload carries one — so
// the only honest way to reach it from a log is to derive it, which is what the shell
// exists to do and what its own header calls naming every member the log cannot
// supply.
//
// WHAT THE LOG ACTUALLY SUPPORTS, WHICH IS WHY THIS IS A DERIVATION RATHER THAN AN
// INVENTION. `Spec-006 §Run Lifecycle (run_lifecycle)` puts the orchestration linkage
// on the BIRTH beat — `run.queued` carries `{agentId?, parentRunId?, linkType?,
// internalHelper?, producingNodeId?}` — so a run whose creation row names a parent IS
// a child run, said by the daemon rather than guessed here. Every member of the
// summary then comes off that same log:
//
//   • `runId` / `parentRunId` — the creation row's own two identities, verbatim.
//   • `producingNodeId` — the creation row's, where it names one. Absent stays absent:
//     `Spec-013` requires provenance to the producing node and a fabricated one would
//     be worse than the named absence the row renders.
//   • `state` — the state the child's newest lifecycle beat announces, read from the
//     KIND through `runStateForTransitionKind` rather than from an unvalidated payload
//     member, which is the same rule the run-entity fold is written under. The
//     creation row announces `queued`, which that mapping deliberately excludes
//     because it is not one of the eight transitions, so it is spelled here beside the
//     one type literal this module keys on.
//   • `eventCount` — how many of this window's rows are attributed to the child, by
//     the projection's OWN attribution reader. A count of what is held, which is what
//     the contract says the member is on the incomplete arm.
//   • `completeness` — `incomplete` with cause `compacted` from the child's first
//     `usage.context_compacted`, and `complete` otherwise. A compaction inside the
//     child folded rows out of its transcript, so the count above is a floor over a
//     history that lost entries — which is exactly what that cause names, and it is
//     terminal, so nothing retries it. No other cause is reachable from a log: this
//     console performs no child-run detail fetch to fail and holds no per-child
//     backfill state.
//
// THE SUMMARY IS COMPOSED HERE AND NOT PARSED HERE. A console surface never runs a
// contracts schema over a value — the wire's own shapes are narrowed at the call door
// and nowhere else — and this value never crossed a wire in the first place: it is the
// shell's reading of rows the store already holds. So the one refusal a schema would
// have performed is performed in code beside the reason for it: a creation row naming
// ITSELF as its parent produces no summary, because a self-parenting node makes the
// lineage graph cyclic and every walk of it non-terminating. The `RunId` / `NodeId`
// casts are the sibling projection's, for its stated reason — the brand is a
// compile-time nominal tag over `string` with no runtime witness, and the value under
// it is the wire's own.
//
// IT IS STAMPED ON ONE ROW PER CHILD: the creation row, which is the only row in the
// log that names the child AND its parent. Stamping the child's later rows would file
// them as re-summarizations, and a re-summarization is a claim the wire did not make —
// those rows say nothing about a parent at all. One row per child therefore takes a
// fresh object each projection pass and loses its place in the retention table, which
// is one row per child run and is stated here rather than discovered from a profile.

import {
  type ChildRunSummary,
  type NodeId,
  type RunId,
  type RunState,
} from "@ai-sidekicks/contracts";

import { runStateForTransitionKind } from "../../../bridge/index.js";
import { readWireString } from "../../../core/index.js";
import { type ConsoleSessionEvent } from "../../../store/index.js";
import { attributedRunIdOf } from "../run-attribution.js";

/**
 * The one event type that carries the orchestration linkage.
 *
 * Spelled once because two things read it: the pass that finds a child run, and the
 * state mapping below, which has to say what a creation row announces because the
 * transition mapping deliberately does not carry it.
 */
const RUN_CREATED_TYPE = "run.queued";

/** The state a creation row announces, which no transition mapping carries. */
const RUN_CREATED_STATE: RunState = "queued";

/**
 * The event type whose arrival inside a child run makes its summary a floor.
 *
 * A compaction is a boundary in that run's own transcript: rows before it were folded
 * away, so the count of what this window holds is a lower bound over a history that
 * lost entries.
 */
const CONTEXT_COMPACTED_TYPE = "usage.context_compacted";

/** What one pass has learned about one child run, before it is composed. */
interface ChildRunReading {
  /** The row the summary is stamped on — this child's own creation row. */
  readonly creationEventId: string;
  readonly parentRunId: string;
  readonly producingNodeId: string | undefined;
  state: RunState;
  eventCount: number;
  compactedAt: string | undefined;
}

/**
 * Every child run this log names, keyed by the EVENT ID of the row it is stamped on.
 *
 * Keyed by the row rather than by the run because that is the question the projection
 * asks — "does this event carry a summary" — and a run-keyed map would make the caller
 * re-decide which of a child's rows is its creation row, which is this module's rule.
 *
 * A pure fold, so the same log answers with the same summaries however many times it
 * is projected — the property the caller's memo depends on.
 */
export function deriveShellChildRunSummaries(
  events: readonly ConsoleSessionEvent[],
): ReadonlyMap<string, ChildRunSummary> {
  const readingsByRunId = new Map<string, ChildRunReading>();
  for (const event of events) {
    const runId = attributedRunIdOf(event.payload);
    if (runId === undefined) {
      continue;
    }
    if (event.kind === RUN_CREATED_TYPE) {
      admitChildRun(readingsByRunId, event, runId);
    }
    const reading = readingsByRunId.get(runId);
    if (reading === undefined) {
      // Not a child run, or a row that arrived before its creation row did. Either
      // way there is nothing to summarize: a child whose parent nothing named is a
      // run, and the ledger already draws one.
      continue;
    }
    reading.eventCount += 1;
    const announcedState = runStateForTransitionKind(event.kind);
    if (announcedState !== undefined) {
      reading.state = announcedState;
    }
    if (event.kind === CONTEXT_COMPACTED_TYPE && reading.compactedAt === undefined) {
      // The FIRST compaction, because that is when the transcript stopped being whole.
      // A later one changes nothing about the claim.
      reading.compactedAt = event.occurredAt;
    }
  }
  return composedSummaries(readingsByRunId);
}

/**
 * Record a creation row that names a parent, or leave the run unrecorded.
 *
 * `parentRunId` is read as a wire string and nothing else is inferred: a creation row
 * naming no parent is an ordinary run's, and a row naming a parent this reader cannot
 * read as a string is malformed rather than parentless — both produce no reading, and
 * the difference between them is not one this surface can act on.
 */
function admitChildRun(
  readingsByRunId: Map<string, ChildRunReading>,
  event: ConsoleSessionEvent,
  runId: string,
): void {
  const payload = event.payload;
  const parentRunId = readWireString(payload?.["parentRunId"]);
  if (parentRunId === undefined || readingsByRunId.has(runId)) {
    return;
  }
  readingsByRunId.set(runId, {
    creationEventId: event.id,
    parentRunId,
    producingNodeId: readWireString(payload?.["producingNodeId"]),
    state: RUN_CREATED_STATE,
    eventCount: 0,
    compactedAt: undefined,
  });
}

/**
 * Turn the readings into summaries, keyed by the row each is stamped on, and drop the
 * one shape the lineage graph cannot hold.
 *
 * THE SELF-PARENT REFUSAL IS THE WHOLE OF THE CHECK, and it is here rather than in a
 * schema because a schema is a parser and nothing on this path was parsed: every field
 * below is either the log's own string or this module's own count. A run that named
 * itself as its own parent makes the graph cyclic, so it produces no summary at all
 * rather than one whose first walk does not terminate.
 */
function composedSummaries(
  readingsByRunId: ReadonlyMap<string, ChildRunReading>,
): ReadonlyMap<string, ChildRunSummary> {
  const summariesByEventId = new Map<string, ChildRunSummary>();
  for (const [runId, reading] of readingsByRunId) {
    if (runId === reading.parentRunId) {
      continue;
    }
    summariesByEventId.set(reading.creationEventId, {
      runId: runId as RunId,
      parentRunId: reading.parentRunId as RunId,
      state: reading.state,
      ...(reading.producingNodeId === undefined
        ? {}
        : { producingNodeId: reading.producingNodeId as NodeId }),
      eventCount: reading.eventCount,
      completeness:
        reading.compactedAt === undefined
          ? { state: "complete" }
          : { state: "incomplete", cause: "compacted", observedAt: reading.compactedAt },
    });
  }
  return summariesByEventId;
}
