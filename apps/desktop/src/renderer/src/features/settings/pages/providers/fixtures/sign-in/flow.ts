// The brokered sign-in and the non-interactive token registration: what each call answers,
// and what the page holds while it is in flight.
//
// A flow ending is never a verdict that the account is authenticated, so every settled arm
// is a state of the flow and the page learns the account's fate by re-reading the registry.
// A token exists here only for the length of one registration call, never in a state.

import type {
  BillingMode,
  ProviderAccount,
  ProviderAccountId,
} from "@ai-sidekicks/contracts/provider/account/record";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type {
  ProviderAccountProbeResponse,
  ProviderAccountSetCurrentResponse,
} from "@ai-sidekicks/contracts/provider/account/methods";
import type {
  ProviderAccountLoginCancelResponse,
  ProviderAccountLoginResponse,
  ProviderAccountRegisterRequest,
  ProviderAccountRegisterResponse,
} from "@ai-sidekicks/contracts/provider/account/sign-in";

import { coerceToRefusal } from "#renderer/lib/coerce-to-refusal.js";
import { PROVIDER_LABELS } from "#renderer/lib/provider-labels.js";
import type { ProviderLoginCompletion } from "#renderer/services/provider-accounts/deliveries.js";
import { refuse, type Refusal } from "#renderer/lib/refusal/contract.js";

/**
 * Where a brokered sign-in has got to.
 *
 * The three held arms carry the account, so a disabled row can say which account holds
 * the flow.
 */
export type ProviderSignInFlowState =
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
  | { readonly kind: "unfinished"; readonly failureReason: string | undefined };

/** The state a flow starts in and returns to. Shared so it has one spelling. */
export const IDLE_PROVIDER_SIGN_IN_FLOW: ProviderSignInFlowState = { kind: "idle" };

/**
 * Whether the daemon is running a flow of this window's making, per kind.
 *
 * A `Record` over the union's discriminant, so a new arm is a compile error here rather
 * than a control that silently stays pressable.
 */
const PROVIDER_SIGN_IN_RUNNING_BY_KIND: Readonly<Record<ProviderSignInFlowState["kind"], boolean>> =
  {
    idle: false,
    starting: true,
    live: true,
    canceling: true,
    unfinished: false,
  };

/**
 * What one start attempt answered: a live flow. It carries the account so the tracker
 * can record it, and it is the only arm because a start that never became a flow raises.
 */
export interface ProviderSignInStartOutcome {
  readonly kind: "live";
  readonly accountId: ProviderAccountId;
  readonly attempt: ProviderAccountLoginResponse;
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

/**
 * Checks one account now. The daemon reads at once when the account's last read is at least a
 * minute old and otherwise answers with that last read, so the reply looks the same either way.
 */
export type ProviderAccountProbeCall = (request: {
  readonly accountId: ProviderAccountId;
}) => Promise<ProviderAccountProbeResponse>;

/**
 * Makes one account its provider's default. A refusal carries the account's own remedy where its
 * login is gone, and nothing moves.
 */
export type ProviderAccountSetCurrentCall = (request: {
  readonly accountId: ProviderAccountId;
}) => Promise<ProviderAccountSetCurrentResponse>;

/** Whether this flow is running. The one reading of the table above. */
export function isProviderSignInRunning(flow: ProviderSignInFlowState): boolean {
  return PROVIDER_SIGN_IN_RUNNING_BY_KIND[flow.kind];
}

/**
 * The account this flow is about, where the arm carries one.
 *
 * Reads the union's own arms, so the set of kinds that carry an account is stated once.
 */
export function readProviderSignInAccountId(
  flow: ProviderSignInFlowState,
): ProviderAccountId | undefined {
  return "accountId" in flow ? flow.accountId : undefined;
}

/** Start a brokered sign-in for one account. */
export async function startProviderSignIn(
  login: ProviderAccountLoginCall,
  accountId: ProviderAccountId,
): Promise<ProviderSignInStartOutcome> {
  return { kind: "live", accountId, attempt: await login({ accountId }) };
}

/**
 * Where a flow stands once the registry reports its attempt over: a failed attempt did not
 * finish and keeps the provider's own reason; a finished or canceled one leaves nothing to draw,
 * since what became of the account is the registry's to say.
 */
export function flowAfterLoginCompleted(
  completion: Pick<ProviderLoginCompletion, "outcome" | "failureReason">,
): ProviderSignInFlowState {
  return completion.outcome === "failed"
    ? { kind: "unfinished", failureReason: completion.failureReason }
    : IDLE_PROVIDER_SIGN_IN_FLOW;
}

/**
 * Read a write-only token field once and clear it in the same step, so the value lives only in
 * the submit handler that sends it: never in component state, a `FormData` entry or the field.
 */
export function takeWriteOnlyToken(tokenInput: HTMLInputElement | null): string {
  const token = tokenInput?.value ?? "";
  if (tokenInput !== null) {
    tokenInput.value = "";
  }
  return token;
}

/** The outcome a form starts in and returns to. Shared so it has one spelling. */
export const IDLE_TOKEN_REGISTRATION: TokenRegistrationOutcome = { kind: "idle" };

/** The subsystem name the refusals the form raises on its own carry. */
export const TOKEN_REGISTRATION_REFUSAL_ORIGIN = "provider-account-registration";

/** The code a rejected registration that carried none of its own is reported under. */
const REGISTRATION_FAILED_CODE = "registration-failed";

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
 * Runs before the token exists in the submit handler, so a refused name cannot discard a typed
 * credential. The name is required and differs from that provider's other account names,
 * compared without case or surrounding spaces; a name of only spaces passes the browser's
 * `required` check and is refused here. The refusal never echoes the name, which is user content.
 * The form asks nothing about billing, so an admitted account's billing is `unknown`.
 */
export function readRegistrationFields(
  typed: { readonly displayLabel: string; readonly provider: ProviderName },
  accounts: readonly ProviderAccount[],
): RegistrationFieldReading {
  const displayLabel = typed.displayLabel.trim();
  if (displayLabel === "") {
    return {
      kind: "refused",
      refusal: refuse(
        TOKEN_REGISTRATION_REFUSAL_ORIGIN,
        "registration-label-blank",
        "Name this account.",
      ),
    };
  }
  const comparedName = displayLabel.toLowerCase();
  const isTaken = accounts.some(
    (account) =>
      account.provider === typed.provider &&
      account.displayLabel.trim().toLowerCase() === comparedName,
  );
  if (isTaken) {
    return {
      kind: "refused",
      refusal: refuse(
        TOKEN_REGISTRATION_REFUSAL_ORIGIN,
        "registration-label-taken",
        `Another ${PROVIDER_LABELS[typed.provider]} account already has this name.`,
      ),
    };
  }
  return {
    kind: "admitted",
    fields: { provider: typed.provider, displayLabel, billingMode: "unknown" },
  };
}

/**
 * Submit a registration, optionally carrying the one write-only token member.
 *
 * The caller composes the whole request, which keeps the token's lifetime inside its submit
 * handler; the outcome carries the account only, as the reply does. A rejected call answers
 * `refused` with the service's own words, so the form's control comes back.
 */
export async function submitTokenRegistration(
  register: ProviderAccountRegisterCall,
  request: ProviderAccountRegisterRequest,
): Promise<TokenRegistrationOutcome> {
  try {
    return { kind: "registered", account: (await register(request)).account };
  } catch (error) {
    return {
      kind: "refused",
      refusal: coerceToRefusal(error, TOKEN_REGISTRATION_REFUSAL_ORIGIN, REGISTRATION_FAILED_CODE),
    };
  }
}
