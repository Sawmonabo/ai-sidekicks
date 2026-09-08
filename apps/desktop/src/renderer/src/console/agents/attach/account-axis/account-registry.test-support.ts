// The node registry the account axis reads, as one reply a scripted daemon can answer.
//
// BESIDE THE AXIS RATHER THAN BESIDE ITS CALLER. The one module that answers with this
// today is the binding column's own support module, and the fixture is still not about
// a column: it describes what a node's provider-account registry holds, which is the
// account axis's subject and nobody else's. Kept here, a second suite that needs a
// populated registry finds it under the surface it is about.
//
// BUILT FROM `bridge/quotas/`'s OWN ROW FACTORY rather than typed out again: that
// module is the one place this console decides what a registry row looks like, and a
// second literal here would be a second answer to the same question.

import { account, listReply } from "../../../bridge/quotas/provider-quota-feed.test-support.js";

/**
 * The provider accounts the node carries.
 *
 * TWO ACCOUNTS UNDER ONE PROVIDER AND ONE UNDER THE OTHER, which is the only shape
 * that can tell a picker scoped to the chosen driver's provider apart from one that
 * offers whatever the registry holds. `claude` is deliberately the provider the attach
 * fixtures' definition names, so a form on the definition arm reaches a populated axis.
 */
const REGISTRY_ACCOUNTS: readonly Record<string, unknown>[] = [
  account({ accountId: "acct-team", displayLabel: "Team", isDefault: true }),
  account({
    accountId: "acct-personal",
    displayLabel: "Personal",
    isDefault: false,
    healthState: "reauth_required",
  }),
  account({ accountId: "acct-codex", provider: "codex", displayLabel: "Codex", isDefault: true }),
];

/**
 * What run admission last made of the `claude` provider, resolved to one account.
 *
 * The projection is per PROVIDER and names the one account resolution reached, which
 * is the distinction the account axis has to hold: `acct-personal` carries this entry
 * and `acct-team` carries none, so a field that attributed a provider's verdict to
 * every row under it would say something about an account nobody computed.
 *
 * The remedy is the `sign_in` arm on purpose. It is the arm that carries the
 * provider's own first-party invocation and the credential home it authenticates
 * into, and both are display-only members an attach form may not put in front of
 * somebody as a thing to run — so a fixture without them could not prove the form
 * does not.
 */
const REGISTRY_READINESS: readonly Record<string, unknown>[] = [
  {
    provider: "claude",
    state: "reauth_required",
    resolvedAccountId: "acct-personal",
    remedy: {
      kind: "sign_in",
      accountId: "acct-personal",
      signInInvocation: "claude setup-token",
      credentialHomePath: "/homes/acct-personal",
    },
  },
];

/**
 * The `providerAccount.list` reply this registry answers with.
 *
 * A function rather than a held object, so one case's reply is never the object a
 * previous case was handed: nothing here mutates it today, and a fixture that could be
 * mutated across cases is the shape that makes a suite order-dependent later.
 */
export function registryListReply(): Record<string, unknown> {
  return { ...listReply(REGISTRY_ACCOUNTS, []), readiness: REGISTRY_READINESS };
}
