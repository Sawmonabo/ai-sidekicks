//! A signed-in route through the router: the access token passes only with a resource-request
//! proof under the key it is bound to, every refusal carries the `DPoP` challenge, and a revoke
//! touches only the caller's own passkey.

use axum::http::StatusCode;
use axum::http::header::WWW_AUTHENTICATE;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jiff::{SignedDuration, Timestamp};
use serde_json::json;

use crate::helpers::{DpopKey, Relay, call, post, sign_in, start_relay};

const REVOKE_PATH: &str = "/webauthn.credential.revoke";
const USER: &str = "0190a000-0000-7000-8000-000000000001";
const HANDLE: &str = "dXNlci1vbmU";
const PASSKEY: &str = "cGFzc2tleS1vbmU";

// An hour ago, so a pair minted under it is already expired.
fn read_hour_ago_clock() -> Result<Timestamp, jiff::Error> {
    Timestamp::now().checked_sub(SignedDuration::from_hours(1))
}

// A signed-in user and the access token its sign-in under `key` issued.
async fn sign_in_user(relay: &Relay, key: &DpopKey) -> String {
    relay.add_user_with_passkey(USER, HANDLE, PASSKEY, 0);
    let (status, _, signed_in) = sign_in(relay, &relay.router, key, PASSKEY, HANDLE, 1).await;
    assert_eq!(status, StatusCode::OK, "{signed_in}");
    signed_in["accessToken"]
        .as_str()
        .expect("a token")
        .to_owned()
}

// A v4.public token's claims, which it carries in the clear before its 64-byte signature.
fn read_token_claims(token: &str) -> serde_json::Value {
    let signed = URL_SAFE_NO_PAD
        .decode(token.trim_start_matches("v4.public."))
        .expect("the token is base64url");
    serde_json::from_slice(&signed[..signed.len() - 64]).expect("the claims are JSON")
}

async fn revoke(
    relay: &Relay,
    passkey_id: &str,
    authorization: Option<&str>,
    proof: Option<&str>,
) -> (StatusCode, axum::http::HeaderMap, serde_json::Value) {
    let mut headers = Vec::new();
    if let Some(authorization) = authorization {
        headers.push(("Authorization", authorization));
    }
    if let Some(proof) = proof {
        headers.push(("DPoP", proof));
    }
    let body = json!({ "passkeyId": passkey_id });
    call(&relay.router, post(REVOKE_PATH, &body, &headers)).await
}

