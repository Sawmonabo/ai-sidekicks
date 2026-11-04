//! MCP server bindings: the store of each binding's governance row, the resolver that folds
//! each provider's reading into binding rows and keeps which binding a server name a session
//! reports resolves to, and the set of tool servers a session opens with.

pub mod resolver;
pub mod session_tool_servers;
pub mod store;
