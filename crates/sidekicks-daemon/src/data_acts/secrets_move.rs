//! The modes that move the daemon's own secrets between the login keychain and the items file of a
//! Mac's service running while the person is logged out, run from the person's login session.
//!
//! - **`secrets move files|keychain`** holds the data folder's lock, so it is refused while a
//!   service runs. It first moves every registered account's provider sign-in kept in the login
//!   keychain the same way, one at a time, into its sign-in file going to the files and back into
//!   its keychain item going to the keychain. It then moves every item into the place it names,
//!   each written, read back and then deleted from its source, the place record naming the move
//!   until the last delete. Each sign-in's move takes the keychain's one turn, as every call on
//!   the items does, so no two calls meet one prompt. When either step is refused, it puts every
//!   sign-in and every item it moved back where it was and the place record back at the move's
//!   start before it answers, naming beside the refusal anything it could not put back, so a
//!   later start finishes nothing.
//! - **`secrets check keychain`** takes no lock and changes nothing the service keeps: it writes,
//!   reads back and deletes one value under an account of its own, so it runs while the service
//!   that runs while the person is logged out holds the folder.
//!
//! Each installs no log and answers one JSON object on its standard output.

use std::fmt::Write as _;
use std::process::ExitCode;

use sidekicks_contracts::daemon::mode_outcome::DaemonModeOutcome;
use sidekicks_contracts::daemon::secrets_place::SecretsMoveDestination;
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_platforms::{
    KeychainItemRefusal, KeychainSignIn, SignInMoveError, Spawner, sign_in_move,
};
use sidekicks_provider::driver::{PROVIDER_REGISTRATIONS, ProviderDescriptor};
use sidekicks_std::error_description::describe_error;
use sidekicks_std::keyed_lock::HeldWorkEnd;

use crate::data_acts::mode_outcome::{
    ModeFolders, hold_data_folder, keychain_unavailable, login_session_secret_items, not_started,
    run_data_folder_mode, store_unavailable, write_mode_outcome,
};
use crate::data_acts::provider_accounts::{helper_mode_services, read_account_homes};

/// Runs `secrets move <destination>`. Exits 0 once every provider sign-in and every item is in
/// the place `destination` names; exits 1 with `daemon.dataFolder.held` while the data folder is
/// held, `daemon.data.storeUnavailable` when a place refuses, a provider's sign-ins cannot be
/// moved or the secrets sit outside the pair, an internal error for a word no destination has, or,
/// when the outcome cannot be written, that failure on standard error.
pub(crate) fn run_secrets_move_mode(destination: &str) -> ExitCode {
    let Some(destination) = SecretsMoveDestination::from_word(destination) else {
        return write_mode_outcome(
            "move",
            &DaemonModeOutcome::failed(format!("the secrets have no place named {destination}")),
        );
    };
    run_data_folder_mode("move", move |folders| move_secrets(folders, destination))
}

/// Runs `secrets check keychain`, holding no lock. Exits 0 once the login keychain took, gave back
/// and deleted a value; exits 1 with `daemon.data.storeUnavailable` when it refused or kept another
/// value, or, when the outcome cannot be written, that failure on standard error.
pub(crate) fn run_keychain_check_mode() -> ExitCode {
    run_data_folder_mode("check", |folders| async move {
        let secret_items = match login_session_secret_items(folders.data_folder) {
            Ok(secret_items) => secret_items,
            Err(outcome) => return outcome,
        };
        match secret_items
            .check_destination(SecretsMoveDestination::OperatingSystem)
            .await
        {
            Ok(()) => DaemonModeOutcome::Result(()),
            Err(refusal) => store_unavailable(refusal),
        }
    })
}

// Holds the data folder, reaches the secrets and names every sign-in to move before anything
// moves, then moves the provider sign-ins and then the secrets into `destination` under that hold.
async fn move_secrets(
    folders: ModeFolders,
    destination: SecretsMoveDestination,
) -> DaemonModeOutcome<()> {
    let _lock = match hold_data_folder(&folders.data_folder).await {
        Ok(lock) => lock,
        Err(outcome) => return outcome,
    };
    let secret_items = match login_session_secret_items(folders.data_folder.clone()) {
        Ok(secret_items) => secret_items,
        Err(outcome) => return outcome,
    };
    let move_secret_items = async {
        match secret_items.move_to(destination).await {
            Ok(()) => DaemonModeOutcome::Result(()),
            Err(refusal) => store_unavailable(refusal),
        }
    };
    let Some(sign_in_move) = sign_in_move() else {
        return move_secret_items.await;
    };
    let (spawner, sign_ins) = match name_keychain_sign_ins(&folders).await {
        Ok(Some(named)) => named,
        Ok(None) => return move_secret_items.await,
        Err(outcome) => return outcome,
    };
    let turn = secret_items.keychain_turn();
    // One sign-in's move is one call in the keychain's turn, each of its steps held to the turn's
    // call time; past that time from its turn the move answers as overran, its turn kept until it
    // ends, so the put-back behind it never meets it.
    let move_one = |toward: SecretsMoveDestination, sign_in: KeychainSignIn| {
        let (sign_in_move, spawner, turn) = (sign_in_move.clone(), spawner.clone(), turn.clone());
        async move {
            let service = sign_in.service.clone();
            let step_bound = turn.call_timeout();
            let moving = async move {
                let sign_ins = [sign_in];
                match toward {
                    SecretsMoveDestination::LoggedOutServiceFile => {
                        sign_in_move
                            .move_into_files(&spawner, &sign_ins, step_bound)
                            .await
                    }
                    SecretsMoveDestination::OperatingSystem => {
                        sign_in_move
                            .move_into_keychain(&spawner, &sign_ins, step_bound)
                            .await
                    }
                }
            };
            match turn.run(&service, moving, Result::is_ok).await {
                Ok(moved) => moved,
                Err(HeldWorkEnd::Unanswered) => Err(SignInMoveError::Overran),
                Err(HeldWorkEnd::Interrupted(stopped)) => Err(SignInMoveError::Stopped(stopped)),
            }
        }
    };
    move_sign_ins_then(&sign_ins, destination, move_one, move_secret_items).await
}

