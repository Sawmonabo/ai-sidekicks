// What each permission level sends Codex: the permission profile a conversation runs under, who
// reviews its asks, when it asks at all, and how connector tools ask by default. Below YOLO every
// profile is the daemon's own, defined inline in each conversation's `config` under a name unique
// to the repository; YOLO is Codex's own full access, never the legacy `sandbox` member, which
// leaves the conversation with no active profile.

import { createHash } from "node:crypto";
import path from "node:path";

import type { ProviderMode } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { PermissionLevel } from "@ai-sidekicks/contracts/session/controls/methods";

/** Codex's own full-access profile, which YOLO selects. */
const CODEX_FULL_ACCESS_PROFILE = ":danger-full-access";

/** The levels that run under one of the daemon's own profiles. */
type CodexDaemonProfileLevel = Exclude<PermissionLevel, "yolo">;

const CODEX_DAEMON_PROFILE_LEVELS: readonly CodexDaemonProfileLevel[] = [
  "readonly",
  "ask",
  "reviewed",
  "sandboxed",
];

// Hex digits of the repository root's SHA-256 a profile name keeps: enough that two repositories
// the person works in never share a name.
const REPOSITORY_HASH_LENGTH = 16;

/** Who Codex routes an ask to (`ApprovalsReviewer`). */
type CodexApprovalsReviewer = "user" | "auto_review";

/** How Codex approves a connector's tool calls (`AppToolApproval`). */
type CodexConnectorApprovalMode = "writes" | "approve";

/** One filesystem entry's access, as Codex's profiles spell it. */
type CodexFilesystemAccess = "read" | "write" | "deny";

/** One profile as a conversation's `config.permissions` defines it. */
interface CodexPermissionProfile {
  readonly extends: ":read-only" | ":workspace";
  readonly filesystem: Readonly<Record<string, CodexFilesystemAccess>>;
}

/** The folders and denies one conversation's profiles are built from. */
export interface CodexProfileFolders {
  /** The conversation's working folder: its worktree, absolute. */
  readonly workingDirectory: string;
  /**
   * The repository's git folder, absolute: the common one for a linked worktree. Absent outside
   * a repository.
   */
  readonly gitCommonFolder: string | undefined;
  /** More folders the posture lets the conversation write, absolute. */
  readonly writableRoots: readonly string[];
  /** The credential paths no level may read, absolute. */
  readonly denyPaths: readonly string[];
}

/** The thread members one level sets on start, resume, fork and a level move. */
export interface CodexLevelSettings {
  /** The profile id the thread selects. */
  readonly permissions: string;
  readonly approvalPolicy: "on-request" | "never";
  readonly approvalsReviewer: CodexApprovalsReviewer;
}

/**
 * The profile id a level selects for one repository: `sidekicks-<level>-<hash of the repository
 * root>` below YOLO, so a profile the person defined never collides with it, and Codex's full
 * access at YOLO.
 */
export function composeCodexProfileName(
  level: PermissionLevel,
  folders: CodexProfileFolders,
): string {
  if (level === "yolo") {
    return CODEX_FULL_ACCESS_PROFILE;
  }
  // The repository root is the common git folder's parent, so every worktree of one repository
  // shares its profiles; outside a repository it is the working folder.
  const repositoryRoot =
    folders.gitCommonFolder === undefined
      ? folders.workingDirectory
      : path.dirname(folders.gitCommonFolder);
  const hash = createHash("sha256").update(repositoryRoot).digest("hex");
  return `sidekicks-${level}-${hash.slice(0, REPOSITORY_HASH_LENGTH)}`;
}

/**
 * Who answers Codex's asks at a level: Codex's own automatic reviewer at Reviewed, which is what
 * that level means, and the person, through the daemon's approvals, at every other level.
 */
export function composeCodexApprovalsReviewer(level: PermissionLevel): CodexApprovalsReviewer {
  return level === "reviewed" ? "auto_review" : "user";
}

