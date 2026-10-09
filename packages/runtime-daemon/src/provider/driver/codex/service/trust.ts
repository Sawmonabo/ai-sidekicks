// Trusting the daemon's own hooks on a service it started: Codex runs a command hook only once its
// hash is recorded as trusted, so before any conversation starts, forks or resumes the daemon
// reads each hook's key and hash and writes them to the home's hook state.

import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";
import { CodexTransportError } from "../session/errors.js";
import type { CodexHookCommands } from "./command-line.js";

/** The one call trust needs from a service connection. */
type CodexServiceRequest = (method: string, params: unknown) => Promise<unknown>;

/** The hooks a service's command line set, as `hooks/list` names their source. */
const CODEX_SESSION_FLAGS_HOOK_SOURCE = "sessionFlags";

interface ListedHook {
  readonly key: string;
  readonly currentHash: string;
  readonly trustStatus: string | undefined;
}

/**
 * Records the trusted hash of each daemon hook the service lists, in one upsert. Throws
 * `CodexTransportError` when the service does not list a daemon hook with its key and hash, since
 * an untrusted hook never runs.
 */
export async function trustCodexDaemonHooks(
  request: CodexServiceRequest,
  hookCommands: CodexHookCommands,
): Promise<void> {
  const listed = readSessionFlagHooks(await request("hooks/list", {}));
  const trustedHashes: Record<string, { trusted_hash: string }> = {};
  for (const command of [hookCommands.preToolUse, hookCommands.postToolUse]) {
    const hook = listed.get(command);
    if (hook === undefined) {
      throw new CodexTransportError(
        "The Codex service does not list a hook the daemon started it with, so it cannot be " +
          "trusted and would never run.",
        { method: "hooks/list" },
      );
    }
    if (hook.trustStatus !== "trusted") {
      trustedHashes[hook.key] = { trusted_hash: hook.currentHash };
    }
  }
  if (Object.keys(trustedHashes).length === 0) {
    return;
  }
  await request("config/value/write", {
    keyPath: "hooks.state",
    value: trustedHashes,
    mergeStrategy: "upsert",
  });
}

/** The command-line hooks a `hooks/list` reply names, by command. */
function readSessionFlagHooks(reply: unknown): Map<string, ListedHook> {
  const hooksByCommand = new Map<string, ListedHook>();
  const groups = isPlainObject(reply) ? reply["data"] : undefined;
  for (const group of Array.isArray(groups) ? groups : []) {
    const hooks = isPlainObject(group) ? group["hooks"] : undefined;
    for (const hook of Array.isArray(hooks) ? hooks : []) {
      if (!isPlainObject(hook) || hook["source"] !== CODEX_SESSION_FLAGS_HOOK_SOURCE) {
        continue;
      }
      const command = readNonEmptyString(hook, "command");
      const key = readNonEmptyString(hook, "key");
      const currentHash = readNonEmptyString(hook, "currentHash");
      if (command === undefined || key === undefined || currentHash === undefined) {
        continue;
      }
      hooksByCommand.set(command, {
        key,
        currentHash,
        trustStatus: readNonEmptyString(hook, "trustStatus"),
      });
    }
  }
  return hooksByCommand;
}
