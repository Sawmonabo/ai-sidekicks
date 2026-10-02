/**
 * The listener, subscriber and diagnostic shapes a Codex session reports through, and the reporter
 * for a frame that arrives after its session is gone.
 */

/** Per-session view of the two process-wide `PtyHost` sinks. */
export interface CodexPtySessionListeners {
  onData(chunk: Uint8Array): void;
  onExit(exitCode: number, signalCode?: number): void;
}

/**
 * Subscribes to one pty session's data/exit stream, returning an unsubscribe; the host's sinks are
 * process-wide, so the composition root demultiplexes.
 */
export type CodexPtySessionSubscriber = (
  ptySessionId: string,
  listeners: CodexPtySessionListeners,
) => () => void;

/** Cancelable timeout scheduler. Injected so tests never wait on real time. */
export type CodexScheduleTimeout = (callback: () => void, delayMs: number) => () => void;

/**
 * Everything the transport could not route, as a closed union so nothing drops silently. Supplying
 * `onServerNotification` moves provider events off `unconsumed-server-notification`.
 */
export type CodexTransportDiagnostic =
  | { kind: "unparsable-line"; line: string }
  | { kind: "line-too-long"; retainedLength: number; limit: number }
  | { kind: "unknown-response-id"; responseId: string }
  | { kind: "echoed-client-frame"; method: string }
  | { kind: "unhandled-server-request"; method: string; censused: boolean }
  | { kind: "unrouted-server-request-refused"; method: string }
  | { kind: "callback-tools-withheld"; withheldToolCount: number; reason: string }
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
   * A routed ask's answer exceeded {@link CODEX_MAX_LINE_LENGTH} encoded, so the provider gets the
   * refusal {@link CODEX_OUTBOUND_ANSWER_TOO_LARGE_REASON}; twice if that does not fit either,
   * then nothing is sent.
   */
  | {
      kind: "server-request-answer-oversized";
      method: string;
      encodedByteLength: number;
      limit: number;
    }
  /**
   * The exit path says the process died, not that this ask went unanswered; its caller may still
   * be waiting for an answer that never comes.
   */
  | { kind: "server-request-answer-write-failed"; method: string; detail: string }
  | { kind: "notification-write-failed"; method: string; detail: string }
  | { kind: "unconsumed-server-notification"; method: string }
  /**
   * The notification consumer (the daemon's own pure normalizer) threw; the notification is
   * dropped, not the connection. `detail` is normalized.
   */
  | { kind: "notification-consumer-failed"; method: string; detail: string }
  | { kind: "process-exited"; exitCode: number; signalCode: number | null }
  /** A disposer threw during teardown with no caller to rethrow to; `detail` is normalized. */
  | { kind: "subscription-dispose-failed"; detail: string }
  /**
   * A teardown step threw where the teardown carries on without it: a failed `pty-kill` or
   * `pty-close` may leave the child running. `detail` is normalized.
   */
  | {
      kind: "teardown-step-failed";
      step: "pty-kill" | "pty-close" | "thread-unsubscribe" | "session-disposal";
      detail: string;
    }
  /**
   * The auth read that classifies a failed resume threw, so the resume reads `recovery-needed`.
   * `detail` is normalized.
   */
  | { kind: "resume-auth-classification-failed"; detail: string }
  /**
   * A `thread/fork` response's turn list did not corroborate the rewind (an absent list reads as
   * zero). Reported, not fatal.
   */
  | {
      kind: "fork-turn-ledger-unconfirmed";
      expectedTurnCount: number;
      confirmedTurnCount: number;
    }
  /** A domain allow-list was requested but the network axis is a boolean; spawned denied. */
  | { kind: "posture-network-allowlist-narrowed"; deniedDomainCount: number }
  /**
   * The realized sandbox policy is wider than the posture demanded (unrecognized config keys are
   * silently ignored). Reported, not fatal.
   */
  | {
      kind: "posture-realization-diverged";
      requestedNetworkAccess: boolean;
      realizedNetworkAccess: boolean;
    }
  /** A subagent definition was withheld from the spawn rather than admitted unenforceable. */
  | { kind: "subagent-definition-withheld"; definitionName: string; reason: string }
  | { kind: "turn-evidence-memory-overflowed"; retainedTurnCount: number }
  | { kind: "settled-turn-memory-overflowed"; retainedTurnCount: number }
  | { kind: "interrupted-route-memory-overflowed"; retainedTurnCount: number }
  /**
   * A binding was taken from turns still live, so their frames were ruled fail-closed.
   * `reportedRunCount` is lower than `ruledFrameCount` when frames share a run; a duplicate report
   * is suppressed, the ruling never.
   */
  | { kind: "abandoned-frames-ruled"; ruledFrameCount: number; reportedRunCount: number }
  /**
   * A resume superseded a live binding with unsettled frames, so they were failed as unproven
   * deliveries but not quarantined. `reportedRunCount` is lower than `abandonedFrameCount` when
   * frames share a run or a join key resolved to no run.
   */
  | {
      kind: "superseded-frames-failed";
      abandonedFrameCount: number;
      reportedRunCount: number;
    };

/** Required: a no-op default would reintroduce silent drops. */
export type CodexDiagnosticSink = (diagnostic: CodexTransportDiagnostic) => void;

/**
 * Reports a diagnostic from a frame with no caller to act on failure, so a throwing sink cannot
 * unwind the read-chunk drain and hang the requests behind it.
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
