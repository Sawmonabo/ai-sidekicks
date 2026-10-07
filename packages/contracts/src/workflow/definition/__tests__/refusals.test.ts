// The builder refuses a connection with this check and the daemon refuses a save with it, so a
// shape one lets through and the other refuses would lose a person's draft or store a graph the
// engine cannot run. Each rule has a minimal document it refuses beside the accepted one.
import { describe, expect, it } from "vitest";

import type {
  WorkflowDraftDocument,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeId,
} from "../document.js";
import type { WorkflowHandleSpec } from "../../kind.js";
import {
  checkWorkflowGraph,
  type WorkflowDefinitionFinding,
  type WorkflowNodeHandles,
} from "../refusals.js";

const mainInput: WorkflowHandleSpec<"inputs"> = { id: "inputs/main/0", label: "In", type: "main" };
const toolInput: WorkflowHandleSpec<"inputs"> = {
  id: "inputs/tool/0",
  label: "Tools",
  type: "tool",
};
const mainOutput = (index: number): WorkflowHandleSpec<"outputs"> => ({
  id: `outputs/main/${index}`,
  label: `Out ${index}`,
  type: "main",
});
const toolOutput: WorkflowHandleSpec<"outputs"> = {
  id: "outputs/tool/0",
  label: "Tool",
  type: "tool",
};

// The catalog the resolver reads. A Switch has one output per rule, so its outputs come from the
// node's params, as the caller that holds the kinds' code computes them.
const CATALOG: Record<string, (node: WorkflowNode) => WorkflowNodeHandles> = {
  "trigger.manual": () => ({ category: "trigger", inputs: [], outputs: [mainOutput(0)] }),
  "files.read": () => ({ category: "files", inputs: [mainInput], outputs: [mainOutput(0)] }),
  "agent.run": () => ({
    category: "agent",
    inputs: [mainInput, toolInput],
    outputs: [mainOutput(0), toolOutput],
  }),
  "developer.mcp-tool": () => ({ category: "developer", inputs: [], outputs: [toolOutput] }),
  "output.stop": () => ({ category: "output", inputs: [mainInput], outputs: [] }),
  "flow.loop-items": () => ({
    category: "flow",
    inputs: [mainInput],
    outputs: [mainOutput(0), mainOutput(1)],
  }),
  "flow.switch": (node) => ({
    category: "flow",
    inputs: [mainInput],
    outputs: Array.from({ length: node.params["rules"] as number }, (_, index) =>
      mainOutput(index),
    ),
  }),
};

function resolveNodeHandles(node: WorkflowNode): WorkflowNodeHandles | undefined {
  return CATALOG[node.kind]?.(node);
}

function node(id: string, kind: string, params: Record<string, unknown> = {}): WorkflowNode {
  return { id: id as WorkflowNodeId, kind, kindVersion: 1, name: id, order: 0, params };
}

function edge(
  source: string,
  target: string,
  sourceHandle = "outputs/main/0",
  targetHandle = "inputs/main/0",
): WorkflowEdge {
  return {
    id: `${source}->${target}`,
    source: source as WorkflowNodeId,
    sourceHandle,
    target: target as WorkflowNodeId,
    targetHandle,
  };
}

const TRIGGER = node("start", "trigger.manual");
const READ = node("read", "files.read");
const AGENT = node("agent", "agent.run");
const TOOL = node("tool", "developer.mcp-tool");
const STOP = node("stop", "output.stop");

// Start, read, ask the agent with one tool wired in, stop. The tool node has no main path: it is
// reached as the agent's tool.
const BASE_NODES = [READ, AGENT, TOOL, STOP];
const BASE_EDGES = [
  edge("start", "read"),
  edge("read", "agent"),
  edge("tool", "agent", "outputs/tool/0", "inputs/tool/0"),
  edge("agent", "stop"),
];

