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
use sidekicks_contracts::project::ProjectId;
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
use crate::errors::McpRefusal;
use crate::mutation::preflight::{McpMutationCheck, check_mutation};
use crate::mutation::receipts::McpIntentReceipt;
use crate::mutation::saved_answer::McpSavedAnswer;
use crate::mutation::settle::{saved_value, store_unavailable};

/// Where a switch the daemon keeps lives: its own switch over the binding, or its switch of a
/// provider's own server in one project.
enum McpDaemonSwitch {
    /// The daemon's switch over the binding.
    Binding,
    /// The daemon's switch of a connector or an organization's server in the project `project_id`,
    /// whose root the request named.
    Project {
        /// The project's root, as the request named it.
        root: PlacedPath,
        /// The project, which the switch is kept under so it follows the project's folder.
        project_id: ProjectId,
    },
}

impl McpMutationService {
    /// Switches `request`'s binding on or off: in the provider's config where it keeps the switch,
    /// else in the daemon's own store with no provider call. Refuses as [`Self::delete`] does, and
    /// with [`McpRefusal::ProjectNotFound`] where a per-project switch names a root no attached
    /// project is at.
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
            Some(root) => Some(McpDaemonSwitch::Project {
                project_id: self.parts.attached_project_at(&binding, &root).await?,
                root,
            }),
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

    // The attached project at `root`, which a per-project switch of `binding` is kept under;
    // refused as not found where no attached project is at it, and as the store's where the
    // projects cannot be read.
    async fn attached_project_at(
        &self,
        binding: &McpServerBindingRef,
        root: &PlacedPath,
    ) -> Result<ProjectId, McpRefusal> {
        self.inventory
            .attached_project_at(root)
            .await
            .map_err(|error| McpRefusal::BindingStoreUnavailable {
                cause: None,
                source: Some(Box::new(error)),
            })?
            .ok_or_else(|| McpRefusal::ProjectNotFound {
                binding: Box::new(binding.clone()),
            })
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
            McpDaemonSwitch::Project { root, project_id } => {
                set_project_switch(&mut server, root, wanted);
                project_switch_statements(&intent.binding, *project_id, wanted)
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use futures::future::ready;
    use serde_json::json;
    use sidekicks_contracts::free_form_string::FilesystemPath;
    use sidekicks_contracts::mcp::server::config::McpServerConfigView;
    use sidekicks_contracts::mcp::server::inventory::{
        McpAnsweredInventoryEntry, McpOverrideOrigin, McpServerInventoryEntry,
    };
    use sidekicks_contracts::mcp::server::{McpApprovalMode, McpServerBindingRef};
    use sidekicks_contracts::place::PlacedPath;
    use sidekicks_contracts::repo::mount::RepoMountState;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_provider::driver::contract::MockProviderDriver;
    use sidekicks_provider::driver::mcp_server::read::{
        McpServerDeclaration, McpServerPolicy, McpServerToolDefaults, ProviderMcpServersReading,
    };
    use sidekicks_provider::driver::test_registry::first_provider;
    use sidekicks_workspace::test_rows::{PARENT_ROWS_AT, project_and_mount_rows};

    use super::super::tests::Fixture;
    use crate::mutation::receipts::tests::idempotency_key;

    /// A connector switched off for a project is still off for it once the project's folder
    /// moves: the switch is kept under the project, so the list names the folder it is at now.
    /// Killed by a switch kept under the folder's path, which the move leaves behind.
    #[tokio::test]
    async fn a_server_switched_off_for_a_project_stays_off_after_its_folder_moves() {
        let provider = first_provider();
        let connector = json!({
            "scope": "connector",
            "provider": provider.as_str(),
            "scopeRef": "account-1",
            "serverName": "slack",
        });
        let binding: McpServerBindingRef =
            serde_json::from_value(connector.clone()).expect("a connector binding");
        let mut driver = MockProviderDriver::new();
        let declared = binding.clone();
        driver.expect_read_mcp_servers().returning(move |_request| {
            Box::pin(ready(Ok(ProviderMcpServersReading {
                declarations: vec![McpServerDeclaration {
                    binding: declared.clone(),
                    config: McpServerConfigView::Http {
                        url: "https://mcp.example.com/slack".to_owned(),
                        url_query_param_names: None,
                        header_names: None,
                        bearer_token_env_var: None,
                        env_http_headers: None,
                        oauth_scopes: None,
                        oauth_resource: None,
                        enabled: None,
                        required: None,
                        startup_timeout_sec: None,
                        tool_timeout_sec: None,
                    },
                    superseded_in: Vec::new(),
                    disabled_in: Vec::new(),
                    is_read_only: true,
                    sign_in_settings: None,
                    is_switch_kept_by_daemon: false,
                    tool_defaults: McpServerToolDefaults::with_approval_mode(McpApprovalMode::Auto),
                    organization_managed: None,
                }],
                roots: Vec::new(),
                is_machine_managed: false,
                server_policy: McpServerPolicy::default(),
                account_servers: Vec::new(),
                probe_readings: Vec::new(),
            })))
        });
        let fixture = Fixture::new(vec![Arc::new(driver)], None).await;
        let project = mint_uuid_v7().to_string();
        for row in project_and_mount_rows(&project, None) {
            fixture.run(&row);
        }
        let mut switch_off = connector;
        switch_off["clientIdempotencyKey"] = json!(idempotency_key().as_str());
        switch_off["enabled"] = json!(false);
        switch_off["projectRoot"] = json!("/repos/app");

        fixture
            .service
            .set_enabled(serde_json::from_value(switch_off).expect("a switch request"))
            .await
            .expect("the switch is kept");
        // The move: the project's mount at the old folder ends and one at the new folder takes it.
        let detached = <&'static str>::from(RepoMountState::Detached);
        let moved = mint_uuid_v7();
        fixture.run(&format!(
            "UPDATE repo_mounts SET state = '{detached}' WHERE id = '{project}';
             INSERT INTO repo_mounts (id, machine_id, local_path, canonical_root, project_id,
               attached_at, updated_at)
             VALUES ('{moved}', 'machine', '/repos/moved', '/repos/moved', '{project}',
               '{PARENT_ROWS_AT}', '{PARENT_ROWS_AT}')"
        ));
        let server = fixture
            .service
            .parts
            .inventory
            .read(&binding)
            .await
            .expect("the connector is listed");

        let McpServerInventoryEntry::Answered(McpAnsweredInventoryEntry::Connector {
            disabled_in,
            ..
        }) = server
        else {
            panic!("the connector's answered entry: {server:?}");
        };
        let moved_root = PlacedPath {
            path: FilesystemPath::new("/repos/moved".to_owned()).expect("a path"),
            place: None,
        };
        assert_eq!(
            disabled_in.map(|places| places.as_slice().to_vec()),
            Some(vec![McpOverrideOrigin::Placed(moved_root)])
        );
    }
}
