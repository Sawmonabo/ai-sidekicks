//! What one working server of a session offers to attach: the list its provider read for the
//! daemon, or how the daemon reaches the server to read the list itself. A reach holds the
//! server's values, so it lives only in memory, and its `Debug` prints none of them.

use std::fmt;
use std::path::PathBuf;

use serde::Deserialize;
use serde_json::Value;
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::session::controls::methods::SessionMcpResource;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::ComposedText;

use crate::driver::mcp_server::read::McpServerSignInClient;

/// Where a session's server's resources come from, as its driver answers.
#[derive(Clone, Debug, PartialEq)]
pub enum McpResourceSource {
    /// The provider listed them itself.
    Listed {
        /// The resources it listed.
        resources: Vec<SessionMcpResource>,
        /// Whether every page was read; `false` where a page cap stopped the read.
        complete: bool,
    },
    /// The daemon reads them itself, reaching the server as the provider does.
    Reach {
        /// The binding the session serves the server from.
        binding: McpServerBindingRef,
        /// How the server is reached.
        reach: McpServerReach,
    },
    /// The provider holds the server's sign-in or makes its credentials itself, which the daemon
    /// never reads, so the daemon cannot reach it.
    SignedInByProvider,
}

/// How the daemon reaches a server as its provider would. It holds values, so its `Debug` prints
/// only which kind of reach it is.
#[derive(Clone, PartialEq)]
pub enum McpServerReach {
    /// A program the daemon starts and talks to over its standard input and output.
    Stdio {
        /// The program, as the server's entry names it.
        program: String,
        /// Its arguments.
        arguments: Vec<String>,
        /// The whole environment the provider starts it in, the entry's own values over the
        /// provider's process's.
        environment: Vec<(String, String)>,
        /// The folder it starts in.
        working_folder: Option<PathBuf>,
    },
    /// A server at an address.
    Address {
        /// The address.
        address: McpServerAddress,
        /// The headers each request carries, values included.
        headers: Vec<(String, String)>,
        /// The sign-in client the declaration names, where the daemon signs in for it.
        sign_in: Option<McpServerSignInClient>,
    },
}

impl fmt::Debug for McpServerReach {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Stdio { .. } => formatter.write_str("McpServerReach::Stdio(..)"),
            Self::Address { .. } => formatter.write_str("McpServerReach::Address(..)"),
        }
    }
}

// One resource as MCP's `Resource` writes it; members the list does not show are ignored.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListedResource {
    uri: String,
    name: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    mime_type: Option<String>,
    #[serde(default)]
    size: Option<u64>,
}

/// `resource`, one resource as MCP's `Resource` writes it, as the attachment list shows it;
/// `None` for one that does not read as a resource or whose address or name is blank, which the
/// list leaves out. A blank title, description or media type, or a size past the safe integers,
/// is left off alone.
pub fn read_listed_mcp_resource(resource: Value) -> Option<SessionMcpResource> {
    let listed: ListedResource = serde_json::from_value(resource).ok()?;
    Some(SessionMcpResource {
        uri: ComposedText::new(listed.uri)?,
        name: ComposedText::new(listed.name)?,
        title: listed.title.and_then(ComposedText::new),
        description: listed.description.and_then(ComposedText::new),
        mime_type: listed.mime_type.and_then(ComposedText::new),
        size: listed.size.and_then(SafeInt::new),
    })
}
