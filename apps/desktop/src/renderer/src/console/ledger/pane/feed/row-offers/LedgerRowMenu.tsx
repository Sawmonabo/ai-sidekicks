// The one per-row control — the trigger, and nothing behind it.
//
// ONE CONTROL AND NOT FIVE BUTTONS. `Spec-023 §Console Design (Meridian)` rule 7 puts
// a row at one line until it is opened, and five inline controls would be five lines'
// worth of chrome on every row of a log a person scrolls through thousands of. So the
// row carries a single revealed trigger and the offers live behind it.
//
// THE REVEAL IS THE PRIMITIVE'S AND THE CONTROL IS THIS FAMILY'S.
// `primitives/figures/ledger-row.css` publishes `meridian-ledger-row__revealed` for exactly
// this: the row owns WHEN a secondary control appears — hover or focus-within — and
// the family owns what the thing is. Nothing here writes a hover rule, so the reveal
// stays one decision rather than a question the cascade answers.
//
// THE MENU IS THE FEED'S AND THIS IS A DETACHED TRIGGER FOR IT, which is a cost rule
// before it is a structural one. A `Menu.Root` builds a floating-tree node, a popup
// store, a positioner and an interaction stack; mounting one per row builds all of it
// for every row the viewport holds, for a menu at most one row ever has open — and it
// called the offer builder on every render of every mounted row to fill a popup that
// was not on screen. Measured on the endurance tier that machinery was megabytes of
// retained heap. So the row names the window's one handle and carries the row's own
// question as the trigger's `payload`; `LedgerRowOffersMenu.tsx` mounts the single
// root that answers it, and the offers are built when a menu opens rather than when a
// row renders.
//
// BASE UI OWNS THE BEHAVIOUR, and the detached trigger is its own published shape for
// this rather than a way around it: the trigger's `aria-haspopup` and `aria-expanded`,
// the popup's roles, arrow-key navigation, typeahead, Escape, outside press, and
// returning focus to THIS trigger on close are all still the library's.

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
  return (
    <Menu.Trigger
      handle={props.offers.menuHandle}
      // WHAT THIS ROW IS ASKING, carried to the popup by the library rather than
      // looked back up there. The popup opens for one trigger at a time, so the
      // request that fills it is the one the pressed row composed — and a row that
      // scrolled out of the mounted range while its menu was open still answers for
      // the row the reader pressed.
      payload={{
        row: props.row,
        density: props.density,
        chapterRunId: props.chapterRunId,
        bodyText: props.bodyText,
        pathReference: props.pathReference,
      }}
      className="meridian-ledger-row-menu__trigger meridian-ledger-row__revealed"
      // Named by the row's own summary rather than by its id: a screen reader
      // walking the window hears which entry the control belongs to, and the id
      // is an opaque token that says nothing out loud. It is still one press
      // away — "Copy entry id" is the first offer inside.
      aria-label={`Offers for the entry ${props.row.summary}`}
    >
      <Glyph name="more" size={GLYPH_SIZE_CHROME} />
    </Menu.Trigger>
  );
}
