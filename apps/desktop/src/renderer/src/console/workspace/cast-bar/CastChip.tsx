// One participant, as a chip.
//
// Its own module for the one-component rule. It is where the hue rule lands, and the
// rule is that the hue is IDENTITY and nothing else: the ring says which participant
// this is, and the chip carries no colour at all for state. A chip tinted for
// attention was a second meaning on the one surface whose whole job is telling people
// apart, and it put the amber vocabulary somewhere nobody can act on it. Amber lives
// where the act is — the approval card, the sidebar row, the rail tick — and what
// this chip carries instead is a WORD.

import { Glyph, WireFigure } from "../../primitives/index.js";
import { GLYPH_SIZE_DENSE, tokenReference } from "../../tokens/index.js";
import {
  CAST_ATTENTION_CLAUSE,
  castChipAccessibleName,
  type CastMember,
} from "./cast-bar-model.js";

/** Carries one participant's hue into the chip's ring, without a style attribute per rule. */
interface CastChipStyle extends React.CSSProperties {
  readonly "--meridian-cast-hue": string;
}

export interface CastChipProps {
  readonly member: CastMember;
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
 * identity handle, an agent's attached name — and the id when the log named none.
 * The id stays reachable as the name's tooltip: two participants admitted in the
 * same millisecond share a UUID prefix long enough that the chip's own ellipsis
 * truncates both to the same string, so the id alone identifies nobody.
 */
export function CastChip(props: CastChipProps): React.JSX.Element {
  const { member } = props;
  const style: CastChipStyle = { "--meridian-cast-hue": tokenReference(member.hue.tokenName) };

  return (
    <button
      type="button"
      className="meridian-cast-chip"
      style={style}
      data-ring={member.hue.ringTreatment}
      data-shares-step={member.hue.sharesStepWithEarlierParticipant}
      data-attention={member.needsAttention}
      aria-label={castChipAccessibleName(member)}
      onClick={() => {
        props.onFollow(member.participantId);
      }}
    >
      {/* Presence is not a wire the console has. The glyph is drawn in the
          not-checked treatment rather than as a state, because "we have not asked"
          and "they are online" are different facts. */}
      <Glyph name="dot" size={GLYPH_SIZE_DENSE} title="Presence has not been read" />
      <span
        className="meridian-cast-chip__name"
        title={member.label === undefined ? undefined : member.participantId}
      >
        <WireFigure value={member.label ?? member.participantId} />
      </span>
      {member.needsAttention ? (
        <span className="meridian-cast-chip__verb">{CAST_ATTENTION_CLAUSE}</span>
      ) : member.verb === undefined ? null : (
        <span className="meridian-cast-chip__verb" data-stale={member.isVerbStale}>
          {member.verb}
        </span>
      )}
    </button>
  );
}
