// What an empty ledger window draws.

import { Nothing } from "../../../../primitives/index.js";
import { EMPTY_LEDGER_WORDS } from "./empty-window-words.js";

/** The window with nothing in it, in the console's own shape for an absence. */
export function EmptyLedgerWindow(): React.JSX.Element {
  return (
    <Nothing
      kind="empty"
      placement="surface"
      title={EMPTY_LEDGER_WORDS.title}
      detail={EMPTY_LEDGER_WORDS.detail}
    />
  );
}
