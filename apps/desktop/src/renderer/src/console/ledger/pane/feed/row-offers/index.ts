// The row-offer door: the control one row wears, and the binding behind it.
//
// A DOOR HERE BECAUSE THIS DIRECTORY HAS READERS OTHER THAN ITSELF — the family's one
// criterion, stated in `ledger/cards/index.ts`: the feed's row renderer draws the
// control and the feed itself binds it, and both are modules other than the ones that
// declare these names. `feed/` publishes no door for the mirror-image reason, so this
// is the nearest door the two readers can take.
//
// AND IT PUBLISHES EXACTLY WHAT THOSE TWO TAKE. The offer vocabulary, the pure
// builder, the surface shape and the two refusals are read inside this directory and
// by its own suites, which reach the declaring modules directly — a door line with no
// production reader is a dead export the barrel census fails, so this door is never
// widened for symmetry.
//
// AND THE SHEET IS IMPORTED HERE. The door that owns a directory is the door that
// imports its sheet (`ledger/ledger.css` states the rule), and this door publishes
// the component that draws every rule in it — so the sheet, its renderer, and the
// door that carries it are one place.

// The sheet this directory owns, imported by its own door.
import "./row-offers.css";

export { LedgerRowMenu } from "./LedgerRowMenu.js";
export { LedgerRowOffersMenu } from "./LedgerRowOffersMenu.js";

export { useLedgerRowOffers, type LedgerRowOffersBinding } from "./ledger-row-offers-binding.js";
