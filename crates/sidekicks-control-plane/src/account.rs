//! The account's routes and what they keep: the passkey relying party and the tokens it issues.
//! Every route is one POST at `/<its wire name>`, served by the account's one writer: the account
//! object on the Workers relay, the relay's process on the Compose relay.

use std::error::Error;
use std::sync::Arc;

use axum::Router;
use axum::middleware::from_fn_with_state;
use axum::routing::post;
use sidekicks_contracts::method::Method;
use sidekicks_contracts::webauthn::ceremony::{
    WebAuthnAuthenticationOptionsIssue, WebAuthnAuthenticationVerify,
    WebAuthnRegistrationOptionsIssue, WebAuthnRegistrationVerify,
};
use sidekicks_contracts::webauthn::credential::WebAuthnCredentialRevoke;

use crate::account::settings::{AccountSettings, SettingError};
use crate::account::token::issuer::TokenIssueError;
use crate::account::webauthn::authenticator_list::AuthenticatorList;
use crate::account::webauthn::challenge::ChallengeError;
use crate::account::webauthn::verifier::{PasskeyVerifier, VerifierError};
use crate::account::webauthn::{authentication, credential, registration};
use crate::account_store::{AccountStoreError, SharedAccountStore};
use crate::rate_limit::enforcement_pipeline::AdmissionCheck;
use crate::rate_limit::layer::{CountedRoute, rate_limit};
use crate::rate_limit::limiter::{Clock, RateLimitEndpointGroup};
use crate::server::router::{ControlPlaneRefusal, RequestId};

pub mod aasa;
pub mod settings;
pub mod token;
pub(crate) mod user_record;
pub mod webauthn;

/// What the account routes share: the account store, the passkey verifier and the authenticator
/// list it names passkeys from, the settings read when the router was built, and the clock every
/// expiry reads.
#[derive(Clone)]
pub struct AccountRoutes<S, V, L> {
    store: S,
    verifier: V,
    authenticator_list: L,
    settings: Result<Arc<AccountSettings>, Arc<SettingError>>,
    clock: Clock,
}

impl<S, V, L> AccountRoutes<S, V, L> {
    /// The routes' state over `store`, `verifier` and `authenticator_list`, with `settings` as
    /// read; a settings error fails each route that needs them with the logged 500.
    pub fn new(
        store: S,
        verifier: V,
        authenticator_list: L,
        settings: Result<AccountSettings, SettingError>,
        clock: Clock,
    ) -> Self {
        Self {
            store,
            verifier,
            authenticator_list,
            settings: settings.map(Arc::new).map_err(Arc::new),
            clock,
        }
    }

    // The settings, or the logged 500 when they did not read.
    fn read_settings(
        &self,
        request_id: Option<&RequestId>,
    ) -> Result<Arc<AccountSettings>, ControlPlaneRefusal> {
        self.settings
            .clone()
            .map_err(|error| ControlPlaneRefusal::refuse_internal_failure(request_id, &*error))
    }
}

/// A failure inside an account route, which its caller reads only as the logged 500.
#[derive(Debug, thiserror::Error)]
enum AccountRouteError {
    /// The account store failed.
    #[error("the account store failed")]
    Store(#[from] AccountStoreError),
    /// A challenge could not be issued.
    #[error("the challenge could not be issued")]
    Challenge(#[from] ChallengeError),
    /// The token pair could not be issued.
    #[error("the token pair could not be issued")]
    TokenIssue(#[from] TokenIssueError),
    /// The passkey verifier gave no verdict.
    #[error("the passkey verifier gave no verdict")]
    Verifier(#[from] VerifierError),
    /// The clock read outside what a timestamp holds.
    #[error("the clock is out of range")]
    Clock(#[from] jiff::Error),
}

/// What an account route's step answers: its value or the caller's refusal, or a failure that
/// becomes the logged 500.
type RouteOutcome<T> = Result<Result<T, ControlPlaneRefusal>, AccountRouteError>;

// The logged 500 for a failure, or what the route answered.
fn settle<T>(
    request_id: Option<&RequestId>,
    outcome: RouteOutcome<T>,
) -> Result<T, ControlPlaneRefusal> {
    outcome.unwrap_or_else(|error| {
        Err(ControlPlaneRefusal::refuse_internal_failure(
            request_id,
            &error as &(dyn Error + 'static),
        ))
    })
}

// The path a method is served at.
fn route_path<M: Method>() -> String {
    format!("/{}", M::DESCRIPTOR.method)
}

/// The path of each account route, in the order [`build_account_router`] serves them: the
/// registration options and verify, the sign-in options and verify, and the passkey revoke.
pub(crate) fn list_account_route_paths() -> [String; 5] {
    [
        route_path::<WebAuthnRegistrationOptionsIssue>(),
        route_path::<WebAuthnRegistrationVerify>(),
        route_path::<WebAuthnAuthenticationOptionsIssue>(),
        route_path::<WebAuthnAuthenticationVerify>(),
        route_path::<WebAuthnCredentialRevoke>(),
    ]
}

/// Builds the account's routes over `routes`, the four ceremony routes counted by `admission` in
/// the sign-in group; the host adds the refusal fallbacks after every route it serves.
pub fn build_account_router<S, V, L, A>(routes: AccountRoutes<S, V, L>, admission: A) -> Router
where
    S: SharedAccountStore,
    V: PasskeyVerifier,
    L: AuthenticatorList,
    A: AdmissionCheck,
{
    let counted = CountedRoute {
        admission,
        endpoint: RateLimitEndpointGroup::AuthEndpoint,
        clock: routes.clock,
    };
    let count = || from_fn_with_state(counted.clone(), rate_limit::<A>);
    let [
        registration_options,
        registration_verify,
        authentication_options,
        authentication_verify,
        credential_revoke,
    ] = list_account_route_paths();
    let router = Router::new()
        .route(
            &registration_options,
            post(registration::issue_registration_options::<S, V, L>).route_layer(count()),
        )
        .route(
            &registration_verify,
            post(registration::verify_registration::<S, V, L>).route_layer(count()),
        )
        .route(
            &authentication_options,
            post(authentication::issue_authentication_options::<S, V, L>).route_layer(count()),
        )
        .route(
            &authentication_verify,
            post(authentication::verify_authentication::<S, V, L>).route_layer(count()),
        )
        .route(
            &credential_revoke,
            post(credential::revoke_passkey::<S, V, L>),
        );
    router.with_state(routes)
}
