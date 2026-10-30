//! Against an axum double on a loopback port: nothing past the address's scheme and host reaches
//! the service log or the outcome, user info reaches the receiver as a `Basic` header, and every
//! attempt verifies the Standard Webhooks way.

use std::io::Write;
use std::sync::{Arc, Mutex};

use axum::http::StatusCode;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use jiff::{SignedDuration, Timestamp};
use rstest::rstest;
use secrecy::{ExposeSecret as _, SecretString};
use sidekicks_contracts::attention::AttentionDeliveryResult;
use sidekicks_contracts::web_address::WebAddress;
use sidekicks_contracts::wire::integer::BoundedInt;
use standardwebhooks::Webhook;

use super::{PostOutcome, WebAddressPost, WebAddressPoster};
use crate::attention::delivery::web_address::receiver_double::{closed_port, serve};
use crate::attention::delivery::web_address::shown_host;
use crate::attention::delivery::web_address::signature::mint_signing_secret;

const MESSAGE_ID: &str = "018f0000-0000-7000-8000-0000000000e1";
const BODY: &[u8] = br#"{"text":"Nightly bump \u00b7 Finished","kind":"finished"}"#;

/// The service log, captured at TRACE from every target, `log` records included.
#[derive(Clone, Default)]
struct CapturedLog(Arc<Mutex<Vec<u8>>>);

impl Write for CapturedLog {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .expect("the captured log")
            .extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl CapturedLog {
    /// Installs the capture as the process's subscriber and `log` logger; nextest runs each test in
    /// a process of its own.
    fn install() -> Self {
        let log = Self::default();
        let writer = log.clone();
        tracing_subscriber::fmt()
            .with_max_level(tracing::Level::TRACE)
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .try_init()
            .expect("the test installs the one subscriber");
        log
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().expect("the captured log")).into_owned()
    }
}

fn address(text: &str) -> WebAddress {
    WebAddress::new(text).expect("a test web address")
}

/// Mutations: an error kept or logged with its address (`without_url` dropped), the answer's body
/// logged, connection tracing turned on, the path in the shown host, user info left in the address
/// or dropped instead of moved into the header.
#[rstest]
#[case::refused_over_http("http", "u:p", Some(b"u:p".as_slice()), AttentionDeliveryResult::Refused)]
#[case::a_failed_handshake("https", "u:p", None, AttentionDeliveryResult::Unreachable)]
#[case::a_user_not_in_utf8("http", "%FF:p", Some(b"\xff:p".as_slice()), AttentionDeliveryResult::Refused)]
#[case::a_password_not_in_utf8("http", "u:%FF", Some(b"u:\xff".as_slice()), AttentionDeliveryResult::Refused)]
#[case::only_a_password_not_in_utf8("http", ":%FF", Some(b":\xff".as_slice()), AttentionDeliveryResult::Refused)]
#[tokio::test]
async fn nothing_past_the_scheme_and_host_leaves_and_user_info_moves_to_the_header(
    #[case] scheme: &str,
    #[case] user_info: &str,
    #[case] credentials: Option<&[u8]>,
    #[case] result: AttentionDeliveryResult,
) {
    let log = CapturedLog::install();
    let (port, received) = serve(StatusCode::INTERNAL_SERVER_ERROR).await;
    let saved = address(&format!(
        "{scheme}://{user_info}@127.0.0.1:{port}/hook/SECRETPATH?token=SECRETQUERY"
    ));
    let secret = mint_signing_secret().expect("the system's random source");
    let poster = WebAddressPoster::default();

    let outcome = poster
        .post(WebAddressPost {
            address: &saved,
            signing_secret: &secret,
            message_id: MESSAGE_ID,
            body: BODY,
            attempted_at: Timestamp::now(),
        })
        .await
        .expect("the attempt is made");
    let closed = address(&format!(
        "http://u:p@127.0.0.1:{}/hook/SECRETPATH?token=SECRETQUERY",
        closed_port().await
    ));
    let unanswered = poster
        .post(WebAddressPost {
            address: &closed,
            signing_secret: &secret,
            message_id: MESSAGE_ID,
            body: BODY,
            attempted_at: Timestamp::now(),
        })
        .await
        .expect("the attempt is made");

    let status = (result == AttentionDeliveryResult::Refused)
        .then(|| BoundedInt::new(500).expect("a status"));
    assert_eq!(
        outcome,
        PostOutcome {
            result,
            http_status: status
        }
    );
    assert_eq!(unanswered.result, AttentionDeliveryResult::Unreachable);
    assert_eq!(shown_host(&saved).as_str(), format!("{scheme}://127.0.0.1"));
    let requests = received.lock().expect("the double's record").clone();
    match credentials {
        Some(credentials) => {
            let [request] = requests.as_slice() else {
                panic!("one request reached the double: {requests:?}");
            };
            assert_eq!(request.path_and_query, "/hook/SECRETPATH?token=SECRETQUERY");
            let header = request.headers["authorization"]
                .to_str()
                .expect("an ASCII header");
            let sent = STANDARD
                .decode(header.strip_prefix("Basic ").expect("a Basic header"))
                .expect("base64");
            assert_eq!(sent, credentials);
        }
        None => assert!(requests.is_empty(), "no TLS handshake completed"),
    }

    let key = secret
        .expose_secret()
        .strip_prefix("whsec_")
        .expect("a signing secret")
        .to_owned();
    let seen = format!("{}\n{outcome:?}\n{unanswered:?}", log.text());
    assert!(
        seen.contains("the web address"),
        "the attempts are logged: {seen}"
    );
    for secret_part in [
        "SECRETPATH",
        "SECRETQUERY",
        "u:p",
        "%FF",
        "dTpw",
        "Nightly bump",
        key.as_str(),
    ] {
        assert!(!seen.contains(secret_part), "{secret_part} leaked: {seen}");
    }
}

