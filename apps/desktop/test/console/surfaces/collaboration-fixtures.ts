// The collaboration family's cast, for every tier that audits or captures it.
//
// The accessibility tier and the screenshot tier are two tiers asking two questions
// of one family, and they held byte-identical copies of this whole block: the same
// two builders, the same labels, the same disagreement tick, the same embedded
// `lastSeen`, and the same frozen instant spelled `Date.parse` in both.
//
// One of those divergences fails loudly and the other does not. Give
// `ChannelListResponseChannel` a required member and the tier whose copy was not
// fixed stops compiling — visible. Move `ROSTER_AXES_DISAGREE_MS` in the capture
// because a beat moved, and the audit keeps measuring at the old tick, where the two
// machine-health axes no longer disagree: the never-mask reading the constant exists
// for silently stops being covered while the tier stays green.
//
// `test/console/surfaces/` is where a family's surface scaffolding lives — beside
// `console-harness.tsx` in role, one directory down so a tier reads which family a
// module belongs to from its name rather than from its contents.

import type {
  ChannelListResponseChannel,
  PresenceReadResponseParticipant,
} from "@ai-sidekicks/contracts";

import type { ChannelActivityLabels } from "../../../src/renderer/src/console/collaboration/activity-model.js";
import { frozenStartMilliseconds } from "../../../src/renderer/src/console/core/frozen-instant.test-support.js";

/**
 * The instant every relative stamp in this family's tiers is measured against.
 *
 * Read through the console's own instant reader rather than `Date.parse`, which
 * answers a number for a day that does not exist and would leave a captured "last
 * seen" figure describing an elapsed time nobody chose.
 */
export const COLLABORATION_INSTANT_MILLISECONDS: number = frozenStartMilliseconds();

/**
 * The tick this family's scenario has its two machine-health axes disagree at.
 *
 * The runner's attachment has ended while the heartbeat sweep still reads it
 * healthy, which is the reading the never-mask rule exists for — and the one a page
 * collapsing the two axes into a single scalar could not draw. Both tiers stop here
 * rather than at an earlier frame precisely because two agreeing axes look the same
 * either way.
 */
export const ROSTER_AXES_DISAGREE_MS = 640;

/** Identifiers render as themselves: neither a capture nor an audit may depend on a name read. */
export const LABELS: ChannelActivityLabels = {
  participantLabel: (participantId) => participantId.replace("participant-", ""),
  runLabel: (runId) => runId,
};

/** One channel in the given state, with the participant count both tiers draw. */
export function channel(
  id: string,
  name: string,
  state: ChannelListResponseChannel["state"],
): ChannelListResponseChannel {
  return {
    id: id as ChannelListResponseChannel["id"],
    name,
    state,
    participantCount: 4,
  };
}

/**
 * One roster participant, last seen half a minute before the frozen instant.
 *
 * The gap is part of the fixture: it is what makes the row's relative age a figure
 * rather than a dash, so a tier that moved the instant without moving this stamp
 * would be measuring a different elapsed time from its sibling.
 */
export function participant(
  participantId: string,
  state: PresenceReadResponseParticipant["state"],
): PresenceReadResponseParticipant {
  return {
    participantId: participantId as PresenceReadResponseParticipant["participantId"],
    state,
    lastSeen: "2026-01-01T09:59:30.000Z",
  };
}
