// A node of the version a run pinned, found by its id: what names a step and says its kind on the
// run's page, the header, the step panel and the graph's panel alike.

import type {
  WorkflowDocument,
  WorkflowNode,
} from "@ai-sidekicks/contracts/workflow/definition/document";

/**
 * The node `nodeId` names in the run's pinned document, the trigger included; `undefined` until
 * the document is read, or where it names no such node.
 */
export function findDocumentNode(
  document: WorkflowDocument | undefined,
  nodeId: string,
): WorkflowNode | undefined {
  if (document === undefined) {
    return undefined;
  }
  return document.trigger.id === nodeId
    ? document.trigger
    : document.nodes.find((node) => node.id === nodeId);
}
