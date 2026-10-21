//! A passkey sign-in through the router: the challenge spent once under a race, every failed
//! check of the passkey answered alike with nothing advanced, and the token-request `DPoP` proof
//! refused before the challenge is read.

use axum::http::StatusCode;
use axum::http::header::WWW_AUTHENTICATE;
use jiff::Timestamp;
use rstest::rstest;
use serde_json::{Value, json};

use crate::helpers::{
    DpopKey, ORIGIN, build_assertion, build_proof_claims, call, issue_sign_in_challenge, post,
    sign_in, start_relay,
};

const VERIFY_PATH: &str = "/webauthn.authentication.verify";
const USER: &str = "0190a000-0000-7000-8000-000000000001";
const OTHER_USER: &str = "0190a000-0000-7000-8000-000000000002";
const HANDLE: &str = "dXNlci1vbmU";
const OTHER_HANDLE: &str = "dXNlci10d28";
const PASSKEY: &str = "cGFzc2tleS1vbmU";
const OTHER_PASSKEY: &str = "cGFzc2tleS10d28";

fn count(relay: &crate::helpers::Relay, statement: &str) -> i64 {
    relay.query(statement)[0]["n"].as_i64().expect("a count")
}

#[tokio::test]
async fn two_verifies_of_one_challenge_issue_one_pair() {
    let relay = start_relay();
    relay.add_user_with_passkey(USER, HANDLE, PASSKEY, 0);
    relay
        .verifier
        .answer(&json!({ "verified": true, "newCounter": 0 }));
    relay.verifier.gate(2);
    let (transaction_id, _) = issue_sign_in_challenge(&relay.router).await;
    let body = build_assertion(&transaction_id, PASSKEY, Some(HANDLE));
    let key = DpopKey::generate();
    let (first, second) = (key.prove(VERIFY_PATH, None), key.prove(VERIFY_PATH, None));

    // Both read the challenge and wait in the verifier together; then each commits in turn.
    let (first, second) = tokio::join!(
        call(&relay.router, post(VERIFY_PATH, &body, &[("DPoP", &first)])),
        call(
            &relay.router,
            post(VERIFY_PATH, &body, &[("DPoP", &second)])
        ),
    );
    let mut answers = [first, second];
    answers.sort_by_key(|(status, _, _)| status.as_u16());
    assert_eq!(answers[0].0, StatusCode::OK, "{}", answers[0].2);
    assert_eq!(answers[1].0, StatusCode::BAD_REQUEST);
    assert_eq!(answers[1].2["code"], "account.passkey.challengeInvalid");
    assert_eq!(
        count(&relay, "SELECT COUNT(*) AS n FROM refresh_token_families"),
        1
    );
}

#[rstest]
#[case::unknown_passkey("cGFzc2tleS1ub25l", Some(HANDLE), json!({"verified": true, "newCounter": 11}))]
#[case::revoked_passkey("cmV2b2tlZA", Some(HANDLE), json!({"verified": true, "newCounter": 11}))]
#[case::foreign_user_handle(PASSKEY, Some(OTHER_HANDLE), json!({"verified": true, "newCounter": 11}))]
#[case::no_user_handle(PASSKEY, None, json!({"verified": true, "newCounter": 11}))]
#[case::refused_verdict_with_a_higher_counter(
    PASSKEY,
    Some(HANDLE),
    json!({"verified": false, "newCounter": 99})
)]
#[case::regressed_counter(PASSKEY, Some(HANDLE), json!({"verified": true, "newCounter": 9}))]
#[tokio::test]
async fn every_failed_passkey_check_answers_alike_and_advances_nothing(
    #[case] credential_id: &str,
    #[case] user_handle: Option<&str>,
    #[case] verdict: serde_json::Value,
) {
    let relay = start_relay();
    relay.add_user_with_passkey(USER, HANDLE, PASSKEY, 10);
    relay.add_user_with_passkey(OTHER_USER, OTHER_HANDLE, OTHER_PASSKEY, 0);
    relay.add_user_with_passkey(
        "0190a000-0000-7000-8000-000000000003",
        "dXNlci10aHJlZQ",
        "cmV2b2tlZA",
        0,
    );
    relay.execute("DELETE FROM webauthn_credentials WHERE credential_id = 'cmV2b2tlZA'");
    relay.verifier.answer(&verdict);
    let (transaction_id, _) = issue_sign_in_challenge(&relay.router).await;
    let body = build_assertion(&transaction_id, credential_id, user_handle);
    let proof = DpopKey::generate().prove(VERIFY_PATH, None);

    let (status, headers, refusal) =
        call(&relay.router, post(VERIFY_PATH, &body, &[("DPoP", &proof)])).await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(headers.get(WWW_AUTHENTICATE).is_none());
    assert_eq!(
        refusal,
        json!({
            "code": "account.passkey.verificationFailed",
            "category": "invalidArgument",
            "message": "The passkey could not be verified.",
        })
    );
    assert_eq!(
        relay.query(
            "SELECT signature_counter, last_used_at FROM webauthn_credentials \
             WHERE credential_id = 'cGFzc2tleS1vbmU'"
        ),
        vec![json!({ "signature_counter": 10, "last_used_at": null })]
    );
    assert_eq!(
        count(&relay, "SELECT COUNT(*) AS n FROM refresh_token_families"),
        0
    );
    assert_eq!(
        count(&relay, "SELECT COUNT(*) AS n FROM webauthn_challenges"),
        0,
        "a failed verification still spends its challenge"
    );
}

/// How a proof is spoiled: its claims, then its header, each changed before signing.
type Spoil = fn(&mut Value, &mut Value);

