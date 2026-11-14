// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The node catalog: every node kind the daemon runs, as `workflow.kind.list` serializes it.

import type { SchemaCheck } from "../../schema-check.js";
import { validateEmptyPayload } from "../checks/method-descriptor.js";
import { validateWorkflowKindListResponse } from "../checks/workflow/kind.js";
import type { EmptyPayload } from "../method-descriptor.js";
import type { WorkflowNodeKindId } from "./definition/document.js";

/** The name a person reads for each node kind the catalog ships, by the kind's key. */
export const WORKFLOW_NODE_KIND_NAMES = {
  "agent.askQuestion": "Ask a question",
  "agent.multiAgent": "Run a sidekick team",
  "agent.run": "Run a sidekick",
  "browser.act": "Act on a page",
  "browser.extract": "Extract from a page",
  "browser.open": "Open a page",
  "browser.screenshot": "Screenshot",
  "developer.callbackTool": "App tool",
  "developer.code": "Code",
  "developer.git": "Git",
  "developer.http": "HTTP request",
  "developer.mcpTool": "MCP tool",
  "developer.repoDiff": "Read a repo diff",
  "developer.runTests": "Run tests",
  "developer.shell": "Run a command",
  "files.ingestArtifacts": "Ingest as artifacts",
  "files.parse": "Parse",
  "files.read": "Read files",
  "files.template": "Render a template",
  "files.write": "Write files",
  "flow.executeWorkflow": "Execute workflow",
  "flow.if": "If",
  "flow.loopItems": "Loop over items",
  "flow.merge": "Merge",
  "flow.setVars": "Set variables",
  "flow.stopError": "Stop with error",
  "flow.switch": "Switch",
  "flow.wait": "Wait",
  "human.approval": "Ask for approval",
  "human.form": "Ask for a form",
  "human.waitForChatReply": "Wait for a chat reply",
  "output.notify": "Notify",
  "output.saveArtifact": "Save as artifact",
  "output.writeSummary": "Write a summary",
  "trigger.chat": "From chat",
  "trigger.error": "When a workflow fails",
  "trigger.fileWatch": "On a file change",
  "trigger.manual": "Run manually",
  "trigger.schedule": "On a schedule",
  "trigger.sessionEvent": "On a session event",
  "trigger.subWorkflow": "Called by a workflow",
  "trigger.webhook": "On a webhook",
} as const;

/**
 * The categories the palette groups kinds under.
 */
export type WorkflowNodeKindCategory =
  | "trigger"
  | "agent"
  | "human"
  | "files"
  | "browser"
  | "developer"
  | "flow"
  | "output";
/**
 * One input handle a kind declares. `maxConnections` absent means the handle takes any number
 * of edges.
 */
export type WorkflowInputHandleSpec =
  | {
      type: "main";
      /**
       * The handle's id.
       */
      id: string;
      /**
       * The handle's label.
       */
      label: string;
      /**
       * The most edges the handle takes; absent, any number.
       */
      maxConnections?: number;
      /**
       * Whether the handle must be connected.
       */
      required?: boolean;
    }
  | {
      type: "tool";
      /**
       * The handle's id.
       */
      id: string;
      /**
       * The handle's label.
       */
      label: string;
      /**
       * The most edges the handle takes; absent, any number.
       */
      maxConnections?: number;
      /**
       * Whether the handle must be connected.
       */
      required?: boolean;
    };
/**
 * One output handle a kind declares. `maxConnections` absent means the handle takes any
 * number of edges.
 */
export type WorkflowOutputHandleSpec =
  | {
      type: "main";
      /**
       * The handle's id.
       */
      id: string;
      /**
       * The handle's label.
       */
      label: string;
      /**
       * The most edges the handle takes; absent, any number.
       */
      maxConnections?: number;
      /**
       * Whether the handle must be connected.
       */
      required?: boolean;
    }
  | {
      type: "tool";
      /**
       * The handle's id.
       */
      id: string;
      /**
       * The handle's label.
       */
      label: string;
      /**
       * The most edges the handle takes; absent, any number.
       */
      maxConnections?: number;
      /**
       * Whether the handle must be connected.
       */
      required?: boolean;
    };
/**
 * The type of one leaf parameter, which picks the field the inspector draws.
 */
export type WorkflowParamType =
  | "string"
  | "text"
  | "number"
  | "boolean"
  | "select"
  | "multiselect"
  | "json"
  | "expression"
  | "path"
  | "glob"
  | "cron"
  | "secret"
  | "agent"
  | "mcpTool"
  | "callbackTool"
  | "session"
  | "project";
/**
 * A parameter's id, which a node's params are keyed by.
 */
export type WorkflowParamId = string;
/**
 * The type of a parameter that nests a field list.
 */
export type WorkflowCollectionParamType = "collection";
/**
 * One parameter a kind declares: a leaf of one type, or a collection that nests a field list.
 */
export type WorkflowParamSpec = WorkflowLeafParamSpec | WorkflowCollectionParamSpec;
/**
 * What running a kind can change: nothing, this machine, or something beyond it.
 */
export type WorkflowNodeSideEffects = "none" | "local" | "external";

/**
 * One choice a `select` or `multiselect` parameter offers.
 */
