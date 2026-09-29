import { useMemo } from "react";

import { parseConsolePaneAddress, type ConsolePaneAddress } from "@renderer/console/seats/index.js";
import type { SessionPane } from "../pane-layout/pane-layout.js";

/** The focused pane's address, for the composer's send router. */
export function useFocusedPaneAddress(
  panes: readonly SessionPane[],
  focusedPaneId: string | undefined,
): ConsolePaneAddress | undefined {
  return useMemo(() => {
    const pane = panes.find((candidate) => candidate.paneId === focusedPaneId);
    if (pane === undefined) {
      return undefined;
    }
    // Parsed rather than composed, for `paneContextFor`'s reason: the pair is not an
    // address until the seat says it is. A pane whose address the seat refuses routes
    // nothing — which is the same answer as no focused pane, and is the honest one:
    // the composer has no place to send to.
    const address = parseConsolePaneAddress(pane.kind, pane.entity);
    return "code" in address ? undefined : address;
  }, [panes, focusedPaneId]);
}
