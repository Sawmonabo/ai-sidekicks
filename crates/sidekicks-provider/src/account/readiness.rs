//! Each provider's readiness to start a run, derived from the registry's stored rows alone: the
//! provider's current account resolved as run admission resolves it, that account's stored health
//! reported verbatim, and the one remedy its state calls for. It starts no process, looks at no
//! folder and opens no credential file, so a surface may read it as often as it likes; whether a
//! home is missing is the stored observation's word, never a fresh look.

use sidekicks_contracts::provider::account::record::readiness::{
    ChooseCurrentRemedyKind, LookAgainRemedyKind, ProviderChooseCurrentRemedy,
    ProviderLookAgainRemedy, ProviderReadiness, ProviderRegisterRemedy,
    ProviderSignInExpiredRemedy, ProviderSignInRemedy, RegisterRemedyKind, SignInRemedyKind,
};
use sidekicks_contracts::provider::account::record::{
    ProviderAccountHealthState, ProviderAccountId, ProviderAuthMode,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::list::BoundedVec;

use crate::account::registry::RegisteredAccount;

/// One readiness entry for each of `providers`, in their order, from `accounts`, the registered
/// accounts as the registry lists them; an account of a provider not named is passed over.
pub fn derive_provider_readiness(
    providers: &[ProviderId],
    accounts: &[RegisteredAccount],
) -> Vec<ProviderReadiness> {
    providers
        .iter()
        .map(|provider| {
            let provider_accounts: Vec<&RegisteredAccount> = accounts
                .iter()
                .filter(|account| &account.provider == provider)
                .collect();
            match resolve_current_account(&provider_accounts) {
                CurrentAccount::NoAccount => ProviderReadiness::NoAccount {
                    provider: provider.clone(),
                    resolved_account_id: None,
                    observed_at: None,
                    remedy: ProviderRegisterRemedy {
                        kind: RegisterRemedyKind::Value,
                        provider: provider.clone(),
                    },
                },
                CurrentAccount::NoCurrent => ProviderReadiness::NoCurrent {
                    provider: provider.clone(),
                    resolved_account_id: None,
                    // A candidate's observation describes an account resolution did not reach.
                    observed_at: None,
                    remedy: ProviderChooseCurrentRemedy {
                        kind: ChooseCurrentRemedyKind::Value,
                        candidate_account_ids: BoundedVec::new(
                            provider_accounts
                                .iter()
                                .map(|account| account.account_id.clone())
                                .collect(),
                        )
                        .expect("a provider with no current account has an account to choose"),
                    },
                },
                CurrentAccount::Resolved(account) => resolved_account_readiness(account),
            }
        })
        .collect()
}

// Where resolution of a provider's current account lands: no account, accounts with none current
// (never elected here, since that would pick who pays), or the one current account.
enum CurrentAccount<'account> {
    NoAccount,
    NoCurrent,
    Resolved(&'account RegisteredAccount),
}

fn resolve_current_account<'account>(
    accounts: &[&'account RegisteredAccount],
) -> CurrentAccount<'account> {
    if accounts.is_empty() {
        return CurrentAccount::NoAccount;
    }
    accounts
        .iter()
        .find(|account| account.is_default)
        .map_or(CurrentAccount::NoCurrent, |account| {
            CurrentAccount::Resolved(account)
        })
}

// The resolved account's stored health as its arm, with the remedy that arm calls for; an account
// never observed is undecided.
fn resolved_account_readiness(account: &RegisteredAccount) -> ProviderReadiness {
    let provider = account.provider.clone();
    let resolved_account_id = account.account_id.clone();
    let Some(health) = &account.health else {
        return ProviderReadiness::Indeterminate {
            provider,
            remedy: look_again(&resolved_account_id),
            resolved_account_id,
            observed_at: None,
        };
    };
    let observed_at = Some(health.observed_at.clone());
    match health.state {
        ProviderAccountHealthState::Authenticated => ProviderReadiness::Authenticated {
            provider,
            resolved_account_id: Some(resolved_account_id),
            observed_at,
        },
        ProviderAccountHealthState::ReauthRequired => ProviderReadiness::ReauthRequired {
            provider,
            remedy: sign_in_expired_remedy(account),
            resolved_account_id,
            observed_at,
        },
        ProviderAccountHealthState::HomeMissing => ProviderReadiness::HomeMissing {
            provider,
            remedy: ProviderSignInRemedy {
                kind: SignInRemedyKind::Value,
                account_id: resolved_account_id.clone(),
            },
            resolved_account_id,
            observed_at,
        },
        ProviderAccountHealthState::Indeterminate => ProviderReadiness::Indeterminate {
            provider,
            remedy: look_again(&resolved_account_id),
            resolved_account_id,
            observed_at,
        },
    }
}

// A token or API-key account cannot refresh itself, so its one remedy is a fresh token pasted in;
// every other mode, an unrecognized or unobserved one included, signs in through the provider.
fn sign_in_expired_remedy(account: &RegisteredAccount) -> ProviderSignInExpiredRemedy {
    let account_id = account.account_id.clone();
    match account.observed_auth_mode {
        Some(ProviderAuthMode::OauthToken | ProviderAuthMode::ApiKey) => {
            ProviderSignInExpiredRemedy::PasteToken { account_id }
        }
        Some(
            ProviderAuthMode::OauthSubscription
            | ProviderAuthMode::External
            | ProviderAuthMode::None
            | ProviderAuthMode::Unknown,
        )
        | None => ProviderSignInExpiredRemedy::SignIn { account_id },
    }
}

fn look_again(account_id: &ProviderAccountId) -> ProviderLookAgainRemedy {
    ProviderLookAgainRemedy {
        kind: LookAgainRemedyKind::Value,
        account_id: account_id.clone(),
    }
}

#[cfg(test)]
mod tests;
