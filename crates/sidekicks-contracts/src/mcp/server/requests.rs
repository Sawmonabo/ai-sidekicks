//! Each `mcp.*` method's request and reply: reading the inventory, writing and removing a
//! binding, switching it and its tools, its sign-in, reconnecting it, and searching the public MCP
//! Registry.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::error::ERROR_MESSAGE_MAX_LEN;
use crate::free_form_string::FilesystemPath;
use crate::mcp::server::config::{McpRequestText, McpServerConfigInput};
use crate::mcp::server::inventory::{
    McpServerInventoryEntry, McpServerLegStatus, McpToolOverride, McpToolOverrideFacet,
};
use crate::mcp::server::{McpApplicationGrade, McpToolName, binding_addressed};
use crate::method::KeyedRequest;
use crate::place::{PlacedPath, WslPlace};
use crate::provider::driver::runtime_binding::RuntimeBindingId;
use crate::provider::id::ProviderId;
use crate::session::id::SessionId;
use crate::web_address::WebAddress;
use crate::wire::id::ClientUuid;
use crate::wire::record::JsonRecord;
use crate::wire::text::{FreeFormText, NonEmptyText};
use crate::wire::{Never, literal};

/// Reads the whole inventory; `refresh` asks the daemon to probe before answering.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct McpServerListRequest {
    /// Whether to probe first.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "bool")]
    pub refresh: Option<bool>,
}

binding_addressed! {
    /// Adds a binding or changes its declaration, at any writable scope on any provider. Every
    /// scope takes what the person typed, values included, written in that provider's own file
    /// format; a plugin's, connector's or organization's server is refused, and so is a transport
    /// or member the binding's provider does not declare.
    pub enum McpServerUpsertRequest in writable scopes {
        /// The press's key; a retry reuses it.
        client_idempotency_key: ClientUuid,
        /// The declaration.
        #[garde(dive)]
        config: McpServerConfigInput,
    }
}

impl KeyedRequest for McpServerUpsertRequest {}

binding_addressed! {
    /// Removes a binding from its provider's config. A plugin's server leaves only with its
    /// plugin, and a connector or an organization's server only with the provider's own account or
    /// settings, so each is refused.
    pub enum McpServerDeleteRequest in writable scopes {
        /// The press's key; a retry reuses it.
        client_idempotency_key: ClientUuid,
    }
}

impl KeyedRequest for McpServerDeleteRequest {}

binding_addressed! {
    /// Turns one binding on or off. A connector or an organization's server is switched for one
    /// project, `projectRoot`, by the daemon's own switch, never in the provider's config; every
    /// other binding is switched where it applies and takes no `projectRoot`.
    pub enum McpServerEnabledUpdateRequest in every scope {
        /// The press's key; a retry reuses it.
        client_idempotency_key: ClientUuid,
        /// On or off.
        enabled: bool,
    }
    on connector and managed {
        /// The project the switch applies in.
        project_root: FilesystemPath,
        /// The distribution the project's root is in, in Linux form; absent elsewhere.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WslPlace")]
        place: Option<WslPlace>,
    }
    elsewhere {
        /// Never present: the binding is switched where it applies.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        project_root: Option<Never>,
    }
}

impl KeyedRequest for McpServerEnabledUpdateRequest {}

binding_addressed! {
    /// A keyed command on one binding with nothing else to say: starting the daemon's sign-in.
    pub enum McpServerSignInRequest in every scope {
        /// The press's key; a retry reuses it.
        client_idempotency_key: ClientUuid,
    }
}

impl KeyedRequest for McpServerSignInRequest {}

binding_addressed! {
    /// Sets one tool's override on a binding.
    pub enum McpToolOverrideUpdateRequest in every scope {
        /// The press's key; a retry reuses it.
        client_idempotency_key: ClientUuid,
        /// The override.
        #[garde(dive)]
        r#override: McpToolOverride,
    }
}

impl KeyedRequest for McpToolOverrideUpdateRequest {}

binding_addressed! {
    /// Clears one facet of one tool's override, returning that facet to the server's own value
    /// and leaving the tool's other facets as they stand.
    pub enum McpToolOverrideClearRequest in every scope {
        /// The press's key; a retry reuses it.
        client_idempotency_key: ClientUuid,
        /// The tool.
        tool_name: McpToolName,
        /// The facet it clears.
        facet: McpToolOverrideFacet,
    }
}

impl KeyedRequest for McpToolOverrideClearRequest {}

binding_addressed! {
    /// Signs out of the server at the address the binding's entry declares: the one sign-in every
    /// binding at that address shares.
    pub enum McpServerSignOutRequest in every scope {
        /// The press's key; a retry reuses it.
        client_idempotency_key: ClientUuid,
    }
}

