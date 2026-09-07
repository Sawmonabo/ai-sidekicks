// How a workspace card holds its execution-context reader, and nothing about the read.
//
// SPLIT FROM THE READER ON `proposal-gate-binding.ts`'S SEAM, and for its reasons: the
// class beside this one collaborates with the bridge and owns what a read publishes;
// this module collaborates with React's rendering lifecycle and owns when a reader is
// opened, subscribed, and ended. They meet at one object.
//
// THE SEAM IS `useSubjectScopedResource` AND NOT `useMemo`, which is that module's own
// distinction: a memo opened during a pass React discards really constructs the reader
// and really puts its read on the wire, and no effect ever commits to end it. The
// resource seam closes such a reader inside the render that drops it.
//
// KEYED BY THE WORKSPACE ID ALONE, because that is the whole of what the read takes.
// A key with more members in it would open a second reader whenever some unrelated
// part of the row moved, and every one of those would put the same call on the wire
// again for an answer that had not changed.
//
// THE SESSION STORE IS THE READER'S COLLABORATOR AND NOT THE SURFACE'S: it is what
// carries the reconnect edge and the repo-lifecycle frames, two of the four reasons
// `Spec-023 §Rules every console surface obeys` names. It is handed down rather than
// reached for, exactly as every other reading in this family takes it.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { consoleClockFor, type ConsoleBridge } from "../../bridge/index.js";
import {
  CONTROLLER_DISPOSAL,
  useSubjectScopedResource,
  type SessionStore,
} from "../../store/index.js";
import type { ExecutionContextReading } from "./execution-context-model.js";
import { WorkspaceExecutionContextReader } from "./execution-context-reader.js";

/**
 * Bind one workspace's execution-context reading to its reader.
 *
 * Returns the reading and nothing else: this read takes no argument a participant can
 * supply and answers no act, so there is no second member for a surface to call.
 */
export function useWorkspaceExecutionContext(
  bridge: ConsoleBridge,
  workspaceId: string,
  sessionStore: SessionStore,
): ExecutionContextReading {
  // THE CLOCK COMES FROM THE BRIDGE, on `repo-mounts-binding.ts`'s reason: one window,
  // one time base, so this refresh coalesces on the clock the section around it
  // advances on. Memoised because the real arm mints a fresh clock per call and a new
  // object every render would re-mint the reader beneath it.
  const clock = useMemo(() => consoleClockFor(bridge), [bridge]);
  const { value: reader } = useSubjectScopedResource(
    bridge,
    workspaceId,
    () => new WorkspaceExecutionContextReader({ bridge, workspaceId, sessionStore, clock }),
    CONTROLLER_DISPOSAL,
  );
  useEffect(() => {
    reader.start();
  }, [reader]);
  const subscribe = useCallback(
    (onReadingChange: () => void) => reader.subscribe(onReadingChange),
    [reader],
  );
  const read = useCallback(() => reader.snapshot, [reader]);
  return useSyncExternalStore(subscribe, read, read);
}
