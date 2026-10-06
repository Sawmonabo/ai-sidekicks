// The rules every free-form wire string follows: no NUL byte, not blank, and bounded.
import { z } from "zod";

/**
 * A free-form wire string with at least one non-whitespace character and no NUL byte, and no
 * length cap of its own: what a person writes to an agent, bounded only by the transport's
 * message limit. `fieldLabel` names the field in the refusal message. The whitespace check is
 * ASCII-only, so zero-width characters pass by design; no identity normalization happens here.
 * NUL is refused because it corrupts log lines and traces and opens log and filesystem injection.
 */
export const wireUncappedFreeFormString = (fieldLabel: string): z.ZodString =>
  z
    .string()
    .min(1)
    .regex(/\S/, {
      message: `${fieldLabel} must contain at least one non-whitespace character.`,
    })
    .refine((value) => !value.includes("\0"), {
      message: `${fieldLabel} MUST NOT contain a NUL byte.`,
    });

/**
 * A {@link wireUncappedFreeFormString} of at most `maxLen` characters, for a name, a reason or an
 * id the app itself bounds; the cap is defense in depth behind the transport's message limit.
 */
export const wireFreeFormString = (maxLen: number, fieldLabel: string): z.ZodString =>
  wireUncappedFreeFormString(fieldLabel).max(maxLen);

/**
 * The longest filesystem path any wire string carries. 4096 is Linux's `PATH_MAX`, above macOS's
 * 1024 and Windows' 260-character default; a longer Windows extended-length path is refused.
 */
export const FILE_PATH_MAX_LEN = 4096;
