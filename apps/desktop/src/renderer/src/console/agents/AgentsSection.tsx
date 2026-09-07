// The agents section of the session sidebar — who is attached, and what state each is in.
//
// `Spec-023 §The surface set` names `agents` one of the sidebar's eight sections and
// makes each one "a composition of its own read, opening panes". It had no owner at
// all until this file, so the sidebar rendered the seat's own "reserved, not stubbed"
// answer where the roster belongs.
//
// IN THIS FAMILY AND NOT IN THE SIDEBAR'S, because a body belongs to the family whose
// vocabulary it renders — the same sentence this family's door already makes about the
// agent console — and because a section body parked in the sidebar's own subtree
// could not read the roster at all: one view family may not import another, so it
// would have had to re-declare the lifecycle kinds, the state vocabulary and the read.
// The COMPOSITION that seats it lives at the console root, where naming two families is
// what the file is for.
//
// THE READ IS THE ROSTER THIS FAMILY ALREADY HAS. `createAgentRoster` is the agent
// console's own push-driven read of `agent.list`, refreshed by the three registered
// lifecycle kinds and by nothing else — no interval, no second subscription. The
// section holds one for the session it is mounted under and disposes it when that
// session changes or the section closes, which a collapsed section does by not being
// mounted at all.
//
// THE STATE VOCABULARY IS THE WIRE'S, checked against `AGENT_STATES` through this
// family's own membership test, so a state this build does not carry takes the
// unrecognized group and renders its own string rather than being guessed into one it
// does not belong to. The row's chip is the sidebar's shared mono one rather than
// `AgentStateChip`: that component carries the `configured` reason sentence, which is a
// clause, and a sidebar row is one line.

import { useEffect, useMemo } from "react";

import { consoleClockFor } from "../bridge/index.js";
import { Nothing, type ChipTone } from "../primitives/index.js";
import {
  SidebarSectionList,
  groupSectionRows,
  groupedRowCount,
  normaliseFilterQuery,
  usePushDrivenRead,
  type SectionListGroup,
  type SidebarSectionContext,
} from "../seats/index.js";
import { useReadTriggers } from "../store/index.js";
import { AGENT_LIFECYCLE_EVENT_KINDS, AGENT_STATES, isKnownMember } from "./agent-wire.js";
import { createAgentRoster } from "./run-console/agent-console-reads.js";
import type { AgentRosterEntry } from "../bridge/index.js";

/** The groups this section renders, in render order. Closed, declared once. */
const AGENT_GROUPS = ["needs-attention", "ready", "rest", "unrecognized"] as const;

type AgentGroup = (typeof AGENT_GROUPS)[number];

/**
 * Which group a registered state sorts into, total over the wire's vocabulary.
 *
 * `configured` is the one amber state and the reason is `AgentStateChip`'s: it means
 * the agent's pinned machine is not attached, so the agent cannot run and somebody has
 * to attach it. That is a person being needed, which is what amber is for.
 */
const GROUP_BY_AGENT_STATE: Readonly<Record<(typeof AGENT_STATES)[number], AgentGroup>> = {
  configured: "needs-attention",
  ready: "ready",
  disabled: "rest",
  archived: "rest",
};

/** What each group is called on screen. Total over the closed set. */
const GROUP_LABEL: Readonly<Record<AgentGroup, string>> = {
  "needs-attention": "Needs attention",
  ready: "Ready",
  rest: "Everything else",
  unrecognized: "Unrecognized state",
};

/** The chip tone each group wears. Total for `GROUP_LABEL`'s reason. */
const GROUP_TONE: Readonly<Record<AgentGroup, ChipTone>> = {
  "needs-attention": "attention",
  ready: "accent",
  rest: "neutral",
  // A state this build does not know is a defect somewhere, not an agent in trouble.
  unrecognized: "failure",
};

