//! A server's declaration: as the person submits it, values included, and as the daemon reads it
//! back, with every credential-bearing value reduced to its name.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::web_address::WebAddress;
use crate::wire::literal;
use crate::wire::number::PositiveNumber;
use crate::wire::record::Record;
use crate::wire::text::{BoundedText, FreeFormText};

/// The longest command, argument, name, value, address or search text an `mcp.*` request carries.
pub const MCP_REQUEST_TEXT_MAX_LEN: usize = 8192;

/// A command, a name or a search text an `mcp.*` request carries.
pub type McpRequestText = FreeFormText<MCP_REQUEST_TEXT_MAX_LEN>;

/// An argument or a value an `mcp.*` request carries; it may be empty.
pub type McpRequestValue = BoundedText<0, MCP_REQUEST_TEXT_MAX_LEN>;

/// An `http:` or `https:` server address, taken as typed, a user name or password in it included;
/// `http:` is legal because a server may listen on loopback.
pub type McpServerAddress = WebAddress;

/// Whether an address keeps the request text's cap.
pub(crate) fn is_request_address(address: &McpServerAddress, _: &()) -> garde::Result {
    if address
        .as_str()
        .chars()
        .nth(MCP_REQUEST_TEXT_MAX_LEN)
        .is_none()
    {
        Ok(())
    } else {
        Err(garde::Error::new(
            "the address is longer than the request text cap",
        ))
    }
}

/// A submitted map of names to values: an environment, or headers.
pub type McpTextMap = Record<McpRequestText, McpRequestValue>;

/// How a remote server is reached.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum McpRemoteTransport {
    /// Streamable HTTP.
    Http,
    /// Server-sent events.
    Sse,
}

literal! {
    /// The transport of a server the provider starts as a program.
    pub enum McpStdioTransport = "stdio";
}

/// Declares one transport's declaration: the members the caller names, then the settings every
/// transport carries, the same on a submitted declaration and its read-back.
macro_rules! server_config {
    ($(#[doc = $doc:literal])+ pub struct $name:ident { $($members:tt)* }) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[schemars(inline)]
        #[garde(allow_unvalidated)]
        pub struct $name {
            $($members)*
            /// Whether the server is on; unset keeps the provider's value.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "bool")]
            pub enabled: Option<bool>,
            /// Whether a session refuses to start without the server; unset keeps the provider's
            /// value.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "bool")]
            pub required: Option<bool>,
            /// How long the server may take to start, in seconds.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "PositiveNumber")]
            pub startup_timeout_sec: Option<PositiveNumber>,
            /// How long one tool call may take, in seconds.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "PositiveNumber")]
            pub tool_timeout_sec: Option<PositiveNumber>,
        }
    };
}

server_config! {
    /// A program the provider starts, as the person submits it. Environment values are write-only,
    /// handed to the provider's write path and never served back.
    pub struct McpStdioConfigInput {
        /// Always `stdio`.
        pub transport: McpStdioTransport,
        /// The program.
        pub command: McpRequestText,
        /// Its arguments.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Vec<McpRequestValue>")]
        pub args: Option<Vec<McpRequestValue>>,
        /// Its environment, values included.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "McpTextMap")]
        pub env: Option<McpTextMap>,
    }
}

server_config! {
    /// A server reached at an address, as the person submits it. Header values are write-only.
    pub struct McpRemoteConfigInput {
        /// How it is reached.
        pub transport: McpRemoteTransport,
        /// Its address.
        #[garde(custom(is_request_address))]
        #[schemars(extend("maxLength" = MCP_REQUEST_TEXT_MAX_LEN))]
        pub url: McpServerAddress,
        /// Headers sent with each request, values included.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "McpTextMap")]
        pub headers: Option<McpTextMap>,
        /// The environment variable holding a bearer token.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "McpRequestText")]
        pub bearer_token_env_var: Option<McpRequestText>,
        /// A header name mapped to the name of the environment variable holding its value.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "McpTextMap")]
        pub env_http_headers: Option<McpTextMap>,
        /// The scopes a sign-in asks for.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Vec<McpRequestText>")]
        pub oauth_scopes: Option<Vec<McpRequestText>>,
        /// The resource a sign-in names.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "McpRequestText")]
        pub oauth_resource: Option<McpRequestText>,
    }
}

/// A server's declaration as the person submits it, by transport; unset members keep the
/// provider's values.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum McpServerConfigInput {
    /// A program the provider starts.
    Stdio(#[garde(dive)] McpStdioConfigInput),
    /// A server reached at an address.
    Remote(#[garde(dive)] McpRemoteConfigInput),
}

server_config! {
    /// A program the provider starts, read back with its environment's names only.
    pub struct McpStdioConfigView {
        /// Always `stdio`.
        pub transport: McpStdioTransport,
        /// The program.
        pub command: String,
        /// Its arguments.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Vec<String>")]
        pub args: Option<Vec<String>>,
        /// The names of the environment variables it is given.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Vec<String>")]
        pub env_var_names: Option<Vec<String>>,
    }
}

server_config! {
    /// A server reached at an address, read back with header and query names only. The daemon
    /// strips the address's query and any user name or password from it; a client shows it
    /// verbatim.
    pub struct McpRemoteConfigView {
        /// How it is reached.
        pub transport: McpRemoteTransport,
        /// Its address, stripped.
        pub url: String,
        /// The names of the query parameters stripped from the address.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Vec<String>")]
        pub url_query_param_names: Option<Vec<String>>,
        /// The names of the headers sent with each request.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Vec<String>")]
        pub header_names: Option<Vec<String>>,
        /// The environment variable holding a bearer token.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "String")]
        pub bearer_token_env_var: Option<String>,
        /// A header name mapped to the name of the environment variable holding its value; names
        /// only, so it is served back.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Record<String, String>")]
        pub env_http_headers: Option<Record<String, String>>,
        /// The scopes a sign-in asks for.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Vec<String>")]
        pub oauth_scopes: Option<Vec<String>>,
        /// The resource a sign-in names.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "String")]
        pub oauth_resource: Option<String>,
    }
}

/// The redacted read-back of a binding's declaration, by transport.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum McpServerConfigView {
    /// A program the provider starts.
    Stdio(McpStdioConfigView),
    /// A server reached at an address.
    Remote(McpRemoteConfigView),
}
