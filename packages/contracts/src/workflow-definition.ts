// Workflow definitions and their versions: creating a definition, reading one, listing
// the definitions a caller can see, reading one saved version, and reading the chain of
// versions a pinned version belongs to. Payload shapes only; nothing here registers a
// method or a handler.
import { z } from "zod";

import { SessionIdSchema, type SessionId } from "./session.js";

/** A workflow definition's id. The daemon mints it; a client passes it through unparsed. */
export type WorkflowDefinitionId = string & { readonly __brand: "WorkflowDefinitionId" };
/** Wire schema for {@link WorkflowDefinitionId}. */
export const WorkflowDefinitionIdSchema: z.ZodType<WorkflowDefinitionId, WorkflowDefinitionId> = z
  .string()
  .min(1)
  .brand<"WorkflowDefinitionId">() as unknown as z.ZodType<
  WorkflowDefinitionId,
  WorkflowDefinitionId
>;

/**
 * One saved version's id, exactly as the daemon returned it; it is what a run start
 * takes. A client never builds one from a definition id and a version number, because
 * no encoding over that pair exists on the wire.
 */
export const WorkflowVersionIdSchema: z.ZodType<string, string> = z.string().min(1);

/**
 * A definition's content hash: BLAKE3 over the RFC 8785 canonical JSON of its hashed
 * body. Canvas layout and pinned sample data sit outside that body, so neither changes it.
 */
export const WorkflowContentHashSchema: z.ZodType<string, string> = z.string().min(1);

const WORKFLOW_DEFINITION_SCOPES = ["session", "project", "shared"] as const;

/**
 * Where a definition is visible, most specific first, which is also the order a name
 * resolves in. `session` binds it to the session that wrote it, `project` spans one
 * project's sessions, and `shared` is reusable by every project on this machine.
 * `shared` widens reuse only: nothing is distributed or synced.
 */
export type WorkflowDefinitionScope = (typeof WORKFLOW_DEFINITION_SCOPES)[number];
/** Wire schema for {@link WorkflowDefinitionScope}. */
export const WorkflowDefinitionScopeSchema: z.ZodType<
  WorkflowDefinitionScope,
  WorkflowDefinitionScope
> = z.enum(WORKFLOW_DEFINITION_SCOPES);

// A scope's identity: the authoring session's id at `session`, the resolved repository
// root at `project`, and the empty string at `shared`, which refers to nothing narrower.
const WorkflowDefinitionScopeRefSchema = z.string();

/**
 * The `workflow.definitionCreate` input. Saving a new workflow, duplicating one,
 * importing a file and moving one to `shared` all send this one shape. Authorization
 * keys on `scope`, never on which act composed the request, so the request has no act field.
 */
export interface WorkflowDefinitionCreateRequest {
  sessionId: SessionId;
  name: string;
  scope: WorkflowDefinitionScope;
  scopeRef?: string | undefined;
  parentContentHash?: string | undefined;
}
/** Wire schema for {@link WorkflowDefinitionCreateRequest}. */
export const WorkflowDefinitionCreateRequestSchema: z.ZodType<
  WorkflowDefinitionCreateRequest,
  WorkflowDefinitionCreateRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    name: z.string().min(1),
    // A `shared` target is refused for anyone the daemon's operator check does not
    // admit; it is never quietly narrowed to a smaller scope.
    scope: WorkflowDefinitionScopeSchema,
    // Omitted at `session`, it means this request's session; at `shared`, the empty
    // string. `project` has nothing to derive it from, so omitting it there is refused.
    scopeRef: WorkflowDefinitionScopeRefSchema.optional(),
    // The hash of the `shared` definition this one was branched from when an author
    // edited it. Provenance only: it is outside the hashed body, so a branched definition
    // and one written from scratch with the same body hash alike.
    parentContentHash: WorkflowContentHashSchema.optional(),
  })
  .strict();

/**
 * The `workflow.definitionCreate` result: the new definition and its first version,
 * with what a caller needs to pin or start that version without a second read.
 */
