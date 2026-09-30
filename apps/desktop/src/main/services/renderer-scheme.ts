// The renderer transport's identity and content-security policy. This module imports nothing,
// so the handler that serves the bundle, the window factory (which decides which origins a
// window may navigate within) and the build config (which stands up the dev server) can all
// take these values without an Electron import.
//
// The policy lives beside the scheme because the renderer document is served over two
// transports, this scheme and the Vite dev server, and a policy inside the production handler
// is one the dev transport cannot state.

/** Scheme the built renderer bundle is served from. */
export const RENDERER_SCHEME = "sidekicks-renderer";

/** The only host this scheme serves. Any other host is refused. */
export const RENDERER_HOST = "app";

/** Origin of the served bundle — the persistence partition key for IndexedDB. */
export const RENDERER_ORIGIN = "sidekicks-renderer://app";

/** The one navigable document; every route is this URL plus a hash fragment. */
export const RENDERER_INDEX_URL = "sidekicks-renderer://app/index.html";

// A response header is the policy's only carrier; the shipped `index.html` has no meta tag.
// `connect-src` is `'self'` alone, stricter than the baseline's text, which also admits a
// configured control-plane and relay origin; no such origin is configured anywhere yet, and a
// placeholder would neither allow the real origin nor refuse honestly. It is also the one
// directive the dev transport widens, so it is a constant of its own.
const RENDERER_CONNECT_SRC = "connect-src 'self'";

/** Every directive except `connect-src`, in emitted order. Both transports share it verbatim. */
const RENDERER_POLICY_DIRECTIVES: readonly string[] = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
];

/**
 * Composes a policy from the shared directives plus one `connect-src`, spliced into second
 * position so the two policies differ by one token, not by the whole string.
 */
function composePolicy(connectSrc: string): string {
  const [defaultSrc, ...rest] = RENDERER_POLICY_DIRECTIVES;
  return [defaultSrc, connectSrc, ...rest].join("; ");
}

/** The exact `Content-Security-Policy` header every scheme response carries. */
export const RENDERER_CONTENT_SECURITY_POLICY: string = composePolicy(RENDERER_CONNECT_SRC);

/**
 * The port `electron-vite dev` serves the renderer on. Pinned, and paired with `strictPort` in
 * the config, because the dev policy names this origin: a server that silently moved would
 * emit a policy for an origin it is not serving and the HMR socket would be refused.
 */
export const RENDERER_DEV_SERVER_PORT = 5173;

/**
 * The policy the Vite dev server emits on every response: the production policy with a
 * `connect-src` that also names the HMR WebSocket origins. CSP Level 3 already lets `'self'`
 * match `ws:` from an `http:` document, so the additions are redundant on a conforming engine,
 * but they prevent an HMR socket refused by our own header. Both loopback spellings are named
 * because Electron reaches the dev server by whichever `ELECTRON_RENDERER_URL` carries. Dev
 * only: `window.ts` takes the dev branch only when the app is unpackaged and
 * `ELECTRON_RENDERER_URL` is set.
 */
export const RENDERER_DEV_CONTENT_SECURITY_POLICY: string = composePolicy(
  `${RENDERER_CONNECT_SRC} ws://localhost:${String(RENDERER_DEV_SERVER_PORT)} ` +
    `ws://127.0.0.1:${String(RENDERER_DEV_SERVER_PORT)}`,
);
