// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The items data travels in between nodes, and the failure an item, a step or a run carries.

import type { AgentDefinitionId } from "../../agent/definition.js";
import type { ArtifactId } from "../../artifacts/id.js";
import type { ProviderAccountId } from "../../provider/account/record.js";
import type { ProviderId } from "../../provider/id.js";
import type { WorkflowNodeId } from "./document.js";

/**
 * An item's lineage: the one input item it came from, or several.
 */
export type WorkflowPairedItems = WorkflowPairedItem | WorkflowPairedItem[];
/**
 * A step failure's own code, a wire name in the `workflow[.resource].condition` form, such as
 * `workflow.step.timedOut`.
 */
export type WorkflowStepErrorCode = string;
/**
 * Why a step's agent could not resolve: the resolution refusal's own details, its
 * `definitionId` `null` for a step running the General agent, which runs no definition.
 */
export type WorkflowStepAgentResolutionRefusedDetails =
  | {
      reason: "modelUnavailable";
      /**
       * The definition.
       */
      definitionId: AgentDefinitionId | null;
      /**
       * The provider.
       */
      providerName: ProviderId;
      /**
       * The model, or `null` for none bound.
       */
      modelId: string | null;
    }
  | {
      reason: "effortUnsupported";
      /**
       * The definition.
       */
      definitionId: AgentDefinitionId | null;
      /**
       * The stored effort.
       */
      effort: string;
      /**
       * The model's efforts.
       */
      effortLevels: string[];
    }
  | {
      reason: "accountUnavailable";
      /**
       * The definition.
       */
      definitionId: AgentDefinitionId | null;
      /**
       * The account.
       */
      providerAccountId: ProviderAccountId;
    }
  | {
      reason: "allowlistUnrealizable";
      /**
       * The definition.
       */
      definitionId: AgentDefinitionId | null;
      /**
       * The missing tools, at least one.
       *
       * @minItems 1
       */
      toolNames: [string, ...string[]];
      /**
       * The driver's tools.
       */
      supportedToolNames: string[];
    }
  | {
      reason: "providerUnsupported";
      /**
       * The definition.
       */
      definitionId: AgentDefinitionId | null;
      /**
       * The provider as the definition's file names it, which may be no provider id.
       */
      unsupportedProviderName: string;
    };
/**
 * A failure carried on one item, so one item can fail while the rest of a batch succeeds, on the
 * step it failed in, and on a run as why it failed or was canceled.
 */
export type WorkflowStepError =
  | WorkflowStepUncodedError
  | WorkflowStepCodedError
  | WorkflowStepAgentResolutionError;

/**
 * A binary value an item carries: a stored artifact by id, with the type, name and size a panel
 * draws. Bytes never travel inside a run record or a document.
 */
export interface WorkflowBinaryRef {
  /**
   * The artifact holding the bytes.
   */
  artifactId: ArtifactId;
  /**
   * The media type.
   */
  mimeType: string;
  /**
   * The file name.
   */
  fileName: string;
  /**
   * The size, in bytes.
   */
  size: number;
}
/**
 * One input item an output item came from, and on which input.
 */
export interface WorkflowPairedItem {
  /**
   * The input item's index.
   */
  item: number;
  /**
   * The input's index.
   */
  input?: number;
}
/**
 * A failure with no code of its own: the message alone.
 */
export interface WorkflowStepUncodedError {
  /**
   * What went wrong, in words.
   */
  message: string;
  /**
   * The node the failure belongs to.
   */
  nodeId?: WorkflowNodeId;
  /**
   * The zero-based index of the input item the step failed on, the `$itemIndex` an
   * expression reads. It names an item of the node's first main input.
   */
  itemIndex?: number;
  /**
   * Absent: this failure has no code.
   */
  code?: never;
  /**
   * Absent: details never come without a code.
   */
  details?: never;
}
/**
 * A failure carrying the step failure's own `workflow[.resource].condition` code, and that
 * code's details where it has any.
 */
export interface WorkflowStepCodedError {
  /**
   * What went wrong, in words.
   */
  message: string;
  /**
   * The node the failure belongs to.
   */
  nodeId?: WorkflowNodeId;
  /**
   * The zero-based index of the input item the step failed on, the `$itemIndex` an
   * expression reads. It names an item of the node's first main input.
   */
  itemIndex?: number;
  /**
   * The failure's code.
   */
  code: WorkflowStepErrorCode;
  /**
   * The code's details.
   */
  details?: {
    [k: string]: unknown | undefined;
  };
}
/**
 * A step whose agent could not resolve, such as a park on an account removed first.
 */
export interface WorkflowStepAgentResolutionError {
  /**
   * What went wrong, in words.
   */
  message: string;
  /**
   * The node the failure belongs to.
   */
  nodeId?: WorkflowNodeId;
  /**
   * The zero-based index of the input item the step failed on, the `$itemIndex` an
   * expression reads. It names an item of the node's first main input.
   */
  itemIndex?: number;
  /**
   * Always `agent.definition.resolutionRefused`.
   */
  code: "agent.definition.resolutionRefused";
  /**
   * Why the agent could not resolve.
   */
  details: WorkflowStepAgentResolutionRefusedDetails;
}
/**
 * One item: data between nodes is always a list of these.
 */
export interface WorkflowItem {
  /**
   * The item's data.
   */
  json: unknown;
  /**
   * The binary values the item carries, by name.
   */
  binary?: {
    [k: string]: WorkflowBinaryRef | undefined;
  };
  /**
   * The item's lineage, which lets an expression walk back across a branch and a merge.
   */
  pairedItem?: WorkflowPairedItems;
  /**
   * The item's failure.
   */
  error?: WorkflowStepError;
}
/**
 * An item pinned onto a node as test data. It carries no binary value, because a node whose
 * items carry one cannot be pinned.
 */
export interface WorkflowPinnedItem {
  /**
   * The item's data.
   */
  json: unknown;
  /**
   * The item's lineage, which lets an expression walk back across a branch and a merge.
   */
  pairedItem?: WorkflowPairedItems;
  /**
   * The item's failure.
   */
  error?: WorkflowStepError;
}

export {
  validateWorkflowBinaryRef,
  validateWorkflowItem,
  validateWorkflowPairedItem,
  validateWorkflowPairedItems,
  validateWorkflowPinnedItem,
  validateWorkflowStepAgentResolutionError,
  validateWorkflowStepAgentResolutionRefusedDetails,
  validateWorkflowStepCodedError,
  validateWorkflowStepError,
  validateWorkflowStepErrorCode,
  validateWorkflowStepUncodedError,
} from "../../checks/workflow/definition/item.js";
