//! The service that adds, removes and switches a binding in its provider's own config. Each
//! mutation reads the receipt key, takes its idempotency key's lock, answers a retry from its saved
//! receipt, checks the mutation against what the provider declares, writes its receipt `pending`,
//! then writes the provider's config and settles the receipt by what the config holds afterwards,
//! committing the binding's rows in the receipt's own write. A switch the daemon keeps is committed
//! with no provider call. Each committed change sends `mcp.server.config.changed` for its binding.
//! The sign-in and sign-out commands take the same key, lock and saved check, and a command's
//! receipt a stop left `pending` is expired, since a command writes no config to settle against.

use std::error::Error;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use futures::future::BoxFuture;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use sidekicks_contracts::mcp::governance::{
    McpServerDelete, McpServerEnabledUpdate, McpServerUpsert,
};
use sidekicks_contracts::mcp::server::config::McpServerConfigInput;
use sidekicks_contracts::mcp::server::inventory::McpServerInventoryEntry;
use sidekicks_contracts::mcp::server::requests::{
    McpServerDeleteRequest, McpServerDeleteResponse, McpServerMutationResponse,
    McpServerUpsertRequest,
};
use sidekicks_contracts::mcp::server::{McpApplicationGrade, McpServerBindingRef};
use sidekicks_contracts::method::Method;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::descriptor_of;
use sidekicks_provider::driver::mcp_server::read::McpServerDeclaration;
use sidekicks_provider::driver::mcp_server::write::{
    McpServerObserved, McpServerObservedEntry, McpServerWrite, McpServerWriteOutcome,
};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};
use sidekicks_store::credential_store::SecretKeychain;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::statement::WriteStatement;
use sidekicks_store::database::writer::DatabaseWriter;

use crate::binding::store::{
    McpBindingKey, McpBindingLanding, record_binding_statement, remove_binding_statement,
};
use crate::errors::McpRefusal;
use crate::inventory_service::{McpInventoryService, failure_reason_text};
use crate::mutation::preflight::{McpMutationCheck, check_mutation};
use crate::mutation::receipt_key::{MCP_RECEIPT_KEY_STATEMENT_CAPACITY, McpReceiptKeys};
use crate::mutation::receipts::{
    MCP_MUTATION_RECEIPTS_STATEMENT_CAPACITY, McpIntentReceipt, McpMutationReceipts,
    McpReceiptDigest, McpReceiptKey, McpSavedCheck,
};
use crate::mutation::reconciler::McpIntentSettlement;
use crate::mutation::saved_answer::McpSavedAnswer;
use crate::mutation::service::command::{McpCommand, McpCommandSettler};
use crate::mutation::settle::{
    McpIntentSettler, McpIntentSettlers, McpLandedCommit, McpPendingSettle, apply_settlement,
    commit_refusal, observe_settlement, rebuilt_binding, store_unavailable,
};
use crate::mutation::write_refusal::mcp_refusal_of_write;
use crate::status::notices::McpNoticeBoard;

/// The distinct statements the mutation service keeps prepared on each read connection: its
/// receipts' and its receipt key's, beside the inventory's it reads through.
pub const MCP_MUTATION_SERVICE_STATEMENT_CAPACITY: usize =
    MCP_MUTATION_RECEIPTS_STATEMENT_CAPACITY + MCP_RECEIPT_KEY_STATEMENT_CAPACITY;

/// The rows a binding's removal commits beside its own, in the receipt's write, from the binding
/// alone, so a removal settled at the daemon's start commits what the live one does.
pub type McpRemovalRows = Arc<dyn Fn(&McpBindingKey) -> Vec<WriteStatement> + Send + Sync>;

/// The daemon's words when the provider's config could not be read before a write.
const CONFIG_UNREAD_WORDS: &str = "the provider's config could not be read, so nothing was written";

/// The daemon's words when the provider's servers could not be read to check a change.
const DECLARATIONS_UNREAD_WORDS: &str =
    "the provider's MCP servers could not be read, so nothing was written";

/// The daemon's words when the provider's entry for the binding has no form a receipt compares.
const UNCOMPARABLE_ENTRY_WORDS: &str =
    "the provider's config holds an entry the daemon cannot compare, so nothing was written";

