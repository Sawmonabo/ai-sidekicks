// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A color as the wire carries it: sRGB written `#rrggbb`, either case.

/** The pattern every color field checks, as text: an sRGB color written `#rrggbb`, either case. */
export const HEX_COLOR_PATTERN = "^#[0-9a-fA-F]{6}$" as const;

/**
 * An sRGB color written `#rrggbb`, either case.
 */
export type HexColor = string;

export { validateHexColor } from "./checks/color.js";
