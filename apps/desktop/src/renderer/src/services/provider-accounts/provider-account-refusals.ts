// How the provider-account reading says an account-plane read could not be taken. The sentence is a
// pure function of what failed, kept apart from the fold so it is testable without a bridge; the
// refusal itself is composed in `wire-reads/unreadable-deliveries.ts`.

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
