// Whether this session has a run a person could step into.
//
// One aside sits under the lease line — that stepping in pauses a run and hands you
// the conversation, and that it never moves the keyboard. An aside is a clarification,
// and a clarification about a control nobody
// can reach right now is noise on every terminal pane that is not running anything.
// So the sentence renders when there is something to step into and not otherwise.
//
// IT READS THE PROJECTION AND NOT THE LOG, and that is the whole of this module's
// rule. A fold of its own over `session.subscribe` beats was a SECOND kind-to-state
// mapping beside the run-lifecycle projector's, and the two disagreed exactly where
// the wire is tolerant: `SessionEventSchema` registers no run-lifecycle payload
// variant, so a `run.running` beat carrying `newState: "failed"` — or carrying no
// state at all — arrives well-formed, and the projector refuses it precisely because a
// recognized transition must supply the state it announces. A kind-keyed fold could
// not see any of that. It read the kind, called the run running, and put a step-in
// aside on a run the rest of the console does not consider running.
//
// SO THERE IS ONE SOURCE OF TRUTH and this surface consumes it: the `run` partition,
// which holds what the projector admitted, read through the store's own selector. The
// runs family owns run RENDERING and one view family never imports another — but the
// store sits below both, so the reading this pane needs was always available without
// re-deriving anything.
//
// AND IT IS NARROW ON PURPOSE. A steppable run is a RUNNING one. Stepping in pauses a
// run, and a queued run has not started, a paused one is already stopped, a run
// waiting on an approval or an input is stopped on something a step-in does not
// supply, and a finished run cannot be paused at all. Every one of those is a state
// the projection carries verbatim, so the answer is read rather than guessed — and the
// direction it errs in is silence, which is the honest one for a sentence about a
// control: a partition no projector has written to answers `false`.
//
// TOTAL AND PURE, on `lease-model.ts`'s discipline: given the same projection, the
// same answer.

import type { RunState } from "@ai-sidekicks/contracts";

import type { ConsoleEntity } from "../../store/index.js";

/**
 * The one run state a step-in can act on.
 *
 * Written as a `RunState`, so a state this console invents — or one a later release
 * renames — is a compile error rather than a comparison that silently matches nothing.
 * That is `node-presence-model.ts`'s rule and the reason it is worth the import: a
 * fold keyed on a string nobody checks reports "nothing is running" forever, and reads
 * exactly like a session with no runs in it.
 */
const STEPPABLE_RUN_STATE: RunState = "running";

/**
 * Whether any run in this session's projection is running.
 *
 * The partition and not the timeline — see the header. A run the projection carries no
 * state for is not steppable: the state is what the projector writes when a beat
 * supplied one it accepted, and its absence is the absence of that fact rather than a
 * state to interpret.
 */
export function hasSteppableRun(runs: Readonly<Record<string, ConsoleEntity>>): boolean {
  return Object.values(runs).some((run) => run.state === STEPPABLE_RUN_STATE);
}
