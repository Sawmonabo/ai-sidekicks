// How a section gets its reader, and how that reader gets closed.
//
// SPLIT OFF THE READER ON THE SEAM `proposals/` ALREADY HAS. That directory keeps
// `proposal-gate-reader.ts` and `proposal-gate-binding.ts` apart for the reason this
// module exists: a class that reads is testable without React, and a hook that mounts
// one is testable without a wire, and holding both in one file made it the size
// `apps/desktop/AGENTS.md` calls two jobs.
//
// The reader is constructed in a hook and never in a render body, subscribed through
// `useSyncExternalStore` so a publish is a single transition, and disposed on unmount —
// the three properties `apps/desktop/AGENTS.md` requires of anything holding state
// beside a component.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import type { ExecutionMode, WorkspaceId } from "@ai-sidekicks/contracts";

import { consoleClockFor, type ConsoleBridge } from "../../bridge/index.js";
import {
  CONTROLLER_DISPOSAL,
  useSubjectScopedResource,
  type SessionStore,
} from "../../store/index.js";
import { RepoMountsReader } from "./repo-mounts-reader.js";
import type { RepoMountsReading } from "./repo-mounts-model.js";
/** What the hook hands a surface: the reading, the picker's mutation, and the re-read. */
export interface RepoMountsBinding {
  readonly reading: RepoMountsReading;
  readonly requestModeSelection: (workspaceId: WorkspaceId, executionMode: ExecutionMode) => void;
  /**
   * Read the section again, because a participant's own act changed what it holds.
   *
   * `participant-request` AND NOT A NEW REASON. The scheduler's vocabulary already has
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
 * THE CLOCK COMES FROM THE BRIDGE, on `clone-expiry-wake-up.ts`'s reason one file
 * over: `consoleClockFor` is the one answer to which clock a window runs on, and the
 * deadline wake-up in the clone list already reads it — so a reader stamping its
 * reading off a clock of its own would put two time bases inside one list, and the
 * wall clock would win every `Math.max`. Memoised because the real arm mints a fresh
 * `RealClock` per call, and a new object every render would re-mint the reader.
 */
export function useRepoMounts(
  bridge: ConsoleBridge,
  sessionStore: SessionStore,
): RepoMountsBinding {
  const clock = useMemo(() => consoleClockFor(bridge), [bridge]);
  const { value: reader, settle } = useSubjectScopedResource(
    bridge,
    sessionStore.sessionId,
    () => new RepoMountsReader({ bridge, sessionStore, clock }),
    CONTROLLER_DISPOSAL,
  );
  useEffect(() => {
    // THE STORE AXIS, AND ONLY IT. The seam holds one resource per `(subject, key)`,
    // which here is `(bridge, session id)`: a store replaced under the same id retires
    // every read taken against the old one, and the key cannot carry that axis, so the
    // reader is asked instead. The replacement is PUBLISHED through the seam, so it is
    // closed on the seam's terms. The DISPOSAL axis that used to sit beside it —
    // strict mode running the seam's cleanup and then this setup again on the same
    // committed reader — is `isClosed`'s, above, and re-deriving it here disposed that
    // reader twice.
    if (!reader.isReadingFor(sessionStore)) {
      settle()(new RepoMountsReader({ bridge, sessionStore, clock }));
      return;
    }
    reader.start();
  }, [reader, settle, bridge, sessionStore, clock]);
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
    reader.requestRead("participant-request");
  }, [reader]);
  return { reading, requestModeSelection, requestRead };
}
