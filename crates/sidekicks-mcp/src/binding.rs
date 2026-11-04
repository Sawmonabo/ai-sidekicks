//! MCP server bindings: the store of each binding's governance row, the resolver that folds
//! each provider's reading into binding rows and keeps which binding a server name a session
//! reports resolves to, and the set of tool servers a session opens with.

pub mod resolver;
pub mod session_tool_servers;
pub mod store;

/// Builds the arm of `$entry`, a type with one arm per binding scope, for `$binding`, the binding's
/// identity moved into the arm beside the named locals.
macro_rules! binding_arm {
    ($entry:ident, $binding:expr, { $($member:ident),* $(,)? }) => {
        match $binding {
            ::sidekicks_contracts::mcp::server::McpServerBindingRef::User {
                provider,
                server_name,
            } => $entry::User {
                provider,
                server_name,
                $($member,)*
            },
            ::sidekicks_contracts::mcp::server::McpServerBindingRef::Project {
                provider,
                scope_ref,
                place,
                server_name,
            } => $entry::Project {
                provider,
                scope_ref,
                place,
                server_name,
                $($member,)*
            },
            ::sidekicks_contracts::mcp::server::McpServerBindingRef::Local {
                provider,
                scope_ref,
                place,
                server_name,
            } => $entry::Local {
                provider,
                scope_ref,
                place,
                server_name,
                $($member,)*
            },
            ::sidekicks_contracts::mcp::server::McpServerBindingRef::Plugin {
                provider,
                scope_ref,
                server_name,
            } => $entry::Plugin {
                provider,
                scope_ref,
                server_name,
                $($member,)*
            },
            ::sidekicks_contracts::mcp::server::McpServerBindingRef::Connector {
                provider,
                scope_ref,
                server_name,
            } => $entry::Connector {
                provider,
                scope_ref,
                server_name,
                $($member,)*
            },
            ::sidekicks_contracts::mcp::server::McpServerBindingRef::Managed {
                provider,
                server_name,
            } => $entry::Managed {
                provider,
                server_name,
                $($member,)*
            },
        }
    };
}
pub(crate) use binding_arm;
