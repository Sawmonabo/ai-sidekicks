// Linux's primary selection, written through the bridge's selection clipboard only while it holds
// what it held when the selection settled, so a selection made meanwhile in another window stands.

import type { PlatformBridge } from "../bridge.js";
import { LateClipboardCopy } from "../late-clipboard-copy.js";
import type { PrimarySelection } from "./contract.js";

/** The primary selection Linux keeps, written through `bridge`'s selection clipboard. */
export function linuxPrimarySelection(bridge: PlatformBridge): PrimarySelection {
  return {
    takeSettledSelection: async (readText) => {
      const lateCopy = new LateClipboardCopy(bridge, "selection");
      const text = await readText();
      if (text !== undefined) {
        await lateCopy.write({ text });
      }
    },
  };
}