/// The daemon's words when the provider holds the change but its row could not be read back.
const ROW_UNREAD_WORDS: &str =
    "the provider holds the change, but its server could not be read back, so send it again";

/// The daemon's words when the server's row could not be read before a change was written.
const ROW_UNREAD_BEFORE_WRITE_WORDS: &str = "the server could not be read, so nothing was written";

/// What the mutation service reads and writes through.
pub struct McpMutationSources {
    /// The registered providers, each with its driver.
    pub providers: Arc<ProviderRegistry>,
    /// The inventory each response's row and each check's declarations are read from.
    pub inventory: Arc<McpInventoryService>,
    /// The receipt key's keychain service.
    pub keychain: Arc<dyn SecretKeychain>,
    /// The writer every receipt and binding row goes through.
    pub writer: Arc<DatabaseWriter>,
    /// The read pool the receipts and the receipt key's pin are read on.
    pub reads: Arc<DatabaseReadPool>,
    /// The rows a removal commits beside the binding's own; `None` commits none.
    pub removal_rows: Option<McpRemovalRows>,
    /// The board each committed change's `mcp.server.config.changed` is sent on.
    pub board: Arc<McpNoticeBoard>,
}

/// Adds, removes and switches the bindings in their providers' own configs, each change answered
/// once per idempotency key, and settles the changes a stop left unfinished.
pub struct McpMutationService {
    /// What every mutation and settle reaches, shared with the settlers.
    parts: Arc<McpMutationParts>,
    /// The receipt key, read before any idempotency key's lock is taken.
    receipt_keys: Arc<McpReceiptKeys>,
    /// The idempotency keys' locks, shared with the receipt key's read and the pending pass.
    key_locks: Arc<KeyedLock<ClientUuid>>,
    /// The pass over the receipts a stop left `pending`.
    pending: McpPendingSettle,
}

/// What a mutation and a settle reach: the drivers, the inventory, the receipts, the removal's
/// extra rows and the notice board.
struct McpMutationParts {
    /// The registered providers, each with its driver.
    providers: Arc<ProviderRegistry>,
    /// The inventory rows and declarations are read from.
    inventory: Arc<McpInventoryService>,
    /// The mutations' receipts.
    receipts: McpMutationReceipts,
    /// The rows a removal commits beside the binding's own.
    removal_rows: Option<McpRemovalRows>,
    /// The board each committed change's notice is sent on.
    board: Arc<McpNoticeBoard>,
    /// Whether an unfinished change whose provider is not registered was logged, once a daemon.
    is_unregistered_provider_logged: AtomicBool,
}

/// A governance mutation's operation, as its receipt names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum McpOperation {
    /// `mcp.server.upsert`.
    Upsert,
    /// `mcp.server.delete`.
    Delete,
    /// `mcp.server.enabled.update`.
    SetEnabled,
}

impl McpOperation {
    // The wire method the operation's receipts are spent on.
    fn method(self) -> &'static str {
        match self {
            Self::Upsert => McpServerUpsert::DESCRIPTOR.method,
            Self::Delete => McpServerDelete::DESCRIPTOR.method,
            Self::SetEnabled => McpServerEnabledUpdate::DESCRIPTOR.method,
        }
    }
}

/// What a receipt is spent on: a governance mutation, settled against its provider's config, or
/// a command, whose `pending` receipt is expired.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum McpReceiptOperation {
    /// A governance mutation.
    Mutation(McpOperation),
    /// A sign-in or sign-out command.
    Command(McpCommand),
}

impl McpReceiptOperation {
    // The wire method the receipt is spent on.
    fn method(self) -> &'static str {
        match self {
            Self::Mutation(operation) => operation.method(),
            Self::Command(command) => command.method(),
        }
    }
}

/// How a mutation goes on once its idempotency key is held: answered from its receipt, or run
/// fresh under the hold.
enum McpMutationStart<'lock> {
    /// The receipt answered: its saved answer, or its pending change settled.
    Answered(Value),
    /// The key has no receipt: the mutation runs while the hold lasts.
    Fresh {
        /// The receipt key every digest of the mutation is taken under.
        receipt_key: Arc<McpReceiptKey>,
        /// The digest of the request under its idempotency key.
        request_digest: McpReceiptDigest,
        /// The idempotency key's lock, held until the mutation answers.
        hold: KeyHold<'lock, ClientUuid>,
    },
}

