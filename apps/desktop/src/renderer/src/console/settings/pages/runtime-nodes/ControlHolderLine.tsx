// Who holds the shared terminal, in one line, with the holder's hue beside it.
//
// TOTAL OVER THE READING, so every arm the roster reply can produce is drawn and none
// falls through to a blank. The two absences are different sentences on purpose: a
// read that has not answered is not a session with a free lease, and rendering the
// second for the first would be a claim about the session nothing checked.
//
// THE MARK IS THE HUE AND NOTHING ELSE. `Spec-023 §Console Design (Meridian)` rule 2
// puts the participant hue on a mark and never behind text, so the identifier beside
// it is the ordinary mono wire figure and the colour is a 2 px standing mark — the
// same attribution width rule 1 spends on a row edge, on an element that is not one.
// A holder the session's hue wheel has never admitted takes the neutral boundary
// rather than borrowing the colour of whoever is nearest, which is what fail-closed
// means for an identity.
//
// NO NAME IS INVENTED. The roster reply carries a `ParticipantId` and no display name,
// and no projection in this window claims one, so the identifier renders verbatim in
// mono. A renderer that substituted a friendly label would be asserting an identity
// nothing answered for.
//
// AND NO CONTROL. Taking or releasing the lease belongs to the terminal deck, against
// the daemon that owns the lease record; this line reports the projection.

import type { ReactNode } from "react";

import { DerivedFigure, InlineRefusal, Nothing, WireFigure } from "../../../primitives/index.js";
import {
  participantHueTokenName,
  tokenReference,
  type ParticipantHueAssignment,
} from "../../../tokens/index.js";
import type { ControlHolderReading } from "./control-holder-reading.js";

/** Carries the holder's hue into the mark's fill, as the ledger row does for an edge. */
interface ControlHolderMarkStyle extends React.CSSProperties {
  readonly "--meridian-control-holder-hue": string;
}

export function ControlHolderLine(props: {
  readonly reading: ControlHolderReading;
  /** The session wheel's assignment, or `undefined` for an identity it never admitted. */
  readonly hueAssignment: ParticipantHueAssignment | undefined;
}): ReactNode {
  const { reading } = props;

  if (reading.kind === "unread") {
    return (
      <Nothing kind="not-loaded" placement="inline" title="Reading who holds the shared shell." />
    );
  }

  // The refusal renders here rather than being swallowed, and it is the seam's own —
  // the same one the roster above rendered, in the console's shape. Leaving the line
  // blank would read as a free lease, which is the one statement that is certainly
  // wrong when nothing answered.
  if (reading.kind === "unreadable") {
    return <InlineRefusal {...reading.refusal} />;
  }

  if (reading.kind === "unheld") {
    return (
      <p className="meridian-control-holder">
        <span
          className="meridian-control-holder__mark meridian-control-holder__mark--unattributed"
          aria-hidden="true"
        />
        <DerivedFigure text="Unheld" />
        <DerivedFigure text="— nobody is holding the session's shared shell, or the control plane cannot vouch that the machine holding it is live. The projection serves both the same way, and no client is entitled to tell them apart." />
      </p>
    );
  }

  const markStyle: ControlHolderMarkStyle | undefined =
    props.hueAssignment === undefined
      ? undefined
      : {
          "--meridian-control-holder-hue": tokenReference(
            participantHueTokenName(props.hueAssignment.step),
          ),
        };
  const markClassName =
    props.hueAssignment === undefined
      ? "meridian-control-holder__mark meridian-control-holder__mark--unattributed"
      : `meridian-control-holder__mark meridian-control-holder__mark--${props.hueAssignment.ringTreatment}`;

  return (
    <p className="meridian-control-holder">
      <span className={markClassName} style={markStyle} aria-hidden="true" />
      <DerivedFigure text="Held by" />
      <WireFigure value={reading.participantId} />
    </p>
  );
}
