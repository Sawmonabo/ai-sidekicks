// Renderer scheme registration and the built-bundle protocol handler.
//
// Plan-023 Phase 1B (T-023p-1B-1). Two exported entry points so the startup
// ORDER is asserted rather than assumed (`startup-order.test.ts`):
//
//   • `registerRendererScheme()` — module-top-level in `main/index.ts`, ahead
//     of every `whenReady()` consumer. Electron accepts exactly one
//     `registerSchemesAsPrivileged` call per process and it must happen before
//     `app.ready`; a scheme left non-standard has no origin, and an origin-less
//     document gets neither IndexedDB nor `localStorage`
//     (`Spec-023 §Renderer Bundle`, `Spec-023 §Console Design (Meridian)`
//     §Persistence on the renderer scheme; Plan-023 I-023-11).
//   • `installRendererProtocol(rendererRoot)` — inside `whenReady()`, BEFORE
//     any window is constructed, so no window can ever race the handler.
//
// The bundle is served over this custom scheme and never over `file://`,
// because `Spec-023 §Security Hardening Baseline` disables the
// `GrantFileProtocolExtraPrivileges` fuse (Plan-023 I-023-2).
//
// Resolution is one pure function, `resolveRendererAsset`, so every containment
// arm is unit-testable without an Electron process. Its failure matrix is
// enumerated in `protocol.test.ts` and summarised here:
//
//   raw `..` segment ............ forbidden   (the URL parser SILENTLY collapses
//                                              `..`, so the guard reads the RAW
//                                              path, never the parsed pathname)
//   `%2e%2e` ................... forbidden   (decode, then re-scan segments)
//   `%2F` / `%2f` .............. forbidden   (an encoded separator is a probe)
//   `%5C` / `%5c` / `\` ........ forbidden   (Windows separator smuggling)
//   `//…` (absolute) ........... forbidden   (one leading slash is stripped, so
//                                              a second leaves an absolute path)
//   `C:/…` (drive-absolute) .... forbidden   (rejected on every platform, not
//                                              just where `isAbsolute` says so)
//   symlink leaving the root ... forbidden   (`realpath` on both sides)
//   host other than `app` ...... forbidden
//   NUL / malformed percent .... forbidden
//   miss / directory ........... not-found
//
// Both refusals answer with an EMPTY body and echo no path, so a probe learns
// nothing about the tree. There is deliberately no `index.html` fallback: the
// console routes by hash, so every navigable URL is `index.html` plus a
// fragment and a fallback would only turn typos into a served shell.
//
// Bodies stream through `net.fetch(pathToFileURL(...))` — the pattern Electron's
// own `protocol.handle` documentation gives — so no response is ever buffered
// into main-process memory.

import { net, protocol } from "electron";
import type { Stats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Scheme the built renderer bundle is served from. */
export const RENDERER_SCHEME = "sidekicks-renderer";

/** The only host this scheme serves. Any other host is refused. */
export const RENDERER_HOST = "app";

/** Origin of the served bundle — the persistence partition key for IndexedDB. */
export const RENDERER_ORIGIN = "sidekicks-renderer://app";

/** The one navigable document; every route is this URL plus a hash fragment. */
export const RENDERER_INDEX_URL = "sidekicks-renderer://app/index.html";

// `Spec-023 §Security Hardening Baseline` locks this policy, and this header is
// its ONLY carrier — the shipped `index.html` deliberately has no meta tag.
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
const CONTENT_SECURITY_POLICY_DIRECTIVES: readonly string[] = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
];

/** The exact `Content-Security-Policy` header value every response carries. */
export const RENDERER_CONTENT_SECURITY_POLICY: string =
  CONTENT_SECURITY_POLICY_DIRECTIVES.join("; ");

// A CLOSED extension map. An unmapped extension answers `application/octet-stream`
// rather than being sniffed — which is only meaningful paired with the
// `nosniff` header below, since without it Chromium would content-sniff the
// octet-stream body and could execute it.
//
// `.map` is deliberately ABSENT rather than mapped: source maps are refused
// outright by the guard below, so giving them a content type would describe a
// response this handler never produces.
const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
  [".wasm", "application/wasm"],
]);

