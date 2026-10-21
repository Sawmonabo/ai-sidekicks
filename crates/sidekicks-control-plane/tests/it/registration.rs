//! Adding a passkey through the router: an attestation that names another credential or a key
//! the machines refuse spends its challenge and writes nothing, a credential id already held
//! keeps its first holder, and the provider's name comes from the authenticator list.

use axum::http::StatusCode;
use serde_json::json;

use crate::helpers::{DpopKey, Relay, call, post, sign_in, start_relay};

const ISSUE_PATH: &str = "/webauthn.registrationOptions.issue";
const VERIFY_PATH: &str = "/webauthn.registration.verify";
const USER: &str = "0190a000-0000-7000-8000-000000000001";
const HANDLE: &str = "dXNlci1vbmU";
const PASSKEY: &str = "cGFzc2tleS1vbmU";
const OTHER_USER: &str = "0190a000-0000-7000-8000-000000000002";
const OTHER_PASSKEY: &str = "cGFzc2tleS10d28";
const NEW_PASSKEY: &str = "bmV3LXBhc3NrZXk";
const LISTED_AAGUID: &str = "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4";
const NAMELESS_AAGUID: &str = "00000000-0000-0000-0000-000000000000";
const LIST: &str = r#"{"ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": {"name": "Google Password Manager",
    "icon_dark": "data:image/svg+xml;base64,AA"}}"#;

/// A signed-in caller: the key its token is bound to and the token.
struct Caller {
    key: DpopKey,
    access: String,
}

async fn sign_in_caller(relay: &Relay) -> Caller {
    relay.add_user_with_passkey(USER, HANDLE, PASSKEY, 0);
    relay.add_user_with_passkey(OTHER_USER, "dXNlci10d28", OTHER_PASSKEY, 0);
    let key = DpopKey::generate();
    let (status, _, signed_in) = sign_in(relay, &relay.router, &key, PASSKEY, HANDLE, 1).await;
    assert_eq!(status, StatusCode::OK, "{signed_in}");
    let access = signed_in["accessToken"]
        .as_str()
        .expect("a token")
        .to_owned();
    Caller { key, access }
}

// Issues registration options and verifies `credential_id` under them, the verifier answering
// `verdict`; answers the issued options and the verify's reply.
async fn register(
    relay: &Relay,
    caller: &Caller,
    credential_id: &str,
    verdict: serde_json::Value,
) -> (serde_json::Value, StatusCode, serde_json::Value) {
    let authorization = format!("DPoP {}", caller.access);
    let proof = caller.key.prove(ISSUE_PATH, Some(&caller.access));
    let headers = [
        ("Authorization", authorization.as_str()),
        ("DPoP", proof.as_str()),
    ];
    let (status, _, issued) = call(&relay.router, post(ISSUE_PATH, &json!({}), &headers)).await;
    assert_eq!(status, StatusCode::OK, "{issued}");
    relay.verifier.answer(&verdict);
    let body = json!({
        "transactionId": issued["transactionId"],
        "response": {
            "id": credential_id,
            "rawId": credential_id,
            "type": "public-key",
            "clientExtensionResults": {},
            "response": {
                "clientDataJSON": "AA",
                "attestationObject": "AA",
                "transports": ["internal", "hybrid"],
            },
        },
    });
    let proof = caller.key.prove(VERIFY_PATH, Some(&caller.access));
    let headers = [
        ("Authorization", authorization.as_str()),
        ("DPoP", proof.as_str()),
    ];
    let (status, _, verified) = call(&relay.router, post(VERIFY_PATH, &body, &headers)).await;
    (issued, status, verified)
}

fn verified(credential_id: &str, aaguid: &str) -> serde_json::Value {
    json!({
        "verified": true,
        "credentialId": credential_id,
        "publicKey": { "coseAlgorithm": -7, "coseKey": "pQECAyYgAQ" },
        "aaguid": aaguid,
        "counter": 0,
    })
}

fn count_challenges(relay: &Relay) -> usize {
    relay
        .query("SELECT challenge FROM webauthn_challenges")
        .len()
}

#[tokio::test]
async fn a_refused_attestation_writes_nothing_and_spends_its_challenge() {
    let relay = start_relay();
    let caller = sign_in_caller(&relay).await;
    let refused = [
        ("another credential", verified("b3RoZXI", LISTED_AAGUID)),
        ("a refused key", json!({ "verified": false })),
        ("an id already held", verified(OTHER_PASSKEY, LISTED_AAGUID)),
    ];
    for (case, verdict) in refused {
        let credential_id = if case == "an id already held" {
            OTHER_PASSKEY
        } else {
            NEW_PASSKEY
        };
        let (_, status, refusal) = register(&relay, &caller, credential_id, verdict).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{case}");
        assert_eq!(
            refusal["code"], "account.passkey.verificationFailed",
            "{case}"
        );
        assert_eq!(
            count_challenges(&relay),
            0,
            "{case}: the challenge is spent"
        );
    }
    assert_eq!(
        relay.query("SELECT credential_id, user_id FROM webauthn_credentials ORDER BY user_id"),
        vec![
            json!({ "credential_id": PASSKEY, "user_id": USER }),
            json!({ "credential_id": OTHER_PASSKEY, "user_id": OTHER_USER }),
        ],
        "nothing written, and the id's first holder kept"
    );
}

#[tokio::test]
async fn a_new_passkey_is_named_from_the_authenticator_list() {
    let relay = start_relay();
    let caller = sign_in_caller(&relay).await;
    relay.authenticator_list.hold(LIST);

    let (issued, status, added) = register(
        &relay,
        &caller,
        NEW_PASSKEY,
        verified(NEW_PASSKEY, LISTED_AAGUID),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{added}");
    assert_eq!(
        issued["options"]["excludeCredentials"],
        json!([{ "type": "public-key", "id": PASSKEY, "transports": [] }])
    );
    assert_eq!(issued["options"]["user"]["id"], HANDLE);
    assert_eq!(
        added,
        json!({
            "passkeyId": NEW_PASSKEY,
            "publicKey": { "coseAlgorithm": -7, "coseKey": "pQECAyYgAQ" },
            "aaguid": LISTED_AAGUID,
            "providerName": "Google Password Manager",
        })
    );
    assert_eq!(
        relay.query(&format!(
            "SELECT user_id, transports FROM webauthn_credentials WHERE credential_id = \
             '{NEW_PASSKEY}'"
        )),
        vec![json!({ "user_id": USER, "transports": "[\"internal\",\"hybrid\"]" })]
    );

    let (_, status, nameless) = register(
        &relay,
        &caller,
        "bmFtZWxlc3M",
        verified("bmFtZWxlc3M", NAMELESS_AAGUID),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{nameless}");
    assert!(
        nameless.get("providerName").is_none(),
        "the all-zero AAGUID names none"
    );

    relay.authenticator_list.hold("{}");
    let (_, status, retired) = register(
        &relay,
        &caller,
        "cmV0aXJlZA",
        verified("cmV0aXJlZA", LISTED_AAGUID),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{retired}");
    assert!(
        retired.get("providerName").is_none(),
        "a retired list names none"
    );
}