#[rstest]
#[case::ath_present(|claims: &mut Value, _: &mut Value| claims["ath"] = json!("aGFzaA"))]
#[case::iat_61_seconds_old(|claims: &mut Value, _: &mut Value| claims["iat"] = json!(Timestamp::now().as_second() - 61))]
#[case::iat_61_seconds_ahead(|claims: &mut Value, _: &mut Value| claims["iat"] = json!(Timestamp::now().as_second() + 61))]
#[case::iat_at_the_least_integer(|claims: &mut Value, _: &mut Value| claims["iat"] = json!(i64::MIN))]
#[case::other_method(|claims: &mut Value, _: &mut Value| claims["htm"] = json!("GET"))]
#[case::other_target(|claims: &mut Value, _: &mut Value| claims["htu"] = json!(format!("https://other.example{VERIFY_PATH}")))]
#[case::private_key_member(|_: &mut Value, header: &mut Value| header["jwk"]["d"] = json!("c2VjcmV0"))]
#[case::other_type(|_: &mut Value, header: &mut Value| header["typ"] = json!("jwt"))]
#[case::critical_extension(|_: &mut Value, header: &mut Value| header["crit"] = json!(["exp"]))]
#[tokio::test]
async fn a_spoiled_proof_is_refused_before_the_challenge_is_read(#[case] spoil: Spoil) {
    let relay = start_relay();
    relay.add_user_with_passkey(USER, HANDLE, PASSKEY, 0);
    let key = DpopKey::generate();
    let mut claims = build_proof_claims(VERIFY_PATH, None);
    let mut header = key.header();
    spoil(&mut claims, &mut header);
    let proof = key.sign(&header, &claims);
    assert_proof_refused(&relay, &proof).await;
}

#[tokio::test]
async fn a_bad_signature_or_a_replayed_jti_is_refused_and_a_query_still_matches() {
    let relay = start_relay();
    relay.add_user_with_passkey(USER, HANDLE, PASSKEY, 0);
    let key = DpopKey::generate();

    // A character in the middle of the signature holds six whole bits, so the changed signature
    // still decodes and only its verify refuses it.
    let proof = key.prove(VERIFY_PATH, None);
    let signature_start = proof.rfind('.').expect("a proof has a signature") + 1;
    let middle = signature_start + (proof.len() - signature_start) / 2;
    let flipped = if &proof[middle..=middle] == "A" {
        "B"
    } else {
        "A"
    };
    let proof = format!("{}{flipped}{}", &proof[..middle], &proof[middle + 1..]);
    assert_proof_refused(&relay, &proof).await;

    // A target that differs only by its query is the same request's.
    relay
        .verifier
        .answer(&json!({ "verified": true, "newCounter": 1 }));
    let (transaction_id, _) = issue_sign_in_challenge(&relay.router).await;
    let mut claims = build_proof_claims(VERIFY_PATH, None);
    claims["htu"] = json!(format!("{ORIGIN}{VERIFY_PATH}?from=sheet"));
    let used = key.sign(&key.header(), &claims);
    let body = build_assertion(&transaction_id, PASSKEY, Some(HANDLE));
    let (status, _, signed_in) =
        call(&relay.router, post(VERIFY_PATH, &body, &[("DPoP", &used)])).await;
    assert_eq!(status, StatusCode::OK, "{signed_in}");

    assert_proof_refused(&relay, &used).await;
}

// Sends `proof` with a sign-in under a fresh challenge and checks the refusal names the proof,
// the challenge is left for an honest retry, and nothing is issued.
async fn assert_proof_refused(relay: &crate::helpers::Relay, proof: &str) {
    relay
        .verifier
        .answer(&json!({ "verified": true, "newCounter": 50 }));
    let families = count(relay, "SELECT COUNT(*) AS n FROM refresh_token_families");
    let (transaction_id, _) = issue_sign_in_challenge(&relay.router).await;
    let body = build_assertion(&transaction_id, PASSKEY, Some(HANDLE));

    let (status, headers, refusal) =
        call(&relay.router, post(VERIFY_PATH, &body, &[("DPoP", proof)])).await;

    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(refusal["code"], "auth.dpopMismatch");
    assert_eq!(
        headers[WWW_AUTHENTICATE],
        r#"DPoP algs="ES256", error="invalid_dpop_proof""#
    );
    assert_eq!(
        count(
            relay,
            &format!(
                "SELECT COUNT(*) AS n FROM webauthn_challenges WHERE transaction_id = \
                 '{transaction_id}'"
            )
        ),
        1,
        "the challenge is left for a retry"
    );
    assert_eq!(
        count(relay, "SELECT COUNT(*) AS n FROM refresh_token_families"),
        families
    );
}

#[tokio::test]
async fn a_sign_in_is_checked_against_the_relying_party_and_the_stored_key() {
    let relay = start_relay();
    relay.add_user_with_passkey(USER, HANDLE, PASSKEY, 0);
    let key = DpopKey::generate();
    let (status, _, signed_in) = sign_in(&relay, &relay.router, &key, PASSKEY, HANDLE, 0).await;
    assert_eq!(status, StatusCode::OK, "{signed_in}");
    assert_eq!(signed_in["userId"], USER);
    let checks = relay.verifier.checks();
    let check = checks.last().expect("the verifier was called");
    assert_eq!(check["expectedOrigin"], json!([ORIGIN]));
    assert_eq!(check["expectedRPID"], "relay.example");
    assert_eq!(check["requireUserVerification"], true);
    assert_eq!(check["credential"]["publicKey"], "pQECAw");
}
