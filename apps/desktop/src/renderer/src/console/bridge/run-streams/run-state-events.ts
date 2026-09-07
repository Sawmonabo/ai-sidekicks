// The run-state stream's two frames, read once for the console.
//
// `daemon-streams.ts` deliberately leaves a delivered frame `unknown` — a
// subscription has no single reply to bind, so each frame is projected by its
// consumer. What that leaves open is WHERE the projection's schema lives, and the
// answer is the same one the call door gives: at the wire's edge. `console/bridge/**`
// is the only family that may import a `*Schema` binding from the contracts package,
// so a pane consumes a typed reader and never a validator, and the two frames this
// stream multiplexes are read in one place rather than at every surface that opens
// it.
//
// TWO FRAMES AND NOT ONE. `run.subscribeState` carries `RunStateChangeEvent` and
// `RunRolledBackEvent` over one stream — a transition and a rewind, which move
// different members and mean different things to a reader — so the readers stay
// separate and the caller decides in which order to try them. A single reader
// answering a union would have had to pick that order here, where no surface can see
// it.

import {
  RunRolledBackEventSchema,
  RunStateChangeEventSchema,
  type RunRolledBackEvent,
  type RunStateChangeEvent,
} from "@ai-sidekicks/contracts";

/** The state transition a frame carries, or `undefined` where it carries none. */
export function readRunStateChange(payload: unknown): RunStateChangeEvent | undefined {
  const parsed = RunStateChangeEventSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

/** The rewind a frame carries, or `undefined` where it carries none. */
export function readRunRolledBack(payload: unknown): RunRolledBackEvent | undefined {
  const parsed = RunRolledBackEventSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}
