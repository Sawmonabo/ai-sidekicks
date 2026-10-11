// The primary selection of a system that keeps one, written through the bridge's selection
// clipboard only while it holds what it held when the selection settled, so a selection made
// meanwhile in another window stands. A middle-click pastes it.

import type { PlatformBridge } from "../bridge.js";
import { copyOnceBuilt } from "../clipboard/late-copy.js";
import type { PrimarySelection } from "./contract.js";

/** The primary selection the system keeps, written through `bridge`'s selection clipboard. */
export function keptPrimarySelection(bridge: PlatformBridge): PrimarySelection {
  return {
    isPastedByMiddleClick: true,
    takeSettledSelection: (readText, view) =>
      copyOnceBuilt(
        bridge,
        view,
        async (write) => {
          const text = await readText();
          if (text !== undefined) {
            await write({ text });
          }
        },
        "selection",
      ),
  };
}