#[tokio::test]
async fn a_token_passes_only_with_a_proof_under_its_own_key() {
    let relay = start_relay();
    let key = DpopKey::generate();
    let access = sign_in_user(&relay, &key).await;
    let authorization = format!("DPoP {access}");
    let other_key = DpopKey::generate();
    let past_router = relay.with_clock(read_hour_ago_clock);
    let past_key = DpopKey::generate();
    let past_proof = {
        let mut claims =
            crate::helpers::build_proof_claims("/webauthn.authentication.verify", None);
        claims["iat"] = json!(read_hour_ago_clock().unwrap().as_second());
        past_key.sign(&past_key.header(), &claims)
    };
    relay
        .verifier
        .answer(&json!({ "verified": true, "newCounter": 2 }));
    let (_, _, past_issue) = call(
        &past_router,
        post("/webauthn.authenticationOptions.issue", &json!({}), &[]),
    )
    .await;
    let transaction_id = past_issue["transactionId"].as_str().unwrap();
    let past_body = crate::helpers::build_assertion(transaction_id, PASSKEY, Some(HANDLE));
    let (status, _, past_pair) = call(
        &past_router,
        post(
            "/webauthn.authentication.verify",
            &past_body,
            &[("DPoP", &past_proof)],
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{past_pair}");
    let expired = past_pair["accessToken"].as_str().unwrap().to_owned();

    let refusals = [
        (
            "a proof under another key",
            Some(authorization.clone()),
            Some(other_key.prove(REVOKE_PATH, Some(&access))),
            "auth.dpopMismatch",
            r#"DPoP algs="ES256", error="invalid_token""#,
        ),
        (
            "no proof",
            Some(authorization.clone()),
            None,
            "auth.dpopMismatch",
            r#"DPoP algs="ES256", error="invalid_dpop_proof""#,
        ),
        (
            "the bearer scheme",
            Some(format!("Bearer {access}")),
            Some(key.prove(REVOKE_PATH, Some(&access))),
            "auth.token.invalid",
            r#"DPoP algs="ES256""#,
        ),
        (
            "another token's hash",
            Some(authorization.clone()),
            Some(key.prove(REVOKE_PATH, Some(&expired))),
            "auth.dpopMismatch",
            r#"DPoP algs="ES256", error="invalid_dpop_proof""#,
        ),
        (
            "an expired token",
            Some(format!("DPoP {expired}")),
            Some(past_key.prove(REVOKE_PATH, Some(&expired))),
            "auth.token.expired",
            r#"DPoP algs="ES256", error="invalid_token""#,
        ),
        (
            "no token",
            None,
            Some(key.prove(REVOKE_PATH, None)),
            "auth.token.invalid",
            r#"DPoP algs="ES256""#,
        ),
    ];
    for (case, authorization, proof, code, challenge) in refusals {
        let (status, headers, refusal) =
            revoke(&relay, PASSKEY, authorization.as_deref(), proof.as_deref()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{case}");
        assert_eq!(refusal["code"], code, "{case}");
        assert_eq!(headers[WWW_AUTHENTICATE], challenge, "{case}");
    }

    let proof = key.prove(REVOKE_PATH, Some(&access));
    let (status, _, _) = revoke(&relay, "bm9uZQ", Some(&authorization), Some(&proof)).await;
    assert_eq!(status, StatusCode::OK);
    let (status, headers, refusal) =
        revoke(&relay, "bm9uZQ", Some(&authorization), Some(&proof)).await;
    assert_eq!(
        (
            status,
            refusal["code"].clone(),
            headers[WWW_AUTHENTICATE].to_str().unwrap()
        ),
        (
            StatusCode::UNAUTHORIZED,
            json!("auth.dpopMismatch"),
            r#"DPoP algs="ES256", error="invalid_dpop_proof""#
        ),
        "a replayed proof"
    );

    let jti = read_token_claims(&access)["jti"]
        .as_str()
        .unwrap()
        .to_owned();
    relay.execute(&format!(
        "INSERT INTO revoked_jtis (jti, user_id, family_id, reason, expires_at) VALUES \
         ('{jti}', '{USER}', 'family', 'signOut', 4102444800)"
    ));
    let proof = key.prove(REVOKE_PATH, Some(&access));
    let (status, headers, refusal) =
        revoke(&relay, "bm9uZQ", Some(&authorization), Some(&proof)).await;
    assert_eq!(
        (
            status,
            refusal["code"].clone(),
            headers[WWW_AUTHENTICATE].to_str().unwrap()
        ),
        (
            StatusCode::UNAUTHORIZED,
            json!("auth.token.invalid"),
            r#"DPoP algs="ES256", error="invalid_token""#
        ),
        "a revoked token"
    );
}

#[tokio::test]
async fn a_revoke_removes_only_the_callers_own_passkey() {
    let relay = start_relay();
    let key = DpopKey::generate();
    let access = sign_in_user(&relay, &key).await;
    let authorization = format!("DPoP {access}");
    relay.add_user_with_passkey(
        "0190a000-0000-7000-8000-000000000002",
        "dXNlci10d28",
        "cGFzc2tleS10d28",
        0,
    );
    let passkeys = || {
        relay
            .query("SELECT credential_id FROM webauthn_credentials ORDER BY credential_id")
            .len()
    };

    let mut answers = Vec::new();
    for passkey_id in ["cGFzc2tleS10d28", "bm9uZQ"] {
        let proof = key.prove(REVOKE_PATH, Some(&access));
        let (status, _, body) =
            revoke(&relay, passkey_id, Some(&authorization), Some(&proof)).await;
        answers.push((status, body));
    }
    assert_eq!(
        answers[0], answers[1],
        "another account's passkey answers as an absent one"
    );
    assert_eq!(answers[0], (StatusCode::OK, json!({})));
    assert_eq!(passkeys(), 2);

    let proof = key.prove(REVOKE_PATH, Some(&access));
    let (status, _, _) = revoke(&relay, PASSKEY, Some(&authorization), Some(&proof)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(passkeys(), 1, "the account's last passkey may go");

    let (status, _, refusal) = sign_in(&relay, &relay.router, &key, PASSKEY, HANDLE, 5).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(refusal["code"], "account.passkey.verificationFailed");
}
