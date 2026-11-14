// The props the new-session control takes, and what it hands back.
//
// The callback carries a session id and nothing else. What the app does with a session it just
// started (open its store, declare the session directory stale, navigate) is
// `features/sessions/start.ts`, because each step names a store or a route the control does not
// hold.

import type { ProjectId } from "@ai-sidekicks/contracts/project";
import type { ExecutionMode } from "@ai-sidekicks/contracts/repo/mount";
import type { SessionLead } from "@ai-sidekicks/contracts/session/directory";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";

/** A recent project the picker offers: its name, and where a session in it works. */
export interface NewSessionProject {
  readonly projectId: ProjectId;
  /** The row's words: the project's own name. */
  readonly name: string;
  /** A worktree of the session's own, or the checkout the project already has. */
  readonly executionMode: ExecutionMode;
}

/** What the sessions list hands the new-session control. */
export interface NewSessionControlProps {
  /** The transport a pick creates its session through. */
  readonly bridge: PlatformBridge;
  /**
   * The lead a new session starts on: its provider, model and effort. The picker offers no
   * model or effort choice of its own, so the list that mounts it names the lead.
   */
  readonly lead: SessionLead;
  /** The picker's recent projects, under `Just chat`, in the order they are drawn. */
  readonly recentProjects: readonly NewSessionProject[];
  /**
   * The session a pick made, told once its create answered. Needs no stable identity; the
   * control reads the committed callback when the create settles.
   */
  readonly onSessionCreated: (sessionId: string) => void;
}
