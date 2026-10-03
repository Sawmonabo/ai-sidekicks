// Binds the mounts section to its reader, on the window's clock (`useBridgeClock`) so two time
// bases never share a screen. Reader and binding are separate modules so each is testable
// without the other.

import { useCallback, useMemo } from "react";

import type { ExecutionMode, WorkspaceId } from "@ai-sidekicks/contracts";

import { useStoreBoundReader } from "@renderer/hooks/subject-scoped/useStoreBoundReader.js";
import { useBridgeClock } from "@renderer/services/platform/hooks/useClock.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import type { RepoOperations } from "../../repo-operations.js";
import { RepoMountsReader } from "../repo-mounts-reader.js";
import type { RepoMountsReading } from "../repo-mounts-model.js";

/** What the hook hands a section: the reading, the picker's mutation, and the re-read. */
export interface RepoMountsBinding {
  readonly reading: RepoMountsReading;
  readonly requestModeSelection: (workspaceId: WorkspaceId, executionMode: ExecutionMode) => void;
  /**
   * Read the section again because a user's own act changed what it holds. Sent as
   * `user-request`: an attach or re-attach mints a mount no lifecycle frame announces, and the
   * request coalesces with the reader's other reasons into one read.
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
  const subject = useMemo(() => ({ bridge, operations }), [bridge, operations]);
  const { reader, reading } = useStoreBoundReader(
    subject,
    sessionStore.sessionId,
    sessionStore,
    () => new RepoMountsReader({ operations, sessionStore, clock }),
  );
  const requestModeSelection = useCallback(
    (workspaceId: WorkspaceId, executionMode: ExecutionMode) => {
      void reader.requestModeSelection(workspaceId, executionMode);
    },
    [reader],
  );
  const requestRead = useCallback(() => {
    reader.requestRead("user-request");
  }, [reader]);
  return { reading, requestModeSelection, requestRead };
}
