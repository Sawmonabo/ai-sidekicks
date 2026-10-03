// The Electron seam for the renderer bundle: registers the scheme, installs the handler, and
// decides the response policy (status codes, empty refusal bodies, locked headers). Its
// inputs live in modules that do not import `electron`: `./renderer-scheme.ts` (identity and
// CSP), `./renderer-assets.ts` (containment and resolution) and
// `../windows/load-failure-document.ts` (the generated failure document).
//
// Two entry points, so the startup order is assertable (`startup-order.test.ts`):
// `registerRendererScheme()` at module top level in `main/index.ts`, ahead of every
// `whenReady()` consumer, and `installRendererProtocol(rendererRoot)` inside `whenReady()`
// before any window exists.
//
// The bundle is served over this scheme, never `file://`, because the hardening baseline
// disables the `GrantFileProtocolExtraPrivileges` fuse. Bodies stream through `net.fetch`
// over a `file:` URL, the pattern Electron's `protocol.handle` documentation gives, so no
// response is buffered in main-process memory.

import { net, protocol } from "electron";
import { pathToFileURL } from "node:url";

import {
  matchLoadFailureRequest,
  renderLoadFailureDocument,
} from "../windows/load-failure-document.js";
import { resolveRendererAsset } from "./renderer-assets.js";
import { RENDERER_CONTENT_SECURITY_POLICY, RENDERER_SCHEME } from "./renderer-scheme.js";

// Module-scoped on purpose: it mirrors a process-global Electron constraint (one
// `registerSchemesAsPrivileged` call per process, before `app.ready`). Set before the Electron
// call so a call Electron rejects cannot be retried into a second registration.
let rendererSchemeRegistered = false;

/**
 * Registers `sidekicks-renderer://` as a privileged scheme. Must run at module top level in
 * `main/index.ts`, ahead of every `whenReady()` consumer. Throws on a second call, which
 * would otherwise hide a startup-order regression.
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
    // Paired with the closed content-type map in `./renderer-assets.ts`: an unmapped asset is
    // served as `application/octet-stream`, which needs sniffing forbidden.
    "X-Content-Type-Options": "nosniff",
  };
}

/** A refusal: the status, the locked headers, and no body at all. */
function emptyResponse(status: number): Response {
  return new Response(null, { status, headers: baseResponseHeaders() });
}

/**
 * Installs the `sidekicks-renderer://` handler over the built renderer tree. Call inside
 * `app.whenReady()` before any `BrowserWindow` exists. A second call throws from Electron's
 * duplicate-handler check; this module adds no guard that would mask it.
 */
export function installRendererProtocol(rendererRoot: string): void {
  protocol.handle(
    RENDERER_SCHEME,
    (request: Request): Promise<Response> => handleRendererRequest(rendererRoot, request.url),
  );
}

/**
 * Answers one request. Exported so the response policy (status codes, empty refusal bodies,
 * locked headers) is asserted directly, since `resolveRendererAsset`'s verdict carries no body
 * or header.
 */
export async function handleRendererRequest(rendererRoot: string, url: string): Promise<Response> {
  // First and without touching the file system: this document exists to be servable when the
  // tree is not.
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
    // Streams the body straight through; nothing is buffered in the main process.
    fileResponse = await net.fetch(pathToFileURL(resolution.absolutePath).toString());
  } catch {
    // The asset vanished between the realpath check and the read. Fail closed, naming no path.
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
