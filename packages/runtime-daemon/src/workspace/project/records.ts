// The reads of the `projects` rows: each project as the Projects page and the session list's
// project headers draw it, with its session count, the daemon's tally of its sessions and the
// session an agent runs in; the naming facts, setup steps and environment rows the worktree
// service reads; and the rows the clone service and the detach work from. Every read is on the
// read-only connection, so a project writer reads what it committed.

import type { Database, Statement } from "better-sqlite3";

import type { EnvironmentRow } from "@ai-sidekicks/contracts/machine-settings";
import type {
  ProjectId,
  ProjectListEntry,
  ProjectSetup,
  ProjectState,
} from "@ai-sidekicks/contracts/project";
import { VcsTypeSchema, type RepoMountId, type VcsType } from "@ai-sidekicks/contracts/repo/mount";
import type { SessionActivity } from "@ai-sidekicks/contracts/session/directory";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { WorktreeId } from "@ai-sidekicks/contracts/worktree/lifecycle";

import type { WorktreeProjectNaming } from "../../git/worktree/naming.js";
import { sessionProjectSql } from "../../session/directory/lookups.js";
import { sessionActivitySql } from "../../session/directory/run-activity.js";
import type { FolderPlace } from "../folder/place.js";
import { CloneOutcome } from "../schema.js";

/** One `projects` row as stored, with the project's attached mount, if it has one. */
export interface ProjectRow {
  readonly id: ProjectId;
  readonly name: string;
  readonly slug: string;
  readonly folder_path: string;
  readonly state: ProjectState;
  readonly clone_url: string | null;
  /** Where the clone stands; `null` once the project is no longer cloning. */
  readonly clone_outcome: CloneOutcome | null;
  /** Git's last error line, held only while the outcome is `failed`. */
  readonly clone_failure: string | null;
  /** JSON {@link ProjectSetup}. */
  readonly setup: string;
  /** JSON {@link EnvironmentRow}[]. */
  readonly environment_rows: string;
  readonly branch_pattern: string | null;
  readonly repo_mount_id: RepoMountId | null;
}

/** An attached project's folder, as the clone compares an address against it. */
export interface AttachedProjectFolder {
  readonly projectId: ProjectId;
  readonly repoMountId: RepoMountId;
  readonly canonicalRoot: string;
}

// Each project with its attached mount; `@project_id` NULL reads every project.
const PROJECT_ROWS_SQL = `SELECT project.id, project.name, project.slug, project.folder_path,
       project.state, project.clone_url, project.clone_outcome, project.clone_failure,
       project.setup, project.environment_rows, project.branch_pattern,
       (SELECT mount.id FROM repo_mounts AS mount
         WHERE mount.project_id = project.id AND mount.state = 'attached') AS repo_mount_id
  FROM projects AS project
 WHERE @project_id IS NULL OR project.id = @project_id
 ORDER BY project.created_at ASC, project.id ASC`;

// Each project session's activity facts with its project; a session being purged is gone.
const PROJECT_SESSION_FACTS_SQL = `SELECT facts.project_id, facts.activity
  FROM (SELECT ${sessionProjectSql("s.id")} AS project_id,
               ${sessionActivitySql("s.id", "s.last_run_outcome")} AS activity
          FROM sessions s
         WHERE s.shape = 'project' AND s.state <> 'purge_requested') AS facts
 WHERE facts.project_id IS NOT NULL
   AND (@project_id IS NULL OR facts.project_id = @project_id)`;

// Each run whose execution root is unreleased, with the project of its workspace's mount, oldest
// first; `run_id` breaks ties between runs started in the same tick.
const RUNNING_SESSIONS_SQL = `SELECT mount.project_id, run_context.session_id
  FROM run_execution_contexts AS run_context
  JOIN workspaces AS workspace ON workspace.id = run_context.workspace_id
  JOIN repo_mounts AS mount ON mount.id = workspace.repo_mount_id
 WHERE run_context.released_at IS NULL
   AND mount.project_id IS NOT NULL
   AND (@project_id IS NULL OR mount.project_id = @project_id)
 ORDER BY run_context.created_at ASC, run_context.run_id ASC`;

const NAMING_OF_MOUNT_SQL = `SELECT project.slug, project.branch_pattern
  FROM repo_mounts AS mount JOIN projects AS project ON project.id = mount.project_id
 WHERE mount.id = ?`;

// The setup steps and environment rows of the project a worktree belongs to.
const PROJECT_OF_WORKTREE_SQL = `SELECT project.setup, project.environment_rows
  FROM worktrees AS worktree
  JOIN repo_mounts AS mount ON mount.id = worktree.repo_mount_id
  JOIN projects AS project ON project.id = mount.project_id
 WHERE worktree.id = ?`;

const PROJECT_OF_MOUNT_SQL = "SELECT project_id FROM repo_mounts WHERE id = ?";

