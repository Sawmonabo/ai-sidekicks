// Binds the mounts section to its reader, on the window's clock (`useBridgeClock`) so two time
// bases never share a screen. Reader and binding are separate modules so each is testable
// without the other.

import { useCallback, useMemo } from "react";

import { useStoreBoundReader } from "#renderer/hooks/subject-scoped/useStoreBoundReader.js";
import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import { useBridgeClock } from "#renderer/services/platform/hooks/useClock.js";
import { type PlatformBridge } from "#renderer/services/platform/bridge.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import type { RepoOperations } from "../../operations.js";
import { RepoMountsReader } from "../reader.js";
import type { RepoMountsReading } from "../reading.js";

/** What the hook hands a section: the reading and the re-read. */
export interface RepoMountsBinding {
  readonly reading: RepoMountsReading;
  /**
   * Read the section again because a user's own act changed what it holds. Sent as
   * `user-request`: an attach mints a mount no lifecycle frame announces, and the request
   * coalesces with the reader's other reasons into one read.
   */
  readonly requestRead: () => void;
}

/**
 * Bind one section to its reader, keyed on the session. A new `operations` object re-mints the
 * reader, so a caller holds one object for as long as the section should keep its reading.
 */
export function useRepoMounts(
  bridge: PlatformBridge,
  sessionStore: SessionStore,
  operations: RepoOperations,
): RepoMountsBinding {
  const clock = useBridgeClock();
  const ownerWindow = useOwnerWindow();
  const subject = useMemo(() => ({ bridge, operations }), [bridge, operations]);
  const { reader, reading } = useStoreBoundReader(
    subject,
    sessionStore.sessionId,
    sessionStore,
    () => new RepoMountsReader({ operations, sessionStore, ownerWindow, clock }),
  );
  const requestRead = useCallback(() => {
    reader.requestRead("user-request");
  }, [reader]);
  return { reading, requestRead };
}
