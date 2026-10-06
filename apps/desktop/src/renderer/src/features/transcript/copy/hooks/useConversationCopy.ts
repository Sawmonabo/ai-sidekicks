import { useCallback } from "react";

import { useAnnounce } from "#renderer/hooks/announce/useAnnounce.js";
import { usePlatformBridge } from "#renderer/services/platform/hooks/usePlatformBridge.js";
import { readConversationSelection } from "../conversation-selection.js";

/**
 * The conversation's `copy` handler, for the element holding its rows. A copy of a selection in
 * the conversation goes through main as its flavors, joined in the order the rows are read,
 * while focus may sit in the message box; a selection in the message box itself never reaches
 * this element, so the platform copies it as it is. A refused write is said aloud.
 */
export function useConversationCopy(): (event: React.ClipboardEvent<HTMLElement>) => void {
  const bridge = usePlatformBridge();
  const announce = useAnnounce();
  return useCallback(
    (event: React.ClipboardEvent<HTMLElement>): void => {
      const selection = event.currentTarget.ownerDocument.getSelection();
      if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
        return;
      }
      const content = readConversationSelection(selection.getRangeAt(0), event.currentTarget);
      if (content === undefined) {
        return;
      }
      event.preventDefault();
      bridge.native.copyToClipboard(content).catch(() => {
        announce("Could not copy the selection", "assertive");
      });
    },
    [bridge, announce],
  );
}
