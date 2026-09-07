// The rollup fold: what a section's own tree adds up to.
//
// `Spec-023 §Console Design (Meridian)` §The surface set asks the sidebar for
// "rollup status per section: child-to-parent over the session › channel › run tree;
// grouping pinned, needs-attention, running, then the rest; a section carrying an
// amber or red item is open and every other section is collapsed". The TREE is the
// owning family's — `SidebarSectionDescriptor.rollup` — and this module is the fold
// the column runs over it.
//
// CHILD-TO-PARENT, AND ONLY IN THAT DIRECTION. A node reports its OWN level and the
// fold carries it upward, so a channel is amber because a run under it is and never
// because the channel said so. The other direction would be a claim about a child
// made by something that is not the child, which is the shape that goes stale the
// moment the child settles.
//
// THE FOLD SYNTHESISES NO BADGE. Every number below is a count of nodes the section's
// own read produced; nothing here reaches a bridge, and a section whose read has not
// answered supplies no nodes and therefore no counts — which is the difference
// between "unavailable" and zero that the design track spends a whole bullet on.

import {
  SIDEBAR_ROLLUP_GROUPS,
  type SidebarRollupGroup,
  type SidebarRollupNode,
} from "../../../seats/index.js";
import { type SidebarSectionAttention } from "./sidebar-model.js";

/** What one section's tree adds up to. Replaced, never mutated in place. */
export interface SectionRollup {
  /**
   * The strongest level anywhere in the tree, or `undefined` when nothing is calling.
   *
   * This is the value the open-or-collapsed rule is decided from, which is why it is
   * the same union a section's own `attention` reader answers in: one vocabulary for
   * one question, whichever of the two seams the answer arrived through.
   */
  readonly attention: SidebarSectionAttention | undefined;
  /** How many nodes sit in each group. Total over the closed set, so zero is stated. */
  readonly countsByGroup: Readonly<Record<SidebarRollupGroup, number>>;
  /** Every node in the tree, at every depth. */
  readonly nodeCount: number;
}

/** A rollup over no tree at all: nothing calling, nothing counted. */
export const EMPTY_SECTION_ROLLUP: SectionRollup = Object.freeze({
  attention: undefined,
  countsByGroup: Object.freeze(emptyCounts()),
  nodeCount: 0,
});

/**
 * Which of two levels is the louder one.
 *
 * `failure` outranks `attention` outranks nothing — the two hues the design track
 * spends on urgency, ordered as it orders them. Written once here because both the
 * upward carry and the section-level answer ask it, and two spellings of one ordering
 * is the pair that drifts.
 */
export function strongerAttention(
  left: SidebarSectionAttention | undefined,
  right: SidebarSectionAttention | undefined,
): SidebarSectionAttention | undefined {
  if (left === "failure" || right === "failure") {
    return "failure";
  }
  if (left === "attention" || right === "attention") {
    return "attention";
  }
  return undefined;
}

/**
 * Fold one section's tree into what the column renders and decides from.
 *
 * Iterative rather than recursive, over an explicit stack. A rollup arrives from a
 * family's own projection and its depth is that projection's, not this module's, so a
 * recursive walk would put the column's render one malformed reply away from a stack
 * overflow — and a renderer that crashes on a shape the daemon sent is the failure
 * mode the whole fail-closed posture exists to avoid.
 */
export function foldSectionRollup(nodes: readonly SidebarRollupNode[]): SectionRollup {
  const countsByGroup = emptyCounts();
  let attention: SidebarSectionAttention | undefined;
  let nodeCount = 0;

  const pending: SidebarRollupNode[] = [...nodes];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) {
      continue;
    }
    nodeCount += 1;
    countsByGroup[node.group] += 1;
    attention = strongerAttention(attention, node.attention);
    if (node.children !== undefined) {
      pending.push(...node.children);
    }
  }

  return { attention, countsByGroup, nodeCount };
}

/** One row of the rollup, flattened out of the tree with its depth kept. */
export interface FlattenedRollupNode {
  readonly node: SidebarRollupNode;
  /** How deep under the section this node sits. A top-level node is `0`. */
  readonly depth: number;
  /**
   * The strongest level at or under this node.
   *
   * The child-to-parent carry, computed once here rather than by whoever renders the
   * row: a collapsed parent is the only thing on screen, and a parent drawn from its
   * own level alone would show calm over a failing child.
   */
  readonly rolledUpAttention: SidebarSectionAttention | undefined;
}

