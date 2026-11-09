//! The switch of a binding: in the provider's own config where the provider keeps it, settled as
//! every write to that config is, else in the daemon's store, committed with its receipt and no
//! provider call, its config-changed notice sent once the commit lands.

use std::error::Error;

use serde_json::Value;
use sidekicks_contracts::mcp::server::inventory::{
    McpAnsweredInventoryEntry, McpOverrideOrigin, McpServerInventoryEntry,
};
use sidekicks_contracts::mcp::server::requests::{
    McpServerEnabledUpdateRequest, McpServerMutationResponse,
};
use sidekicks_contracts::mcp::server::{McpApplicationGrade, McpServerBindingRef};
use sidekicks_contracts::place::PlacedPath;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::list::UniqueList;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_provider::driver::mcp_server::write::McpServerWrite;

use super::{
    McpMutationParts, McpMutationService, McpMutationStart, McpOperation, McpReceiptOperation,
    ROW_UNREAD_BEFORE_WRITE_WORDS, before_digest, bindings_of, observe_before, response_of,
    response_value,
};
use crate::binding::store::{
    McpBindingKey, PROJECT_SWITCH_SCOPES, enabled_override_statement, project_switch_statements,
};
use crate::mutation::preflight::{McpMutationCheck, check_mutation};
use crate::mutation::receipts::McpIntentReceipt;
use crate::mutation::saved_answer::McpSavedAnswer;
use crate::mutation::settle::{saved_value, store_unavailable};

/// Where a switch the daemon keeps lives: its own switch over the binding, or its switch of a
/// provider's own server in one project.
enum McpDaemonSwitch {
    /// The daemon's switch over the binding.
    Binding,
    /// The daemon's switch of a connector or an organization's server in this project.
    Project(PlacedPath),
}

impl McpMutationService {
    /// Switches `request`'s binding on or off: in the provider's config where it keeps the switch,
    /// else in the daemon's own store with no provider call. Refuses as [`Self::delete`] does.
    pub async fn set_enabled(
        &self,
        request: McpServerEnabledUpdateRequest,
    ) -> Result<McpServerMutationResponse, DomainError> {
        let binding = request.binding();
        let (idempotency_key, wanted, project_root) = switch_parts(&request);
        let operation = McpOperation::SetEnabled;
        let (receipt_key, request_digest, _hold) = match self
            .start(
                McpReceiptOperation::Mutation(operation),
                idempotency_key,
                &request,
                &binding,
            )
            .await?
        {
            McpMutationStart::Answered(answer) => return response_of(answer),
            McpMutationStart::Fresh {
                receipt_key,
                request_digest,
                hold,
            } => (receipt_key, request_digest, hold),
        };
        let declarations = self.parts.read_declarations(&binding).await?;
        let check = McpMutationCheck::SetEnabled { binding: &binding };
        check_mutation(&check, &bindings_of(&declarations))?;
        let key = McpBindingKey::of(&binding);
        let mut intent = McpIntentReceipt {
            idempotency_key: idempotency_key.clone(),
            operation: operation.method().to_owned(),
            binding: key,
            request_digest,
            before_digest: None,
            after_digest: None,
            wanted_enabled: Some(wanted),
        };
        let daemon_switch = match project_root {
            Some(project_root) => Some(McpDaemonSwitch::Project(project_root)),
            None => declarations
                .iter()
                .any(|declaration| {
                    declaration.binding == binding && declaration.is_switch_kept_by_daemon
                })
                .then_some(McpDaemonSwitch::Binding),
        };
        if let Some(daemon_switch) = daemon_switch {
            let answer = self
                .parts
                .commit_daemon_switch(&intent, &binding, wanted, daemon_switch)
                .await?;
            return response_of(answer);
        }
        let driver = self.parts.driver(&binding)?;
        let before = observe_before(driver, &binding).await?;
        intent.before_digest = before_digest(
            &receipt_key,
            idempotency_key,
            &intent.binding,
            &before,
            &binding,
        )?;
        let write = McpServerWrite::SetEnabled {
            binding,
            is_enabled: wanted,
        };
        let answer = self
            .parts
            .write_and_settle(operation, driver, &intent, &receipt_key, write, before)
            .await?;
        response_of(answer)
    }
}

