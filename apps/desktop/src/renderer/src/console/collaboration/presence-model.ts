// Who is in this session, and what state each of them is in.
//
// THE READ IS THE TRUTH AND THE PUSH IS ONLY A SIGNAL. `presence.read` returns
// `{participantId, state, lastSeen}` per participant; `presence.subscribe` delivers
// a change notification whose payload this module never opens. That is the whole
// discipline, and it lives in `seats/push-driven-read.ts` because the channel directory
// needs it identically — subscribe first, answer the signal with a fresh read, one
// read per burst through the refresh chokepoint, never a second copy of the
// publisher's state, and never a flicker back to the loading shape.
//
// THE FOUR STATES ARE THE WIRE'S. `PresenceState` is `online | idle | reconnecting
// | offline` (`packages/contracts/src/presence.ts`) and this module derives no
// fifth. Composing is a signal carried BESIDE presence — it lives in
// `activity-model.ts` — and folding it in here would make "is composing" and "is
// online" the same question, which they are not: a person can be composing on a
// reconnecting client.
//
// HUE COMES FROM THE SESSION'S OWN WHEEL, NOT FROM THE ROSTER'S ORDER. The store's
// `ParticipantHueAllocator` allocates in join-log order, so the same person reads
// the same colour in the roster, the timeline, and a pane's focus ring. Allocating
// here — off the read's order, which is the daemon's — would give a person a
// different colour in this list than in the log beside it.
//
// THE SHIPPED TIER-1 ROSTER IS NOT THIS. `session-members/participant-roster.tsx`
// reads `window.sidekicks` directly, so the console's fixture cannot stand in for
// it and the frame mounts it behind a live-bridge guard. This model reaches the
// bridge the console resolved, which is what lets a scenario drive it, and it
// routes its refresh through the scheduler rather than through a hand-rolled
// sequence counter. Retiring that component from the `workspace` slot is the
// workspace family's own diff, not this one's.

import type {
  PresenceReadResponse,
  PresenceReadResponseParticipant,
} from "@ai-sidekicks/contracts";

import type { ConsoleClock } from "../core/index.js";
import type { ConsoleBridge } from "../bridge/index.js";
import type { ParticipantHueAssignment } from "../tokens/index.js";
import type { SessionStore } from "../store/index.js";
import { PushDrivenRead, callDaemonMethod, subscribeDaemonEvent } from "../seats/index.js";

const PRESENCE_READ_METHOD = "presence.read";
const PRESENCE_SUBSCRIBE_EVENT = "presence.subscribe";

/** The refusal origin every roster-read failure carries. */
export const PRESENCE_ROSTER_ORIGIN = "presence-roster";

/**
 * Render order for the four presence states, most present first.
 *
 * Declared once as a tuple with the lookup derived from it. An offline participant
 * is not removed from the list — the roster answers "who is in this session", and
 * someone who stepped away is still in it — so the ordering is what keeps the
 * people who can answer right now at the top.
 */
export const PRESENCE_STATE_RENDER_ORDER = ["online", "idle", "reconnecting", "offline"] as const;

/** One row of the roster: the wire's participant, plus the session's own hue. */
export interface RosterRow {
  readonly participant: PresenceReadResponseParticipant;
  /** The session wheel's assignment, or `undefined` for a participant it has not admitted. */
  readonly hue: ParticipantHueAssignment | undefined;
  /** True when this row is the reader's own. Marked, never moved to the top. */
  readonly isSelf: boolean;
}

/**
 * Order the read's participants for the eye and attach each one's hue.
 *
 * Pure, and separated from the model for the reason the channel ordering is: the
 * ordering rule is where the mistakes are, and a rule reachable only through a
 * bridge is a rule nobody drives directly.
 *
 * Ties inside one state keep the daemon's own order. Sorting by id or by last-seen
 * would make the list re-order itself under a person mid-glance, which is the one
 * thing a roster must not do.
 */
export function rosterRowsFrom(
  participants: readonly PresenceReadResponseParticipant[],
  hueFor: (participantId: string) => ParticipantHueAssignment | undefined,
  selfParticipantId: string | undefined,
): readonly RosterRow[] {
  const rankOf = (state: string): number => {
    const rank = PRESENCE_STATE_RENDER_ORDER.indexOf(
      state as (typeof PRESENCE_STATE_RENDER_ORDER)[number],
    );
    // A state outside the four sorts last rather than first. The union is closed on
    // the wire, so this arm is unreachable through a conforming daemon — and a
    // renderer that put an unrecognised state at the TOP of the roster would give
    // the most prominent row to the least understood value.
    return rank === -1 ? PRESENCE_STATE_RENDER_ORDER.length : rank;
  };
  return participants
    .map((participant, arrivalIndex) => ({ participant, arrivalIndex }))
    .sort((left, right) => {
      const byState = rankOf(left.participant.state) - rankOf(right.participant.state);
      return byState !== 0 ? byState : left.arrivalIndex - right.arrivalIndex;
    })
    .map(({ participant }) => ({
      participant,
      hue: hueFor(participant.participantId),
      isSelf: participant.participantId === selfParticipantId,
    }));
}

/** The read the roster is built on, with its refresh already bound. */
export type PresenceRoster = PushDrivenRead<readonly PresenceReadResponseParticipant[]>;

/**
 * Build the roster read for one session.
 *
 * Constructed by whoever owns its lifetime — a sidebar section, never a render
 * body — and disposed with that owner.
 */
export function createPresenceRoster(options: {
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore;
  readonly clock: ConsoleClock;
}): PresenceRoster {
  const { bridge, sessionStore, clock } = options;
  return new PushDrivenRead<readonly PresenceReadResponseParticipant[]>({
    clock,
    origin: PRESENCE_ROSTER_ORIGIN,
    read: async () => {
      const response = await callDaemonMethod<{ readonly sessionId: string }, PresenceReadResponse>(
        bridge,
        PRESENCE_READ_METHOD,
        { sessionId: sessionStore.sessionId },
      );
      return response.participants;
    },
    // The payload is typed `void` and the handler takes no argument, which is the
    // "never decodes the push payload" rule made unrepresentable rather than
    // merely observed: there is no binding here to read a field out of.
    subscribe: (onChangeSignal) =>
      subscribeDaemonEvent<void>(bridge, PRESENCE_SUBSCRIBE_EVENT, onChangeSignal),
  });
}
