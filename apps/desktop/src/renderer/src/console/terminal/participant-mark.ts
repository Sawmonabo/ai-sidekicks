// How the console draws one participant beside the session's shared shell.
//
// Held apart from `LeaseLine.tsx` because the holder line, the ledger, and the mark
// dot all take it and all three are their own modules — a shape exported by one of
// them and imported by the others would close a cycle between siblings that only
// ever read it.
//
// FAIL-CLOSED BY CONSTRUCTION. Every reader takes `TerminalParticipantMark |
// undefined`, and `undefined` is the answer for a participant the hue wheel has never
// admitted: such a participant is drawn on the neutral boundary with its wire id,
// rather than borrowing somebody else's hue and somebody else's name.

import type { ParticipantRingTreatment } from "../tokens/index.js";

/** How a participant is drawn: the wheel step and the treatment that disambiguates it. */
export interface TerminalParticipantMark {
  readonly hueStep: number;
  readonly ringTreatment: ParticipantRingTreatment;
  /**
   * The name a person reads, when the roster has supplied one. Absent is the
   * ordinary state today — no projector claims `participant.joined` yet — and the
   * surface then renders the wire id in mono rather than inventing a name.
   */
  readonly displayName: string | undefined;
}

/** How a caller asks for one. `undefined` is the wheel's honest answer, not a gap. */
export type TerminalParticipantMarkReader = (
  participantId: string,
) => TerminalParticipantMark | undefined;
