//! A server's declaration: as the person submits it, values included, and as the daemon reads it
//! back, with every credential-bearing value reduced to its name.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use strum::{IntoStaticStr, VariantArray};

use crate::web_address::WebAddress;
use crate::wire::list::{UniqueList, closed_list_key};
use crate::wire::number::PositiveNumber;
use crate::wire::record::Record;
use crate::wire::text::{BoundedText, FreeFormText, is_within_length};

/// The longest command, argument, name, value, address or search text an `mcp.*` request carries.
pub const MCP_REQUEST_TEXT_MAX_LEN: usize = 8192;

/// A command, a name or a search text an `mcp.*` request carries.
pub type McpRequestText = FreeFormText<MCP_REQUEST_TEXT_MAX_LEN>;

/// An argument or a value an `mcp.*` request carries; it may be empty.
pub type McpRequestValue = BoundedText<0, MCP_REQUEST_TEXT_MAX_LEN>;

/// An `http:` or `https:` server address of at most [`MCP_REQUEST_TEXT_MAX_LEN`] code points as
/// sent, taken as typed, a user name or password in it included; `http:` is legal because a
/// server may listen on loopback.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct McpServerAddress(WebAddress);

impl McpServerAddress {
    /// `text` as kept when it is within the request text's cap as sent and is a web address, else
    /// `None`; the cap counts the text before it is trimmed.
    pub fn new(text: &str) -> Option<Self> {
        if !is_within_length(text, 0, MCP_REQUEST_TEXT_MAX_LEN) {
            return None;
        }
        WebAddress::new(text).map(Self)
    }

    /// The address as kept.
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl<'de> Deserialize<'de> for McpServerAddress {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(&String::deserialize(deserializer)?).ok_or_else(|| {
            D::Error::custom(format!(
                "not an http: or https: address of at most {MCP_REQUEST_TEXT_MAX_LEN} code points"
            ))
        })
    }
}

impl JsonSchema for McpServerAddress {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "McpServerAddress".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let mut schema = WebAddress::json_schema(generator);
        schema.insert("maxLength".into(), MCP_REQUEST_TEXT_MAX_LEN.into());
        schema
    }
}

/// A submitted map of names to values: an environment, or headers.
pub type McpTextMap = Record<McpRequestText, McpRequestValue>;