/**
 * The tree as rows, grouped pinned → needs-attention → running → rest.
 *
 * Grouping is applied at each LEVEL rather than flattening the tree and sorting the
 * result: the tree is the session › channel › run nesting a person reads down, and a
 * global sort would lift a run out from under its channel and put it beside one from
 * a different channel. So siblings are ordered by group and each keeps its children.
 *
 * Iterative for {@link foldSectionRollup}'s reason, and the rolled-up level is carried
 * DOWN the stack rather than recomputed per row: folding each node's subtree at the
 * point it is emitted would walk the same descendants once per ancestor, which is
 * quadratic in the depth of a tree whose depth this module does not choose.
 */
export function flattenSectionRollup(
  nodes: readonly SidebarRollupNode[],
): readonly FlattenedRollupNode[] {
  const rolledUpByNode = rollUpAttentionByNode(nodes);
  const rows: FlattenedRollupNode[] = [];
  // Pushed in REVERSE group order so the last push is the first pop: the stack is
  // what makes the walk iterative, and a stack reverses whatever it is given.
  const pending: FlattenedRollupNode[] = [...groupedLevel(nodes, 0, rolledUpByNode)].reverse();
  while (pending.length > 0) {
    const row = pending.pop();
    if (row === undefined) {
      continue;
    }
    rows.push(row);
    const children = groupedLevel(row.node.children ?? [], row.depth + 1, rolledUpByNode);
    // The children go on TOP of the stack, so this node's subtree is emitted before
    // its next sibling — the reading order a nested tree has on screen.
    for (let position = children.length - 1; position >= 0; position -= 1) {
      const child = children[position];
      if (child !== undefined) {
        pending.push(child);
      }
    }
  }
  return rows;
}

/**
 * One level's nodes as rows, in group order.
 *
 * A filter per group rather than a comparator, because the order IS the group tuple's
 * order and a comparator would encode it a second time as a rank table.
 */
function groupedLevel(
  nodes: readonly SidebarRollupNode[],
  depth: number,
  rolledUpByNode: ReadonlyMap<SidebarRollupNode, SidebarSectionAttention | undefined>,
): readonly FlattenedRollupNode[] {
  const rows: FlattenedRollupNode[] = [];
  for (const group of SIDEBAR_ROLLUP_GROUPS) {
    for (const node of nodes) {
      if (node.group === group) {
        rows.push({ node, depth, rolledUpAttention: rolledUpByNode.get(node) });
      }
    }
  }
  return rows;
}

/**
 * Every node's strongest level at or under itself, in one post-order pass.
 *
 * Keyed on the node OBJECT rather than on `nodeId`: ids are unique within a section by
 * contract, and a section that breaks that contract would otherwise have two nodes
 * share one answer — a wrong level drawn silently rather than a duplicate row shown
 * honestly. The identity key cannot collide however the section's ids are minted.
 */
function rollUpAttentionByNode(
  nodes: readonly SidebarRollupNode[],
): ReadonlyMap<SidebarRollupNode, SidebarSectionAttention | undefined> {
  const rolledUp = new Map<SidebarRollupNode, SidebarSectionAttention | undefined>();
  // Depth-first, emitting each node AFTER its children, so every child's answer is
  // already in the map when its parent asks for it.
  const postOrder: SidebarRollupNode[] = [];
  const pending: SidebarRollupNode[] = [...nodes];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) {
      continue;
    }
    postOrder.push(node);
    pending.push(...(node.children ?? []));
  }
  for (let position = postOrder.length - 1; position >= 0; position -= 1) {
    const node = postOrder[position];
    if (node === undefined) {
      continue;
    }
    let attention = node.attention;
    for (const child of node.children ?? []) {
      attention = strongerAttention(attention, rolledUp.get(child));
    }
    rolledUp.set(node, attention);
  }
  return rolledUp;
}

/** A zeroed count per group. Total over the closed set by construction. */
function emptyCounts(): Record<SidebarRollupGroup, number> {
  return { pinned: 0, "needs-attention": 0, running: 0, rest: 0 };
}