/** The source-map suffix this handler refuses, matched case-insensitively. */
const SOURCE_MAP_SUFFIX = ".map";

/**
 * Whether a request targets a source map, and therefore gets an unconditional
 * empty-bodied 404.
 *
 * The build emits hidden source maps for the Sentry upload; they are not
 * shipped, and Phase 5's `electron-builder` `files` filter excludes
 * `out/**\/*.map` from the package. But a developer tree has them sitting
 * beside the bundle, so "not packaged" is not the same as "not reachable" —
 * without this the handler would happily serve the renderer's full original
 * sources to anything that could reach the scheme. Refusing at the handler
 * makes the guarantee hold in every tree rather than only in a packaged one.
 *
 * Checked on BOTH the raw and the decoded text so `/x%2Emap` cannot slip past
 * a raw-only comparison, and answered UNCONDITIONALLY — before containment,
 * before any filesystem call, and before content-type resolution — so no
 * source map is ever read, let alone served, on any code path.
 */
function isSourceMapRequest(rawPath: string): boolean {
  if (rawPath.toLowerCase().endsWith(SOURCE_MAP_SUFFIX)) {
    return true;
  }
  try {
    return decodeURIComponent(rawPath).toLowerCase().endsWith(SOURCE_MAP_SUFFIX);
  } catch {
    // A malformed escape is refused a few lines below anyway; it is not a map.
    return false;
  }
}

/** Content type served for any extension outside the closed map above. */
export const FALLBACK_CONTENT_TYPE = "application/octet-stream";

/**
 * Outcome of resolving one `sidekicks-renderer://app/<path>` request against the
 * built renderer tree.
 *
 * The two refusal arms carry NO other member by construction: a 403 or 404 that
 * echoed the attempted path would tell a probe which paths exist.
 */
export type RendererAssetResolution =
  | { readonly outcome: "resolved"; readonly absolutePath: string; readonly contentType: string }
  | { readonly outcome: "not-found" }
  | { readonly outcome: "forbidden" };

const FORBIDDEN: RendererAssetResolution = { outcome: "forbidden" };
const NOT_FOUND: RendererAssetResolution = { outcome: "not-found" };

/**
 * Extracts the raw (still percent-encoded) path component of `url`, without
 * letting the WHATWG URL parser normalise it first.
 *
 * This matters: `new URL('sidekicks-renderer://app/../etc/passwd').pathname` is
 * `/etc/passwd` — the parser silently repairs the traversal, so a guard reading
 * `pathname` would see a clean path and admit a probe. Reading the raw text is
 * what makes the `..` arm reachable at all.
 *
 * Returns `null` when the input has no `://` authority separator.
 */
