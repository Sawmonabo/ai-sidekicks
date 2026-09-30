// Golden vectors: Claude control-request subtypes, pinned to Claude Code 2.1.251. Read from the
// schema constructors in the 2.1.245 binary; at 2.1.251 every string below still occurs as a
// literal, which shows none vanished but cannot prove registry membership. Names only: the binary
// holds no request body. When the pin moves, re-read the new binary and re-derive this file;
// never hand-edit a subtype string to make a test pass.

/**
 * The fifteen control-request subtypes the pinned build registers, in registry order, plus
 * `mcp_set_servers` last: not in the registry, it still answered `{"subtype":"success", ...}` at
 * every probed build while a nonexistent subtype was refused.
 */
export const CLAUDE_CONTROL_REQUEST_SUBTYPES: readonly string[] = Object.freeze([
  "interrupt",
  "set_permission_mode",
  "can_use_tool",
  "set_model",
  "get_usage",
  "get_context_usage",
  "get_session_cost",
  "list_models",
  "get_binary_version",
  "apply_flag_settings",
  "rewind_files",
  "hook_callback",
  "elicitation",
  "request_user_dialog",
  "mcp_message",
  "mcp_set_servers",
] as const);

/**
 * Three control subtypes the 2.1.245 registry does not hold. Absence proves nothing about
 * capability; it means no probe answer is recorded, so no row exists for them.
 */
export const CLAUDE_CONTROL_REQUEST_SUBTYPES_ABSENT_AT_PIN: readonly string[] = Object.freeze([
  "set_effort",
  "rewind",
  "compact",
] as const);