impl McpMutationService {
    /// The service over `sources`, a settler for each mutation and each command registered with
    /// the pass over `pending` receipts; nothing is read until the first call or
    /// [`Self::settle_pending`].
    pub fn new(sources: McpMutationSources) -> Self {
        let receipts =
            McpMutationReceipts::new(Arc::clone(&sources.writer), Arc::clone(&sources.reads));
        let receipt_keys = Arc::new(McpReceiptKeys::new(
            sources.keychain,
            receipts.clone(),
            sources.reads,
            sources.writer,
        ));
        let key_locks = Arc::new(KeyedLock::new());
        let parts = Arc::new(McpMutationParts {
            providers: sources.providers,
            inventory: sources.inventory,
            receipts: receipts.clone(),
            removal_rows: sources.removal_rows,
            board: sources.board,
            is_unregistered_provider_logged: AtomicBool::new(false),
        });
        let mutation_settlers = [
            McpOperation::Upsert,
            McpOperation::Delete,
            McpOperation::SetEnabled,
        ]
        .map(|operation| {
            let settler = McpOperationSettler {
                parts: Arc::clone(&parts),
                operation,
            };
            (
                operation.method(),
                Box::new(settler) as Box<dyn McpIntentSettler>,
            )
        });
        let command_settlers = [McpCommand::SignIn, McpCommand::SignOut].map(|command| {
            let settler = McpCommandSettler {
                receipts: receipts.clone(),
            };
            (
                command.method(),
                Box::new(settler) as Box<dyn McpIntentSettler>,
            )
        });
        let settlers =
            McpIntentSettlers::new(mutation_settlers.into_iter().chain(command_settlers));
        let pending = McpPendingSettle::new(
            receipts,
            Arc::clone(&receipt_keys),
            Arc::clone(&key_locks),
            settlers,
        );
        Self {
            parts,
            receipt_keys,
            key_locks,
            pending,
        }
    }

