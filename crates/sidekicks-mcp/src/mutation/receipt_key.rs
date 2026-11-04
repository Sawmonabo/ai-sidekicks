//! The daemon's receipt key: 32 bytes in the credential store that every receipt digest is keyed
//! with, read, made and settled under one lock and held for the run after its first good read.
//! A pin beside the receipts, the keyed hash of a fixed label under the key, tells the key from
//! another. A key gone while its pin stands, or not matching it, is lost: a new one is made, and
//! every unfinished receipt, whose digests no key the daemon holds can match again, is answered
//! with that failure. A keychain that cannot be read changes nothing and is asked again next time.

#![cfg_attr(
    not(test),
    expect(dead_code, reason = "the mutation service reads the receipt key")
)]

use std::borrow::Cow;
use std::sync::Arc;

use rusqlite::OptionalExtension as _;
use rusqlite::types::Value as SqliteValue;
use secrecy::SecretBox;
use sidekicks_contracts::mcp::governance::{McpBindingStoreUnavailableCause, McpReceiptKeyCause};
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_store::credential_store::seed_item::{
    SEED_LENGTH, Seed, encode_seed, item_seed, random_seed,
};
use sidekicks_store::credential_store::{KeychainRefusal, SecretKeychain};
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement};
use sidekicks_store::database::writer::DatabaseWriter;

use crate::errors::McpRefusal;
use crate::mutation::receipts::{McpMutationReceipts, McpReceiptKey, McpReceiptStoreError};
use crate::mutation::saved_answer::McpSavedAnswer;

/// The distinct statements the receipt key keeps prepared on each read connection.
pub(crate) const MCP_RECEIPT_KEY_STATEMENT_CAPACITY: usize = 1;

/// The receipt key's one account in its keychain service.
pub(crate) const MCP_RECEIPT_KEY_ACCOUNT: &str = "receipt-key";

// What the pin is the keyed hash of; it never changes, so a pin taken by one run checks the next.
const PIN_LABEL: &[u8] = b"ai-sidekicks mcp receipt key pin";

const SELECT_PIN_SQL: &str = "SELECT pin FROM mcp_receipt_key_pin WHERE singleton = 1";

const UPSERT_PIN_SQL: &str = "INSERT INTO mcp_receipt_key_pin (singleton, pin) VALUES (1, @pin)
  ON CONFLICT (singleton) DO UPDATE SET pin = excluded.pin";

