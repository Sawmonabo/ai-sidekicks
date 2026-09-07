// One participant, as a chip.
//
// Its own module for the one-component rule. It is where the hue rule lands, and the
// rule is that the hue is IDENTITY and nothing else: the ring says which participant
// this is, and the chip carries no colour at all for state. A chip tinted for
// attention was a second meaning on the one surface whose whole job is telling people
// apart, and it put the amber vocabulary somewhere nobody can act on it. Amber lives
// where the act is — the approval card, the sidebar row, the rail tick — and what
// this chip carries instead is a WORD.

import { Tooltip } from "@base-ui/react/tooltip";

import { type SessionStore } from "../../store/index.js";
import { tokenReference } from "../../tokens/index.js";
import { ParticipantCard } from "./ParticipantCard.js";
import { type CastMember } from "./cast-bar-model.js";
import { CastChipButton, type CastChipStyle } from "./CastChipButton.js";

/**
 * How far the card sits off the chip.
 *
 * A positioning offset rather than a density cap: it is the tooltip library's own
 * geometry argument and nothing else in the console spends it, so it stays beside the
 * one call that passes it rather than in the cap home, which holds the budgets a
 * surface is held to.
 */
const CARD_OFFSET_PX = 6;

export interface CastChipProps {
  readonly member: CastMember;
  /**
   * The store the participant card reads its four facts out of.
   *
   * Handed down rather than reached for, on the same terms every other reading in this
   * console is: a bar rendered in an auxiliary window reads THAT window's store. The
   * card is mounted only while it is open, so a closed chip costs no subscription.
   */
  readonly sessionStore: SessionStore;
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

  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={<CastChipButton member={member} style={style} onFollow={props.onFollow} />}
      />
      <Tooltip.Portal>
        {/* The card is a POPUP the tooltip mounts only while it is open, so the reading
            behind it starts when somebody hovers or tabs to the chip and stops when they
            leave. A card mounted with the chip would hold one store subscription per
            participant for the life of the bar. */}
        <Tooltip.Positioner sideOffset={CARD_OFFSET_PX}>
          <Tooltip.Popup className="meridian-cast-chip__card">
            <ParticipantCard
              sessionStore={props.sessionStore}
              participantId={member.participantId}
              label={member.label}
            />
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
