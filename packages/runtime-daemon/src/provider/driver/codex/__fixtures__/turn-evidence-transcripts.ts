// Golden vector: Codex `turn/completed` payloads for the turn-evidence classifier.
// Pin: codex-cli 0.150.1. The model-output and quota-exhausted vectors were recorded from the
// pinned binary's `app-server` (initialize, initialized, thread/start, turn/start on a default
// connection). The command-dispatch vector is synthesized and labeled so.
//
// Why a synthesized vector exists: the pinned app-server does no client-side command parsing. A
// first input element starting with `/` (a real command such as `/status`, or an invented one) is
// echoed back as a `userMessage` item and run as a normal turn, so there is no recorded
// command-dispatch response. A provider install could start dispatching commands between two
// runs, so the classifier needs a vector for that shape. It keys on the absence of turn evidence,
// not on a recognizable dispatch shape, so it works against a shape nobody has seen.

/** A turn that produced model output - the negative control. */
export function codexTurnWithModelOutput(turnId: string): Record<string, unknown> {
  return {
    threadId: "thread-1",
    turn: {
      id: turnId,
      items: [
        { type: "userMessage", id: "item-1", content: [{ type: "text", text: "hello" }] },
        { type: "agentMessage", id: "item-2", content: [{ type: "text", text: "hi" }] },
      ],
      itemsView: "loaded",
      status: "completed",
      error: null,
      durationMs: 2838,
    },
  };
}

/**
 * SYNTHESIZED: a command-dispatch response. The turn completed with no model output and no error.
 */
export function codexCommandDispatchResponse(turnId: string): Record<string, unknown> {
  return {
    threadId: "thread-1",
    turn: {
      id: turnId,
      items: [{ type: "userMessage", id: "item-1", content: [{ type: "text", text: "/status" }] }],
      itemsView: "loaded",
      status: "completed",
      error: null,
      durationMs: 4,
    },
  };
}

/**
 * RECORDED: the quota-exhausted turn, with no model output and a typed declared failure. It is the
 * control for the classifier's third evidence class: a two-way "output or nothing" rule would read
 * it as a turn that never ran. `itemsView: "notLoaded"` beside an empty item list is measured;
 * it is why turn evidence accrues from in-flight item notifications, not from this frame alone.
 */
export function codexQuotaExhaustedTurn(turnId: string): Record<string, unknown> {
  return {
    threadId: "thread-1",
    turn: {
      id: turnId,
      items: [],
      itemsView: "notLoaded",
      status: "failed",
      error: {
        message: "You've hit your usage limit.",
        codexErrorInfo: "usageLimitExceeded",
        additionalDetails: null,
      },
      durationMs: 2838,
    },
  };
}
