// How the provider-account reading says one of its deliveries could not be read, kept apart from
// the fold; the refusal itself is composed in `wire-reads/unreadable-deliveries.ts`.

import type { UnreadableDeliveryStream } from "../wire-reads/unreadable-deliveries.js";

/** The subsystem name every refusal the provider-account reading raises carries. */
export const PROVIDER_QUOTA_REFUSAL_ORIGIN = "provider-account-quota";

/** The provider-account tail's words for a delivery it could not read. */
export const PROVIDER_QUOTA_DELIVERY_STREAM: UnreadableDeliveryStream = {
  origin: PROVIDER_QUOTA_REFUSAL_ORIGIN,
  sentence:
    "A provider-account delivery did not match the registered " +
    "notification shape, so it moved no account or quota here",
};
