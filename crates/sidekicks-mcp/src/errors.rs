//! The `mcp.*` refusals, each sent on the wire by its code: the refusal's message becomes the
//! reply's message and its detail `data.fields`.
//!
//! No path and no config value reaches a message or a detail: a binding is named by its provider,
//! scope and server name alone, never by its project root, and a failure underneath stays on the
//! refusal for the service log and never reaches the wire. The one exception is
//! `mcp.server.configFileInvalid`'s `configFiles`, which names the provider's config files on this
//! machine as the provider reported them.

use std::error::Error;

use serde_json::{Map, Value, json};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::mcp::governance::{
    McpBindingStoreUnavailableCause, McpReceiptKeyCause, McpServerConfigFileInvalidDetails,
    McpServerConfigWriteConflictReason,
};
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_ipc::domain_error::{DomainError, refusal_fields};
use sidekicks_ipc::registry::HandlerError;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_store::credential_store::KeychainRefusal;

use crate::binding::store::McpBindingKey;

/// Why a write to a provider's own config lost to a concurrent edit, with what each reason
/// carries; its reason is the detail's `reason`.
#[derive(Debug)]
pub enum McpConfigWriteConflict {
    /// The provider refused the write's expected version as stale; both versions go back so the
    /// caller can read the config again.
    StaleVersion {
        /// The version the write expected.
        expected_version: String,
        /// The version the provider holds.
        current_version: String,
    },
    /// The provider's config file no longer holds what the daemon last read, so the edit was not
    /// written and the file was left as it was.
    ConfigFileChanged,
    /// Another writer changed the binding's entry after the daemon read it, so the provider holds
    /// that writer's entry and not this change.
    EntryChanged,
}

/// A provider's config that does not load, so a write to it wrote nothing: the binding the write
/// was for, the provider's words and the config's layer paths.
#[derive(Debug)]
pub struct McpConfigFileInvalid {
    /// The binding the write was for.
    pub(crate) binding: McpServerBindingRef,
    /// The provider's words about the file, with no config value.
    pub(crate) words: String,
    /// The paths of the config's layers the read before the write reported, never a path read
    /// from the provider's words.
    pub(crate) config_files: Vec<String>,
}

/// Why no sign-in the daemon or a provider can run reaches a server, which the refusal's message
/// names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SignInUnsupportedReason {
    /// The binding is a program the provider starts or a provider account's connector.
    #[error("it is not reached at an address")]
    NotReachedAtAddress,
    /// The address the binding's entry declares does not read as a web address once its
    /// variables are filled.
    #[error(
        "the address its entry declares names a variable with no value or is not a web address"
    )]
    AddressUnreadable,
    /// The server publishes no protected-resource or authorization-server metadata.
    #[error("it publishes no sign-in route")]
    NoSignInRoute,
    /// The authorization server's metadata names endpoints or a flow the daemon cannot use.
    #[error("its authorization server's metadata names nothing the daemon's client can use")]
    UnusableMetadata,
    /// The authorization server's metadata does not list `S256` among its PKCE methods.
    #[error("its authorization server does not say it takes S256 PKCE challenges")]
    NoS256Challenge,
    /// The client the server's owner issued names a callback the daemon cannot serve.
    #[error("the callback its owner registered is not one the daemon can serve")]
    OwnerCallbackUnserved,
    /// The server does not admit the daemon's own client, and no provider's flow signs in to it.
    #[error("no provider's own client can sign in to it")]
    NoProviderFlow,
}

