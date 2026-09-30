// Project contracts — a project is its own durable record beside its mount. It
// exists from the first press of `Clone`, before any mount does, and carries
// the name the person gives it, its setup steps, its own environment rows and
// its own branch pattern. The row shape, the environment-name rule and the
// branch-pattern rule are the machine settings' own, imported so a project's
// override is checked exactly as `Every project` is.
// `repo.projectList` is a live list: the acknowledgement is the shared
// `SubscribeAckResponse`, and each emission carries the whole list, so a late
// subscriber needs no replay and a dropped frame costs nothing.
//
// IMPORT DIRECTION IS ONE-WAY: this module imports nothing from `./event.js`
// and nothing whose import closure reaches it (the transitive rule repo.ts's
// header documents). Every module imported below is closure-clean.
import { z } from "zod";

import { brandedUuidIdSchema } from "./internal/branded.js";
import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc-streaming.js";
import {
  BranchNamePatternSchema,
  EnvironmentRowSchema,
  type EnvironmentRow,
} from "./machine-settings.js";
import { REPO_PATH_MAX_LEN, RepoMountIdSchema, type RepoMountId } from "./repo.js";
import { SessionIdSchema, wireFreeFormString, type SessionId } from "./session.js";

/** A project: the record beside a mount that the person names and configures. */
export type ProjectId = string & { readonly __brand: "ProjectId" };
/** Parses a {@link ProjectId}; the daemon mints it. */
export const ProjectIdSchema: z.ZodType<ProjectId, ProjectId> =
  brandedUuidIdSchema<ProjectId>("ProjectId");

// --------------------------------------------------------------------------
// Projects — `repo.projectList` and the edits on a project's row.
// --------------------------------------------------------------------------

/** The longest project name the daemon keeps. */
export const PROJECT_NAME_MAX_LEN = 256;
/**
 * The longest setup command the daemon keeps. A command line the person types,
 * bounded generously so no command a shell accepts is refused for its length.
 */
export const PROJECT_SETUP_COMMAND_MAX_LEN = 8192;

/**
 * A project's life: `cloning` from the first press of `Clone` until the clone
 * attaches (a failed or canceled clone stays `cloning`, so it can be run again),
 * then `active`, and `archived` while it sits in the archived group.
 */
export type ProjectState = "cloning" | "active" | "archived";
/** Wire schema for {@link ProjectState}. */
export const ProjectStateSchema: z.ZodType<ProjectState> = z.enum([
  "cloning",
  "active",
  "archived",
]);

/**
 * What runs after a worktree is made in the project: files copied into the new
 * tree, then commands run in order, each given up on after the time limit. The
 * steps run with the repository's own git hooks off and never raise an
 * approval, so only the person writes them.
 */
export interface ProjectSetup {
  filesToCopy: string[];
  commands: string[];
  timeLimitSeconds: number;
}
/** Parses a {@link ProjectSetup}; each file is a path inside the repository. */
export const ProjectSetupSchema: z.ZodType<ProjectSetup, ProjectSetup> = z
  .object({
    filesToCopy: z.array(wireFreeFormString(REPO_PATH_MAX_LEN, "ProjectSetup.filesToCopy[]")),
    commands: z.array(wireFreeFormString(PROJECT_SETUP_COMMAND_MAX_LEN, "ProjectSetup.commands[]")),
    timeLimitSeconds: z.number().int().positive(),
  })
  .strict();

/**
 * One project as the Projects page and the session list's project headers draw
 * it.
 *
 * `repoMountId` is null while the project is still cloning, since the mount is
 * made when the clone attaches. `runningSessionId` names a session with an agent
 * running anywhere in the project, which is what grays `Delete`; the screen reads
 * that session's title from the session list. `environmentRows` are the
 * project's own rows, each winning over the `Every project` row of the same
 * name. `branchPattern` is null while the
 * project follows the machine's pattern. `onOtherSideDisk` marks a folder on the
 * other side's disk of a Windows computer with WSL, which the service reads more
 * slowly.
 */
export interface ProjectListEntry {
  projectId: ProjectId;
  repoMountId: RepoMountId | null;
  name: string;
  folderPath: string;
  state: ProjectState;
  sessionCount: number;
  runningSessionId: SessionId | null;
  setup: ProjectSetup;
  environmentRows: EnvironmentRow[];
  branchPattern: string | null;
  onOtherSideDisk: boolean;
}
/** Wire schema for {@link ProjectListEntry}. */
export const ProjectListEntrySchema: z.ZodType<ProjectListEntry> = z
  .object({
    projectId: ProjectIdSchema,
    repoMountId: RepoMountIdSchema.nullable(),
    name: wireFreeFormString(PROJECT_NAME_MAX_LEN, "ProjectListEntry.name"),
    folderPath: wireFreeFormString(REPO_PATH_MAX_LEN, "ProjectListEntry.folderPath"),
    state: ProjectStateSchema,
    sessionCount: z.number().int().nonnegative(),
    runningSessionId: SessionIdSchema.nullable(),
    setup: ProjectSetupSchema,
    environmentRows: z.array(EnvironmentRowSchema),
    branchPattern: BranchNamePatternSchema.nullable(),
    onOtherSideDisk: z.boolean(),
  })
  .strict();