/** The members a level sends on a thread for one repository. */
export function composeCodexLevelSettings(
  level: PermissionLevel,
  folders: CodexProfileFolders,
): CodexLevelSettings {
  return {
    permissions: composeCodexProfileName(level, folders),
    // Sandboxed never asks: a command the profile refuses fails with Codex's own sentence. YOLO
    // asks on request so Codex's own forced-removal check still reaches the person.
    approvalPolicy: level === "sandboxed" ? "never" : "on-request",
    approvalsReviewer: composeCodexApprovalsReviewer(level),
  };
}

/**
 * The connectors' defaults a level sets, only as `apps._default`, so a reviewer or approval mode
 * the person set for one app or tool keeps its own: `writes` below YOLO, so a tool not marked
 * read-only asks, and `approve` at YOLO, so each runs unasked. Codex reads a connector ask's
 * reviewer from the `apps` table before the conversation's, so it carries the level's too.
 */
export function composeCodexConnectorDefaults(level: PermissionLevel): Record<string, string> {
  const approvalMode: CodexConnectorApprovalMode = level === "yolo" ? "approve" : "writes";
  return {
    "apps._default.default_tools_approval_mode": approvalMode,
    "apps._default.approvals_reviewer": composeCodexApprovalsReviewer(level),
  };
}

/**
 * The `config` members that define every daemon profile and select the level's. All four are
 * defined on every conversation, so a later level move selects one its config already holds;
 * `default_permissions` sits in `config` too, since a profile selected only through the thread
 * member breaks a service-wide tool-server reload.
 */
export function composeCodexPermissionConfig(
  level: PermissionLevel,
  folders: CodexProfileFolders,
): { readonly permissions: Record<string, CodexPermissionProfile>; default_permissions: string } {
  const denies = Object.fromEntries(folders.denyPaths.map((denied) => [denied, "deny" as const]));
  const writableRoots = Object.fromEntries(
    folders.writableRoots.map((root) => [root, "write" as const]),
  );
  // `:workspace` makes both temporary folders writable by itself; they stay readable only, so
  // nothing outside the worktree is written where the daemon's own data could stand.
  const workspaceBase = { ":tmpdir": "read", ":slash_tmp": "read", ...writableRoots } as const;
  const workspace: CodexPermissionProfile = {
    extends: ":workspace",
    filesystem: { ...workspaceBase, ...denies },
  };
  const profileByLevel: Readonly<Record<CodexDaemonProfileLevel, CodexPermissionProfile>> = {
    readonly: { extends: ":read-only", filesystem: denies },
    ask: workspace,
    reviewed: workspace,
    sandboxed: {
      extends: ":workspace",
      filesystem: { ...workspaceBase, ...composeRepositoryEntries(folders), ...denies },
    },
  };
  return {
    permissions: Object.fromEntries(
      CODEX_DAEMON_PROFILE_LEVELS.map((profileLevel) => [
        composeCodexProfileName(profileLevel, folders),
        profileByLevel[profileLevel],
      ]),
    ),
    default_permissions: composeCodexProfileName(level, folders),
  };
}

/**
 * The per-repository entries at Sandboxed: the git folder is writable so a commit lands without
 * asking, while its `hooks` and `config`, and a linked worktree's `.git` pointer, stay read-only,
 * so no agent plants a hook or repoints the hooks path.
 */
function composeRepositoryEntries(
  folders: CodexProfileFolders,
): Record<string, CodexFilesystemAccess> {
  const gitCommonFolder = folders.gitCommonFolder;
  if (gitCommonFolder === undefined) {
    return {};
  }
  const pointer = path.join(folders.workingDirectory, ".git");
  return {
    [gitCommonFolder]: "write",
    [path.join(gitCommonFolder, "hooks")]: "read",
    [path.join(gitCommonFolder, "config")]: "read",
    // In a plain checkout the `.git` folder is the git folder itself and stays writable.
    ...(pointer === gitCommonFolder ? {} : { [pointer]: "read" }),
  };
}

/**
 * The levels a Codex session can run at, each named by the profile it selects: Codex's full access
 * at YOLO, and below it the daemon's profile name, which each repository's hash completes.
 */
export function listCodexModes(): ProviderMode[] {
  return [
    ...CODEX_DAEMON_PROFILE_LEVELS.map((level) => ({ id: level, name: `sidekicks-${level}` })),
    { id: "yolo", name: CODEX_FULL_ACCESS_PROFILE },
  ];
}