    /// Adds `request`'s binding to its provider's config or changes its declaration, answering the
    /// row as it then stands. Refuses as the receipt key or the receipts cannot be used, as the
    /// key was spent on another request, as the declaration fails its checks, and as the provider
    /// refuses or cannot be read.
    pub async fn upsert(
        &self,
        request: McpServerUpsertRequest,
    ) -> Result<McpServerMutationResponse, DomainError> {
        let binding = request.binding();
        let writable = request.writable_binding();
        let (idempotency_key, config) = match &request {
            McpServerUpsertRequest::User {
                client_idempotency_key,
                config,
                ..
            }
            | McpServerUpsertRequest::Project {
                client_idempotency_key,
                config,
                ..
            }
            | McpServerUpsertRequest::Local {
                client_idempotency_key,
                config,
                ..
            } => (client_idempotency_key, config),
        };
        let operation = McpOperation::Upsert;
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
        let check = McpMutationCheck::Upsert {
            binding: &writable,
            config,
        };
        check_mutation(&check, &bindings_of(&declarations))?;
        let driver = self.parts.driver(&binding)?;
        let before = observe_before(driver, &binding).await?;
        let entry = driver
            .compose_mcp_server(&writable, config, &before)
            .map_err(|refusal| mcp_refusal_of_write(&binding, refusal, &before))?;
        let key = McpBindingKey::of(&binding);
        let after_digest = receipt_key
            .digest_declaration(idempotency_key, &key, entry.members())
            .map_err(|error| {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "a composed MCP entry has no canonical form, so its change is not made"
                );
                McpRefusal::ServerConfigInvalid {
                    reason: "the declaration has no canonical form".to_owned(),
                }
            })?;
        let intent = McpIntentReceipt {
            idempotency_key: idempotency_key.clone(),
            operation: operation.method().to_owned(),
            before_digest: before_digest(&receipt_key, idempotency_key, &key, &before, &binding)?,
            binding: key,
            request_digest,
            after_digest: Some(after_digest),
            wanted_enabled: emulated_local_switch(&binding, config, &before),
        };
        let write = McpServerWrite::Upsert {
            binding: writable,
            entry,
        };
        let answer = self
            .parts
            .write_and_settle(operation, driver, &intent, &receipt_key, write, before)
            .await?;
        response_of(answer)
    }

    /// Removes `request`'s binding from its provider's config, committing the removal's rows in
    /// the receipt's write. Refuses as [`Self::upsert`] does, and where the provider declares no
    /// such binding.
    pub async fn delete(
        &self,
        request: McpServerDeleteRequest,
    ) -> Result<McpServerDeleteResponse, DomainError> {
        let binding = request.binding();
        let writable = request.writable_binding();
        let (McpServerDeleteRequest::User {
            client_idempotency_key: idempotency_key,
            ..
        }
        | McpServerDeleteRequest::Project {
            client_idempotency_key: idempotency_key,
            ..
        }
        | McpServerDeleteRequest::Local {
            client_idempotency_key: idempotency_key,
            ..
        }) = &request;
        let operation = McpOperation::Delete;
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
        let check = McpMutationCheck::Remove { binding: &writable };
        check_mutation(&check, &bindings_of(&declarations))?;
        let driver = self.parts.driver(&binding)?;
        let before = observe_before(driver, &binding).await?;
        let key = McpBindingKey::of(&binding);
        let intent = McpIntentReceipt {
            idempotency_key: idempotency_key.clone(),
            operation: operation.method().to_owned(),
            before_digest: before_digest(&receipt_key, idempotency_key, &key, &before, &binding)?,
            binding: key,
            request_digest,
            after_digest: None,
            wanted_enabled: None,
        };
        let write = McpServerWrite::Remove { binding: writable };
        let answer = self
            .parts
            .write_and_settle(operation, driver, &intent, &receipt_key, write, before)
            .await?;
        response_of(answer)
    }

    /// Starts the pass over the receipts a stop left `pending` in the background, as the daemon's
    /// start does; nothing starts while one runs.
    pub fn settle_pending(&self) {
        self.pending.request();
    }

    /// Closes the pass over the `pending` receipts' task tracker, so no pass starts after it, a
    /// mutation's owed request included, and waits for a running pass to end; the daemon's stop
    /// calls it under its own deadline before the drivers shut down.
    pub async fn stop(&self) {
        self.pending.stop().await;
    }

    // A receipted call's first steps, in their order: the receipt key, then `idempotency_key`'s
    // lock, then its receipt's answer, a mutation's pending one settled under the lock and a
    // command's expired, so the command runs fresh under it.
    async fn start(
        &self,
        operation: McpReceiptOperation,
        idempotency_key: &ClientUuid,
        request: &impl Serialize,
        binding: &McpServerBindingRef,
    ) -> Result<McpMutationStart<'_>, DomainError> {
        let receipt_key = self
            .receipt_keys
            .read(&self.key_locks)
            .await
            .map_err(McpRefusal::from)?;
        self.pending.request_if_owed();
        let hold = self.key_locks.acquire(idempotency_key.clone()).await;
        let request = serde_json::to_value(request).expect("a request writes as JSON");
        let request_digest = receipt_key
            .digest_request(idempotency_key, operation.method(), &request)
            .map_err(|error| {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "an MCP change's request has no canonical form, so it is not made"
                );
                McpRefusal::ServerConfigInvalid {
                    reason: "the request has no canonical form".to_owned(),
                }
            })?;
        let saved = self
            .parts
            .receipts
            .check_saved(idempotency_key, &request_digest)
            .await
            .map_err(store_unavailable)?;
        match saved {
            McpSavedCheck::Fresh => Ok(McpMutationStart::Fresh {
                receipt_key,
                request_digest,
                hold,
            }),
            McpSavedCheck::Saved(saved) => {
                let saved: McpSavedAnswer =
                    serde_json::from_value(saved).map_err(stored_answer_unreadable)?;
                saved.into_domain_error().map(McpMutationStart::Answered)
            }
            McpSavedCheck::Conflict => Err(McpRefusal::IdempotencyConflict {
                binding: Box::new(binding.clone()),
            }
            .into()),
            McpSavedCheck::Pending(intent) => match operation {
                McpReceiptOperation::Mutation(operation) => {
                    let settlement = self
                        .parts
                        .settlement(operation, &intent, &receipt_key)
                        .await;
                    self.parts
                        .commit_settlement(operation, &intent, settlement, None)
                        .await
                        .map(McpMutationStart::Answered)
                }
                McpReceiptOperation::Command(_) => {
                    self.parts
                        .receipts
                        .expire(idempotency_key)
                        .await
                        .map_err(store_unavailable)?;
                    Ok(McpMutationStart::Fresh {
                        receipt_key,
                        request_digest,
                        hold,
                    })
                }
            },
        }
    }
}

