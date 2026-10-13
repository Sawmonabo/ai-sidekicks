//! A server's declaration: as the person submits it, values included, and as the daemon reads it
//! back, with every credential-bearing value reduced to its name.

use schemars::{JsonSchema, Schema};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::provider::name::ProviderName;
use crate::schema::{push_all_of, required_member};
use crate::web_address::WebAddress;
use crate::wire::number::PositiveNumber;
use crate::wire::record::Record;
use crate::wire::text::{BoundedText, FreeFormText, is_within_length};

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
#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "garde passes a check's context by reference"
)]
pub(crate) fn is_request_address(address: &McpServerAddress, (): &()) -> garde::Result {
    if is_within_length(address.as_str(), 0, MCP_REQUEST_TEXT_MAX_LEN) {
        Ok(())
    } else {
        Err(garde::Error::new(
            "the address is longer than the request text cap",
        ))
    }
}

/// A submitted map of names to values: an environment, or headers.
pub type McpTextMap = Record<McpRequestText, McpRequestValue>;

/// Declares a declaration union tagged on `transport`: a program the provider starts (`stdio`)
/// and a server reached at an address over streamable HTTP (`http`) or server-sent events (`sse`,
/// Claude Code only), each arm ending with the settings every transport carries, the same on a
/// submitted declaration and its read-back.
macro_rules! server_config {
    (
        $(#[doc = $doc:literal])+
        pub enum $name:ident {
            stdio { $($stdio:tt)* }
            remote { $($remote:tt)* }
        }
    ) => {
        server_config! {
            @union [$(#[doc = $doc])+] $name [$($stdio)*] [$($remote)*] [
                /// Whether the server is on; unset keeps the provider's value.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "bool")]
                enabled: Option<bool>,
                /// Whether a session refuses to start without the server; Codex only. Unset keeps
                /// the provider's value.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "bool")]
                required: Option<bool>,
                /// How long the server may take to start, in seconds; Codex only.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "PositiveNumber")]
                startup_timeout_sec: Option<PositiveNumber>,
                /// How long one tool call may take, in seconds; Codex only.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "PositiveNumber")]
                tool_timeout_sec: Option<PositiveNumber>,
            ]
        }
    };
    (
        @union [$(#[doc = $doc:literal])+] $name:ident [$($stdio:tt)*] [$($remote:tt)*]
        [$($shared:tt)*]
    ) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(
            tag = "transport",
            rename_all = "snake_case",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        #[garde(allow_unvalidated)]
        pub enum $name {
            /// A program the provider starts.
            Stdio { $($stdio)* $($shared)* },
            /// A server reached over streamable HTTP.
            Http { $($remote)* $($shared)* },
            /// A server reached over server-sent events; Claude Code only.
            Sse { $($remote)* $($shared)* },
        }
    };
}

server_config! {
    /// A server's declaration as the person submits it, by transport; unset members keep the
    /// provider's values. Environment and header values are write-only, handed to the provider's
    /// write path and never served back. A member only Codex reads is refused on a Claude Code
    /// binding, and `sse` on a Codex one.
    pub enum McpServerConfigInput {
        stdio {
            /// The program.
            command: McpRequestText,
            /// Its arguments.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Vec<McpRequestValue>")]
            args: Option<Vec<McpRequestValue>>,
            /// Its environment, values included.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "McpTextMap")]
            env: Option<McpTextMap>,
            /// The names of the variables it inherits from the environment Codex starts in; Codex
            /// only.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Vec<McpRequestText>")]
            env_vars: Option<Vec<McpRequestText>>,
        }
        remote {
            /// Its address.
            #[garde(custom(is_request_address))]
            #[schemars(extend("maxLength" = MCP_REQUEST_TEXT_MAX_LEN))]
            url: McpServerAddress,
            /// Headers sent with each request, values included.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "McpTextMap")]
            headers: Option<McpTextMap>,
            /// The environment variable holding a bearer token; Codex only.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "McpRequestText")]
            bearer_token_env_var: Option<McpRequestText>,
            /// A header name mapped to the name of the environment variable holding its value;
            /// Codex only.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "McpTextMap")]
            env_http_headers: Option<McpTextMap>,
            /// The scopes a sign-in asks for; Codex only.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Vec<McpRequestText>")]
            oauth_scopes: Option<Vec<McpRequestText>>,
            /// The resource a sign-in names; Codex only.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "McpRequestText")]
            oauth_resource: Option<McpRequestText>,
        }
    }
}

/// The members of a submitted declaration only Codex reads, by wire name; a Claude Code binding
/// refuses each.
const CODEX_ONLY_CONFIG_MEMBERS: [&str; 8] = [
    "envVars",
    "required",
    "startupTimeoutSec",
    "toolTimeoutSec",
    "bearerTokenEnvVar",
    "envHttpHeaders",
    "oauthScopes",
    "oauthResource",
];

impl McpServerConfigInput {
    /// Whether the declaration sets the member of that wire name.
    fn sets_member(&self, member: &str) -> bool {
        match self {
            Self::Stdio {
                env_vars,
                required,
                startup_timeout_sec,
                tool_timeout_sec,
                ..
            } => match member {
                "envVars" => env_vars.is_some(),
                "required" => required.is_some(),
                "startupTimeoutSec" => startup_timeout_sec.is_some(),
                "toolTimeoutSec" => tool_timeout_sec.is_some(),
                _ => false,
            },
            Self::Http {
                bearer_token_env_var,
                env_http_headers,
                oauth_scopes,
                oauth_resource,
                required,
                startup_timeout_sec,
                tool_timeout_sec,
                ..
            }
            | Self::Sse {
                bearer_token_env_var,
                env_http_headers,
                oauth_scopes,
                oauth_resource,
                required,
                startup_timeout_sec,
                tool_timeout_sec,
                ..
            } => match member {
                "bearerTokenEnvVar" => bearer_token_env_var.is_some(),
                "envHttpHeaders" => env_http_headers.is_some(),
                "oauthScopes" => oauth_scopes.is_some(),
                "oauthResource" => oauth_resource.is_some(),
                "required" => required.is_some(),
                "startupTimeoutSec" => startup_timeout_sec.is_some(),
                "toolTimeoutSec" => tool_timeout_sec.is_some(),
                _ => false,
            },
        }
    }

    /// Whether the declaration fits its provider: a Claude Code binding sets no member only Codex
    /// reads, and a Codex binding is not reached over `sse`.
    pub(crate) fn check_provider(&self, provider: ProviderName) -> garde::Result {
        match provider {
            ProviderName::Claude => {
                match CODEX_ONLY_CONFIG_MEMBERS
                    .into_iter()
                    .find(|member| self.sets_member(member))
                {
                    Some(member) => Err(garde::Error::new(format!(
                        "{member} is read only by Codex, so a Claude Code binding refuses it"
                    ))),
                    None => Ok(()),
                }
            }
            ProviderName::Codex if matches!(self, Self::Sse { .. }) => {
                Err(garde::Error::new("a Codex binding is not reached over sse"))
            }
            ProviderName::Codex => Ok(()),
        }
    }
}

/// The schema twin of [`McpServerConfigInput::check_provider`], on a request whose `provider` sits
/// beside its `config`.
pub(crate) fn add_provider_config_rules(schema: &mut Schema) {
    let provider_is = |provider: ProviderName| {
        json!({
            "type": "object",
            "properties": { "provider": { "const": provider } },
            "required": ["provider"],
        })
    };
    push_all_of(
        schema,
        json!({
            "if": provider_is(ProviderName::Claude),
            "then": {
                "type": "object",
                "properties": {
                    "config": {
                        "not": { "anyOf": CODEX_ONLY_CONFIG_MEMBERS.map(required_member) },
                    },
                },
            },
        }),
    );
    push_all_of(
        schema,
        json!({
            "if": provider_is(ProviderName::Codex),
            "then": {
                "type": "object",
                "properties": {
                    "config": {
                        "type": "object",
                        "properties": { "transport": { "not": { "const": "sse" } } },
                    },
                },
            },
        }),
    );
}

server_config! {
    /// The redacted read-back of a binding's declaration, by transport: environment, header and
    /// query names only. The daemon strips an address's query and any user name or password from
    /// it, and serves an organization's server with its address's host only; a client shows the
    /// address verbatim.
    pub enum McpServerConfigView {
        stdio {
            /// The program.
            command: String,
            /// Its arguments.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Vec<String>")]
            args: Option<Vec<String>>,
            /// The names of the environment variables it is given.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Vec<String>")]
            env_var_names: Option<Vec<String>>,
        }
        remote {
            /// Its address, stripped.
            url: String,
            /// The names of the query parameters stripped from the address.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Vec<String>")]
            url_query_param_names: Option<Vec<String>>,
            /// The names of the headers sent with each request.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Vec<String>")]
            header_names: Option<Vec<String>>,
            /// The environment variable holding a bearer token.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "String")]
            bearer_token_env_var: Option<String>,
            /// A header name mapped to the name of the environment variable holding its value;
            /// names only, so it is served back.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Record<String, String>")]
            env_http_headers: Option<Record<String, String>>,
            /// The scopes a sign-in asks for.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Vec<String>")]
            oauth_scopes: Option<Vec<String>>,
            /// The resource a sign-in names.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "String")]
            oauth_resource: Option<String>,
        }
    }
}
