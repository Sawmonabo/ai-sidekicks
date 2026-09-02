// The terminal scenario's clock, and the two beat shapes its script writes many of.
//
// Split out of `terminal.ts` on the same seam `scenario.ts` split from
// `scenario-engine.ts`: that file declares WHAT this session does, in order, and
// this one owns the envelope every beat of it is built from. The script reads as a
// table once the envelope stops being retyped twenty times.
//
// THE INSTANT IS DERIVED FROM THE TICK, and that is the point rather than a
// convenience. Every beat used to carry `atMs` and an `occurredAt` that had to agree
// with it by hand, which is two spellings of one fact — and the fixture's own frozen
// clock advances on `atMs`, so a drifted `occurredAt` would put a timestamp on screen
// that no tick of this scenario corresponds to. One of them is now computed from the
// other, so they cannot disagree.

import type { ScenarioBeat } from "../scenario.js";
import { TERMINAL_SCENARIO_SESSION_ID } from "./terminal-cast.js";

/** Wall-clock instant the frozen clock reports as "now" at tick zero. */
export const TERMINAL_SCENARIO_STARTED_AT_ISO = "2026-01-01T16:40:00.000Z";

const TERMINAL_SCENARIO_STARTED_AT_MS = Date.parse(TERMINAL_SCENARIO_STARTED_AT_ISO);

/** The event kind every lease transition arrives on. `Spec-006`'s registered type. */
const LEASE_TRANSITION_KIND = "pty.control_changed";

/**
 * The tick the shell's host node attached at.
 *
 * A tick and not an instant, because two surfaces report it — the `runtime_node.online`
 * beat and the roster reply's `attachedAt` — and they were two hand-written copies of
 * one timestamp. Both now read it here and pass it through the clock below.
 */
export const TERMINAL_HOST_NODE_ATTACHED_AT_MS = 160;

/**
 * The tick of the host node's last heartbeat before it went silent.
 *
 * Three surfaces report this one: the roster reply, the `runtime_node.offline` beat's
 * `lastHeartbeatAt`, and — through the beat — the degraded line a person reads.
 */
export const TERMINAL_HOST_NODE_LAST_HEARTBEAT_AT_MS = 3_780;

/** The instant a tick lands on, in the frozen clock's own wall time. */
export function terminalScenarioInstantAt(atMs: number): string {
  return new Date(TERMINAL_SCENARIO_STARTED_AT_MS + atMs).toISOString();
}

/** What one beat says beyond the envelope this module stamps. */
export interface TerminalScenarioBeatInput {
  /** The tick this beat is due at, measured from scenario start. */
  readonly atMs: number;
  readonly sequence: number;
  /** Wire-verbatim event type. Held to the registered taxonomy by `scenarios.test.ts`. */
  readonly kind: string;
  /** Who the log attributes the event to. Omitted where the daemon acted alone. */
  readonly actorParticipantId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * One scripted beat of this session, with its session id and its instant stamped.
 *
 * Both stamped rather than written per beat: the session id is the same string
 * twenty times over, and the instant is `atMs` in the other spelling.
 */
export function terminalScenarioBeat(beat: TerminalScenarioBeatInput): ScenarioBeat {
  return {
    atMs: beat.atMs,
    event: {
      sessionId: TERMINAL_SCENARIO_SESSION_ID,
      sequence: beat.sequence,
      kind: beat.kind,
      occurredAt: terminalScenarioInstantAt(beat.atMs),
      ...(beat.actorParticipantId === undefined
        ? {}
        : { actorParticipantId: beat.actorParticipantId }),
      payload: beat.payload,
    },
  };
}

/** What one lease transition says. The payload members are `Spec-006`'s own. */
export interface TerminalLeaseTransitionBeatInput {
  readonly atMs: number;
  readonly sequence: number;
  /**
   * Who holds it after this transition.
   *
   * `null` is the free lease, and it is written as an explicit null rather than an
   * omitted member because `Spec-023 §Console Design (Meridian)` 8.8 makes an unheld
   * lease an explicit state that reads differently from a suppressed one.
   */
  readonly holderParticipantId: string | null;
  readonly previousHolderParticipantId: string | null;
  /** One of the five reasons `Spec-006` closes the set at. */
  readonly reason: string;
  /** Omitted for a take the daemon's own lease authority performed. */
  readonly actorParticipantId?: string;
}

/**
 * One `pty.control_changed` beat.
 *
 * Its own builder rather than a `terminalScenarioBeat` call with a payload literal,
 * because nine of this script's twenty beats are this shape and the transitions are
 * what a reader comes to the script for. Written as a table, the hand-off sequence
 * reads off the page; written as nine payload literals, it did not.
 */
export function terminalLeaseTransitionBeat(
  transition: TerminalLeaseTransitionBeatInput,
): ScenarioBeat {
  return terminalScenarioBeat({
    atMs: transition.atMs,
    sequence: transition.sequence,
    kind: LEASE_TRANSITION_KIND,
    ...(transition.actorParticipantId === undefined
      ? {}
      : { actorParticipantId: transition.actorParticipantId }),
    payload: {
      sessionId: TERMINAL_SCENARIO_SESSION_ID,
      holderParticipantId: transition.holderParticipantId,
      previousHolderParticipantId: transition.previousHolderParticipantId,
      reason: transition.reason,
    },
  });
}