/// Declares a declaration union tagged on `transport`: a program the provider starts (`stdio`)
/// and a server reached at an address over streamable HTTP (`http`) or server-sent events (`sse`),
/// each arm ending with the settings every transport carries, the same on a submitted declaration
/// and its read-back.
macro_rules! server_config {
    (
        $(#[doc = $doc:literal])+
        pub enum $name:ident {
            stdio { $($stdio:tt)* }
            remote { $($remote:tt)* }
            $(ws $ws:tt)?
        }
    ) => {
        server_config! {
            @union [$(#[doc = $doc])+] $name [$($stdio)*] [$($remote)*] [$($ws)?] [
                /// Whether the server is on; unset keeps the provider's value.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "bool")]
                enabled: Option<bool>,
                /// Whether a session refuses to start without the server. Unset keeps the
                /// provider's value.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "bool")]
                required: Option<bool>,
                /// How long the server may take to start, in seconds.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "PositiveNumber")]
                startup_timeout_sec: Option<PositiveNumber>,
                /// How long one tool call may take, in seconds.
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
        [$($ws:tt)?] [$($shared:tt)*]
    ) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(
            tag = "transport",
            rename_all = "camelCase",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        #[garde(allow_unvalidated)]
        pub enum $name {
            /// A program the provider starts.
            Stdio { $($stdio)* $($shared)* },
            /// A server reached over streamable HTTP.
            Http { $($remote)* $($shared)* },
            /// A server reached over server-sent events.
            Sse { $($remote)* $($shared)* },
            $(
                /// A server reached over a WebSocket.
                Ws $ws,
            )?
        }
    };
}

server_config! {
    /// A server's declaration as the person submits it, by transport; unset members keep the
    /// provider's values. Environment and header values are write-only, handed to the provider's
    /// write path and never served back. The daemon refuses a transport or member the binding's
    /// provider does not declare, the declared set `provider.list` sends.
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
            /// The names of the variables it inherits from the environment the provider starts
            /// in.
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
            url: McpServerAddress,
            /// Headers sent with each request, values included.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "McpTextMap")]
            headers: Option<McpTextMap>,
            /// The environment variable holding a bearer token.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "McpRequestText")]
            bearer_token_env_var: Option<McpRequestText>,
            /// A header name mapped to the name of the environment variable holding its value.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "McpTextMap")]
            env_http_headers: Option<McpTextMap>,
            /// The scopes a sign-in asks for.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Vec<McpRequestText>")]
            oauth_scopes: Option<Vec<McpRequestText>>,
            /// The resource a sign-in names.
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
        ws {
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
            /// The names of the headers sent when the connection opens.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Vec<String>")]
            header_names: Option<Vec<String>>,
        }
    }
}

/// How a server is reached: a program the provider starts, streamable HTTP or server-sent events.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Hash,
    Serialize,
    Deserialize,
    JsonSchema,
    VariantArray,
    IntoStaticStr,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum McpTransport {
    /// A program the provider starts.
    Stdio,
    /// Streamable HTTP.
    Http,
    /// Server-sent events.
    Sse,
}

/// A member of a submitted declaration that a provider reads only if its driver declares it.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Hash,
    Serialize,
    Deserialize,
    JsonSchema,
    VariantArray,
    IntoStaticStr,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum McpDeclaredConfigMember {
    /// `envVars`.
    EnvVars,
    /// `required`.
    Required,
    /// `startupTimeoutSec`.
    StartupTimeoutSec,
    /// `toolTimeoutSec`.
    ToolTimeoutSec,
    /// `bearerTokenEnvVar`.
    BearerTokenEnvVar,
    /// `envHttpHeaders`.
    EnvHttpHeaders,
    /// `oauthScopes`.
    OauthScopes,
    /// `oauthResource`.
    OauthResource,
}

closed_list_key!(McpTransport, McpDeclaredConfigMember);

/// What a provider's driver declares about the servers it takes: the transports it reaches them
/// over and the members it reads beyond the ones every provider reads. The desktop's form offers
/// only these, and the daemon refuses any other.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderMcpDeclaration {
    /// The transports, at least one.
    #[garde(dive)]
    pub transports: UniqueList<McpTransport, 1, { usize::MAX }>,
    /// The members it reads beyond the shared ones; may be empty.
    #[garde(dive)]
    pub config_members: UniqueList<McpDeclaredConfigMember, 0, { usize::MAX }>,
}

impl McpServerConfigInput {
    /// The declaration's transport.
    pub fn transport(&self) -> McpTransport {
        match self {
            Self::Stdio { .. } => McpTransport::Stdio,
            Self::Http { .. } => McpTransport::Http,
            Self::Sse { .. } => McpTransport::Sse,
        }
    }

    /// Whether the declaration sets `member`; a member its transport does not carry is never set.
    pub fn sets_member(&self, member: McpDeclaredConfigMember) -> bool {
        match self {
            Self::Stdio {
                env_vars,
                required,
                startup_timeout_sec,
                tool_timeout_sec,
                ..
            } => match member {
                McpDeclaredConfigMember::EnvVars => env_vars.is_some(),
                McpDeclaredConfigMember::Required => required.is_some(),
                McpDeclaredConfigMember::StartupTimeoutSec => startup_timeout_sec.is_some(),
                McpDeclaredConfigMember::ToolTimeoutSec => tool_timeout_sec.is_some(),
                McpDeclaredConfigMember::BearerTokenEnvVar
                | McpDeclaredConfigMember::EnvHttpHeaders
                | McpDeclaredConfigMember::OauthScopes
                | McpDeclaredConfigMember::OauthResource => false,
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
                McpDeclaredConfigMember::EnvVars => false,
                McpDeclaredConfigMember::Required => required.is_some(),
                McpDeclaredConfigMember::StartupTimeoutSec => startup_timeout_sec.is_some(),
                McpDeclaredConfigMember::ToolTimeoutSec => tool_timeout_sec.is_some(),
                McpDeclaredConfigMember::BearerTokenEnvVar => bearer_token_env_var.is_some(),
                McpDeclaredConfigMember::EnvHttpHeaders => env_http_headers.is_some(),
                McpDeclaredConfigMember::OauthScopes => oauth_scopes.is_some(),
                McpDeclaredConfigMember::OauthResource => oauth_resource.is_some(),
            },
        }
    }

    /// Whether the declaration fits what its provider's driver declares: a declared transport and
    /// no member the driver leaves out. The error names the first misfit and never a value.
    pub fn check_declared(&self, declaration: &ProviderMcpDeclaration) -> garde::Result {
        let transport = self.transport();
        if !declaration.transports.as_slice().contains(&transport) {
            return Err(garde::Error::new(format!(
                "the provider does not reach a server over {}",
                <&str>::from(transport)
            )));
        }
        match McpDeclaredConfigMember::VARIANTS.iter().find(|member| {
            self.sets_member(**member) && !declaration.config_members.as_slice().contains(member)
        }) {
            Some(member) => Err(garde::Error::new(format!(
                "the provider does not read {}",
                <&str>::from(*member)
            ))),
            None => Ok(()),
        }
    }
}
