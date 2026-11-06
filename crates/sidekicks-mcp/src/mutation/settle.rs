//! The settle of a governance mutation whose provider leg may or may not have landed: what the
//! provider's config holds for the receipt's binding is observed, digested and settled by the
//! reconciler's rule, and the receipt is answered by that settlement. Each receipt operation has
//! its settler, and one pass at a time hands every receipt a start or a stopped mutation left
//! `pending` to its settler, reading the receipt key before it lists or locks anything.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use futures::future::BoxFuture;
use serde_json::Value;
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::mcp_server::write::McpServerObservedEntry;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_store::database::statement::WriteStatement;
use tokio_util::task::TaskTracker;

use crate::errors::{McpConfigWriteConflict, McpRefusal};
use crate::mutation::receipt_key::McpReceiptKeys;
use crate::mutation::receipts::{
    McpIntentReceipt, McpMutationReceipts, McpReceiptKey, McpReceiptStoreError, McpSavedCheck,
};
use crate::mutation::reconciler::{
    McpDeclarationObservation, McpIntentSettlement, McpSwitchObservation, settle_declaration,
    settle_switch,
};
use crate::mutation::saved_answer::McpSavedAnswer;

/// The daemon's words when the provider's config holds what it held before the change.
const UNLANDED_WORDS: &str = "the change did not reach the provider's config, so send it again";

/// The daemon's words when the provider's config could not be read to tell whether the change
/// landed.
const UNSETTLED_WORDS: &str =
    "the provider's config could not be read to tell whether the change landed";

/// Settles the `pending` receipts of one operation, each saving its own answer.
pub(crate) trait McpIntentSettler: Send + Sync {
    /// Settles `intent`, a `pending` receipt of this settler's operation whose idempotency key's
    /// lock the caller holds, its digests taken under `key`, and answers the settlement it
    /// reached; a receipt it cannot settle yet stays `pending` and answers `Unsettled`, or
    /// `NoDriver` where no registered driver ever can.
    fn settle(
        &self,
        intent: McpIntentReceipt,
        key: Arc<McpReceiptKey>,
    ) -> BoxFuture<'_, McpIntentSettlement>;
}

