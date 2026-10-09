// The project record's writer: attach (the record and its mount in one write, or the project
// already holding the folder's repository), the clone's record from its first press to its attach,
// and the edits on the project's own row: rename, archive and its undo, setup, environment rows and
// branch pattern. Detach forgets the record in the mount's own detach write and archives the
// project's sessions, which stay readable; the folder on disk is never touched. Records are made
// one at a time, so two never take one slug. A finished attach and a detach are each one
// service-log record; nothing about a project is a session event.

import * as path from "node:path";

import type {
  BranchPatternRefusalReason,
  EnvironmentRow,
} from "@ai-sidekicks/contracts/machine-settings";
import {
  ProjectIdSchema,
  type ProjectId,
  type ProjectListEntry,
  type ProjectSetup,
} from "@ai-sidekicks/contracts/project";
import type {
  RepoAttachRequest,
  RepoAttachResponse,
  RepoDetachRequest,
  RepoDetachResponse,
} from "@ai-sidekicks/contracts/repo/folders";
import type { RepoMountId } from "@ai-sidekicks/contracts/repo/mount";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import {
  refuseBranchPattern,
  refuseEnvironmentRows,
} from "../../daemon/machine/settings/refusals.js";
import type { ServiceLogWriter } from "../../daemon/service-log.js";
import type { WriteStatement } from "../../database/statement.js";
import { WriteRefusedError, type DatabaseWriter } from "../../database/writer.js";
import { pathExists } from "../../git/filesystem.js";
import { KeyedLock } from "../../keyed-lock.js";
import type { SessionChanges } from "../../session/changes.js";
import { mintUuidV7 } from "../../uuid-v7.js";
import { addressWithoutCredentials, type StagedClone } from "../clone/destination.js";
import type { FolderPlace } from "../folder/place.js";
import {
  ProjectNotFoundError,
  RepoAlreadyAttachedError,
  RepoFolderUnreachableError,
} from "../repo/errors.js";
import type { RepoAttachTarget, RepoMountService } from "../repo/mount-service.js";
import { CloneOutcome } from "../schema.js";
import type { ProjectRecords } from "./records.js";
import { slugBaseOf, slugCandidate } from "./slug.js";

// A new project's setup: nothing to copy, nothing to run, and no time limit on a step.
const NEW_PROJECT_SETUP: ProjectSetup = { filesToCopy: [], commands: [] };

// One key for every record made: attaches and clones take slugs one at a time.
const RECORD_LOCK_KEY = "projects";

const INSERT_PROJECT_SQL = `INSERT INTO projects (
     id, name, slug, folder_path, state, clone_url, clone_outcome, setup, environment_rows,
     branch_pattern, created_at, updated_at
   ) VALUES (
     @id, @name, @slug, @folder_path, @state, @clone_url, @clone_outcome, @setup, '[]', NULL,
     @now, @now
   )`;

// A finished clone's record turns active in the write that inserts its mount.
const ACTIVATE_CLONED_PROJECT_SQL = `UPDATE projects
    SET state = 'active', clone_url = NULL, clone_outcome = NULL, clone_failure = NULL,
        clone_staging_folder = NULL, clone_staging_identity = NULL, folder_path = @folder_path,
        updated_at = @now
  WHERE id = @id AND state = 'cloning'`;

// A clone run again: running, with the address and folder it runs with, no folder made yet.
const RETARGET_CLONE_SQL = `UPDATE projects
    SET clone_url = @clone_url, folder_path = @folder_path,
        clone_outcome = '${CloneOutcome.Running}', clone_failure = NULL,
        clone_staging_folder = NULL, clone_staging_identity = NULL, updated_at = @now
  WHERE id = @id AND state = 'cloning'`;

// Written once the daemon has made the folder git clones into, before git starts, so a restart
// removes that folder and nothing else.
const RECORD_CLONE_STAGED_SQL = `UPDATE projects
    SET clone_staging_folder = @clone_staging_folder,
        clone_staging_identity = @clone_staging_identity, updated_at = @now
  WHERE id = @id AND state = 'cloning' AND clone_outcome = '${CloneOutcome.Running}'`;

// Only a running clone ends, so a clone canceled or failed already keeps its outcome. Its staged
// folder is dealt with by then, so the record lets it go.
const RECORD_CLONE_END_SQL = `UPDATE projects
    SET clone_outcome = @clone_outcome, clone_failure = @clone_failure,
        clone_staging_folder = NULL, clone_staging_identity = NULL, updated_at = @now
  WHERE id = @id AND state = 'cloning' AND clone_outcome = '${CloneOutcome.Running}'`;

