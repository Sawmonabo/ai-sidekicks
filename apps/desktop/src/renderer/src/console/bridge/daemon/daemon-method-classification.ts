// What the console's method set says about ITSELF, asked of every method at once.
//
// A SIBLING OF THE REGISTRY RATHER THAN A SECOND COPY OF IT.
// `daemon-reply-registry.ts` pairs each method with the two schemas its call is parsed
// against; this module answers what CALLING one does. Those are two subjects over one
// closed key set and only the first is about a shape, which is the seam. Both
// classifications are annotated as total maps over `ConsoleDaemonMethod`, so a method
// added to the contract next door is a missing-property error here rather than a row
// that classifies itself by default, and a key for a method the contract does not name
// does not compile either. A roster written anywhere else would be a second list of
// method strings, and a second list is the shape that goes stale in silence.
//
// TWO MAPS BECAUSE THEY ARE TWO QUESTIONS, and neither answers the other. Whether a
// call moves a RUN and whether it is a READING are independent over this set:
// `run.queueList` reads and moves no run, `repo.executionModeSelect` records and moves
// no run, `run.pause` records and moves one, and no registered method reads and moves
// one. Widening either to cover the other would put a claim written about run controls
// over every family that also reads.
//
// WHY THE READING PARTITION IS DECLARED AT ALL, when `DaemonCallOptions.signal` already
// states it at each call site. Because absence there is legal and therefore
// unenforceable: a read that simply FORGOT its signal is the same source text as a
// durable act that deliberately passes none, and two reads shipped through that gap
// before anything looked. A per-method statement is what lets a gate hold every call at
// the door to the rule its own method implies. Nothing in `callDaemon` consults either
// map — the call still says what it is doing, and this is what that saying is checked
// against.
//
// AND IT IS THE PARTITION THE SHELL BLOCK IS HELD TO, rather than a second opinion
// beside it. `store/shell/shell-mutation-block.ts` names the writes this console offers a
// CONTROL for, which is deliberately a subset — a method no surface dispatches has no
// control to disable — and its every registered member classifies as a record here. Two
// answers to "is this a write" that could disagree is the defect that pairing refuses.

import { CONSOLE_DAEMON_METHODS, type ConsoleDaemonMethod } from "./daemon-reply-registry.js";

/**
 * Whether each registered method CHANGES A RUN, answered for every one of them.
 *
 * A TOTAL MAP AND NOT A ROSTER, which is the whole reason it is here rather than
 * beside whichever caller wanted it. A roster of run-changing methods is a list that
 * goes stale in silence: the row a landing family adds to the contract next door is a
 * compile error until it is bound a schema, and would be nothing at all until someone
 * remembered to classify it. The mapped-type annotation makes the classification part
 * of adding the row.
 *
 * WHAT THE QUESTION MEANS, so a row is decided rather than guessed. `true` is: this
 * call starts, changes, or stops a run, or the queue of turns that becomes one. Pause
 * and resume move a run between states; the four intervention arms reach a running
 * one; the interrupt and the compaction are run-addressed on the driver plane and
 * both change the run they name. `false` is everything else, and several of them are
 * worth stating because they are mutations all the same: `repo.executionModeSelect`
 * records a WORKSPACE's execution mode and names no run; `session.create`,
 * `session.join`, `membership.update`, `invite.create` and `invite.revoke` change the
 * session's own roster; the repo attach, bind, prepare, retire, and dispose acts change mounts,
 * workspaces, and execution roots the same way; and `providerAccount.probe` re-checks
 * an account's readiness, which no run reads until its next admission. A mutation is
 * not automatically a run change, and reading it as one would put every family that
 * also reads under a claim written about run controls.
 *
 * WHICH IS ALSO WHY IT IS NOT THE DOOR'S READ-VERSUS-RECORD RULE. That question has a
 * map of its own below, and thirteen registered methods change no run and are no reading
 * either — every repo prepare, bind, select, retire, and dispose act, the four roster
 * writes, and the account probe. Reading this map's `false` as "a reading" would exempt
 * all twelve from the signal rule at once.
 */
