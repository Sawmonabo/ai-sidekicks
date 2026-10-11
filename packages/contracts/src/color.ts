// A color as the wire carries it: sRGB written `#rrggbb`, either case.

import { z } from "zod";

/** An sRGB color written `#rrggbb`, either case; the one pattern every color field checks. */
export const HEX_COLOR_PATTERN: RegExp = /^#[0-9a-f]{6}$/iu;

/** An sRGB color written `#rrggbb`. */
export type HexColor = string;

/** Parses a {@link HexColor}. */
export const HexColorSchema: z.ZodType<HexColor, HexColor> = z.string().regex(HEX_COLOR_PATTERN);
