// The Electron seam for the renderer bundle: registers the scheme, installs the handler, and
// decides the response policy (status codes, empty refusal bodies, locked headers). Its
// inputs live in modules that do not import `electron`: `./scheme.ts` (identity and
// CSP), `./assets.ts` (containment and resolution) and
// `../../windows/load-failure/document.ts` (the generated failure document).
//
// Two entry points, so the startup order is assertable (`index.test.ts`): the scheme's one
// registration (`registerRendererScheme`, called by `main/index.ts`) at module top level, ahead of
// every `whenReady()` consumer, and `installRendererProtocol` inside `whenReady()` before any
// window exists.
//
// The bundle is served over this scheme, never `file://`, because the app's fuses disable
// `GrantFileProtocolExtraPrivileges`. Bodies stream through `net.fetch` over a `file:` URL, the
// pattern Electron's `protocol.handle` documentation gives, so no response is buffered in
// main-process memory. The one exception is the console document, `index.html`, read whole so the
// appearance record, and the safe-start mark on a load after repeated renderer crashes, can be
// stamped on its root element (`./root-stamp.ts`). A tree main cannot read, or an asset whose read
// fails, answers the page with an empty refusal and is written to main's log, which never reaches
// the page.

import { net, protocol } from "electron";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  matchLoadFailureRequest,
  renderLoadFailureDocument,
} from "../../windows/load-failure/document.js";
import type { MainDiagnosticLog } from "../diagnostic-log.js";
import { describeFailure } from "#shared/failure-message.js";
import { isMissingPath } from "../missing-path.js";
import { resolveRendererAsset } from "./assets.js";
import { stampRootElement, type RootStamp } from "./root-stamp.js";
import { RENDERER_CONTENT_SECURITY_POLICY, RENDERER_INDEX_URL, RENDERER_SCHEME } from "./scheme.js";

/** The console document's file, at the built tree's root. */
const CONSOLE_DOCUMENT_FILE = new URL(RENDERER_INDEX_URL).pathname.slice(1);

/** Where a tree or an asset main could not read is recorded. */
type RendererServingLog = Pick<MainDiagnosticLog, "write">;

const LOG_SOURCE = "main/services/renderer";

/**
 * Registers `sidekicks-renderer://` as privileged, which Electron takes once per process and only
 * before `app.ready`. Call once, at module top level in `main/index.ts`, ahead of every
 * `whenReady()` consumer.
 */
export function registerRendererScheme(): void {
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
 * is served, so it reports the record and the start kind in force then; a read that fails is
 * written to `log`. A second call throws from Electron's duplicate-handler check; this module adds
 * no guard that would mask it.
 */
export function installRendererProtocol(
  rendererRoot: string,
  rootStamp: RootStamp,
  log: RendererServingLog,
): void {
  protocol.handle(
    RENDERER_SCHEME,
    (request: Request): Promise<Response> =>
      handleRendererRequest(rendererRoot, request.url, rootStamp, log),
  );
}

/**
 * Answers one request. Exported so the response policy (status codes, empty refusal bodies,
 * locked headers) is asserted directly, since `resolveRendererAsset`'s verdict carries no body
 * or header. A tree or an asset that could not be read is written to `log` and answered with an
 * empty refusal naming no path.
 */
export async function handleRendererRequest(
  rendererRoot: string,
  url: string,
  rootStamp: RootStamp,
  log: RendererServingLog,
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
  if (resolution.outcome === "unreadable") {
    log.write({
      level: "error",
      source: LOG_SOURCE,
      message:
        `the renderer tree could not be read for ${url}: ` + describeFailure(resolution.failure),
    });
    return emptyResponse(403);
  }

  let fileResponse: Response;
  try {
    // Streams the body straight through; nothing is buffered in the main process.
    fileResponse = await net.fetch(pathToFileURL(resolution.absolutePath).toString());
  } catch (failure) {
    log.write({
      level: "error",
      source: LOG_SOURCE,
      message: `the renderer asset ${url} could not be read: ${describeFailure(failure)}`,
    });
    return emptyResponse(404);
  }
  if (!fileResponse.ok) {
    log.write({
      level: "error",
      source: LOG_SOURCE,
      message: `the renderer asset ${url} was read with status ${String(fileResponse.status)}`,
    });
    return emptyResponse(404);
  }

  // Only an HTML file can be the console document, so no other asset pays for the comparison.
  if (
    path.extname(resolution.absolutePath) === ".html" &&
    (await isConsoleDocument(rendererRoot, resolution.absolutePath))
  ) {
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
