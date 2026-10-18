//! The workflow secrets' values, held in a keychain under each secret's id. The daemon's table
//! records a secret's place and name; this store holds only the value, which leaves the daemon only
//! into the step that resolves it.
//!
//! The store takes a [`SecretKeychain`] and holds no keychain code: the operating system's
//! credential store is one keychain and the daemon's items file, where that store cannot be used,
//! the other, so the store's rules run in tests without touching a real keychain.
//!
//! Call order is the caller's contract. Seal the value before writing the record, so a refusing
//! keychain leaves no record naming a missing value. To delete, mark the record's removal, remove
//! the value, then remove the record, so a crash in between is finished at the next start instead
//! of leaving a value with no record.
//!
//! A keychain that accepts a write may not have kept it (a locked login keychain or a policy on the
//! Windows credential store can drop it without an error), so every seal reads the value back and
//! compares.

use std::borrow::Cow;
use std::error::Error;
use std::sync::Arc;

use futures::future::BoxFuture;
use secrecy::{ExposeSecret, SecretString};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_contracts::workflow::secret::{
    WorkflowSecretId, WorkflowSecretStoreUnavailableDetails, WorkflowSecretValue,
};
use subtle::ConstantTimeEq as _;

use crate::ipc::domain_error::DomainError;

/// The keychain service the workflow secrets' values are filed under.
#[expect(
    dead_code,
    reason = "the daemon's start builds the workflow secret store's keychain under this service"
)]
pub(crate) const WORKFLOW_SECRET_KEYCHAIN_SERVICE: &str = "ai-sidekicks-workflow-secrets";

/// One keychain service's entries, each addressed by an account name. Every call fails with
/// [`WorkflowSecretStoreUnavailable`] when the keychain is locked, missing or silent; the operating
/// system's keychain answers in bounded time, and the items file when its file system answers.
pub(crate) trait SecretKeychain: Send + Sync {
    /// Writes `value` under `account`, replacing any value held there.
    fn write<'call>(
        &'call self,
        account: &'call str,
        value: &'call SecretString,
    ) -> BoxFuture<'call, Result<(), WorkflowSecretStoreUnavailable>>;

    /// The value held under `account`, or `None` when none is.
    fn read<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<Option<SecretString>, WorkflowSecretStoreUnavailable>>;

    /// Removes the value under `account`; `false` when none was held.
    fn remove<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<bool, WorkflowSecretStoreUnavailable>>;
}

/// The keychain could not be used: it is locked, or the machine has none the daemon can use. It
/// carries the keychain's own failure and never a secret value, and refuses a call with
/// `workflow.secret.storeUnavailable` and its cause.
#[derive(Debug, thiserror::Error)]
#[error("The workflow secret store could not be used: {reason}")]
pub(crate) struct WorkflowSecretStoreUnavailable {
    /// Why the keychain could not be used.
    cause: KeychainRefusalCause,
    /// What went wrong, in words a person reads.
    reason: Cow<'static, str>,
    /// The keychain's failure underneath, kept for the service log.
    #[source]
    failure: Option<Box<dyn Error + Send + Sync>>,
}

impl WorkflowSecretStoreUnavailable {
    /// A refusal for `cause`, with `reason` in words a person reads, which must hold no secret
    /// value.
    pub(crate) fn new(cause: KeychainRefusalCause, reason: impl Into<Cow<'static, str>>) -> Self {
        Self {
            cause,
            reason: reason.into(),
            failure: None,
        }
    }

    /// The same refusal keeping the keychain's `failure` underneath, which must hold no secret
    /// value.
    pub(crate) fn with_failure(self, failure: impl Into<Box<dyn Error + Send + Sync>>) -> Self {
        Self {
            failure: Some(failure.into()),
            ..self
        }
    }

    /// Why the keychain could not be used.
    pub(crate) fn cause(&self) -> KeychainRefusalCause {
        self.cause
    }
}

impl From<WorkflowSecretStoreUnavailable> for DomainError {
    fn from(refusal: WorkflowSecretStoreUnavailable) -> Self {
        let refused = DomainError::new(
            refusal.to_string(),
            RefusalCode::WorkflowSecretStoreUnavailable,
        )
        .with_detail(WorkflowSecretStoreUnavailableDetails {
            cause: refusal.cause(),
        });
        match refusal.failure {
            Some(failure) => refused.with_source(failure),
            None => refused,
        }
    }
}

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
    /// Fails with [`WorkflowSecretStoreUnavailable`] when the keychain is locked, missing, or did
    /// not keep the value.
    pub(crate) async fn seal(
        &self,
        secret_id: WorkflowSecretId,
        value: &WorkflowSecretValue,
    ) -> Result<(), WorkflowSecretStoreUnavailable> {
        let account = secret_id.text();
        let sealed = SecretString::from(value.as_str());
        self.keychain.write(account.as_str(), &sealed).await?;
        let kept = self.keychain.read(account.as_str()).await?;
        // Compared in constant time, so the check leaks nothing about the value through timing.
        let is_kept = kept.is_some_and(|kept| {
            bool::from(
                kept.expose_secret()
                    .as_bytes()
                    .ct_eq(value.as_str().as_bytes()),
            )
        });
        if is_kept {
            Ok(())
        } else {
            Err(WorkflowSecretStoreUnavailable::new(
                KeychainRefusalCause::Unavailable,
                "it accepted the value but did not keep it",
            ))
        }
    }

    /// The secret's value, or `None` when the keychain holds none, which the step that asked
    /// reports as `workflow.secret.notFound`. Fails when the keychain cannot be used.
    pub(crate) async fn resolve(
        &self,
        secret_id: WorkflowSecretId,
    ) -> Result<Option<SecretString>, WorkflowSecretStoreUnavailable> {
        self.keychain.read(secret_id.text().as_str()).await
    }

    /// Removes a secret's value; removing one that is already gone succeeds. Fails when the
    /// keychain cannot be used.
    pub(crate) async fn remove(
        &self,
        secret_id: WorkflowSecretId,
    ) -> Result<(), WorkflowSecretStoreUnavailable> {
        self.keychain
            .remove(secret_id.text().as_str())
            .await
            .map(|_was_held| ())
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

    use super::{SecretKeychain, WorkflowSecretStore, WorkflowSecretStoreUnavailable};
    use crate::ipc::domain_error::DomainError;

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
        ) -> BoxFuture<'call, Result<(), WorkflowSecretStoreUnavailable>> {
            let mut shorter = value.expose_secret().to_owned();
            shorter.pop();
            *self.kept.lock().expect("no test thread panics holding it") = Some(shorter);
            Box::pin(async { Ok(()) })
        }

        fn read<'call>(
            &'call self,
            _account: &'call str,
        ) -> BoxFuture<'call, Result<Option<SecretString>, WorkflowSecretStoreUnavailable>>
        {
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
        ) -> BoxFuture<'call, Result<bool, WorkflowSecretStoreUnavailable>> {
            Box::pin(async { Ok(false) })
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
        let refused = DomainError::from(refusal);
        assert_eq!(refused.code, RefusalCode::WorkflowSecretStoreUnavailable);
        for written in [refused.to_string(), format!("{refused:?}")] {
            assert!(!written.contains("hunter2"), "{written}");
        }
    }
}