const CHANGES_A_RUN: { readonly [MethodName in ConsoleDaemonMethod]: boolean } = Object.freeze({
  "run.queueCreate": true,
  "run.queueList": false,
  "run.queueCancel": true,
  "run.pause": true,
  "run.resume": true,
  "run.intervene": true,
  "driver.interruptRun": true,
  "driver.compactContext": true,
  "driver.listProviderCommands": false,
  "driver.listCapabilities": false,
  "driver.listModels": false,
  "repo.mountRead": false,
  "repo.workspaceList": false,
  "repo.executionModeCapabilitiesRead": false,
  "repo.executionModeSelect": false,
  "repo.worktreeStatusRead": false,
  "repo.attach": false,
  "repo.workspaceBind": false,
  "repo.executionRootPrepare": false,
  "repo.worktreeReuseCheck": false,
  "repo.ephemeralClonePrepare": false,
  "repo.ephemeralCloneDispose": false,
  "repo.worktreeRetire": false,
  "session.create": false,
  "session.join": false,
  "channel.list": false,
  "membership.update": false,
  "presence.read": false,
  "invite.create": false,
  "invite.revoke": false,
  "providerAccount.list": false,
  "providerAccount.probe": false,
});

/**
 * Whether each registered method ANSWERS A READING, answered for every one of them.
 *
 * `true` is: the call asks the daemon for a value and changes nothing, so whoever
 * asked may walk away from the answer — which is what makes the read round's abort
 * signal that caller's obligation rather than an option. `false` is a durable act: it
 * has HAPPENED once the daemon has it, so a signal on one would abandon the console's
 * half of a write mid-flight and leave a person reading a surface that says it did not
 * occur.
 *
 * READ OFF WHAT THE CALL DOES, NEVER OFF WHAT ITS REPLY IS NAMED. This partition was
 * first resolved in the architecture tier from the WORDS of each bound schema's
 * operation — `Read`, `List`, `Check` — which is a naming convention wearing a
 * classifier's clothes, and it fails in both directions: a durable write whose reply
 * schema happens to carry one of those words classifies as a read and is then required
 * to carry an abort signal that would abandon it, and a read named with a fourth verb
 * classifies as a write and is excused from carrying one. The rows below say which each
 * method is, once, where a reviewer meets them.
 *
 * THE HARD ROWS, stated so a later one is decided rather than guessed.
 * `repo.worktreeReuseCheck` asks whether a worktree can be reused and writes nothing,
 * so it reads. `providerAccount.probe` re-checks an account and RECORDS the reading it
 * took, so it does not. `run.queueList` reads a queue whose neighbours all move it.
 * And every `repo.*` prepare, bind, select, retire, and dispose act is a record: they
 * change mounts, workspaces, and execution roots, and none of them may be abandoned
 * once the daemon has it.
 */
const IS_A_READING: { readonly [MethodName in ConsoleDaemonMethod]: boolean } = Object.freeze({
  "run.queueCreate": false,
  "run.queueList": true,
  "run.queueCancel": false,
  "run.pause": false,
  "run.resume": false,
  "run.intervene": false,
  "driver.interruptRun": false,
  "driver.compactContext": false,
  "driver.listProviderCommands": true,
  "driver.listCapabilities": true,
  "driver.listModels": true,
  "repo.mountRead": true,
  "repo.workspaceList": true,
  "repo.executionModeCapabilitiesRead": true,
  "repo.executionModeSelect": false,
  "repo.worktreeStatusRead": true,
  "repo.attach": false,
  "repo.workspaceBind": false,
  "repo.executionRootPrepare": false,
  "repo.worktreeReuseCheck": true,
  "repo.ephemeralClonePrepare": false,
  "repo.ephemeralCloneDispose": false,
  "repo.worktreeRetire": false,
  "session.create": false,
  "session.join": false,
  "channel.list": true,
  "membership.update": false,
  "presence.read": true,
  "invite.create": false,
  "invite.revoke": false,
  "providerAccount.list": true,
  "providerAccount.probe": false,
});

/**
 * The registered methods that change a run — the console's one roster of them.
 *
 * Derived from the table above and from the registry's own key census, so the roster
 * and the classification cannot disagree and neither can drift from the method set.
 * A consumer that wants "which wire calls are run controls" reads this and never
 * writes its own list; the one that exists today is the architecture tier's
 * read-cancellation gate, whose claim is about exactly this set of dispatches.
 */
export const RUN_CHANGING_DAEMON_METHODS: readonly ConsoleDaemonMethod[] = Object.freeze(
  CONSOLE_DAEMON_METHODS.filter((method) => CHANGES_A_RUN[method]),
);

/**
 * The registered methods that answer a reading — the console's one roster of them.
 *
 * Derived the same way and for the same reason, and its complement within
 * `CONSOLE_DAEMON_METHODS` is the record set exactly: the map above is total, so every
 * registered method is on one side of this line and no method is on both. Its consumer
 * is the architecture tier's read-signal gate, which holds every call at the door to
 * showing the signal its own method implies.
 */
export const READING_DAEMON_METHODS: readonly ConsoleDaemonMethod[] = Object.freeze(
  CONSOLE_DAEMON_METHODS.filter((method) => IS_A_READING[method]),
);