/// Each receipt operation's settler, by the `mcp.*` method the receipt was spent on.
pub(crate) struct McpIntentSettlers(HashMap<&'static str, Box<dyn McpIntentSettler>>);

impl McpIntentSettlers {
    /// The registry holding each `(operation, settler)` of `settlers`.
    pub(crate) fn new(
        settlers: impl IntoIterator<Item = (&'static str, Box<dyn McpIntentSettler>)>,
    ) -> Self {
        Self(settlers.into_iter().collect())
    }

    // The settler of `operation`, if one is registered.
    fn settler(&self, operation: &str) -> Option<&dyn McpIntentSettler> {
        self.0.get(operation).map(Box::as_ref)
    }
}

/// What a landed mutation commits with its receipt: the response it answers and the rows it
/// writes in the same write.
pub(crate) struct McpLandedCommit {
    /// The response, as it goes on the wire.
    pub(crate) response: Value,
    /// The mutation's own rows.
    pub(crate) rows: Vec<WriteStatement>,
}

/// How `intent` settles against what `driver` observes for its binding, the declaration digested
/// under `key`. Answers `Unsettled` where the observe fails, the binding does not rebuild from its
/// stored key, the entry has no canonical form, or a declaration's binding is answered with a
/// switch.
pub(crate) async fn observe_settlement(
    driver: &dyn ProviderDriver,
    key: &McpReceiptKey,
    intent: &McpIntentReceipt,
) -> McpIntentSettlement {
    let observed = observe_entry(driver, intent).await;
    if let Some(wanted) = intent.wanted_enabled.filter(|_| intent.is_switch()) {
        let observation = match observed {
            Some(McpServerObservedEntry::Switch(is_enabled)) => {
                McpSwitchObservation::Switch(is_enabled)
            }
            Some(McpServerObservedEntry::Present(entry)) => {
                McpSwitchObservation::Switch(entry.switch())
            }
            Some(McpServerObservedEntry::Absent) => McpSwitchObservation::Absent,
            None => McpSwitchObservation::Unread,
        };
        return settle_switch(wanted, observation);
    }
    let observation = match observed {
        Some(McpServerObservedEntry::Present(entry)) => {
            match key.digest_declaration(&intent.idempotency_key, &intent.binding, entry.members())
            {
                Ok(digest) => McpDeclarationObservation::Present(digest),
                Err(error) => {
                    tracing::warn!(
                        error = &error as &(dyn std::error::Error + 'static),
                        operation = intent.operation.as_str(),
                        "an observed MCP entry has no canonical form, so its change stays unsettled"
                    );
                    McpDeclarationObservation::Unread
                }
            }
        }
        Some(McpServerObservedEntry::Absent) => McpDeclarationObservation::Absent,
        Some(McpServerObservedEntry::Switch(_)) => {
            tracing::warn!(
                operation = intent.operation.as_str(),
                "a provider answered a switch for a declared MCP binding, so its change stays \
                 unsettled"
            );
            McpDeclarationObservation::Unread
        }
        None => McpDeclarationObservation::Unread,
    };
    settle_declaration(
        intent.before_digest.as_ref(),
        intent.after_digest.as_ref(),
        &observation,
    )
}

// What the provider's config holds for `intent`'s binding; `None` where the binding does not
// rebuild from its stored key or the config cannot be read.
async fn observe_entry(
    driver: &dyn ProviderDriver,
    intent: &McpIntentReceipt,
) -> Option<McpServerObservedEntry> {
    let Some(binding) = intent.binding.binding_ref() else {
        tracing::warn!(
            operation = intent.operation.as_str(),
            "an MCP change's stored binding no longer reads as a binding, so it stays unsettled"
        );
        return None;
    };
    match driver.observe_mcp_server(binding).await {
        Ok(observed) => Some(observed.entry),
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                operation = intent.operation.as_str(),
                "the provider's config could not be read to settle an MCP change"
            );
            None
        }
    }
}

/// Answers `intent` by `settlement` and keeps its receipt so: a landed one committed with what
/// `landed` builds, run only then; an unlanded one expired, so a retry runs fresh; one changed by
/// another writer or whose binding is gone committed with that refusal; an unsettled one left
/// `pending`. Fails with `landed`'s error, the receipt left `pending`; with
/// `mcp.bindingStoreUnavailable` where the commit or expiry fails, or the binding no longer
/// rebuilds from its stored key; and with the refusal each settlement answers.
pub(crate) async fn apply_settlement<Landed, LandedFuture>(
    receipts: &McpMutationReceipts,
    intent: &McpIntentReceipt,
    settlement: McpIntentSettlement,
    landed: Landed,
) -> Result<Value, DomainError>
where
    Landed: FnOnce() -> LandedFuture,
    LandedFuture: Future<Output = Result<McpLandedCommit, DomainError>>,
{
    let idempotency_key = &intent.idempotency_key;
    match settlement {
        McpIntentSettlement::Landed => {
            let McpLandedCommit { response, rows } = landed().await?;
            let saved = saved_value(&McpSavedAnswer::Served {
                response: response.clone(),
            });
            receipts
                .commit(idempotency_key, &saved, rows)
                .await
                .map_err(store_unavailable)?;
            Ok(response)
        }
        McpIntentSettlement::Unlanded => {
            let binding = rebuilt_binding(intent)?;
            receipts
                .expire(idempotency_key)
                .await
                .map_err(store_unavailable)?;
            Err(McpRefusal::ProviderRefusedWrite {
                binding,
                words: UNLANDED_WORDS.to_owned(),
            }
            .into())
        }
        McpIntentSettlement::ChangedByAnother => {
            let refusal = McpRefusal::ServerConfigWriteConflict {
                binding: rebuilt_binding(intent)?,
                conflict: McpConfigWriteConflict::EntryChanged,
            };
            commit_refusal(receipts, idempotency_key, refusal).await
        }
        McpIntentSettlement::BindingGone => {
            let refusal = McpRefusal::ServerNotFound {
                binding: rebuilt_binding(intent)?,
            };
            commit_refusal(receipts, idempotency_key, refusal).await
        }
        McpIntentSettlement::Unsettled | McpIntentSettlement::NoDriver => {
            Err(McpRefusal::ProviderRefusedWrite {
                binding: rebuilt_binding(intent)?,
                words: UNSETTLED_WORDS.to_owned(),
            }
            .into())
        }
    }
}

/// Commits `idempotency_key`'s receipt with `refusal` saved, and answers it. Fails with
/// `mcp.bindingStoreUnavailable` where the commit fails, the receipt left `pending`.
pub(crate) async fn commit_refusal(
    receipts: &McpMutationReceipts,
    idempotency_key: &ClientUuid,
    refusal: impl Into<DomainError>,
) -> Result<Value, DomainError> {
    let refusal = refusal.into();
    receipts
        .commit(
            idempotency_key,
            &saved_value(&McpSavedAnswer::of_refusal(&refusal)),
            Vec::new(),
        )
        .await
        .map_err(store_unavailable)?;
    Err(refusal)
}

/// A saved answer as its receipt's `response_json`.
pub(crate) fn saved_value(answer: &McpSavedAnswer) -> Value {
    serde_json::to_value(answer).expect("a saved answer writes as JSON")
}

/// The refusal of a receipt store that failed, `mcp.bindingStoreUnavailable` with the failure kept
/// underneath.
pub(crate) fn store_unavailable(error: McpReceiptStoreError) -> DomainError {
    McpRefusal::BindingStoreUnavailable {
        cause: None,
        source: Some(Box::new(error)),
    }
    .into()
}

/// A receipt's stored binding key whose parts no longer read as a binding.
#[derive(Debug, thiserror::Error)]
#[error("an MCP mutation receipt's stored binding no longer reads as a binding")]
struct StoredBindingFault;

/// The binding `intent`'s stored key names, which every refusal of it names. Fails with
/// `mcp.bindingStoreUnavailable` where a stored part no longer reads as a binding's.
pub(crate) fn rebuilt_binding(
    intent: &McpIntentReceipt,
) -> Result<Box<McpServerBindingRef>, DomainError> {
    intent.binding.binding_ref().map(Box::new).ok_or_else(|| {
        McpRefusal::BindingStoreUnavailable {
            cause: None,
            source: Some(Box::new(StoredBindingFault)),
        }
        .into()
    })
}

/// The pass over the receipts left `pending`, run as one background task at a time: at the
/// daemon's start, and after a mutation's receipt key read while a pass is owed.
pub(crate) struct McpPendingSettle {
    /// What the pass's task reads, locks and settles with.
    pass: Arc<McpPendingPass>,
    /// The pass's task, while it runs.
    tracker: TaskTracker,
}

/// What one pass reads, locks and settles with, shared with its task.
struct McpPendingPass {
    /// The receipts listed and read again under each lock.
    receipts: McpMutationReceipts,
    /// The receipt key, read before anything is listed or locked.
    receipt_keys: Arc<McpReceiptKeys>,
    /// The idempotency keys' locks every mutation shares.
    key_locks: Arc<KeyedLock<ClientUuid>>,
    /// Each operation's settler.
    settlers: McpIntentSettlers,
    /// Whether a pass could not read the receipt key, list the receipts or settle one of them,
    /// so the next mutation starts one.
    is_owed: AtomicBool,
    /// Whether a pass's task runs.
    is_running: AtomicBool,
}

impl McpPendingSettle {
    /// The pass over `receipts`, reading the receipt key from `receipt_keys`, holding each row
    /// under its lock in `key_locks` and settling it by its operation's settler in `settlers`.
    pub(crate) fn new(
        receipts: McpMutationReceipts,
        receipt_keys: Arc<McpReceiptKeys>,
        key_locks: Arc<KeyedLock<ClientUuid>>,
        settlers: McpIntentSettlers,
    ) -> Self {
        Self {
            pass: Arc::new(McpPendingPass {
                receipts,
                receipt_keys,
                key_locks,
                settlers,
                is_owed: AtomicBool::new(false),
                is_running: AtomicBool::new(false),
            }),
            tracker: TaskTracker::new(),
        }
    }

    /// Starts a pass in the background, as the daemon's start does; nothing starts while one
    /// runs, nor once [`Self::stop`] has begun.
    pub(crate) fn request(&self) {
        // The token keeps a stop's wait from ending between the closed check and the spawn.
        let token = self.tracker.token();
        if self.tracker.is_closed()
            || self
                .pass
                .is_running
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return;
        }
        let pass = Arc::clone(&self.pass);
        tokio::spawn(async move {
            pass.run().await;
            pass.is_running.store(false, Ordering::Release);
            drop(token);
        });
    }

    /// Starts a pass as [`Self::request`] does, but only while one is owed; a mutation calls it
    /// once its own receipt key read succeeds and that key's lock is released.
    pub(crate) fn request_if_owed(&self) {
        if self.pass.is_owed.load(Ordering::Acquire) {
            self.request();
        }
    }

    /// Closes the pass to new requests and waits for a running one to end.
    pub(crate) async fn stop(&self) {
        self.tracker.close();
        self.tracker.wait().await;
    }
}

