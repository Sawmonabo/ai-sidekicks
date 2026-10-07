// The refusal a save answers with when a document breaks a rule, and the check over the
// document's graph that the builder runs while a connection is dragged and the daemon runs
// again at save, so both refuse the same shapes.
import { z } from "zod";

import type { WorkflowNodeKindSpec } from "../kind.js";
import {
  WorkflowNodeIdSchema,
  type WorkflowDraftDocument,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeId,
  type WorkflowNodeKindId,
} from "./document.js";
import { parseWorkflowHandle, type WorkflowHandle, type WorkflowHandleMode } from "./handle.js";

/**
 * A document the daemon's check at save refused; it carries every finding at once.
 *
 * @consumedBy the handler that returns the `workflow.definition_refused` error
 */
export const WORKFLOW_DEFINITION_REFUSED_CODE = "workflow.definition_refused" as const;

/**
 * The rules a refused document can break. Each finding names one, with the nodes it
 * marks; the validation strip lists every finding and the canvas marks each node.
 */
export const WORKFLOW_DEFINITION_FINDING_RULES = [
  "cycle",
  "orphan",
  "empty_document",
  "trigger_missing",
  "trigger_duplicate",
  "edge_into_trigger",
  "edge_out_of_terminal",
  "param_missing",
  "expression_unparsable",
  "expression_unknown_node",
  "expression_regex_unsupported",
  "tool_edge_without_tool_input",
  "handle_type_unknown",
  "name_taken",
  "repository_required",
  "unknown_key",
  "secret_outside_sensitive_field",
  "code_packages_unresolved",
] as const;
/** One of {@link WORKFLOW_DEFINITION_FINDING_RULES}. */
export type WorkflowDefinitionFindingRule = (typeof WORKFLOW_DEFINITION_FINDING_RULES)[number];

/**
 * One finding. Only `code_packages_unresolved` carries `detail`, and always does: the package a
 * full-tier Code step names at two versions in two imports. A package that merely cannot be
 * locked is no finding; the save is kept.
 */
export type WorkflowDefinitionFinding =
  | {
      rule: Exclude<WorkflowDefinitionFindingRule, "code_packages_unresolved">;
      nodeIds: WorkflowNodeId[];
    }
  | {
      rule: "code_packages_unresolved";
      nodeIds: [WorkflowNodeId, ...WorkflowNodeId[]];
      detail: string;
    };
/** Wire schema for {@link WorkflowDefinitionFinding}. */
export const WorkflowDefinitionFindingSchema: z.ZodType<WorkflowDefinitionFinding> = z.union([
  z
    .object({
      rule: z.enum(WORKFLOW_DEFINITION_FINDING_RULES).exclude(["code_packages_unresolved"]),
      nodeIds: z.array(WorkflowNodeIdSchema),
    })
    .strict(),
  z
    .object({
      rule: z.literal("code_packages_unresolved"),
      nodeIds: z.tuple([WorkflowNodeIdSchema], WorkflowNodeIdSchema),
      detail: z.string().min(1),
    })
    .strict(),
]);

/** The details of {@link WORKFLOW_DEFINITION_REFUSED_CODE}: the whole list of findings. */
export interface WorkflowDefinitionRefusedDetails {
  findings: WorkflowDefinitionFinding[];
}
/**
 * Wire schema for {@link WorkflowDefinitionRefusedDetails}.
 *
 * @consumedBy the handler that returns the `workflow.definition_refused` error
 */
export const WorkflowDefinitionRefusedDetailsSchema: z.ZodType<WorkflowDefinitionRefusedDetails> = z
  .object({ findings: z.array(WorkflowDefinitionFindingSchema).min(1) })
  .strict();

// The graph check

/** The loop kind: an edge into its own input closes the loop body and is no cycle. */
const LOOP_KIND: WorkflowNodeKindId = "flow.loop-items";

/**
 * One node's category and the handles it has. For a kind whose outputs derive from its params,
 * `outputs` is what this node's params give; a node that routes failures to an error output
 * lists that output too.
 */
export type WorkflowNodeHandles = Pick<WorkflowNodeKindSpec, "category" | "inputs" | "outputs">;

/**
 * Answers a node's handles, or `undefined` for a kind the catalog does not list; that node's
 * handles and category then go unchecked, though its edges still count toward cycles and reach.
 */
export type WorkflowNodeHandlesResolver = (node: WorkflowNode) => WorkflowNodeHandles | undefined;

/**
 * The findings for the rules that need only the document and the kinds' handles: the trigger,
 * an empty document, each edge's ends, cycles, then orphans, each in document order. The rules
 * that need the library, the params, expressions or the code packages are checked elsewhere.
 * A node of a kind the catalog does not list has no known category, so it is never refused as a
 * trigger in the trigger's place nor as a second trigger among the nodes.
 */
