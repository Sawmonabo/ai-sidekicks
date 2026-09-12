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

import {
  BILLING_MODES,
  PROVIDER_NAMES,
  type BillingMode,
  type ProviderAccountId,
  type ProviderAccountLoginResponse,
  type ProviderAccountRegisterRequest,
  type ProviderAccountRegisterResponse,
  type ProviderName,
} from "@ai-sidekicks/contracts";

import { settleGrowthRead, type ConsoleBridge } from "../../../../bridge/index.js";
import { refuse, type ConsoleRefusal } from "../../../../core/index.js";

/**
 * Where a brokered sign-in has got to.
 *
 * THE THREE HELD ARMS CARRY THE ACCOUNT, and that is what makes the plane sayable. A
 * flow that recorded only its own progress could tell a surface that something was
 * running and never which account was running it — so a second row's control could be
 * disabled with no reason a person could act on, which is worse than one that stays
 * pressable and refuses.
 *
 * AND A REFUSED CANCELLATION IS AN ARM OF THE LIVE ATTEMPT RATHER THAN A REPLACEMENT
 * FOR IT. A cancel that the transport could not carry, or that the daemon declined,
 * establishes nothing about the provider's own login process — so the attempt is still
 * the thing on screen, and the refusal is rendered beside its verification details and
 * its cancel control rather than instead of them. Installing it as `refused` took away
 * the code the operator was typing and the only way to stop the flow, and re-offered
 * every start control, over a process that may well still be running.
 */
export type SignInFlowState =
  | { readonly kind: "idle" }
  | { readonly kind: "starting"; readonly accountId: ProviderAccountId }
  | {
      readonly kind: "live";
      readonly accountId: ProviderAccountId;
      readonly attempt: ProviderAccountLoginResponse;
      /** A cancellation this machine refused. The attempt is still running. */
      readonly cancelRefusal?: ConsoleRefusal | undefined;
    }
  | {
      readonly kind: "cancelling";
      readonly accountId: ProviderAccountId;
      readonly attempt: ProviderAccountLoginResponse;
      /** The previous cancellation's refusal, still shown while this one travels. */
      readonly cancelRefusal?: ConsoleRefusal | undefined;
    }
  | { readonly kind: "ended"; readonly because: string }
  | { readonly kind: "refused"; readonly refusal: ConsoleRefusal };

/** The state a shell starts in and returns to. Shared so it has one spelling. */
export const IDLE_SIGN_IN_FLOW: SignInFlowState = { kind: "idle" };

/**
 * What a flow ending on the registry's own tail says.
 *
 * A SENTENCE OF ITS OWN, because this ending is not a cancellation and not a reply to
 * anything this window asked. `providerAccount.subscribe` carries `login_completed`
 * correlated on the attempt id, and the registered contract is explicit that it is a
 * report FROM THE PROVIDER that its flow finished and never a verdict about the
 * account — so the words say exactly that and send the reader to the registry, which is
 * the same thing every other settled arm of this plane does.
 */
export const SIGN_IN_ENDED_BY_REGISTRY =
  "This machine reports the provider's sign-in finished. That is not a claim the account is authenticated — the registry is being read again to see what became of it.";

/**
 * Whether the daemon is running a flow of this window's making, per kind.
 *
 * THE CLOSED SET, DECLARED ONCE. A `Record` over the union's own discriminant rather
 * than a list of the three kinds that hold: the compiler refuses a missing key and
 * refuses an unknown one, so a seventh arm added to the state above is a compile error
 * here rather than a control that silently stays pressable through it. A predicate
 * spelled at each call site is how two surfaces come to disagree about what "running"
 * means, which for this plane is the difference between one flow and two.
 */
const SIGN_IN_PLANE_HELD_BY_KIND: Readonly<Record<SignInFlowState["kind"], boolean>> = {
  idle: false,
  starting: true,
  live: true,
  cancelling: true,
  ended: false,
  refused: false,
};

/**
 * What one start attempt answered.
 *
 * NARROWER THAN THE FLOW STATE, AND THE NARROWING IS THE RULE. A start either produced
 * a flow or it did not, and a refusal is the second — so it cannot be installed as the
 * tracked flow, because there is no flow to track and the card that renders one is
 * shared across every readiness row. The caller routes the refused arm to the row that
 * asked; the type is what stops it going anywhere else.
 */
export type SignInStartOutcome =
  | {
      readonly kind: "live";
      readonly accountId: ProviderAccountId;
      readonly attempt: ProviderAccountLoginResponse;
    }
  | { readonly kind: "refused"; readonly refusal: ConsoleRefusal };

/** What one cancel answered. Both arms ARE about the tracked flow, so both install. */
export type SignInCancelOutcome =
  | { readonly kind: "ended"; readonly because: string }
  | { readonly kind: "refused"; readonly refusal: ConsoleRefusal };

/** What a token registration did, as far as this shell may claim. */
export type TokenRegistrationOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "submitting" }
  | { readonly kind: "registered"; readonly account: ProviderAccountRegisterResponse["account"] }
  | { readonly kind: "refused"; readonly refusal: ConsoleRefusal };

