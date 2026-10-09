// Length limits on provider output, applied through `wireFreeFormString`, which refuses an over-max
// value and never truncates; they keep unbounded provider output out of the daemon's tables.

/**
 * Max length of a tool name, shared by `ProviderToolMetadata.name` and
 * `CallbackToolInvocation.toolName` so a name that resolves against a declaration always fits.
 */
export const DRIVER_TOOL_NAME_MAX_LEN = 128;
/**
 * Max length of a tool description; generous because MCP-style descriptions can embed
 * parameter-schema docs beyond 8 KiB and an overlong value is rejected, not truncated.
 */
export const DRIVER_TOOL_DESCRIPTION_MAX_LEN = 16384;
/** Max length of `fallbackAction` on `DriverInterventionResult` and `MoveSessionToForkResult`. */
export const DRIVER_FALLBACK_ACTION_MAX_LEN = 128;
/** Max length of a store-minted `bindingId`, such as the one on the resume result. */
export const DRIVER_BINDING_ID_MAX_LEN = 256;
/**
 * Max length of a resume `providerFailureDetail`; generous because it may wrap an upstream stack
 * trace or nested-cause chain, and a rejection would lose that signal.
 */
export const DRIVER_FAILURE_DETAIL_MAX_LEN = 32768;
/** Max length of `McpServerStatusEmission.serverName`. */
export const DRIVER_MCP_SERVER_NAME_MAX_LEN = 128;
/** Max length of `ProviderCommandEntry.name`. */
export const DRIVER_PROVIDER_COMMAND_NAME_MAX_LEN = 128;
/**
 * Max length of `ProviderCommandEntry.description`; generous because a skill's front matter
 * routinely carries usage prose, and an overlong value drops the whole entry.
 */
export const DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN = 16384;
/**
 * Max length of a short provider-declared vocabulary token carried verbatim
 * (`ProviderCommandEntry.scope`, `ProviderOutputSpeedState.declared`).
 */
export const DRIVER_PROVIDER_DECLARED_TOKEN_MAX_LEN = 128;
/** Max length of `ProviderOutputSpeedState.reason`; a rejection loses only the explanation. */
export const DRIVER_OUTPUT_SPEED_REASON_MAX_LEN = 512;
