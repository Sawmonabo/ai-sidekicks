// The Electron seam for the renderer bundle: registers the scheme, installs the handler, and
// decides the response policy (status codes, empty refusal bodies, locked headers). Its
// inputs live in modules that do not import `electron`: `./scheme.ts` (identity and
// CSP), `./assets.ts` (containment and resolution) and
// `../../windows/load-failure/document.ts` (the generated failure document).
//
// Two entry points, so the startup order is assertable (`index.test.ts`): the scheme's one
// registration (`RendererSchemeRegistration`, held by `main/index.ts`) at module top level, ahead
// of every `whenReady()` consumer, and `installRendererProtocol(rendererRoot, rootStamp)` inside
// `whenReady()` before any window exists.
//
// The bundle is served over this scheme, never `file://`, because the hardening baseline
// disables the `GrantFileProtocolExtraPrivileges` fuse. Bodies stream through `net.fetch`
// over a `file:` URL, the pattern Electron's `protocol.handle` documentation gives, so no
// response is buffered in main-process memory. The one exception is the console document,
// `index.html`, read whole so the appearance record, and the safe-start mark on a load after
// repeated renderer crashes, can be stamped on its root element (`../root-stamp.ts`).

import { net, protocol } from "electron";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  matchLoadFailureRequest,
  renderLoadFailureDocument,
} from "../../windows/load-failure/document.js";
import { resolveRendererAsset } from "./assets.js";
import { RENDERER_CONTENT_SECURITY_POLICY, RENDERER_INDEX_URL, RENDERER_SCHEME } from "./scheme.js";
import { isMissingPath } from "../missing-path.js";
import { stampRootElement, type RootStamp } from "../root-stamp.js";

/** The console document's file, at the built tree's root. */
const CONSOLE_DOCUMENT_FILE = new URL(RENDERER_INDEX_URL).pathname.slice(1);

/**
 * The privileged registration of `sidekicks-renderer://`, which Electron takes once per process
 * and only before `app.ready`. `main/index.ts` holds the one instance.
 */
export class RendererSchemeRegistration {
  #isRegistered = false;

  /**
   * Registers the scheme. Must run at module top level in `main/index.ts`, ahead of every
   * `whenReady()` consumer. Throws on a second call, which would otherwise hide a startup-order
   * regression.
   */
  public register(): void {
    if (this.#isRegistered) {
      throw new Error(
        "The renderer scheme was registered twice. Electron accepts exactly one " +
          "protocol.registerSchemesAsPrivileged call per process, and it must run " +
          "before app.ready.",
      );
    }
    // Set before the Electron call, so a call Electron rejects is never retried into a second.
    this.#isRegistered = true;
    protocol.registerSchemesAsPrivileged([
      {
        scheme: RENDERER_SCHEME,
        privileges: { standard: true, secure: true, supportFetchAPI: true },
      },
    ]);
  }
}

/** Headers every response carries, refusals included. */
function baseResponseHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": RENDERER_CONTENT_SECURITY_POLICY,
    // Paired with the closed content-type map in `./assets.ts`: an unmapped asset is
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
 * `app.whenReady()` before any window exists. `rootStamp` is read each time the console document
 * is served, so it reports the record and the start kind in force then. A second call throws from
 * Electron's duplicate-handler check; this module adds no guard that would mask it.
 */
export function installRendererProtocol(rendererRoot: string, rootStamp: RootStamp): void {
  protocol.handle(
    RENDERER_SCHEME,
    (request: Request): Promise<Response> =>
      handleRendererRequest(rendererRoot, request.url, rootStamp),
  );
}

/**
 * Answers one request. Exported so the response policy (status codes, empty refusal bodies,
 * locked headers) is asserted directly, since `resolveRendererAsset`'s verdict carries no body
 * or header.
 */
export async function handleRendererRequest(
  rendererRoot: string,
  url: string,
  rootStamp: RootStamp,
): Promise<Response> {
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

  if (await isConsoleDocument(rendererRoot, resolution.absolutePath)) {
    return new Response(stampRootElement(await fileResponse.text(), rootStamp), {
      status: 200,
      headers: { ...baseResponseHeaders(), "Content-Type": resolution.contentType },
    });
  }

  return new Response(fileResponse.body, {
    status: 200,
    headers: { ...baseResponseHeaders(), "Content-Type": resolution.contentType },
  });
}

// By the file a request resolved to, so every spelling of it, `/%69ndex.html` among them, is
// stamped. A tree with no console document serves none.
async function isConsoleDocument(rendererRoot: string, absolutePath: string): Promise<boolean> {
  try {
    return absolutePath === (await realpath(path.join(rendererRoot, CONSOLE_DOCUMENT_FILE)));
  } catch (error: unknown) {
    if (isMissingPath(error)) {
      return false;
    }
    throw error;
  }
}
