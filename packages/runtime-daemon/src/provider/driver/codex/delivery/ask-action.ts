// What a Codex approval would let run, read from its method and params, and the scopes a rule on
// it may take. A command or a host takes a rule for the session, as `acceptForSession`, where Codex
// offers that answer, and then one for the project too, in the project's rule file; a change to
// one file takes the session's alone, since Codex keeps no project rule on a file; input to a
// running command, a permissions grant and a tool server's call Codex keeps for the session only
// where it says so. A command is read as the whole line it runs, the one its `<shell> -lc '…'`
// wrapper hands the shell. A tool server's call is named as Codex's pre-tool hook names it,
// `mcp__<server>__<tool>`.

import type { RememberedScopeKind } from "@ai-sidekicks/contracts/approval";
import { parse } from "unbash";

import { joinShellWords, unwrapShellCommandLine } from "../../../../policy/shell-commands.js";
import { composeToolServerToolName } from "../../../mcp/tool-name.js";
import type { ProviderAskAction } from "../../../port/permission-ask.js";
import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";

const COMMAND_APPROVAL_METHODS: ReadonlySet<string> = new Set([
  "item/commandExecution/requestApproval",
  "execCommandApproval",
]);

const FILE_CHANGE_APPROVAL_METHODS: ReadonlySet<string> = new Set([
  "item/fileChange/requestApproval",
  "applyPatchApproval",
]);

// The answer that keeps an allow for the rest of the conversation, on a command's ask.
const CODEX_SESSION_DECISION = "acceptForSession";

// A tool server's approval names the scopes it keeps an allow for in `_meta.persist`.
const CODEX_PERSIST_SESSION = "session";

/** What a held Codex approval would do, and the scopes a rule on it may take. */
export interface CodexAskReading {
  readonly action: ProviderAskAction;
  readonly ruleScopes: readonly RememberedScopeKind[];
}

/**
 * Reads one approval. `changedPaths` are the files the change item the ask names will touch, read
 * from that item's start, since a change's ask names no file itself.
 */
export function readCodexAskAction(
  method: string,
  params: Readonly<Record<string, unknown>>,
  changedPaths: readonly string[] | undefined,
): CodexAskReading {
  if (COMMAND_APPROVAL_METHODS.has(method)) {
    return readCommandAsk(params);
  }
  if (FILE_CHANGE_APPROVAL_METHODS.has(method)) {
    const paths =
      changedPaths ??
      (isPlainObject(params["fileChanges"]) ? Object.keys(params["fileChanges"]) : []);
    return {
      action: { kind: "file_change", paths },
      ruleScopes: paths.length === 1 ? ["session"] : [],
    };
  }
  if (method === "mcpServer/elicitation/request") {
    const meta = isPlainObject(params["_meta"]) ? params["_meta"] : {};
    const persist = meta["persist"];
    const keepsForSession =
      persist === CODEX_PERSIST_SESSION ||
      (Array.isArray(persist) && persist.includes(CODEX_PERSIST_SESSION));
    const serverName = readNonEmptyString(params, "serverName");
    const serverToolName = readNonEmptyString(meta, "tool_name");
    return {
      action: {
        kind: "tool",
        toolName:
          serverName !== undefined && serverToolName !== undefined
            ? composeToolServerToolName(serverName, serverToolName)
            : (serverName ?? method),
      },
      ruleScopes: keepsForSession ? ["session"] : [],
    };
  }
  return { action: { kind: "tool", toolName: method }, ruleScopes: [] };
}

function readCommandAsk(params: Readonly<Record<string, unknown>>): CodexAskReading {
  if (params["kind"] === "writeStdin") {
    const written = typeof params["command"] === "string" ? params["command"] : "";
    return { action: { kind: "command_input", input: readWrittenInput(written) }, ruleScopes: [] };
  }
  // Never the rule words Codex proposes, which may name one command of several or a prefix.
  const command = readCommandText(params["command"]);
  const decisions = params["availableDecisions"];
  // A server that lists no answers offers its whole set, `acceptForSession` among them.
  const keepsForSession = !Array.isArray(decisions) || decisions.includes(CODEX_SESSION_DECISION);
  const ruleScopes: readonly RememberedScopeKind[] = keepsForSession ? ["session", "project"] : [];
  const network = params["networkApprovalContext"];
  const host = isPlainObject(network) ? readNonEmptyString(network, "host") : undefined;
  if (host !== undefined) {
    return { action: { kind: "network", host }, ruleScopes };
  }
  return { action: { kind: "command", command }, ruleScopes };
}

// The modern ask names its command as one line, the legacy one as its words; either is read
// through the shell wrapper Codex runs it in.
function readCommandText(command: unknown): string {
  return unwrapShellCommandLine(
    typeof command === "string" ? command : joinShellWords(readWords(command)),
  );
}

function readWords(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((word): word is string => typeof word === "string")
    : [];
}

// An input ask's command is `write_stdin --session-id <n> <input>`, shell-quoted: its last word is
// the input.
function readWrittenInput(command: string): string {
  const simple = parse(command).commands[0]?.command;
  const last = simple?.type === "Command" ? simple.args.at(-1) : undefined;
  return last?.type === "Word" ? last.value : "";
}
