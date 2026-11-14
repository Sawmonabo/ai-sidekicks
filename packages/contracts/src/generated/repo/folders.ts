// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The folders the service can reach and where each came from, browsing the machine's folders, one folder's attach, read, detach and re-attach, and the details of their refusals.

import type { WireInstant } from "../internal/wire-scalars.js";
import type { MachineId } from "../machine/id.js";
import type { Place, WslPlace } from "../place.js";
import type { ProjectId } from "../project.js";
import type { SessionId } from "../session/id.js";
import type { RunningHolder, WorktreeId } from "../worktree/lifecycle.js";
import type {
  RepoMountHealth,
  RepoMountId,
  RepoMountState,
  VcsType,
  WorkspaceId,
} from "./mount.js";

/**
 * The longest system reason a `repoMount.rootResolutionFailed` refusal carries, in code
 * points: room for any system's own message, which is a sentence.
 */
export const ROOT_RESOLUTION_DETAIL_MAX_LEN = 1024 as const;

/**
 * Where a folder the service can reach came from, carrying the ids its removal act takes: a
 * project's folder the person attached (removed by the project's detach); a chat's own workspace,
 * which goes only when that session is purged; or a worktree the app made (removed by its
 * retire).
 */
export type RepoMountOrigin =
  | {
      kind: "attached";
      /**
       * The mount.
       */
      repoMountId: RepoMountId;
      /**
       * Its project.
       */
      projectId: ProjectId;
    }
  | {
      kind: "managed";
      /**
       * The mount.
       */
      repoMountId: RepoMountId;
      /**
       * The one chat that owns it.
       */
      sessionId: SessionId;
    }
  | {
      kind: "worktree";
      /**
       * The worktree.
       */
      worktreeId: WorktreeId;
      /**
       * Its project.
       */
      projectId: ProjectId;
    };
/**
 * What `machine.folder.list` takes: one folder, or the top level of a Windows computer. macOS and
 * Linux have no top level and refuse it.
 */
export type MachineFolderListRequest =
  | {
      /**
       * Never present: this asks for a folder.
       */
      top?: never;
      /**
       * The distribution to browse; absent on macOS and Linux and for Windows itself.
       */
      place?: WslPlace;
      /**
       * The folder to show, in that place's own form.
       */
      path?: string;
      /**
       * The text that narrows its folders.
       */
      filter?: string;
      /**
       * Whether hidden folders are listed.
       */
      showHidden?: boolean;
    }
  | {
      /**
       * Always `true`.
       */
      top: true;
    };
/**
 * One step of the path to the folder in view, pressable to go back to it: on Windows the first is
 * the top level, so the device can go back up and change drive or distribution; every other step
 * is a folder.
 */
export type MachineFolderPathSegment =
  | {
      kind: "top";
    }
  | {
      kind: "folder";
      /**
       * Its name, which may be only spaces.
       */
      name: string;
      /**
       * Its path.
       */
      path: string;
    };
/**
 * One entry of a Windows computer's top level: a drive, or a WSL 2 distribution, which opens on
 * its home folder through `machine.folder.list` with its place.
 */
export type MachineFolderTopEntry =
  | {
      kind: "drive";
      /**
       * Its root folder.
       */
      path: string;
    }
  | {
      kind: "distribution";
      /**
       * Its place.
       */
      place: WslPlace;
    };
/**
 * The `machine.folder.list` result: one folder, or the top level of a Windows computer.
 */
export type MachineFolderListResponse =
  | {
      /**
       * Never present: this is a folder.
       */
      top?: never;
      /**
       * Where the folder in view is; absent on macOS and Linux.
       */
      place?: Place;
      /**
       * The folder in view.
       */
      path: string;
      /**
       * The path's segments, at least the folder in view.
       *
       * @minItems 1
       */
      segments: [MachineFolderPathSegment, ...MachineFolderPathSegment[]];
      /**
       * Its folders.
       */
      entries: MachineFolderListEntry[];
      /**
       * Whether the filter would narrow further.
       */
      more: boolean;
    }
  | {
      /**
       * Always `true`.
       */
      top: true;
      /**
       * The drives, then the distributions.
       */
      entries: MachineFolderTopEntry[];
    };
