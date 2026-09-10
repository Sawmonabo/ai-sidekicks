// One participant, as a chip.
//
// Its own module for the one-component rule. It is where the hue rule lands, and the
// rule is that the hue is IDENTITY and nothing else: the ring says which participant
// this is, and the chip carries no colour at all for state. A chip tinted for
// attention was a second meaning on the one surface whose whole job is telling people
// apart, and it put the amber vocabulary somewhere nobody can act on it. Amber lives
// where the act is — the approval card and the sidebar row — and what this chip
// carries instead is a WORD.

import { Tooltip } from "@base-ui/react/tooltip";

import { tokenReference } from "../../../tokens/index.js";
import { type CastMember } from "../model/cast-bar-model.js";
import { CastChipButton, type CastChipStyle } from "./CastChipButton.js";

export interface CastChipProps {
  readonly member: CastMember;
  /**
   * The bar's one card handle, which this chip triggers with itself as the payload.
   *
   * Handed down rather than minted here: a handle per chip would be a card per chip,
   * which is the arrangement `ParticipantCardHost.tsx` records the measured cost of.
   */
  readonly cardHandle: Tooltip.Handle<CastMember>;
  readonly onFollow: (participantId: string) => void;
}

/**
 * One participant.
 *
 * A `<button>` because clicking it performs an act — follow — and a `<div>` with a
 * click handler is an act nobody can reach with a keyboard. The accessible name is
 * built from the identifier and the verb, so a screen reader hears "priya, waiting
 * on approval" rather than "button" — composed in the model and set as the button's
 * own label, because the presence glyph is an image with a name and concatenation
 * would put "Presence has not been read" in front of every person in the session.
 *
 * A chip somebody is blocked on says so in words — in the chip and in its accessible
 * name, one sentence from one constant. `data-attention` survives as the attribute
 * that gives that clause its weight, which is LUMINANCE and never hue:
 * `Spec-023 §The four bars` steers attention "by luminance and the two-hue rule",
 * and the two-hue half is spent on identity here, so the clause reads at full
 * strength beside a verb set in muted grey.
 *
 * THE CLAUSE REPLACES THE VERB RATHER THAN JOINING IT. The bar is one line and a chip
 * truncates to one clause, so a chip carrying both would show whichever the ellipsis
 * left — and of the two, the one a person acts on is this. The derived verb is not
 * lost: `castChipAccessibleName` composes both, so the name a screen reader hears is
 * a superset of what the chip draws.
 *
 * The visible name is the one the WIRE gave this participant — a membership beat's
 * identity handle, an agent's attached name — and the id when the log named none. The
 * id is reachable in the CARD rather than in a `title`: two participants admitted in
 * the same millisecond share a UUID prefix long enough that the chip's own ellipsis
 * truncates both to the same string, so the id alone identifies nobody, and an
 * identifier on its own was never one of the four facts the design asks a hover for.
 */
export function CastChip(props: CastChipProps): React.JSX.Element {
  const { member } = props;
  const style: CastChipStyle = { "--meridian-cast-hue": tokenReference(member.hue.tokenName) };

  // A TRIGGER AND NOT A ROOT. The bar mounts one card for every chip in it and binds
  // them with a handle, so what belongs here is the half that names this participant.
  return (
    <Tooltip.Trigger
      handle={props.cardHandle}
      payload={member}
      render={<CastChipButton member={member} style={style} onFollow={props.onFollow} />}
    />
  );
}