// One registered account's provider sign-in kept in the login keychain, with its provider, which
// a refusal names.
struct ProviderSignIn {
    provider: &'static ProviderDescriptor,
    sign_in: KeychainSignIn,
}

// The spawner the moves start the keychain tool on and every registered account's provider
// sign-in kept in the login keychain, named before any moves; `None` with no account registered.
// Fails as an internal error when the accounts cannot be read or a sign-in cannot be named.
async fn name_keychain_sign_ins(
    folders: &ModeFolders,
) -> Result<Option<(Spawner, Vec<ProviderSignIn>)>, DaemonModeOutcome<()>> {
    let homes = read_account_homes(&folders.data_folder)
        .await
        .map_err(|failure| DaemonModeOutcome::failed(describe_error(&failure)))?;
    if homes.is_empty() {
        return Ok(None);
    }
    let services = helper_mode_services(folders)
        .await
        .map_err(|failure| DaemonModeOutcome::failed(describe_error(&failure)))?;
    let mut sign_ins = Vec::new();
    for registration in PROVIDER_REGISTRATIONS {
        let legs = (registration.helper_mode_account_legs)(&services);
        for home in homes
            .iter()
            .filter(|home| home.provider == registration.descriptor.id)
        {
            let account_folders = home
                .folders()
                .map_err(|failure| not_started("an account's folders are not known", &failure))?;
            let sign_in = legs.keychain_sign_in(&account_folders).map_err(|failure| {
                not_started("an account's sign-in could not be named", &failure)
            })?;
            sign_ins.extend(sign_in.map(|sign_in| ProviderSignIn {
                provider: registration.descriptor,
                sign_in,
            }));
        }
    }
    Ok(Some((services.spawner, sign_ins)))
}

// Moves each of `sign_ins` toward `destination` through `move_one`, one at a time, and then runs
// `then`. A refusal of either puts every sign-in moved before it back through `move_one` before
// it is answered, so a refused move leaves each sign-in where it was; a sign-in that cannot be put
// back is named in the refusal's message beside its cause. A sign-in with nothing to move counts
// as moved, and the one refused is never put back, since its source still holds it whole or its
// refusal names the copy it left.
async fn move_sign_ins_then<MoveOne, Moving>(
    sign_ins: &[ProviderSignIn],
    destination: SecretsMoveDestination,
    move_one: MoveOne,
    then: impl Future<Output = DaemonModeOutcome<()>>,
) -> DaemonModeOutcome<()>
where
    MoveOne: Fn(SecretsMoveDestination, KeychainSignIn) -> Moving,
    Moving: Future<Output = Result<(), SignInMoveError>>,
{
    let mut moved = 0;
    let mut refusal = loop {
        let Some(provider_sign_in) = sign_ins.get(moved) else {
            match then.await {
                DaemonModeOutcome::Result(()) => return DaemonModeOutcome::Result(()),
                refusal @ DaemonModeOutcome::Error(_) => break refusal,
            }
        };
        if let Err(refusal) = move_one(destination, provider_sign_in.sign_in.clone()).await {
            break sign_ins_refused(provider_sign_in.provider, &refusal);
        }
        moved += 1;
    };
    let back = match destination {
        SecretsMoveDestination::LoggedOutServiceFile => SecretsMoveDestination::OperatingSystem,
        SecretsMoveDestination::OperatingSystem => SecretsMoveDestination::LoggedOutServiceFile,
    };
    for provider_sign_in in &sign_ins[..moved] {
        let Err(failure) = move_one(back, provider_sign_in.sign_in.clone()).await else {
            continue;
        };
        if let DaemonModeOutcome::Error(error) = &mut refusal {
            write!(
                error.message,
                "; a {} sign-in it had moved could not be put back: {}",
                provider_sign_in.provider.name(),
                describe_error(&failure)
            )
            .expect("a string takes every write");
        }
    }
    refusal
}

