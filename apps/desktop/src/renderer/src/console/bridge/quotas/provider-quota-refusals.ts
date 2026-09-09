// How this family says an account-plane reading could not be taken.
//
// Split from `provider-account-quota.ts` for the reason `queue-refusals.ts` was split
// from the reading beside it: composing a refusal and holding a registry are two jobs,
// and the sentence here is a pure function of what failed, so it is testable without a
// bridge and readable without the fold.
//
// The ORIGIN lives here rather than beside either reader because three modules now
// raise refusals in this subsystem's name — the wire, the tail, and this file — and a
// constant declared beside one of them would make the other two import through it.
//
// WHAT IS HERE IS THIS STREAM'S WORDS. The refusal itself is composed in `readings/`,
// which is where the queue's is composed too: the two were written out separately and
// were the same function apart from the origin and the noun.

import {
  unreadableDeliveryRefusalComposerFor,
  type UnreadableDeliveryRefusalComposer,
} from "../readings/index.js";

/** The subsystem name every refusal the account-plane reading raises carries. */
export const PROVIDER_QUOTA_REFUSAL_ORIGIN = "provider-account-quota";

/** One unreadable account-plane delivery as the refusal a surface renders. */
export const unreadableProviderQuotaDeliveryRefusal: UnreadableDeliveryRefusalComposer =
  unreadableDeliveryRefusalComposerFor({
    origin: PROVIDER_QUOTA_REFUSAL_ORIGIN,
    sentence:
      "A provider-account delivery did not match the registered notification shape, so it moved no account or quota here",
  });
