// The workflow checks on the page: `crates/sidekicks-contracts`' graph, connection and parameter
// checks and the condition a param's `showWhen` and a kind's sandbox are read by, compiled to
// WebAssembly and instantiated once from a module compiled elsewhere and handed over, since the
// page that runs them may compile nothing itself. The daemon runs the same Rust on a save, so the
// builder refuses what the save would. Arguments cross as one JSON text and findings come back as
// one, each node's handles carried in the arguments as data. A trap leaves the instance's memory in
// no known state, so a new instance is started from the kept module before the trap is thrown on.

import type {
  WorkflowConnectionCheckInput,
  WorkflowDefinitionFinding,
  WorkflowGraphCheckInput,
} from "../../generated/workflow/definition/refusals.js";
import type {
  WorkflowConditionCheckInput,
  WorkflowNodeParamsCheckInput,
  WorkflowParamIssue,
} from "../../generated/workflow/definition/params.js";
// The glue `wasm-bindgen` writes beside the module in `dist/`, the same file from `src/` and `dist/`.
import * as workflowCheckModule from "../../../dist/workflow-check.js";

const listeners = new Set<() => void>();
let isProvided = false;

/**
 * Instantiates `module`, the compiled `workflow-check.wasm`, and tells every subscriber; a module
 * in hand is kept over a later one. Throws when the module does not start, leaving the checks
 * waiting for another.
 */
export function provideWorkflowCheckModule(module: WebAssembly.Module): void {
  if (isProvided) {
    return;
  }
  workflowCheckModule.initSync({ module });
  isProvided = true;
  for (const listener of [...listeners]) {
    listener();
  }
}

/** Whether the checks hold their module, so they answer. */
export function isWorkflowCheckModuleProvided(): boolean {
  return isProvided;
}

/** Calls `listener` once the module arrives; the returned function stops it. */
export function subscribeToWorkflowCheckModule(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The graph check's findings for a document, empty when its graph is accepted. Throws before the
 * module arrives, and when the module traps, after starting it again for the next call.
 */
export function checkWorkflowDefinitionGraph(
  input: WorkflowGraphCheckInput,
): WorkflowDefinitionFinding[] {
  return JSON.parse(
    callModule(() => workflowCheckModule.check_workflow_graph_json(JSON.stringify(input))),
  ) as WorkflowDefinitionFinding[];
}

/**
 * The findings one connection adds to a document, empty when it is accepted. Throws as
 * `checkWorkflowDefinitionGraph` does.
 *
 * @consumedBy the workflow builder's canvas, checking a connection while it is dragged
 */
export function checkWorkflowConnection(
  input: WorkflowConnectionCheckInput,
): WorkflowDefinitionFinding[] {
  return JSON.parse(
    callModule(() => workflowCheckModule.check_workflow_connection_json(JSON.stringify(input))),
  ) as WorkflowDefinitionFinding[];
}

/**
 * Each parameter value a node's kind refuses, empty when every value is accepted. Throws as
 * `checkWorkflowDefinitionGraph` does.
 */
export function checkWorkflowNodeParams(input: WorkflowNodeParamsCheckInput): WorkflowParamIssue[] {
  return JSON.parse(
    callModule(() => workflowCheckModule.check_workflow_node_params_json(JSON.stringify(input))),
  ) as WorkflowParamIssue[];
}

/**
 * Whether each param the condition names holds one of its listed values, a param's default
 * standing in for a value left out. Throws as `checkWorkflowDefinitionGraph` does.
 */
export function isWorkflowConditionMet(input: WorkflowConditionCheckInput): boolean {
  return callModule(() =>
    workflowCheckModule.is_workflow_condition_met_json(JSON.stringify(input)),
  );
}

/**
 * `call` on the running instance. Throws before the module arrives; on a trap, starts a new
 * instance from the kept module, synchronously, and throws the trap on.
 */
function callModule<Result>(call: () => Result): Result {
  if (!isProvided) {
    throw new Error("The workflow checks' module has not arrived");
  }
  try {
    return call();
  } catch (error: unknown) {
    if (error instanceof WebAssembly.RuntimeError) {
      workflowCheckModule.__wbg_reset_state();
    }
    throw error;
  }
}