export function AgentsSection(props: {
  readonly context: SidebarSectionContext;
}): React.JSX.Element {
  const { context } = props;
  const { bridge, sessionStore } = context;

  // Built in a memo and disposed by the effect that closed over it, so a section
  // rebound from one session to another builds a second reader rather than keeping the
  // first — the read is keyed on the session it names, and a retained one would list
  // the previous session's roster under the new session.
  const roster = useMemo(
    () => createAgentRoster(bridge, sessionStore, consoleClockFor(bridge)),
    [bridge, sessionStore],
  );
  useEffect(() => {
    return () => {
      roster.dispose();
    };
  }, [roster]);
  useReadTriggers(
    useMemo(
      () => ({
        triggeringEventKinds: new Set<string>(AGENT_LIFECYCLE_EVENT_KINDS),
        requestRead: (reason: Parameters<typeof roster.refresh>[0]) => {
          roster.refresh(reason);
        },
      }),
      [roster],
    ),
    sessionStore,
  );

  const state = usePushDrivenRead(roster);
  const entries = state.kind === "loaded" ? state.value.agents : [];
  const grouped = useMemo(
    () => groupAgents(entries, context.filterQuery),
    [entries, context.filterQuery],
  );

  if (state.kind === "not-loaded") {
    return <Nothing kind="not-loaded" title="Reading this session's agents." />;
  }
  if (state.kind === "failed") {
    return (
      <Nothing
        kind="error"
        title="The agent roster is unavailable."
        // The refusal's own sentence, rendered as received — it names the operation and
        // the document that owes the wire, and rebuilding it would drop exactly that.
        detail={state.refusal.detail}
      />
    );
  }

  if (groupedRowCount(grouped) === 0) {
    return (
      <Nothing
        kind="empty"
        title={
          normaliseFilterQuery(context.filterQuery) === ""
            ? "No agent is attached to this session."
            : "No agent matches the filter."
        }
        detail="An agent joins when somebody attaches one to this session."
      />
    );
  }

  const groups: SectionListGroup[] = [];
  for (const group of AGENT_GROUPS) {
    const agents = grouped.get(group);
    if (agents === undefined) {
      continue;
    }
    groups.push({
      id: group,
      label: GROUP_LABEL[group],
      tone: GROUP_TONE[group],
      rows: agents.map((agent) => ({
        id: agent.name ?? agent.agentId,
        stateLabel: agent.state ?? "state not reported",
        openLabel: `${GROUP_LABEL[group]}: agent ${agent.name ?? agent.agentId}`,
        // The agent console, addressed at this agent. It is the one pane kind that is a
        // view of a single agent, which is why this section opens an address where the
        // runs and approvals sections open a surface.
        open: () => {
          context.openPane({ kind: "agent-console", entity: { kind: "agent", id: agent.agentId } });
        },
      })),
    });
  }

  return <SidebarSectionList countNoun="agents" groups={groups} />;
}

/**
 * Split the roster into its groups, dropping the rows the filter excludes.
 *
 * The fold is `seats/section-grouping.ts`'s, shared with the sidebar's other bodies;
 * what stays here is the three answers only this section can give.
 */
function groupAgents(
  agents: readonly AgentRosterEntry[],
  filterQuery: string | undefined,
): ReadonlyMap<AgentGroup, readonly AgentRosterEntry[]> {
  const normalisedQuery = normaliseFilterQuery(filterQuery);
  return groupSectionRows(agents, {
    groupOf: (agent) => groupOf(agent.state),
    matches: (agent) => normalisedQuery === "" || matchesFilter(agent, normalisedQuery),
    // The roster carries no touch time; `createdAt` is the one instant on the row, so
    // newest-attached leads. A row without one sorts after the rows that have one
    // rather than being dropped.
    orderedBy: (agent) => agent.createdAt,
  });
}

/** The sidebar filter runs over titles and paths; an agent's are its name, its id and its state. */
function matchesFilter(agent: AgentRosterEntry, normalisedQuery: string): boolean {
  return (
    agent.agentId.toLocaleLowerCase().includes(normalisedQuery) ||
    (agent.name ?? "").toLocaleLowerCase().includes(normalisedQuery) ||
    (agent.state ?? "").toLocaleLowerCase().includes(normalisedQuery)
  );
}

/**
 * Which group a wire-verbatim state sorts into.
 *
 * The table is widened to a string lookup by ASSIGNMENT rather than by a cast, the
 * shape `RunsSection.tsx` uses for the same problem: the declaration above stays total
 * over `AGENT_STATES`, so the vocabulary gaining a member is a compile error there,
 * while a state it does not carry answers `undefined` here and takes the unrecognized
 * group instead of being asserted into one it does not belong to. `isKnownMember` is
 * the vocabulary's own membership test and guards the lookup ahead of it, so a
 * prototype key arriving as a state cannot resolve to a function.
 */
function groupOf(state: string | undefined): AgentGroup {
  const groupByState: Readonly<Record<string, AgentGroup | undefined>> = GROUP_BY_AGENT_STATE;
  if (state === undefined || !isKnownMember(AGENT_STATES, state)) {
    return "unrecognized";
  }
  return groupByState[state] ?? "unrecognized";
}