/// A refusal of an `mcp.*` call, converted into the reply's error by its code. Each arm boxes the
/// binding it names, so every `Result` carrying the refusal stays small.
#[derive(Debug, thiserror::Error)]
pub enum McpRefusal {
    /// The daemon's stores of a server's bindings and receipts, or its receipt key, cannot be
    /// used, so every MCP change fails closed, changing nothing.
    #[error("{}", binding_store_words(.cause.as_ref()))]
    BindingStoreUnavailable {
        /// Why, sent as the detail's `cause` where it is known.
        cause: Option<McpBindingStoreUnavailableCause>,
        /// The store's failure, where there is one.
        #[source]
        source: Option<Box<dyn Error + Send + Sync>>,
    },
    /// A change reused an idempotency key with a request the daemon cannot match to the key's first
    /// one; what the key first answered is untouched.
    #[error(
        "{}: this change reused a request key another change already used, so send it again under \
         a new key",
        binding_words(.binding)
    )]
    IdempotencyConflict {
        /// The binding the key first answered.
        binding: Box<McpServerBindingRef>,
    },
    /// The submitted configuration failed validation before anything was written.
    #[error("the MCP server configuration is invalid: {reason}")]
    ServerConfigInvalid {
        /// The field and the rule it broke, in words the daemon writes; never a submitted value.
        reason: String,
    },
    /// A write to the provider's own config lost to a concurrent edit; nothing was written.
    #[error(
        "{}: its configuration changed while it was being written, so nothing was written",
        binding_words(.binding)
    )]
    ServerConfigWriteConflict {
        /// The binding the write was for.
        binding: Box<McpServerBindingRef>,
        /// How the write lost.
        conflict: McpConfigWriteConflict,
    },
    /// The provider's own config does not load, so nothing was written and only an edit of the file
    /// fixes it.
    #[error(
        "{}: the provider's config does not load, so nothing was written: {}",
        binding_words(&.details.binding),
        .details.words
    )]
    ServerConfigFileInvalid {
        /// The binding, the provider's words and the config's layer paths.
        details: Box<McpConfigFileInvalid>,
    },
    /// The provider did not take a write to its own config; nothing was written.
    #[error("{}: the provider did not take the change: {words}", binding_words(.binding))]
    ProviderRefusedWrite {
        /// The binding the write was for.
        binding: Box<McpServerBindingRef>,
        /// Why, in the provider's words or the daemon's, with no config value.
        words: String,
    },
    /// No server with the binding's provider, scope, reference and name is in the inventory.
    #[error("{} was not found", binding_words(.binding))]
    ServerNotFound {
        /// The binding asked for.
        binding: Box<McpServerBindingRef>,
    },
    /// The server is off or not working in the session, so it cannot answer a read.
    #[error("{} is off or not working in this session", binding_words(.binding))]
    ServerNotRunning {
        /// The binding asked for.
        binding: Box<McpServerBindingRef>,
    },
    /// The sign-in could not be started for a passing reason; it can be tried again.
    #[error("the sign-in to {} could not be started", binding_words(.binding))]
    ServerSignInFailed {
        /// The binding being signed in to.
        binding: Box<McpServerBindingRef>,
        /// Why it could not be started.
        #[source]
        source: Box<dyn Error + Send + Sync>,
    },
    /// The server publishes no sign-in route, or one the daemon cannot read.
    #[error("{} offers no sign-in the daemon can use: {reason}", binding_words(.binding))]
    ServerSignInUnsupported {
        /// The binding being signed in to.
        binding: Box<McpServerBindingRef>,
        /// Why no sign-in reaches it.
        reason: SignInUnsupportedReason,
    },
    /// The keychain refused to delete the sign-in, so the server stays signed in.
    #[error("the sign-out of {} did not finish: {source}", binding_words(.binding))]
    ServerSignOutFailed {
        /// The binding being signed out of.
        binding: Box<McpServerBindingRef>,
        /// The keychain's refusal, whose cause goes on the wire.
        #[source]
        source: Box<KeychainRefusal>,
    },
}

const _: () = assert!(size_of::<McpRefusal>() <= 64);

// The binding store refusal's message: a lost receipt key left the change unconfirmed, and any
// other cause leaves the store unusable.
fn binding_store_words(cause: Option<&McpBindingStoreUnavailableCause>) -> &'static str {
    match cause {
        Some(McpBindingStoreUnavailableCause::ReceiptKey(McpReceiptKeyCause::ReceiptKeyLost)) => {
            "The change was not confirmed."
        }
        Some(
            McpBindingStoreUnavailableCause::AddressKey(_)
            | McpBindingStoreUnavailableCause::Keychain(_),
        )
        | None => {
            "the MCP binding store cannot be reached, so no MCP change can be made until it can"
        }
    }
}

