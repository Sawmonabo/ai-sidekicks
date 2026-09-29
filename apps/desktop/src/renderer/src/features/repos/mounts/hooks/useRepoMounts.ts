// How a section gets its reader, and how that reader gets closed.
//
// A class that reads is testable without React, and a hook that mounts one is testable
// without a daemon, which is why the reader (`repo-mounts-reader.ts`) and this binding
// are two modules.
//
// The reader is constructed in a hook and never in a render body, subscribed through
// `useSyncExternalStore` so a publish is a single transition, and disposed on unmount —
// the three properties `apps/desktop/AGENTS.md` requires of anything holding state
// beside a component.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import type { ExecutionMode, WorkspaceId } from "@ai-sidekicks/contracts";

import { consoleClockFor, type ConsoleBridge } from "@renderer/console/bridge/console-bridge.js";
import { CONTROLLER_DISPOSAL } from "@renderer/lib/subject-scoped/subject-scoped-disposal.js";
import { useSubjectScopedResource } from "@renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import type { RepoOperations } from "../../repo-operations.js";
import { RepoMountsReader } from "../repo-mounts-reader.js";
import type { RepoMountsReading } from "../repo-mounts-model.js";
/** What the hook hands a surface: the reading, the picker's mutation, and the re-read. */
export interface RepoMountsBinding {
  readonly reading: RepoMountsReading;
  readonly requestModeSelection: (workspaceId: WorkspaceId, executionMode: ExecutionMode) => void;
  /**
   * Read the section again, because a user's own act changed what it holds.
   *
   * `user-request` AND NOT A NEW REASON. The scheduler's vocabulary already has
   * the member for an act a person performed, and the attach and re-attach controls are
   * exactly that: the mount they mint is not announced by any lifecycle frame this
   * reader subscribes to, so without this the section would keep reporting the roster it
   * read before the act. It coalesces with the reader's other reasons, so an attach that
   * lands beside a reconnect is one read and not two.
   */
  readonly requestRead: () => void;
}

/**
 * Bind one section to its reader.
 *
 * The reader is constructed in a hook and never in a render body, subscribed through
 * `useSyncExternalStore` so a publish is a single transition, and disposed on
 * unmount — the three properties `apps/desktop/AGENTS.md` requires of anything that
 * holds state beside a component.
 *
 * THE CLOCK COMES FROM THE BRIDGE: `consoleClockFor` is the one answer to which clock a
 * window runs on, so a reader stamping its reading off a clock of its own would put two
 * time bases on one screen. Memoized because the real arm mints a fresh `RealClock` per
 * call, and a new object every render would re-mint the reader.
 *
 * A NEW `operations` OBJECT RE-MINTS THE READER, because the subject is the bridge together
 * with the calls and the reader reads through the ones it was built with. A caller
 * therefore holds one object for as long as the section should keep its reading.
 */
export function useRepoMounts(
  bridge: ConsoleBridge,
  sessionStore: SessionStore,
  operations: RepoOperations,
): RepoMountsBinding {
  const clock = useMemo(() => consoleClockFor(bridge), [bridge]);
  const subject = useMemo(() => ({ bridge, operations }), [bridge, operations]);
  const { value: reader, settle } = useSubjectScopedResource(
    subject,
    sessionStore.sessionId,
    () => new RepoMountsReader({ operations, sessionStore, clock }),
    CONTROLLER_DISPOSAL,
  );
  useEffect(() => {
    // THE STORE AXIS, AND NOT THE DISPOSAL. The seam holds one resource per
    // `(subject, key)`, which here is `({ bridge, operations }, session id)`: a store
    // replaced under the same id retires every read taken against the old one, and the key
    // cannot carry that axis, so the reader is asked instead. The replacement is PUBLISHED
    // through the seam, so it is closed on the seam's terms. Strict mode running the
    // seam's cleanup and then this setup again on the same committed reader is
    // `isClosed`'s, above, and re-deriving it here would dispose that reader twice.
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
