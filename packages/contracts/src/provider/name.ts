// The closed set of providers the daemon drives, one literal tuple surfaced as the wire schema and
// as the `readonly` array the schema conformance test compares with the database CHECK list.
import { z } from "zod";

const PROVIDER_NAME_VALUES = ["claude", "codex"] as const;

/**
 * The closed provider set, equal to the `provider_accounts.provider` CHECK list. It is not
 * `z.string()` because the provider selects the driver, credential-home layout and quota
 * vocabulary, so an unknown value has no safe reading.
 */
export type ProviderName = (typeof PROVIDER_NAME_VALUES)[number];
/** Every `ProviderName`, in declaration order. */
export const PROVIDER_NAMES: readonly ProviderName[] = PROVIDER_NAME_VALUES;
/** Parses a {@link ProviderName}. */
export const ProviderNameSchema: z.ZodType<ProviderName, ProviderName> =
  z.enum(PROVIDER_NAME_VALUES);