const PROJECT_EXISTS_SQL = "SELECT 1 FROM projects WHERE id = @id";

// The detach's own write forgets the record once its mount reads `detached`; while an agent runs
// the mount stays attached and this deletes nothing. The mount's `project_id` goes NULL with it.
const FORGET_PROJECT_OF_DETACHED_MOUNT_SQL = `DELETE FROM projects
  WHERE id = (SELECT project_id FROM repo_mounts
               WHERE id = @repo_mount_id AND state = 'detached')`;

/** A folder attached as a project, or found already attached as one, with its mount's facts. */
export interface ProjectAttachment extends RepoAttachResponse {
  readonly projectId: ProjectId;
  /** Whether this call made the project; false when the folder's repository was already one. */
  readonly isNew: boolean;
}

/** What a clone's record starts with. */
export interface CloningProjectInput {
  /** The address the person typed, as git takes it; it is stored with any user and password out. */
  readonly url: string;
  /** The folder the finished clone is renamed to, replacing an empty folder there. */
  readonly folderPath: string;
  /** The repository's name, read from the address. */
  readonly name: string;
}

/** How a running clone ended short of its attach: git's failure line, a cancel, or a stop. */
export type CloneEnd =
  | { readonly outcome: typeof CloneOutcome.Failed; readonly failureLine: string }
  | { readonly outcome: typeof CloneOutcome.Canceled | typeof CloneOutcome.Interrupted };

/** What the project writer reads, writes and calls. */
export interface ProjectServiceDeps {
  /** The daemon database's writer, which every project change goes through. */
  readonly writer: Pick<DatabaseWriter, "write">;
  /** The project reads, shared with the live list and the clone. */
  readonly records: ProjectRecords;
  /** Resolves and attaches a project's folder, and detaches it. */
  readonly mounts: Pick<RepoMountService, "resolveAttachTarget" | "insertAttachedMount" | "detach">;
  /** Archives the sessions of a forgotten project. */
  readonly sessions: Pick<SessionChanges, "archiveOfForgottenProject">;
  /** Why a branch-name pattern cannot be saved, or `null` when it can. */
  readonly findBranchPatternRefusal: (
    pattern: string,
  ) => Promise<BranchPatternRefusalReason | null>;
  /** Where a folder sits on a Windows computer with WSL. */
  readonly folderPlace: FolderPlace;
  /** The daemon's worktrees folder, whose project folders a new slug must not reuse. */
  readonly worktreesDirectory: string;
  /** Called after each committed change to the project rows, so the live list reads them again. */
  readonly onProjectsChanged: () => void;
  /** Where `repo.attached` and `repo.detached` are recorded. */
  readonly writeServiceLog: ServiceLogWriter;
  /** ISO-8601 wall clock for `created_at` and `updated_at`. */
  readonly now?: () => string;
  /** Project-id source, default `mintUuidV7`. */
  readonly newProjectId?: () => string;
}

/** Owns the `projects` rows: attach, the clone's record, the project edits and the detach. */
export class ProjectService {
  readonly #records: ProjectRecords;
  readonly #writer: Pick<DatabaseWriter, "write">;
  readonly #mounts: ProjectServiceDeps["mounts"];
  readonly #sessions: ProjectServiceDeps["sessions"];
  readonly #findBranchPatternRefusal: ProjectServiceDeps["findBranchPatternRefusal"];
  readonly #folderPlace: FolderPlace;
  readonly #worktreesDirectory: string;
  readonly #onProjectsChanged: () => void;
  readonly #writeServiceLog: ServiceLogWriter;
  readonly #now: () => string;
  readonly #newProjectId: () => string;
  readonly #recordLock = new KeyedLock<string>();

  constructor(deps: ProjectServiceDeps) {
    this.#records = deps.records;
    this.#writer = deps.writer;
    this.#mounts = deps.mounts;
    this.#sessions = deps.sessions;
    this.#findBranchPatternRefusal = deps.findBranchPatternRefusal;
    this.#folderPlace = deps.folderPlace;
    this.#worktreesDirectory = deps.worktreesDirectory;
    this.#onProjectsChanged = deps.onProjectsChanged;
    this.#writeServiceLog = deps.writeServiceLog;
    this.#now = deps.now ?? ((): string => new Date().toISOString());
    this.#newProjectId = deps.newProjectId ?? mintUuidV7;
  }