/** The `repo.projectList` subscription takes nothing: it lists every project. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ProjectListRequest {}
/** Wire schema for {@link ProjectListRequest}. */
export const ProjectListRequestSchema: z.ZodType<ProjectListRequest, ProjectListRequest> = z
  .object({})
  .strict();

/** The `repo.projectList` acknowledgement. */
export type ProjectListResponse = SubscribeAckResponse;
/** Wire schema for {@link ProjectListResponse}. */
export const ProjectListResponseSchema: z.ZodType<ProjectListResponse> = SubscribeAckResponseSchema;

/**
 * One `repo.projectList` emission: every project, sent once on subscribe and
 * again on each change, so a project attached or cloned from another device
 * appears at once.
 */
export interface ProjectList {
  projects: ProjectListEntry[];
}
/** Wire schema for {@link ProjectList}. */
export const ProjectListSchema: z.ZodType<ProjectList> = z
  .object({ projects: z.array(ProjectListEntrySchema) })
  .strict();

/** The project an edit acts on, as every project edit's reply returns it. */
export interface ProjectEditResponse {
  project: ProjectListEntry;
}
/** Wire schema for {@link ProjectEditResponse}. */
export const ProjectEditResponseSchema: z.ZodType<ProjectEditResponse> = z
  .object({ project: ProjectListEntrySchema })
  .strict();

/** `repo.projectRename`: the project's display name; the folder on disk is untouched. */
export interface ProjectRenameRequest {
  projectId: ProjectId;
  name: string;
}
/** Wire schema for {@link ProjectRenameRequest}. */
export const ProjectRenameRequestSchema: z.ZodType<ProjectRenameRequest, ProjectRenameRequest> = z
  .object({
    projectId: ProjectIdSchema,
    name: wireFreeFormString(PROJECT_NAME_MAX_LEN, "ProjectRenameRequest.name"),
  })
  .strict();

/**
 * `repo.projectArchive` and `repo.projectReactivate`: the project to move into or
 * out of the archived group. Its sessions are kept either way, and archiving an
 * archived project, or reactivating an active one, changes nothing.
 */
export interface ProjectStateChangeRequest {
  projectId: ProjectId;
}
/** Wire schema for {@link ProjectStateChangeRequest}. */
export const ProjectStateChangeRequestSchema: z.ZodType<
  ProjectStateChangeRequest,
  ProjectStateChangeRequest
> = z.object({ projectId: ProjectIdSchema }).strict();

/** `repo.projectSetupUpdate`: the whole setup, replacing what the project had. */
export interface ProjectSetupUpdateRequest {
  projectId: ProjectId;
  setup: ProjectSetup;
}
/** Wire schema for {@link ProjectSetupUpdateRequest}. */
export const ProjectSetupUpdateRequestSchema: z.ZodType<
  ProjectSetupUpdateRequest,
  ProjectSetupUpdateRequest
> = z.object({ projectId: ProjectIdSchema, setup: ProjectSetupSchema }).strict();

/**
 * `repo.projectEnvironmentUpdate`: the project's whole list of rows, replacing
 * what it had. A row whose name the environment-name rule refuses is refused
 * with the machine settings' own `daemon.environment_name_refused` and its
 * details, naming the row, and nothing is written.
 */
export interface ProjectEnvironmentUpdateRequest {
  projectId: ProjectId;
  environmentRows: EnvironmentRow[];
}
/** Wire schema for {@link ProjectEnvironmentUpdateRequest}. */
export const ProjectEnvironmentUpdateRequestSchema: z.ZodType<
  ProjectEnvironmentUpdateRequest,
  ProjectEnvironmentUpdateRequest
> = z
  .object({ projectId: ProjectIdSchema, environmentRows: z.array(EnvironmentRowSchema) })
  .strict();

/**
 * `repo.projectBranchPatternUpdate`: the project's own branch pattern, or null
 * to return the project to the machine's pattern. A pattern git refuses, or one
 * that clashes with a branch in the repository, is refused and nothing is
 * written.
 */
export interface ProjectBranchPatternUpdateRequest {
  projectId: ProjectId;
  pattern: string | null;
}
/** Wire schema for {@link ProjectBranchPatternUpdateRequest}. */
export const ProjectBranchPatternUpdateRequestSchema: z.ZodType<
  ProjectBranchPatternUpdateRequest,
  ProjectBranchPatternUpdateRequest
> = z.object({ projectId: ProjectIdSchema, pattern: BranchNamePatternSchema.nullable() }).strict();
