// The renderer transport's identity and its content-security policy.
//
// Plan-023 Phase 1B (T-023p-1B-1). Split out of `./protocol.ts` so the three
// things that need these values do not have to reach through an Electron
// import to get them: the handler that serves the bundle, the window factory
// that decides which origins a window may navigate within, and the build config
// that stands up the dev server. This module therefore imports NOTHING — not
// `electron`, not `node:*` — and holds only frozen data.
//
// Why the policy lives beside the scheme rather than beside the handler: the
// scheme and the policy are one decision. `Spec-023 §Security Hardening
// Baseline` locks a policy for the renderer DOCUMENT, and that document is
// served over two transports — this scheme in every packaged and built tree,
// and the Vite dev server under `electron-vite dev`. A policy defined inside
// the production handler is a policy the other transport has no way to state,
// which is exactly how the dev document ended up with none.

/** Scheme the built renderer bundle is served from. */
export const RENDERER_SCHEME = "sidekicks-renderer";

/** The only host this scheme serves. Any other host is refused. */
export const RENDERER_HOST = "app";

/** Origin of the served bundle — the persistence partition key for IndexedDB. */
export const RENDERER_ORIGIN = "sidekicks-renderer://app";

/** The one navigable document; every route is this URL plus a hash fragment. */
export const RENDERER_INDEX_URL = "sidekicks-renderer://app/index.html";

// `Spec-023 §Security Hardening Baseline` locks this policy, and a response
// HEADER is its only carrier — the shipped `index.html` deliberately has no
// meta tag.
//
// `connect-src` is narrower than the baseline's text, which reads
// `'self' https://<configured-control-plane-origin> wss://<configured-relay-origin>`.
// Those are placeholders: no control-plane origin and no relay origin is
// configured anywhere in the workspace at Tier 1, and emitting a placeholder
// string would produce a policy that neither allows the real origin nor refuses
// honestly. The baseline is stated as a floor ("At minimum"), so shipping
// `'self'` alone is stricter than it requires, not looser. The two configured
// origins join this directive in the Tier-8 remainder, when the surface that
// configures them lands (Plan-023 Phase 3 wires the daemon and relay clients).
//
// `connect-src` is also the ONE directive the dev transport widens, which is
// why it is named as its own constant below rather than inlined here.
const RENDERER_CONNECT_SRC = "connect-src 'self'";

/**
 * Every directive except `connect-src`, in the order they are emitted.
 *
 * Shared verbatim by both transports. A directive added here reaches the dev
 * server and the production handler in the same edit, which is the property the
 * parity test in `renderer-scheme.test.ts` asserts.
 */
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
 * Composes a policy from the shared directives plus one `connect-src`.
 *
 * `connect-src` is spliced into second position rather than appended, so both
 * policies read in the same order and a diff between them is a diff of one
 * token rather than of the whole string.
 */
function composePolicy(connectSrc: string): string {
  const [defaultSrc, ...rest] = RENDERER_POLICY_DIRECTIVES;
  return [defaultSrc, connectSrc, ...rest].join("; ");
}

/** The exact `Content-Security-Policy` header every scheme response carries. */
export const RENDERER_CONTENT_SECURITY_POLICY: string = composePolicy(RENDERER_CONNECT_SRC);

/**
 * The port `electron-vite dev` serves the renderer on.
 *
 * Pinned rather than left to Vite's "first free port" search, because the dev
 * policy below names this origin: a server that silently moved to 5174 would
 * emit a policy for an origin it is not serving, and the HMR socket would be
 * refused by the very header meant to allow it. The config pairs this with
 * `strictPort`, so a collision fails the dev server loudly instead of moving
 * it — the failure a developer can act on, rather than a broken socket they
 * have to diagnose.
 */
export const RENDERER_DEV_SERVER_PORT = 5173;

/**
 * The policy the Vite dev server emits on every response.
 *
 * Identical to the production policy except for `connect-src`, which additionally
 * names the HMR WebSocket origins. CSP Level 3 already lets `'self'` match a
 * `ws:` URL when the document's scheme is `http:`, so on a conforming engine
 * the additions are redundant — they are stated anyway because the cost is two
 * tokens and the failure they prevent (an HMR socket refused by our own header)
 * presents as "the dev server stopped reloading", which is a slow thing to
 * diagnose. Both spellings of the loopback host are named because Vite resolves
 * the HMR host from the request the browser made, and Electron reaches the dev
 * server by whichever one `ELECTRON_RENDERER_URL` carries.
 *
 * This is a DEV-only widening on a DEV-only origin. Nothing in a packaged or
 * built tree reads it: `window.ts` takes the dev branch only when the app is
 * unpackaged AND `ELECTRON_RENDERER_URL` is set.
 */
export const RENDERER_DEV_CONTENT_SECURITY_POLICY: string = composePolicy(
  `${RENDERER_CONNECT_SRC} ws://localhost:${String(RENDERER_DEV_SERVER_PORT)} ` +
    `ws://127.0.0.1:${String(RENDERER_DEV_SERVER_PORT)}`,
);
