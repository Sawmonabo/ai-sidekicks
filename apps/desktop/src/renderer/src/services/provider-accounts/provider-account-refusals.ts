// How the provider-account reading says an account-plane read could not be taken.
//
// Composing a refusal and holding a registry are two jobs, and the sentence here is a
// pure function of what failed, so it is testable without a bridge and readable
// without the fold. The ORIGIN lives here beside that sentence, and the tail
// (`provider-account-deliveries.ts`) imports both.
//
// WHAT IS HERE IS THIS STREAM'S WORDS. The refusal itself is composed in
// `wire-reads/unreadable-deliveries.ts`;
// this file supplies only the origin and the sentence.

import {
  unreadableDeliveryRefusalComposerFor,
  type UnreadableDeliveryRefusalComposer,
} from "../wire-reads/unreadable-deliveries.js";

/** The subsystem name every refusal the account-plane reading raises carries. */
export const PROVIDER_QUOTA_REFUSAL_ORIGIN = "provider-account-quota";

/** One unreadable account-plane delivery as the refusal a view renders. */
export const unreadableProviderQuotaDeliveryRefusal: UnreadableDeliveryRefusalComposer =
  unreadableDeliveryRefusalComposerFor({
    origin: PROVIDER_QUOTA_REFUSAL_ORIGIN,
    sentence:
      "A provider-account delivery did not match the registered notification shape, so it moved no account or quota here",
  });
