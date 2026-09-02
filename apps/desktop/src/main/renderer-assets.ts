// Renderer-asset resolution: one pure function and its containment matrix.
//
// Plan-023 Phase 1B (T-023p-1B-1). Split out of `./protocol.ts` so every
// containment arm is unit-testable with no Electron import anywhere in its
// dependency graph — this module reaches only `node:*` and the scheme
// constants, and performs no Electron call of any kind.
//
// The failure matrix, enumerated in `renderer-assets.test.ts` and summarised
// here:
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
// Both refusals carry NO member beyond the verdict, so a probe learns nothing
// about the tree. There is deliberately no `index.html` fallback: the console
// routes by hash, so every navigable URL is `index.html` plus a fragment and a
// fallback would only turn typos into a served shell.

import type { Stats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { RENDERER_HOST, RENDERER_SCHEME } from "./renderer-scheme.js";

// A CLOSED extension map. An unmapped extension answers `application/octet-stream`
// rather than being sniffed — which is only meaningful paired with the
// `X-Content-Type-Options: nosniff` header `./protocol.ts` attaches to every
// response, since without it Chromium would content-sniff the octet-stream body
// and could execute it. The map and that header are one decision split across
// two modules, so neither may be changed without the other.
//
// `.map` is deliberately ABSENT rather than mapped: source maps are refused
// outright by the guard below, so giving them a content type would describe a
// response no caller can ever ask for.
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

/** The source-map suffix this resolver refuses, matched case-insensitively. */
const SOURCE_MAP_SUFFIX = ".map";

/**
 * Whether a request targets a source map, and therefore resolves `not-found`
 * unconditionally — which `./protocol.ts` answers as an empty-bodied 404.
 *
 * The build emits hidden source maps for the Sentry upload; they are not
 * shipped, and Phase 5's `electron-builder` `files` filter excludes
 * `out/**\/*.map` from the package. But a developer tree has them sitting
 * beside the bundle, so "not packaged" is not the same as "not reachable" —
 * without this the resolver would happily admit the renderer's full original
 * sources to anything that could reach the scheme. Refusing here, above every
 * filesystem call, makes the guarantee hold in every tree rather than only in a
 * packaged one.
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
