//! A credential store for tests whose every call blocks until the test releases it, as a locked
//! store's call waits on its unlock prompt, counting the calls it received.

use std::any::Any;
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, PoisonError};

use keyring_core::api::{CredentialApi, CredentialStoreApi};
use keyring_core::{Credential, Entry};
use tokio::sync::watch;

/// A credential store whose calls each wait until [`BlockingCredentialStore::release`], then answer
/// as a store holding nothing: a write succeeds, a read and a removal find no value. Every call
/// waiting must be released before the test's runtime drops, since the drop waits on it.
#[derive(Debug)]
pub struct BlockingCredentialStore {
    calls: Arc<HeldCalls>,
}

impl BlockingCredentialStore {
    /// A store holding every call until it is released.
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            calls: Arc::new(HeldCalls {
                is_released: Mutex::new(false),
                released: Condvar::new(),
                received: watch::Sender::new(0),
            }),
        })
    }

    /// Lets every call waiting, and every later one, answer.
    pub fn release(&self) {
        *self
            .calls
            .is_released
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = true;
        self.calls.released.notify_all();
    }

    /// The calls the store has received, those still waiting included.
    pub fn calls(&self) -> usize {
        *self.calls.received.borrow()
    }

    /// Waits until the store has received `count` calls.
    pub async fn wait_for_calls(&self, count: usize) {
        let mut received = self.calls.received.subscribe();
        // The sender lives in `self`, which outlives this wait, so the wait ends only on the count.
        drop(received.wait_for(|received| *received >= count).await);
    }
}

impl CredentialStoreApi for BlockingCredentialStore {
    fn vendor(&self) -> String {
        String::from("a test store whose calls wait to be released")
    }

    fn id(&self) -> String {
        String::from("blocking")
    }

    fn build(
        &self,
        service: &str,
        account: &str,
        _modifiers: Option<&HashMap<&str, &str>>,
    ) -> keyring_core::Result<Entry> {
        Ok(Entry::new_with_credential(Arc::new(BlockingCredential {
            calls: Arc::clone(&self.calls),
            specifiers: (service.to_owned(), account.to_owned()),
        })))
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

// The calls the store and its entries share: whether they are released, and how many arrived.
#[derive(Debug)]
struct HeldCalls {
    is_released: Mutex<bool>,
    released: Condvar,
    received: watch::Sender<usize>,
}

impl HeldCalls {
    fn answer_when_released(&self) {
        self.received.send_modify(|received| *received += 1);
        let is_released = self
            .is_released
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        drop(
            self.released
                .wait_while(is_released, |is_released| !*is_released)
                .unwrap_or_else(PoisonError::into_inner),
        );
    }
}

// One entry of the blocking store.
#[derive(Debug)]
struct BlockingCredential {
    calls: Arc<HeldCalls>,
    specifiers: (String, String),
}

impl CredentialApi for BlockingCredential {
    fn set_secret(&self, _secret: &[u8]) -> keyring_core::Result<()> {
        self.calls.answer_when_released();
        Ok(())
    }

    fn get_secret(&self) -> keyring_core::Result<Vec<u8>> {
        self.calls.answer_when_released();
        Err(keyring_core::Error::NoEntry)
    }

    fn delete_credential(&self) -> keyring_core::Result<()> {
        self.calls.answer_when_released();
        Err(keyring_core::Error::NoEntry)
    }

    fn get_credential(&self) -> keyring_core::Result<Option<Arc<Credential>>> {
        Ok(None)
    }

    fn get_specifiers(&self) -> Option<(String, String)> {
        Some(self.specifiers.clone())
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}