export function checkWorkflowGraph(
  document: WorkflowDraftDocument,
  resolveNodeHandles: WorkflowNodeHandlesResolver,
): WorkflowDefinitionFinding[] {
  const { trigger } = document;
  const nodes = trigger === undefined ? document.nodes : [trigger, ...document.nodes];
  const graph: GraphFacts = {
    trigger,
    nodes,
    nodeById: new Map(nodes.map((node) => [node.id, node])),
    handlesById: new Map(nodes.map((node) => [node.id, resolveNodeHandles(node)])),
    edges: document.edges.map((edge) => ({
      edge,
      source: parseWorkflowHandle(edge.sourceHandle),
      target: parseWorkflowHandle(edge.targetHandle),
    })),
  };
  const findings: WorkflowDefinitionFinding[] = [];
  if (trigger === undefined) {
    findings.push({ rule: "trigger_missing", nodeIds: [] });
  } else if (isListedAsNonTrigger(graph, trigger.id)) {
    findings.push({ rule: "trigger_missing", nodeIds: [trigger.id] });
  }
  if (document.nodes.length === 0) {
    findings.push({ rule: "empty_document", nodeIds: [] });
  }
  const duplicateTriggerIds = document.nodes
    .filter((node) => graph.handlesById.get(node.id)?.category === "trigger")
    .map((node) => node.id);
  if (duplicateTriggerIds.length > 0) {
    findings.push({ rule: "trigger_duplicate", nodeIds: duplicateTriggerIds });
  }
  for (const parsedEdge of graph.edges) {
    for (const rule of edgeRules(graph, parsedEdge)) {
      findings.push({ rule, nodeIds: [parsedEdge.edge.source, parsedEdge.edge.target] });
    }
  }
  for (const cycleNodeIds of cycles(graph)) {
    findings.push({ rule: "cycle", nodeIds: cycleNodeIds });
  }
  // With no trigger every node would be an orphan; the missing trigger is the one finding.
  if (trigger !== undefined) {
    for (const nodeId of orphans(graph, trigger.id)) {
      findings.push({ rule: "orphan", nodeIds: [nodeId] });
    }
  }
  return findings;
}

// A node in the trigger's place whose kind the catalog lists under another category.
function isListedAsNonTrigger(graph: GraphFacts, nodeId: WorkflowNodeId): boolean {
  const category = graph.handlesById.get(nodeId)?.category;
  return category !== undefined && category !== "trigger";
}

type EdgeRule = Extract<
  WorkflowDefinitionFindingRule,
  | "edge_into_trigger"
  | "edge_out_of_terminal"
  | "tool_edge_without_tool_input"
  | "handle_type_unknown"
>;

interface ParsedEdge {
  edge: WorkflowEdge;
  source: WorkflowHandle;
  target: WorkflowHandle;
}

interface GraphFacts {
  trigger: WorkflowNode | undefined;
  nodes: WorkflowNode[];
  nodeById: ReadonlyMap<WorkflowNodeId, WorkflowNode>;
  handlesById: ReadonlyMap<WorkflowNodeId, WorkflowNodeHandles | undefined>;
  edges: ParsedEdge[];
}

// One rule at most for each end of the edge; a rule that names the end's problem outright
// stands in for the undeclared-handle finding it would also raise.
function edgeRules(graph: GraphFacts, { edge, source, target }: ParsedEdge): Set<EdgeRule> {
  const sourceHandles = graph.handlesById.get(edge.source);
  const targetHandles = graph.handlesById.get(edge.target);
  const rules = new Set<EdgeRule>();
  if (sourceHandles !== undefined && sourceHandles.outputs.length === 0) {
    rules.add("edge_out_of_terminal");
  } else if (!isDeclaredHandle(edge.sourceHandle, source, "outputs", sourceHandles)) {
    rules.add("handle_type_unknown");
  }
  if (edge.target === graph.trigger?.id) {
    rules.add("edge_into_trigger");
  } else if (
    target.isTypeKnown &&
    target.type === "tool" &&
    targetHandles !== undefined &&
    !targetHandles.inputs.some((spec) => spec.type === "tool")
  ) {
    rules.add("tool_edge_without_tool_input");
  } else if (!isDeclaredHandle(edge.targetHandle, target, "inputs", targetHandles)) {
    rules.add("handle_type_unknown");
  }
  return rules;
}

// A handle is declared when it names a known type on the right side and, where the node's kind
// is in the catalog, one of the handles that node has.
function isDeclaredHandle(
  handleId: string,
  handle: WorkflowHandle,
  mode: WorkflowHandleMode,
  handles: WorkflowNodeHandles | undefined,
): boolean {
  return (
    handle.isTypeKnown &&
    handle.mode === mode &&
    (handles === undefined || handles[mode].some((spec) => spec.id === handleId))
  );
}

function isMainEdge({ source, target }: ParsedEdge): boolean {
  return source.type === "main" && target.type === "main";
}

function isToolEdge({ source, target }: ParsedEdge): boolean {
  return source.type === "tool" && target.type === "tool";
}

/**
 * Every cycle among `main` edges as its nodes in document order, found as the strongly
 * connected components of more than one node or with a self-edge. An edge into a loop node's
 * input closes the loop body and is left out, unless it is the loop node's own self-edge.
 */
