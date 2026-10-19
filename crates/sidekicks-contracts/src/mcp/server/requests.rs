//! Each `mcp.*` method's request and reply: reading the inventory, writing and removing a
//! binding, switching it and its tools, its sign-in, reconnecting it, and searching the public MCP
//! Registry.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::free_form_string::FilesystemPath;
use crate::mcp::server::config::{McpRequestText, McpServerAddress, McpServerConfigInput};
use crate::mcp::server::inventory::{
    McpServerInventoryEntry, McpServerLegStatus, McpToolOverride, McpToolOverrideFacet,
};
use crate::mcp::server::{McpApplicationGrade, McpToolName, binding_addressed};
use crate::method::KeyedRequest;
use crate::place::WslPlace;
use crate::provider::driver::runtime_binding::RuntimeBindingId;
use crate::session::id::SessionId;
use crate::web_address::WebAddress;
use crate::wire::id::ClientUuid;
use crate::wire::record::JsonRecord;
use crate::wire::text::NonEmptyText;
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

/// Signs out of one server: the daemon's single sign-in for it, which every provider and every
/// binding naming it share. `serverId` is the server's address, not a scope-qualified binding.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct McpServerSignOutRequest {
    /// The press's key; a retry reuses it.
    pub client_idempotency_key: ClientUuid,
    /// The server's address.
    pub server_id: McpServerAddress,
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

/// What `mcp.server.list` answers with.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpServerListResponse {
    /// Every binding.
    #[garde(dive)]
    pub servers: Vec<McpServerInventoryEntry>,
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
/// effect, and each live session's outcome. `liveResults` is absent, not empty, where none was
/// touched.
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
}

/// What removing a binding answers with. There is no row left to return.
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
    /// The runtime that runs it, such as `npx`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "String")]
    pub runtime_hint: Option<String>,
    /// The runtime's arguments, each as the registry describes it (its kind, name, value and
    /// whether it is required).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<JsonRecord>")]
    pub runtime_arguments: Option<Vec<JsonRecord>>,
}

/// A registry server reached at an address.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpRegistryRemote {
    /// How it is reached, as the registry names it.
    #[serde(rename = "type")]
    pub transport: String,
    /// Its `http:` or `https:` address.
    pub url: WebAddress,
}

/// An environment variable a registry server reads: its name, never a value.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpRegistryEnvironmentVariable {
    /// The variable's name.
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
}

/// One registry search result. Untrusted data from a public registry anyone can publish to: it
/// fills the add form and nothing else, and it never holds an environment variable's value.
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
    pub environment_variables: Vec<McpRegistryEnvironmentVariable>,
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

    use super::{McpServerSignOutRequest, McpServerUpsertRequest};
    use crate::wire::attachment::{ReceivedError, parse_received};

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
        let logout = |url: &str| {
            serde_json::json!({ "clientIdempotencyKey": KEY, "serverId": url }).to_string()
        };
        parse_received::<McpServerUpsertRequest>(upsert("https://example.com/").as_bytes(), vec![])
            .expect("an address within the cap is read");
        parse_received::<McpServerSignOutRequest>(
            logout("https://example.com/").as_bytes(),
            vec![],
        )
        .expect("an address within the cap is read");
        assert!(matches!(
            parse_received::<McpServerUpsertRequest>(upsert(&padded).as_bytes(), vec![]),
            Err(ReceivedError::Read { .. })
        ));
        assert!(matches!(
            parse_received::<McpServerSignOutRequest>(logout(&padded).as_bytes(), vec![]),
            Err(ReceivedError::Read { .. })
        ));
    }
}