const VCS_OF_MOUNT_SQL = "SELECT vcs_type FROM repo_mounts WHERE id = ?";

// The project's sessions a detach archives: the active ones, and those still provisioning, whose
// bind can never come once the project is forgotten.
const ARCHIVABLE_SESSIONS_OF_PROJECT_SQL = `SELECT s.id FROM sessions s
 WHERE s.shape = 'project' AND s.state IN ('active', 'provisioning')
   AND ${sessionProjectSql("s.id")} = ?
 ORDER BY s.created_at ASC, s.id ASC`;

const SLUG_TAKEN_SQL = "SELECT 1 FROM projects WHERE slug = ?";

const ATTACHED_PROJECT_FOLDERS_SQL = `SELECT mount.project_id AS projectId,
       mount.id AS repoMountId, mount.canonical_root AS canonicalRoot
  FROM repo_mounts AS mount
 WHERE mount.state = 'attached' AND mount.origin = 'attached'
 ORDER BY mount.attached_at DESC, mount.id DESC`;

// A clone recorded running: at the service's start no git runs, so the last stop cut it short.
const RUNNING_CLONES_SQL = `SELECT id, folder_path, clone_staging_folder, clone_staging_identity
  FROM projects
 WHERE state = 'cloning' AND clone_outcome = '${CloneOutcome.Running}'`;

/** A clone recorded running, as the start-time recovery reads it. */
export interface RunningCloneRow {
  readonly id: ProjectId;
  /** The clone's destination. */
  readonly folder_path: string;
  /** The folder the daemon made for the clone's git, or `null` before it made one. */
  readonly clone_staging_folder: string | null;
  /** That folder's `<device>:<inode>`, set with it. */
  readonly clone_staging_identity: string | null;
}

interface SessionFactsRow {
  readonly project_id: ProjectId;
  readonly activity: SessionActivity;
}

type ProjectScope = { readonly project_id: ProjectId | null };

/** The project reads, prepared once on the read-only connection. */
export class ProjectRecords {
  readonly #folderPlace: FolderPlace;
  readonly #selectRows: Statement<[ProjectScope], ProjectRow>;
  readonly #selectSessionFacts: Statement<[ProjectScope], SessionFactsRow>;
  readonly #selectRunningSessions: Statement<
    [ProjectScope],
    { readonly project_id: ProjectId; readonly session_id: SessionId }
  >;
  readonly #selectNamingOfMount: Statement<
    [string],
    { readonly slug: string; readonly branch_pattern: string | null }
  >;
  readonly #selectProjectOfWorktree: Statement<
    [string],
    { readonly setup: string; readonly environment_rows: string }
  >;
  readonly #selectProjectOfMount: Statement<[string], { readonly project_id: ProjectId | null }>;
  readonly #selectVcsOfMount: Statement<[string], { readonly vcs_type: string }>;
  readonly #selectArchivableSessionsOfProject: Statement<[string], { readonly id: SessionId }>;
  readonly #selectSlugTaken: Statement<[string]>;
  readonly #selectAttachedProjectFolders: Statement<[], AttachedProjectFolder>;
  readonly #selectRunningClones: Statement<[], RunningCloneRow>;

  constructor(reader: Database, folderPlace: FolderPlace) {
    this.#folderPlace = folderPlace;
    this.#selectRows = reader.prepare(PROJECT_ROWS_SQL);
    this.#selectSessionFacts = reader.prepare(PROJECT_SESSION_FACTS_SQL);
    this.#selectRunningSessions = reader.prepare(RUNNING_SESSIONS_SQL);
    this.#selectNamingOfMount = reader.prepare(NAMING_OF_MOUNT_SQL);
    this.#selectProjectOfWorktree = reader.prepare(PROJECT_OF_WORKTREE_SQL);
    this.#selectProjectOfMount = reader.prepare(PROJECT_OF_MOUNT_SQL);
    this.#selectVcsOfMount = reader.prepare(VCS_OF_MOUNT_SQL);
    this.#selectArchivableSessionsOfProject = reader.prepare(ARCHIVABLE_SESSIONS_OF_PROJECT_SQL);
    this.#selectSlugTaken = reader.prepare(SLUG_TAKEN_SQL);
    this.#selectAttachedProjectFolders = reader.prepare(ATTACHED_PROJECT_FOLDERS_SQL);
    this.#selectRunningClones = reader.prepare(RUNNING_CLONES_SQL);
  }

  /** Every project as the list draws it, oldest first. */
  readEntries(): ProjectListEntry[] {
    return this.#readEntries(null);
  }

  /** One project as the list draws it, or `undefined` when it does not exist. */
  readEntry(projectId: ProjectId): ProjectListEntry | undefined {
    return this.#readEntries(projectId)[0];
  }

