// What one of this family's sections reports while it is shut, and how one of its
// rows becomes draggable.
//
// TWO SEAMS IN ONE FILE, because both are one act read from its two ends: the section
// hands the column a NODE per item so the fold above the section can decide whether to
// open it, and a drag TARGET per row so the same item can be pulled onto the deck. Both
// are the section's own reading of the same list and both are keyed off the same
// identifier, so writing them apart would put "what are this section's items called" in
// two places and let the two answers drift.
//
// HOISTED ON THE SECOND USE. The runs and approvals sections differ only in which
// partition they read, which group an item sorts into, and what a row is called;
// everything else — the answered-and-whole guard, the flat node shape, and the
// column-unique drag id — is one rule, stated once.
//
// ONLY AN ANSWERED, WHOLE READ REPORTS ANYTHING. A store that has not been initialised
// and one the daemon has told us is incomplete both know nothing about what this
// section holds, and counts or a mark raised from either would be the badge the sidebar
// refuses to synthesise. Both answer with no nodes at all, which the column renders as
// nothing rather than as zero.
//
// THE FILTER IS NOT CONSULTED, and the omission is the claim. Filtering narrows what a
// person is LOOKING at; a failed run hidden by a query is still a failed run, and a
// section is not even mounted while it is shut, so a rollup answered from the filtered
// list would go quiet exactly when somebody typed.

import {
  type ConsolePaneAddress,
  type SidebarRollupGroup,
  type SidebarRollupNode,
  type SidebarRowDragBinder,
  type SidebarRowDragTarget,
  type SidebarSectionContext,
  type SidebarSectionId,
} from "../../../seats/index.js";
import { type ConsoleEntity, type ConsoleEntityKind } from "../../../store/index.js";
import { type SidebarSectionAttention } from "../model/sidebar-model.js";

/**
 * The three answers only a section can give about its own items, plus where they open.
 *
 * A table rather than a subclass, for the reason the section bodies already give about
 * their grouping tables: what varies between two sections is data, and a second
 * function that only re-spelled the guard above would be the copy that goes stale.
 */
export interface SectionRollupReading {
  /** Which store partition this section's items live in. */
  readonly partition: ConsoleEntityKind;
  /** Which of the column's four groups one item sorts into. */
  readonly group: (entity: ConsoleEntity) => SidebarRollupGroup;
  /**
   * What this item is calling for, or nothing.
   *
   * The item's OWN reading and never its neighbours': the column folds child-to-parent
   * and a node that reported for the section would be a second source of truth for what
   * the fold exists to compute.
   */
  readonly attention: (entity: ConsoleEntity) => SidebarSectionAttention | undefined;
  /** What a person reads on the node, and what a drop announcement names it by. */
  readonly label: (entity: ConsoleEntity) => string;
  /** The pane a press or a drop of one of these nodes opens. */
  readonly opens: ConsolePaneAddress;
}

/**
 * This section's items as the column's rollup tree.
 *
 * FLAT, AND THE FLATNESS IS A STATEMENT. The design track's tree is session › channel ›
 * run, and neither of this family's two sections holds that nesting: a projected run
 * carries no channel it belongs to and an approval carries none either, so a level
 * invented here would be a parent the console made up. `SidebarRollupNode.children` is
 * optional precisely so a section with one level supplies one level, and the fold walks
 * a flat list and a nested one by the same rule.
 *
 * Called during the column's render, over state the family already holds — never a
 * read, never a subscription.
 */
export function readSectionRollup(
  context: Omit<SidebarSectionContext, "isOpen" | "openPane">,
  reading: SectionRollupReading,
): readonly SidebarRollupNode[] {
  const state = context.sessionStore.snapshot();
  if (!state.initialised || state.degradedCause !== undefined) {
    return [];
  }
  return Object.values(state.partitions[reading.partition]).map((entity) => {
    const attention = reading.attention(entity);
    return {
      nodeId: entity.id,
      label: reading.label(entity),
      group: reading.group(entity),
      // Absent rather than present-and-undefined: the node shape says a node carrying
      // nothing itself omits the member, and the fold reads presence.
      ...(attention === undefined ? {} : { attention }),
      opens: reading.opens,
    };
  });
}

/** One row of a named section, as the column's drag binder keys it. */
export interface SectionRowDragInput {
  readonly sectionId: SidebarSectionId;
  /** The row's wire-verbatim identifier — unique within its own section. */
  readonly entityId: string;
  /** What a person reads on the row, and what the drop announcement names it by. */
  readonly label: string;
  /** What the drop opens. A row that opens nothing is not a drag target at all. */
  readonly opens: ConsolePaneAddress;
}

/**
 * What a row spreads into itself to become draggable, or nothing at all.
 *
 * SPREAD RATHER THAN A MEMBER SET TO `undefined`, because the row shape declares the
 * binding optional and this tree is compiled with exact optional property types: a row
 * carrying `bindDrag: undefined` is a different row from one carrying no key, and the
 * seat would have to widen its own member to accept it.
 *
 * A column that handed down no binder therefore produces rows nobody bound rather than
 * rows bound to a no-op — the distinction the section bodies rely on when they are
 * rendered outside a sidebar.
 */
export function sectionRowDragBinding(
  dragRow: SidebarRowDragBinder | undefined,
  input: SectionRowDragInput,
): { readonly bindDrag?: (element: HTMLElement | null) => void } {
  if (dragRow === undefined) {
    return {};
  }
  return { bindDrag: dragRow(sectionRowDragTarget(input)) };
}

/**
 * One row's drag target, keyed so two sections' rows can never collide.
 *
 * A rollup node's id is unique within its SECTION and a drag target's is unique within
 * the COLUMN — the binder cache is the column's, one entry per id — so the section id
 * is prefixed here rather than left to each section body to remember. A run and an
 * approval that happened to share an identifier would otherwise share one bound
 * element, and whichever row mounted second would drag the first one's address.
 */
function sectionRowDragTarget(input: SectionRowDragInput): SidebarRowDragTarget {
  return {
    nodeId: `${input.sectionId}:${input.entityId}`,
    label: input.label,
    opens: input.opens,
  };
}
