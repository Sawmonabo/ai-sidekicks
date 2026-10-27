//! Where the daemon keeps its secrets: on macOS and Windows each one an item in the operating
//! system's credential store, on Linux each one an item in the daemon's one items file, sealed to
//! this computer by systemd's credential service, or plain where that service cannot seal for it,
//! and on a Mac whose service runs while the person is logged out the same file, plain.
//!
//! A feature keeps its values through a [`SecretKeychain`], one keychain service's items addressed
//! by account, and holds no store code, so its rules run in tests without a real store. A refused
//! call is a [`KeychainRefusal`], which names no feature; each caller turns it into its own refusal
//! with the cause.

pub(crate) mod file;
pub(crate) mod items;
pub(crate) mod os;
pub(crate) mod place;
pub(crate) mod seal;
pub(crate) mod service;

use std::borrow::Cow;
use std::error::Error;

use futures::future::BoxFuture;
use secrecy::{ExposeSecret, SecretString};
use sidekicks_contracts::keychain::KeychainRefusalCause;
use subtle::ConstantTimeEq as _;

/// One keychain service's items, each addressed by an account name. Every call fails with
/// [`KeychainRefusal`] when the keychain is locked, missing or silent; the operating system's
/// keychain answers in bounded time, and the items file when its file system answers.
pub(crate) trait SecretKeychain: Send + Sync {
    /// Writes `value` under `account`, replacing any value held there.
    fn write<'call>(
        &'call self,
        account: &'call str,
        value: &'call SecretString,
    ) -> BoxFuture<'call, Result<(), KeychainRefusal>>;

    /// The value held under `account`, or `None` when none is.
    fn read<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<Option<SecretString>, KeychainRefusal>>;

    /// Removes the value under `account`; `false` when none was held.
    fn remove<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<bool, KeychainRefusal>>;

    /// Every account this service files an item under.
    fn accounts(&self) -> BoxFuture<'_, Result<Vec<String>, KeychainRefusal>>;

    /// Writes `value` under `account` and reads it back, since a keychain that accepts a write may
    /// not have kept it (a locked login keychain or a policy on the Windows credential store can
    /// drop it without an error). Fails with an `unavailable` refusal when it kept another value or
    /// none, naming neither.
    fn write_verified<'call>(
        &'call self,
        account: &'call str,
        value: &'call SecretString,
    ) -> BoxFuture<'call, Result<(), KeychainRefusal>> {
        Box::pin(async move {
            self.write(account, value).await?;
            if holds_value(self.read(account).await?.as_ref(), value) {
                Ok(())
            } else {
                Err(KeychainRefusal::new(
                    KeychainRefusalCause::Unavailable,
                    "it accepted the value but did not keep it",
                ))
            }
        })
    }
}

/// Whether `kept`, a value read back, is `value`, compared in constant time so the check leaks
/// nothing about either through timing.
pub(crate) fn holds_value(kept: Option<&SecretString>, value: &SecretString) -> bool {
    kept.is_some_and(|kept| {
        bool::from(
            kept.expose_secret()
                .as_bytes()
                .ct_eq(value.expose_secret().as_bytes()),
        )
    })
}

/// The keychain could not be used: it is locked, or the machine has none the daemon can use. It
/// carries the keychain's own failure and never a secret value, and names no feature: each caller
/// refuses with its own code and this cause.
#[derive(Debug, thiserror::Error)]
#[error("The keychain could not be used: {reason}")]
pub(crate) struct KeychainRefusal {
    /// Why the keychain could not be used.
    cause: KeychainRefusalCause,
    /// What went wrong, in words a person reads.
    reason: Cow<'static, str>,
    /// The keychain's failure underneath, kept for the service log.
    #[source]
    failure: Option<Box<dyn Error + Send + Sync>>,
}

impl KeychainRefusal {
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
    #[cfg(test)]
    pub(crate) fn cause(&self) -> KeychainRefusalCause {
        self.cause
    }

    /// What went wrong, in words a person reads.
    pub(crate) fn reason(&self) -> &str {
        &self.reason
    }

    /// Why the keychain could not be used and the keychain's failure underneath, which a caller
    /// turns into its own refusal beside this refusal's text.
    pub(crate) fn into_cause_and_failure(
        self,
    ) -> (KeychainRefusalCause, Option<Box<dyn Error + Send + Sync>>) {
        (self.cause, self.failure)
    }
}
