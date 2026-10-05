// Renderer-asset resolution: one pure function and its containment matrix, importing nothing
// from Electron so every arm is unit-testable.
//
// The failure matrix (each arm is in `renderer-assets.test.ts`):
//
//   raw `..` segment ............ forbidden   (the URL parser silently collapses `..`, so the
//                                              guard reads the raw path, not `pathname`)
//   `%2e%2e` ................... forbidden   (decode, then re-scan segments)
//   `%2F` / `%2f` .............. forbidden   (an encoded separator is a probe)
//   `%5C` / `%5c` / `\` ........ forbidden   (Windows separator smuggling)
//   `//…` (absolute) ........... forbidden   (one leading slash is stripped, so a second
//                                              leaves an absolute path)
//   `C:/…` (drive-absolute) .... forbidden   (rejected on every platform)
//   symlink leaving the root ... forbidden   (`realpath` on both sides)
//   host other than `app` ...... forbidden
//   NUL / malformed percent .... forbidden
//   miss / directory ........... not-found
//
// Refusals carry no member beyond the verdict, so a probe learns nothing about the tree. There
// is no `index.html` fallback: the app routes by hash, so every navigable URL is
// `index.html` plus a fragment.

import type { Stats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { isMissingPath } from "./missing-path.js";
import { RENDERER_HOST, RENDERER_SCHEME } from "./renderer-scheme.js";

// A closed extension map: an unmapped extension is served as `application/octet-stream`
// rather than sniffed, which only holds together with the `X-Content-Type-Options: nosniff`
// header `./renderer-protocol.ts` attaches to every response; change neither alone. `.map` is
// absent because the guard below refuses source maps.
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
 * Whether a request targets a source map, which resolves `not-found` unconditionally (an
 * empty-body 404 in `./renderer-protocol.ts`). The build emits hidden source maps that sit
 * beside the bundle in a developer tree, and would expose the renderer's original sources.
 * Checked on the raw and the decoded text so `/x%2Emap` cannot slip past, and before any
 * filesystem call.
 */
function isSourceMapRequest(rawPath: string): boolean {
  if (rawPath.toLowerCase().endsWith(SOURCE_MAP_SUFFIX)) {
    return true;
  }
  try {
    return decodeURIComponent(rawPath).toLowerCase().endsWith(SOURCE_MAP_SUFFIX);
  } catch {
    // A malformed escape is refused below anyway; it is not a map.
    return false;
  }
}

/** Content type served for any extension outside the closed map above. */
const FALLBACK_CONTENT_TYPE = "application/octet-stream";

/**
 * The outcome of resolving one `sidekicks-renderer://app/<path>` request against the built
 * tree. The refusal arms carry no other member: a response that echoed the path would tell a
 * probe which paths exist.
 */
export type RendererAssetResolution =
  | { readonly outcome: "resolved"; readonly absolutePath: string; readonly contentType: string }
  | { readonly outcome: "not-found" }
  | { readonly outcome: "forbidden" };

const FORBIDDEN: RendererAssetResolution = { outcome: "forbidden" };
const NOT_FOUND: RendererAssetResolution = { outcome: "not-found" };

/**
 * Extracts the raw (still percent-encoded) path of `url` without letting the WHATWG parser
 * normalize it: `new URL('sidekicks-renderer://app/../etc/passwd').pathname` is `/etc/passwd`,
 * so a guard reading `pathname` would miss the traversal. Returns `null` when the input has no
 * `://` authority separator.
 */
function extractRawPath(url: string): string | null {
  const authorityStart = url.indexOf("://");
  if (authorityStart < 0) {
    return null;
  }
  const afterAuthorityMarker = url.slice(authorityStart + "://".length);
  // The authority ends at the first `/`, `?` or `#`.
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
 * Resolves one renderer-scheme URL to an absolute file inside `rendererRoot`. Pure apart from
 * the file system (no Electron call). Any doubt at any step answers `forbidden` with no path.
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
  // `host` carries the port when one is present, so `app:8080` fails this equality. This
  // scheme has no authentication, so credentials in the authority mark a malformed probe.
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
    // No path at all: a miss, not an escape.
    return NOT_FOUND;
  }

  // Source maps are refused first. 404, not 403: a present map and an absent one must be
  // indistinguishable.
  if (isSourceMapRequest(rawPath)) {
    return NOT_FOUND;
  }

  // Separator smuggling, checked on the still-encoded text: `%2F` and `%5C` survive the URL
  // parser's `pathname`, so a decode-first guard would turn them into real separators.
  if (/%2f/i.test(rawPath) || /%5c/i.test(rawPath) || rawPath.includes("\\")) {
    return FORBIDDEN;
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    // Malformed percent-escape: refuse rather than guess.
    return FORBIDDEN;
  }

  if (decodedPath.includes("\0") || decodedPath.includes("\\")) {
    return FORBIDDEN;
  }
  if (decodedPath.split("/").includes("..")) {
    return FORBIDDEN;
  }

  // Strip exactly the one leading slash the URL grammar guarantees; a second one trips the
  // absolute-path guard below.
  const relativePath = decodedPath.slice(1);
  if (relativePath === "") {
    return NOT_FOUND;
  }
  // `path.isAbsolute` is platform-dependent, so the drive prefix is rejected explicitly.
  if (path.isAbsolute(relativePath) || /^[a-z]:/i.test(relativePath)) {
    return FORBIDDEN;
  }

  const resolvedRoot = path.resolve(rendererRoot);
  const candidatePath = path.resolve(resolvedRoot, relativePath);
  if (!isContainedIn(resolvedRoot, candidatePath)) {
    return FORBIDDEN;
  }

  // Symlink containment. Both sides are realpath'd because the root itself may sit under a
  // symlinked prefix (`/tmp` on macOS is `/private/tmp`). Neither result is cached: the second
  // realpath is one warm-cache syscall against a file read, and a cache would need
  // invalidation.
  let realRoot: string;
  try {
    realRoot = await realpath(resolvedRoot);
  } catch {
    // The built tree is missing or unreadable: a misconfiguration, not a miss.
    return FORBIDDEN;
  }

  let realCandidate: string;
  try {
    realCandidate = await realpath(candidatePath);
  } catch (error: unknown) {
    return isMissingPath(error) ? NOT_FOUND : FORBIDDEN;
  }

  if (!isContainedIn(realRoot, realCandidate)) {
    return FORBIDDEN;
  }

  let candidateStats: Stats;
  try {
    candidateStats = await stat(realCandidate);
  } catch (error: unknown) {
    return isMissingPath(error) ? NOT_FOUND : FORBIDDEN;
  }
  if (!candidateStats.isFile()) {
    // A directory is not an asset; there is no directory index.
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
