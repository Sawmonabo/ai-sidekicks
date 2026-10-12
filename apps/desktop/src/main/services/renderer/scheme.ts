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
export const RENDERER_ORIGIN: string = `${RENDERER_SCHEME}://${RENDERER_HOST}`;

/** The one navigable document; every route is this URL plus a hash fragment. */
export const RENDERER_INDEX_URL: string = `${RENDERER_ORIGIN}/index.html`;

// A response header is the policy's only carrier; the shipped `index.html` has no meta tag.
// `connect-src` is `'self'`: the page connects to nothing beyond its own origin. It is the one
// directive the dev transport widens, so it is a constant of its own.
const RENDERER_CONNECT_SRC = "connect-src 'self'";

// A dedicated worker takes its policy from its own script's response, so only the scripts of the
// workers that run WebAssembly, the diagram worker (merman) and the markdown worker (Sätteri),
// admit `'wasm-unsafe-eval'`, which lets their WebAssembly compile and still refuses every
// JavaScript evaluation.
const RENDERER_SCRIPT_SRC = "script-src 'self'";
const WEBASSEMBLY_WORKER_SCRIPT_SRC = "script-src 'self' 'wasm-unsafe-eval'";

/** Every directive except `connect-src` and `script-src`. Both transports share it verbatim. */
const RENDERER_POLICY_DIRECTIVES: readonly string[] = [
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
];

/**
 * Composes a policy from the shared directives, one `connect-src` and one `script-src`, so the
 * page's and the WebAssembly workers' policies, and each transport's, differ only in those tokens.
 */
function composePolicy(connectSrc: string, scriptSrc: string): string {
  return ["default-src 'self'", connectSrc, scriptSrc, ...RENDERER_POLICY_DIRECTIVES].join("; ");
}

/**
 * The exact `Content-Security-Policy` header of every scheme response but the script of a worker
 * that runs WebAssembly.
 */
export const RENDERER_CONTENT_SECURITY_POLICY: string = composePolicy(
  RENDERER_CONNECT_SRC,
  RENDERER_SCRIPT_SRC,
);

/** The exact `Content-Security-Policy` header a WebAssembly worker's script carries. */
export const WEBASSEMBLY_WORKER_CONTENT_SECURITY_POLICY: string = composePolicy(
  RENDERER_CONNECT_SRC,
  WEBASSEMBLY_WORKER_SCRIPT_SRC,
);

/** The diagram worker's bundle name; the build writes its script as `<name>-<hash>.js`. */
export const DIAGRAM_WORKER_BUNDLE_NAME = "diagram-worker";

/** The markdown worker's bundle name; the build writes its script as `<name>-<hash>.js`. */
export const MARKDOWN_WORKER_BUNDLE_NAME = "markdown-worker";

const WEBASSEMBLY_WORKER_SCRIPT_PATTERN = new RegExp(
  `^(?:${DIAGRAM_WORKER_BUNDLE_NAME}|${MARKDOWN_WORKER_BUNDLE_NAME})-[\\w-]+\\.js$`,
  "u",
);

/** Is this served file, by its base name, the built script of a worker that runs WebAssembly? */
export function isWebAssemblyWorkerScript(fileName: string): boolean {
  return WEBASSEMBLY_WORKER_SCRIPT_PATTERN.test(fileName);
}

/**
 * The port `electron-vite dev` serves the renderer on. Pinned, and paired with `strictPort` in
 * the config, because the dev policy names this origin: a server that silently moved would
 * emit a policy for an origin it is not serving and the HMR socket would be refused.
 */
export const RENDERER_DEV_SERVER_PORT = 5173;

/** The `connect-src` the dev server sends: the production one plus the HMR WebSocket origins. */
const RENDERER_DEV_CONNECT_SRC =
  `${RENDERER_CONNECT_SRC} ws://localhost:${String(RENDERER_DEV_SERVER_PORT)} ` +
  `ws://127.0.0.1:${String(RENDERER_DEV_SERVER_PORT)}`;

/**
 * The policy the Vite dev server emits on every response but a WebAssembly worker's: the production
 * policy with a `connect-src` that also names the HMR WebSocket origins. CSP Level 3 already lets
 * `'self'` match `ws:` from an `http:` document, so the additions are redundant on a conforming
 * engine, but they prevent an HMR socket refused by our own header. Both loopback spellings are
 * named because Electron reaches the dev server by whichever `ELECTRON_RENDERER_URL` carries. Dev
 * only: `factory.ts` takes the dev branch only when the app is unpackaged and
 * `ELECTRON_RENDERER_URL` is set.
 */
export const RENDERER_DEV_CONTENT_SECURITY_POLICY: string = composePolicy(
  RENDERER_DEV_CONNECT_SRC,
  RENDERER_SCRIPT_SRC,
);

/** The policy the Vite dev server emits on a WebAssembly worker's script. */
export const WEBASSEMBLY_WORKER_DEV_CONTENT_SECURITY_POLICY: string = composePolicy(
  RENDERER_DEV_CONNECT_SRC,
  WEBASSEMBLY_WORKER_SCRIPT_SRC,
);