impl KeyedRequest for McpServerSignOutRequest {}

binding_addressed! {
    /// Asks the provider to open a binding's connection again. It carries no key: it writes
    /// nothing, so there is no receipt to return. `bindingId` names one live leg; `sessionId`
    /// alone names every leg of that session; neither names every live leg.
    pub enum McpServerReconnectRequest in every scope {
        /// The session whose legs to reconnect.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "SessionId")]
        session_id: Option<SessionId>,
        /// The one live leg to reconnect.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "RuntimeBindingId")]
        binding_id: Option<RuntimeBindingId>,
    }
}

/// Searches the public MCP Registry for servers to add. The daemon makes the call, only when the
/// person types, and keeps nothing past the page it answers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct McpRegistrySearchRequest {
    /// What the person typed.
    pub query: McpRequestText,
    /// The page to read on from.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "McpRequestText")]
    pub cursor: Option<McpRequestText>,
}

/// What `mcp.server.list` answers with: the bindings of every provider whose read answered, each
/// provider whose read failed, and each project root part of whose config a provider could not
/// read.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpServerListResponse {
    /// Every binding of the providers that answered.
    #[garde(dive)]
    pub servers: Vec<McpServerInventoryEntry>,
    /// One entry per provider whose read failed, whose bindings `servers` leaves out; empty when
    /// every provider answered.
    #[garde(skip)]
    pub failed_providers: Vec<McpProviderReadFailure>,
    /// One entry per project root and provider where part of the provider's config for that root
    /// could not be read; the root's other bindings are still in `servers`. Empty when every root
    /// was read whole.
    #[garde(skip)]
    pub failed_roots: Vec<McpRootReadFailure>,
}

/// A project root part of whose MCP config a provider's read could not read. It carries no
/// system error text; the daemon's log keeps that.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpRootReadFailure {
    /// The provider.
    pub provider: ProviderId,
    /// The root, with the distribution it is in.
    pub root: PlacedPath,
}

/// A provider whose MCP servers could not be read, with why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpProviderReadFailure {
    /// The provider.
    pub provider: ProviderId,
    /// Why its read failed, with no credential, address query or file path in it.
    pub cause: FreeFormText<ERROR_MESSAGE_MAX_LEN>,
}

/// What `mcp.server.read` answers with.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpServerReadResponse {
    /// The binding.
    #[garde(dive)]
    pub server: McpServerInventoryEntry,
}

/// How a mutation went on one live session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum McpLiveApplicationOutcome {
    /// The session took the change.
    Applied,
    /// The session did not.
    Failed,
}

/// One live session's outcome after a mutation that touched it. A mutation that committed and
/// failed on one session still answers served and reports that session here.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpLiveApplicationResult {
    /// The session.
    pub session_id: SessionId,
    /// The live leg.
    pub binding_id: RuntimeBindingId,
    /// How it went.
    pub outcome: McpLiveApplicationOutcome,
    /// The provider's error code, on a failure.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "String")]
    pub error_code: Option<String>,
    /// What went wrong, on a failure.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "String")]
    pub detail: Option<String>,
}

/// What a governance mutation answers with: the row as it now stands, where the change took
/// effect, each live session's outcome, and why the provider's running service did not reload the
/// change, where it did not. `liveResults` is absent, not empty, where none was touched.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct McpServerMutationResponse {
    /// The row.
    #[garde(dive)]
    pub server: McpServerInventoryEntry,
    /// Where the change took effect.
    pub applied: McpApplicationGrade,
    /// Each touched session's outcome.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<McpLiveApplicationResult>")]
    pub live_results: Option<Vec<McpLiveApplicationResult>>,
    /// Present when the provider holds the change but its running service did not reload it, so
    /// the change applies at that service's next start; it says why, with no config value or file
    /// path.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<ERROR_MESSAGE_MAX_LEN>")]
    pub reload_failure: Option<FreeFormText<ERROR_MESSAGE_MAX_LEN>>,
}

/// What removing a binding answers with: where the change took effect, each live session's
/// outcome, and why the provider's running service did not reload the removal, where it did not.
/// There is no row left to return.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct McpServerDeleteResponse {
    /// Where the change took effect.
    pub applied: McpApplicationGrade,
    /// Each touched session's outcome.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<McpLiveApplicationResult>")]
    pub live_results: Option<Vec<McpLiveApplicationResult>>,
    /// Present when the provider holds the change but its running service did not reload it, so
    /// the change applies at that service's next start; it says why, with no config value or file
    /// path.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<ERROR_MESSAGE_MAX_LEN>")]
    pub reload_failure: Option<FreeFormText<ERROR_MESSAGE_MAX_LEN>>,
}