// `daemon.data.storeUnavailable` naming the provider whose sign-ins did not move and why; the
// cause is `locked` only for a locked keychain.
fn sign_ins_refused(
    provider: &ProviderDescriptor,
    refusal: &SignInMoveError,
) -> DaemonModeOutcome<()> {
    keychain_unavailable(
        sign_in_refusal_cause(refusal),
        format!(
            "the {} sign-ins could not be moved: {}",
            provider.name(),
            describe_error(refusal)
        ),
    )
}

// `locked` for a move a locked keychain refused, a copy left behind by one included, else
// `unavailable`.
fn sign_in_refusal_cause(refusal: &SignInMoveError) -> KeychainRefusalCause {
    match refusal {
        SignInMoveError::Keychain {
            refusal: KeychainItemRefusal::Locked,
            ..
        } => KeychainRefusalCause::Locked,
        SignInMoveError::CopyLeft { refusal, .. } => sign_in_refusal_cause(refusal),
        SignInMoveError::Keychain { .. }
        | SignInMoveError::File(_)
        | SignInMoveError::Write(_)
        | SignInMoveError::CopyDiffers { .. }
        | SignInMoveError::TooLongForTheKeychainTool { .. }
        | SignInMoveError::Overran
        | SignInMoveError::Stopped(_) => KeychainRefusalCause::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::Mutex;

    use rstest::rstest;
    use sidekicks_contracts::daemon::mode_outcome::DaemonModeOutcome;
    use sidekicks_contracts::daemon::secrets_place::SecretsMoveDestination;
    use sidekicks_contracts::keychain::KeychainRefusalCause;
    use sidekicks_platforms::{KeychainItemRefusal, KeychainSignIn, SignInMoveError};
    use sidekicks_provider::driver::PROVIDER_REGISTRATIONS;

    use super::{ProviderSignIn, move_sign_ins_then};
    use crate::data_acts::mode_outcome::keychain_unavailable;

    // Two accounts' sign-ins move toward the files and either the second's keychain read or the
    // secrets' own move after both is refused as a locked keychain: every sign-in already in its
    // file is back in its item, and the refusal names the locked keychain with no put-back failure
    // beside it; where the first's move back is refused too, it stays in its file and the refusal
    // names it. Killed by the put-back skipped, and by a put-back's failure left unnamed.
    #[rstest]
    #[case::second_sign_in_refused("second", None)]
    #[case::secrets_move_refused("none", None)]
    #[case::put_back_refused("second", Some("first"))]
    #[tokio::test]
    async fn a_refused_move_puts_every_sign_in_moved_before_it_back(
        #[case] refused_account: &str,
        #[case] refused_put_back: Option<&str>,
    ) {
        let provider = PROVIDER_REGISTRATIONS[0].descriptor;
        let sign_ins = ["first", "second"].map(|account| ProviderSignIn {
            provider,
            sign_in: KeychainSignIn {
                service: "service".to_owned(),
                account: account.to_owned(),
                file: PathBuf::from(account),
            },
        });
        let places: Mutex<HashMap<String, SecretsMoveDestination>> = Mutex::new(
            ["first", "second"]
                .map(|account| (account.to_owned(), SecretsMoveDestination::OperatingSystem))
                .into(),
        );
        let move_one = |toward: SecretsMoveDestination, sign_in: KeychainSignIn| {
            let places = &places;
            async move {
                let refused = match toward {
                    SecretsMoveDestination::LoggedOutServiceFile => Some(refused_account),
                    SecretsMoveDestination::OperatingSystem => refused_put_back,
                };
                if refused == Some(sign_in.account.as_str()) {
                    return Err(SignInMoveError::Keychain {
                        service: sign_in.service,
                        account: sign_in.account,
                        refusal: KeychainItemRefusal::Locked,
                    });
                }
                places
                    .lock()
                    .expect("the places are readable")
                    .insert(sign_in.account, toward);
                Ok(())
            }
        };

        let outcome = move_sign_ins_then(
            &sign_ins,
            SecretsMoveDestination::LoggedOutServiceFile,
            move_one,
            async {
                keychain_unavailable(
                    KeychainRefusalCause::Locked,
                    "the login keychain is locked".to_owned(),
                )
            },
        )
        .await;

        let places = places.into_inner().expect("the places are readable");
        for account in ["first", "second"] {
            let expected = if refused_put_back == Some(account) {
                SecretsMoveDestination::LoggedOutServiceFile
            } else {
                SecretsMoveDestination::OperatingSystem
            };
            assert_eq!(places[account], expected, "the {account} sign-in");
        }
        let DaemonModeOutcome::Error(refusal) = outcome else {
            panic!("a refused sign-in answered a moved one");
        };
        let put_back_failure = "sign-in it had moved could not be put back";
        if refused_put_back.is_some() {
            assert!(
                refusal.message.contains(put_back_failure),
                "{}",
                refusal.message
            );
        } else {
            assert!(
                refusal.message.ends_with("the login keychain is locked"),
                "{}",
                refusal.message
            );
        }
    }
}
