// The console's one reading of a wire identifier.
//
// EVERY IDENTIFIER THE STORE HOLDS IS A `string`, AND EVERY REQUEST TAKES A BRAND.
// `SessionId`, `RunId`, `ChannelId` and `WorkspaceId` are branded in
// `@ai-sidekicks/contracts`, so the only way from one to the other is the registered
// schema — and before this module, seven surfaces reached for that schema
// themselves. That is the same defect the call door closed one layer up, arriving by
// a different route: a parse written per call site is a parse somebody eventually
// writes differently, and the shape of "differently" here is a cast, which turns an
// identifier the daemon would refuse into a round trip that fails.
//
// WHY THE READERS LIVE IN `bridge/`. A schema is the wire's, and the wire's edge is
// this family: `console/bridge/**` is the only place a `*Schema` binding may be
// imported from the contracts package, so a family above it consumes a typed READER
// and never a validator. Named as the family's other decode seams are — a `read*`
// that answers the value or `undefined` — so a caller branches on presence rather
// than on a validator's result object, and no family has to know what a schema
// failure looks like.
//
// WHAT THEY DO NOT DO. They mint no refusal and compose no sentence. Whether an
// unreadable identifier is a rendered refusal, a dropped row, or a silent skip is
// the caller's decision and differs by surface: the composer refuses the send and
// keeps the participant's text, the runs pane refuses the control, and the addressed
// -run chip simply shows no state. A reader that refused on their behalf would have
// had to choose one, and the console's refusal codes would have moved into the
// bridge family where no surface can read them.

import {
  ChannelIdSchema,
  QueueItemIdSchema,
  RunIdSchema,
  RunStateSchema,
  SessionIdSchema,
  WorkspaceIdSchema,
  type ChannelId,
  type QueueItemId,
  type RunId,
  type RunState,
  type SessionId,
  type WorkspaceId,
} from "@ai-sidekicks/contracts";

/** The session identifier the wire admits, or `undefined` where it admits none. */
export function readSessionId(value: string): SessionId | undefined {
  const parsed = SessionIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** The run identifier the wire admits, or `undefined` where it admits none. */
export function readRunId(value: string): RunId | undefined {
  const parsed = RunIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** The queue-item identifier the wire admits, or `undefined` where it admits none. */
export function readQueueItemId(value: string): QueueItemId | undefined {
  const parsed = QueueItemIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** The channel identifier the wire admits, or `undefined` where it admits none. */
export function readChannelId(value: string): ChannelId | undefined {
  const parsed = ChannelIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** The workspace identifier the wire admits, or `undefined` where it admits none. */
export function readWorkspaceId(value: string): WorkspaceId | undefined {
  const parsed = WorkspaceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The run state the wire admits, or `undefined` for a word this build does not know.
 *
 * A state and not an identifier, and here rather than beside the four because the
 * question is the same one: the store holds the daemon's word verbatim and a surface
 * that branches on it needs the closed union. A state this build has never heard of
 * is a real case — a newer daemon against an older console — and answering
 * `undefined` is what lets the surface say so instead of falling into whichever arm
 * its `switch` happened to end on.
 */
export function readRunState(value: string): RunState | undefined {
  const parsed = RunStateSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The states in which a run is still the daemon's to move.
 *
 * The complement of the three terminals — `completed`, `interrupted`, `failed` — and
 * written as the positive set rather than as a negation, so a tenth state added
 * upstream lands OUTSIDE it: a run whose state this build has never heard of is not
 * asserted to be finished.
 *
 * IT IS HERE AND NOT IN A VIEW FAMILY. It began in `runs/pane/run-status.ts`, and the
 * second surface that needed it — the settings surface's restart confirmation, which
 * has to name the runs a restart would interrupt — is a SIBLING view family, which
 * may not import it from there (`apps/desktop/AGENTS.md`: view families are siblings,
 * not a ladder). The remedy that file's own rule names is the hoist, and this module
 * is where it lands: `bridge/` already owns the console's one reading of the wire's
 * run-state vocabulary, and a predicate over that vocabulary belongs beside the
 * reader that produces it rather than in whichever family asked first.
 */
const LIVE_RUN_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "queued",
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "paused",
]);

/**
 * Whether a run is still moving, by the state the daemon last reported.
 *
 * Used to decide what a surface OFFERS or SAYS, never whether the daemon will admit
 * anything: eligibility is the daemon's and reaches a surface as a typed refusal
 * (`Spec-023 §Rules every console surface obeys` — "eligibility is never projected by
 * the renderer"). What this answers is the narrower question of whether an act is
 * meaningful at all — a `completed` run has no turn to interrupt, and a restart
 * interrupts nothing by ending it.
 */
export function isLiveRunState(state: RunState): boolean {
  return LIVE_RUN_STATES.has(state);
}
