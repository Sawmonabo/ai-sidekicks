// Renderer scheme registration and the built-bundle protocol handler.
//
// Plan-023 Phase 1B (T-023p-1B-1). This module is the ELECTRON seam and nothing
// else: it registers the scheme, installs the handler, and decides the response
// policy — the status codes, the empty refusal bodies, and the locked headers.
// The three things it answers with live in their own modules, none of which
// imports `electron`:
//
//   • `./renderer-scheme.ts` ..... the scheme's identity and its CSP
//   • `./renderer-assets.ts` ..... containment and resolution over the built tree
//   • `./load-failure-document.ts` the generated failure document
//
// Two exported entry points, so the startup ORDER is asserted rather than
// assumed (`startup-order.test.ts`):
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
// Bodies stream through `net.fetch(pathToFileURL(...))` — the pattern Electron's
// own `protocol.handle` documentation gives — so no response is ever buffered
// into main-process memory.

import { net, protocol } from "electron";
import { pathToFileURL } from "node:url";

import { matchLoadFailureRequest, renderLoadFailureDocument } from "./load-failure-document.js";
import { resolveRendererAsset } from "./renderer-assets.js";
import { RENDERER_CONTENT_SECURITY_POLICY, RENDERER_SCHEME } from "./renderer-scheme.js";

// Registration is one-shot per process by construction, and the latch is
// module-scoped on purpose: it mirrors a PROCESS-global Electron constraint
// (exactly one `registerSchemesAsPrivileged` per process, before `app.ready`),
// so a class instance holding it would be the same module-scoped singleton with
// more ceremony and no additional guarantee. The flag is set BEFORE the Electron
// call so a call that Electron itself rejects (registering after `app.ready`)
// cannot be retried into a second registration — one attempt per process,
// period.
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
    // Paired with the closed content-type map in `./renderer-assets.ts`: an
    // unmapped asset is served as `application/octet-stream`, which only means
    // anything if the browser is forbidden from sniffing a type back out of the
    // bytes.
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
  // Answered FIRST, and without touching the filesystem: this document exists
  // to be servable when the tree is not.
  const loadFailureReason = matchLoadFailureRequest(url);
  if (loadFailureReason !== null) {
    return new Response(renderLoadFailureDocument(loadFailureReason), {
      status: 200,
      headers: { ...baseResponseHeaders(), "Content-Type": "text/html; charset=utf-8" },
    });
  }

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
