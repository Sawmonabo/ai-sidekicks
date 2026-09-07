// The one per-row control, and the offers behind it.
//
// ONE CONTROL AND NOT FIVE BUTTONS. `Spec-023 §Console Design (Meridian)` rule 7 puts
// a row at one line until it is opened, and five inline controls would be five lines'
// worth of chrome on every row of a log a person scrolls through thousands of. So the
// row carries a single revealed trigger and the offers live behind it, which is the
// same arrangement `collaboration/members/MembershipActionsMenu.tsx` reaches for.
//
// THE REVEAL IS THE PRIMITIVE'S AND THE CONTROL IS THIS FAMILY'S.
// `primitives/ledger-row.css` publishes `meridian-ledger-row__revealed` for exactly
// this: the row owns WHEN a secondary control appears — hover or focus-within — and
// the family owns what the thing is. Nothing here writes a hover rule, so the reveal
// stays one decision rather than a question the cascade answers.
//
// IT IS NOT REGISTERED WITH AN OVERLAY REGISTRY, AND THAT IS A STRUCTURAL FACT RATHER
// THAN AN OMISSION. The console's occlusion registry lives in a sibling VIEW family,
// and the layering gate forbids one view family importing another — the registry's
// own header says it is hoisted into a lower family by the task that adds the first
// overlay PRIMITIVE, and no primitive publishes one yet. Until that hoist lands, a
// menu in a view family registers nothing, which is what the membership menu next
// door does too.
//
// BASE UI OWNS THE BEHAVIOUR. The trigger's `aria-haspopup` and `aria-expanded`, the
// popup's roles, arrow-key navigation, typeahead, Escape, outside press, and
// returning focus to the trigger on close are the library's — an own build would be
// re-deciding a solved accessibility contract row by row.

import { Menu } from "@base-ui/react/menu";

import type { FilePathRef, TimelineRow } from "@ai-sidekicks/contracts";

import { Glyph } from "../../../../primitives/index.js";
import { type TimelineRowDensity } from "../../../../seats/index.js";
import { GLYPH_SIZE_CHROME } from "../../../../tokens/index.js";
import { type LedgerRowOffersBinding } from "./ledger-row-offers-binding.js";

export interface LedgerRowMenuProps {
  readonly row: TimelineRow;
  /** The collapse state the list handed this row, so "Open" and "Close" are honest. */
  readonly density: TimelineRowDensity;
  /**
   * The run whose chapter this window draws for this row, or `undefined`.
   *
   * Resolved by the row renderer against the window it is looking up bodies in, and
   * passed as a string so this component's memo boundary one level up still holds:
   * the window itself is a fresh object on every admitted event.
   */
  readonly chapterRunId: string | undefined;
  /**
   * The row's machine-authored body as this console has read it, or `undefined`.
   *
   * `undefined` for every row this build can render: the seat a row arrives through
   * carries no body, and the read that opens one is the growth slate's unregistered
   * `hydrated-event-read`. So "Copy body" is absent rather than present and inert,
   * which is the rule the offer builder states for every conditional offer.
   */
  readonly bodyText: string | undefined;
  /**
   * The opaque path token this row carries, or `undefined`.
   *
   * `undefined` for every row this build can render, and structurally so: the token
   * is minted by the main process and the renderer cannot build one from a string,
   * so "Reveal file" appears the day the timeline read serves one — the growth
   * slate's unregistered `timeline-path-reference` row.
   */
  readonly pathReference: FilePathRef | undefined;
  /** This window's offer binding. STABLE, or the row memo above moves with it. */
  readonly offers: LedgerRowOffersBinding;
}

/** The row's offers, behind one revealed control. */
export function LedgerRowMenu(props: LedgerRowMenuProps): React.JSX.Element {
  const offers = props.offers.offersFor({
    row: props.row,
    density: props.density,
    chapterRunId: props.chapterRunId,
    bodyText: props.bodyText,
    pathReference: props.pathReference,
  });
  return (
    <Menu.Root>
      <Menu.Trigger
        className="meridian-ledger-row-menu__trigger meridian-ledger-row__revealed"
        // Named by the row's own summary rather than by its id: a screen reader
        // walking the window hears which entry the control belongs to, and the id
        // is an opaque token that says nothing out loud. It is still one press
        // away — "Copy entry id" is the first offer inside.
        aria-label={`Offers for the entry ${props.row.summary}`}
      >
        <Glyph name="more" size={GLYPH_SIZE_CHROME} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="meridian-ledger-row-menu__positioner" sideOffset={4}>
          <Menu.Popup className="meridian-ledger-row-menu">
            {offers.map((offer) => (
              <Menu.Item
                key={offer.kind}
                className="meridian-ledger-row-menu__item"
                onClick={offer.perform}
              >
                {offer.label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
