// The one participant card the cast bar opens, for every chip in it.
//
// ONE HOST FOR THE WHOLE BAR, NOT ONE PER CHIP. The card is a hover surface on up to
// eight chips, and the shape that suggests itself — a tooltip root wrapped around each
// chip — mounts eight floating roots inside every console the bar appears in. It was
// built that way first and the frame's own routing suite stopped settling: a mount that
// had been a few macrotasks began exceeding the suite's five-second bound, and the two
// cases after it failed on an empty body. So the bar mints ONE handle, every chip is a
// trigger bound to it, and this file is the single popup they all open into — the same
// arrangement `ledger/cards/markdown/footnotes/FootnotePopoverHost.tsx` makes for the
// same reason, and the arrangement the library's own handle API exists to serve.
//
// THE ANCHORED PART OF THE CARD IS THE PRIMITIVE'S. `Tooltip.Root` and the handle stay
// here — one popup driven by many triggers is the arrangement this file exists for —
// while the portal, the positioner, and the popup are
// `primitives/overlay/OverlayTooltipPopup.tsx`'s, which is what registers the card in
// the window's airspace (`Spec-023 §Console Design (Meridian)` 12.3). A bar that
// mounted its own portal would be a card a native browser-pane view paints over.
//
// THE PAYLOAD IS THE MEMBER, not its id: the card names the participant, and a host that
// took an id would have to find the member again out of a model the bar already derived.

import { Tooltip } from "@base-ui/react/tooltip";

import { OverlayTooltipPopup } from "../../../primitives/index.js";
import { type SessionStore } from "../../../store/index.js";
import { ParticipantCard } from "./ParticipantCard.js";
import { type CastMember } from "../model/cast-bar-model.js";

/**
 * How far the card sits off the chip.
 *
 * A positioning offset rather than a density cap: it is the tooltip library's own
 * geometry argument and nothing else in the console spends it, so it stays beside the
 * one call that passes it rather than in the cap home, which holds the budgets a
 * surface is held to.
 */
const CARD_OFFSET_PX = 6;

export interface ParticipantCardHostProps {
  /** The handle every chip in this bar triggers, minted once by the bar. */
  readonly handle: Tooltip.Handle<CastMember>;
  /**
   * The store the participant card reads its four facts out of.
   *
   * Handed down rather than reached for, on the same terms every other reading in this
   * console is: a bar rendered in an auxiliary window reads THAT window's store.
   */
  readonly sessionStore: SessionStore;
}

/**
 * The card itself, mounted only while a chip is holding it open.
 *
 * The popup is what the library mounts on open and unmounts on close, so the card's
 * reading starts when somebody hovers or tabs to a chip and stops when they leave. A
 * card mounted with the chips would hold one store subscription per participant for the
 * life of the bar, which is the cost this arrangement exists to avoid.
 */
export function ParticipantCardHost(props: ParticipantCardHostProps): React.JSX.Element {
  return (
    <Tooltip.Root handle={props.handle}>
      {({ payload: member }: { readonly payload: CastMember | undefined }) => (
        <OverlayTooltipPopup sideOffset={CARD_OFFSET_PX} className="meridian-cast-chip__card">
          {/* No payload means no chip is holding it open, which is every render but
              the open one. Rendering nothing is the honest answer; a card composed
              from a remembered member would name somebody nobody pointed at. */}
          {member === undefined ? null : (
            <ParticipantCard
              sessionStore={props.sessionStore}
              participantId={member.participantId}
              label={member.label}
            />
          )}
        </OverlayTooltipPopup>
      )}
    </Tooltip.Root>
  );
}