impl McpPendingPass {
    // Reads the receipt key, lists the pending receipts, and settles each one still pending
    // under its idempotency key's lock.
    async fn run(&self) {
        let key = match self.receipt_keys.read(&self.key_locks).await {
            Ok(key) => key,
            Err(error) => {
                self.is_owed.store(true, Ordering::Release);
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "the MCP receipt key could not be read, so the unfinished MCP changes wait for \
                     the next one"
                );
                return;
            }
        };
        let pending = match self.receipts.list_pending().await {
            Ok(pending) => pending,
            Err(error) => {
                self.is_owed.store(true, Ordering::Release);
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "the unfinished MCP changes could not be listed, so they wait for the next \
                     MCP change"
                );
                return;
            }
        };
        self.is_owed.store(false, Ordering::Release);
        let mut is_unregistered_warned = false;
        for listed in pending {
            let Some(settler) = self.settlers.settler(&listed.operation) else {
                if !is_unregistered_warned {
                    is_unregistered_warned = true;
                    tracing::warn!(
                        operation = listed.operation.as_str(),
                        "an unfinished MCP change has no settler for its operation, so it stays \
                         unfinished"
                    );
                }
                continue;
            };
            let _hold = self.key_locks.acquire(listed.idempotency_key.clone()).await;
            // A same-key retry may have settled the receipt between the list and the lock.
            match self
                .receipts
                .check_saved(&listed.idempotency_key, &listed.request_digest)
                .await
            {
                Ok(McpSavedCheck::Pending(intent)) => {
                    let settlement = settler.settle(intent, Arc::clone(&key)).await;
                    if settlement == McpIntentSettlement::Unsettled {
                        self.is_owed.store(true, Ordering::Release);
                    }
                }
                Ok(McpSavedCheck::Fresh | McpSavedCheck::Saved(_) | McpSavedCheck::Conflict) => {}
                Err(error) => {
                    self.is_owed.store(true, Ordering::Release);
                    tracing::warn!(
                        error = &error as &(dyn std::error::Error + 'static),
                        "an unfinished MCP change could not be read again, so it waits for the \
                         next MCP change"
                    );
                }
            }
        }
    }
}