impl McpMutationParts {
    // The driver of `binding`'s provider; refused as not found where it is not registered.
    fn driver(&self, binding: &McpServerBindingRef) -> Result<&dyn ProviderDriver, McpRefusal> {
        self.providers
            .drivers()
            .find(|(provider, _driver)| *provider == binding.provider())
            .map(|(_provider, driver)| driver.as_ref())
            .ok_or_else(|| McpRefusal::ServerNotFound {
                binding: Box::new(binding.clone()),
            })
    }

    // Every declaration of `binding`'s provider, which a mutation's checks read.
    async fn read_declarations(
        &self,
        binding: &McpServerBindingRef,
    ) -> Result<Vec<McpServerDeclaration>, McpRefusal> {
        self.inventory
            .read_declarations(binding.provider())
            .await
            .map_err(|error| {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    provider = binding.provider().as_str(),
                    "the provider's MCP servers could not be read to check an MCP change"
                );
                McpRefusal::ProviderRefusedWrite {
                    binding: Box::new(binding.clone()),
                    words: DECLARATIONS_UNREAD_WORDS.to_owned(),
                }
            })
    }

    // `binding`'s inventory row as it now stands, or as `landing`'s row will leave it; refused as
    // the provider's with `words`, which say whether the change was written, where it cannot be
    // read.
    async fn read_row(
        &self,
        binding: &McpServerBindingRef,
        landing: Option<McpBindingLanding<'_>>,
        words: &str,
    ) -> Result<McpServerInventoryEntry, McpRefusal> {
        let read = match landing {
            Some(landing) => self.inventory.read_landed(landing).await,
            None => self.inventory.read(binding).await,
        };
        read.map_err(|error| {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                provider = binding.provider().as_str(),
                "an MCP server's row could not be read for its change's answer"
            );
            McpRefusal::ProviderRefusedWrite {
                binding: Box::new(binding.clone()),
                words: words.to_owned(),
            }
        })
    }

    // Begins `intent`, writes `write` against `before` and answers by its outcome: a refusal
    // committed and answered with no notice, any other outcome settled by what the config then
    // holds.
    async fn write_and_settle(
        &self,
        operation: McpOperation,
        driver: &dyn ProviderDriver,
        intent: &McpIntentReceipt,
        receipt_key: &McpReceiptKey,
        write: McpServerWrite,
        before: McpServerObserved,
    ) -> Result<Value, DomainError> {
        self.receipts
            .begin(intent)
            .await
            .map_err(store_unavailable)?;
        let reload_failure = match driver.write_mcp_server(write, before.clone()).await {
            McpServerWriteOutcome::Refused(refusal) => {
                let binding = rebuilt_binding(intent)?;
                let refusal = mcp_refusal_of_write(&binding, refusal, &before);
                return commit_refusal(&self.receipts, &intent.idempotency_key, refusal).await;
            }
            McpServerWriteOutcome::Applied { reload_failure } => reload_failure,
            McpServerWriteOutcome::Unknown => None,
        };
        let settlement = observe_settlement(driver, receipt_key, intent).await;
        self.commit_settlement(operation, intent, settlement, reload_failure)
            .await
    }

    // How `intent`, a `pending` receipt of `operation` whose idempotency key's lock the caller
    // holds, settles against what its provider's config holds; a switch the daemon keeps never
    // reached the provider, so its receipt is unlanded.
    async fn settlement(
        &self,
        operation: McpOperation,
        intent: &McpIntentReceipt,
        receipt_key: &McpReceiptKey,
    ) -> McpIntentSettlement {
        match self.driver_of_intent(intent) {
            None => McpIntentSettlement::NoDriver,
            Some(driver) if operation == McpOperation::SetEnabled => {
                match self.is_switch_kept_by_daemon(intent).await {
                    Some(true) => McpIntentSettlement::Unlanded,
                    Some(false) => observe_settlement(driver, receipt_key, intent).await,
                    None => McpIntentSettlement::Unsettled,
                }
            }
            Some(driver) => observe_settlement(driver, receipt_key, intent).await,
        }
    }

    // Answers `intent` by `settlement` and keeps its receipt so, sending the binding's
    // config-changed notice once a landed change is committed. The binding is rebuilt from the
    // stored key first, so a key that no longer reads as one refuses with the receipt `pending`
    // rather than committing a change no notice can name.
    async fn commit_settlement(
        &self,
        operation: McpOperation,
        intent: &McpIntentReceipt,
        settlement: McpIntentSettlement,
        reload_failure: Option<String>,
    ) -> Result<Value, DomainError> {
        let binding = rebuilt_binding(intent)?;
        let response = apply_settlement(&self.receipts, intent, settlement, || {
            self.landed(operation, intent, &binding, reload_failure)
        })
        .await?;
        self.board.send_config_changed(&binding);
        Ok(response)
    }

    // The driver of `intent`'s provider; `None` where it is not registered, logged the first time.
    fn driver_of_intent(&self, intent: &McpIntentReceipt) -> Option<&dyn ProviderDriver> {
        let driver = self
            .providers
            .drivers()
            .find(|(provider, _driver)| **provider == intent.binding.provider)
            .map(|(_provider, driver)| driver.as_ref());
        if driver.is_none()
            && !self
                .is_unregistered_provider_logged
                .swap(true, Ordering::AcqRel)
        {
            tracing::warn!(
                provider = intent.binding.provider.as_str(),
                "an unfinished MCP change's provider is not registered, so it stays unsettled"
            );
        }
        driver
    }

    // What a landed `intent` of `operation` on `binding` commits: the binding's rows, and the
    // response the receipt saves, which carries `reload_failure` capped as a failure reason.
    async fn landed(
        &self,
        operation: McpOperation,
        intent: &McpIntentReceipt,
        binding: &McpServerBindingRef,
        reload_failure: Option<String>,
    ) -> Result<McpLandedCommit, DomainError> {
        let reload_failure = reload_failure.and_then(|text| failure_reason_text(&text));
        let key = &intent.binding;
        let commit = match operation {
            McpOperation::Upsert | McpOperation::SetEnabled => {
                // A switch the provider keeps leaves the daemon's as it stands.
                let landing = McpBindingLanding {
                    binding,
                    enabled_override: intent.wanted_enabled.filter(|_| !intent.is_switch()),
                };
                // Read with the row laid over, since it commits only with the answer.
                let server = self
                    .read_row(binding, Some(landing), ROW_UNREAD_WORDS)
                    .await?;
                McpLandedCommit {
                    response: response_value(&McpServerMutationResponse {
                        server,
                        applied: McpApplicationGrade::UserConfigWrite,
                        live_results: None,
                        reload_failure,
                    }),
                    rows: vec![record_binding_statement(key, landing.enabled_override)],
                }
            }
            McpOperation::Delete => {
                let mut rows = vec![remove_binding_statement(key)];
                if let Some(removal_rows) = &self.removal_rows {
                    rows.extend(removal_rows(key));
                }
                McpLandedCommit {
                    response: response_value(&McpServerDeleteResponse {
                        applied: McpApplicationGrade::UserConfigWrite,
                        live_results: None,
                        reload_failure,
                    }),
                    rows,
                }
            }
        };
        Ok(commit)
    }
}

