// The SHELL plane: what this machine will display, what the runtime is doing, and the
// three controls that move it.
//
// WHY THIS PLANE HAS A MODULE. `workflows/workflow-reads.ts` and
// `settings/onboarding-answers.ts` state the shape — a plane whose answers
// need reasoning of their own leaves the port and takes its served ids with it, so the
// ids and the handlers stay one set with one home. This plane earns it on the same
// ground the onboarding one does, twice over: five of its six answers are composed from
// ONE `FixtureShellChannel`, and a channel minted per handler would be a fixture where a
// stop moves nothing the feed says. Holding them in the port also took that file past
// the package's split threshold.
//
// THE CHANNEL IS MINTED HERE AND CLOSED OVER, which is what makes it one per port. It
// is deliberately not a parameter, on `FixtureOnboardingLedger`'s reason: a caller that
// could supply one could supply the same one to two ports, and a control pressed in one
// window would move another window's shell.
//
// WHAT IS NOT HERE. The channel's own ordering rule — how a scripted frame and a
// control override are ranked against the frozen clock, and what a control never claims
// — is `shell-status.ts`', whose header carries the whole of it. What is HERE is
// only how each of the six served operations composes its answer out of that channel,
// and out of the script for the one answer that is not the channel's.

import { answerFromScriptedReply } from "../growth/scripted-answer.js";
import {
  FixtureShellChannel,
  SHELL_STATUS_SCRIPT,
  startingReport,
  stoppedReport,
} from "./shell-status.js";
import {
  growthUnscriptedReply,
  type GrowthOutcome,
  type GrowthPort,
} from "../../growth-port/index.js";
import { SHELL_NOTIFICATION_PERMISSION_CALL } from "../../scenarios/bring-your-history.js";
import type { ScenarioEngine } from "../../scenario-runtime/scenario-engine.js";
import type { ShellReport } from "../../../store/index.js";

/**
 * The six shell operations the fixture answers.
 *
 * Declared here and spread into `FIXTURE_SERVED_GROWTH_OPERATION_IDS` in
 * `call-plane/served-operations.ts`, on
 * `FIXTURE_SERVED_WORKFLOW_OPERATION_IDS`' rule: the ids and the implementations below
 * are one set with one home, and a second tuple in the served module would agree with
 * this one until a control landed in only one of them.
 */
export const FIXTURE_SERVED_SHELL_OPERATION_IDS = [
  "shellNotificationPermissionRead",
  "shellStatusSubscribe",
  "daemonStatusRead",
  "daemonStop",
  "daemonRestart",
  "daemonStart",
] as const;

/** One shell operation the fixture serves. Derived, so the set has one home. */
export type FixtureServedShellOperationId = (typeof FIXTURE_SERVED_SHELL_OPERATION_IDS)[number];

/**
 * The fixture's six shell answers for one running scenario.
 *
 * `Pick` over the port rather than a shape of its own, on `fixtureWorkflowReads`'
 * reason: a handler whose signature drifts from the operation it serves is a compile
 * error here rather than a surface rendering a value no daemon sends.
 */
export function fixtureShellAnswers(
  engine: ScenarioEngine,
): Pick<GrowthPort, FixtureServedShellOperationId> {
  // One channel per port, so the feed and the three controls answer about one
  // shell and a control pressed in this window cannot move another window's.
  const shellChannel = new FixtureShellChannel(engine);
  return {
    // The shell's notification permission, from the script and from nowhere else. It
    // is a READ with no empty form, which puts it beside the subject-addressed
    // workflow reads rather than beside the enumerations: `granted`, `denied` and
    // `not-determined` are three answers and none of them is "nobody asked", so a
    // scenario that scripts nothing has left the question unasked and the read says
    // so. Answering `granted` by default would be worse than refusing — the centre
    // would stop saying it is the only surface, on a fixture where no notification
    // can be delivered at all.
    //
    // It is the one answer here that is not the channel's: a permission is a fact
    // about the MACHINE rather than about the runtime the three controls move, and
    // folding it into the channel would make a daemon stop change what a person is
    // told about notifications.
    shellNotificationPermissionRead: async (request) =>
      await answerFromScriptedReply(
        engine,
        SHELL_NOTIFICATION_PERMISSION_CALL,
        "shellNotificationPermissionRead",
        request,
        () =>
          growthUnscriptedReply(
            "shellNotificationPermissionRead",
            SHELL_NOTIFICATION_PERMISSION_CALL,
          ),
      ),
    // The shell's own condition — the one FEED this port serves, opened from the
    // frames a scenario declares and refused by a scenario that declares none.
    //
    // That refusal is the SCENARIO's gap and never the build's, which is why it takes
    // the unscripted code rather than `wire-unregistered`: this port implements the
    // feed, and `wire-unregistered` would send a reader to the document owing a wire
    // the fixture already stands in for. What is missing is the scenario's own
    // `shellStatus` declaration, so the sentence names that rather than a call.
    shellStatusSubscribe: async () => {
      const stream = shellChannel.open();
      return stream === undefined
        ? growthUnscriptedReply("shellStatusSubscribe", SHELL_STATUS_SCRIPT)
        : { status: "served", value: stream };
    },
    // The three daemon controls answer about the same shell the feed does, through
    // the one channel above, and refuse for the same reason and by the same name
    // where the scenario declares no shell condition — a control that moved a shell
    // nobody declared would be the fixture inventing the state the feed will not.
    daemonStatusRead: async () => {
      const current = shellChannel.current();
      return current?.negotiation === undefined
        ? growthUnscriptedReply("daemonStatusRead", SHELL_STATUS_SCRIPT)
        : {
            status: "served",
            value: {
              state: current.connection.kind,
              version: current.negotiation.daemonProtocolVersion,
            },
          };
    },
    daemonStop: async () => publishShellControl(shellChannel, "daemonStop", stoppedReport),
    daemonRestart: async () => publishShellControl(shellChannel, "daemonRestart", startingReport),
    daemonStart: async () => publishShellControl(shellChannel, "daemonStart", startingReport),
  };
}

/**
 * Move the fixture's shell with one control, or refuse where none is scripted.
 *
 * The three controls differ only in the report they produce, so the refusal rule —
 * and the fact that a control answers `void` rather than a state — is written once.
 */
function publishShellControl(
  channel: FixtureShellChannel,
  operationId: "daemonStop" | "daemonRestart" | "daemonStart",
  next: (current: ShellReport) => ShellReport,
): GrowthOutcome<void> {
  const current = channel.current();
  if (current === undefined) {
    return growthUnscriptedReply(operationId, SHELL_STATUS_SCRIPT);
  }
  channel.publish(next(current));
  return { status: "served", value: undefined };
}
