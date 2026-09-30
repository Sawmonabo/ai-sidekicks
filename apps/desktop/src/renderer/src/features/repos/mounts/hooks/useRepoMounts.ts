// Binds a section to its reader. The reader is built in a hook and never in a render body,
// subscribed through `useSyncExternalStore` so a publish is one transition, and disposed on
// unmount. Reader and binding are separate modules so each is testable without the other.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import type { ExecutionMode, WorkspaceId } from "@ai-sidekicks/contracts";

import { CONTROLLER_DISPOSAL } from "@renderer/lib/subject-scoped/subject-scoped-disposal.js";
import { useSubjectScopedResource } from "@renderer/hooks/subject-scoped/useSubjectScopedResource.js";
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
 * Bind one section to its reader, on the window's clock (`useBridgeClock`) so two time bases
 * never share a screen. A new `operations` object re-mints the reader, so a caller holds one
 * object for as long as the section should keep its reading.
 */
export function useRepoMounts(
  bridge: PlatformBridge,
  sessionStore: SessionStore,
  operations: RepoOperations,
): RepoMountsBinding {
  const clock = useBridgeClock();
  const subject = useMemo(() => ({ bridge, operations }), [bridge, operations]);
  const { value: reader, settle } = useSubjectScopedResource(
    subject,
    sessionStore.sessionId,
    () => new RepoMountsReader({ operations, sessionStore, clock }),
    CONTROLLER_DISPOSAL,
  );
  useEffect(() => {
    // The store axis: the seam keys a resource on `(subject, session id)` and cannot see a
    // store replaced under the same id, so the reader is asked. The replacement is published
    // through the seam, which closes it. Strict mode's replayed setup on a closed reader is
    // the seam's `isClosed`, and re-deriving it here would dispose that reader twice.
    if (!reader.isReadingFor(sessionStore)) {
      settle()(new RepoMountsReader({ operations, sessionStore, clock }));
      return;
    }
    reader.start();
  }, [reader, settle, operations, sessionStore, clock]);
  const subscribe = useCallback(
    (onReadingChange: () => void) => reader.subscribe(onReadingChange),
    [reader],
  );
  const read = useCallback(() => reader.snapshot, [reader]);
  const reading = useSyncExternalStore(subscribe, read, read);
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