function extractRawPath(url: string): string | null {
  const authorityStart = url.indexOf("://");
  if (authorityStart < 0) {
    return null;
  }
  const afterAuthorityMarker = url.slice(authorityStart + "://".length);
  // The authority ends at the first `/`, `?`, or `#`; whichever comes first.
  const pathStart = afterAuthorityMarker.search(/[/?#]/);
  if (pathStart < 0) {
    return "";
  }
  const remainder = afterAuthorityMarker.slice(pathStart);
  if (!remainder.startsWith("/")) {
    // Query or fragment with no path at all.
    return "";
  }
  const queryStart = remainder.search(/[?#]/);
  return queryStart < 0 ? remainder : remainder.slice(0, queryStart);
}

/**
 * Resolves one renderer-scheme URL to an absolute file inside `rendererRoot`.
 *
 * Pure with respect to its arguments plus the filesystem: it performs no
 * Electron call, so every arm of the failure matrix above is unit-testable.
 * Any doubt at any step answers `forbidden` with no path attached.
 */
export async function resolveRendererAsset(
  rendererRoot: string,
  url: string,
): Promise<RendererAssetResolution> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return FORBIDDEN;
  }

  if (parsedUrl.protocol !== `${RENDERER_SCHEME}:`) {
    return FORBIDDEN;
  }
  // `host` carries the port when one is present, so an authority like
  // `app:8080` fails this equality rather than passing a hostname-only check.
  // Credentials in the authority are refused outright: this scheme has no
  // authentication and a URL that carries any is a malformed probe.
  if (
    parsedUrl.host.toLowerCase() !== RENDERER_HOST ||
    parsedUrl.username !== "" ||
    parsedUrl.password !== ""
  ) {
    return FORBIDDEN;
  }

  const rawPath = extractRawPath(url);
  if (rawPath === null) {
    return FORBIDDEN;
  }
  if (rawPath === "") {
    // No path at all — a miss, not an escape, and no `index.html` fallback.
    return NOT_FOUND;
  }

  // Source maps: refused before anything else looks at the path. 404 and not
  // 403 deliberately — a source map that is present and a source map that is
  // absent must be indistinguishable, and 403 would confirm the file is there.
  if (isSourceMapRequest(rawPath)) {
    return NOT_FOUND;
  }

  // Separator smuggling, checked on the still-encoded text. `%2F` and `%5C`
  // survive the URL parser's pathname (verified against Node's WHATWG parser),
  // so a decode-first guard would turn them into real separators before any
  // segment scan could see them for what they are.
  if (/%2f/i.test(rawPath) || /%5c/i.test(rawPath) || rawPath.includes("\\")) {
    return FORBIDDEN;
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    // Malformed percent-escape — refuse rather than guess at the intent.
    return FORBIDDEN;
  }

  if (decodedPath.includes("\0") || decodedPath.includes("\\")) {
    return FORBIDDEN;
  }
  if (decodedPath.split("/").includes("..")) {
    return FORBIDDEN;
  }

  // Strip EXACTLY the one leading slash the URL grammar guarantees. A second
  // one survives and trips the absolute-path guard below, which is the honest
  // answer: `sidekicks-renderer://app//etc/passwd` is a probe, not a typo.
  const relativePath = decodedPath.slice(1);
  if (relativePath === "") {
    return NOT_FOUND;
  }
  // `path.isAbsolute` is platform-dependent, so the Windows drive prefix is
  // rejected explicitly and the verdict is the same on every platform.
  if (path.isAbsolute(relativePath) || /^[a-z]:/i.test(relativePath)) {
    return FORBIDDEN;
  }

  const resolvedRoot = path.resolve(rendererRoot);
  const candidatePath = path.resolve(resolvedRoot, relativePath);
  if (!isContainedIn(resolvedRoot, candidatePath)) {
    return FORBIDDEN;
  }

  // Symlink containment. Both sides are realpath'd because the root itself may
  // sit under a symlinked prefix (`/tmp` on macOS is `/private/tmp`), and
  // comparing a real candidate against a symlinked root would refuse every
  // legitimate asset. Neither result is memoised: the second realpath costs one
  // warm-cache syscall against a file read that is orders of magnitude larger,
  // and a cache here would need an invalidation story it cannot honestly have.
  let realRoot: string;
  try {
    realRoot = await realpath(resolvedRoot);
  } catch {
    // The built tree is missing or unreadable — a misconfiguration, not a miss.
    return FORBIDDEN;
  }

  let realCandidate: string;
  try {
    realCandidate = await realpath(candidatePath);
  } catch (error: unknown) {
    return isNotFoundError(error) ? NOT_FOUND : FORBIDDEN;
  }

  if (!isContainedIn(realRoot, realCandidate)) {
    return FORBIDDEN;
  }

  let candidateStats: Stats;
  try {
    candidateStats = await stat(realCandidate);
  } catch (error: unknown) {
    return isNotFoundError(error) ? NOT_FOUND : FORBIDDEN;
  }
  if (!candidateStats.isFile()) {
    // A directory is not an asset, and there is no directory index.
    return NOT_FOUND;
  }

  return {
    outcome: "resolved",
    absolutePath: realCandidate,
    contentType:
      CONTENT_TYPES.get(path.extname(realCandidate).toLowerCase()) ?? FALLBACK_CONTENT_TYPE,
  };
}

/** True when `candidate` is `root` itself or sits beneath it. */
function isContainedIn(root: string, candidate: string): boolean {
  if (candidate === root) {
    return true;
  }
  return candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** True for the `ENOENT` / `ENOTDIR` shapes that mean "no such asset". */
function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

// Registration is one-shot per process by construction. The flag is set BEFORE
// the Electron call so a call that Electron itself rejects (registering after
// `app.ready`) cannot be retried into a second registration — one attempt per
// process, period.
let rendererSchemeRegistered = false;

/**
 * Registers `sidekicks-renderer://` as a privileged scheme.
 *
 * MUST run at module top level in `main/index.ts`, ahead of every
 * `whenReady()` consumer (Plan-023 I-023-11). Throws on a second call: Electron
 * accepts exactly one registration per process, and a silently-swallowed second
 * call would hide a startup-order regression rather than surface it.
 */
export function registerRendererScheme(): void {
  if (rendererSchemeRegistered) {
    throw new Error(
      "registerRendererScheme() was called twice. Electron accepts exactly one " +
        "protocol.registerSchemesAsPrivileged call per process, and it must run " +
        "before app.ready — see apps/desktop/src/main/index.ts for the single call site.",
    );
  }
  rendererSchemeRegistered = true;
  protocol.registerSchemesAsPrivileged([
    {
      scheme: RENDERER_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ]);
}

/** Headers every response carries, refusals included. */
function baseResponseHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": RENDERER_CONTENT_SECURITY_POLICY,
    // Paired with the closed content-type map: an unmapped asset is served as
    // `application/octet-stream`, which only means anything if the browser is
    // forbidden from sniffing a type back out of the bytes.
    "X-Content-Type-Options": "nosniff",
  };
}

/** A refusal: the status, the locked headers, and no body at all. */
function emptyResponse(status: number): Response {
  return new Response(null, { status, headers: baseResponseHeaders() });
}

/**
 * Installs the `sidekicks-renderer://` handler over the built renderer tree.
 *
 * MUST be called inside `app.whenReady()` and BEFORE any `BrowserWindow` is
 * constructed, so no window can load against an unhandled scheme. A second call
 * throws from Electron's own duplicate-handler check, which is the diagnostic
 * we want — this module adds no guard that would mask it.
 */
export function installRendererProtocol(rendererRoot: string): void {
  protocol.handle(
    RENDERER_SCHEME,
    (request: Request): Promise<Response> => handleRendererRequest(rendererRoot, request.url),
  );
}

/**
 * Answers one request. Exported so the response policy — the status codes, the
 * empty refusal bodies, and the locked headers — is asserted directly rather
 * than inferred from `resolveRendererAsset`'s verdict, which carries no body
 * and no header of its own.
 */
export async function handleRendererRequest(rendererRoot: string, url: string): Promise<Response> {
  const resolution = await resolveRendererAsset(rendererRoot, url);
  if (resolution.outcome === "forbidden") {
    return emptyResponse(403);
  }
  if (resolution.outcome === "not-found") {
    return emptyResponse(404);
  }

  let fileResponse: Response;
  try {
    // Streams the body straight through; nothing is buffered in the main
    // process. `net.fetch` over a `file:` URL is the pattern Electron's own
    // `protocol.handle` documentation gives.
    fileResponse = await net.fetch(pathToFileURL(resolution.absolutePath).toString());
  } catch {
    // The asset vanished between the realpath check and the read. Fail closed
    // and stay silent about which path it was.
    return emptyResponse(404);
  }
  if (!fileResponse.ok) {
    return emptyResponse(404);
  }

  return new Response(fileResponse.body, {
    status: 200,
    headers: { ...baseResponseHeaders(), "Content-Type": resolution.contentType },
  });
}