function cycles(graph: GraphFacts): WorkflowNodeId[][] {
  const successors = new Map<WorkflowNodeId, WorkflowNodeId[]>();
  const selfEdgeNodeIds = new Set<WorkflowNodeId>();
  for (const parsedEdge of graph.edges) {
    const { source, target } = parsedEdge.edge;
    const isLoopClosing = source !== target && graph.nodeById.get(target)?.kind === LOOP_KIND;
    if (!isMainEdge(parsedEdge) || isLoopClosing) {
      continue;
    }
    if (graph.nodeById.has(source) && graph.nodeById.has(target)) {
      appendTo(successors, source, target);
      if (source === target) {
        selfEdgeNodeIds.add(source);
      }
    }
  }
  const cycleByNodeId = new Map<WorkflowNodeId, WorkflowNodeId[]>();
  for (const component of stronglyConnectedComponents(
    graph.nodes.map((node) => node.id),
    successors,
  )) {
    if (component.length > 1 || component.some((nodeId) => selfEdgeNodeIds.has(nodeId))) {
      const members: WorkflowNodeId[] = [];
      for (const nodeId of component) {
        cycleByNodeId.set(nodeId, members);
      }
    }
  }
  // One walk in document order fills each cycle's members and lists the cycles by first member.
  const found: WorkflowNodeId[][] = [];
  for (const { id } of graph.nodes) {
    const members = cycleByNodeId.get(id);
    if (members !== undefined) {
      if (members.length === 0) {
        found.push(members);
      }
      members.push(id);
    }
  }
  return found;
}

// Tarjan's algorithm, walked with an explicit stack so a long chain cannot exhaust the call
// stack: each component is popped off the node stack once its root is finished.
function stronglyConnectedComponents(
  nodeIds: WorkflowNodeId[],
  successors: ReadonlyMap<WorkflowNodeId, WorkflowNodeId[]>,
): WorkflowNodeId[][] {
  const visits = new Map<WorkflowNodeId, { index: number; lowLink: number }>();
  const stack: WorkflowNodeId[] = [];
  const onStack = new Set<WorkflowNodeId>();
  const components: WorkflowNodeId[][] = [];
  const enter = (nodeId: WorkflowNodeId) => {
    const visit = { index: visits.size, lowLink: visits.size };
    visits.set(nodeId, visit);
    stack.push(nodeId);
    onStack.add(nodeId);
    return { nodeId, visit, next: successors.get(nodeId) ?? [], nextIndex: 0 };
  };
  for (const rootId of nodeIds) {
    if (visits.has(rootId)) {
      continue;
    }
    const frames = [enter(rootId)];
    for (let frame = frames.at(-1); frame !== undefined; frame = frames.at(-1)) {
      const nextId = frame.next[frame.nextIndex];
      if (nextId !== undefined) {
        frame.nextIndex += 1;
        const seen = visits.get(nextId);
        if (seen === undefined) {
          frames.push(enter(nextId));
        } else if (onStack.has(nextId)) {
          frame.visit.lowLink = Math.min(frame.visit.lowLink, seen.index);
        }
        continue;
      }
      frames.pop();
      const parent = frames.at(-1);
      if (parent !== undefined) {
        parent.visit.lowLink = Math.min(parent.visit.lowLink, frame.visit.lowLink);
      }
      if (frame.visit.lowLink === frame.visit.index) {
        const component: WorkflowNodeId[] = [];
        for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
          onStack.delete(member);
          component.push(member);
          if (member === frame.nodeId) {
            break;
          }
        }
        components.push(component);
      }
    }
  }
  return components;
}

/**
 * The nodes the trigger does not reach, in document order. A node is reached along a `main`
 * edge from a reached node, or as the tool of a reached node it is wired into by a `tool` edge,
 * because a tool node has no `main` path and runs only when the agent it serves calls it.
 */
function orphans(graph: GraphFacts, triggerId: WorkflowNodeId): WorkflowNodeId[] {
  const nextById = new Map<WorkflowNodeId, WorkflowNodeId[]>();
  for (const parsedEdge of graph.edges) {
    const { source, target } = parsedEdge.edge;
    if (isMainEdge(parsedEdge)) {
      appendTo(nextById, source, target);
    } else if (isToolEdge(parsedEdge)) {
      appendTo(nextById, target, source);
    }
  }
  const reached = new Set<WorkflowNodeId>([triggerId]);
  const pending: WorkflowNodeId[] = [triggerId];
  for (let nodeId = pending.pop(); nodeId !== undefined; nodeId = pending.pop()) {
    for (const next of nextById.get(nodeId) ?? []) {
      if (!reached.has(next)) {
        reached.add(next);
        pending.push(next);
      }
    }
  }
  return graph.nodes.map((node) => node.id).filter((nodeId) => !reached.has(nodeId));
}

function appendTo(
  lists: Map<WorkflowNodeId, WorkflowNodeId[]>,
  key: WorkflowNodeId,
  value: WorkflowNodeId,
): void {
  const list = lists.get(key);
  if (list === undefined) {
    lists.set(key, [value]);
  } else {
    list.push(value);
  }
}
