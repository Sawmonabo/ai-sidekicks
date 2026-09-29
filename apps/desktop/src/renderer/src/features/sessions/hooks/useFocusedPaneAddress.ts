import { useMemo } from "react";

import { parsePaneAddress } from "@renderer/routing/panes/parse-pane-address.js";
import { type PaneAddress } from "@renderer/routing/panes/pane-address.js";
import type { SessionPane } from "../pane-layout/pane-layout.js";

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
    // Parsed rather than composed, for `paneContextFor`'s reason: the pair is not an
    // address until `parsePaneAddress` says it is. A pane whose address it refuses routes
    // nothing — which is the same answer as no focused pane, and is the honest one:
    // the composer has no place to send to.
    const address = parsePaneAddress(pane.kind, pane.entity);
    return "code" in address ? undefined : address;
  }, [panes, focusedPaneId]);
}
