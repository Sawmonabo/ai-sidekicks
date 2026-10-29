use ProviderAccountHealthState::{Authenticated, HomeMissing, Indeterminate, ReauthRequired};
use rstest::rstest;
use sidekicks_contracts::provider::account::record::readiness::{
    ChooseCurrentRemedyKind, LookAgainRemedyKind, ProviderChooseCurrentRemedy,
    ProviderLookAgainRemedy, ProviderReadiness, ProviderRegisterRemedy,
    ProviderSignInExpiredRemedy, ProviderSignInRemedy, RegisterRemedyKind, SignInRemedyKind,
};
use sidekicks_contracts::provider::account::record::{
    BillingMode, ProviderAccountHealthState, ProviderAccountId, ProviderAuthMode,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::list::BoundedVec;

use super::derive_provider_readiness;
use crate::account::credential_home::CredentialHome;
use crate::account::registry::{HealthObservation, RegisteredAccount};

const OBSERVED_AT: &str = "2026-10-29T12:00:00.000Z";

fn provider(id: &str) -> ProviderId {
    ProviderId::new(id.to_owned()).expect("a test provider id")
}

fn account_id(id: &str) -> ProviderAccountId {
    ProviderAccountId::new(id.to_owned()).expect("a test account id")
}

fn observed_at() -> WireInstant {
    WireInstant::try_from(OBSERVED_AT.to_owned()).expect("a test instant")
}

// A stored row as the registry lists it: `id` of `provider_id`, current or not, with its stored
// health (`None` never observed) and the mode its provider last reported.
fn row(
    provider_id: &str,
    id: &str,
    is_default: bool,
    health: Option<ProviderAccountHealthState>,
    observed_auth_mode: Option<ProviderAuthMode>,
) -> RegisteredAccount {
    RegisteredAccount {
        account_id: account_id(id),
        provider: provider(provider_id),
        credential_home: CredentialHome::from_stored(format!("/data/accounts/{id}")),
        credential_generation: serde_json::from_value(1.into()).expect("a test generation"),
        billing_mode: BillingMode::Subscription,
        is_default,
        health: health.map(|state| HealthObservation {
            state,
            observed_at: observed_at(),
        }),
        probe_enabled: true,
        window_start_enabled: true,
        wake_for_window_start_enabled: false,
        observed_auth_mode,
    }
}

fn no_account(provider_id: &str) -> ProviderReadiness {
    ProviderReadiness::NoAccount {
        provider: provider(provider_id),
        resolved_account_id: None,
        observed_at: None,
        remedy: ProviderRegisterRemedy {
            kind: RegisterRemedyKind::Value,
            provider: provider(provider_id),
        },
    }
}

fn reauth_required(id: &str, remedy: ProviderSignInExpiredRemedy) -> ProviderReadiness {
    ProviderReadiness::ReauthRequired {
        provider: provider("alpha"),
        resolved_account_id: account_id(id),
        observed_at: Some(observed_at()),
        remedy,
    }
}

fn indeterminate(id: &str, observed_at: Option<WireInstant>) -> ProviderReadiness {
    ProviderReadiness::Indeterminate {
        provider: provider("alpha"),
        resolved_account_id: account_id(id),
        observed_at,
        remedy: ProviderLookAgainRemedy {
            kind: LookAgainRemedyKind::Value,
            account_id: account_id(id),
        },
    }
}

// Each stored registry shape derives exactly one entry per selected provider, the arm its stored
// row names and the one remedy that arm calls for, none on `authenticated`, from the rows alone.
// Killed by `signIn` offered for a token or API-key account, by electing a current account where
// none is marked, and by a provider with no rows left out of the reply.
#[rstest]
#[case::no_accounts_on_the_machine(vec![], vec![no_account("alpha"), no_account("beta")])]
#[case::the_current_account_authenticated(
    vec![
        row("alpha", "a1", false, Some(ReauthRequired), None),
        row("alpha", "a2", true, Some(Authenticated), Some(ProviderAuthMode::OauthToken)),
        row("gamma", "g1", true, Some(ReauthRequired), None),
    ],
    vec![
        ProviderReadiness::Authenticated {
            provider: provider("alpha"),
            resolved_account_id: Some(account_id("a2")),
            observed_at: Some(observed_at()),
        },
        no_account("beta"),
    ],
)]
#[case::seeded_with_no_default(
    vec![
        row("alpha", "a1", false, Some(Authenticated), None),
        row("alpha", "a2", false, Some(Authenticated), None),
    ],
    vec![
        ProviderReadiness::NoCurrent {
            provider: provider("alpha"),
            resolved_account_id: None,
            observed_at: None,
            remedy: ProviderChooseCurrentRemedy {
                kind: ChooseCurrentRemedyKind::Value,
                candidate_account_ids: BoundedVec::new(vec![account_id("a1"), account_id("a2")])
                    .expect("two candidates"),
            },
        },
        no_account("beta"),
    ],
)]
#[case::a_token_account_signed_out(
    vec![row("alpha", "a1", true, Some(ReauthRequired), Some(ProviderAuthMode::OauthToken))],
    vec![
        reauth_required(
            "a1",
            ProviderSignInExpiredRemedy::PasteToken { account_id: account_id("a1") },
        ),
        no_account("beta"),
    ],
)]
#[case::an_api_key_account_signed_out(
    vec![row("alpha", "a1", true, Some(ReauthRequired), Some(ProviderAuthMode::ApiKey))],
    vec![
        reauth_required(
            "a1",
            ProviderSignInExpiredRemedy::PasteToken { account_id: account_id("a1") },
        ),
        no_account("beta"),
    ],
)]
#[case::a_subscription_account_signed_out(
    vec![row("alpha", "a1", true, Some(ReauthRequired), Some(ProviderAuthMode::OauthSubscription))],
    vec![
        reauth_required(
            "a1",
            ProviderSignInExpiredRemedy::SignIn { account_id: account_id("a1") },
        ),
        no_account("beta"),
    ],
)]
#[case::a_missing_home(
    vec![row("alpha", "a1", true, Some(HomeMissing), Some(ProviderAuthMode::OauthSubscription))],
    vec![
        ProviderReadiness::HomeMissing {
            provider: provider("alpha"),
            resolved_account_id: account_id("a1"),
            observed_at: Some(observed_at()),
            remedy: ProviderSignInRemedy {
                kind: SignInRemedyKind::Value,
                account_id: account_id("a1"),
            },
        },
        no_account("beta"),
    ],
)]
#[case::an_undecided_reading(
    vec![row("alpha", "a1", true, Some(Indeterminate), Some(ProviderAuthMode::OauthToken))],
    vec![indeterminate("a1", Some(observed_at())), no_account("beta")],
)]
#[case::never_observed(
    vec![row("alpha", "a1", true, None, None)],
    vec![indeterminate("a1", None), no_account("beta")],
)]
fn each_stored_shape_derives_one_entry_per_provider_with_its_one_remedy(
    #[case] accounts: Vec<RegisteredAccount>,
    #[case] expected: Vec<ProviderReadiness>,
) {
    let readiness = derive_provider_readiness(&[provider("alpha"), provider("beta")], &accounts);

    assert_eq!(readiness, expected);
}
