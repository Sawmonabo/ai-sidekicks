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

import type { ConsoleBridge } from "../../bridge/index.js";
import type { SessionStore } from "../../store/index.js";
import { ProposalGateReader, type ProposalGateReading } from "./proposal-gate-reader.js";
import type { ProposalAction } from "./proposal-actions.js";
import type { ProposalGateSubject } from "./proposal-gate-model.js";

/** What the hook hands a surface: the reading, and the one act it sends. */
export interface ProposalGateBinding {
  readonly reading: ProposalGateReading;
  readonly requestAction: (action: ProposalAction) => void;
}

/**
 * Bind one execution root's gate to its reader.
 *
 * THE DEPENDENCIES ARE THE SUBJECT'S PARTS, NOT ITS IDENTITY, and that is deliberate:
 * every caller composes the subject inline — a mount card builds one per worktree row
 * on every render — so a memo keyed on the object would mint a new reader, and a new
 * read, on every render. The parts below are the whole of every arm of the union
 * (`kind`, `workspaceId`, the arm's own root id, and `executionMode`), so two subjects
 * agreeing on all four are the same subject and the captured one is never stale.
 *
 * The session store is the reader's own collaborator rather than the surface's: it is
 * what carries the reconnect edge and the `workspace.stale` frame, two of the four
 * reasons `Spec-023 §Rules every console surface obeys` names.
 */
export function useProposalGate(
  bridge: ConsoleBridge,
  subject: ProposalGateSubject,
  sessionStore: SessionStore,
): ProposalGateBinding {
  const { kind, workspaceId, executionMode } = subject;
  const executionRootId = proposalGateSubjectRootId(subject);
  const reader = useMemo(
    () => new ProposalGateReader({ bridge, subject, sessionStore }),
    // The subject itself is deliberately NOT a dependency: every caller composes it
    // inline, so its identity changes on every render while its content does not. The
    // four values below ARE its content, on every arm of the union.
    [bridge, kind, workspaceId, executionRootId, executionMode, sessionStore],
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

/**
 * The id of the root this subject names, or `undefined` on the arm that names none.
 *
 * A branch root binds no separate root, so it HAS no id — which is why the memo above
 * takes the value rather than a member name: one dependency slot serves all three arms
 * and `undefined` is the branch arm's honest answer rather than a missing dependency.
 */
function proposalGateSubjectRootId(subject: ProposalGateSubject): string | undefined {
  switch (subject.kind) {
    case "worktree":
      return subject.worktreeId;
    case "ephemeral-clone":
      return subject.cloneId;
    case "branch-root":
      return undefined;
  }
}
