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
//
// THE DISCLOSURE'S OWN OPEN STATE IS HERE FOR THE SAME REASON THE READER IS. Where the
// three paths stand is decided by a transition — the edge into `stale` — so somebody
// has to hold the position the last decision was taken at and compare. That is a
// lifecycle collaboration rather than a render, so it sits in a hook beside the one
// above rather than in the component's body; the RULE it applies is
// `execution-context-model.ts`'s, and nothing here decides what open means.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import type { WorkspaceState } from "@ai-sidekicks/contracts";
import { consoleClockFor, type ConsoleBridge } from "../../bridge/index.js";
import {
  CONTROLLER_DISPOSAL,
  useSubjectScopedResource,
  type SessionStore,
} from "../../store/index.js";
import {
  executionRootsDisclosureAfterWorkspaceState,
  initialExecutionRootsDisclosure,
  toggledExecutionRootsDisclosure,
  type ExecutionContextReading,
} from "./execution-context-model.js";
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

/** What a `<details>` needs to stand where this family's density rule puts it. */
export interface ExecutionRootsDisclosureBinding {
  readonly isOpen: boolean;
  readonly onToggle: (isOpen: boolean) => void;
}

/**
 * Bind the three-path disclosure's open state to the workspace's lifecycle position.
 *
 * The rule itself is `execution-context-model.ts`'s and is stated there. What this owns
 * is the React half: the position the last decision was taken at, carried across
 * renders, so the model can be asked about a TRANSITION rather than about the value of
 * the moment.
 *
 * THE NEW POSITION IS APPLIED DURING THE RENDER THAT FIRST SEES IT, not in an effect
 * after it — the documented shape for state that has to follow a prop — so a row going
 * `stale` never paints once collapsed and then jumps open. The model returns the value
 * it was handed where nothing moved, so the comparison settles in one pass and commits
 * no second render; the same identity rule makes the toggle a no-op when the platform
 * reports the state the disclosure is already in, which is what it does when the open
 * attribute is written rather than pressed.
 */
export function useExecutionRootsDisclosure(
  workspaceState: WorkspaceState,
): ExecutionRootsDisclosureBinding {
  const [disclosure, setDisclosure] = useState(() =>
    initialExecutionRootsDisclosure(workspaceState),
  );
  const derived = executionRootsDisclosureAfterWorkspaceState(disclosure, workspaceState);
  if (derived !== disclosure) {
    setDisclosure(derived);
  }
  const onToggle = useCallback((isOpen: boolean) => {
    setDisclosure((current) => toggledExecutionRootsDisclosure(current, isOpen));
  }, []);
  return { isOpen: derived.isOpen, onToggle };
}