#[cfg(test)]
pub(super) mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use futures::future::BoxFuture;
    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::keychain::KeychainRefusalCause;
    use sidekicks_contracts::wire::id::ClientUuid;
    use sidekicks_platforms::CredentialStore as PlatformCredentialStore;
    use sidekicks_provider::driver::contract::MockProviderDriver;
    use sidekicks_provider::driver::contract::error::DriverError;
    use sidekicks_provider::driver::mcp_server::write::{
        McpServerObserved, McpServerObservedEntry,
    };
    use sidekicks_std::keyed_lock::KeyedLock;
    use sidekicks_store::credential_store::service::KeychainService;
    use sidekicks_store::credential_store::test_keychain::{CountingKeychain, test_keychain};
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use tempfile::TempDir;

    use super::{
        McpIntentSettler, McpIntentSettlers, McpLandedCommit, McpPendingSettle, apply_settlement,
        observe_settlement,
    };
    use crate::binding::store::enabled_override_statement;
    use crate::mutation::receipt_key::McpReceiptKeys;
    use crate::mutation::receipts::tests::{
        idempotency_key, project_binding, receipts_over_a_database,
    };
    use crate::mutation::receipts::{
        McpIntentReceipt, McpMutationReceipts, McpReceiptDigest, McpReceiptKey, McpSavedCheck,
    };
    use crate::mutation::reconciler::McpIntentSettlement;
    use crate::mutation::saved_answer::McpSavedAnswer;

    // The operation every test's receipt was spent on.
    const OPERATION: &str = "mcp.server.enabled.update";

    /// The pending receipts over a fresh database, with a receipt key already made and pinned
    /// that the pass reads afresh from a keychain counting its calls.
    struct Fixture {
        database: TestDatabase,
        receipts: McpMutationReceipts,
        keychain: Arc<CountingKeychain>,
        receipt_keys: Arc<McpReceiptKeys>,
        key_locks: Arc<KeyedLock<ClientUuid>>,
        _data_folder: TempDir,
        _platform_store: PlatformCredentialStore,
    }

    impl Fixture {
        async fn new() -> Self {
            let (database, receipts, writer, reads) = receipts_over_a_database().await;
            let (data_folder, platform_store, keychain) =
                test_keychain(KeychainService::McpReceiptKey);
            let keychain = Arc::new(CountingKeychain::new(keychain));
            let key_locks = Arc::new(KeyedLock::new());
            let keys = || {
                McpReceiptKeys::new(
                    Arc::clone(&keychain) as _,
                    receipts.clone(),
                    Arc::clone(&reads),
                    Arc::clone(&writer),
                )
            };
            keys()
                .read(&key_locks)
                .await
                .expect("the receipt key is made and pinned");
            let receipt_keys = Arc::new(keys());
            Self {
                database,
                receipts,
                keychain,
                receipt_keys,
                key_locks,
                _data_folder: data_folder,
                _platform_store: platform_store,
            }
        }

        /// The pass over the fixture's receipts, settling switches through `driver`.
        fn pass(&self, driver: MockProviderDriver) -> McpPendingSettle {
            let settler = SwitchSettler {
                driver,
                receipts: self.receipts.clone(),
            };
            McpPendingSettle::new(
                self.receipts.clone(),
                Arc::clone(&self.receipt_keys),
                Arc::clone(&self.key_locks),
                McpIntentSettlers::new([(
                    OPERATION,
                    Box::new(settler) as Box<dyn McpIntentSettler>,
                )]),
            )
        }

        /// Begins a switch's receipt, wanting the binding on.
        async fn begin(&self) -> McpIntentReceipt {
            let intent = McpIntentReceipt {
                idempotency_key: idempotency_key(),
                operation: OPERATION.to_owned(),
                binding: project_binding(),
                request_digest: McpReceiptDigest::from_bytes([1; 32]),
                before_digest: None,
                after_digest: None,
                wanted_enabled: Some(true),
            };
            self.receipts
                .begin(&intent)
                .await
                .expect("the intent begins");
            intent
        }

        async fn check(&self, intent: &McpIntentReceipt) -> McpSavedCheck {
            self.receipts
                .check_saved(&intent.idempotency_key, &intent.request_digest)
                .await
                .expect("the saved check reads")
        }

        fn count_bindings(&self) -> i64 {
            self.database
                .reader()
                .query_row("SELECT count(*) FROM mcp_server_bindings", [], |row| {
                    row.get(0)
                })
                .expect("the test counts the bindings")
        }
    }

    /// A settler of switches observing through a mock driver, as the service's settler does.
    struct SwitchSettler {
        driver: MockProviderDriver,
        receipts: McpMutationReceipts,
    }

    impl McpIntentSettler for SwitchSettler {
        fn settle(
            &self,
            intent: McpIntentReceipt,
            key: Arc<McpReceiptKey>,
        ) -> BoxFuture<'_, McpIntentSettlement> {
            Box::pin(async move {
                let settlement = observe_settlement(&self.driver, &key, &intent).await;
                let answer = apply_settlement(&self.receipts, &intent, settlement, || async {
                    Ok(landed_commit(&intent))
                })
                .await;
                assert_eq!(answer.is_ok(), settlement == McpIntentSettlement::Landed);
                settlement
            })
        }
    }

    /// What a landed switch commits: its response and the daemon's switch over the binding.
    fn landed_commit(intent: &McpIntentReceipt) -> McpLandedCommit {
        McpLandedCommit {
            response: json!({ "enabled": true }),
            rows: vec![enabled_override_statement(&intent.binding, true)],
        }
    }

    /// A driver whose config holds the binding switched on, its first `failures` observes
    /// failing, with the count of the observes that reached it.
    fn observing(failures: usize) -> (MockProviderDriver, Arc<AtomicUsize>) {
        let observes = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&observes);
        let mut driver = MockProviderDriver::new();
        driver.expect_observe_mcp_server().returning(move |_| {
            let is_failing = counted.fetch_add(1, Ordering::SeqCst) < failures;
            Box::pin(async move {
                if is_failing {
                    return Err(DriverError::Internal("the config is unreadable".into()));
                }
                Ok(McpServerObserved {
                    entry: McpServerObservedEntry::Switch(true),
                    config_version: None,
                    config_files: Vec::new(),
                })
            })
        });
        (driver, observes)
    }

    /// Waits for the pass's task, then lets the next one start.
    pub(in crate::mutation) async fn settled(pass: &McpPendingSettle) {
        pass.stop().await;
        pass.tracker.reopen();
    }

    /// Whether `pass` owes the next mutation a pass.
    pub(in crate::mutation) fn is_owed(pass: &McpPendingSettle) -> bool {
        pass.pass.is_owed.load(Ordering::Acquire)
    }

    /// Where a receipt is once its settlement is applied.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Row {
        Pending,
        Committed,
        Expired,
    }

    /// Each settlement keeps its receipt as it should and answers its code, a committed receipt
    /// saving that same answer, and only a landed one writes its rows. Killed by an unlanded
    /// receipt committed, an unsettled one expired, and a landed one committed without its rows.
    #[rstest]
    #[case::landed(McpIntentSettlement::Landed, Row::Committed, None, 1)]
    #[case::unlanded(
        McpIntentSettlement::Unlanded,
        Row::Expired,
        Some(RefusalCode::ProviderUnavailable),
        0
    )]
    #[case::changed_by_another(
        McpIntentSettlement::ChangedByAnother,
        Row::Committed,
        Some(RefusalCode::McpServerConfigWriteConflict),
        0
    )]
    #[case::binding_gone(
        McpIntentSettlement::BindingGone,
        Row::Committed,
        Some(RefusalCode::McpServerNotFound),
        0
    )]
    #[case::unsettled(
        McpIntentSettlement::Unsettled,
        Row::Pending,
        Some(RefusalCode::ProviderUnavailable),
        0
    )]
    #[tokio::test]
    async fn a_settlement_keeps_its_receipt_and_answers_its_code(
        #[case] settlement: McpIntentSettlement,
        #[case] row: Row,
        #[case] code: Option<RefusalCode>,
        #[case] bindings: i64,
    ) {
        let fixture = Fixture::new().await;
        let intent = fixture.begin().await;

        let answer = apply_settlement(&fixture.receipts, &intent, settlement, || async {
            Ok(landed_commit(&intent))
        })
        .await;

        assert_eq!(answer.as_ref().err().map(|refusal| refusal.code), code);
        if let Ok(response) = &answer {
            assert_eq!(response, &json!({ "enabled": true }));
        }
        let kept = match fixture.check(&intent).await {
            McpSavedCheck::Pending(_) => Row::Pending,
            McpSavedCheck::Fresh => Row::Expired,
            McpSavedCheck::Saved(saved) => {
                let saved: McpSavedAnswer =
                    serde_json::from_value(saved).expect("the saved answer reads");
                let replayed = saved.into_domain_error();
                assert_eq!(replayed.as_ref().err().map(|refusal| refusal.code), code);
                Row::Committed
            }
            McpSavedCheck::Conflict => panic!("the receipt's own request conflicts"),
        };
        assert_eq!(kept, row);
        assert_eq!(fixture.count_bindings(), bindings);
    }

    /// A pass whose receipt key read is refused observes and writes nothing and is owed; once
    /// the keychain answers, one owed request settles the receipt with one more read and a
    /// second request at once starts nothing, nor does one after the pass, which is no longer
    /// owed. Killed by the receipts observed before the key is read, by the owed flag never set
    /// or never cleared, and by two passes at once.
    #[tokio::test]
    async fn a_pass_reads_the_key_first_and_runs_once_when_owed() {
        let fixture = Fixture::new().await;
        let intent = fixture.begin().await;
        let (driver, observes) = observing(0);
        let pass = fixture.pass(driver);
        let (reads, writes) = (fixture.keychain.reads(), fixture.keychain.writes());
        fixture
            .keychain
            .set_read_refusal(Some(KeychainRefusalCause::Locked));

        pass.request();
        settled(&pass).await;

        assert_eq!(fixture.keychain.reads(), reads + 1);
        assert_eq!(fixture.keychain.writes(), writes);
        assert_eq!(observes.load(Ordering::SeqCst), 0);
        assert!(matches!(
            fixture.check(&intent).await,
            McpSavedCheck::Pending(_)
        ));
        assert_eq!(fixture.count_bindings(), 0);

        fixture.keychain.set_read_refusal(None);
        pass.request_if_owed();
        pass.request_if_owed();
        assert_eq!(pass.tracker.len(), 1, "a second request starts no pass");
        settled(&pass).await;

        assert_eq!(fixture.keychain.reads(), reads + 2);
        assert_eq!(observes.load(Ordering::SeqCst), 1);
        let McpSavedCheck::Saved(saved) = fixture.check(&intent).await else {
            panic!("the owed pass settles the receipt");
        };
        assert_eq!(
            serde_json::from_value::<McpSavedAnswer>(saved).expect("the saved answer reads"),
            McpSavedAnswer::Served {
                response: json!({ "enabled": true })
            }
        );
        assert_eq!(fixture.count_bindings(), 1);
        pass.request_if_owed();
        assert!(
            pass.tracker.is_empty(),
            "a pass that settled is no longer owed"
        );
    }

    /// A receipt a same-key retry commits after the pass listed it and before the pass holds its
    /// lock is neither observed nor written by the pass. Killed by the receipt not read again
    /// under its lock.
    #[tokio::test]
    async fn a_receipt_settled_before_the_pass_holds_it_is_skipped() {
        let fixture = Fixture::new().await;
        let intent = fixture.begin().await;
        let (driver, observes) = observing(0);
        let pass = fixture.pass(driver);
        let retry_answer: Value = json!({ "answer": "served", "response": {} });
        let held = fixture
            .key_locks
            .acquire(intent.idempotency_key.clone())
            .await;
        let held_alone = fixture
            .key_locks
            .queue_handle_count(intent.idempotency_key.clone());

        pass.request();
        fixture
            .key_locks
            .wait_for_queue_past(intent.idempotency_key.clone(), held_alone)
            .await;
        fixture
            .receipts
            .commit(&intent.idempotency_key, &retry_answer, Vec::new())
            .await
            .expect("the retry commits the receipt");
        drop(held);
        settled(&pass).await;

        assert_eq!(observes.load(Ordering::SeqCst), 0);
        assert_eq!(
            fixture.check(&intent).await,
            McpSavedCheck::Saved(retry_answer)
        );
        assert_eq!(fixture.count_bindings(), 0);
    }

    /// A receipt whose config cannot be read stays `pending` and leaves the pass owed, so the
    /// next mutation's owed request settles it. Killed by an unsettled receipt not owing a pass.
    #[tokio::test]
    async fn an_unsettled_receipt_owes_the_next_pass() {
        let fixture = Fixture::new().await;
        let intent = fixture.begin().await;
        let (driver, observes) = observing(1);
        let pass = fixture.pass(driver);

        pass.request();
        settled(&pass).await;

        assert!(matches!(
            fixture.check(&intent).await,
            McpSavedCheck::Pending(_)
        ));
        pass.request_if_owed();
        settled(&pass).await;

        assert_eq!(observes.load(Ordering::SeqCst), 2);
        assert!(matches!(
            fixture.check(&intent).await,
            McpSavedCheck::Saved(_)
        ));
        assert_eq!(fixture.count_bindings(), 1);
    }

    /// A stopped pass waits for its running task and starts no other. Killed by a request after
    /// the stop starting a pass.
    #[tokio::test]
    async fn a_stopped_pass_starts_nothing() {
        let fixture = Fixture::new().await;
        let intent = fixture.begin().await;
        let (driver, observes) = observing(0);
        let pass = fixture.pass(driver);

        pass.stop().await;
        pass.request();
        pass.stop().await;

        assert_eq!(observes.load(Ordering::SeqCst), 0);
        assert!(matches!(
            fixture.check(&intent).await,
            McpSavedCheck::Pending(_)
        ));
    }
}