/// One operation's settler, run by the pass over the `pending` receipts.
struct McpOperationSettler {
    /// What the settle reaches.
    parts: Arc<McpMutationParts>,
    /// The operation whose receipts it settles.
    operation: McpOperation,
}

impl McpIntentSettler for McpOperationSettler {
    fn settle(
        &self,
        intent: McpIntentReceipt,
        key: Arc<McpReceiptKey>,
    ) -> BoxFuture<'_, McpIntentSettlement> {
        Box::pin(async move {
            let settlement = self.parts.settlement(self.operation, &intent, &key).await;
            if let Err(refusal) = self
                .parts
                .commit_settlement(self.operation, &intent, settlement, None)
                .await
            {
                tracing::warn!(
                    error = &refusal as &(dyn Error + 'static),
                    operation = intent.operation.as_str(),
                    "an unfinished MCP change was answered with a refusal when it was settled"
                );
            }
            settlement
        })
    }
}

// What the provider's config holds for `binding` before a write; refused as the provider's where
// it cannot be read.
async fn observe_before(
    driver: &dyn ProviderDriver,
    binding: &McpServerBindingRef,
) -> Result<McpServerObserved, McpRefusal> {
    driver
        .observe_mcp_server(binding.clone())
        .await
        .map_err(|error| {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                provider = binding.provider().as_str(),
                "the provider's config could not be read before an MCP change"
            );
            McpRefusal::ProviderRefusedWrite {
                binding: Box::new(binding.clone()),
                words: CONFIG_UNREAD_WORDS.to_owned(),
            }
        })
}