/** Whether this flow is holding the plane. The one reading of the table above. */
export function isSignInPlaneHeld(flow: SignInFlowState): boolean {
  return SIGN_IN_PLANE_HELD_BY_KIND[flow.kind];
}

/**
 * The account this flow is about, where the arm carries one.
 *
 * Reads the union's own arms rather than a second list of which kinds have an account:
 * the three that do are the three that hold, and stating that twice is how the two
 * come apart. A caller wanting "held, and by whom" asks both questions.
 */
export function signInPlaneHolderAccountId(flow: SignInFlowState): ProviderAccountId | undefined {
  return "accountId" in flow ? flow.accountId : undefined;
}

/**
 * Start a brokered sign-in for one account.
 *
 * Answers an outcome rather than throwing, so every arm — including the daemon's own
 * refusal, which is what `provideraccount.signin_unsupported` and
 * `provideraccount.signin_in_flight` arrive as — renders on the control that raised it.
 */
export async function startSignIn(
  bridge: ConsoleBridge,
  accountId: ProviderAccountId,
): Promise<SignInStartOutcome> {
  const settlement = await settleGrowthRead(bridge.growth.providerAccountLogin({ accountId }));
  return settlement.status === "served"
    ? { kind: "live", accountId, attempt: settlement.value }
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
): Promise<SignInCancelOutcome> {
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

/** The outcome a form starts in and returns to. Shared so it has one spelling. */
export const IDLE_TOKEN_REGISTRATION: TokenRegistrationOutcome = { kind: "idle" };

/** The subsystem name the refusals the form raises on its own carry. */
export const TOKEN_REGISTRATION_REFUSAL_ORIGIN = "provider-account-registration";

/** The three fields a registration needs beside the write-only token. */
export interface AdmittedRegistrationFields {
  readonly provider: ProviderName;
  readonly displayLabel: string;
  readonly billingMode: BillingMode;
}

/** What the form's own fields amount to: a request it can send, or a refusal to show. */
export type RegistrationFieldReading =
  | { readonly kind: "admitted"; readonly fields: AdmittedRegistrationFields }
  | { readonly kind: "refused"; readonly refusal: ConsoleRefusal };

/**
 * Read the form's ordinary fields, before anything is sent and before the token is read.
 *
 * WHY THIS IS A FUNCTION AND NOT THREE CHECKS INSIDE THE SUBMIT HANDLER. The handler
 * used to read the token first, clear it, and only then decide whether the rest of the
 * form was sendable — so a label of nothing but spaces, which the browser's own
 * `required` check accepts, threw away a credential the person had typed and returned
 * with no submission and nothing on screen. Reading the fields is therefore a step that
 * happens BEFORE the token exists in the handler at all, and its refusal arm is the
 * form's evidence that a press was received.
 *
 * IT REFUSES ON EVERY ARM RATHER THAN RETURNING SILENTLY. The two selects offer closed
 * vocabularies the wire publishes, so an unadmitted value is not reachable by pressing
 * anything — but a narrowing that answers `undefined` on the impossible arm is a
 * surface that goes quiet when it is surprised, and the whole point of the refusal
 * shape is that a press is answered.
 *
 * NO REFUSED VALUE IS ECHOED. A label is user content, and `detail` says what
 * would change the answer rather than repeating what was typed.
 */
export function readRegistrationFields(typed: {
  readonly displayLabel: string;
  readonly provider: string;
  readonly billingMode: string;
}): RegistrationFieldReading {
  const displayLabel = typed.displayLabel.trim();
  if (displayLabel === "") {
    return registrationRefusal(
      "registration-label-blank",
      "Give the account a label with at least one visible character — spaces alone are not a name anything can be found by. Nothing was sent, and the token field still holds what you typed.",
    );
  }
  if (!isProviderName(typed.provider)) {
    return registrationRefusal(
      "registration-provider-unadmitted",
      "This window offers a provider the wire does not publish. Nothing was sent; pick one of the listed providers.",
    );
  }
  if (!isBillingMode(typed.billingMode)) {
    return registrationRefusal(
      "registration-billing-mode-unadmitted",
      "This window offers a billing mode the wire does not publish. Nothing was sent; pick one of the listed modes.",
    );
  }
  return {
    kind: "admitted",
    fields: { provider: typed.provider, displayLabel, billingMode: typed.billingMode },
  };
}

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

/** One refusal of the form's own, so the origin is written once. */
function registrationRefusal(code: string, detail: string): RegistrationFieldReading {
  return { kind: "refused", refusal: refuse(TOKEN_REGISTRATION_REFUSAL_ORIGIN, code, detail) };
}

/** Narrow a select's string back to the closed provider set the wire admits. */
function isProviderName(value: string): value is ProviderName {
  return PROVIDER_NAMES.some((provider) => provider === value);
}

/** Narrow a select's string back to the closed billing vocabulary the wire admits. */
function isBillingMode(value: string): value is BillingMode {
  return BILLING_MODES.some((mode) => mode === value);
}
