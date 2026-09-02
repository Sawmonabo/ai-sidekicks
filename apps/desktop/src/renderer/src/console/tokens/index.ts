// The design-token door.
//
// Everything the Meridian language decides — the colour space and its gamut fit,
// the scheme pairs, the participant hue wheel, the type / space / radius scales,
// the motion durations, the glyph set, and the two functions that install a
// generated stylesheet into a document — reaches the rest of the console through
// this file.
//
// WHY A DOOR AND NOT SEVEN DEEP PATHS. A token is a value another family renders
// with, so almost every family imports something here. If they each reach for the
// module that happens to hold the symbol today, then moving a token between
// `palette.ts` and `tokens.ts` — an edit inside this family — breaks files that
// have no business knowing this family has more than one module. The door is what
// makes the split an implementation detail.
//
// This family imports nothing from the console above it. It is the vocabulary
// layer: it may be read by anything and may read nothing.
//
// IT IS ALSO DOM-FREE, AND THAT IS A CONSTRAINT RATHER THAN AN OBSERVATION. The
// generated-asset tier runs in node and imports this family to byte-diff the
// emitted sheet against the palette it came from. A module here that typed a
// `Document` or a `Window` would put those names into a program that has neither,
// and the family would stop being readable by the tooling that validates it. The
// one part of the token story that DOES touch a document — installing the
// generated sheet and setting the scheme attribute — lives in
// `frame/token-installation.ts`, where mounting already happens.

export type { ConsoleScheme, SchemePreference } from "./tokens.js";
export {
  CONSOLE_SCHEMES,
  PARTICIPANT_HUES,
  SCHEME_COLOR_TOKENS,
  SCHEME_PREFERENCES,
  SYSTEM_SCHEME_PREFERENCE,
  isSchemePreference,
  participantHueTokenName,
  tokenReference,
  tokenVariableName,
} from "./tokens.js";

export {
  ATTRIBUTION_EDGE_WIDTH_PX,
  BOUNDED_ENUMERATION_MAX_HEIGHT_REM,
  BOUNDED_ENUMERATION_MAX_ROWS,
  ENUMERATION_ROW_HEIGHT_REM,
  MOTION_DURATIONS_MS,
  PARTICIPANT_HUE_STEPS,
} from "./palette.js";

export { formatOklch } from "./color.js";

export type { GlyphName } from "./glyphs.js";

export type { ParticipantHueAssignment, ParticipantRingTreatment } from "./participant-hue.js";
export { ParticipantHueAllocator, RING_TREATMENTS } from "./participant-hue.js";

export { SCHEME_ATTRIBUTE, generateMeridianCss } from "./generate-css.js";
