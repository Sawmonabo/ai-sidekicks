// The runs section — the one sidebar section this family owns.
//
// `Spec-023 §Console Design (Meridian)` §4.4 makes each section "a composition of
// its own read", groups its rows "pinned, needs-attention, running, then the
// rest", shows "counts only when the section's read has answered", and renders
// "unavailable" rather than zero when the read is not there. This file is that
// composition for runs.
//
// THE READ IS THE SESSION STORE, NOT A BRIDGE CALL. §4.4's wire table gives runs
// `run.subscribeState` and `run.subscribeQueue`, which are SDK-only today. What
// the console has instead is the projected `run` partition, filled by the
// projectors registered at store construction — and that is a read the section is
// entitled to make, because the store is the console's projection of exactly
// those subscriptions. Nothing here polls, and nothing here subscribes to the
// bridge: the partition hook re-renders this section when a run changes and
// nothing else does.
//
// THE THREE ABSENCES ARE THREE DIFFERENT SENTENCES. A store that has not been
// initialised is `not-loaded`; a store the daemon told us is incomplete is
// `error` carrying its own cause verbatim; an initialised, whole store holding no
// runs is `empty` with the escape hatch. Collapsing any two of those is exactly
// what rule 8 forbids, and the middle one is §4.4's "never zero".
//
// THE STATE VOCABULARY IS THE WIRE'S. `RunState` is the registered nine-member
// union, and grouping reads a run's wire-verbatim `state` against it through a
// total table. A state the union does not carry is not guessed at — it takes the
// unrecognized group and renders its own string, which is the fail-closed
// projection rule.

import { useEffect, useMemo } from "react";

import { type RunState } from "@ai-sidekicks/contracts";

import {
  Chip,
  DerivedFigure,
  Nothing,
  formatCount,
  type ChipTone,
} from "../../../primitives/index.js";
import {
  useSessionDegradedCause,
  useSessionInitialised,
  useSessionPartition,
  type ConsoleEntity,
} from "../../../store/index.js";
import { type SidebarSectionContext } from "../../seats/index.js";

/**
 * Which group a run's state sorts into, total over the registered union.
 *
 * `needs-attention` is the amber-or-red half of §4.4's grouping and is also what
 * the section reports through the seat, so one table decides both — a section
 * that grouped by one rule and reported attention by another could show a red
 * mark over a list with nothing red in it.
 *
 * `pinned`, the first of §4.4's four groups, is absent because nothing in the
 * corpus pins a run: no wire member and no persisted value class carries it. A
 * group with no source would be a heading that is always empty.
 */
const GROUP_BY_RUN_STATE: Readonly<Record<RunState, RunGroup>> = {
  failed: "needs-attention",
  interrupted: "needs-attention",
  waiting_for_approval: "needs-attention",
  waiting_for_input: "needs-attention",
  running: "running",
  starting: "running",
  queued: "rest",
  paused: "rest",
  completed: "rest",
};

/** The groups this section renders, in render order. Closed, declared once. */
const RUN_GROUPS = ["needs-attention", "running", "rest", "unrecognized"] as const;

type RunGroup = (typeof RUN_GROUPS)[number];

/** What each group is called on screen. Total over the closed set. */
const GROUP_LABEL: Readonly<Record<RunGroup, string>> = {
  "needs-attention": "Needs attention",
  running: "Running",
  rest: "Everything else",
  unrecognized: "Unrecognized state",
};

/** The chip tone each group wears. Total for `GROUP_LABEL`'s reason. */
const GROUP_TONE: Readonly<Record<RunGroup, ChipTone>> = {
  "needs-attention": "attention",
  running: "accent",
  rest: "neutral",
  // A state this build does not know is a defect somewhere, not a run in trouble.
  unrecognized: "failure",
};

