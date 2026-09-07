// What a supervisor's condition closes, and the method set that rule applies to.
//
// SPLIT FROM `shell-state.ts`, which owns the vocabulary. That module says what the
// shell reported; this one says what the report COSTS — which is a different job with
// a different reader, and together they were one file past the package's ceiling. The
// seam is clean because nothing here is part of the report: a block is derived from a
// state and from a method name, and the state module knows about neither.
//
// `Spec-023 §Daemon Supervision Lifecycle` step 3 is the rule underneath both halves:
// mutating operations are blocked while the supervisor is not serving, and read-only
// subscriptions continue.

import type { ShellState } from "./shell-state.js";

/**
 * The daemon methods this console treats as mutating, and no others.
 *
 * `Spec-023 §Daemon Supervision Lifecycle` step 3 blocks mutating operations and
 * permits read-only subscriptions, and the classification is a registration's own
 * `mutating` flag rather than a judgement made here.
 *
 * WHICH REGISTRATION, THOUGH — AND THE FIRST ANSWER WAS THE WRONG INSTRUMENT. This
 * tuple was resolved from a census of the handlers the daemon has SHIPPED
 * (`packages/runtime-daemon/src/ipc/handlers/`), and a census of what has landed
 * bounds the mutating set from BELOW and not from above: the console calls methods
 * that daemon has no handler for yet — that is what the growth slate is — so a method
 * absent from it is unregistered rather than read-only. Reading the absence as a
 * classification is how `providerAccount.probe` came to be omitted while
 * `bridge/daemon/daemon-reply-registry.ts` was already carrying it and calling it a
 * mutating verb: the account plane's own contract registers eight mutating verbs and
 * the probe is one of them, and a re-check dispatched through a stopped supervisor is
 * a write this window had no business putting.
 *
 * So the authority is the CORPUS registration — `api-payload-contracts.md`, per
 * namespace — of which the shipped handlers are the subset that has landed.
 * `test/console/architecture/daemon-mutating-registrations.test.ts` holds the tuple to
 * that subset in the one direction a census can support: every shipped
 * `mutating: true` registration is named here, and nothing named here is shipped
 * `mutating: false`. What the gate cannot answer — a corpus-registered verb whose
 * handler has not landed — is what the paragraph above is for.
 *
 * The table stays a closed tuple so "exactly these and no others" is countable, and so
 * an added mutating verb is a deliberate edit here rather than a control that silently
 * stays live through an outage.
 */
export const MUTATING_DAEMON_METHODS = [
  "session.create",
  "session.join",
  "driver.interruptRun",
  "driver.applyIntervention",
  "driver.respondToRequest",
  "driver.compactContext",
  "providerAccount.probe",
] as const;

/** One mutating method name. Derived from the tuple above. */
export type MutatingDaemonMethod = (typeof MUTATING_DAEMON_METHODS)[number];

/** Whether a method string is one of the seven. Total over every string. */
export function isMutatingDaemonMethod(method: string): method is MutatingDaemonMethod {
  return (MUTATING_DAEMON_METHODS as readonly string[]).includes(method);
}

/**
 * Why a mutating control is closed, or `undefined` while nothing closes it.
 *
 * The two members are the console's own refusal fields — a code in mono and a
 * sentence — so a control renders this through the same `InlineRefusal` it renders a
 * daemon refusal through, and no surface grows a second shape for "the shell says
 * no".
 */
export interface ShellMutationBlock {
  readonly code: string;
  readonly detail: string;
}

/**
 * The cause a disabled control names, or `undefined` while none applies.
 *
 * Four codes rather than the three failures the design enumerates: `stopped` is a
 * deliberate shutdown and reads as one, and folding it into "offline" would report a
 * shell somebody turned off as a shell that could not be reached.
 */
export function shellMutationBlock(state: ShellState): ShellMutationBlock | undefined {
  const { connection } = state;
  switch (connection.kind) {
    case "unreported":
    case "connected":
      return undefined;
    case "probing":
    case "starting":
      return {
        code: "shell-disconnected",
        detail:
          "The local runtime is still starting, so nothing can be sent to it yet. Everything on screen is the last state this window was sent.",
      };
    case "reconnecting":
      return {
        code: "shell-disconnected",
        detail: `The local runtime is not connected — attempt ${String(connection.attempt)} of ${String(connection.attemptLimit)}. Everything on screen is the last state this window was sent.`,
      };
    case "version-incompatible":
      return {
        code: "shell-version-incompatible",
        detail:
          "The local runtime refused this build's protocol version, so mutating operations are blocked and reads continue. The banner says which side moves.",
      };
    case "offline":
      return {
        code: "shell-offline",
        detail: `The local runtime did not come back after ${String(connection.attemptLimit)} attempts. Everything on screen is the last state this window was sent, and a retry is offered on the banner.`,
      };
    case "stopped":
      return {
        code: "shell-stopped",
        detail:
          "The local runtime has been stopped. Everything on screen is the last state this window was sent; starting it again is a shell action, never a call.",
      };
  }
}

/**
 * The block that applies to ONE method, or `undefined` where none does.
 *
 * The seam every control that dispatches a daemon call goes through, so the
 * "exactly the mutating methods, and no others" rule has one implementation: a
 * read stays live through every arm above, because a surface asking about
 * `session.read` is told nothing blocks it even while the shell is offline.
 */
export function shellBlockForMethod(
  state: ShellState,
  method: string,
): ShellMutationBlock | undefined {
  return isMutatingDaemonMethod(method) ? shellMutationBlock(state) : undefined;
}
