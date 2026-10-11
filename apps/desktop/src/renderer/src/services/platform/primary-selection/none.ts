// A system that keeps no primary selection: a settled selection writes nothing and a middle-click
// pastes nothing.

import type { PrimarySelection } from "./contract.js";

/** No primary selection: nothing is written and the text is never read. */
export const NO_PRIMARY_SELECTION: PrimarySelection = {
  isPastedByMiddleClick: false,
  takeSettledSelection: () => Promise.resolve(),
};
