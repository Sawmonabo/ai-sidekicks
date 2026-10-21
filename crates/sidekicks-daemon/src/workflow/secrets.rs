//! The workflow secrets' values, held in a keychain under each secret's id. The daemon's table
//! records a secret's place and name; this store holds only the value, which leaves the daemon only
//! into the step that resolves it.
//!
//! The store takes a [`SecretKeychain`] and holds no keychain code, so its rules run in tests
//! without touching a real keychain.
//!
//! Call order is the caller's contract. Seal the value before writing the record, so a refusing
//! keychain leaves no record naming a missing value. To delete, mark the record's removal, remove
//! the value, then remove the record, so a crash in between is finished at the next start instead
//! of leaving a value with no record.

use std::sync::Arc;

use secrecy::SecretString;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::workflow::secret::{
    WorkflowSecretId, WorkflowSecretStoreUnavailableDetails, WorkflowSecretValue,
};

use crate::credential_store::{KeychainRefusal, SecretKeychain};
use crate::ipc::domain_error::DomainError;

/// Seals, resolves and removes workflow secrets' values in the keychain.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the workflow secret handlers and the steps that resolve a secret use the store"
    )
)]
pub(crate) struct WorkflowSecretStore {
    /// The keychain the values are kept in.
    keychain: Arc<dyn SecretKeychain>,
}

#[expect(
    dead_code,
    reason = "the workflow secret handlers and the steps that resolve a secret use the store"
)]
impl WorkflowSecretStore {
    /// A store over `keychain`.
    pub(crate) fn new(keychain: Arc<dyn SecretKeychain>) -> Self {
        Self { keychain }
    }

    /// Seals a secret's value, the first or a replacement, and confirms the keychain kept it.
    /// Fails with [`KeychainRefusal`] when the keychain is locked, missing, or did not keep the
    /// value.
    pub(crate) async fn seal(
        &self,
        secret_id: WorkflowSecretId,
        value: &WorkflowSecretValue,
    ) -> Result<(), KeychainRefusal> {
        let sealed = SecretString::from(value.as_str());
        self.keychain.seal(secret_id.text().as_str(), &sealed).await
    }

    /// The secret's value, or `None` when the keychain holds none, which the step that asked
    /// reports as `workflow.secret.notFound`. Fails when the keychain cannot be used.
    pub(crate) async fn resolve(
        &self,
        secret_id: WorkflowSecretId,
    ) -> Result<Option<SecretString>, KeychainRefusal> {
        self.keychain.read(secret_id.text().as_str()).await
    }

    /// Removes a secret's value; removing one that is already gone succeeds. Fails when the
    /// keychain cannot be used.
    pub(crate) async fn remove(&self, secret_id: WorkflowSecretId) -> Result<(), KeychainRefusal> {
        self.keychain
            .remove(secret_id.text().as_str())
            .await
            .map(|_was_held| ())
    }
}

/// A refused keychain call answered as `workflow.secret.storeUnavailable` with its cause.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the workflow secret handlers and the steps that resolve a secret answer a \
                  refused keychain with it"
    )
)]
pub(crate) fn store_unavailable(refusal: KeychainRefusal) -> DomainError {
    let cause = refusal.cause();
    let (message, failure) = refusal.into_failure();
    let refused = DomainError::new(message, RefusalCode::WorkflowSecretStoreUnavailable)
        .with_detail(WorkflowSecretStoreUnavailableDetails { cause });
    match failure {
        Some(failure) => refused.with_source(failure),
        None => refused,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use futures::future::BoxFuture;
    use secrecy::{ExposeSecret, SecretString};
    use serde_json::json;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::keychain::KeychainRefusalCause;
    use sidekicks_contracts::workflow::secret::{WorkflowSecretId, WorkflowSecretValue};

    use super::{WorkflowSecretStore, store_unavailable};
    use crate::credential_store::{KeychainRefusal, SecretKeychain};

    /// The value the seal writes.
    const SECRET: &str = "hunter2-do-not-print";

    /// A keychain that accepts every write but keeps the value without its last character.
    #[derive(Default)]
    struct KeychainKeepingAShorterValue {
        kept: Mutex<Option<String>>,
    }

    impl SecretKeychain for KeychainKeepingAShorterValue {
        fn write<'call>(
            &'call self,
            _account: &'call str,
            value: &'call SecretString,
        ) -> BoxFuture<'call, Result<(), KeychainRefusal>> {
            let mut shorter = value.expose_secret().to_owned();
            shorter.pop();
            *self.kept.lock().expect("no test thread panics holding it") = Some(shorter);
            Box::pin(async { Ok(()) })
        }

        fn read<'call>(
            &'call self,
            _account: &'call str,
        ) -> BoxFuture<'call, Result<Option<SecretString>, KeychainRefusal>> {
            let kept = self
                .kept
                .lock()
                .expect("no test thread panics holding it")
                .clone()
                .map(SecretString::from);
            Box::pin(async move { Ok(kept) })
        }

        fn remove<'call>(
            &'call self,
            _account: &'call str,
        ) -> BoxFuture<'call, Result<bool, KeychainRefusal>> {
            Box::pin(async { Ok(false) })
        }

        fn accounts(&self) -> BoxFuture<'_, Result<Vec<String>, KeychainRefusal>> {
            Box::pin(async { Ok(Vec::new()) })
        }
    }

    /// A keychain that drops a write without an error must refuse the seal as `unavailable`, and
    /// the refusal names neither the value written nor the one kept. Mutation: seal skips the
    /// read-back.
    #[tokio::test]
    async fn a_keychain_keeping_another_value_refuses_the_seal_without_naming_either() {
        let store = WorkflowSecretStore::new(Arc::new(KeychainKeepingAShorterValue::default()));
        let secret_id =
            WorkflowSecretId::new("0190f1c4-7e3a-7b1c-9d2e-3f4a5b6c7d8e").expect("the id reads");
        let value: WorkflowSecretValue = serde_json::from_value(json!(SECRET)).expect("it reads");

        let refusal = store
            .seal(secret_id, &value)
            .await
            .expect_err("a value the keychain did not keep is refused");

        assert_eq!(refusal.cause(), KeychainRefusalCause::Unavailable);
        let refused = store_unavailable(refusal);
        assert_eq!(refused.code, RefusalCode::WorkflowSecretStoreUnavailable);
        for written in [refused.to_string(), format!("{refused:?}")] {
            assert!(!written.contains("hunter2"), "{written}");
        }
    }
}
