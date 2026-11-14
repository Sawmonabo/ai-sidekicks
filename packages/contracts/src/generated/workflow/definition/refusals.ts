// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The refusal a save answers with when a document breaks a rule, and the arguments of the graph and connection checks.

import type {
  WorkflowInputHandleSpec,
  WorkflowNodeKindCategory,
  WorkflowOutputHandleSpec,
  WorkflowParamId,
} from "../kind.js";
import type {
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeId,
  WorkflowTriggerNode,
} from "./document.js";

/** A document the daemon's check at save refused; it carries every finding at once. */
export const WORKFLOW_DEFINITION_REFUSED_CODE = "workflow.definition.refused" as const;

/**
 * A named rule of a finding that marks only nodes, by which the parameter check names the
 * finding a refused value raises at save.
 */
export type WorkflowDefinitionRule =
  | "cycle"
  | "orphan"
  | "emptyDocument"
  | "nodeIdDuplicate"
  | "nodeMissing"
  | "triggerMissing"
  | "triggerDuplicate"
  | "nodeNameDuplicate"
  | "edgeIntoTrigger"
  | "edgeOutOfTerminal"
  | "edgeDuplicate"
  | "paramMissing"
  | "expressionUnknownNode"
  | "expressionRegexUnsupported"
  | "toolEdgeWithoutToolInput"
  | "handleTypeUnknown"
  | "handleTypeMismatch"
  | "inputConnectionsExceeded"
  | "nameTaken"
  | "repositoryRequired"
  | "unknownKey"
  | "secretOutsideSensitiveField"
  | "secretInExpression";
/**
 * One finding: the rule a refused document breaks, with the nodes it marks. The validation
 * strip lists every finding and the canvas marks each node.
 */
export type WorkflowDefinitionFinding =
  | {
      rule: "cycle";
      /**
       * The nodes the finding marks.
       */
      nodeIds: WorkflowNodeId[];
    }
  | {
      rule: "orphan";
      /**
       * The nodes the finding marks.
       */
      nodeIds: WorkflowNodeId[];
    }
  | {
      rule: "emptyDocument";
      /**
       * The nodes the finding marks.
       */
      nodeIds: WorkflowNodeId[];
    }
  | {
      rule: "nodeIdDuplicate";
      /**
       * The nodes the finding marks.
       */
      nodeIds: WorkflowNodeId[];
    }
  | {
      rule: "nodeMissing";
      /**
       * The nodes the finding marks.
       */
      nodeIds: WorkflowNodeId[];
    }
  | {
      rule: "triggerMissing";
      /**
       * The nodes the finding marks.
       */
      nodeIds: WorkflowNodeId[];
    }
  | {
      rule: "triggerDuplicate";
      /**
       * The nodes the finding marks.
       */
      nodeIds: WorkflowNodeId[];
    }
  | {
      rule: "nodeNameDuplicate";
      /**
       * The nodes the finding marks.
       */
      nodeIds: WorkflowNodeId[];
    }
  | {
      rule: "edgeIntoTrigger";
      /**
       * The nodes the finding marks.
       */
      nodeIds: WorkflowNodeId[];
    }
  | {
      rule: "edgeOutOfTerminal";
      /**
       * The nodes the finding marks.
       */
      nodeIds: WorkflowNodeId[];
    }
  | {
      rule: "edgeDuplicate";
      /**
       * The nodes the finding marks.
       */
      nodeIds: WorkflowNodeId[];
    }
  | {
      rule: "paramMissing";
      /**
       * The nodes the finding marks.
       */
      nodeIds: WorkflowNodeId[];
    }
  | {
      rule: "expressionUnknownNode";
      /**
       * The nodes the finding marks.
       */
      nodeIds: WorkflowNodeId[];
    }
  | {
      rule: "expressionRegexUnsupported";
      /**
       * The nodes the finding marks.
       */
      nodeIds: WorkflowNodeId[];
    }
  | {
      rule: "toolEdgeWithoutToolInput";
      /**
       * The nodes the finding marks.
       */
      nodeIds: WorkflowNodeId[];
    }
  | {
      rule: "handleTypeUnknown";
      /**
       * The nodes the finding marks.
       */
      nodeIds: WorkflowNodeId[];
    }
  | {
      rule: "handleTypeMismatch";
      /**
       * The nodes the finding marks.
       */
      nodeIds: WorkflowNodeId[];
    }
  | {
      rule: "inputConnectionsExceeded";
      /**
       * The nodes the finding marks.
       */
      nodeIds: WorkflowNodeId[];
    }
  | {
      rule: "nameTaken";
      /**
       * The nodes the finding marks.
       */
      nodeIds: WorkflowNodeId[];
    }
  | {
      rule: "repositoryRequired";
      /**
       * The nodes the finding marks.
       */
      nodeIds: WorkflowNodeId[];
    }
  | {
      rule: "unknownKey";
      /**
       * The nodes the finding marks.
       */
      nodeIds: WorkflowNodeId[];
    }
  | {
      rule: "secretOutsideSensitiveField";
      /**
       * The nodes the finding marks.
       */
      nodeIds: WorkflowNodeId[];
    }
  | {
      rule: "secretInExpression";
      /**
       * The nodes the finding marks.
       */
      nodeIds: WorkflowNodeId[];
    }
  | {
      rule: "codePackagesUnresolved";
      /**
       * The Code steps.
       *
       * @minItems 1
       */
      nodeIds: [WorkflowNodeId, ...WorkflowNodeId[]];
      /**
       * The package.
       */
      detail: string;
    }
  | {
      rule: "expressionUnparsable";
      /**
       * The nodes the finding marks.
       */
      nodeIds: WorkflowNodeId[];
      /**
       * Why the node's first such expression does not parse; for a reader called as a
       * method, the spellings that read a node, `$all('<label>')` among them.
       */
      detail: string;
    }
  | {
      rule: "expressionNotExpanded";
      /**
       * The command steps.
       */
      nodeIds: WorkflowNodeId[];
      /**
       * Why the first such fill of the step does not expand, naming the fill, and the
       * line for a here-document that does not end where bash ends it.
       */
      detail: string;
    };

