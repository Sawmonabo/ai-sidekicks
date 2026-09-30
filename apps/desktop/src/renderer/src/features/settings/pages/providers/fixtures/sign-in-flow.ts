// The brokered sign-in and the non-interactive token registration: what each call answers,
// and what the page holds while it is in flight.
//
// A flow ending is never a verdict that the account is authenticated, so every settled arm
// is a state of the flow and the page learns the account's fate by re-reading the registry.
// A token exists here only for the length of one registration call, never in a state.

import {
  BILLING_MODES,
  PROVIDER_NAMES,
  type BillingMode,
  type ProviderAccountId,
  type ProviderAccountLoginCancelResponse,
  type ProviderAccountLoginResponse,
  type ProviderAccountRegisterRequest,
  type ProviderAccountRegisterResponse,
  type ProviderName,
} from "@ai-sidekicks/contracts";

import { refuse, type Refusal } from "@renderer/lib/refusal.js";

/**
 * Where a brokered sign-in has got to.
 *
 * The three held arms carry the account, so a disabled row can say which account holds
 * the flow.
 */
export type SignInFlowState =
  | { readonly kind: "idle" }
  | { readonly kind: "starting"; readonly accountId: ProviderAccountId }
  | {
      readonly kind: "live";
      readonly accountId: ProviderAccountId;
      readonly attempt: ProviderAccountLoginResponse;
    }
  | {
      readonly kind: "canceling";
      readonly accountId: ProviderAccountId;
      readonly attempt: ProviderAccountLoginResponse;
    }
  | { readonly kind: "ended"; readonly because: string };

/** The state a flow starts in and returns to. Shared so it has one spelling. */
export const IDLE_PROVIDER_SIGN_IN_FLOW: SignInFlowState = { kind: "idle" };

/**
 * What a flow ending on the registry's own tail says.
 *
 * Its own sentence: this ending is neither a cancellation nor a reply to a call. The
 * report comes from the provider and is not a claim the account is authenticated.
 */
export const SIGN_IN_ENDED_BY_REGISTRY =
  "This machine reports the provider's sign-in finished. That is not a claim the account is authenticated — the registry is being read again to see what became of it.";

/**
 * Whether the daemon is running a flow of this window's making, per kind.
 *
 * A `Record` over the union's discriminant, so a new arm is a compile error here rather
 * than a control that silently stays pressable.
 */
const SIGN_IN_RUNNING_BY_KIND: Readonly<Record<SignInFlowState["kind"], boolean>> = {
  idle: false,
  starting: true,
  live: true,
  canceling: true,
  ended: false,
};

/**
 * What one start attempt answered: a live flow. It carries the account so the tracker
 * can record it, and it is the only arm because a start that never became a flow raises.
 */
export interface SignInStartOutcome {
  readonly kind: "live";
  readonly accountId: ProviderAccountId;
  readonly attempt: ProviderAccountLoginResponse;
}

/** What one cancel answered: the flow is over. */
export interface SignInCancelOutcome {
  readonly kind: "ended";
  readonly because: string;
}

/** What a token registration did, as far as this fixture body may claim. */
export type TokenRegistrationOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "submitting" }
  | { readonly kind: "registered"; readonly account: ProviderAccountRegisterResponse["account"] }
  | { readonly kind: "refused"; readonly refusal: Refusal };

/**
 * Starts a brokered sign-in for one account.
 */
export type ProviderAccountLoginCall = (request: {
  readonly accountId: ProviderAccountId;
}) => Promise<ProviderAccountLoginResponse>;

/**
 * Cancels a sign-in that is still in flight.
 */
export type ProviderAccountLoginCancelCall = (request: {
  readonly attemptId: string;
}) => Promise<ProviderAccountLoginCancelResponse>;

/**
 * Registers an account, optionally carrying the one write-only token member.
 */
export type ProviderAccountRegisterCall = (
  request: ProviderAccountRegisterRequest,
) => Promise<ProviderAccountRegisterResponse>;

/** Whether this flow is running. The one reading of the table above. */
export function isSignInRunning(flow: SignInFlowState): boolean {
  return SIGN_IN_RUNNING_BY_KIND[flow.kind];
}

/**
 * The account this flow is about, where the arm carries one.
 *
 * Reads the union's own arms, so the set of kinds that carry an account is stated once.
 */
export function readSignInAccountId(flow: SignInFlowState): ProviderAccountId | undefined {
  return "accountId" in flow ? flow.accountId : undefined;
}

/** Start a brokered sign-in for one account. */
export async function startProviderSignIn(
  login: ProviderAccountLoginCall,
  accountId: ProviderAccountId,
): Promise<SignInStartOutcome> {
  return { kind: "live", accountId, attempt: await login({ accountId }) };
}

/**
 * Cancel a sign-in that is still in flight.
 *
 * `canceled` is the daemon stopping a running flow; `notFound` means there was nothing to
 * stop because it finished or expired first. Reporting that as a cancellation would claim
 * the console stopped something it did not.
 */
export async function cancelSignIn(
  cancel: ProviderAccountLoginCancelCall,
  attempt: ProviderAccountLoginResponse,
): Promise<SignInCancelOutcome> {
  const reply = await cancel({ attemptId: attempt.attemptId });
  return {
    kind: "ended",
    because:
      reply.status === "canceled"
        ? "The sign-in was canceled. Nothing about this account has changed until the registry is read again."
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
  | { readonly kind: "refused"; readonly refusal: Refusal };

/**
 * Read the form's ordinary fields, before anything is sent and before the token is read.
 *
 * Runs before the token exists in the submit handler, so a refused label cannot discard a
 * typed credential; a label of only spaces passes the browser's `required` check and is
 * refused here. Every arm answers with a refusal rather than going quiet, and a refusal
 * never echoes the label, which is user content.
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
 * The caller composes the whole request, which keeps the token's lifetime inside its submit
 * handler; the outcome carries the account only, as the reply does.
 */
export async function submitTokenRegistration(
  register: ProviderAccountRegisterCall,
  request: ProviderAccountRegisterRequest,
): Promise<TokenRegistrationOutcome> {
  return { kind: "registered", account: (await register(request)).account };
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
