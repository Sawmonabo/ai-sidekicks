// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The reads over a definition's saved versions: one version, every version of the workflow a run's pinned version belongs to, and the difference between two versions, with the refusal a diff of two workflows answers with.

import type { AgentId } from "../../agent/definition.js";
import type { WireInstant } from "../../internal/wire-scalars.js";
import type {
  WorkflowContentHash,
  WorkflowDefinitionId,
  WorkflowDocument,
  WorkflowEdge,
  WorkflowNode,
  WorkflowTriggerNode,
  WorkflowVersionId,
} from "./document.js";

/**
 * Who saved a version: the person, or the agent that did.
 */
export type WorkflowVersionSavedBy =
  | {
      kind: "user";
      /**
       * Never present: the person is no agent.
       */
      agentId?: never;
    }
  | {
      kind: "agent";
      /**
       * The agent.
       */
      agentId: AgentId;
    };
/**
 * One node of a version difference, whole: the trigger travels with its inputs, every other node
 * as itself. A trigger with no inputs reads back as a plain node, losing nothing.
 */
export type WorkflowVersionNode = WorkflowNode | WorkflowTriggerNode;

/**
 * The `workflow.version.read` input: a version is addressed by its definition and number.
 */
export interface WorkflowVersionReadRequest {
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The version's number, counted from 1.
   */
  versionNumber: number;
}
/**
 * The `workflow.version.read` result: one saved version, which never changes. A soft-deleted
 * definition's versions still read, because a run pins its version.
 */
export interface WorkflowVersionReadResponse {
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The version's number.
   */
  versionNumber: number;
  /**
   * The version's id, the one a run start takes.
   */
  workflowVersionId: WorkflowVersionId;
  /**
   * The hash of its hashed body.
   */
  contentHash: WorkflowContentHash;
  /**
   * The document.
   */
  document: WorkflowDocument;
  /**
   * When it was saved.
   */
  createdAt: WireInstant;
}
/**
 * The `workflow.version.list` input, keyed by a version id alone. A run holds only its pinned
 * version id, and a run whose definition was deleted still opens, so this read works from that
 * one handle.
 */
export interface WorkflowVersionListRequest {
  /**
   * Any version of the workflow.
   */
  workflowVersionId: WorkflowVersionId;
}
/**
 * How many nodes and edges one version changed over another, counted over the hashed body only,
 * so a moved node never counts.
 */
export interface WorkflowVersionChangeCounts {
  /**
   * Nodes added.
   */
  nodesAdded: number;
  /**
   * Nodes removed.
   */
  nodesRemoved: number;
  /**
   * Nodes changed.
   */
  nodesChanged: number;
  /**
   * Edges added.
   */
  edgesAdded: number;
  /**
   * Edges removed.
   */
  edgesRemoved: number;
}
/**
 * One version in the list: the id a re-pin carries, the number a person reads, when it was saved
 * and by whom, and what it changed over the version before it.
 */
export interface WorkflowVersionListEntry {
  /**
   * The version's id.
   */
  workflowVersionId: WorkflowVersionId;
  /**
   * The version's number.
   */
  versionNumber: number;
  /**
   * The hash of its hashed body.
   */
  contentHash: WorkflowContentHash;
  /**
   * When it was saved.
   */
  createdAt: WireInstant;
  /**
   * Who saved it.
   */
  savedBy: WorkflowVersionSavedBy;
  /**
   * What it changed over the version before it; absent on the first version.
   */
  changesFromPrevious?: WorkflowVersionChangeCounts;
}
/**
 * The `workflow.version.list` result: every version of the pinned version's definition, oldest
 * first, never empty.
 */
export interface WorkflowVersionListResponse {
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * Its versions, oldest first.
   *
   * @minItems 1
   */
  versions: [WorkflowVersionListEntry, ...WorkflowVersionListEntry[]];
}
/**
 * The `workflow.version.diff.read` input: two versions of one workflow. Two versions of different
 * workflows are refused with `workflow.version.diffCrossWorkflow`, and nothing is compared.
 */
export interface WorkflowVersionDiffReadRequest {
  /**
   * The version compared from.
   */
  fromWorkflowVersionId: WorkflowVersionId;
  /**
   * The version compared to.
   */
  toWorkflowVersionId: WorkflowVersionId;
}
/**
 * One node a version changed, whole, before and after.
 */
export interface WorkflowVersionNodeChange {
  /**
   * The node in the version compared from.
   */
  before: WorkflowVersionNode;
  /**
   * The node in the version compared to.
   */
  after: WorkflowVersionNode;
}
/**
 * The `workflow.version.diff.read` result: the structural difference, computed in the daemon over
 * the hashed body only, so a moved node is never a change. The trigger counts as a node, and a
 * version that changed only the trigger's inputs names the trigger changed.
 */
export interface WorkflowVersionDiffReadResponse {
  /**
   * Nodes added.
   */
  nodesAdded: WorkflowVersionNode[];
  /**
   * Nodes removed.
   */
  nodesRemoved: WorkflowVersionNode[];
  /**
   * Nodes changed.
   */
  nodesChanged: WorkflowVersionNodeChange[];
  /**
   * Edges added.
   */
  edgesAdded: WorkflowEdge[];
  /**
   * Edges removed.
   */
  edgesRemoved: WorkflowEdge[];
}
/**
 * The details of `workflow.version.diffCrossWorkflow`: the two versions, of different
 * workflows, a diff named.
 */
export interface WorkflowVersionDiffCrossWorkflowDetails {
  /**
   * The version compared from.
   */
  fromWorkflowVersionId: WorkflowVersionId;
  /**
   * The version compared to.
   */
  toWorkflowVersionId: WorkflowVersionId;
}