/**
 * The details of `workflow.definition.refused`: the whole list of findings.
 */
export interface WorkflowDefinitionRefusedDetails {
  /**
   * Every finding, at least one.
   *
   * @minItems 1
   */
  findings: [WorkflowDefinitionFinding, ...WorkflowDefinitionFinding[]];
}
/**
 * What the graph check reads of a node's kind: its category, the handles the node has, whether
 * it needs a project's repository and which param holds a trigger's `Repository`. For a kind
 * whose outputs derive from its params, `outputs` is what this node's params give; a node that
 * routes failures to an error output lists that output too.
 */
export interface WorkflowNodeHandles {
  /**
   * The kind's category.
   */
  category: WorkflowNodeKindCategory;
  /**
   * The node's input handles.
   */
  inputs: WorkflowInputHandleSpec[];
  /**
   * The node's output handles.
   */
  outputs: WorkflowOutputHandleSpec[];
  /**
   * Whether a run of the kind needs the run to work in a project's repository.
   */
  needsRepository: boolean;
  /**
   * The id of the kind's `project` param, which on a trigger is its `Repository`; absent for a
   * kind that has none.
   */
  repositoryParam?: WorkflowParamId;
}
/**
 * The graph check's arguments as the builder sends them: the document's trigger, its other nodes
 * and edges, and each node's handles by node id, built from the kinds table.
 */
export interface WorkflowGraphCheckInput {
  /**
   * The trigger node, once placed.
   */
  trigger?: WorkflowTriggerNode;
  /**
   * The other nodes.
   */
  nodes: WorkflowNode[];
  /**
   * The edges.
   */
  edges: WorkflowEdge[];
  /**
   * Each node's handles by node id.
   */
  nodeHandles: {
    [k: string]: WorkflowNodeHandles | undefined;
  };
}
/**
 * The connection check's arguments as the builder sends them: the document's trigger, its other
 * nodes and edges, each node's handles, and the one connection being drawn.
 */
export interface WorkflowConnectionCheckInput {
  /**
   * The trigger node, once placed.
   */
  trigger?: WorkflowTriggerNode;
  /**
   * The other nodes.
   */
  nodes: WorkflowNode[];
  /**
   * The document's edges; on a reconnect, without the edge being moved.
   */
  edges: WorkflowEdge[];
  /**
   * The connection being drawn, with the id the page will store it under.
   */
  edge: WorkflowEdge;
  /**
   * Each node's handles by node id.
   */
  nodeHandles: {
    [k: string]: WorkflowNodeHandles | undefined;
  };
}

export {
  validateWorkflowDefinitionFinding,
  validateWorkflowDefinitionRefusedDetails,
} from "../../checks/workflow/definition/refusals.js";
