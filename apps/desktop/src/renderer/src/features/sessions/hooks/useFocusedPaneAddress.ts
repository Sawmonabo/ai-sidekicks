import { useMemo } from "react";

import { parsePaneAddress } from "#renderer/routing/panes/parse-address.js";
import { type PaneAddress } from "#renderer/routing/panes/address.js";
import type { SessionPane } from "../pane-layout/state.js";

/** The focused pane's address, for the composer's send router. */
export function useFocusedPaneAddress(
  panes: readonly SessionPane[],
  focusedPaneId: string | undefined,
): PaneAddress | undefined {
  return useMemo(() => {
    const pane = panes.find((candidate) => candidate.paneId === focusedPaneId);
    if (pane === undefined) {
      return undefined;
    }
    // Parsed rather than composed: a pair `parsePaneAddress` refuses routes nothing, the same
    // as no focused pane, since the composer has nowhere to send.
    const address = parsePaneAddress(pane.kind, pane.entity);
    return "code" in address ? undefined : address;
  }, [panes, focusedPaneId]);
}
