// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A project: the durable record beside a mount that the person names, with its setup steps, its own environment rows and its own branch pattern.

import type { BranchNamePattern, EnvironmentRow } from "./machine/settings.js";
import type { Place } from "./place.js";
import type { RepoMountId } from "./repo/mount.js";
import type { SessionId } from "./session/id.js";

/** The longest project name the daemon keeps. */
export const PROJECT_NAME_MAX_LEN = 256 as const;

/**
 * The longest setup command the daemon keeps: a command line the person types, bounded
 * generously so no command a shell accepts is refused for its length.
 */
export const PROJECT_SETUP_COMMAND_MAX_LEN = 8192 as const;

/**
 * The daemon-minted id of a project: the record beside a mount that the person names.
 */
export type ProjectId = string & { readonly __brand: "ProjectId" };
/**
 * A project's life: `cloning` from the first press of `Clone` until the clone attaches (a failed
 * or canceled clone stays `cloning`, so it can be run again), then `active`, and `archived` while
 * it sits in the archived group.
 */
export type ProjectState = "cloning" | "active" | "archived";

/**
 * What runs after a worktree is made in the project: files copied into the new tree, then
 * commands run in order, each given up on after the time limit when one is set. The steps run
 * with the repository's own git config, its hooks included, and never raise an approval, so only
 * the person writes them.
 */
export interface ProjectSetup {
  /**
   * Paths inside the repository copied into each new tree.
   */
  filesToCopy: string[];
  /**
   * Commands run in order.
   */
  commands: string[];
  /**
   * Seconds each command is given up on after; absent means no limit. At most 2^31 − 1 ms in
   * whole seconds, the longest delay a timer keeps.
   */
  timeLimitSeconds?: number;
}
/**
 * How many of a project's sessions are running, waiting on the person and done.
 */
export interface ProjectSessionTally {
  /**
   * Running.
   */
  running: number;
  /**
   * Waiting on the person.
   */
  waiting: number;
  /**
   * Done.
   */
  done: number;
}
/**
 * One project as the Projects page and the session list's project headers draw it.
 */
export interface ProjectListEntry {
  /**
   * The project.
   */
  projectId: ProjectId;
  /**
   * `null` while the project is still cloning; the mount is made when the clone attaches.
   */
  repoMountId: RepoMountId | null;
  /**
   * Its name.
   */
  name: string;
  /**
   * Its folder, in its place's own form.
   */
  folderPath: string;
  /**
   * Its life.
   */
  state: ProjectState;
  /**
   * How many sessions it has.
   */
  sessionCount: number;
  /**
   * A session with an agent running anywhere in the project, or `null`.
   */
  runningSessionId: SessionId | null;
  /**
   * How many of its sessions are running, waiting on the person and done.
   */
  sessionTally: ProjectSessionTally;
  /**
   * Its setup steps.
   */
  setup: ProjectSetup;
  /**
   * The project's own rows, each winning over the `Every project` row of the same name.
   */
  environmentRows: EnvironmentRow[];
  /**
   * `null` while the project follows the machine's pattern.
   */
  branchPattern: BranchNamePattern | null;
  /**
   * Where its folder is and its sessions run, fixed at attach; absent on macOS and Linux.
   */
  place?: Place;
  /**
   * Present when the project's distribution is no longer on this computer, so its sessions
   * cannot run and the row offers `Remove`.
   */
  isDistributionRemoved?: true;
}
/**
 * One `project.subscribe` emission: every project, sent once on subscribe and again on each
 * change, so a project attached or cloned from another device appears at once.
 */
export interface ProjectList {
  /**
   * Every project.
   */
  projects: ProjectListEntry[];
}
/**
 * The project an edit acts on, as every project edit's reply returns it.
 */
export interface ProjectEditResponse {
  /**
   * The project as edited.
   */
  project: ProjectListEntry;
}
/**
 * `project.rename`: the project's display name; the folder on disk is untouched.
 */
export interface ProjectRenameRequest {
  /**
   * The project.
   */
  projectId: ProjectId;
  /**
   * Its new name.
   */
  name: string;
}
/**
 * `project.archive` and `project.reactivate`: the project to move into or out of the
 * archived group. Its sessions are kept either way, and archiving an archived project, or
 * reactivating an active one, changes nothing.
 */
export interface ProjectStateChangeRequest {
  /**
   * The project.
   */
  projectId: ProjectId;
}
/**
 * `project.setup.update`: the whole setup, replacing what the project had.
 */
export interface ProjectSetupUpdateRequest {
  /**
   * The project.
   */
  projectId: ProjectId;
  /**
   * Its setup.
   */
  setup: ProjectSetup;
}
/**
 * `project.environment.update`: the project's whole list of rows, replacing what it had. A row
 * whose name the environment-name rule refuses is refused with `project.environment.nameRefused`
 * naming the row, and nothing is written.
 */
export interface ProjectEnvironmentUpdateRequest {
  /**
   * The project.
   */
  projectId: ProjectId;
  /**
   * Its rows.
   */
  environmentRows: EnvironmentRow[];
}
/**
 * `project.branchPattern.update`: the project's own branch pattern, or `null` to return the
 * project to the machine's pattern. A pattern git refuses, or one that clashes with a branch in
 * the repository, is refused and nothing is written.
 */
export interface ProjectBranchPatternUpdateRequest {
  /**
   * The project.
   */
  projectId: ProjectId;
  /**
   * Its pattern, or `null` for the machine's.
   */
  pattern: string | null;
}