/**
 * Why a folder was refused `repoMount.outsideTrustEnvelope`.
 */
export type RepoMountOutsideTrustEnvelopeReason = "outsideProject" | "worktreeRemoved";
/**
 * Why a `repoMount.rootResolutionFailed` refusal could not resolve a path's canonical repository
 * root: the path is missing, unreadable or not absolute, git could not answer for it, its working
 * tree is not one git names for the repository, git reports a folder with no visible `.git`
 * entry is not a repository, or the resolved path is not valid Unicode or is longer than the
 * wire's path cap.
 */
export type RepoMountRootResolutionReason =
  | "pathNotFound"
  | "notReadable"
  | "vcsError"
  | "notAbsolute"
  | "rootMismatch"
  | "notARepository"
  | "notUnicode"
  | "pathTooLong";
/**
 * Why a re-attach was refused.
 */
export type RepoMountReattachRefusedReason = "identityMatches";

/**
 * One folder the service can reach, with how many sessions use it and, on a Windows computer,
 * where it is.
 */
export interface RepoMountListEntry {
  /**
   * The folder.
   */
  path: string;
  /**
   * Where it came from.
   */
  origin: RepoMountOrigin;
  /**
   * How many sessions use it.
   */
  usingSessionCount: number;
  /**
   * Where it is; absent on macOS and Linux.
   */
  place?: Place;
}
/**
 * The `repoMount.list` result.
 */
export interface RepoMountListResponse {
  /**
   * Every folder.
   */
  mounts: RepoMountListEntry[];
}
/**
 * One folder in a listing.
 */
export interface MachineFolderListEntry {
  /**
   * Its name, which may be only spaces.
   */
  name: string;
  /**
   * Its path.
   */
  path: string;
  /**
   * Whether it is a git repository.
   */
  isRepository: boolean;
}
/**
 * `repoMount.attach`: a path on the machine the service runs on, the folder the platform's chooser
 * returned or, from another device, a folder `machine.folder.list` showed. A Linux path comes with
 * the WSL 2 distribution it was given in, since the path alone does not say which one holds it;
 * without a place, the path's own form says where it is (a drive path on Windows, a
 * `\\wsl.localhost\<distro>\` path in that distribution). The folder's own disk sets the mount's
 * place, so a Windows drive reached from a distribution is on Windows. The path is kept as
 * entered; absoluteness, traversal and existence are the resolver's to refuse, a path that is not
 * a git repository is refused, and so is a distribution that runs on WSL 1 or is not on this
 * computer.
 */
export interface RepoMountAttachRequest {
  /**
   * The path as entered.
   */
  localPath: string;
  /**
   * The distribution a Linux path was given in; absent on macOS and Linux and wherever the
   * path's own form says, Windows itself among them.
   */
  place?: WslPlace;
}
/**
 * The `repoMount.attach` result: the new mount and the root its path resolved to.
 */
export interface RepoMountAttachResponse {
  /**
   * The mount.
   */
  repoMountId: RepoMountId;
  /**
   * Its state.
   */
  state: RepoMountState;
  /**
   * Its version-control system.
   */
  vcsType: VcsType;
  /**
   * The resolver's absolute, symlink-resolved root, never the entered path, in its place's own
   * form.
   */
  canonicalRoot: string;
  /**
   * Where the root is, fixed for the mount's life; absent on macOS and Linux.
   */
  place?: Place;
}
/**
 * `repoMount.read`, `repoMount.detach` and `repoMount.reattach`: the mount to act on.
 */
export interface RepoMountRequest {
  /**
   * The mount.
   */
  repoMountId: RepoMountId;
}
/**
 * One session using a folder.
 */