export interface WorkflowDefinitionCreateResponse {
  definitionId: WorkflowDefinitionId;
  versionNumber: number;
  contentHash: string;
  workflowVersionId: string;
  createdAt: string;
}
/** Wire schema for {@link WorkflowDefinitionCreateResponse}. */
export const WorkflowDefinitionCreateResponseSchema: z.ZodType<WorkflowDefinitionCreateResponse> = z
  .object({
    definitionId: WorkflowDefinitionIdSchema,
    versionNumber: z.number().int().positive(),
    contentHash: WorkflowContentHashSchema,
    workflowVersionId: WorkflowVersionIdSchema,
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();

/**
 * The `workflow.definitionRead` input: one definition, at `version` when given and at
 * its latest version otherwise.
 */
export interface WorkflowDefinitionReadRequest {
  definitionId: WorkflowDefinitionId;
  version?: number | undefined;
}
/** Wire schema for {@link WorkflowDefinitionReadRequest}. */
export const WorkflowDefinitionReadRequestSchema: z.ZodType<
  WorkflowDefinitionReadRequest,
  WorkflowDefinitionReadRequest
> = z
  .object({
    definitionId: WorkflowDefinitionIdSchema,
    version: z.number().int().positive().optional(),
  })
  .strict();

/**
 * The `workflow.definitionList` input. Without `scope` it answers every visible scope
 * together. Without `sessionId` the list is not resolved from any one session, so no
 * entry carries `resolvesAtThisContext`.
 */
export interface WorkflowDefinitionListRequest {
  sessionId?: SessionId | undefined;
  scope?: WorkflowDefinitionScope | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}
/** Wire schema for {@link WorkflowDefinitionListRequest}. */
export const WorkflowDefinitionListRequestSchema: z.ZodType<
  WorkflowDefinitionListRequest,
  WorkflowDefinitionListRequest
> = z
  .object({
    sessionId: SessionIdSchema.optional(),
    scope: WorkflowDefinitionScopeSchema.optional(),
    limit: z.number().int().positive().optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();

/**
 * One definition in a list. `latestWorkflowVersionId` is what a run start takes;
 * `latestVersionNumber` sits beside it because a version read addresses a version by
 * number. A client passes both through and derives neither from the other.
 */
export interface WorkflowDefinitionSummary {
  id: WorkflowDefinitionId;
  name: string;
  scope: WorkflowDefinitionScope;
  scopeRef: string;
  latestVersionNumber: number;
  latestWorkflowVersionId: string;
  contentHash: string;
  resolvesAtThisContext?: boolean | undefined;
  createdAt: string;
}
/** Wire schema for {@link WorkflowDefinitionSummary}. */
export const WorkflowDefinitionSummarySchema: z.ZodType<WorkflowDefinitionSummary> = z
  .object({
    id: WorkflowDefinitionIdSchema,
    name: z.string().min(1),
    scope: WorkflowDefinitionScopeSchema,
    scopeRef: WorkflowDefinitionScopeRefSchema,
    latestVersionNumber: z.number().int().positive(),
    latestWorkflowVersionId: WorkflowVersionIdSchema,
    contentHash: WorkflowContentHashSchema,
    // Present only when the request named a session: true for the one entry per name
    // that resolving most specific first would pick there, so a picker shows which
    // definition a run would use instead of working out the order itself.
    resolvesAtThisContext: z.boolean().optional(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();

/** The `workflow.definitionList` result: one page of definitions, each listed once across pages. */
export interface WorkflowDefinitionListResponse {
  definitions: WorkflowDefinitionSummary[];
  nextCursor?: string | undefined;
}
/** Wire schema for {@link WorkflowDefinitionListResponse}. */
export const WorkflowDefinitionListResponseSchema: z.ZodType<WorkflowDefinitionListResponse> = z
  .object({
    definitions: z.array(WorkflowDefinitionSummarySchema),
    nextCursor: z.string().min(1).optional(),
  })
  .strict();

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

/** One version in a chain: the id a re-pin carries and the number a person reads. */
export interface WorkflowVersionChainEntry {
  workflowVersionId: string;
  versionNumber: number;
}
/** Wire schema for {@link WorkflowVersionChainEntry}. */
export const WorkflowVersionChainEntrySchema: z.ZodType<WorkflowVersionChainEntry> = z
  .object({
    workflowVersionId: WorkflowVersionIdSchema,
    versionNumber: z.number().int().positive(),
  })
  .strict();

/**
 * The `workflow.versionChainRead` result: every version of the pinned version's
 * definition, oldest first.
 */
export interface WorkflowVersionChainReadResponse {
  versions: WorkflowVersionChainEntry[];
}
/** Wire schema for {@link WorkflowVersionChainReadResponse}. */
export const WorkflowVersionChainReadResponseSchema: z.ZodType<WorkflowVersionChainReadResponse> = z
  .object({ versions: z.array(WorkflowVersionChainEntrySchema) })
  .strict();