function documentOf(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowDraftDocument {
  return { schemaVersion: "2", name: "Check", trigger: TRIGGER, nodes, edges };
}

function finding(
  rule: Exclude<WorkflowDefinitionFinding["rule"], "code_packages_unresolved">,
  ...nodeIds: string[]
): WorkflowDefinitionFinding {
  return { rule, nodeIds: nodeIds as WorkflowNodeId[] };
}

const EXTRA = node("extra", "files.read");
const LOOP = node("loop", "flow.loop-items");
const BODY = node("body", "files.read");

describe("checkWorkflowGraph", () => {
  it("accepts the base document, with a tool node reached only as an agent's tool", () => {
    expect(checkWorkflowGraph(documentOf(BASE_NODES, BASE_EDGES), resolveNodeHandles)).toEqual([]);
  });

  it.each<[string, WorkflowDraftDocument, WorkflowDefinitionFinding[]]>([
    [
      "a draft with no trigger, and no orphan beside it",
      { ...documentOf([READ], []), trigger: undefined },
      [finding("trigger_missing")],
    ],
    ["a trigger with no other node", documentOf([], []), [finding("empty_document")]],
    [
      "a second trigger among the nodes",
      documentOf([...BASE_NODES, node("again", "trigger.manual")], BASE_EDGES),
      [finding("trigger_duplicate", "again"), finding("orphan", "again")],
    ],
    [
      "an edge into the trigger",
      documentOf(BASE_NODES, [...BASE_EDGES, edge("read", "start")]),
      [finding("edge_into_trigger", "read", "start"), finding("cycle", "start", "read")],
    ],
    [
      "an edge out of a terminal kind",
      documentOf([...BASE_NODES, EXTRA], [...BASE_EDGES, edge("stop", "extra")]),
      [finding("edge_out_of_terminal", "stop", "extra")],
    ],
    [
      "a tool edge into a node with no tool input",
      documentOf(BASE_NODES, [
        edge("start", "read"),
        edge("read", "agent"),
        edge("tool", "read", "outputs/tool/0", "inputs/tool/0"),
        edge("agent", "stop"),
      ]),
      [finding("tool_edge_without_tool_input", "tool", "read")],
    ],
    [
      "a handle naming a type other than main or tool",
      documentOf(BASE_NODES, [...BASE_EDGES, edge("read", "stop", "outputs/error/0")]),
      [finding("handle_type_unknown", "read", "stop")],
    ],
    [
      "a handle the node's kind does not declare",
      documentOf(BASE_NODES, [...BASE_EDGES, edge("read", "stop", "outputs/main/3")]),
      [finding("handle_type_unknown", "read", "stop")],
    ],
    [
      "a target handle on the output side",
      documentOf(BASE_NODES, [
        ...BASE_EDGES,
        edge("read", "stop", "outputs/main/0", "outputs/main/0"),
      ]),
      [finding("handle_type_unknown", "read", "stop")],
    ],
    [
      "a cycle among main edges",
      documentOf(BASE_NODES, [...BASE_EDGES, edge("agent", "read")]),
      [finding("cycle", "read", "agent")],
    ],
    [
      "a self-edge",
      documentOf(BASE_NODES, [...BASE_EDGES, edge("read", "read")]),
      [finding("cycle", "read")],
    ],
    [
      "a self-edge on a loop node",
      documentOf([LOOP], [edge("start", "loop"), edge("loop", "loop")]),
      [finding("cycle", "loop")],
    ],
    [
      "a cycle beside a loop that does not pass through the loop's input",
      documentOf(
        [LOOP, BODY, EXTRA],
        [
          edge("start", "loop"),
          edge("loop", "body", "outputs/main/1"),
          edge("body", "loop"),
          edge("loop", "extra"),
          edge("extra", "body"),
          edge("body", "extra"),
        ],
      ),
      [finding("cycle", "body", "extra")],
    ],
    [
      "a node the trigger does not reach",
      documentOf([...BASE_NODES, EXTRA], BASE_EDGES),
      [finding("orphan", "extra")],
    ],
  ])("refuses %s", (_name, document, expected) => {
    expect(checkWorkflowGraph(document, resolveNodeHandles)).toEqual(expected);
  });

  it("accepts the edge that closes a loop body into the loop node's input", () => {
    const document = documentOf(
      [LOOP, BODY, STOP],
      [
        edge("start", "loop"),
        edge("loop", "body", "outputs/main/1"),
        edge("body", "loop"),
        edge("loop", "stop"),
      ],
    );
    expect(checkWorkflowGraph(document, resolveNodeHandles)).toEqual([]);
  });

  it("checks an edge against the outputs a node's params give", () => {
    const threeWays = documentOf(
      [node("route", "flow.switch", { rules: 3 }), STOP],
      [edge("start", "route"), edge("route", "stop", "outputs/main/2")],
    );
    const twoWays = documentOf(
      [node("route", "flow.switch", { rules: 2 }), STOP],
      [edge("start", "route"), edge("route", "stop", "outputs/main/2")],
    );
    expect(checkWorkflowGraph(threeWays, resolveNodeHandles)).toEqual([]);
    expect(checkWorkflowGraph(twoWays, resolveNodeHandles)).toEqual([
      finding("handle_type_unknown", "route", "stop"),
    ]);
  });

  it("checks no handle on a kind the catalog does not list", () => {
    const document = documentOf(
      [node("vendor", "vendor.unknown")],
      [edge("start", "vendor", "outputs/main/0", "inputs/main/7")],
    );
    expect(checkWorkflowGraph(document, resolveNodeHandles)).toEqual([]);
  });
});