/// Why the receipt key could not be read or made.
#[derive(Debug, thiserror::Error)]
pub(crate) enum McpReceiptKeyError {
    /// The keychain is locked or cannot be used; nothing was written.
    #[error(transparent)]
    Keychain(#[from] KeychainRefusal),
    /// The system gave no random bytes for a new key.
    #[error("the system gave no random bytes for the MCP receipt key")]
    Random(#[from] getrandom::Error),
    /// The pin or the receipts could not be read or written.
    #[error(transparent)]
    Store(#[from] McpReceiptStoreError),
}

impl From<McpReceiptKeyError> for McpRefusal {
    /// Every failure fails the mutation closed; a keychain's refusal names its cause.
    fn from(error: McpReceiptKeyError) -> Self {
        let cause = match &error {
            McpReceiptKeyError::Keychain(refusal) => {
                Some(McpBindingStoreUnavailableCause::Keychain(refusal.cause()))
            }
            McpReceiptKeyError::Random(_) | McpReceiptKeyError::Store(_) => None,
        };
        Self::BindingStoreUnavailable {
            cause,
            source: Some(Box::new(error)),
        }
    }
}

/// The receipt key and what it is kept in; see the module doc. Every read, mint and settle runs
/// under one lock, taken before any idempotency key's lock and released once the key is read.
pub(crate) struct McpReceiptKeys {
    /// The receipt key's keychain service.
    keychain: Arc<dyn SecretKeychain>,
    /// The receipts a lost key's settle commits.
    receipts: McpMutationReceipts,
    /// Where the pin is read.
    reads: Arc<DatabaseReadPool>,
    /// Where the pin and a lost key's settle are written.
    writer: Arc<DatabaseWriter>,
    /// The key once read or made; only a success is kept.
    key: tokio::sync::Mutex<Option<Arc<McpReceiptKey>>>,
}

impl McpReceiptKeys {
    /// The receipt key kept in `keychain`, pinned and settled through `reads` and `writer`, its
    /// lost-key settle committing `receipts`; nothing is read until the first [`Self::read`].
    pub(crate) fn new(
        keychain: Arc<dyn SecretKeychain>,
        receipts: McpMutationReceipts,
        reads: Arc<DatabaseReadPool>,
        writer: Arc<DatabaseWriter>,
    ) -> Self {
        Self {
            keychain,
            receipts,
            reads,
            writer,
            key: tokio::sync::Mutex::new(None),
        }
    }

    /// The receipt key: the one held, else the keychain's item checked against the pin, adopted
    /// when there is no pin, made when there is neither, and made again when it is lost, each
    /// unfinished receipt then committed with the lost key's failure under its lock in
    /// `key_locks`. Fails with [`McpReceiptKeyError::Keychain`] when the keychain cannot be read,
    /// writing and holding nothing, and with the other arms as the random source or the store
    /// fails.
    pub(crate) async fn read(
        &self,
        key_locks: &KeyedLock<ClientUuid>,
    ) -> Result<Arc<McpReceiptKey>, McpReceiptKeyError> {
        let mut held = self.key.lock().await;
        if let Some(key) = held.as_ref() {
            return Ok(Arc::clone(key));
        }
        let key = self.read_or_mint(key_locks).await?;
        Ok(Arc::clone(held.insert(Arc::new(key))))
    }

    // The key against its pin, under the lock: an item that is no key reads as none.
    async fn read_or_mint(
        &self,
        key_locks: &KeyedLock<ClientUuid>,
    ) -> Result<McpReceiptKey, McpReceiptKeyError> {
        let pin = self.read_pin().await?;
        let item = self.keychain.read(MCP_RECEIPT_KEY_ACCOUNT).await?;
        let seed = item.as_ref().and_then(item_seed);
        match (seed, pin) {
            (Some(seed), Some(pin)) if pin_of(&seed) == pin => Ok(key_of(&seed)),
            (Some(seed), None) => {
                self.write(vec![pin_statement(&seed)]).await?;
                Ok(key_of(&seed))
            }
            (None, None) => {
                let seed = self.write_new_seed().await?;
                self.write(vec![pin_statement(&seed)]).await?;
                Ok(key_of(&seed))
            }
            (_, Some(_)) => self.settle_lost(key_locks).await,
        }
    }

    // Makes a new key and, in one write, pins it and commits every pending receipt with the lost
    // key's failure and no digests, each held under its idempotency key's lock until written.
    async fn settle_lost(
        &self,
        key_locks: &KeyedLock<ClientUuid>,
    ) -> Result<McpReceiptKey, McpReceiptKeyError> {
        let pending = self.receipts.list_pending().await?;
        let holds = key_locks
            .acquire_all(pending.iter().map(|intent| intent.idempotency_key.clone()))
            .await;
        let seed = self.write_new_seed().await?;
        let lost = DomainError::from(McpRefusal::BindingStoreUnavailable {
            cause: Some(McpBindingStoreUnavailableCause::ReceiptKey(
                McpReceiptKeyCause::ReceiptKeyLost,
            )),
            source: None,
        });
        let saved = serde_json::to_value(McpSavedAnswer::of_refusal(&lost))
            .expect("a saved answer writes as JSON");
        let mut statements = Vec::with_capacity(pending.len() + 1);
        statements.push(pin_statement(&seed));
        statements.extend(pending.iter().map(|intent| {
            McpMutationReceipts::commit_key_lost_statement(&intent.idempotency_key, &saved)
        }));
        self.write(statements).await?;
        drop(holds);
        Ok(key_of(&seed))
    }

    // A fresh seed, written to the keychain and read back before it is used.
    async fn write_new_seed(&self) -> Result<Seed, McpReceiptKeyError> {
        let seed = random_seed()?;
        self.keychain
            .write_verified(MCP_RECEIPT_KEY_ACCOUNT, &encode_seed(&seed))
            .await?;
        Ok(seed)
    }

    // The pin, `None` until one is written.
    async fn read_pin(&self) -> Result<Option<blake3::Hash>, McpReceiptStoreError> {
        let pin = self
            .reads
            .read(ReadLength::Short, |connection| {
                Ok::<_, McpReceiptStoreError>(
                    connection
                        .prepare_cached(SELECT_PIN_SQL)?
                        .query_row([], |row| row.get::<_, [u8; 32]>(0))
                        .optional()?,
                )
            })
            .await?;
        Ok(pin.map(blake3::Hash::from_bytes))
    }

    // Runs `statements` as one write.
    async fn write(&self, statements: Vec<WriteStatement>) -> Result<(), McpReceiptStoreError> {
        self.writer
            .write(statements)
            .await
            .map_err(McpReceiptStoreError::Write)?;
        Ok(())
    }
}

// The pin of the key `seed` is: the keyed hash of the label, compared in constant time.
fn pin_of(seed: &Seed) -> blake3::Hash {
    blake3::keyed_hash(seed, PIN_LABEL)
}

// The statement that sets the pin to `seed`'s.
fn pin_statement(seed: &Seed) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(UPSERT_PIN_SQL),
        bindings: StatementBindings::Named(vec![(
            Cow::Borrowed("@pin"),
            SqliteValue::Blob(pin_of(seed).as_bytes().to_vec()),
        )]),
        expected_row_count: Some(1),
    }
}

// The receipt key of `seed`, copied straight into its wiped box.
fn key_of(seed: &Seed) -> McpReceiptKey {
    McpReceiptKey::new(SecretBox::init_with_mut(|key: &mut [u8; SEED_LENGTH]| {
        key.copy_from_slice(seed.as_slice());
    }))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use rstest::rstest;
    use rusqlite::OptionalExtension as _;
    use secrecy::SecretString;
    use serde_json::{Value, json};
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::keychain::KeychainRefusalCause;
    use sidekicks_contracts::wire::id::ClientUuid;
    use sidekicks_ipc::domain_error::DomainError;
    use sidekicks_platforms::CredentialStore as PlatformCredentialStore;
    use sidekicks_std::keyed_lock::KeyedLock;
    use sidekicks_store::credential_store::SecretKeychain;
    use sidekicks_store::credential_store::seed_item::item_seed;
    use sidekicks_store::credential_store::service::KeychainService;
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use tempfile::TempDir;

    use super::{MCP_RECEIPT_KEY_ACCOUNT, McpReceiptKeys, PIN_LABEL};
    use crate::errors::McpRefusal;
    use crate::mutation::receipts::tests::{
        idempotency_key, project_binding, receipt_key, receipts_over_a_database,
    };
    use crate::mutation::receipts::{
        McpIntentReceipt, McpMutationReceipts, McpReceiptKey, McpSavedCheck,
    };
    use crate::mutation::saved_answer::McpSavedAnswer;
    use crate::test_keychain::{CountingKeychain, test_keychain};

    // The method every test's receipts were spent on.
    const METHOD: &str = "mcp.server.upsert";

    // The bytes of the key every receipt the tests begin was made under.
    const FIRST_KEY: u8 = 1;

    /// A receipt key over a fresh database and an empty keychain that counts its calls.
    struct Fixture {
        database: TestDatabase,
        receipts: McpMutationReceipts,
        keychain: Arc<CountingKeychain>,
        keys: McpReceiptKeys,
        key_locks: KeyedLock<ClientUuid>,
        _data_folder: TempDir,
        _platform_store: PlatformCredentialStore,
    }

    impl Fixture {
        async fn new() -> Self {
            let (database, receipts, writer, reads) = receipts_over_a_database().await;
            let (data_folder, platform_store, keychain) =
                test_keychain(KeychainService::McpReceiptKey);
            let keychain = Arc::new(CountingKeychain::new(keychain));
            let keys =
                McpReceiptKeys::new(Arc::clone(&keychain) as _, receipts.clone(), reads, writer);
            Self {
                database,
                receipts,
                keychain,
                keys,
                key_locks: KeyedLock::new(),
                _data_folder: data_folder,
                _platform_store: platform_store,
            }
        }

        async fn read(&self) -> Result<Arc<McpReceiptKey>, super::McpReceiptKeyError> {
            self.keys.read(&self.key_locks).await
        }

        /// Writes `item` as the key's item, a write the counting keychain counts.
        async fn keep_item(&self, item: &str) {
            self.keychain
                .write(
                    MCP_RECEIPT_KEY_ACCOUNT,
                    &SecretString::from(item.to_owned()),
                )
                .await
                .expect("the test keychain keeps the item");
        }

        /// The pin row, `None` while there is none.
        fn pin(&self) -> Option<Vec<u8>> {
            self.database
                .reader()
                .query_row("SELECT pin FROM mcp_receipt_key_pin", [], |row| row.get(0))
                .optional()
                .expect("the test reads the pin")
        }

        /// Writes the pin of the key whose bytes are all `fill`.
        fn pin_key(&self, fill: u8) {
            self.database
                .reader()
                .execute(
                    "INSERT INTO mcp_receipt_key_pin (singleton, pin) VALUES (1, ?1)",
                    [pin_of_bytes(&[fill; 32])],
                )
                .expect("the test writes the pin");
        }

        /// The key's item read back as its bytes, and the pin those bytes make.
        async fn kept_key(&self) -> ([u8; 32], Vec<u8>) {
            let item = self
                .keychain
                .read(MCP_RECEIPT_KEY_ACCOUNT)
                .await
                .expect("the test keychain answers")
                .expect("the key's item is kept");
            let seed = item_seed(&item).expect("the item is a key in lowercase hex");
            (*seed, pin_of_bytes(&seed))
        }

        /// Begins a receipt for `request` under `idempotency_key`, made under the first key.
        async fn begin(&self, idempotency_key: &ClientUuid, request: &Value) {
            let request_digest = receipt_key(FIRST_KEY)
                .digest_request(idempotency_key, METHOD, request)
                .expect("the request digests");
            self.receipts
                .begin(&McpIntentReceipt {
                    idempotency_key: idempotency_key.clone(),
                    operation: METHOD.to_owned(),
                    binding: project_binding(),
                    request_digest,
                    before_digest: Some(request_digest),
                    after_digest: Some(request_digest),
                    wanted_enabled: None,
                })
                .await
                .expect("the intent begins");
        }

        /// The count of `idempotency_key`'s digests still stored, and its status.
        fn row(&self, idempotency_key: &ClientUuid) -> (i64, String) {
            self.database
                .reader()
                .query_row(
                    "SELECT count(request_digest) + count(before_digest) + count(after_digest),
                       status
                     FROM mcp_mutation_receipts WHERE client_idempotency_key = ?1",
                    [idempotency_key.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("the test reads the receipt")
        }

        async fn check(&self, idempotency_key: &ClientUuid, key: &McpReceiptKey) -> McpSavedCheck {
            let request_digest = key
                .digest_request(idempotency_key, METHOD, &request())
                .expect("the request digests");
            self.receipts
                .check_saved(idempotency_key, &request_digest)
                .await
                .expect("the saved check reads")
        }
    }

    fn pin_of_bytes(key: &[u8; 32]) -> Vec<u8> {
        blake3::keyed_hash(key, PIN_LABEL).as_bytes().to_vec()
    }

    fn request() -> Value {
        json!({ "serverName": "docs" })
    }

    /// What one key digests a fixed request to, so two handles can be told to be one key.
    fn fingerprint(key: &McpReceiptKey) -> [u8; 32] {
        let fixed = ClientUuid::new("018f0000-0000-7000-8000-000000000000".to_owned())
            .expect("a client key");
        *key.digest_request(&fixed, METHOD, &request())
            .expect("the request digests")
            .as_bytes()
    }

    /// Two first reads at once make one key, write it once and pin it. Killed by a mint without
    /// the lock, and by the pin never written.
    #[tokio::test]
    async fn two_first_reads_make_one_pinned_key() {
        let fixture = Fixture::new().await;

        let (first, second) = tokio::join!(fixture.read(), fixture.read());

        let (first, second) = (
            first.expect("a key is made"),
            second.expect("a key is read"),
        );
        assert_eq!(fixture.keychain.writes(), 1);
        assert_eq!(fingerprint(&first), fingerprint(&second));
        let (kept, pin) = fixture.kept_key().await;
        assert_eq!(
            fingerprint(&first),
            fingerprint(&McpReceiptKey::new(secrecy::SecretBox::new(Box::new(kept))))
        );
        assert_eq!(fixture.pin(), Some(pin));
    }

    /// What the keychain holds under the receipt key's account when its pin stands.
    #[derive(Clone, Copy, Debug)]
    enum KeptItem {
        /// Nothing.
        NotFound,
        /// Another key than the pinned one.
        AnotherKey,
        /// Text that is no 32-byte key.
        NotAKey,
    }

    /// A key that does not match its pin is made again: the new key replaces the pin, the
    /// pending receipt is committed with the lost key's failure and no digests, answered under
    /// any request, and the committed receipt keeps its digest, which the new key cannot match.
    /// Killed by a lost key leaving the receipt pending, by the digest cleared on a committed
    /// receipt, and by the pin unread.
    #[rstest]
    #[case::not_found(KeptItem::NotFound)]
    #[case::another_key(KeptItem::AnotherKey)]
    #[case::not_a_key(KeptItem::NotAKey)]
    #[tokio::test]
    async fn a_lost_key_commits_the_pending_receipts_and_leaves_committed_ones(
        #[case] kept: KeptItem,
    ) {
        let fixture = Fixture::new().await;
        fixture.pin_key(FIRST_KEY);
        match kept {
            KeptItem::NotFound => {}
            KeptItem::AnotherKey => {
                fixture
                    .keep_item(&base16ct::lower::encode_string(&[2; 32]))
                    .await;
            }
            KeptItem::NotAKey => fixture.keep_item("not-a-key").await,
        }
        let (pending_key, committed_key) = (idempotency_key(), idempotency_key());
        fixture.begin(&pending_key, &request()).await;
        fixture.begin(&committed_key, &request()).await;
        fixture
            .receipts
            .commit(&committed_key, &json!({ "answer": "served" }), Vec::new())
            .await
            .expect("the receipt commits");

        let key = fixture.read().await.expect("a new key is made");

        let (kept_bytes, pin) = fixture.kept_key().await;
        assert_ne!(kept_bytes, [FIRST_KEY; 32]);
        assert_eq!(fixture.pin(), Some(pin));
        assert_eq!(fixture.row(&pending_key), (0, "committed".to_owned()));
        let McpSavedCheck::Saved(saved) = fixture.check(&pending_key, &receipt_key(9)).await else {
            panic!("the lost key's receipt answers its saved failure under any request");
        };
        let saved: McpSavedAnswer = serde_json::from_value(saved).expect("the saved answer reads");
        let Err(replayed) = saved.into_domain_error() else {
            panic!("the lost key's receipt saved a refusal");
        };
        assert_eq!(replayed.code, RefusalCode::McpBindingStoreUnavailable);
        assert_eq!(
            replayed
                .detail
                .and_then(|fields| fields.get("cause").cloned()),
            Some(json!("receiptKeyLost"))
        );
        assert_eq!(fixture.row(&committed_key), (3, "committed".to_owned()));
        assert_eq!(
            fixture.check(&committed_key, &key).await,
            McpSavedCheck::Conflict
        );
    }

    /// A locked keychain answers with its cause and changes nothing: the receipt stays pending,
    /// the pin stays, nothing is written or held, and the next read once it opens holds the
    /// pinned key. Killed by a locked read taken as a lost key, and by the refusal held.
    #[tokio::test]
    async fn a_locked_keychain_changes_nothing() {
        let fixture = Fixture::new().await;
        fixture.pin_key(FIRST_KEY);
        fixture
            .keep_item(&base16ct::lower::encode_string(&[FIRST_KEY; 32]))
            .await;
        let pending_key = idempotency_key();
        fixture.begin(&pending_key, &request()).await;
        fixture
            .keychain
            .set_read_refusal(Some(KeychainRefusalCause::Locked));

        let Err(refused) = fixture.read().await else {
            panic!("a locked keychain refuses");
        };

        let refused = DomainError::from(McpRefusal::from(refused));
        assert_eq!(refused.code, RefusalCode::McpBindingStoreUnavailable);
        assert_eq!(
            refused
                .detail
                .and_then(|fields| fields.get("cause").cloned()),
            Some(json!("locked"))
        );
        assert!(matches!(
            fixture.check(&pending_key, &receipt_key(FIRST_KEY)).await,
            McpSavedCheck::Pending(_)
        ));
        assert_eq!(fixture.pin(), Some(pin_of_bytes(&[FIRST_KEY; 32])));
        assert_eq!(fixture.keychain.writes(), 1);

        fixture.keychain.set_read_refusal(None);
        let key = fixture.read().await.expect("the opened keychain answers");
        assert_eq!(fingerprint(&key), fingerprint(&receipt_key(FIRST_KEY)));
    }
}
