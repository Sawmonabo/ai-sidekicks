//! A credential store for tests held in this process's memory alone: keyring-core's mock store,
//! listed as every system store lists, naming only the items written.

use std::any::Any;
use std::collections::HashMap;
use std::sync::{Arc, PoisonError};

use keyring_core::Entry;
use keyring_core::api::CredentialStoreApi;
use keyring_core::mock::{Cred, Store};

/// keyring-core's mock store, whose own search also names every entry only built on it, behind a
/// search that names only those holding a value.
#[derive(Debug)]
pub(crate) struct InMemoryCredentialStore {
    store: Arc<Store>,
}

impl InMemoryCredentialStore {
    /// An empty store.
    pub(crate) fn new() -> Self {
        Self {
            store: Store::new().expect("the in-memory store builds without a failure"),
        }
    }
}

impl CredentialStoreApi for InMemoryCredentialStore {
    fn vendor(&self) -> String {
        self.store.vendor()
    }

    fn id(&self) -> String {
        self.store.id()
    }

    fn build(
        &self,
        service: &str,
        account: &str,
        modifiers: Option<&HashMap<&str, &str>>,
    ) -> keyring_core::Result<Entry> {
        self.store.build(service, account, modifiers)
    }

    fn search(&self, spec: &HashMap<&str, &str>) -> keyring_core::Result<Vec<Entry>> {
        let mut entries = self.store.search(spec)?;
        entries.retain(is_written);
        Ok(entries)
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

// Whether `entry` holds a value, read from the mock's own record so no refusal a test set on it
// is spent.
fn is_written(entry: &Entry) -> bool {
    entry.as_any().downcast_ref::<Cred>().is_some_and(|cred| {
        cred.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .borrow()
            .secret
            .is_some()
    })
}
