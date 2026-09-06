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
// THIS IS THE ONLY PLACE THE APPLICATION DRAWS PRESENCE, and it became that here.
// `session-members/participant-roster.tsx` drew it too, mounted at the `workspace`
// slot behind a live-bridge guard, so one window read one session's presence twice
// over two reads free to disagree — and the shipped one could not be the survivor:
// it reads `window.sidekicks` directly, so no scenario can drive it, and it carries
// no seam for the role, the terminal-lease holder, or the per-device fan-out the
// rows beside this model render. That slot claim is retired; giving the shipped
// component a read seam instead would be an edit inside `session-members/`, which is
// Plan-002's subtree. This model reaches the bridge the console resolved, which is
// what lets a scenario drive it, and it routes its refresh through the scheduler
// rather than through a hand-rolled sequence counter.

import type { PresenceReadResponseParticipant } from "@ai-sidekicks/contracts";

import {
  MILLISECONDS_PER_DAY,
  MILLISECONDS_PER_HOUR,
  MILLISECONDS_PER_MINUTE,
  parseInstant,
  type ConsoleClock,
} from "../../core/index.js";
import { callDaemon, heldIdAsWireId, type ConsoleBridge } from "../../bridge/index.js";
import type { ParticipantHueAssignment } from "../../tokens/index.js";
import type { SessionStore } from "../../store/index.js";
import { PushDrivenRead, servedValueOrRaise, subscribeDaemonEvent } from "../../seats/index.js";

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

/**
 * One settled roster read: who was there, and WHEN the console heard it.
 *
 * The stamp rides the reading rather than being sampled where the rows are drawn.
 * A relative age is measured against an instant, and a render body that read the
 * clock for one produced a figure that depended on when the tree last happened to
 * re-render: a participant idle since 10:00 went on reading "a few seconds ago" at
 * 10:45 and then jumped straight to "45 minutes ago" the moment something unrelated
 * moved. Stamped at the read, the instant is a fact about the read; advancing it is
 * `useDeadlineWake`'s job and nobody else's.
 */
export interface PresenceReading {
  readonly participants: readonly PresenceReadResponseParticipant[];
  /** When this read settled, off the console's one clock. */
  readonly readAtMilliseconds: number;
}

/** The read the roster is built on, with its refresh already bound. */
export type PresenceRoster = PushDrivenRead<PresenceReading>;

/**
 * The instants at which a row's rendered age changes, for every row.
 *
 * `formatRelativeTime` rounds within four bands — seconds under a minute, minutes
 * under an hour, hours under a day, then days — and this enumerates the instants at
 * which the phrase it composes actually changes, because each of those is a wake-up
 * a surface must arm or else render a figure that is only correct at the moment it
 * was painted.
 *
 * THE SECOND BAND IS DELIBERATELY NOT ENUMERATED. It changes once a second, so a row
 * whose stamp is recent contributed sixty deadlines inside the next minute: twenty
 * people online made the section wake about twenty times a second on a console
 * nobody was touching, each wake re-rendering every row and building a fresh
 * `Intl.RelativeTimeFormat` for each. A single-shot chain re-armed at 1 Hz per row is
 * an interval poll with a different implementation, which is exactly what
 * `Spec-023 §Console Design (Meridian)` forbids and what its idle-CPU budget is
 * measured against. So the first deadline a stamp earns is the one at which "now"
 * becomes "1 minute ago", and the figure under a minute old is left reading as of the
 * read that stamped it — which the read itself re-stamps on every presence signal.
 *
 * EACH BAND STARTS WHERE THE PREVIOUS ONE ENDED. A band's rounding flips at half-unit
 * offsets, and the flip at step 0 of every band but the first sits INSIDE the band
 * below it — half a minute, half an hour, half a day — so enumerating it armed a
 * wake-up that crossed no threshold the format renders. The steps therefore run from
 * one, and the instant the band itself takes over is enumerated once, as the band's
 * own unit.
 *
 * Derived from `lastSeen` ALONE and never from the current instant, which is what
 * makes it a stable list `useDeadlineWake` can step through one deadline at a time:
 * a list computed against "now" would name one boundary, and after waking to it
 * would name the same one again and re-arm nothing.
 *
 * An unreadable stamp contributes no deadline — such a row renders an em dash, which
 * does not age — and the horizon stops at {@link AGE_BOUNDARY_HORIZON_DAYS}, past
 * which the figure moves once a day and the next presence read has long since
 * restamped it.
 */
export function ageBoundariesOf(
  participants: readonly PresenceReadResponseParticipant[],
): readonly number[] {
  const boundaries: number[] = [];
  for (const participant of participants) {
    const seen = parseInstant(participant.lastSeen);
    if (seen.kind !== "instant") {
      continue;
    }
    for (const { unitMilliseconds, steps } of AGE_BANDS) {
      boundaries.push(seen.epochMilliseconds + unitMilliseconds);
      for (let step = 1; step < steps; step += 1) {
        boundaries.push(
          seen.epochMilliseconds +
            unitMilliseconds * (step + 0.5) +
            AGE_BOUNDARY_TIE_BREAK_MILLISECONDS,
        );
      }
    }
  }
  return boundaries;
}

/** How far ahead the day band is enumerated. Beyond it the figure moves once a day. */
const AGE_BOUNDARY_HORIZON_DAYS = 30;

/**
 * Why a half-unit deadline is armed one millisecond late.
 *
 * The rounding flips AT the half-unit, and `Math.round` breaks a tie toward positive
 * infinity — the delta these figures are composed from is negative, so waking at
 * exactly `1.5` units renders the value for `1` and the row stays one step behind
 * until the next deadline. One millisecond past it renders the step the crossing
 * produced, which is what makes "one deadline per rendered change" true rather than
 * approximately true.
 */
const AGE_BOUNDARY_TIE_BREAK_MILLISECONDS = 1;

/**
 * The bands whose changes are armed, and how many steps each spans.
 *
 * The second band `formatRelativeTime` rounds in is absent by the decision above, so
 * the minute band's own lower edge — one minute past the stamp — is the first
 * deadline any row earns.
 */
const AGE_BANDS: readonly { readonly unitMilliseconds: number; readonly steps: number }[] = [
  { unitMilliseconds: MILLISECONDS_PER_MINUTE, steps: 60 },
  { unitMilliseconds: MILLISECONDS_PER_HOUR, steps: 24 },
  { unitMilliseconds: MILLISECONDS_PER_DAY, steps: AGE_BOUNDARY_HORIZON_DAYS },
];

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
  return new PushDrivenRead<PresenceReading>({
    clock,
    origin: PRESENCE_ROSTER_ORIGIN,
    read: async () => {
      const reply = await callDaemon(bridge, PRESENCE_READ_METHOD, {
        sessionId: heldIdAsWireId(sessionStore.sessionId),
      });
      // Stamped where the read settles, off the clock this read already owns — so a
      // story's frozen clock stamps a frozen instant and a capture is byte-stable.
      return {
        participants: servedValueOrRaise(reply).participants,
        readAtMilliseconds: clock.now(),
      };
    },
    // The payload is typed `void` and the handler takes no argument, which is the
    // "never decodes the push payload" rule made unrepresentable rather than
    // merely observed: there is no binding here to read a field out of.
    subscribe: (onChangeSignal) =>
      subscribeDaemonEvent<void>(bridge, PRESENCE_SUBSCRIBE_EVENT, onChangeSignal),
  });
}
