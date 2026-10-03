// The generated document a window loads when its renderer bundle could not be loaded, so a
// load failure has a visible reason instead of a blank window.
//
// It is generated in main and served from the renderer scheme's handler, not emitted into the
// bundle: a fallback living in the tree that just failed is missing exactly when needed. This
// path never reaches the asset resolver, so no file system call happens on it.
//
// It carries no script (the CSP would refuse an inline one), no link out, and no reload
// control: a retry needs a renderer-to-main channel that does not exist, and a control that
// claims a capability nothing implements is what the app's copy rules forbid. It is split
// from `../services/renderer-protocol.ts` so its grammar is unit-testable with no Electron
// import.

import { RENDERER_HOST, RENDERER_ORIGIN, RENDERER_SCHEME } from "../services/renderer-scheme.js";

/** Reserved path serving the generated load-failure document. */
export const LOAD_FAILURE_PATH = "/-/load-failure";

/** Query parameter carrying the reason onto the failure document. */
const LOAD_FAILURE_REASON_PARAMETER = "reason";

/**
 * Longest reason rendered, in code points. The reason comes from an Electron error message,
 * which is unbounded, so an unbounded document would be a memory cost driven by the failure.
 */
const LOAD_FAILURE_REASON_MAX_CODE_POINTS = 300;

/**
 * The Unicode replacement character, substituted for an unpaired surrogate. Visible on
 * purpose: dropping the code unit would make the rendered reason silently differ from the
 * message the process saw.
 */
const REPLACEMENT_CHARACTER = "�";

/**
 * Bounds a reason to the rendered length without leaving an unpaired surrogate behind. Two
 * hazards: `slice` cuts by UTF-16 code unit and can split a pair (`Array.from` iterates by code
 * point, so the cut cannot fall inside one), and the source message may already contain an
 * unpaired surrogate. Both matter because `encodeURIComponent` throws `URIError` on a lone
 * surrogate, and the caller is a rejected load's own recovery path, where a throw would skip
 * the recovery. The `u` flag makes the replacement match by code point, so a well-formed pair
 * is untouched.
 */
export function boundLoadFailureReason(reason: string): string {
  const bounded = Array.from(reason).slice(0, LOAD_FAILURE_REASON_MAX_CODE_POINTS).join("");
  return bounded.replace(/[\uD800-\uDFFF]/gu, REPLACEMENT_CHARACTER);
}

/**
 * Builds the URL a window loads to display `reason`. Total over every string, since the bound
 * removes the only input `encodeURIComponent` rejects; the caller guards it anyway because a
 * recovery path should not depend on a totality proof.
 */
export function buildLoadFailureUrl(reason: string): string {
  const bounded = boundLoadFailureReason(reason);
  return `${RENDERER_ORIGIN}${LOAD_FAILURE_PATH}?${LOAD_FAILURE_REASON_PARAMETER}=${encodeURIComponent(bounded)}`;
}

/**
 * The reason carried by `url` when it targets the failure document, or `null` otherwise.
 * Matches scheme, host and the exact decoded path, never a prefix, so
 * `/-/load-failure/../index.html` falls through to the resolver, which refuses it.
 */
export function matchLoadFailureRequest(url: string): string | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }
  if (
    parsedUrl.protocol !== `${RENDERER_SCHEME}:` ||
    parsedUrl.host.toLowerCase() !== RENDERER_HOST ||
    parsedUrl.pathname !== LOAD_FAILURE_PATH
  ) {
    return null;
  }
  return parsedUrl.searchParams.get(LOAD_FAILURE_REASON_PARAMETER) ?? "";
}

/** HTML-escapes text for interpolation into the document body. */
function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Renders the failure document. The reason is escaped rather than trusted: it comes from an
 * error message, which remote input can shape, and escaping keeps it text even when it is
 * markup.
 */
export function renderLoadFailureDocument(reason: string): string {
  const bounded = boundLoadFailureReason(reason);
  const shown = bounded === "" ? "No reason was reported." : bounded;
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    "<title>The app could not be loaded</title>",
    "<style>",
    "html{color-scheme:light dark}",
    "body{margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;",
    "font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;padding:2rem}",
    "main{max-width:38rem}",
    "h1{font-size:1.125rem;font-weight:600;margin:0 0 .5rem}",
    "p{margin:0 0 .75rem}",
    "code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;",
    "overflow-wrap:anywhere}",
    "</style>",
    "</head>",
    "<body>",
    "<main>",
    "<h1>The app could not be loaded</h1>",
    "<p>The application window is running, but its interface could not be served.</p>",
    `<p><code>${escapeHtmlText(shown)}</code></p>`,
    "<p>Close this window and start the application again. If it keeps happening, the",
    "installed files may be incomplete — reinstall the application.</p>",
    "</main>",
    "</body>",
    "</html>",
  ].join("\n");
}