export interface RepoMountUser {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * One mount as `repoMount.read` reports it, with a freshly probed health verdict.
 */
export interface RepoMountReadResponse {
  /**
   * The mount.
   */
  id: RepoMountId;
  /**
   * The machine's daemon that holds it.
   */
  machineId: MachineId;
  /**
   * The path as entered; it differs from `canonicalRoot` when entered inside or via a link.
   */
  localPath: string;
  /**
   * The resolved root.
   */
  canonicalRoot: string;
  /**
   * Where both paths are, in that place's own form; absent on macOS and Linux.
   */
  place?: Place;
  /**
   * Its version-control system.
   */
  vcsType: VcsType;
  /**
   * Its state.
   */
  state: RepoMountState;
  /**
   * Its health, probed for this read.
   */
  health: RepoMountHealth;
  /**
   * When it was attached.
   */
  attachedAt: WireInstant;
  /**
   * Where it came from.
   */
  origin: RepoMountOrigin;
  /**
   * Its project's name, absent on a chat's own workspace, which belongs to no project.
   */
  displayName?: string;
  /**
   * The sessions using it.
   */
  usedBy: RepoMountUser[];
}
/**
 * The `repoMount.detach` result. Detaching is a project's `Delete`: the mount turns `detached` for
 * good, every dependent workspace is archived, the project record is forgotten with its setup
 * steps, and the project's sessions are archived and stay readable. Nothing on disk is touched.
 */
export interface RepoMountDetachResponse {
  /**
   * The mount.
   */
  repoMountId: RepoMountId;
  /**
   * Its state.
   */
  state: RepoMountState;
  /**
   * The workspaces archived.
   */
  archivedWorkspaceIds: WorkspaceId[];
  /**
   * The sessions archived.
   */
  archivedSessionIds: SessionId[];
  /**
   * The project this call forgot, `null` when the mount was already detached.
   */
  forgottenProjectId: ProjectId | null;
}
/**
 * The details of a `repoMount.outsideTrustEnvelope` refusal: its reason and no path, since the
 * caller already holds the folder it sent.
 */
export interface RepoMountOutsideTrustEnvelopeDetails {
  /**
   * Why.
   */
  reason: RepoMountOutsideTrustEnvelopeReason;
}
/**
 * The details of a `repoMount.rootResolutionFailed` refusal: its reason, the system's own words
 * for it where the system gave any, and no path, since the message never echoes the path tried.
 */
export interface RepoMountRootResolutionFailedDetails {
  /**
   * Why.
   */
  reason: RepoMountRootResolutionReason;
  /**
   * The system's own reason a folder could not be read (`Permission denied`), shown beside it;
   * absent where the system gave none. Never a path.
   */
  detail?: string;
}
/**
 * The details of a `repoMount.alreadyAttached` refusal: the mount that holds the repository and
 * its project, `null` when the holder is a chat's own workspace. No path.
 */
export interface RepoMountAlreadyAttachedDetails {
  /**
   * The mount holding the repository.
   */
  conflictingRepoMountId: RepoMountId;
  /**
   * Its project.
   */
  conflictingProjectId: ProjectId | null;
}
/**
 * The `repoMount.reattach` result: the new mount. The old one turns `detached` and the folder is
 * attached fresh under the same project record, keeping its sessions and their workspaces.
 */
export interface RepoMountReattachResponse {
  /**
   * The new mount.
   */
  repoMountId: RepoMountId;
}
/**
 * The details of a `repoMount.reattachRefused` refusal.
 */
export interface RepoMountReattachRefusedDetails {
  /**
   * Why.
   */
  reason: RepoMountReattachRefusedReason;
}
/**
 * The details of a `repoMount.reattachConflict` refusal: the run live in the project and its
 * session.
 */
export interface RepoMountReattachConflictDetails {
  /**
   * The session running there.
   */
  runningSessionId: SessionId;
  /**
   * The run.
   */
  runningHolder: RunningHolder;
}