export interface WorkflowParamOption {
  /**
   * The value the parameter takes.
   */
  value: unknown;
  /**
   * The label a person reads.
   */
  label: string;
}
/**
 * A leaf parameter: one declared type. `showWhen` is the whole conditional form: the parameter is
 * drawn when each named sibling holds one of the listed values. `sensitive` marks the only
 * parameters a `secret://` reference resolves in.
 */
export interface WorkflowLeafParamSpec {
  /**
   * The parameter's id.
   */
  id: WorkflowParamId;
  /**
   * The label a person reads.
   */
  label: string;
  /**
   * The parameter's type.
   */
  type: WorkflowParamType;
  /**
   * Whether the parameter must be filled.
   */
  required?: boolean;
  /**
   * Whether a `secret://` reference resolves in the parameter.
   */
  sensitive?: boolean;
  /**
   * The value the parameter starts on.
   */
  default?: unknown;
  /**
   * The help line.
   */
  help?: string;
  /**
   * The choices.
   */
  options?: WorkflowParamOption[];
  /**
   * The sibling values the parameter is drawn under, by sibling id.
   */
  showWhen?: {
    [k: string]: unknown[] | undefined;
  };
}
/**
 * A parameter that nests a field list and may repeat.
 */
export interface WorkflowCollectionParamSpec {
  /**
   * The parameter's id.
   */
  id: WorkflowParamId;
  /**
   * The label a person reads.
   */
  label: string;
  /**
   * Always `collection`.
   */
  type: "collection";
  /**
   * The nested fields.
   */
  fields: WorkflowParamSpec[];
  /**
   * Whether the field list repeats.
   */
  multiple?: boolean;
}
/**
 * What a kind's run can do: be canceled, resume after a restart, what it can change, whether it
 * needs a project's repository, and when it runs in its provider's sandbox.
 */
export interface WorkflowNodeCapabilities {
  /**
   * Whether a run of the kind can be canceled.
   */
  cancelable: boolean;
  /**
   * Whether a run of the kind resumes after a restart.
   */
  resumable: boolean;
  /**
   * What a run of the kind can change.
   */
  sideEffects: WorkflowNodeSideEffects;
  /**
   * Whether a run of the kind needs the run to work in a project's repository.
   */
  repository: boolean;
  /**
   * When a run of the kind starts a process in its provider's sandbox: absent for never, an
   * empty record for always, otherwise when each named param's value is one of its listed
   * values, as a param's `showWhen` reads.
   */
  sandbox?: {
    [k: string]: unknown[] | undefined;
  };
}
/**
 * One kind as the catalog serializes it. `version` is the implementation a newly placed node
 * records; a placed node keeps the version it recorded. Each handle id appears once on its side,
 * since an edge names a handle by id alone.
 */
export interface WorkflowNodeKindSpec {
  /**
   * The kind's key.
   */
  kind: WorkflowNodeKindId;
  /**
   * The implementation a newly placed node records.
   */
  version: number;
  /**
   * The palette's group.
   */
  category: WorkflowNodeKindCategory;
  /**
   * The name a person reads.
   */
  displayName: string;
  /**
   * What the kind does.
   */
  description: string;
  /**
   * The kind's icon.
   */
  icon: string;
  /**
   * Other words the palette's search finds the kind by.
   */
  aliases?: string[];
  /**
   * The input handles, each id once.
   */
  inputs: WorkflowInputHandleSpec[];
  /**
   * The output handles, each id once.
   */
  outputs: WorkflowOutputHandleSpec[];
  /**
   * Whether the listed outputs are the base case of a set the node's params derive.
   */
  outputsDeriveFromParams: boolean;
  /**
   * The parameters.
   */
  params: WorkflowParamSpec[];
  /**
   * Whether the kind runs once per item rather than once over all of them.
   */
  perItem?: boolean;
  /**
   * What a run of the kind can do.
   */
  capabilities?: WorkflowNodeCapabilities;
}
/**
 * The `workflow.kind.list` result: every kind the daemon runs.
 */
export interface WorkflowKindListResponse {
  /**
   * The kinds.
   */
  kinds: WorkflowNodeKindSpec[];
}

export {
  validateWorkflowCollectionParamSpec,
  validateWorkflowInputHandleSpec,
  validateWorkflowKindListResponse,
  validateWorkflowLeafParamSpec,
  validateWorkflowNodeCapabilities,
  validateWorkflowNodeKindCategory,
  validateWorkflowNodeKindSpec,
  validateWorkflowNodeSideEffects,
  validateWorkflowOutputHandleSpec,
  validateWorkflowParamId,
  validateWorkflowParamOption,
  validateWorkflowParamSpec,
  validateWorkflowParamType,
} from "../checks/workflow/kind.js";

/** The methods of {@link WORKFLOW_KIND_METHOD_DESCRIPTORS}, each with its checks. */
export interface WorkflowKindMethodDescriptors {
  readonly "workflow.kind.list": {
    readonly method: "workflow.kind.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<WorkflowKindListResponse>;
  };
}
/** The node catalog's method table. */
export const WORKFLOW_KIND_METHOD_DESCRIPTORS: WorkflowKindMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "workflow.kind.list": /* @__PURE__ */ Object.freeze({
      method: "workflow.kind.list",
      procedureType: "query",
      mutating: false,
      requestCheck: validateEmptyPayload,
      responseCheck: validateWorkflowKindListResponse,
    }),
  });