// The daemon's switch an upsert of `binding` sets where its provider keeps a `local` server as
// an off user entry: the switch `config` asks for, on for a server not there `before`, else the
// one kept; `None` for every other binding, whose switch the provider keeps.
fn emulated_local_switch(
    binding: &McpServerBindingRef,
    config: &McpServerConfigInput,
    before: &McpServerObserved,
) -> Option<bool> {
    let is_emulated = matches!(binding, McpServerBindingRef::Local { .. })
        && descriptor_of(binding.provider().as_str())
            .is_some_and(|descriptor| descriptor.is_mcp_local_scope_emulated);
    if !is_emulated {
        return None;
    }
    config
        .enabled()
        .or_else(|| matches!(before.entry, McpServerObservedEntry::Absent).then_some(true))
}

// The digest of the declaration `before` holds for `key`, `None` where it holds none; refused as
// the provider's where the entry has no canonical form.
fn before_digest(
    receipt_key: &McpReceiptKey,
    idempotency_key: &ClientUuid,
    key: &McpBindingKey,
    before: &McpServerObserved,
    binding: &McpServerBindingRef,
) -> Result<Option<McpReceiptDigest>, McpRefusal> {
    match &before.entry {
        McpServerObservedEntry::Present(entry) => receipt_key
            .digest_declaration(idempotency_key, key, entry.members())
            .map(Some)
            .map_err(|error| {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    provider = binding.provider().as_str(),
                    "an observed MCP entry has no canonical form, so its change is not made"
                );
                McpRefusal::ProviderRefusedWrite {
                    binding: Box::new(binding.clone()),
                    words: UNCOMPARABLE_ENTRY_WORDS.to_owned(),
                }
            }),
        McpServerObservedEntry::Absent | McpServerObservedEntry::Switch(_) => Ok(None),
    }
}

// The bindings `declarations` declare, which a mutation's checks compare against.
fn bindings_of(declarations: &[McpServerDeclaration]) -> Vec<McpServerBindingRef> {
    declarations
        .iter()
        .map(|declaration| declaration.binding.clone())
        .collect()
}

/// A response as its receipt saves it and the wire carries it.
pub(crate) fn response_value(response: &impl Serialize) -> Value {
    serde_json::to_value(response).expect("a mutation's response writes as JSON")
}

/// `answer`, a response the service built or a receipt saved, as the method's response; a saved
/// one that no longer reads as it fails closed.
pub(crate) fn response_of<Response: DeserializeOwned>(
    answer: Value,
) -> Result<Response, DomainError> {
    serde_json::from_value(answer).map_err(|error| stored_answer_unreadable(error).into())
}

// The refusal of a saved answer that does not read back, the failure kept underneath.
fn stored_answer_unreadable(error: serde_json::Error) -> McpRefusal {
    McpRefusal::BindingStoreUnavailable {
        cause: None,
        source: Some(Box::new(error)),
    }
}

pub(crate) mod command;
mod switch;
#[cfg(test)]
mod tests;
