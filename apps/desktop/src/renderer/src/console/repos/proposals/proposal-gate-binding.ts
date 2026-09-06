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

import { consoleClockFor, type ConsoleBridge } from "../../bridge/index.js";
import {
  useSubjectScopedResource,
  type SessionStore,
  type SubjectScopedDisposal,
} from "../../store/index.js";
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
 * THE SEAM IS ADDRESSED BY THE SUBJECT'S PARTS, NOT ITS IDENTITY: `proposalGateKeyOf`
 * below states which five, and why the object itself would open a reader per frame.
 *
 * `repoMountId` IS ONE OF THE FIVE even though the gate does not READ under it. It is
 * the only identity the registered `GitActionExecuteRequest` takes, so a reader holding
 * a stale one would send an act naming a mount the surface has moved off. Every arm
 * happens to resolve it from the workspace row, which makes it a function of
 * `workspaceId` in practice — but that is a property of three constructors elsewhere
 * rather than anything this hook can check, and a key member omitted because a caller
 * currently makes it redundant is a key member omitted.
 *
 * THE READER IS HELD BY `useSubjectScopedResource` RATHER THAN BY `useMemo`, which is
 * the difference between a resource closed however its render ended and one closed only
 * on the renders React keeps: a memo opened during a pass React then discards really
 * built the reader and really armed its refresh, and no effect ever committed to close
 * it. The seam closes that pass's reader inside the render that drops it.
 *
 * The session store is the reader's own collaborator rather than the surface's: it is
 * what carries the reconnect edge and the `workspace.stale` frame, two of the four
 * reasons `Spec-023 §Rules every console surface obeys` names.
 *
 * THE CLOCK COMES FROM THE BRIDGE, on `repo-mounts-reader.ts`'s reason: `consoleClockFor`
 * is the one answer to which clock a window runs on, so the gate's refresh window
 * coalesces on the same time base the section around it advances on. Memoised because
 * the real arm mints a fresh `RealClock` per call.
 */
export function useProposalGate(
  bridge: ConsoleBridge,
  subject: ProposalGateSubject,
  sessionStore: SessionStore,
): ProposalGateBinding {
  const clock = useMemo(() => consoleClockFor(bridge), [bridge]);
  const gateKey = proposalGateKeyOf(subject);
  const { value: reader, settle } = useSubjectScopedResource(
    bridge,
    gateKey,
    () => new ProposalGateReader({ bridge, subject, sessionStore, clock }),
    PROPOSAL_GATE_READER_DISPOSAL,
  );
  useEffect(() => {
    // THE STORE AXIS, AND ONLY IT. The seam holds one resource per `(subject, key)`,
    // which here is `(bridge, gate identity)`: the store whose repair edge and frames
    // are two of this gate's three refresh reasons is the axis that key cannot carry,
    // so the reader is asked instead. The replacement is PUBLISHED through the seam, so
    // it is closed on the seam's terms. The DISPOSAL axis that used to sit beside it —
    // strict mode running the seam's cleanup and then this setup again on the same
    // committed reader — is `isClosed`'s, below, and re-deriving it here disposed that
    // reader twice.
    if (!reader.isReadingFor(sessionStore)) {
      settle()(new ProposalGateReader({ bridge, subject, sessionStore, clock }));
      return;
    }
    reader.start();
    // `subject` is read inside the re-mint arm and is deliberately absent from the
    // list: its identity moves on every render while `gateKey` — which the held reader
    // is addressed by, and which is a function of the subject's five members — does
    // not. A re-mint therefore reads the subject of the render that triggered it, and
    // that subject agrees with the key by construction.
  }, [reader, settle, bridge, gateKey, sessionStore, clock]);
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
 * How one reader ends, and how one this module already ended is recognised.
 *
 * ONE MODULE-LEVEL OBJECT, because the resource seam holds `dispose` and `isClosed` on
 * dependencies of their own: a literal minted in the render body would hand over a
 * fresh identity on every pass and restart the lifetime beneath it. `dispose` here is
 * TERMINAL, which is why the reading travels beside it in the same object rather than
 * being re-derived in an effect — re-derived there it left the corpse recorded as
 * committed and disposed a second time when the caller's own replacement retired it.
 */
const PROPOSAL_GATE_READER_DISPOSAL: SubjectScopedDisposal<ProposalGateReader> = {
  dispose: (reader) => {
    reader.dispose();
  },
  isClosed: (reader) => reader.isDisposed,
};

/**
 * The whole of a subject's content, as the one string the resource seam keys on.
 *
 * THE SUBJECT ITSELF IS DELIBERATELY NOT THE KEY: every caller composes one inline — a
 * mount card builds one per worktree row on every render — so a seam addressed by the
 * object would open a reader, and a read, on every frame. These five values ARE its
 * content on every arm of the union, so two subjects agreeing on all five address the
 * same gate and the held reader is never stale.
 *
 * SEPARATED BY A CHARACTER NO MEMBER CAN CONTAIN, so two members cannot run together
 * into a third value: an id ending in a mode name beside an empty root id would
 * otherwise collide with a different subject under a plain join.
 */
function proposalGateKeyOf(subject: ProposalGateSubject): string {
  return [
    subject.kind,
    subject.workspaceId,
    subject.repoMountId,
    proposalGateSubjectRootId(subject) ?? "",
    subject.executionMode,
  ].join("\u0000");
}

/**
 * The id of the root this subject names, or `undefined` on the arm that names none.
 *
 * A branch root binds no separate root, so it HAS no id — which is why the key above
 * takes the value rather than a member name: one key segment serves all three arms and
 * `undefined` is the branch arm's honest answer rather than a missing segment.
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
