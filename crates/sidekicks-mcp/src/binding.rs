//! MCP server bindings: the store of each binding's governance row, and the resolver that folds
//! each provider's reading into binding rows and keeps which binding a server name a session
//! reports resolves to.

pub mod resolver;
pub mod store;
