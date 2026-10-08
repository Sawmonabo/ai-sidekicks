// Why this machine's keychain could not be used: the one cause a refused seal carries, whether of a
// provider account's token, a workflow secret or a notification delivery secret.
import { z } from "zod";

const KEYCHAIN_REFUSAL_CAUSE_VALUES = ["locked", "unavailable"] as const;

/**
 * Why this machine's keychain could not be used: it is `locked`, or there is no keychain the app
 * can use (`unavailable`). A secret that cannot be sealed is refused and stored nowhere else, and
 * every refusal over the keychain carries this one pair.
 */
export type KeychainRefusalCause = (typeof KEYCHAIN_REFUSAL_CAUSE_VALUES)[number];
/**
 * Every {@link KeychainRefusalCause}.
 *
 * @consumedBy the paste-token refusal, one line per keychain cause
 */
export const KEYCHAIN_REFUSAL_CAUSES: readonly KeychainRefusalCause[] =
  KEYCHAIN_REFUSAL_CAUSE_VALUES;
/** Parses a {@link KeychainRefusalCause}. */
export const KeychainRefusalCauseSchema: z.ZodType<KeychainRefusalCause, KeychainRefusalCause> =
  z.enum(KEYCHAIN_REFUSAL_CAUSE_VALUES);
