// The props the composed new-session draft control takes, and what it hands back.
//
// The callback carries a session id and nothing else. What the app does with a session it just
// started (open its store, declare the session directory stale, navigate) is
// `features/sessions/start/session-start.ts`, because each step names a store or a route the
// draft does not hold.

import type { AgentProviderBinding } from "@ai-sidekicks/contracts";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";

/**
 * The call that puts the person's first message on the queue of the session a send made.
 *
 * Rejects when the message could not be queued, and the send then reports what landed.
 */
export type FirstTurnQueueCall = (request: {
  readonly sessionId: string;
  readonly content: string;
}) => Promise<void>;

/** What the sessions destination hands the composed draft control. */
export interface NewSessionControlProps {
  /**
   * The transport the draft composes against and sends through. The draft is held on this
   * bridge, so a replacement discards it rather than sending through a retired transport.
   */
  readonly bridge: PlatformBridge;
  /** The call the send makes once the session exists, to queue the first message. */
  readonly queueFirstTurn: FirstTurnQueueCall;
  /**
   * The lead a new session starts on: its provider, model, account and effort. The control
   * offers no model or effort choice of its own, so the composition that mounts it names
   * the lead, and a draft opened later starts on the lead named then.
   */
  readonly lead: AgentProviderBinding;
  /**
   * The session a completed send produced, told once when it completed. Not called for a
   * partial send: the draft stays for it, and navigating away would hide the refusal that
   * says what to do next. Needs no stable identity; the control reads the committed callback
   * when it settles.
   */
  readonly onSessionCreated: (sessionId: string) => void;
  /**
   * Ask the destination to re-read the session directory. It is the one act left
   * after a create whose reply this build could not read, and the destination's because the
   * directory is not held by the draft. Needs no stable identity, since a press reads it.
   */
  readonly onSessionDirectoryRecheck: () => void;
}
