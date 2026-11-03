//! Account legs for tests here and in the crates above, which record each sign-out and run none.

use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use sidekicks_contracts::provider::account::record::ProviderAccountId;

use crate::account::registry::ProviderAccountRegistry;
use crate::driver::ProviderAccountFolders;
use crate::driver::contract::account::{
    ProviderAccountLegs, ProviderMemoryImportLegs, ProviderObserveLegs, ProviderSignInLegs,
    ProviderSwitchLegs, ProviderTokenLimitsLegs, ProviderTokenStatusLegs, ProviderWindowTurnLegs,
};
use crate::driver::contract::error::DriverError;

/// Account legs whose sign-out records the account and folders it ran for and succeeds, but for
/// the account `refused` names, whose provider refuses it.
#[derive(Default)]
pub struct RecordedSignOuts {
    signed_out: Mutex<Vec<(ProviderAccountId, ProviderAccountFolders)>>,
    refused: Option<ProviderAccountId>,
}

impl RecordedSignOuts {
    /// Legs whose provider refuses `refused`'s sign-out.
    pub fn refusing(refused: ProviderAccountId) -> Self {
        Self {
            refused: Some(refused),
            ..Self::default()
        }
    }

    /// Each sign-out run so far, with the account and the folders it ran in.
    pub fn signed_out(&self) -> Vec<(ProviderAccountId, ProviderAccountFolders)> {
        self.signed_out
            .lock()
            .expect("the record is not poisoned")
            .clone()
    }
}

impl ProviderAccountLegs for RecordedSignOuts {
    fn sign_out_home(
        &self,
        provider_account_id: ProviderAccountId,
        folders: ProviderAccountFolders,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        let is_refused = self.refused.as_ref() == Some(&provider_account_id);
        self.signed_out
            .lock()
            .expect("the record is not poisoned")
            .push((provider_account_id, folders));
        Box::pin(async move {
            if is_refused {
                return Err(DriverError::Internal(
                    "the provider refused the sign-out".into(),
                ));
            }
            Ok(())
        })
    }

    fn remove_sign_in_move_leftovers<'call>(
        &'call self,
        _registry: &'call ProviderAccountRegistry,
    ) -> BoxFuture<'call, Result<Vec<std::io::Error>, DriverError>> {
        unreachable!("the reset sweeps nothing")
    }

    fn observe_legs(self: Arc<Self>) -> Option<Arc<dyn ProviderObserveLegs>> {
        None
    }

    fn memory_import_legs(self: Arc<Self>) -> Option<Arc<dyn ProviderMemoryImportLegs>> {
        None
    }

    fn switch_legs(self: Arc<Self>) -> Option<Arc<dyn ProviderSwitchLegs>> {
        None
    }

    fn window_turn_legs(self: Arc<Self>) -> Option<Arc<dyn ProviderWindowTurnLegs>> {
        None
    }

    fn token_limits_legs(self: Arc<Self>) -> Option<Arc<dyn ProviderTokenLimitsLegs>> {
        None
    }

    fn sign_in_legs(self: Arc<Self>) -> Option<Arc<dyn ProviderSignInLegs>> {
        None
    }

    fn token_status_legs(self: Arc<Self>) -> Option<Arc<dyn ProviderTokenStatusLegs>> {
        None
    }
}