/// Why an `mcp.server.signIn` launch opened no browser: an `mcp.*` refusal, or a provider's own
/// flow that failed before the browser opened for a cause its driver names, answered as the
/// driver's error is.
#[derive(Debug, thiserror::Error)]
pub enum SignInLaunchError {
    /// An `mcp.*` refusal.
    #[error(transparent)]
    Refused(#[from] McpRefusal),
    /// The provider's driver failed before the browser opened: a provider not installed, its
    /// process failing or too slow, or a fault of the daemon's own.
    #[error("a provider's own MCP sign-in failed before the browser opened")]
    Provider(#[source] DriverError),
}

impl From<SignInLaunchError> for HandlerError {
    /// An `mcp.*` refusal answers by its code, and a provider's failure as the driver's error
    /// answers.
    fn from(error: SignInLaunchError) -> Self {
        match error {
            SignInLaunchError::Refused(refusal) => Self::Refused(refusal.into()),
            SignInLaunchError::Provider(driver_error) => Self::from(driver_error),
        }
    }
}

impl From<McpRefusal> for DomainError {
    fn from(refusal: McpRefusal) -> Self {
        let message = refusal.to_string();
        let (code, detail, source) = match refusal {
            McpRefusal::BindingStoreUnavailable { cause, source } => (
                RefusalCode::McpBindingStoreUnavailable,
                cause.map(|cause| refusal_fields(json!({ "cause": cause }))),
                source,
            ),
            McpRefusal::IdempotencyConflict { binding } => (
                RefusalCode::McpServerIdempotencyConflict,
                Some(binding_fields(&binding)),
                None,
            ),
            McpRefusal::ServerConfigInvalid { .. } => {
                (RefusalCode::McpServerConfigInvalid, None, None)
            }
            McpRefusal::ServerConfigFileInvalid { details } => (
                RefusalCode::McpServerConfigFileInvalid,
                Some(config_file_invalid_fields(*details)),
                None,
            ),
            McpRefusal::ProviderRefusedWrite { binding, .. } => (
                RefusalCode::ProviderUnavailable,
                Some(binding_fields(&binding)),
                None,
            ),
            McpRefusal::ServerConfigWriteConflict { binding, conflict } => (
                RefusalCode::McpServerConfigWriteConflict,
                Some(write_conflict_fields(&binding, &conflict)),
                None,
            ),
            McpRefusal::ServerNotFound { binding } => (
                RefusalCode::McpServerNotFound,
                Some(binding_fields(&binding)),
                None,
            ),
            McpRefusal::ServerNotRunning { binding } => (
                RefusalCode::McpServerNotRunning,
                Some(binding_fields(&binding)),
                None,
            ),
            McpRefusal::ServerSignInFailed { binding, source } => (
                RefusalCode::McpServerSignInFailed,
                Some(binding_fields(&binding)),
                Some(source),
            ),
            McpRefusal::ServerSignInUnsupported { binding, .. } => (
                RefusalCode::McpServerSignInUnsupported,
                Some(binding_fields(&binding)),
                None,
            ),
            McpRefusal::ServerSignOutFailed { binding, source } => {
                return Self {
                    message,
                    ..Self::keychain_refused(
                        *source,
                        RefusalCode::McpServerSignOutFailed,
                        |cause| {
                            let mut fields = binding_fields(&binding);
                            fields.extend(refusal_fields(json!({ "cause": cause })));
                            fields
                        },
                    )
                };
            }
        };
        DomainError {
            message,
            code,
            detail: detail.map(Box::new),
            source,
        }
    }
}

// The binding as a message names it: its server, scope and provider, never its reference.
fn binding_words(binding: &McpServerBindingRef) -> String {
    let key = McpBindingKey::of(binding);
    format!(
        "MCP server {} ({} scope, provider {})",
        key.server_name.as_str(),
        <&'static str>::from(key.scope),
        key.provider.as_str()
    )
}

// The binding's path-free audit ref, `{provider, scope, serverName}`.
fn binding_fields(binding: &McpServerBindingRef) -> Map<String, Value> {
    let key = McpBindingKey::of(binding);
    refusal_fields(json!({
        "provider": key.provider.as_str(),
        "scope": <&'static str>::from(key.scope),
        "serverName": key.server_name.as_str(),
    }))
}

// The audit ref with the conflict's reason and, for a stale version, both versions.
fn write_conflict_fields(
    binding: &McpServerBindingRef,
    conflict: &McpConfigWriteConflict,
) -> Map<String, Value> {
    let conflict_fields = match conflict {
        McpConfigWriteConflict::StaleVersion {
            expected_version,
            current_version,
        } => json!({
            "reason": McpServerConfigWriteConflictReason::StaleVersion,
            "expectedVersion": expected_version,
            "currentVersion": current_version,
        }),
        McpConfigWriteConflict::ConfigFileChanged => {
            json!({ "reason": McpServerConfigWriteConflictReason::ConfigFileChanged })
        }
        McpConfigWriteConflict::EntryChanged => {
            json!({ "reason": McpServerConfigWriteConflictReason::EntryChanged })
        }
    };
    let mut fields = binding_fields(binding);
    fields.extend(refusal_fields(conflict_fields));
    fields
}

// The audit ref with the config's layer paths, the one detail that names a path on this machine.
fn config_file_invalid_fields(details: McpConfigFileInvalid) -> Map<String, Value> {
    let key = McpBindingKey::of(&details.binding);
    refusal_fields(McpServerConfigFileInvalidDetails {
        provider: key.provider,
        scope: key.scope,
        server_name: key.server_name,
        config_files: details.config_files,
    })
}
