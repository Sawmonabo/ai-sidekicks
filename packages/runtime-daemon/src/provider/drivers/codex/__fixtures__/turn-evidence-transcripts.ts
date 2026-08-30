// GOLDEN VECTOR - Codex turn-evidence `turn/completed` payloads (T3.18).
//
//   Source doc      : docs/reference/provider-wire/codex.md
//   Section         : §Command-shaped input is delivered verbatim on this
//                     transport
//   Pin             : codex-cli 0.150.1
//   Provenance      : Binary probe for the two RECORDED vectors below - a
//                     purpose-written stdio client drove the pinned binary's
//                     `app-server` through initialize -> initialized ->
//                     thread/start -> turn/start on a default connection on
//                     2026-08-29, recording every inbound frame until the turn
//                     settled. SYNTHESIZED for the third, and labelled so on
//                     the declaration itself.
//   Trust           : Verified at 0.150.1 for the recorded pair.
//   Derived by      : Plan-005 T3.18.
//
// WHY A SYNTHESIZED VECTOR IS HERE AT ALL, stated rather than buried.
//
// The pinned app-server performs NO client-side command parsing: a first input
// element beginning with `/` is echoed back byte-identical as a `userMessage`
// item and dispatched into a real turn, and that held for a REAL command name
// (`/status`) as well as an invented one - so the finding is a property of the
// transport, not an artifact of the name chosen. There is therefore no recorded
// command-dispatch response to check in for this leg, and the tempting
// conclusion is that this leg needs no detector.
//
// That conclusion is what the tripwire exists to refuse. A provider install can
// start command-dispatching between two runs, and a leg with no detector would
// meet exactly the change the rule anticipates with silence. The synthesized
// vector is what the classifier must catch IF a build ever starts to - which is
// also why the classifier keys on the ABSENCE of turn evidence rather than on
// the presence of a recognizable dispatch shape: it has to work against a shape
// nobody has seen.

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
 * SYNTHESIZED - a command-dispatch response: the turn completed, carried no
 * model output, and declared no error. See the header for why it is synthesized
 * and why it is nonetheless checked in.
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
 * RECORDED - the quota-exhausted turn: no model output at all, and a TYPED
 * declared failure beside it.
 *
 * The control for the classifier's third evidence class. It reached no model,
 * so a two-way "output or trip" rule would report it as a neutralization
 * failure - poisoning a shared operator-visible field for a completely
 * different cause. Note `itemsView: "notLoaded"` beside an EMPTY item list:
 * that is measured, and it is why turn evidence accrues from in-flight item
 * notifications instead of being read only off this frame.
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
