// The fixture's invite answers: the sent-invite ledger read, and the pending lifecycle.
//
// A MODULE OF ITS OWN RATHER THAN A BLOCK IN THE PORT, on `shell/shell-answers.ts`'
// rule. Every operation here reads or moves ONE holder — the ledger a mint folds into
// and the pending table a confirmation spends a reference from — so the plane and the
// state it owns are one unit, and the port composes it in beside the other planes.
//
// AND THE PENDING TABLE IS MINTED HERE, not handed in. Its whole lifecycle is this
// plane's: the five operations share one table of references and one open outcome
// feed, and nothing outside this module can name either, so a port-level instance
// would publish a holder no other plane can use.

import { FixturePendingInvites } from "./pending-invites.js";
import type { FixtureInviteLedger } from "./invite-ledger.js";
import { answerFromScriptedReply } from "../growth/scripted-answer.js";
import { mapGrowthServed, type GrowthPort } from "../../growth-port/index.js";
import type { ScenarioEngine } from "../../scenario-runtime/index.js";

/**
 * The six invite operations the fixture answers.
 *
 * Declared here and spread into `FIXTURE_SERVED_GROWTH_OPERATION_IDS` in
 * `call-plane/served-operations.ts`, on
 * `FIXTURE_SERVED_SHELL_OPERATION_IDS`' rule: the ids and the implementations below
 * are one set with one home, and a second tuple in the served module would agree with
 * this one until a verb landed in only one of them.
 *
 * WHY THE PENDING NAMESPACE IS SERVED IN FULL. All five, because the surface is a
 * lifecycle rather than a read: a confirmation that could be shown but never
 * confirmed, or confirmed but never answered, leaves every one of its outcome arms
 * unreachable from any scenario, screenshot, or bridge-driven test — each of them is
 * published by the act, never by the arrival. `pending-invites.ts` holds the whole of
 * it and states why the reference is spent where it is.
 */
export const FIXTURE_SERVED_INVITE_OPERATION_IDS = [
  "invitesList",
  "invitePendingSubscribe",
  "inviteOutcomeSubscribe",
  "inviteConfirmPending",
  "inviteRetryPending",
  "inviteDismissPending",
] as const;

/** One invite operation the fixture serves. Derived, so the set has one home. */
export type FixtureServedInviteOperationId = (typeof FIXTURE_SERVED_INVITE_OPERATION_IDS)[number];

/**
 * The fixture's six invite answers for one running scenario.
 *
 * `Pick` over the port rather than a shape of its own, on `fixtureShellAnswers`'
 * reason: a handler whose signature drifts from the operation it serves is a compile
 * error here rather than a surface rendering a value no daemon sends.
 *
 * The LEDGER arrives from the caller because two doors read it — this read and the
 * call door's two invite mutations — and `call-plane/bridge.ts` states why one serves
 * both.
 */
export function fixtureInviteAnswers(
  engine: ScenarioEngine,
  inviteLedger: FixtureInviteLedger,
): Pick<GrowthPort, FixtureServedInviteOperationId> {
  // The deep link's whole lifecycle, held for this engine's life. An instance rather
  // than five helpers, because the five operations share one table of references and
  // one open outcome feed — the reasoning is that module's own.
  const pendingInvites = new FixturePendingInvites(engine);
  return {
    invitesList: async (request) =>
      // Routed through the scripted-reply seam on the branch-context read's rule, and
      // answered with the EMPTY LEDGER when a scenario scripts nothing. The two facts
      // are different and the surface draws them differently: "the read is not
      // registered" is what a release build renders, and "this session has sent
      // nobody an invitation" is a state the sent-invite ledger and the received-
      // invite shelf both have to draw and could reach from no scenario at all while
      // this operation refused.
      //
      // The REQUEST travels with the call for the reason the seam states: a scenario
      // answers through `resultFor`, which is handed exactly what the caller sent, and
      // a helper called without it computes every answer about no session at all.
      //
      // An empty array is a legitimate daemon answer here in a way it is NOT for the
      // callback-tool registry: an invite ledger with no rows is an ordinary session,
      // whereas a withheld tool registry and an empty one are different answers to
      // different questions.
      //
      // AND THE ANSWER FOLDS THROUGH THE LEDGER, which is what makes a mint reach the
      // read that shows it: the two invite mutations settle on the OTHER door, and
      // `invite-ledger.ts` is the holder both share. Through `mapGrowthServed` so a
      // refusal travels back exactly as it arrived.
      mapGrowthServed(
        await answerFromScriptedReply(engine, "invites.list", "invitesList", request, () => ({
          status: "served",
          value: [],
        })),
        (rows) => inviteLedger.foldOverScripted(rows),
      ),
    // The pending lifecycle. The two feeds are opened per subscribe, so a window that
    // re-subscribes after a teardown is handed a live one rather than a stream
    // somebody else already closed.
    invitePendingSubscribe: async () => ({
      status: "served",
      value: pendingInvites.openPendingFeed(),
    }),
    inviteOutcomeSubscribe: async () => ({
      status: "served",
      value: pendingInvites.openOutcomeFeed(),
    }),
    inviteConfirmPending: async (request) => pendingInvites.confirm(request.reference),
    inviteRetryPending: async (request) => pendingInvites.retry(request.attempt),
    inviteDismissPending: async (request) => pendingInvites.dismiss(request.reference),
  };
}
