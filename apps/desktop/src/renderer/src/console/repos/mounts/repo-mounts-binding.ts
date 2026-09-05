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
import { useSubjectScopedResource, type SessionStore } from "../../store/index.js";
import { RepoMountsReader } from "./repo-mounts-reader.js";
import type { RepoMountsReading } from "./repo-mounts-model.js";
/** Close one reader. Declared once so the resource seam holds one identity for it. */
function closeRepoMountsReader(reader: RepoMountsReader): void {
  reader.dispose();
}

/** What the hook hands a surface: the reading, and the one mutation the picker sends. */
export interface RepoMountsBinding {
  readonly reading: RepoMountsReading;
  readonly requestModeSelection: (workspaceId: WorkspaceId, executionMode: ExecutionMode) => void;
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
    closeRepoMountsReader,
  );
  useEffect(() => {
    // THE RE-MINT ARM, on `useAttachmentCarrier`'s pattern and for its two reasons.
    // Strict mode runs the seam's cleanup and then this setup again on the SAME
    // committed reader, and `dispose` is terminal — `start()` on it returns early, so
    // the section sat unread with nothing on screen to say why. And the seam holds one
    // resource per `(subject, key)`, which here is `(bridge, session id)`: a store
    // replaced under the same id retires every read taken against the old one, and the
    // key cannot carry that axis, so the reader is asked instead. Either way the
    // replacement is PUBLISHED through the seam, so it is closed on the seam's terms.
    if (reader.isDisposed || !reader.isReadingFor(sessionStore)) {
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
  return { reading, requestModeSelection };
}
