//! The signed-in check every signed-in route runs: the access token in `Authorization: DPoP`,
//! the resource-request `DPoP` proof beside it bound to the same key, the token not revoked and the
//! proof's single use spent, all before the route reads anything.

use std::future::Future;

use axum::http::HeaderMap;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use jiff::Timestamp;
use serde::Deserialize;

use crate::account::AccountRoutes;
use crate::account::token::dpop_proof::{
    CheckedProof, ProofForm, check_dpop_proof, record_proof_jti,
};
use crate::account::token::issuer::{AccessClaims, TokenRefusal, verify_access_token};
use crate::account_store::{AccountStore, AccountStoreError, SharedAccountStore, SqlValue};
use crate::server::router::{
    AuthenticationFault, ControlPlaneRefusal, RequestId, SignedInCheck, SignedInUser,
};

impl<S: SharedAccountStore, V, L> SignedInCheck for AccountRoutes<S, V, L> {
    fn check_signed_in(
        &self,
        parts: &Parts,
    ) -> impl Future<Output = Result<SignedInUser, ControlPlaneRefusal>> + Send {
        let request_id = parts.extensions.get::<RequestId>().cloned();
        let checked = self.check_token_and_proof(parts, request_id.as_ref());
        let store = self.store.clone();
        async move {
            let (claims, proof, now) = checked?;
            let jti = claims.jti.clone();
            let fault = store
                .run_step(move |store| {
                    if is_revoked(store, &jti)? {
                        return Ok(Some(AuthenticationFault::TokenInvalid));
                    }
                    if !record_proof_jti(store, &proof, now)? {
                        return Ok(Some(AuthenticationFault::ProofInvalid));
                    }
                    Ok::<_, AccountStoreError>(None)
                })
                .await
                .map_err(|error| {
                    ControlPlaneRefusal::refuse_internal_failure(request_id.as_ref(), &error)
                })?;
            match fault {
                Some(fault) => Err(ControlPlaneRefusal::Unauthenticated(fault)),
                None => Ok(SignedInUser {
                    user_id: claims.user_id,
                }),
            }
        }
    }
}

impl<S, V, L> AccountRoutes<S, V, L> {
    // The checks that read only the request: the token's signature and claims, and the proof
    // under the token's key, with the time they were made at.
    fn check_token_and_proof(
        &self,
        parts: &Parts,
        request_id: Option<&RequestId>,
    ) -> Result<(AccessClaims, CheckedProof, Timestamp), ControlPlaneRefusal> {
        let refuse = |fault| ControlPlaneRefusal::Unauthenticated(fault);
        let settings = self.read_settings(request_id)?;
        let token = read_dpop_token(&parts.headers).ok_or(refuse(AuthenticationFault::NoToken))?;
        let claims =
            verify_access_token(&settings.token_keys, token).map_err(|refusal| match refusal {
                TokenRefusal::Expired => refuse(AuthenticationFault::TokenExpired),
                TokenRefusal::Invalid => refuse(AuthenticationFault::TokenInvalid),
            })?;
        let now = (self.clock)()
            .map_err(|error| ControlPlaneRefusal::refuse_internal_failure(request_id, &error))?;
        let mut target = settings.origin.clone();
        target.set_path(parts.uri.path());
        let form = ProofForm::ResourceRequest {
            access_token: token,
        };
        let proof = check_dpop_proof(&parts.headers, &parts.method, &target, now, form)
            .map_err(|_fault| refuse(AuthenticationFault::ProofInvalid))?;
        if proof.jkt != claims.jkt {
            return Err(refuse(AuthenticationFault::KeyMismatch));
        }
        Ok((claims, proof, now))
    }
}

// The token of the one `Authorization` header whose scheme is `DPoP`, in any letter case.
fn read_dpop_token(headers: &HeaderMap) -> Option<&str> {
    let mut values = headers.get_all(AUTHORIZATION).iter();
    let (Some(value), None) = (values.next(), values.next()) else {
        return None;
    };
    let (scheme, token) = value.to_str().ok()?.split_once(' ')?;
    let token = token.trim();
    (scheme.eq_ignore_ascii_case("DPoP") && !token.is_empty()).then_some(token)
}

fn is_revoked<S: AccountStore>(store: &S, jti: &str) -> Result<bool, AccountStoreError> {
    #[derive(Deserialize)]
    struct Revoked {}

    let revoked: Vec<Revoked> = store.query(
        "SELECT 1 AS revoked FROM revoked_jtis WHERE jti = ?1",
        &[SqlValue::Text(jti.to_owned())],
    )?;
    Ok(!revoked.is_empty())
}