literal! {
    /// The grade an interrupted-call class takes: always enforced at the daemon, at once.
    pub enum McpDaemonEnforcedGrade = const McpApplicationGrade::DaemonEnforced.as_str();
}

/// One tool override's result, per facet it touched. An `enabled` or `approvalMode` facet may be
/// written into the provider's own config, where the provider keeps it, so each facet carries its
/// own grade.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpToolOverrideApplication {
    /// The `enabled` facet's grade.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "McpApplicationGrade")]
    pub enabled: Option<McpApplicationGrade>,
    /// The `approvalMode` facet's grade.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "McpApplicationGrade")]
    pub approval_mode: Option<McpApplicationGrade>,
    /// The `idempotencyClass` facet's grade.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "McpDaemonEnforcedGrade")]
    pub idempotency_class: Option<McpDaemonEnforcedGrade>,
}

/// What setting or clearing a tool override answers with.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct McpToolOverrideMutationResponse {
    /// The row.
    #[garde(dive)]
    pub server: McpServerInventoryEntry,
    /// Each touched facet's grade.
    pub applied: McpToolOverrideApplication,
}

/// What starting a sign-in answers with: the sign-in page's address for the client to open. A
/// retry answered with the saved result comes without it, because the address is used once and
/// never stored; that caller starts a new sign-in under a new key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct McpServerSignInResponse {
    /// The sign-in page, `http:` or `https:`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WebAddress")]
    pub authorization_url: Option<WebAddress>,
}

/// What reconnecting answers with: each leg's status after the attempt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpServerReconnectResponse {
    /// Each leg.
    #[garde(dive)]
    pub legs: Vec<McpServerLegStatus>,
}

/// A registry server that runs as a package the person's machine installs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpRegistryPackage {
    /// The package registry, such as `npm`.
    pub registry_type: String,
    /// The package's name there.
    pub identifier: NonEmptyText,
    /// The package's version, where the registry names one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "String")]
    pub version: Option<String>,
    /// The runtime that runs it, such as `npx`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "String")]
    pub runtime_hint: Option<String>,
    /// The runtime's arguments, each as the registry describes it (its kind, name, value and
    /// whether it is required); a secret argument, or a secret variable of one, carries no `value`
    /// or `default`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<JsonRecord>")]
    pub runtime_arguments: Option<Vec<JsonRecord>>,
    /// The package's own arguments, each as the registry describes it; a secret argument, or a
    /// secret variable of one, carries no `value` or `default`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<JsonRecord>")]
    pub package_arguments: Option<Vec<JsonRecord>>,
}

/// A registry server reached at an address.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpRegistryRemote {
    /// How it is reached, as the registry names it.
    #[serde(rename = "type")]
    pub transport: String,
    /// The address as the registry writes it: an `http:` or `https:` address, or a template whose
    /// `{name}` placeholders its `variables` fill. The form asks for each variable and checks the
    /// filled address, which the upsert reads as a server address.
    pub url: NonEmptyText,
    /// The placeholders in its address the person fills.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<McpRegistryInput>")]
    pub variables: Option<Vec<McpRegistryInput>>,
    /// The headers its requests carry, which the person fills.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<McpRegistryInput>")]
    pub headers: Option<Vec<McpRegistryInput>>,
}

/// What a registry server asks the person to fill (an environment variable, a header or a
/// placeholder in its address): its name and how to ask, never a value or a default.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpRegistryInput {
    /// The input's name.
    pub name: NonEmptyText,
    /// What it is for.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "String")]
    pub description: Option<String>,
    /// Whether the server needs it.
    pub is_required: bool,
    /// Whether it is a secret, which the form masks.
    pub is_secret: bool,
}

/// One registry search result. Untrusted data from a public registry anyone can publish to: it
/// fills the add form and nothing else. No environment variable, header or address input carries
/// a value or a default, and neither does a secret argument.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpRegistryServer {
    /// The server's registry name.
    pub name: NonEmptyText,
    /// The name a person reads.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "String")]
    pub title: Option<String>,
    /// What it does.
    pub description: String,
    /// Its version.
    pub version: String,
    /// The packages it runs as, where it runs as one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<McpRegistryPackage>")]
    pub packages: Option<Vec<McpRegistryPackage>>,
    /// The addresses it is reached at, where it is reached at one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<McpRegistryRemote>")]
    pub remotes: Option<Vec<McpRegistryRemote>>,
    /// The environment variables it reads.
    pub environment_variables: Vec<McpRegistryInput>,
}

