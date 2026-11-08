//! The start's sweep of the homes minted for new accounts that a stop left with no row: each such
//! home is signed out through its provider and removed, then its mark; an account a row names only
//! loses its mark, and the home of an account removed from the list, which carries a removed mark
//! this sweep never reads, stays as it is. The marks are read before any sign-in can mint an
//! account, so a sign-in under way never has its home swept; the sign-outs then run in the
//! background, all at once.

use std::collections::HashMap;
use std::hash::BuildHasher;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_provider::account::credential_home::marks::{
    MarkedHome, clear_minted_mark, read_minted_homes,
};
use sidekicks_provider::account::credential_home::remove_unadmitted_home;
use sidekicks_provider::account::registry::ProviderAccountRegistry;
use sidekicks_provider::driver::contract::account::ProviderAccountLegs;
use sidekicks_std::file::run_on_blocking_thread;

/// The homes a stop left minted for new accounts, each with whether a row names its account, read
/// at the start before any sign-in can mint another.
pub struct LeftoverMintedHomes {
    data_folder: PathBuf,
    homes: Vec<(MarkedHome, bool)>,
}

impl LeftoverMintedHomes {
    /// Reads the marked homes under `data_folder` and the rows of `registry`. Logs a failed read
    /// and then holds no home, as a later start sweeps again.
    pub async fn read(registry: &ProviderAccountRegistry, data_folder: PathBuf) -> Self {
        let marks_folder = data_folder.clone();
        let minted = match run_on_blocking_thread(move || read_minted_homes(&marks_folder)).await {
            Ok(minted) => minted,
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "the marks of new accounts were not read; the next start sweeps their homes"
                );
                Vec::new()
            }
        };
        if minted.is_empty() {
            return Self {
                data_folder,
                homes: Vec::new(),
            };
        }
        let homes = match registry.list(None).await {
            Ok(admitted) => minted
                .into_iter()
                .map(|home| {
                    let is_admitted = admitted
                        .iter()
                        .any(|account| account.account_id == home.account_id);
                    (home, is_admitted)
                })
                .collect(),
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "the accounts were not read; the next start sweeps the homes of new accounts"
                );
                Vec::new()
            }
        };
        Self { data_folder, homes }
    }

    /// Signs out and removes every home minted for an account no row names, all at once and each
    /// sign-out within `bound`, then clears its mark; a home whose sign-out fails stays marked for
    /// the next start, and an account a row names loses its mark. Logs each failure and never
    /// fails, as a later start sweeps again.
    pub async fn remove_unadmitted<S: BuildHasher>(
        self,
        legs: &HashMap<ProviderId, Arc<dyn ProviderAccountLegs>, S>,
        bound: Duration,
    ) {
        let data_folder = &self.data_folder;
        let sweeps = self
            .homes
            .into_iter()
            .map(|(home, is_admitted)| async move {
                if is_admitted
                    || remove_unadmitted_home(
                        &home.account_id,
                        &home.provider,
                        &home.home,
                        Some(legs),
                        bound,
                    )
                    .await
                {
                    let data_folder = data_folder.clone();
                    let account_id = home.account_id;
                    if let Err(error) =
                        run_on_blocking_thread(move || clear_minted_mark(&data_folder, &account_id))
                            .await
                    {
                        tracing::warn!(
                            error = &error as &(dyn std::error::Error + 'static),
                            "a new account's mark stays; the next start clears it"
                        );
                    }
                }
            });
        futures::future::join_all(sweeps).await;
    }
}

#[cfg(test)]
mod tests;