  /**
   * Attaches the folder at `localPath` as a new project named for the folder, its record and mount
   * in one write, or answers the project that already holds the folder's repository. Throws
   * `RepoFolderUnreachableError` for a folder in another WSL distribution,
   * `RepoRootResolutionError` for a path that resolves to no repository (`not_a_repository` for a
   * plain folder), and `RepoAlreadyAttachedError` when a chat's own workspace holds it.
   */
  async attachOrFind(request: RepoAttachRequest): Promise<ProjectAttachment> {
    if (this.#folderPlace.isInAnotherDistribution(request.localPath)) {
      throw new RepoFolderUnreachableError();
    }
    return this.#recordLock.run(RECORD_LOCK_KEY, async () => {
      let target: RepoAttachTarget;
      try {
        target = await this.#mounts.resolveAttachTarget(request);
      } catch (error) {
        return this.#foundOrRethrow(error);
      }
      const name = path.basename(target.canonicalRoot);
      const projectId = ProjectIdSchema.parse(this.#newProjectId());
      const projectRow = await this.#insertProjectStatement({
        projectId,
        name,
        folderPath: target.canonicalRoot,
        clone: null,
      });
      let mount: RepoAttachResponse;
      try {
        mount = await this.#mounts.insertAttachedMount(target, projectId, [projectRow]);
      } catch (error) {
        // Attached since it was resolved: the project holding it now is the answer.
        return this.#foundOrRethrow(error);
      }
      this.#recordAttached(projectId, mount.repoMountId);
      return { ...mount, projectId, isNew: true };
    });
  }

  /**
   * Makes the record of a clone at its first press, marked `cloning` and running, and answers its
   * id. The project is named for the repository and its slug is fixed now.
   */
  async createCloningProject(input: CloningProjectInput): Promise<ProjectId> {
    return this.#recordLock.run(RECORD_LOCK_KEY, async () => {
      const projectId = ProjectIdSchema.parse(this.#newProjectId());
      await this.#writer.write([
        await this.#insertProjectStatement({
          projectId,
          name: input.name,
          folderPath: input.folderPath,
          clone: { url: input.url },
        }),
      ]);
      this.#onProjectsChanged();
      return projectId;
    });
  }

  /**
   * Points an ended clone at the address and folder it runs again with, marking it running.
   * Throws `ProjectNotFoundError` unless the project is still marked `cloning`.
   */
  async retargetClone(
    projectId: ProjectId,
    target: Omit<CloningProjectInput, "name">,
  ): Promise<void> {
    await this.#writeProjectChange(projectId, {
      sql: RETARGET_CLONE_SQL,
      bindings: {
        id: projectId,
        clone_url: addressWithoutCredentials(target.url),
        folder_path: target.folderPath,
        now: this.#now(),
      },
      expectedRowCount: 1,
    });
  }

  /**
   * Records the folder the daemon made for a running clone's git, so a restart removes that folder
   * and nothing else. Throws the writer's refusal unless the clone is still running.
   */
  async recordCloneStaged(projectId: ProjectId, staged: StagedClone): Promise<void> {
    await this.#writer.write([
      {
        sql: RECORD_CLONE_STAGED_SQL,
        bindings: {
          id: projectId,
          clone_staging_folder: staged.path,
          clone_staging_identity: staged.identity,
          now: this.#now(),
        },
        expectedRowCount: 1,
      },
    ]);
  }

  /**
   * Records how a running clone ended short of its attach; a clone not running (attached, or
   * ended already) is left as it is.
   */
  async recordCloneEnd(projectId: ProjectId, end: CloneEnd): Promise<void> {
    await this.#writer.write([
      {
        sql: RECORD_CLONE_END_SQL,
        bindings: {
          id: projectId,
          clone_outcome: end.outcome,
          clone_failure: end.outcome === CloneOutcome.Failed ? end.failureLine : null,
          now: this.#now(),
        },
      },
    ]);
    this.#onProjectsChanged();
  }

  /**
   * Attaches a finished clone's folder as its project's mount, the record turning `active` in the
   * same write, exactly as a folder is attached. Throws what the attach throws, and
   * `ProjectNotFoundError` when the project is no longer cloning.
   */
  async attachClonedProject(projectId: ProjectId, localPath: string): Promise<ProjectAttachment> {
    return this.#recordLock.run(RECORD_LOCK_KEY, async () => {
      const target = await this.#mounts.resolveAttachTarget({ localPath });
      const activate: WriteStatement = {
        sql: ACTIVATE_CLONED_PROJECT_SQL,
        bindings: { id: projectId, folder_path: target.canonicalRoot, now: this.#now() },
        expectedRowCount: 1,
      };
      let mount: RepoAttachResponse;
      try {
        mount = await this.#mounts.insertAttachedMount(target, projectId, [activate]);
      } catch (error) {
        if (error instanceof WriteRefusedError && error.statementIndex === 0) {
          throw new ProjectNotFoundError(projectId);
        }
        throw error;
      }
      this.#recordAttached(projectId, mount.repoMountId);
      return { ...mount, projectId, isNew: true };
    });
  }

  /** Sets the project's display name; the folder and every worktree path stay where they are. */
  async rename(projectId: ProjectId, name: string): Promise<ProjectListEntry> {
    return this.#editProject(projectId, "name = @value", name);
  }

  /** Moves an active project into the archived group; any other state is left as it is. */
  async archive(projectId: ProjectId): Promise<ProjectListEntry> {
    return this.#moveProjectState(projectId, "active", "archived");
  }

  /** Moves an archived project back into the list; any other state is left as it is. */
  async reactivate(projectId: ProjectId): Promise<ProjectListEntry> {
    return this.#moveProjectState(projectId, "archived", "active");
  }

  /** Replaces the project's setup with one draft: files to copy, commands in order, time limit. */
  async updateSetup(projectId: ProjectId, setup: ProjectSetup): Promise<ProjectListEntry> {
    return this.#editProject(projectId, "setup = @value", JSON.stringify(setup));
  }

  /**
   * Replaces the project's own environment rows. A row whose name the environment-name rule
   * refuses is refused with `daemon.environment_name_refused`, naming it, and nothing is written.
   */
  async updateEnvironment(
    projectId: ProjectId,
    environmentRows: readonly EnvironmentRow[],
  ): Promise<ProjectListEntry> {
    refuseEnvironmentRows(environmentRows);
    return this.#editProject(
      projectId,
      "environment_rows = @value",
      JSON.stringify(environmentRows),
    );
  }

  /**
   * Sets the project's own branch pattern, or with `null` returns it to the machine's. A pattern
   * without `{title}` exactly once, or one git refuses as a branch name, is refused with
   * `daemon.branch_pattern_refused` and nothing is written.
   */
  async updateBranchPattern(
    projectId: ProjectId,
    pattern: string | null,
  ): Promise<ProjectListEntry> {
    if (pattern !== null) {
      refuseBranchPattern(await this.#findBranchPatternRefusal(pattern));
    }
    return this.#editProject(projectId, "branch_pattern = @value", pattern);
  }

  /**
   * The project's `Delete`: detaches its mount and forgets its record in one write, then archives
   * its active sessions and those still provisioning, which stay readable; nothing on disk is
   * touched. Refused as the mount's
   * detach refuses (`repo.detach_conflict` while an agent runs anywhere in the project,
   * `repo.mount_managed`, `repo.not_found`). A session that could not be archived is thrown after
   * every other was tried.
   */
  async detach(request: RepoDetachRequest): Promise<RepoDetachResponse> {
    const projectId = this.#records.readProjectOfMount(request.repoMountId);
    const sessionIds = projectId === null ? [] : this.#records.readArchivableSessionsOf(projectId);
    const outcome = await this.#mounts.detach(request, [
      {
        sql: FORGET_PROJECT_OF_DETACHED_MOUNT_SQL,
        bindings: { repo_mount_id: request.repoMountId },
      },
    ]);
    const forgottenProjectId =
      projectId !== null && this.#records.readRow(projectId) === undefined ? projectId : null;
    if (forgottenProjectId === null) {
      return { ...outcome, archivedSessionIds: [], forgottenProjectId };
    }
    this.#writeServiceLog(
      `repo.detached: project ${forgottenProjectId} forgotten and mount ${request.repoMountId} ` +
        `detached, ${String(outcome.archivedWorkspaceIds.length)} workspaces archived`,
    );
    this.#onProjectsChanged();
    const archivedSessionIds = await this.#archiveSessions(sessionIds);
    return { ...outcome, archivedSessionIds, forgottenProjectId };
  }

  // Every session is tried; the failures are thrown together once all were.
  async #archiveSessions(sessionIds: readonly SessionId[]): Promise<SessionId[]> {
    const archived: SessionId[] = [];
    const failures: unknown[] = [];
    for (const sessionId of sessionIds) {
      try {
        await this.#sessions.archiveOfForgottenProject(sessionId);
        archived.push(sessionId);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `The project was forgotten, but ${String(failures.length)} of its sessions were not ` +
          "archived",
      );
    }
    return archived;
  }

  // An attach refused because the repository is attached already answers the project holding it;
  // a chat's own workspace holds no project, and any other failure is the caller's.
  #foundOrRethrow(error: unknown): ProjectAttachment {
    if (!(error instanceof RepoAlreadyAttachedError)) {
      throw error;
    }
    const repoMountId = error.conflictingRepoMountId;
    const projectId = this.#records.readProjectOfMount(repoMountId);
    const project = projectId === null ? undefined : this.#records.readRow(projectId);
    if (project === undefined || project.repo_mount_id !== repoMountId) {
      throw error;
    }
    // The project's mount is the one its row reads `attached`.
    return {
      repoMountId,
      state: "attached",
      vcsType: this.#records.readVcsOfMount(repoMountId),
      canonicalRoot: project.folder_path,
      projectId: project.id,
      isNew: false,
    };
  }

  // The project row a new project starts as, with the first slug its name leaves free; a clone's
  // starts cloning and running.
  async #insertProjectStatement(input: {
    readonly projectId: ProjectId;
    readonly name: string;
    readonly folderPath: string;
    readonly clone: { readonly url: string } | null;
  }): Promise<WriteStatement> {
    const { clone } = input;
    return {
      sql: INSERT_PROJECT_SQL,
      bindings: {
        id: input.projectId,
        name: input.name,
        slug: await this.#freeSlug(slugBaseOf(input.name)),
        folder_path: input.folderPath,
        state: clone === null ? "active" : "cloning",
        clone_url: clone === null ? null : addressWithoutCredentials(clone.url),
        clone_outcome: clone === null ? null : CloneOutcome.Running,
        setup: JSON.stringify(NEW_PROJECT_SETUP),
        now: this.#now(),
      },
    };
  }

  // Free means no project holds it and no folder sits at it in the worktrees folder, where a
  // forgotten project's worktrees may still be. Called under the record lock.
  async #freeSlug(base: string): Promise<string> {
    for (let ordinal = 1; ; ordinal += 1) {
      const candidate = slugCandidate(base, ordinal);
      if (
        !this.#records.isSlugTaken(candidate) &&
        !(await pathExists(path.join(this.#worktreesDirectory, candidate)))
      ) {
        return candidate;
      }
    }
  }

  #recordAttached(projectId: ProjectId, repoMountId: RepoMountId): void {
    this.#writeServiceLog(`repo.attached: project ${projectId} attached as mount ${repoMountId}`);
    this.#onProjectsChanged();
  }

  // One column of the project's row, the existence guard in the same write.
  async #editProject(
    projectId: ProjectId,
    assignment: string,
    value: string | null,
  ): Promise<ProjectListEntry> {
    return this.#writeProjectChange(projectId, {
      sql: `UPDATE projects SET ${assignment}, updated_at = @now WHERE id = @id`,
      bindings: { id: projectId, value, now: this.#now() },
      expectedRowCount: 1,
    });
  }

  async #moveProjectState(
    projectId: ProjectId,
    from: "active" | "archived",
    to: "active" | "archived",
  ): Promise<ProjectListEntry> {
    return this.#writeProjectChange(
      projectId,
      { sql: PROJECT_EXISTS_SQL, bindings: { id: projectId }, expectedRowCount: 1 },
      {
        sql: `UPDATE projects SET state = @to, updated_at = @now WHERE id = @id AND state = @from`,
        bindings: { id: projectId, from, to, now: this.#now() },
      },
    );
  }

  // The write whose first statement holds only while the project exists, then the project as the
  // list now draws it. Throws `ProjectNotFoundError` with nothing written otherwise.
  async #writeProjectChange(
    projectId: ProjectId,
    ...statements: [WriteStatement, ...WriteStatement[]]
  ): Promise<ProjectListEntry> {
    try {
      await this.#writer.write(statements);
    } catch (error) {
      if (error instanceof WriteRefusedError && error.statementIndex === 0) {
        throw new ProjectNotFoundError(projectId);
      }
      throw error;
    }
    this.#onProjectsChanged();
    const entry = this.#records.readEntry(projectId);
    if (entry === undefined) {
      throw new ProjectNotFoundError(projectId);
    }
    return entry;
  }
}
