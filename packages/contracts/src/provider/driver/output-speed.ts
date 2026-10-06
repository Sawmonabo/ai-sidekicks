// The provider's own report of its accelerated-output state on one binding.
import { z } from "zod";

import { wireFreeFormString } from "../../free-form-string.js";
import {
  DRIVER_OUTPUT_SPEED_REASON_MAX_LEN,
  DRIVER_PROVIDER_DECLARED_TOKEN_MAX_LEN,
} from "./length-limits.js";

/**
 * The provider's own report of its accelerated-output state, held for the binding's life from the
 * first declaration the provider makes, at spawn or thread establishment; absent until then and
 * never stored.
 */
export interface ProviderOutputSpeedState {
  /** The provider's level, verbatim; a level the driver does not list is kept, not coerced. */
  declared: string;
  /** The provider's own explanation, where it gave one. */
  reason?: string | undefined;
}

/** Validates a {@link ProviderOutputSpeedState}; strict, like `ProviderCommandEntrySchema`. */
export const ProviderOutputSpeedStateSchema: z.ZodType<
  ProviderOutputSpeedState,
  ProviderOutputSpeedState
> = z
  .object({
    declared: wireFreeFormString(
      DRIVER_PROVIDER_DECLARED_TOKEN_MAX_LEN,
      "ProviderOutputSpeedState.declared",
    ),
    reason: wireFreeFormString(
      DRIVER_OUTPUT_SPEED_REASON_MAX_LEN,
      "ProviderOutputSpeedState.reason",
    ).optional(),
  })
  .strict();