/// The secret a fixed key makes, whose base64 holds both characters the two alphabets differ in.
fn fixed_secret() -> SecretString {
    let key: Vec<u8> = [0xfb, 0xff, 0xbf].into_iter().cycle().take(32).collect();
    SecretString::from(format!("whsec_{}", STANDARD.encode(key)))
}

/// Mutations: the body signed alone, the secret read or the signature written in another
/// alphabet, the first attempt's timestamp reused, the id or the body changed between attempts.
#[rstest]
#[case::a_minted_secret(mint_signing_secret().expect("the system's random source"))]
#[case::a_secret_in_both_alphabets(fixed_secret())]
#[tokio::test]
async fn every_attempt_verifies_with_one_id_one_body_and_its_own_timestamp(
    #[case] secret: SecretString,
) {
    let (port, received) = serve(StatusCode::NO_CONTENT).await;
    let saved = address(&format!("http://127.0.0.1:{port}/hook"));
    let poster = WebAddressPoster::default();
    let now = Timestamp::now();
    for attempted_at in [now - SignedDuration::from_secs(2), now] {
        let outcome = poster
            .post(WebAddressPost {
                address: &saved,
                signing_secret: &secret,
                message_id: MESSAGE_ID,
                body: BODY,
                attempted_at,
            })
            .await
            .expect("the attempt is made");
        assert_eq!(
            outcome,
            PostOutcome {
                result: AttentionDeliveryResult::Delivered,
                http_status: Some(BoundedInt::new(204).expect("a status")),
            }
        );
    }

    let requests = received.lock().expect("the double's record").clone();
    let [first, second] = requests.as_slice() else {
        panic!("two attempts reached the double: {requests:?}");
    };
    let verifier = Webhook::new(secret.expose_secret()).expect("the secret reads");
    for request in [first, second] {
        verifier
            .verify(&request.body, &request.headers)
            .expect("the attempt verifies");
        assert_eq!(request.headers["content-type"], "application/json");
        assert_eq!(request.headers["user-agent"], "AI-Sidekicks");
        assert_eq!(request.headers["webhook-id"], MESSAGE_ID);
        assert_eq!(request.body.as_ref(), BODY);
    }
    assert_eq!(
        first.headers["webhook-timestamp"]
            .to_str()
            .expect("ASCII")
            .parse::<i64>()
            .expect("Unix seconds"),
        now.as_second() - 2
    );
    assert_ne!(
        first.headers["webhook-timestamp"],
        second.headers["webhook-timestamp"]
    );

    let mut changed_body = second.body.to_vec();
    changed_body[0] = b' ';
    assert!(verifier.verify(&changed_body, &second.headers).is_err());
    let mut changed_id = second.headers.clone();
    changed_id.insert(
        "webhook-id",
        "018f0000-0000-7000-8000-0000000000e2"
            .parse()
            .expect("a header value"),
    );
    assert!(verifier.verify(&second.body, &changed_id).is_err());
}
