// The commands a conversation left running, and ending them. An interrupt stops the turn but not
// its commands, and a command outlives its turn until it exits, so the daemon ends them itself on
// an interrupt and at a session's close, and reads them before it lets go of a conversation.

import type { CodexService } from "../service/supervisor.js";
import { isPlainObject } from "../../../record-readers.js";
import {
  type CodexDiagnosticSink,
  reportDiagnosticFromDetachedFrame,
} from "../transport/diagnostics.js";
import { normalizeProviderFailureDetail } from "./errors.js";

/**
 * Terminates every command `threadId` still runs; with `clean`, also has Codex drop their
 * records, as a close does. A step that fails is reported and the rest still run, since the
 * caller's own outcome must stand.
 */
export async function endCodexRunningCommands(
  service: Pick<CodexService, "request">,
  threadId: string,
  reportDiagnostic: CodexDiagnosticSink,
  options: { readonly clean: boolean },
): Promise<void> {
  let processIds: (string | number)[] = [];
  try {
    processIds = await listCodexRunningCommands(service, threadId);
  } catch (cause) {
    reportStepFailed(reportDiagnostic, "background-terminal-terminate", cause);
  }
  for (const processId of processIds) {
    try {
      await service.request("thread/backgroundTerminals/terminate", { threadId, processId });
    } catch (cause) {
      reportStepFailed(reportDiagnostic, "background-terminal-terminate", cause);
    }
  }
  if (!options.clean) {
    return;
  }
  try {
    await service.request("thread/backgroundTerminals/clean", { threadId });
  } catch (cause) {
    reportStepFailed(reportDiagnostic, "background-terminal-clean", cause);
  }
}

/**
 * The process id of every command `threadId` still runs, each passed back exactly as
 * `thread/backgroundTerminals/list` gave it, read page by page. Throws as a page's request throws.
 */
export async function listCodexRunningCommands(
  service: Pick<CodexService, "request">,
  threadId: string,
): Promise<(string | number)[]> {
  const processIds: (string | number)[] = [];
  let cursor: string | null = null;
  do {
    const page = await service.request("thread/backgroundTerminals/list", {
      threadId,
      ...(cursor === null ? {} : { cursor }),
    });
    const entries = isPlainObject(page) && Array.isArray(page["data"]) ? page["data"] : [];
    for (const entry of entries) {
      const processId = isPlainObject(entry) ? entry["processId"] : undefined;
      // Passed back exactly as listed: terminate names a command by the same value.
      const isListed =
        (typeof processId === "string" && processId.length > 0) || typeof processId === "number";
      if (isListed) {
        processIds.push(processId);
      }
    }
    const nextCursor = isPlainObject(page) ? page["nextCursor"] : null;
    cursor = typeof nextCursor === "string" && nextCursor.length > 0 ? nextCursor : null;
  } while (cursor !== null);
  return processIds;
}

function reportStepFailed(
  reportDiagnostic: CodexDiagnosticSink,
  step: "background-terminal-terminate" | "background-terminal-clean",
  cause: unknown,
): void {
  reportDiagnosticFromDetachedFrame(reportDiagnostic, {
    kind: "teardown-step-failed",
    step,
    detail: normalizeProviderFailureDetail(cause),
  });
}
