// Which registered daemon methods READ, and which put a RECORD on the far side.
//
// WHY THIS IS A TABLE AND NOT A NAME TEST. A method's name is not its
// classification: `repo.worktreeReuseCheck` ends in a word that reads like a write
// and is a `query`, `providerAccount.probe` reads like a read and writes the probed
// account's health row and its credential generation, and `driver.respondToRequest`
// names neither direction. Every row below is quoted from the operation's own
// `query` / `mutation` cell in `docs/architecture/contracts/api-payload-contracts.md`,
// which is the corpus registration the console mirrors rather than re-derives.
//
// TOTAL OVER THE REGISTRY, WHICH IS THE WHOLE POINT OF THE ANNOTATION. The map is
// declared `Record<ConsoleDaemonMethod, DaemonMethodKind>`, so a method added to
// `daemon-method-contract.ts` is a missing-property error here until somebody says
// which kind it is. A registry that could grow a method with no classification would
// grow one that the supervisor block silently treats as a read — which is a write
// staying live through an outage, and is exactly the drift this table closes.
//
// WHAT CONSUMES IT. The call door (`daemon-reply.ts`) refuses a RECORD while the
// supervisor is not serving; the render side reads its own closed tuple in
// `store/shell/shell-mutation-block.ts`, because `store/` sits below `bridge/` on the
// console DAG and may not import this module. Those two answers are held equal in
// both directions by `daemon-method-classification.test.ts`, so neither can drift
// from the other or from the registry.

import type { ConsoleDaemonMethod } from "./daemon-reply-registry.js";

/**
 * What one call does on the far side.
 *
 * Two arms and no third. A method that reads and writes is a RECORD: the question
 * this answers is whether the call may be put through a supervisor that is not
 * serving, and a call that writes anything may not.
 */
export type DaemonMethodKind = "read" | "record";

/**
 * Every registered method's kind, quoted from the corpus's own registration.
 *
 * Grouped by namespace in the registry table's own row order, so a reader comparing
 * the two reads them top to bottom.
 */
export const DAEMON_METHOD_KINDS: Record<ConsoleDaemonMethod, DaemonMethodKind> = Object.freeze({
  "run.queueCreate": "record",
  "run.queueList": "read",
  "run.queueCancel": "record",
  "run.pause": "record",
  "run.resume": "record",
  "run.intervene": "record",
  "driver.interruptRun": "record",
  // Named a mutation by `api-payload-contracts.md`'s run-control context bullet:
  // compaction "mutates the bound run's provider context" and is adjudicated as the
  // same Cedar action the pause and resume verbs take.
  "driver.compactContext": "record",
  "driver.listProviderCommands": "read",
  "driver.listCapabilities": "read",
  "driver.listModels": "read",
  // The answer to a provider-raised ask. It advances the run that is blocked on the
  // question, so it is a record whichever way the person answered.
  "driver.respondToRequest": "record",
  "timeline.reasoningSurfaceRead": "read",
  "timeline.childRunExpand": "read",
  "timeline.read": "read",
  "repo.attach": "record",
  "repo.mountRead": "read",
  "repo.workspaceBind": "record",
  "repo.executionModeCapabilitiesRead": "read",
  "repo.workspaceList": "read",
  "repo.executionModeSelect": "record",
  "repo.executionRootPrepare": "record",
  // A `query` in the corpus register, despite the verb in its name: it reports
  // whether an existing worktree could be reused and prepares nothing.
  "repo.worktreeReuseCheck": "read",
  "repo.ephemeralClonePrepare": "record",
  "repo.ephemeralCloneDispose": "record",
  "repo.worktreeRetire": "record",
  "repo.worktreeStatusRead": "read",
  "session.create": "record",
  "session.join": "record",
  "channel.list": "read",
  // Reaches the control plane THROUGH the daemon rather than terminating in it, and
  // a durable act is no less durable for having been forwarded — the roster it
  // changes is the session's.
  "membership.update": "record",
  "presence.read": "read",
  "invite.create": "record",
  "invite.revoke": "record",
  "providerAccount.list": "read",
  // Grouped with the account plane's eight mutating verbs by the corpus: it writes
  // the observed health state and its observation timestamp back to the probed
  // account's row, and applies the credential-generation rule in the same
  // transaction.
  "providerAccount.probe": "record",
});

/**
 * Whether a method string names a record. Total over every string.
 *
 * Takes `string` rather than `ConsoleDaemonMethod` because the door asks about the
 * method it was handed, and answers `false` for anything the registry does not bind:
 * an unregistered name reaches no wire through this console at all, so there is no
 * write for the supervisor block to close.
 */
export function isRecordDaemonMethod(method: string): boolean {
  return (
    Object.hasOwn(DAEMON_METHOD_KINDS, method) &&
    DAEMON_METHOD_KINDS[method as ConsoleDaemonMethod] === "record"
  );
}
