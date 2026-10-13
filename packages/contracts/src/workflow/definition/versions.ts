// The `workflow.*` reads over a definition's saved versions: one version, the chain a run's
// pinned version belongs to, and the difference between two versions. The method table that
// declares them is in `workflow/definition/methods.ts`.
import { z } from "zod";

import { AgentIdSchema, type AgentId } from "../../agent/definition.js";
import { countSchema, isoDateTimeSchema } from "../../internal/wire-scalars.js";
import {
  WorkflowContentHashSchema,
  WorkflowDefinitionIdSchema,
  WorkflowDocumentSchema,
  WorkflowEdgeSchema,
  WorkflowNodeSchema,
  WorkflowVersionIdSchema,
  type WorkflowDefinitionId,
  type WorkflowDocument,
  type WorkflowEdge,
  type WorkflowNode,
} from "./document.js";

// workflow.versionRead and workflow.versionChainRead

/** The `workflow.versionRead` input: a version is addressed by its definition and number. */
export interface WorkflowVersionReadRequest {
  definitionId: WorkflowDefinitionId;
  versionNumber: number;
}
/** Wire schema for {@link WorkflowVersionReadRequest}. */
export const WorkflowVersionReadRequestSchema: z.ZodType<
  WorkflowVersionReadRequest,
  WorkflowVersionReadRequest
> = z
  .object({
    definitionId: WorkflowDefinitionIdSchema,
    versionNumber: z.number().int().positive(),
  })
  .strict();

/**
 * The `workflow.versionRead` result: one saved version, which never changes. A soft-
 * deleted definition's versions still read, because a run pins its version.
 */
export interface WorkflowVersionReadResponse {
  definitionId: WorkflowDefinitionId;
  versionNumber: number;
  workflowVersionId: string;
  contentHash: string;
  document: WorkflowDocument;
  createdAt: string;
}
/** Wire schema for {@link WorkflowVersionReadResponse}. */
export const WorkflowVersionReadResponseSchema: z.ZodType<WorkflowVersionReadResponse> = z
  .object({
    definitionId: WorkflowDefinitionIdSchema,
    versionNumber: z.number().int().positive(),
    workflowVersionId: WorkflowVersionIdSchema,
    contentHash: WorkflowContentHashSchema,
    document: WorkflowDocumentSchema,
    createdAt: isoDateTimeSchema,
  })
  .strict();

/**
 * The `workflow.versionChainRead` input, keyed by a version id alone. A run holds only
 * its pinned version id, and a run whose definition was deleted still opens, so this
 * read works from that one handle.
 */
export interface WorkflowVersionChainReadRequest {
  workflowVersionId: string;
}
/** Wire schema for {@link WorkflowVersionChainReadRequest}. */
export const WorkflowVersionChainReadRequestSchema: z.ZodType<
  WorkflowVersionChainReadRequest,
  WorkflowVersionChainReadRequest
> = z.object({ workflowVersionId: WorkflowVersionIdSchema }).strict();

/** Who saved a version: the person, or the agent that did. */
export type WorkflowVersionSavedBy = { kind: "user" } | { kind: "agent"; agentId: AgentId };
const WorkflowVersionSavedBySchema: z.ZodType<WorkflowVersionSavedBy> = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("user") }).strict(),
    z.object({ kind: z.literal("agent"), agentId: AgentIdSchema }).strict(),
  ],
);

/**
 * How many nodes and edges one version changed over another, counted over the hashed
 * body only, so a moved node never counts.
 */
export interface WorkflowVersionChangeCounts {
  nodesAdded: number;
  nodesRemoved: number;
  nodesChanged: number;
  edgesAdded: number;
  edgesRemoved: number;
}
const WorkflowVersionChangeCountsSchema: z.ZodType<WorkflowVersionChangeCounts> = z
  .object({
    nodesAdded: countSchema,
    nodesRemoved: countSchema,
    nodesChanged: countSchema,
    edgesAdded: countSchema,
    edgesRemoved: countSchema,
  })
  .strict();

/**
 * One version in a chain: the id a re-pin carries, the number a person reads, when it
 * was saved and by whom, and what it changed over the version before it (absent on the
 * first version).
 */
export interface WorkflowVersionChainEntry {
  workflowVersionId: string;
  versionNumber: number;
  contentHash: string;
  createdAt: string;
  savedBy: WorkflowVersionSavedBy;
  changesFromPrevious?: WorkflowVersionChangeCounts | undefined;
}
/** Wire schema for {@link WorkflowVersionChainEntry}. */
export const WorkflowVersionChainEntrySchema: z.ZodType<WorkflowVersionChainEntry> = z
  .object({
    workflowVersionId: WorkflowVersionIdSchema,
    versionNumber: z.number().int().positive(),
    contentHash: WorkflowContentHashSchema,
    createdAt: isoDateTimeSchema,
    savedBy: WorkflowVersionSavedBySchema,
    changesFromPrevious: WorkflowVersionChangeCountsSchema.optional(),
  })
  .strict();

/**
 * The `workflow.versionChainRead` result: every version of the pinned version's
 * definition, oldest first.
 */
export interface WorkflowVersionChainReadResponse {
  definitionId: WorkflowDefinitionId;
  versions: WorkflowVersionChainEntry[];
}
/** Wire schema for {@link WorkflowVersionChainReadResponse}. */
export const WorkflowVersionChainReadResponseSchema: z.ZodType<WorkflowVersionChainReadResponse> = z
  .object({
    definitionId: WorkflowDefinitionIdSchema,
    versions: z.array(WorkflowVersionChainEntrySchema).min(1),
  })
  .strict();

// workflow.versionDiffRead

/** The `workflow.versionDiffRead` input: two versions of one workflow. */
export interface WorkflowVersionDiffReadRequest {
  fromWorkflowVersionId: string;
  toWorkflowVersionId: string;
}
/** Wire schema for {@link WorkflowVersionDiffReadRequest}. */
export const WorkflowVersionDiffReadRequestSchema: z.ZodType<
  WorkflowVersionDiffReadRequest,
  WorkflowVersionDiffReadRequest
> = z
  .object({
    fromWorkflowVersionId: WorkflowVersionIdSchema,
    toWorkflowVersionId: WorkflowVersionIdSchema,
  })
  .strict();

/**
 * The `workflow.versionDiffRead` result: the structural difference, computed in the
 * daemon over the hashed body only, so a moved node is never a change. A changed node
 * carries its params before and after; the trigger counts as a node.
 */
export interface WorkflowVersionDiffReadResponse {
  nodesAdded: WorkflowNode[];
  nodesRemoved: WorkflowNode[];
  nodesChanged: { before: WorkflowNode; after: WorkflowNode }[];
  edgesAdded: WorkflowEdge[];
  edgesRemoved: WorkflowEdge[];
}
/** Wire schema for {@link WorkflowVersionDiffReadResponse}. */
export const WorkflowVersionDiffReadResponseSchema: z.ZodType<WorkflowVersionDiffReadResponse> = z
  .object({
    nodesAdded: z.array(WorkflowNodeSchema),
    nodesRemoved: z.array(WorkflowNodeSchema),
    nodesChanged: z.array(
      z.object({ before: WorkflowNodeSchema, after: WorkflowNodeSchema }).strict(),
    ),
    edgesAdded: z.array(WorkflowEdgeSchema),
    edgesRemoved: z.array(WorkflowEdgeSchema),
  })
  .strict();
