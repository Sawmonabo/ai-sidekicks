// Linux's primary selection, written through the bridge's selection clipboard.

import type { PlatformBridge } from "../bridge.js";
import type { PrimarySelection } from "./contract.js";

/** The primary selection Linux keeps, written through `bridge`'s selection clipboard. */
export function linuxPrimarySelection(bridge: PlatformBridge): PrimarySelection {
  return {
    takeSettledSelection: async (readText) => {
      const text = readText();
      if (text !== undefined) {
        await bridge.native.copyToClipboard({ text }, "selection");
      }
    },
  };
}
