// The approvals section — what this session is waiting on a person for.
//
// `Spec-023 §The surface set` makes each sidebar section "a composition of its own
// read, opening panes", and this one was reserved rather than stubbed while the
// section had no owner. The seat's own header states why an approvals PANE is not a
// substitute for it: the pane is a whole surface a person navigates to, the frame's
// approval banner is room-wide attention, and the section is the sidebar's own
// independently loaded read of what this session is waiting on. This file is that
// read.
//
// THE READ IS THE SESSION STORE, NOT A SECOND CALL. `bridge/approvals/` owns the fold
// over the seven approval-flow event kinds, and the renderer shell's composition root
// registers it on the projector registry, so the `approval` partition IS the console's
// projection of that plane. A section that called `approval.projectionRead` for
// itself would read the same wire twice and hold an answer beside the store that the
// next event would not move — and the pane already performs that read, on its own
// four triggers, for the detail this section does not draw.
//
// COUNTS, NOT LISTS, UNTIL OPENED, and never a badge nobody served: the rollup below
// answers only from an ANSWERED, whole projection, so a store that has not loaded and
// one the daemon called incomplete both raise nothing rather than reporting zero.
//
// THE STATE VOCABULARY IS THE WIRE'S. `ApprovalState` is the registered five-member
// union and `asApprovalState` is the one narrowing the console owns for it, so a
// state this build does not carry takes the unrecognized group and renders its own
// string rather than being guessed into one of the five.

import { useMemo } from "react";

import { STATE_PHRASE, asApprovalState, type ApprovalState } from "../../../bridge/index.js";
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
  type ConsolePaneAddress,
  type SectionListGroup,
  type SidebarRollupGroup,
  type SidebarRollupNode,
  type SidebarSectionContext,
} from "../../../seats/index.js";
import { type SidebarSectionAttention } from "../model/sidebar-model.js";
import { readSectionRollup, sectionRowDragBinding } from "./section-rollup-nodes.js";

/** The pane every row of this section opens, whether pressed or dropped. */
const APPROVALS_PANE: ConsolePaneAddress = { kind: "approvals" };

/** The groups this section renders, in render order. Closed, declared once. */
const APPROVAL_GROUPS = ["waiting", "settled", "unrecognized"] as const;

type ApprovalGroup = (typeof APPROVAL_GROUPS)[number];

/**
 * Which group a registered state sorts into, total over the wire's union.
 *
 * Two groups and not five: the sidebar's density rule is counts until a section is
 * opened, and the question this column answers is whether anybody is waiting. The
 * four settled states keep their own wire-verbatim chip inside the settled group, so
 * nothing is collapsed away — what is collapsed is the HEADINGS, and a person who
 * wants the distinction between rejected and expired opens the pane, which draws it.
 */
const GROUP_BY_APPROVAL_STATE: Readonly<Record<ApprovalState, ApprovalGroup>> = {
  pending: "waiting",
  approved: "settled",
  rejected: "settled",
  expired: "settled",
  canceled: "settled",
};

/** What each group is called on screen. Total over the closed set. */
const GROUP_LABEL: Readonly<Record<ApprovalGroup, string>> = {
  waiting: "Waiting on a person",
  settled: "Settled",
  unrecognized: "Unrecognized state",
};

/**
 * The chip tone each group wears. Total for `GROUP_LABEL`'s reason.
 *
 * `waiting` is the one amber group, because amber means a person is needed and
 * nothing else earns it. `settled` is neutral rather than green: an approval that was
 * answered is the console working, and spending a second attention colour on it would
 * leave nothing louder for the case where something failed.
 */
const GROUP_TONE: Readonly<Record<ApprovalGroup, ChipTone>> = {
  waiting: "attention",
  settled: "neutral",
  // A state this build does not know is a defect somewhere, not an approval in
  // trouble — the same reading the runs section gives its own unrecognized group.
  unrecognized: "failure",
};

/**
 * Which of the column's four rollup groups each of this section's groups reports as.
 *
 * `waiting` is the one that is calling for a person, so it is the column's
 * `needs-attention`. `settled` and `unrecognized` both report as `rest`: neither is
 * running and neither is waiting on anybody, and inventing a fifth column-level group
 * for a state no build should be meeting would reopen a shared enumeration for one
 * section's benefit. The body still draws unrecognized under its own heading.
 *
 * `running` and `pinned` are unreachable from here, and that is a fact about approvals
 * rather than an omission: an approval is a question waiting on a person, so nothing
 * about it runs, and nothing in the corpus pins one.
 */
const ROLLUP_GROUP_BY_APPROVAL_GROUP: Readonly<Record<ApprovalGroup, SidebarRollupGroup>> = {
  waiting: "needs-attention",
  settled: "rest",
  unrecognized: "rest",
};