  /** One project's row, or `undefined` when it does not exist. */
  readRow(projectId: ProjectId): ProjectRow | undefined {
    return this.#selectRows.get({ project_id: projectId });
  }

  /**
   * The naming facts of the project an attached mount serves. Throws when the mount serves none: a
   * chat's managed mount, or a mount whose project was forgotten.
   */
  readNaming(repoMountId: string): WorktreeProjectNaming {
    const row = this.#selectNamingOfMount.get(repoMountId);
    if (row === undefined) {
      throw new Error(`repo mount "${repoMountId}" serves no project`);
    }
    return { slug: row.slug, branchPattern: row.branch_pattern };
  }

  /** The setup steps of the project a worktree belongs to. Throws when it belongs to none. */
  readSetupOfWorktree(worktreeId: WorktreeId): ProjectSetup {
    return JSON.parse(this.#requireProjectOfWorktree(worktreeId).setup) as ProjectSetup;
  }

  /**
   * The environment rows of the project a worktree belongs to, which its setup commands run with.
   * Throws when it belongs to none.
   */
  readEnvironmentRowsOfWorktree(worktreeId: WorktreeId): EnvironmentRow[] {
    return JSON.parse(
      this.#requireProjectOfWorktree(worktreeId).environment_rows,
    ) as EnvironmentRow[];
  }

  /** The project a mount serves, or `null` for a chat's mount or a forgotten project. */
  readProjectOfMount(repoMountId: string): ProjectId | null {
    return this.#selectProjectOfMount.get(repoMountId)?.project_id ?? null;
  }

  /** The version control a mount's folder is kept in. Throws for a mount with no row. */
  readVcsOfMount(repoMountId: RepoMountId): VcsType {
    const row = this.#selectVcsOfMount.get(repoMountId);
    if (row === undefined) {
      throw new Error(`repo mount "${repoMountId}" has no row`);
    }
    return VcsTypeSchema.parse(row.vcs_type);
  }

  /** The project's active and still-provisioning sessions, oldest first. */
  readArchivableSessionsOf(projectId: ProjectId): SessionId[] {
    return this.#selectArchivableSessionsOfProject.all(projectId).map((row) => row.id);
  }

  /** Whether a project holds `slug`. */
  isSlugTaken(slug: string): boolean {
    return this.#selectSlugTaken.get(slug) !== undefined;
  }

  /** Every attached project's folder, the most recently attached first. */
  readAttachedProjectFolders(): AttachedProjectFolder[] {
    return this.#selectAttachedProjectFolders.all();
  }

  /** The clones recorded running, which no git runs for at the service's start. */
  readRunningClones(): RunningCloneRow[] {
    return this.#selectRunningClones.all();
  }

  #requireProjectOfWorktree(worktreeId: WorktreeId): {
    readonly setup: string;
    readonly environment_rows: string;
  } {
    const row = this.#selectProjectOfWorktree.get(worktreeId);
    if (row === undefined) {
      throw new Error(`worktree "${worktreeId}" belongs to no project`);
    }
    return row;
  }

  #readEntries(projectId: ProjectId | null): ProjectListEntry[] {
    const scope = { project_id: projectId };
    const sessions = new Map<ProjectId, SessionFactsRow[]>();
    for (const facts of this.#selectSessionFacts.all(scope)) {
      const held = sessions.get(facts.project_id);
      if (held === undefined) sessions.set(facts.project_id, [facts]);
      else held.push(facts);
    }
    // The oldest run comes first, so the first seen per project is the one named.
    const runningSessions = new Map<ProjectId, SessionId>();
    for (const running of this.#selectRunningSessions.all(scope)) {
      if (!runningSessions.has(running.project_id)) {
        runningSessions.set(running.project_id, running.session_id);
      }
    }
    return this.#selectRows.all(scope).map((row) => {
      const projectSessions = sessions.get(row.id) ?? [];
      return {
        projectId: row.id,
        repoMountId: row.repo_mount_id,
        name: row.name,
        folderPath: row.folder_path,
        state: row.state,
        sessionCount: projectSessions.length,
        runningSessionId: runningSessions.get(row.id) ?? null,
        sessionTally: tallyOf(projectSessions),
        setup: JSON.parse(row.setup) as ProjectSetup,
        environmentRows: JSON.parse(row.environment_rows) as EnvironmentRow[],
        branchPattern: row.branch_pattern,
        onOtherSideDisk: this.#folderPlace.isOnOtherSideDisk(row.folder_path),
      };
    });
  }
}

// How many of the sessions read running, waiting on the person and done, by the one activity
// reading the sessions list draws.
function tallyOf(sessions: readonly SessionFactsRow[]): ProjectListEntry["sessionTally"] {
  const tally = { running: 0, waiting: 0, done: 0 };
  for (const { activity } of sessions) {
    if (activity === "running" || activity === "waiting" || activity === "done") {
      tally[activity] += 1;
    }
  }
  return tally;
}
