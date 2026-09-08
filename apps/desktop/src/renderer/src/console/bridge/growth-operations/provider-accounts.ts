// The provider-account plane's ledger rows: the brokered sign-in, its cancel, and
// the registration that carries a non-interactive token.
//
// One plane of `GROWTH_OPERATIONS`, composed into it by `index.ts`.

import type { GrowthOperationEntry, GrowthOperationId } from "../growth-port/growth-entry.js";
import { op } from "./operation-entry.js";

/**
 * The ids this plane carries, NAMED rather than matched by a `providerAccount${string}`
 * pattern.
 *
 * The `diagnostics.ts` shape and for that module's reason: the root is split, and here
 * it is split between this ledger and the registered call door. `providerAccount.list`
 * and `providerAccount.subscribe` are bound in `daemon/`, so a pattern here would
 * claim two wires this console already has — and a growth row for a registered route
 * would give the console two answers for one method.
 */
type ProviderAccountOperationId = Extract<
  GrowthOperationId,
  "providerAccountLogin" | "providerAccountLoginCancel" | "providerAccountRegister"
>;

/** The account-plane rows, in the order a person meets them. */
export const PROVIDER_ACCOUNT_GROWTH_OPERATIONS: Readonly<
  Record<ProviderAccountOperationId, GrowthOperationEntry>
> = {
  providerAccountLogin: op(
    "providerAccountLogin",
    "provider-account-signin-and-token",
    "method",
    "ask the daemon to run the provider's own first-party sign-in against one account's credential home, and answer with where the operator completes it",
    "providerAccount.login",
  ),
  providerAccountLoginCancel: op(
    "providerAccountLoginCancel",
    "provider-account-signin-and-token",
    "method",
    "cancel a brokered sign-in that is still in flight, named by the attempt it started",
    "providerAccount.loginCancel",
  ),
  providerAccountRegister: op(
    "providerAccountRegister",
    "provider-account-signin-and-token",
    "method",
    "register an account, optionally carrying the one write-only non-interactive token member that appears on no reply",
    "providerAccount.register",
  ),
};
