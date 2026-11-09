import { useSyncExternalStore } from "react";

import { readCanMoveToBackground, subscribeToCanMoveToBackground } from "../background-requests.js";

/** Whether the mounted composer's session runs a command its provider offers to move now. */
export function useCanMoveToBackground(): boolean {
  return useSyncExternalStore(subscribeToCanMoveToBackground, readCanMoveToBackground);
}
