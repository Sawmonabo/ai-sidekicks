// The one spelling of a Meridian token's custom property. Main stamps the transcript-width token
// on every console document's root and the renderer emits the rest of the sheet, so both name a
// token through here.

const TOKEN_PREFIX = "--meridian-";

/** The CSS custom-property name for a token: `transcript-width` is `--meridian-transcript-width`. */
export function tokenVariableName(tokenName: string): string {
  return `${TOKEN_PREFIX}${tokenName}`;
}