export function ApprovalsSection(context: SidebarSectionContext): React.JSX.Element {
  const approvalsById = useSessionPartition(context.sessionStore, "approval");
  const isInitialised = useSessionInitialised(context.sessionStore);
  const degradedCause = useSessionDegradedCause(context.sessionStore);

  const grouped = useMemo(
    () => groupApprovals(Object.values(approvalsById), context.filterQuery),
    [approvalsById, context.filterQuery],
  );

  if (!isInitialised) {
    return <Nothing kind="not-loaded" title="Reading what this session is waiting on." />;
  }
  if (degradedCause !== undefined) {
    return (
      <Nothing
        kind="error"
        title="The approval list is unavailable."
        // The cause is the store's own word, rendered as received, and there is no
        // Retry beside it: nothing reachable from a section re-pulls a session, and
        // an offered control with nothing behind it is the copy-honesty failure.
        detail={`The projection is incomplete (${degradedCause}), so what is shown here would be a partial list rather than a short one.`}
      />
    );
  }

  if (groupedRowCount(grouped) === 0) {
    return (
      <Nothing
        kind="empty"
        title={
          normaliseFilterQuery(context.filterQuery) === ""
            ? "Nothing in this session is waiting on an approval."
            : "No approval matches the filter."
        }
        detail="An approval appears when an agent asks to do something the session's posture holds back."
      />
    );
  }

  const groups: SectionListGroup[] = [];
  for (const group of APPROVAL_GROUPS) {
    const approvals = grouped.get(group);
    if (approvals === undefined) {
      continue;
    }
    groups.push({
      id: group,
      label: GROUP_LABEL[group],
      tone: GROUP_TONE[group],
      rows: approvals.map((approval) => ({
        id: approval.id,
        stateLabel: approval.state ?? "unknown",
        openLabel: `${statePhraseFor(approval.state)}: approval ${approval.id}`,
        // The session's approvals pane. No pane kind is a view of ONE approval —
        // the inspector's admitted entity kinds are the five sidebar-card kinds and
        // an approval is not among them — so a row opens the surface that holds
        // every request rather than an address the deck would have to refuse.
        open: () => {
          context.openPane(APPROVALS_PANE);
        },
        // The drag opens what the press opens, through the column's own binder — the
        // same seam the runs section binds its rows through, and optional on both sides
        // for the same reason: a composition that hands down no binder has rows nobody
        // bound rather than a no-op invented here.
        ...sectionRowDragBinding(context.dragRow, {
          sectionId: "approvals",
          entityId: approval.id,
          label: `approval ${approval.id}`,
          opens: APPROVALS_PANE,
        }),
      })),
    });
  }

  return <SidebarSectionList countNoun="approvals" groups={groups} />;
}

/**
 * This session's requests as the tree the sidebar folds while this section is shut.
 *
 * A PULL, for the reason the seat states: a collapsed section is not mounted, so a
 * section in trouble could never report from inside itself and the rule that opens it
 * could never fire. Called during the sidebar's own render over state this family
 * already holds — never a read, never a subscription.
 *
 * THE TREE RATHER THAN A LEVEL, which is the seat's own precedence: a section that
 * supplies a rollup has its level folded from it, and answers `attention` as well only
 * where it knows something the fold cannot reach. This one does not, and the tree
 * additionally carries the grouped counts the shut header draws.
 *
 * `failure` is deliberately unreachable. A pending approval is a session waiting on a
 * person, which is `attention`; `failure` names this section's own read having broken,
 * and a broken read supplies no nodes at all rather than a level.
 */
export function approvalsSectionRollup(
  context: Omit<SidebarSectionContext, "isOpen" | "openPane">,
): readonly SidebarRollupNode[] {
  return readSectionRollup(context, {
    partition: "approval",
    group: (approval) => ROLLUP_GROUP_BY_APPROVAL_GROUP[groupOf(approval.state)],
    attention: (approval) => attentionOf(approval.state),
    label: (approval) => `approval ${approval.id}`,
    opens: APPROVALS_PANE,
  });
}

/** What one request is calling for: the waiting group, and nothing else. */
function attentionOf(state: string | undefined): SidebarSectionAttention | undefined {
  return groupOf(state) === "waiting" ? "attention" : undefined;
}

/**
 * Split the approvals into their groups, dropping the ones the filter excludes.
 *
 * The fold is `section-grouping.ts`'s, shared with the other section bodies; what
 * stays here is the three answers only this section can give.
 */
function groupApprovals(
  approvals: readonly ConsoleEntity[],
  filterQuery: string | undefined,
): ReadonlyMap<ApprovalGroup, readonly ConsoleEntity[]> {
  const normalisedQuery = normaliseFilterQuery(filterQuery);
  return groupSectionRows(approvals, {
    groupOf: (approval) => groupOf(approval.state),
    matches: (approval) => normalisedQuery === "" || matchesFilter(approval, normalisedQuery),
    orderedBy: (approval) => approval.touchedAt,
  });
}

/**
 * The sidebar filter runs over titles and paths; an approval's are its identifier and
 * the category the request carried.
 *
 * The category is read off the projected body rather than re-parsed: the projector
 * narrowed it against the registered member schema already, and a section that
 * re-narrowed a wire member would be the second validator a view family may not hold.
 */
function matchesFilter(approval: ConsoleEntity, normalisedQuery: string): boolean {
  const category = approval.body?.["category"];
  return (
    approval.id.toLocaleLowerCase().includes(normalisedQuery) ||
    (approval.state ?? "").toLocaleLowerCase().includes(normalisedQuery) ||
    (typeof category === "string" && category.toLocaleLowerCase().includes(normalisedQuery))
  );
}

/**
 * Which group a wire-verbatim state sorts into.
 *
 * Through `asApprovalState`, the one narrowing this console owns for the union, so a
 * state the wire grows takes the unrecognized group instead of being asserted into a
 * group it does not belong to.
 */
function groupOf(state: string | undefined): ApprovalGroup {
  const registered = state === undefined ? undefined : asApprovalState(state);
  return registered === undefined ? "unrecognized" : GROUP_BY_APPROVAL_STATE[registered];
}

/** What a row's state is called out loud, or the wire's own string where it is not one of the five. */
function statePhraseFor(state: string | undefined): string {
  const registered = state === undefined ? undefined : asApprovalState(state);
  return registered === undefined ? GROUP_LABEL.unrecognized : STATE_PHRASE[registered];
}
