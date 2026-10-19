//! Caps on what a provider sends, in code points. A value past its cap is refused, never cut, so
//! unbounded provider output stays out of the daemon's tables.

use crate::typescript::{TypeScriptModule, ts_constants};

ts_constants! {
    /// The longest tool name, shared by a declared tool and a callback tool invocation, so a name
    /// that resolves against a declaration always fits.
    pub const PROVIDER_TOOL_NAME_MAX_LEN: usize = 128;
    /// The longest tool description; generous because a tool server's description can embed its
    /// parameters' docs past 8 KiB.
    pub const PROVIDER_TOOL_DESCRIPTION_MAX_LEN: usize = 16384;
    /// The longest `fallbackAction` on an intervention's or a fork move's result.
    pub const PROVIDER_FALLBACK_ACTION_MAX_LEN: usize = 128;
    /// The longest runtime binding id, minted by the daemon's store or by a relaunching driver.
    pub const PROVIDER_BINDING_ID_MAX_LEN: usize = 256;
    /// The longest resume `providerFailureDetail`; generous because it may wrap an upstream stack
    /// trace, and a refusal would lose that signal.
    pub const PROVIDER_FAILURE_DETAIL_MAX_LEN: usize = 32768;
    /// The longest tool server name in a status emission.
    pub const PROVIDER_MCP_SERVER_NAME_MAX_LEN: usize = 128;
    /// The longest provider command name.
    pub const PROVIDER_COMMAND_NAME_MAX_LEN: usize = 128;
    /// The longest provider command description; generous because a skill's front matter carries
    /// usage prose, and an overlong value drops the whole entry.
    pub const PROVIDER_COMMAND_DESCRIPTION_MAX_LEN: usize = 16384;
    /// The longest short word a provider declares and the wire carries as sent: a command's scope,
    /// an output speed's level.
    pub const PROVIDER_DECLARED_TOKEN_MAX_LEN: usize = 128;
    /// The longest reason a provider gives for its output speed; a refusal loses only the
    /// explanation.
    pub const PROVIDER_OUTPUT_SPEED_REASON_MAX_LEN: usize = 512;
}

/// The TypeScript module of the caps on provider output.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/driver/length-limits",
    doc: "Caps on what a provider sends, in code points. A value past its cap is refused, never \
          cut, so unbounded provider output stays out of the daemon's tables.",
    definitions: &[],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
