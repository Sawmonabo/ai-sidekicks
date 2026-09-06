// The brokered sign-in and the non-interactive token registration: what each call
// answers, and what the surface holds while it is in flight.
//
// WHY A FLOW STATE AND NOT A BOOLEAN. A sign-in has four outcomes a person can act on
// and they are not degrees of one thing: nothing has been started; a request is out; a
// flow is live and the operator is at the provider's own page with a code and a
// deadline; and the daemon refused. A boolean would collapse the last two, which are
// the two that need different words on screen.
//
// COMPLETION IS NOT A VERDICT, AND THIS MODULE CANNOT MINT ONE. A brokered flow ending
// means the flow ended — never that the account is authenticated — so nothing here
// answers `authenticated`, and the only way this shell learns what became of an
// account is to read the registry again. That is why every settled arm below is a
// state of the FLOW and not a state of the account.
//
// AND NOTHING HERE HOLDS A TOKEN. The registration call takes one on its request and
// the reply carries none, so a token exists in this module for exactly the length of
// one call and is never a member of any state a devtools inspection could read.

import type {
  ProviderAccountId,
  ProviderAccountLoginResponse,
  ProviderAccountRegisterRequest,
  ProviderAccountRegisterResponse,
} from "@ai-sidekicks/contracts";

import { settleGrowthRead, type ConsoleBridge } from "../../../../bridge/index.js";
import type { ConsoleRefusal } from "../../../../core/index.js";

/** Where a brokered sign-in has got to. */
export type SignInFlowState =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | { readonly kind: "live"; readonly attempt: ProviderAccountLoginResponse }
  | { readonly kind: "cancelling"; readonly attempt: ProviderAccountLoginResponse }
  | { readonly kind: "ended"; readonly because: string }
  | { readonly kind: "refused"; readonly refusal: ConsoleRefusal };

/** The state a shell starts in and returns to. Shared so it has one spelling. */
export const IDLE_SIGN_IN_FLOW: SignInFlowState = { kind: "idle" };

/**
 * Start a brokered sign-in for one account.
 *
 * Answers the next flow state rather than throwing, so every arm — including the
 * daemon's own refusal, which is what `provideraccount.signin_unsupported` and
 * `provideraccount.signin_in_flight` arrive as — renders on the control that raised it.
 */
export async function startSignIn(
  bridge: ConsoleBridge,
  accountId: ProviderAccountId,
): Promise<SignInFlowState> {
  const settlement = await settleGrowthRead(bridge.growth.providerAccountLogin({ accountId }));
  return settlement.status === "served"
    ? { kind: "live", attempt: settlement.value }
    : { kind: "refused", refusal: settlement };
}

/**
 * Cancel a sign-in that is still in flight.
 *
 * The reply's two statuses are kept apart on purpose. `cancelled` is the daemon
 * stopping a flow it was running; `notFound` is the daemon saying there was nothing to
 * stop, which is a real answer when the flow completed or expired between the press and
 * the call — and reporting it as a cancellation would tell an operator the console
 * stopped something it did not.
 */
export async function cancelSignIn(
  bridge: ConsoleBridge,
  attempt: ProviderAccountLoginResponse,
): Promise<SignInFlowState> {
  const settlement = await settleGrowthRead(
    bridge.growth.providerAccountLoginCancel({ attemptId: attempt.attemptId }),
  );
  if (settlement.status !== "served") {
    return { kind: "refused", refusal: settlement };
  }
  return {
    kind: "ended",
    because:
      settlement.value.status === "cancelled"
        ? "The sign-in was cancelled. Nothing about this account has changed until the registry is read again."
        : "There was no sign-in left to cancel — it had already finished or expired. Read the registry again to see what became of the account.",
  };
}

/** What a token registration did, as far as this shell may claim. */
export type TokenRegistrationOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "submitting" }
  | { readonly kind: "registered"; readonly account: ProviderAccountRegisterResponse["account"] }
  | { readonly kind: "refused"; readonly refusal: ConsoleRefusal };

/** The outcome a form starts in and returns to. Shared so it has one spelling. */
export const IDLE_TOKEN_REGISTRATION: TokenRegistrationOutcome = { kind: "idle" };

/**
 * Submit a registration, optionally carrying the one write-only token member.
 *
 * The request is composed by the CALLER and handed here whole, which is what keeps the
 * token's lifetime inside the caller's own submit handler: this function never reads a
 * field, never keeps one, and the outcome it answers with carries the account and
 * nothing else — which is all the reply carries either.
 */
export async function submitTokenRegistration(
  bridge: ConsoleBridge,
  request: ProviderAccountRegisterRequest,
): Promise<TokenRegistrationOutcome> {
  const settlement = await settleGrowthRead(bridge.growth.providerAccountRegister(request));
  return settlement.status === "served"
    ? { kind: "registered", account: settlement.value.account }
    : { kind: "refused", refusal: settlement };
}
