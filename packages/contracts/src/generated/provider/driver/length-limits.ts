// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Caps on what a provider sends, in code points. A value past its cap is refused, never cut, so unbounded provider output stays out of the daemon's tables.

/**
 * The longest tool name, shared by a declared tool and a callback tool invocation, so a name
 * that resolves against a declaration always fits.
 */
export const PROVIDER_TOOL_NAME_MAX_LEN = 128 as const;

/**
 * The longest tool description; generous because a tool server's description can embed its
 * parameters' docs past 8 KiB.
 */
export const PROVIDER_TOOL_DESCRIPTION_MAX_LEN = 16384 as const;

/** The longest `fallbackAction` on an intervention's or a fork move's result. */
export const PROVIDER_FALLBACK_ACTION_MAX_LEN = 128 as const;

/** The longest runtime binding id, minted by the daemon's store or by a relaunching driver. */
export const PROVIDER_BINDING_ID_MAX_LEN = 256 as const;

/**
 * The longest resume `providerFailureDetail`; generous because it may wrap an upstream stack
 * trace, and a refusal would lose that signal.
 */
export const PROVIDER_FAILURE_DETAIL_MAX_LEN = 32768 as const;

/** The longest tool server name in a status emission. */
export const PROVIDER_MCP_SERVER_NAME_MAX_LEN = 128 as const;

/** The longest provider command name. */
export const PROVIDER_COMMAND_NAME_MAX_LEN = 128 as const;

/**
 * The longest provider command description; generous because a skill's front matter carries
 * usage prose, and an overlong value drops the whole entry.
 */
export const PROVIDER_COMMAND_DESCRIPTION_MAX_LEN = 16384 as const;

/**
 * The longest short word a provider declares and the wire carries as sent: a command's scope,
 * an output speed's level.
 */
export const PROVIDER_DECLARED_TOKEN_MAX_LEN = 128 as const;

/**
 * The longest reason a provider gives for its output speed; a refusal loses only the
 * explanation.
 */
export const PROVIDER_OUTPUT_SPEED_REASON_MAX_LEN = 512 as const;
