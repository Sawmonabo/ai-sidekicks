// The composer accessories' one seam onto the daemon, and the method strings it
// reaches through it.
//
// WHY A MODULE AND NOT A CAST AT EACH CALL SITE. `SidekicksBridge.daemon.call`
// takes `DaemonMethod`, which is a `never`-shaped brand standing in for Plan-007's
// method union, and answers `DaemonResult<M>`, which resolves to `unknown` until
// that union lands. Every caller therefore has to widen the signature, and three
// accessories widening it three ways would be three subtly different claims about
// the same wire. One widening, in one module, is one claim — and it is the same
// posture `console/frame/session-event-binder.ts` takes for the subscribe half.
//
// WHAT THE WIDENING DOES AND DOES NOT ADMIT. The method name is pinned to `string`
// (the genuinely untypeable half) and the reply is left `unknown`, which is honest:
// a tighter reply type here would be a fiction, and every caller parses the reply
// through the registered schema in `@ai-sidekicks/contracts` before rendering a
// figure from it. Nothing here invents a method name — each constant below is a row
// of a registry the corpus already publishes, quoted verbatim.

/**
 * Participant-triggered context compaction.
 *
 * Run-addressed within the session; the daemon resolves the binding itself, which
 * is why the request carries no binding member for the console to supply.
 */
export const COMPACT_CONTEXT_METHOD = "driver.compactContext";

/**
 * Pause one run.
 *
 * `run.pause` and NOT an intervention arm. The registered
 * `InterventionRequestPayload` union is `steer | interrupt | cancel | rollback`,
 * and pause/resume are separate request types by design — so a control that sent a
 * `{ type: "pause" }` intervention would be sending a shape the wire's own
 * discriminated union has no arm for.
 */
export const RUN_PAUSE_METHOD = "run.pause";

/** Cancel one queued item. The daemon confirms; the shelf never removes ahead of it. */
export const QUEUE_CANCEL_METHOD = "run.queueCancel";

/** The queue's replay-then-tail stream. Session-scoped; the client fans out per run. */
export const QUEUE_SUBSCRIBE_STREAM = "run.subscribeQueue";

/**
 * The two daemon signatures, re-exported from the family that now owns them.
 *
 * They were defined here while the composer accessories were their only caller.
 * The approvals pane is the second family to need them, so they were hoisted to
 * `console/bridge/daemon-call.ts` — the lowest family in the DAG both can reach —
 * on `apps/desktop/AGENTS.md`'s hoist-on-second-use rule. They are re-exported
 * rather than deleted so no accessory's import path moves: this module is still
 * the composer's one seam onto the daemon, and it still owns the method names.
 */
export { callDaemon, subscribeDaemon } from "../../../console/bridge/index.js";
