/**
 * The diagnostic shapes a Codex service and its conversations report through, and the reporter
 * for a frame that arrives with no caller to act on a failure.
 */

import type { CodexRoleFileWithheldField } from "../session/helper-roles.js";

/** Cancelable timeout scheduler. Injected so tests never wait on real time. */
export type CodexScheduleTimeout = (callback: () => void, delayMs: number) => () => void;

/**
 * Everything the transport, the service and the deliveries could not route or carry out, as a
 * closed union so nothing drops silently, and the notices only the daemon's log keeps. Each names
 * what happened and a bounded reason, never a frame's own content, which can hold the person's
 * words, a file or a credential.
 */
export type CodexTransportDiagnostic =
  /** A message that is no JSON-RPC message, by why and how long it was. */
  | {
      kind: "unparsable-message";
      reason: "not-json" | "not-an-object" | "response-without-id";
      characterCount: number;
    }
  | { kind: "unknown-response-id"; responseId: string }
  | { kind: "unhandled-server-request"; method: string; censused: boolean }
  | { kind: "unrouted-server-request-refused"; method: string }
  | { kind: "server-request-responder-failed"; method: string; detail: string }
  /**
   * A routed ask named a turn with no live route, so it is refused: the sole-active fallback would
   * decide the approval against a run that never asked. Asks that publish no turn id still use the
   * fallback.
   */
  | {
      kind: "routed-ask-turn-unresolved";
      method: string;
      turnId: string | null;
      turnIdTruncated: boolean;
      disposition: "refused";
    }
  /**
   * A routed ask named no conversation this service holds for a session, so no session can answer
   * it and it is refused.
   */
  | { kind: "routed-ask-thread-unresolved"; method: string; threadId: string | null }
  /**
   * A routed ask's answer exceeded, encoded, the largest message the service said it takes, so the
   * provider gets the refusal {@link CODEX_OUTBOUND_ANSWER_TOO_LARGE_REASON}; twice if that does
   * not fit either, then nothing is sent.
   */
  | {
      kind: "server-request-answer-oversized";
      method: string;
      encodedByteLength: number;
      limit: number;
    }
  /**
   * The answer to an ask could not be sent; its caller may still be waiting for an answer that
   * never comes.
   */
  | { kind: "server-request-answer-write-failed"; method: string; detail: string }
  | { kind: "notification-write-failed"; method: string; detail: string }
  | { kind: "unconsumed-server-notification"; method: string }
  /**
   * The notification consumer (the daemon's own pure normalizer) threw; the notification is
   * dropped, not the connection. `detail` is normalized.
   */
  | { kind: "notification-consumer-failed"; method: string; detail: string }
  /**
   * A thread-scoped frame named a thread no session on this service holds, outside any start or
   * fork that could be about to claim it, so it is dropped.
   */
  | { kind: "unrouted-thread-frame"; method: string; threadId: string }
  /**
   * More frames waited for a thread a start or fork in flight was about to claim than the hold
   * keeps; the oldest was dropped.
   */
  | { kind: "pending-thread-frame-dropped"; method: string; threadId: string }
  /** The service's connection closed while its process still ran, or on the person's own one. */
  | { kind: "service-connection-dropped"; codexHome: string; detail: string }
  /** A restart or reconnect of a service failed; `detail` is normalized. */
  | { kind: "service-start-failed"; codexHome: string; detail: string }
  /**
   * A teardown step threw where the teardown carries on without it. `detail` is normalized.
   */
  | {
      kind: "teardown-step-failed";
      step:
        | "thread-unsubscribe"
        | "turn-interrupt"
        | "background-terminal-list"
        | "background-terminal-terminate"
        | "background-terminal-clean"
        | "service-stop";
      detail: string;
    }
  /** A conversation could not be resumed on its service after a restart, reconnect or move. */
  | { kind: "conversation-resume-failed"; threadId: string; detail: string }
  /** The connection to a service that kept running came back, and its conversations resumed. */
  | { kind: "service-reconnected"; codexHome: string; conversations: string[] }
  /**
   * A conversation moving to a new build stayed loaded on its old service past the deadline, held
   * by another client, so its resume on the new build went ahead without waiting longer.
   */
  | { kind: "conversation-unload-timed-out"; threadId: string }
  /** `thread/read` could not confirm a conversation unloaded; its resume decides. */
  | { kind: "conversation-unload-unconfirmed"; threadId: string; detail: string }
  /**
   * The fork that moves an idle conversation onto the session's chosen config failed; the
   * session's next turn forks again before it starts. `detail` is normalized.
   */
  | { kind: "conversation-fork-failed"; threadId: string; detail: string }
  /**
   * Codex reported a conversation running under a permission profile the daemon never asked for,
   * or none; the daemon asked for the session's own posture again.
   */
  | {
      kind: "permission-profile-drifted";
      threadId: string;
      activeProfile: string;
      expectedProfile: string;
    }
  /** The ask that sets a drifted conversation back to the session's posture failed. */
  | { kind: "permission-profile-restore-failed"; threadId: string; detail: string }
  /**
   * An item's final text does not continue the pieces already streamed for it; those pieces
   * stand and nothing more of it is written.
   */
  | { kind: "streamed-text-diverged"; threadId: string; itemId: string }
  /** The messages a continue waited to steer in could not be delivered once its pause failed. */
  | { kind: "continue-steer-failed"; threadId: string; detail: string }
  /** A pause's interrupt at the step boundary failed, so the turn runs on and no pause lands. */
  | { kind: "pause-interrupt-failed"; threadId: string; detail: string }
  /**
   * The auth read that classifies a failed resume threw, so the resume reads `recovery-needed`.
   * `detail` is normalized.
   */
  | { kind: "resume-auth-classification-failed"; detail: string }
  /**
   * A `thread/fork` response's turn list did not corroborate the fork (an absent list reads as
   * zero). Reported, not fatal.
   */
  | {
      kind: "fork-turn-ledger-unconfirmed";
      expectedTurnCount: number;
      confirmedTurnCount: number;
    }
  /** A helper definition's field its role file cannot carry; the helper runs without it. */
  | {
      kind: "subagent-definition-field-withheld";
      definitionName: string;
      field: CodexRoleFileWithheldField;
    }
  /**
   * The session owed terminals to more interrupted runs than it remembers, so its conversation
   * was ended rather than lose one silently.
   */
  | { kind: "interrupted-route-memory-overflowed"; retainedTurnCount: number }
  /** A port the daemon wired refused what the driver handed it; `detail` is normalized. */
  | {
      kind: "port-delivery-failed";
      port:
        | "run-end"
        | "session-relaunched"
        | "permission-ask"
        | "question"
        | "reviewer-denial"
        | "server-prompts"
        | "output-speed";
      /** `null` where the failure belongs to no one session. */
      sessionId: string | null;
      detail: string;
    }
  /**
   * The run engine refused or failed a delivery; `method` names the provider frame it came from,
   * `null` for the driver's own. `detail` is normalized.
   */
  | {
      kind: "delivery-dispatch-failed";
      method: string | null;
      deliveryKind: string;
      sessionId: string;
      detail: string;
    }
  /** A session's command list could not be read for a listener following it. */
  | { kind: "provider-command-list-failed"; sessionId: string; detail: string }
  /** A side question's throwaway turn ended without an answer. */
  | { kind: "side-question-unanswered"; sessionId: string; detail: string }
  /** A frame the driver reads only into the daemon's log, by its method. */
  | { kind: "provider-notice-logged"; method: string; sessionId: string }
  /** A frame whose run no live route, interrupt or starting turn names, so nothing is written. */
  | { kind: "unattributed-turn-frame"; method: string; turnId: string | null }
  /** A turn too long for the model's window that could not be cut out of the conversation. */
  | { kind: "oversized-turn-cut-failed"; sessionId: string; detail: string }
  /** The run of a turn Codex started by itself could not open; the turn's frames go unheld. */
  | { kind: "provider-turn-run-failed"; sessionId: string; detail: string }
  /**
   * The frames held while a turn Codex started opens its run went on before the run opened: the
   * hold filled or outlived its deadline.
   */
  | {
      kind: "provider-turn-frames-released";
      sessionId: string;
      reason: "hold-full" | "hold-deadline";
      frameCount: number;
    }
  /** A hook input the daemon could not read or answer; a pre-tool one was denied. */
  | { kind: "hook-answer-failed"; detail: string };

/** Required: a no-op default would reintroduce silent drops. */
export type CodexDiagnosticSink = (diagnostic: CodexTransportDiagnostic) => void;

/**
 * Reports a diagnostic from a frame with no caller to act on failure, so a throwing sink cannot
 * unwind the message handler and hang the requests behind it.
 */
export function reportDiagnosticFromDetachedFrame(
  sink: CodexDiagnosticSink,
  diagnostic: CodexTransportDiagnostic,
): void {
  try {
    sink(diagnostic);
  } catch {
    // The sink is the reporting channel itself; the frame's remaining work matters more.
  }
}

/** Server-initiated notification sink (the provider event stream). */
export type CodexServerNotificationSink = (method: string, params: unknown) => void;
