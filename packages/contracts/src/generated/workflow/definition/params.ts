// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The parameter check's arguments and the values it refuses.

import type { IssuePathSegment } from "../../jsonrpc/issue.js";
import type { WorkflowParamSpec } from "../kind.js";
import type { WorkflowDefinitionRule } from "./refusals.js";

/**
 * One parameter value the check refused. `path` is the value's place, its parameter's id first
 * (`["headers", 0, "token"]` inside a repeating collection, `["tool", "approvalMode"]` for a
 * member a tool binding does not take), `message` names the fault and never quotes the value, and
 * `rule` the finding the save raises for it, where one does.
 */
export interface WorkflowParamIssue {
  /**
   * The value's place, one step per member or index, so an id holding a dot stays one step.
   */
  path: IssuePathSegment[];
  /**
   * The fault.
   */
  message: string;
  /**
   * The finding the save raises for the value: `paramMissing`, `unknownKey`,
   * `secretOutsideSensitiveField` or `secretInExpression`; absent for a reference, a tool
   * binding or a collection that does not read as one.
   */
  rule?: WorkflowDefinitionRule;
}
/**
 * The parameter check's arguments as the builder sends them: one node's parameters and its
 * kind's parameter list.
 */
export interface WorkflowNodeParamsCheckInput {
  /**
   * The node's parameters by id.
   */
  params: {
    [k: string]: unknown | undefined;
  };
  /**
   * The kind's parameter list.
   */
  specs: WorkflowParamSpec[];
}
