// The provider-account plane's three unexposed wires: start a brokered sign-in,
// cancel one, and register an account with a non-interactive token.
//
// One plane of `GrowthOperationSignatures`, composed into it by `index.ts`.
//
// WHY THE REGISTRY READ IS NOT HERE. `providerAccount.list` and
// `providerAccount.subscribe` are bound in `daemon/daemon-reply-registry.ts` and
// `daemon/daemon-streams.ts` respectively, so the accounts surface reads the registry
// and follows its tail through `callDaemon` and the node-scoped quota reading — the
// registered route, parsed both directions. These three are the remainder: the corpus
// registers their request and reply shapes and no bridge namespace serves them.
//
// WHY THE SHAPES ARE IMPORTED RATHER THAN RESTATED. `@ai-sidekicks/contracts` ships
// all five of them, and a second declaration here would be a shape this console
// maintains beside the one the daemon parses against — the `ledger.ts` precedent.
// What the growth port adds is the REFUSAL, not a type.
//
// THE TOKEN RIDES THE REQUEST AND APPEARS ON NO REPLY, which is the registered
// shape and the reason the register operation is on this table at all rather than
// modelled as a form the console keeps state for: `nonInteractiveToken` is the one
// write-only member `PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS` names, the reply carries
// the account and never the token, and there is nothing on this table for a surface
// to echo back even if it wanted to.

import type {
  ProviderAccountLoginCancelRequest,
  ProviderAccountLoginCancelResponse,
  ProviderAccountLoginRequest,
  ProviderAccountLoginResponse,
  ProviderAccountRegisterRequest,
  ProviderAccountRegisterResponse,
} from "@ai-sidekicks/contracts";

export interface ProviderAccountGrowthSignatures {
  providerAccountLogin: {
    request: ProviderAccountLoginRequest;
    value: ProviderAccountLoginResponse;
  };
  providerAccountLoginCancel: {
    request: ProviderAccountLoginCancelRequest;
    value: ProviderAccountLoginCancelResponse;
  };
  providerAccountRegister: {
    request: ProviderAccountRegisterRequest;
    value: ProviderAccountRegisterResponse;
  };
}
