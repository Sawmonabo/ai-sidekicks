// The structural difference between two saved versions, over the hashed body alone: a node is
// matched by its id and an edge by its id, so a moved node or a changed tag is never a change.
import { isDeepStrictEqual } from "node:util";

import type {
  WorkflowDocumentHashedBody,
  WorkflowEdge,
  WorkflowNode,
} from "@ai-sidekicks/contracts/workflow/definition/document";
import type {
  WorkflowVersionChangeCounts,
  WorkflowVersionDiffReadResponse,
} from "@ai-sidekicks/contracts/workflow/definition/methods";

/**
 * The nodes added, removed and changed, the trigger counted as a node, and the edges added and
 * removed between two bodies. An edge whose id stays while its ends move is one removed and one
 * added, since an edge has nothing to change but its ends.
 */
export function diffWorkflowBodies(
  before: WorkflowDocumentHashedBody,
  after: WorkflowDocumentHashedBody,
): WorkflowVersionDiffReadResponse {
  const beforeNodes = [before.trigger, ...before.nodes];
  const afterNodes = [after.trigger, ...after.nodes];
  const beforeNodeById = new Map<string, WorkflowNode>(beforeNodes.map((node) => [node.id, node]));
  const afterNodeIds = new Set(afterNodes.map((node) => node.id));
  const nodesAdded: WorkflowNode[] = [];
  const nodesChanged: { before: WorkflowNode; after: WorkflowNode }[] = [];
  for (const afterNode of afterNodes) {
    const beforeNode = beforeNodeById.get(afterNode.id);
    if (beforeNode === undefined) {
      nodesAdded.push(afterNode);
    } else if (!isDeepStrictEqual(beforeNode, afterNode)) {
      nodesChanged.push({ before: beforeNode, after: afterNode });
    }
  }
  return {
    nodesAdded,
    nodesRemoved: beforeNodes.filter((node) => !afterNodeIds.has(node.id)),
    nodesChanged,
    edgesAdded: edgesMissingFrom(after.edges, before.edges),
    edgesRemoved: edgesMissingFrom(before.edges, after.edges),
  };
}

/** How many nodes and edges a difference names, which a version chain entry carries. */
export function countWorkflowChanges(
  difference: WorkflowVersionDiffReadResponse,
): WorkflowVersionChangeCounts {
  return {
    nodesAdded: difference.nodesAdded.length,
    nodesRemoved: difference.nodesRemoved.length,
    nodesChanged: difference.nodesChanged.length,
    edgesAdded: difference.edgesAdded.length,
    edgesRemoved: difference.edgesRemoved.length,
  };
}

// The edges of `edges` that `others` holds no identical edge of the same id for.
function edgesMissingFrom(
  edges: readonly WorkflowEdge[],
  others: readonly WorkflowEdge[],
): WorkflowEdge[] {
  const otherById = new Map(others.map((edge) => [edge.id, edge]));
  return edges.filter((edge) => !isDeepStrictEqual(otherById.get(edge.id), edge));
}
