// The window's ONE row-offer menu, and the reason there is only one.
//
// A MENU PER MOUNT RATHER THAN PER ROW. Every row wears its own trigger — that part is
// per row and has to be, since the control is anchored to the row a reader is pointing
// at — but the machine behind it is not: `Menu.Root` builds a floating-tree node, a
// popup store, a positioner, and an interaction stack, and a virtualized ledger mounts
// as many rows as the viewport holds. One of those per row is a menu built for every
// row so that at most one row can have it open. Measured over the endurance tier's
// churn it was megabytes of retained heap and a slower frame in every streaming lane.
//
// AND THE OFFERS ARE BUILT WHEN ONE OPENS, not when a row renders. The per-row menu
// called the offer builder in each row's render body to fill a popup that was closed,
// so every admitted event rebuilt an offer list — with its closures — for every
// mounted row. Here the builder runs once, against the payload of the trigger that
// was actually pressed.
//
// WHICH ROW IT IS ANSWERING FOR TRAVELS ON THE TRIGGER. Base UI carries the pressed
// trigger's `payload` into this render function, so nothing here looks a row back up
// out of the window — which matters for a list that moves: the reader's row may have
// left the mounted range by the time they choose an offer, and the request they
// pressed is still the one being answered.
//
// THE ANCHORED PART IS THE PRIMITIVE'S. `primitives/overlay/OverlayMenuPopup.tsx` owns
// the portal, the positioner, and the popup, and registers the popup in the window's
// airspace. A menu that mounted its own
// portal would be one a native browser-pane view paints over and takes the presses of,
// and it would be invisible to the registry, because the consumer never touches the
// registration at all.

import { Menu } from "@base-ui/react/menu";

import { OverlayMenuPopup } from "../../../../primitives/index.js";
import {
  type LedgerRowOfferRequest,
  type LedgerRowOffersBinding,
} from "./ledger-row-offers-binding.js";
import { type LedgerRowOffer } from "./ledger-row-offers.js";

export interface LedgerRowOffersMenuProps {
  /** This window's offer binding — the handle every row's trigger names, and the offers. */
  readonly offers: LedgerRowOffersBinding;
}

/** The one menu a window's row triggers open. */
export function LedgerRowOffersMenu(props: LedgerRowOffersMenuProps): React.JSX.Element {
  return (
    <Menu.Root handle={props.offers.menuHandle}>
      {({ payload }) => (
        <OverlayMenuPopup
          positionerClassName="meridian-ledger-row-menu__positioner"
          sideOffset={4}
          className="meridian-ledger-row-menu"
        >
          {offersForPayload(props.offers, payload).map((offer) => (
            <Menu.Item
              key={offer.kind}
              className="meridian-ledger-row-menu__item"
              onClick={offer.perform}
            >
              {offer.label}
            </Menu.Item>
          ))}
        </OverlayMenuPopup>
      )}
    </Menu.Root>
  );
}

/**
 * The offers for the trigger that opened this menu, or none at all.
 *
 * A menu with no active trigger has no row to answer for, which is the state between
 * a close and the next press. It draws nothing rather than guessing at a last row: an
 * offer list built from a row nobody pressed would act on that row when chosen.
 */
function offersForPayload(
  offers: LedgerRowOffersBinding,
  payload: LedgerRowOfferRequest | undefined,
): readonly LedgerRowOffer[] {
  return payload === undefined ? NO_OFFERS : offers.offersFor(payload);
}

/** No offers at all. One frozen value, so a menu with no active trigger allocates none. */
const NO_OFFERS: readonly LedgerRowOffer[] = Object.freeze([]);
