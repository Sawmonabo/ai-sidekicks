// The runs section — the one of this family's three sidebar sections with a body.
//
// `Spec-023 §The surface set` makes each sidebar section "a composition of its own
// read, opening panes". THE REST IS THIS SECTION'S OWN, because no committed
// document states it: rows group pinned, needs-attention, running, then the rest;
// counts show only once the section's read has answered; and an unavailable read
// renders as unavailable rather than as zero. This file is that composition for
// runs.
//
// THE READ IS THE SESSION STORE, NOT A BRIDGE CALL. Runs reach this console over
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
// what `Spec-023 §Meridian, the design language` rule 8 forbids — "A renderer that
// collapses two of these into one is wrong" — and the middle one is this section's
// own never-zero rule above.
//
// THE STATE VOCABULARY IS THE WIRE'S. `RunState` is the registered nine-member
// union, and grouping reads a run's wire-verbatim `state` against it through a
// total table. A state the union does not carry is not guessed at — it takes the
// unrecognized group and renders its own string, which is the fail-closed
// projection rule.

import { useMemo } from "react";

import { type RunState } from "@ai-sidekicks/contracts";

import { Nothing, type ChipTone } from "../../../primitives/index.js";
import {
  useSessionDegradedCause,
  useSessionInitialised,
  useSessionPartition,
  type ConsoleEntity,
} from "../../../store/index.js";
import {
  SidebarSectionList,
  groupSectionRows,
  groupedRowCount,
  normaliseFilterQuery,
  type SectionListGroup,
  type SidebarSectionContext,
} from "../../../seats/index.js";
import { type SidebarSectionAttention } from "../model/sidebar-model.js";

/**
 * Which group a run's state sorts into, total over the registered union.
 *
 * `needs-attention` is the amber-or-red half of the grouping above and is also what
 * {@link runsSectionAttention} answers from, so one table decides both — a section
 * that grouped by one rule and answered attention by another could show a mark over
 * a list with nothing wrong in it.
 *
 * `pinned`, the first of those four groups, is absent because nothing in the
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
    () => groupRuns(Object.values(runsById), context.filterQuery),
    [runsById, context.filterQuery],
  );

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

  if (groupedRowCount(grouped) === 0) {
    return (
      <Nothing
        kind="empty"
        title={
          normaliseFilterQuery(context.filterQuery) === ""
            ? "No run has been started in this session."
            : "No run matches the filter."
        }
        detail="A run starts when a participant sends a message to an agent."
      />
    );
  }

  const groups: SectionListGroup[] = [];
  for (const group of RUN_GROUPS) {
    const runs = grouped.get(group);
    if (runs === undefined) {
      continue;
    }
    groups.push({
      id: group,
      label: GROUP_LABEL[group],
      tone: GROUP_TONE[group],
      rows: runs.map((run) => ({
        id: run.id,
        stateLabel: run.state ?? "unknown",
        openLabel: `${GROUP_LABEL[group]}: run ${run.id}`,
        // The session's runs pane, not an inspector over this row. No pane kind is
        // a view of one run — `seats/pane-address.ts` settles which entity kinds
        // each kind admits, and the inspector's are the five sidebar-card kinds the
        // spec enumerates — so a row opens the surface that holds every run rather
        // than an address the deck would have to refuse.
        open: () => {
          context.openPane({ kind: "runs" });
        },
      })),
    });
  }

  return <SidebarSectionList countNoun="runs" groups={groups} />;
}

/**
 * What the runs section is asking for, read without mounting it.
 *
 * A PULL rather than a push, and that is what makes the sidebar's rule reachable at
 * all: a collapsed section is not mounted, so a section in trouble could never report
 * from inside itself and the rule that opens it could never fire. This function is
 * called by the sidebar during its own render, over state this family already holds —
 * never a read, never a subscription.
 *
 * Only an ANSWERED read may raise a mark. A store that has not loaded, or one the
 * daemon has told us is incomplete, knows nothing about whether a run needs attention,
 * and a mark raised from that would be the badge the sidebar refuses to synthesise.
 *
 * `failure` is deliberately unreachable here. A run that failed is a run this session
 * is waiting on a person for, which is `attention`; `failure` names the section's own
 * read having broken, and a broken read is the `error` arm the body renders rather than
 * a level the rollup can answer with.
 *
 * The filter is not consulted, and the omission is the claim: filtering narrows what a
 * person is LOOKING at, and a failed run hidden by a filter is still a failed run. A
 * rollup that answered from the filtered list would go quiet exactly when somebody
 * typed.
 */
export function runsSectionAttention(
  context: Omit<SidebarSectionContext, "isOpen" | "openPane">,
): SidebarSectionAttention | undefined {
  const state = context.sessionStore.snapshot();
  if (!state.initialised || state.degradedCause !== undefined) {
    return undefined;
  }
  return Object.values(state.partitions.run).some((run) => groupOf(run.state) === "needs-attention")
    ? "attention"
    : undefined;
}

/**
 * Split the runs into their groups, dropping the ones the filter excludes.
 *
 * The fold itself is `section-grouping.ts`'s, shared with the other section bodies;
 * what stays here is the three answers only this section can give — which group a
 * run belongs to, what its filter matches, and what it is ordered by.
 */
function groupRuns(
  runs: readonly ConsoleEntity[],
  filterQuery: string | undefined,
): ReadonlyMap<RunGroup, readonly ConsoleEntity[]> {
  const normalisedQuery = normaliseFilterQuery(filterQuery);
  return groupSectionRows(runs, {
    groupOf: (run) => groupOf(run.state),
    matches: (run) => normalisedQuery === "" || matchesFilter(run, normalisedQuery),
    orderedBy: (run) => run.touchedAt,
  });
}

/** The sidebar filter runs over titles and paths; a run's are its identifier and
 *  its state. */
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
