// How a React surface holds one worktree's gate reader, and nothing about what the
// reader reads.
//
// Split from `proposal-gate-reader.ts` on the seam that file already names: the class
// beside this one owns the READ — which calls, in what order, and what it publishes
// when one does not answer — and this module owns the BINDING, which is a different
// subject with a different collaborator (React's rendering lifecycle rather than the
// bridge) and its own teardown. They meet at one object, the reader, which is the
// whole seam. Kept together the file was doing two jobs at once, which
// `apps/desktop/AGENTS.md` rejects.
//
// The reader is constructed in a hook and never in a render body, subscribed through
// `useSyncExternalStore` so a publish is a single transition, and disposed on unmount
// — the three properties that document requires of anything holding state beside a
// component.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import type { ConsoleBridge } from "../bridge/index.js";
import type { SessionStore } from "../store/index.js";
import { ProposalGateReader, type ProposalGateReading } from "./proposal-gate-reader.js";
import type { ProposalAction } from "./proposal-actions.js";
import type { ProposalGateSubject } from "./proposal-gate-model.js";

/** What the hook hands a surface: the reading, and the one act it sends. */
export interface ProposalGateBinding {
  readonly reading: ProposalGateReading;
  readonly requestAction: (action: ProposalAction) => void;
}

/**
 * Bind one worktree's gate to its reader.
 *
 * The subject is destructured into the dependency list rather than depended on as an
 * object, because a caller composing it inline would otherwise mint a new reader on
 * every render. The session store is the reader's own collaborator rather than the
 * surface's: it is what carries the reconnect edge and the `workspace.stale` frame,
 * two of the four reasons `Spec-023 §Rules every console surface obeys` names.
 */
export function useProposalGate(
  bridge: ConsoleBridge,
  subject: ProposalGateSubject,
  sessionStore: SessionStore,
): ProposalGateBinding {
  const { workspaceId, worktreeId, executionMode } = subject;
  const reader = useMemo(
    () =>
      new ProposalGateReader({
        bridge,
        subject: { workspaceId, worktreeId, executionMode },
        sessionStore,
      }),
    [bridge, workspaceId, worktreeId, executionMode, sessionStore],
  );
  useEffect(() => {
    reader.start();
    return () => {
      reader.dispose();
    };
  }, [reader]);
  const subscribe = useCallback(
    (onReadingChange: () => void) => reader.subscribe(onReadingChange),
    [reader],
  );
  const read = useCallback(() => reader.snapshot, [reader]);
  const reading = useSyncExternalStore(subscribe, read, read);
  const requestAction = useCallback(
    (action: ProposalAction) => {
      void reader.requestAction(action);
    },
    [reader],
  );
  return { reading, requestAction };
}
