// The loader proves it runs the built module: a graph the Rust check refuses is refused through it,
// and a trap starts a new instance, so the next call answers. The rules' cases are the crate's.
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import * as workflowCheckModule from "../../../../dist/workflow-check.js";
import type {
  WorkflowNode,
  WorkflowNodeId,
} from "../../../generated/workflow/definition/document.js";
import type { WorkflowNodeHandles } from "../../../generated/workflow/definition/refusals.js";
import {
  checkWorkflowDefinitionGraph,
  checkWorkflowNodeParams,
  provideWorkflowCheckModule,
} from "../check.js";

const compiledModule = new WebAssembly.Module(
  readFileSync(new URL("../../../../dist/workflow-check.wasm", import.meta.url)),
);
provideWorkflowCheckModule(compiledModule);

function node(id: string, kind: string): WorkflowNode {
  return { id: id as WorkflowNodeId, kind, kindVersion: 1, name: id, order: 0, params: {} };
}

const AGENT_HANDLES: WorkflowNodeHandles = {
  category: "agent",
  inputs: [{ type: "main", id: "inputs/main/0", label: "In" }],
  outputs: [{ type: "main", id: "outputs/main/0", label: "Out" }],
  needsRepository: false,
};

it("refuses an unreached node through the built module", () => {
  const trigger = node("t", "trigger.manual");
  const reached = node("a", "agent.run");
  const unreached = node("b", "agent.run");
  const findings = checkWorkflowDefinitionGraph({
    trigger,
    nodes: [reached, unreached],
    edges: [
      {
        id: "t-a",
        source: trigger.id,
        sourceHandle: "outputs/main/0",
        target: reached.id,
        targetHandle: "inputs/main/0",
      },
    ],
    nodeHandles: {
      t: { ...AGENT_HANDLES, category: "trigger", inputs: [] },
      a: AGENT_HANDLES,
      b: AGENT_HANDLES,
    },
  });

  expect(findings).toEqual([{ rule: "orphan", nodeIds: ["b"] }]);
});

it("starts a new instance after a trap, so the next call answers", () => {
  const input = {
    params: { prompt: "secret://shared/mail" },
    specs: [{ id: "prompt", label: "Prompt", type: "text" as const }],
  };
  // The instance the loader runs; its memory overwritten, the next call reads garbage and traps.
  const instance = workflowCheckModule.initSync({ module: compiledModule });
  new Uint8Array(instance.memory.buffer).fill(0xff);

  expect(() => checkWorkflowNodeParams(input)).toThrow(WebAssembly.RuntimeError);
  expect(checkWorkflowNodeParams(input)).toEqual([
    {
      path: ["prompt"],
      message: "A secret:// reference stands only in a parameter its kind marks sensitive.",
      rule: "secretOutsideSensitiveField",
    },
  ]);
});