/// One page of registry search results.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct McpRegistrySearchResponse {
    /// The results.
    pub servers: Vec<McpRegistryServer>,
    /// The page after this one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "NonEmptyText")]
    pub next_cursor: Option<NonEmptyText>,
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::McpServerUpsertRequest;
    use crate::mcp::server::config::McpServerConfigInput;
    use crate::wire::attachment::{ReceivedError, parse_received};
    use crate::wire::number::PositiveNumber;
    use crate::wire::text::FreeFormText;

    const KEY: &str = "00000000-0000-4000-8000-000000000000";

    /// An address whose kept form is short but whose text as sent is past the request text's cap.
    #[rstest]
    #[case::spaces(format!("{}https://example.com/", " ".repeat(8190)))]
    #[case::line_breaks(format!("https://example.com/a{}b", "\n".repeat(8180)))]
    fn a_server_address_is_capped_as_sent(#[case] padded: String) {
        let upsert = |url: &str| {
            serde_json::json!({
                "scope": "user",
                "provider": "claude",
                "serverName": "s",
                "clientIdempotencyKey": KEY,
                "config": { "transport": "http", "url": url },
            })
            .to_string()
        };
        parse_received::<McpServerUpsertRequest>(upsert("https://example.com/").as_bytes(), vec![])
            .expect("an address within the cap is read");
        assert!(matches!(
            parse_received::<McpServerUpsertRequest>(upsert(&padded).as_bytes(), vec![]),
            Err(ReceivedError::Read { .. })
        ));
    }

    /// What a clearable member reads as: kept, cleared or set.
    #[derive(Debug, PartialEq)]
    enum Reading<T> {
        Keep,
        Clear,
        Set(T),
    }

    impl<T> Reading<T> {
        #[expect(
            clippy::option_option,
            reason = "it reads the clearable member's own three-meaning type"
        )]
        fn of(member: Option<Option<T>>) -> Self {
            match member {
                None => Self::Keep,
                Some(None) => Self::Clear,
                Some(Some(value)) => Self::Set(value),
            }
        }
    }

    /// A clearable member reads absent as keep, `null` as remove and a value as set, on a remote
    /// member and a shared one alike, and writes each back as sent; a switch still refuses `null`.
    #[rstest]
    #[case::absent(serde_json::json!({}), Reading::Keep, Reading::Keep)]
    #[case::null(
        serde_json::json!({ "bearerTokenEnvVar": null, "startupTimeoutSec": null }),
        Reading::Clear,
        Reading::Clear
    )]
    #[case::value(
        serde_json::json!({ "bearerTokenEnvVar": "TOKEN", "startupTimeoutSec": 10.0 }),
        Reading::Set("TOKEN"),
        Reading::Set(10.0)
    )]
    fn a_clearable_member_keeps_its_three_meanings(
        #[case] members: serde_json::Value,
        #[case] bearer: Reading<&str>,
        #[case] startup: Reading<f64>,
    ) {
        let upsert = |members: &serde_json::Value| {
            let mut config =
                serde_json::json!({ "transport": "http", "url": "https://example.com/" });
            for (name, value) in members.as_object().expect("the members are an object") {
                config[name] = value.clone();
            }
            let request = serde_json::json!({
                "scope": "user",
                "provider": "codex",
                "serverName": "s",
                "clientIdempotencyKey": KEY,
                "config": config,
            });
            (config, request.to_string())
        };
        let (sent, request) = upsert(&members);
        let read = parse_received::<McpServerUpsertRequest>(request.as_bytes(), vec![])
            .expect("a clearable member is read absent, null or set");
        let McpServerUpsertRequest::User { config, .. } = &read else {
            panic!("{read:?} is not the user arm");
        };
        let McpServerConfigInput::Http {
            bearer_token_env_var,
            startup_timeout_sec,
            ..
        } = config
        else {
            panic!("{config:?} is not the http arm");
        };
        assert_eq!(
            Reading::of(
                bearer_token_env_var
                    .as_ref()
                    .map(|member| member.as_ref().map(FreeFormText::as_str))
            ),
            bearer
        );
        assert_eq!(
            Reading::of((*startup_timeout_sec).map(|member| member.map(PositiveNumber::get))),
            startup
        );
        assert_eq!(
            serde_json::to_value(config).expect("the config writes"),
            sent
        );

        let (_, switched_off) = upsert(&serde_json::json!({ "enabled": null }));
        assert!(matches!(
            parse_received::<McpServerUpsertRequest>(switched_off.as_bytes(), vec![]),
            Err(ReceivedError::Shape { .. })
        ));
    }
}