impl McpMutationParts {
    /// Whether the daemon keeps the switch `intent` changes: a provider's own server switched per
    /// project, or a binding its declaration says so of; `None` where the declarations cannot be
    /// read. A binding no longer declared reads as not, so the observe tells it is gone.
    pub(super) async fn is_switch_kept_by_daemon(&self, intent: &McpIntentReceipt) -> Option<bool> {
        if PROJECT_SWITCH_SCOPES.contains(&intent.binding.scope) {
            return Some(true);
        }
        match self
            .inventory
            .read_declarations(&intent.binding.provider)
            .await
        {
            Ok(declarations) => Some(declarations.iter().any(|declaration| {
                declaration.is_switch_kept_by_daemon
                    && McpBindingKey::of(&declaration.binding) == intent.binding
            })),
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    provider = intent.binding.provider.as_str(),
                    "the provider's MCP servers could not be read to settle a switch"
                );
                None
            }
        }
    }

    // Begins and commits `intent`, a switch the daemon keeps, with its switch rows and the row
    // read before the commit with the switch set as the same write sets it, then sends the
    // binding's config-changed notice.
    async fn commit_daemon_switch(
        &self,
        intent: &McpIntentReceipt,
        binding: &McpServerBindingRef,
        wanted: bool,
        daemon_switch: McpDaemonSwitch,
    ) -> Result<Value, DomainError> {
        let mut server = self
            .read_row(binding, None, ROW_UNREAD_BEFORE_WRITE_WORDS)
            .await?;
        let rows = match &daemon_switch {
            McpDaemonSwitch::Binding => {
                set_binding_switch(&mut server, wanted);
                vec![enabled_override_statement(&intent.binding, wanted)]
            }
            McpDaemonSwitch::Project(project_root) => {
                set_project_switch(&mut server, project_root, wanted);
                project_switch_statements(&intent.binding, project_root, wanted)
            }
        };
        let response = response_value(&McpServerMutationResponse {
            server,
            applied: McpApplicationGrade::NextRun,
            live_results: None,
            reload_failure: None,
        });
        self.receipts
            .begin(intent)
            .await
            .map_err(store_unavailable)?;
        let saved = saved_value(&McpSavedAnswer::Served {
            response: response.clone(),
        });
        self.receipts
            .commit(&intent.idempotency_key, &saved, rows)
            .await
            .map_err(store_unavailable)?;
        self.board.send_config_changed(binding);
        Ok(response)
    }
}

// A switch request's key, wanted state and, for a provider's own server, the project it applies
// in.
fn switch_parts(
    request: &McpServerEnabledUpdateRequest,
) -> (&ClientUuid, bool, Option<PlacedPath>) {
    match request {
        McpServerEnabledUpdateRequest::User {
            client_idempotency_key,
            enabled,
            ..
        }
        | McpServerEnabledUpdateRequest::Project {
            client_idempotency_key,
            enabled,
            ..
        }
        | McpServerEnabledUpdateRequest::Local {
            client_idempotency_key,
            enabled,
            ..
        }
        | McpServerEnabledUpdateRequest::Plugin {
            client_idempotency_key,
            enabled,
            ..
        } => (client_idempotency_key, *enabled, None),
        McpServerEnabledUpdateRequest::Connector {
            client_idempotency_key,
            enabled,
            project_root,
            place,
            ..
        }
        | McpServerEnabledUpdateRequest::Managed {
            client_idempotency_key,
            enabled,
            project_root,
            place,
            ..
        } => (
            client_idempotency_key,
            *enabled,
            Some(PlacedPath {
                path: project_root.clone(),
                place: place.clone(),
            }),
        ),
    }
}

// Sets the daemon's switch over the binding on `server`, a row the store answered for.
fn set_binding_switch(server: &mut McpServerInventoryEntry, wanted: bool) {
    match server {
        McpServerInventoryEntry::Answered(
            McpAnsweredInventoryEntry::User { enabled, .. }
            | McpAnsweredInventoryEntry::Project { enabled, .. }
            | McpAnsweredInventoryEntry::Local { enabled, .. }
            | McpAnsweredInventoryEntry::Plugin { enabled, .. }
            | McpAnsweredInventoryEntry::Connector { enabled, .. }
            | McpAnsweredInventoryEntry::Managed { enabled, .. },
        ) => *enabled = wanted,
        // A row read while the store did not answer leaves a switch the store keeps out.
        McpServerInventoryEntry::StoreUnavailable(_) => {}
    }
}

// Sets the daemon's switch of a provider's own server in `project_root` on `server`, where the
// row lists the projects it is switched off in.
fn set_project_switch(
    server: &mut McpServerInventoryEntry,
    project_root: &PlacedPath,
    wanted: bool,
) {
    let McpServerInventoryEntry::Answered(
        McpAnsweredInventoryEntry::Connector { disabled_in, .. }
        | McpAnsweredInventoryEntry::Managed { disabled_in, .. },
    ) = server
    else {
        // Only a provider's own server is switched per project, and a row read while the store
        // did not answer lists none of its projects.
        return;
    };
    let project = McpOverrideOrigin::Placed(project_root.clone());
    let mut places = disabled_in
        .take()
        .map(|places| places.as_slice().to_vec())
        .unwrap_or_default();
    places.retain(|place| *place != project);
    if !wanted {
        places.push(project);
    }
    *disabled_in = UniqueList::new(places);
}
