// The chip's own element, so the tooltip has a component to hand its trigger props to.
//
// ITS OWN MODULE FOR THE ONE-COMPONENT RULE, and the split is what the tooltip needs
// anyway: Base UI's `render` prop clones an element and merges its own props into it,
// so the thing being cloned has to be addressable. `CastChip.tsx` is the chip AND its
// card; this is the button.
//
// THE TRIGGER PROPS ARE SPREAD RATHER THAN NAMED. What the tooltip merges in — the
// pointer and focus handlers, the description association, the open-state attribute —
// is the library's contract, not this file's, and naming them would be a second
// spelling of it that goes stale silently. The chip's own attributes are written after
// the spread so nothing the library passes can displace the hue, the label, or the act.

import { Glyph, WireFigure } from "../../../primitives/index.js";
import { GLYPH_SIZE_DENSE } from "../../../tokens/index.js";
import {
  CAST_ATTENTION_CLAUSE,
  castChipAccessibleName,
  type CastMember,
} from "../model/cast-bar-model.js";

/** Carries one participant's hue into the chip's ring, without a style attribute per rule. */
export interface CastChipStyle extends React.CSSProperties {
  readonly "--meridian-cast-hue": string;
}

export type CastChipButtonProps = {
  readonly member: CastMember;
  readonly style: CastChipStyle;
  readonly onFollow: (participantId: string) => void;
} & React.ButtonHTMLAttributes<HTMLButtonElement>;

/**
 * The chip itself, split out so the tooltip's `render` prop has a component to clone.
 *
 * Base UI merges its trigger props — the hover and focus handlers, the description
 * association — into whatever element this returns, which is why the props it passes
 * are spread rather than named: naming them would be this file restating a contract
 * the library owns, and dropping one silently would leave the card unreachable from
 * the keyboard.
 */
export function CastChipButton(props: CastChipButtonProps): React.JSX.Element {
  const { member, style, onFollow, ...triggerProps } = props;
  return (
    <button
      {...triggerProps}
      type="button"
      className="meridian-cast-chip"
      style={style}
      data-ring={member.hue.ringTreatment}
      data-shares-step={member.hue.sharesStepWithEarlierParticipant}
      data-attention={member.needsAttention}
      aria-label={castChipAccessibleName(member)}
      onClick={() => {
        onFollow(member.participantId);
      }}
    >
      {/* Presence is not a wire the console has. The glyph is drawn in the
          not-checked treatment rather than as a state, because "we have not asked"
          and "they are online" are different facts. */}
      <Glyph name="dot" size={GLYPH_SIZE_DENSE} title="Presence has not been read" />
      {/* No `title` on the name. The id used to ride one, which is a hover affordance
          answering a question nobody asked; the card behind this chip carries the id as
          a selectable wire figure beside the four facts the design names. */}
      <span className="meridian-cast-chip__name">
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