export function RunsSection(context: SidebarSectionContext): React.JSX.Element {
  const runsById = useSessionPartition(context.sessionStore, "run");
  const isInitialised = useSessionInitialised(context.sessionStore);
  const degradedCause = useSessionDegradedCause(context.sessionStore);

  const grouped = useMemo(
    () => groupRuns(Object.values(runsById), context.filterQuery ?? ""),
    [runsById, context.filterQuery],
  );

  const { reportAttention } = context;
  useEffect(() => {
    if (reportAttention === undefined) {
      return;
    }
    // Only an answered read may raise a mark. A store that has not loaded, or one
    // the daemon has told us is incomplete, knows nothing about whether a run
    // needs attention — and a mark raised from that would be the badge §4.4
    // forbids the sidebar to synthesise.
    if (!isInitialised || degradedCause !== undefined) {
      reportAttention("calm");
      return;
    }
    reportAttention(grouped.get("needs-attention") === undefined ? "calm" : "amber");
  }, [reportAttention, isInitialised, degradedCause, grouped]);

  if (!isInitialised) {
    return <Nothing kind="not-loaded" title="Reading the session's runs." />;
  }
  if (degradedCause !== undefined) {
    return (
      <Nothing
        kind="error"
        title="The run list is unavailable."
        // The cause is the store's own word, rendered as received. The console
        // does not paraphrase a wire value, and it does not offer a Retry it
        // cannot perform: nothing reachable from a section re-pulls a session.
        detail={`The projection is incomplete (${degradedCause}), so the runs shown here would be a partial list rather than a short one.`}
      />
    );
  }

  const totalRunCount = [...grouped.values()].reduce((count, runs) => count + runs.length, 0);
  if (totalRunCount === 0) {
    return (
      <Nothing
        kind="empty"
        title={
          (context.filterQuery ?? "") === ""
            ? "No run has been started in this session."
            : "No run matches the filter."
        }
        detail="A run starts when a participant sends a message to an agent."
      />
    );
  }

  return (
    <div className="meridian-sidebar-runs">
      <p className="meridian-sidebar-runs__count">
        <DerivedFigure text={`${formatCount(totalRunCount)} runs`} />
      </p>
      {RUN_GROUPS.map((group) => {
        const runs = grouped.get(group);
        return runs === undefined ? null : (
          <section
            className="meridian-sidebar-runs__group"
            key={group}
            aria-label={GROUP_LABEL[group]}
          >
            <h3 className="meridian-sidebar-runs__group-heading">
              <Chip tone={GROUP_TONE[group]} label={GROUP_LABEL[group]} />
              <DerivedFigure text={formatCount(runs.length)} />
            </h3>
            <ul className="meridian-sidebar-runs__list">
              {runs.map((run) => (
                <li className="meridian-sidebar-runs__row" key={run.id}>
                  <button
                    type="button"
                    className="meridian-sidebar-runs__open"
                    onClick={() => {
                      context.openPane({ kind: "inspector", entity: { kind: "run", id: run.id } });
                    }}
                  >
                    <span className="meridian-sidebar-runs__id">{run.id}</span>
                    <Chip mono label={run.state ?? "unknown"} tone={GROUP_TONE[group]} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/**
 * Split the runs into their groups, dropping the ones the filter excludes.
 *
 * A `Map` keyed by group with absent rather than empty entries, so a caller
 * renders a heading only for a group that has rows — the alternative, four
 * headings of which three say nothing, is the chrome §4.4's density rule spends
 * its whole paragraph avoiding.
 */
function groupRuns(
  runs: readonly ConsoleEntity[],
  filterQuery: string,
): ReadonlyMap<RunGroup, readonly ConsoleEntity[]> {
  const normalisedQuery = filterQuery.trim().toLocaleLowerCase();
  const grouped = new Map<RunGroup, ConsoleEntity[]>();
  for (const run of runs) {
    if (normalisedQuery !== "" && !matchesFilter(run, normalisedQuery)) {
      continue;
    }
    const group = groupOf(run.state);
    const existing = grouped.get(group);
    if (existing === undefined) {
      grouped.set(group, [run]);
    } else {
      existing.push(run);
    }
  }
  for (const rows of grouped.values()) {
    // Newest first within a group. `touchedAt` is an ISO-8601 string, which sorts
    // lexicographically in exactly timestamp order for a fixed offset — the wire
    // sends UTC — so no date is parsed to order a list.
    rows.sort((left, right) => (right.touchedAt ?? "").localeCompare(left.touchedAt ?? ""));
  }
  return grouped;
}

/** §4.4's filter is "over titles and paths"; a run's are its identifier and its state. */
function matchesFilter(run: ConsoleEntity, normalisedQuery: string): boolean {
  return (
    run.id.toLocaleLowerCase().includes(normalisedQuery) ||
    (run.state ?? "").toLocaleLowerCase().includes(normalisedQuery)
  );
}

/**
 * Which group a wire-verbatim state sorts into.
 *
 * The table is widened to a string lookup by ASSIGNMENT rather than by a cast:
 * the declaration above stays total over `RunState`, so the union gaining a tenth
 * member is a compile error there, while a state the union does not carry answers
 * `undefined` here and takes the unrecognized group instead of being asserted
 * into one it does not belong to.
 */
function groupOf(state: string | undefined): RunGroup {
  const groupByState: Readonly<Record<string, RunGroup | undefined>> = GROUP_BY_RUN_STATE;
  return (state === undefined ? undefined : groupByState[state]) ?? "unrecognized";
}
