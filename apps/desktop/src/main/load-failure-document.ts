// The generated load-failure document — Plan-023 Phase 1B (T-023p-1B-2).
//
// A rejected `loadURL` used to log and return, leaving a live, blank, retained
// window: no content, no reason on screen, and nothing for the user to act on.
// The window now loads this reserved path instead, so a load failure has a
// visible, controlled shape.
//
// The document is GENERATED in the main process and served from the renderer
// scheme's handler. It is deliberately not a file emitted into the renderer
// bundle, because the failure it reports is "the renderer bundle could not be
// loaded" — a fallback document living in the tree that just failed is a
// fallback that is missing exactly when it is needed. Being generated also makes
// containment trivially true rather than checked: this path never reaches the
// asset resolver, so no filesystem call happens on it at all and there is no
// root for it to escape.
//
// It carries no script (the CSP's `script-src 'self'` would refuse an inline one
// anyway), no link out, and no reload control — a retry affordance would need a
// renderer-to-main channel this phase does not have, and offering a button that
// did nothing is the capability-claimed-but-not-implemented shape
// `Spec-023 §Console Design (Meridian)` §Copy forbids.
//
// Split out of `./protocol.ts` so the document's own grammar — the reason
// bound, the escaping, the URL round trip — is unit-testable with no Electron
// import anywhere in its dependency graph.

import { RENDERER_HOST, RENDERER_ORIGIN, RENDERER_SCHEME } from "./renderer-scheme.js";

/** Reserved path serving the generated load-failure document. */
export const LOAD_FAILURE_PATH = "/-/load-failure";

/** Query parameter carrying the reason onto the failure document. */
const LOAD_FAILURE_REASON_PARAMETER = "reason";

/**
 * Longest reason rendered, counted in CODE POINTS.
 *
 * A reason is assembled from an Electron error message, which is neither
 * bounded nor authored by us; a document that grew with it would be a
 * main-process memory cost driven by the failure itself.
 */
const LOAD_FAILURE_REASON_MAX_CODE_POINTS = 300;

/**
 * The Unicode replacement character, substituted for an unpaired surrogate.
 *
 * Visible on purpose. The alternative — dropping the code unit — would make the
 * rendered reason silently differ from the message the process actually saw,
 * which is the one property a diagnostic must not have.
 */
const REPLACEMENT_CHARACTER = "�";

/**
 * Bounds a reason to the rendered length without leaving an unpaired surrogate
 * behind.
 *
 * Two distinct hazards, and only the second is about truncation:
 *
 *   1. `String.prototype.slice` cuts by UTF-16 CODE UNIT, so a cut landing
 *      between the halves of a surrogate pair leaves a lone high surrogate.
 *      `Array.from` iterates by CODE POINT, so a pair is one element and the
 *      cut can never fall inside it.
 *   2. The SOURCE message may already contain an unpaired surrogate, which no
 *      truncation strategy can fix because it was never a boundary artefact.
 *
 * Both matter because `encodeURIComponent` throws `URIError` on a lone
 * surrogate, and the one caller of {@link buildLoadFailureUrl} is a rejected
 * load's own recovery path: a throw there would escape the `.catch` that called
 * it, become an unhandled rejection, and skip the recovery entirely — a window
 * left blank by the very code written to stop that happening.
 *
 * The `u` flag is what makes the second pass precise: under it the engine
 * matches by code point, so a well-formed pair is a single code point outside
 * `[\uD800-\uDFFF]` and only genuinely unpaired surrogates are replaced.
 */
export function boundLoadFailureReason(reason: string): string {
  const bounded = Array.from(reason).slice(0, LOAD_FAILURE_REASON_MAX_CODE_POINTS).join("");
  return bounded.replace(/[\uD800-\uDFFF]/gu, REPLACEMENT_CHARACTER);
}

/**
 * Builds the URL a window loads to display `reason`.
 *
 * Total over every string: the bound above removes the only input
 * `encodeURIComponent` rejects, so this function does not throw. Its caller
 * guards the call anyway — see `./window-load-failure.ts` — because a recovery
 * path that depends on a totality proof is a recovery path that breaks the day
 * the proof stops holding.
 */
export function buildLoadFailureUrl(reason: string): string {
  const bounded = boundLoadFailureReason(reason);
  return `${RENDERER_ORIGIN}${LOAD_FAILURE_PATH}?${LOAD_FAILURE_REASON_PARAMETER}=${encodeURIComponent(bounded)}`;
}

/**
 * The reason carried by `url` when it targets the failure document, or `null`
 * when it does not target it at all.
 *
 * Matches on scheme, host, and the EXACT decoded path — never a prefix — so
 * `/-/load-failure/../index.html` is not this document and falls through to the
 * ordinary resolver, which refuses it.
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
 * Renders the failure document.
 *
 * The reason is escaped rather than trusted: it is assembled from an error
 * message, and an error message is one of the few strings in this process that
 * a remote input can shape. Escaping keeps it text even when it is markup.
 */
export function renderLoadFailureDocument(reason: string): string {
  const bounded = boundLoadFailureReason(reason);
  const shown = bounded === "" ? "No reason was reported." : bounded;
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    "<title>The console could not be loaded</title>",
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
    "<h1>The console could not be loaded</h1>",
    "<p>The application window is running, but its interface could not be served.</p>",
    `<p><code>${escapeHtmlText(shown)}</code></p>`,
    "<p>Close this window and start the application again. If it keeps happening, the",
    "installed files may be incomplete — reinstall, or run the application from a fresh build.</p>",
    "</main>",
    "</body>",
    "</html>",
  ].join("\n");
}
