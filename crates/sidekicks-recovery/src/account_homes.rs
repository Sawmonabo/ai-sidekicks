//! The start's sweep of the homes minted for new accounts that a stop left with no row: each such
//! home is signed out through its provider and removed, while a home a row names only loses its
//! mark, and the home of an account removed from the list, which carries no mark, stays as it is.

use std::collections::HashMap;
use std::hash::BuildHasher;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_provider::account::credential_home::minted::{
    MintedHome, clear_minted_mark, read_minted_homes,
};
use sidekicks_provider::account::registry::ProviderAccountRegistry;
use sidekicks_provider::account::resolver::credential_home_folders;
use sidekicks_provider::driver::contract::account::ProviderAccountLegs;

/// Signs out and removes every home under `data_folder` minted for an account no row names, each
/// sign-out within `bound`; a home whose sign-out fails stays for the next start, and a home a row
/// names loses its mark. Logs each failure and never fails, as a later start sweeps again.
pub async fn remove_unadmitted_homes<S: BuildHasher>(
    registry: &ProviderAccountRegistry,
    legs: &HashMap<ProviderId, Arc<dyn ProviderAccountLegs>, S>,
    data_folder: PathBuf,
    bound: Duration,
) {
    let minted = match run_on_blocking_thread(move || read_minted_homes(&data_folder)).await {
        Ok(minted) => minted,
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "the homes of new accounts were not read; the next start sweeps them"
            );
            return;
        }
    };
    if minted.is_empty() {
        return;
    }
    let admitted = match registry.list(None).await {
        Ok(accounts) => accounts,
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "the accounts were not read; the next start sweeps the homes of new accounts"
            );
            return;
        }
    };
    for home in minted {
        if admitted
            .iter()
            .any(|account| account.account_id == home.account_id)
        {
            if let Err(error) = run_on_blocking_thread(move || clear_minted_mark(&home.home)).await
            {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "an admitted account's home kept its minted mark; the next start clears it"
                );
            }
            continue;
        }
        remove_unadmitted_home(home, legs, bound).await;
    }
}

// Signs `home` out through its provider, when one is registered, then removes it; a home whose
// sign-out fails or overruns stays, so its sign-in is never left behind a removed folder.
async fn remove_unadmitted_home<S: BuildHasher>(
    home: MintedHome,
    legs: &HashMap<ProviderId, Arc<dyn ProviderAccountLegs>, S>,
    bound: Duration,
) {
    if let Some(legs) = legs.get(&home.provider) {
        let folders = credential_home_folders(&home.provider, &home.home);
        match tokio::time::timeout(bound, legs.sign_out_home(home.account_id.clone(), folders))
            .await
        {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                tracing::warn!(
                    provider = home.provider.as_str(),
                    error = &error as &(dyn std::error::Error + 'static),
                    "a new account's home was not signed out; the next start sweeps it"
                );
                return;
            }
            Err(_elapsed) => {
                tracing::warn!(
                    provider = home.provider.as_str(),
                    "a new account's sign-out outlived its bound; the next start sweeps its home"
                );
                return;
            }
        }
    }
    let provider = home.provider.clone();
    let path = home.home.path().to_path_buf();
    if let Err(error) =
        run_on_blocking_thread(move || sidekicks_platforms::remove_tree(&path)).await
    {
        tracing::warn!(
            provider = provider.as_str(),
            error = &error as &(dyn std::error::Error + 'static),
            "a new account's home was not removed; the next start sweeps it"
        );
    }
}

// Runs a file-system step off the runtime's threads.
async fn run_on_blocking_thread<T: Send + 'static>(
    step: impl FnOnce() -> io::Result<T> + Send + 'static,
) -> io::Result<T> {
    tokio::task::spawn_blocking(step)
        .await
        .map_err(io::Error::other)
        .flatten()
}

#[cfg(test)]
mod tests;
