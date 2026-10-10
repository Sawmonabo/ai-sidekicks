// macOS and Windows keep no primary selection, so a settled selection writes nothing.

import type { PrimarySelection } from "./contract.js";

/** The primary selection on macOS and Windows: none, so nothing is written and the text unread. */
export const MAC_AND_WINDOWS_PRIMARY_SELECTION: PrimarySelection = {
  takeSettledSelection: () => Promise.resolve(),
};
