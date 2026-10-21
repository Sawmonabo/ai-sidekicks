//! The router's own refusals on a real route, as a caller reads them: a path no route serves, a
//! method a route does not serve, a body that breaks the envelope, is over the size limit or fails
//! the call's contract, and a store failure or a missing setting answered with the fixed internal
//! message.

use axum::body::Body;
use axum::http::header::{ALLOW, CONTENT_TYPE};
use axum::http::{Method, Request, StatusCode};
use rstest::rstest;
use serde_json::json;
use sidekicks_control_plane::server::router::{RequestId, SourceAddress};

use crate::helpers::{call, post, start_relay, start_relay_without};

const ISSUE_PATH: &str = "/webauthn.authenticationOptions.issue";

#[rstest]
#[case::unknown_path(
    Method::POST,
    "/nowhere",
    Some("application/json"),
    "{}".to_owned(),
    StatusCode::NOT_FOUND,
    "request.methodNotFound",
    "unimplemented"
)]
#[case::wrong_method(
    Method::GET,
    ISSUE_PATH,
    None,
    String::new(),
    StatusCode::METHOD_NOT_ALLOWED,
    "request.methodNotAllowed",
    "invalidArgument"
)]
#[case::unparsable_body(
    Method::POST,
    ISSUE_PATH,
    Some("application/json"),
    "{".to_owned(),
    StatusCode::BAD_REQUEST,
    "request.envelopeInvalid",
    "invalidArgument"
)]
#[case::no_json_content_type(
    Method::POST,
    ISSUE_PATH,
    Some("text/plain"),
    "{}".to_owned(),
    StatusCode::BAD_REQUEST,
    "request.envelopeInvalid",
    "invalidArgument"
)]
#[case::wrong_shape(
    Method::POST,
    ISSUE_PATH,
    Some("application/json; charset=utf-8"),
    r#"{"statementHash":3}"#.to_owned(),
    StatusCode::UNPROCESSABLE_ENTITY,
    "request.paramsInvalid",
    "invalidArgument"
)]
#[case::an_array_for_an_object(
    Method::POST,
    ISSUE_PATH,
    Some("application/json"),
    "[]".to_owned(),
    StatusCode::UNPROCESSABLE_ENTITY,
    "request.paramsInvalid",
    "invalidArgument"
)]
#[case::over_the_size_limit(
    Method::POST,
    ISSUE_PATH,
    Some("application/json"),
    format!(r#"{{"statementHash":"{}"}}"#, "a".repeat(3 << 20)),
    StatusCode::PAYLOAD_TOO_LARGE,
    "request.envelopeInvalid",
    "invalidArgument"
)]
#[tokio::test]
async fn the_router_refuses_with_its_own_codes(
    #[case] method: Method,
    #[case] path: &str,
    #[case] content_type: Option<&str>,
    #[case] body: String,
    #[case] status: StatusCode,
    #[case] code: &str,
    #[case] category: &str,
) {
    let relay = start_relay();
    let issue_path = if body.starts_with('[') {
        json!([])
    } else {
        json!(["statementHash"])
    };
    let mut request = Request::builder().method(method).uri(path);
    if let Some(content_type) = content_type {
        request = request.header(CONTENT_TYPE, content_type);
    }
    let mut request = request.body(Body::from(body)).unwrap();
    request
        .extensions_mut()
        .insert(SourceAddress("198.51.100.7".to_owned()));
    let (answered, headers, refusal) = call(&relay.router, request).await;
    assert_eq!(
        (
            answered,
            refusal["code"].as_str(),
            refusal["category"].as_str()
        ),
        (status, Some(code), Some(category))
    );
    assert!(
        refusal["message"]
            .as_str()
            .is_some_and(|message| !message.is_empty())
    );
    if status == StatusCode::METHOD_NOT_ALLOWED {
        assert_eq!(headers[ALLOW], "POST");
    }
    if status == StatusCode::UNPROCESSABLE_ENTITY {
        // The issue names where the body breaks, never the value it holds.
        assert_eq!(refusal["issues"][0]["path"], issue_path, "{refusal}");
    }
    if status == StatusCode::PAYLOAD_TOO_LARGE {
        assert_eq!(refusal["reason"], "tooLarge");
    }
}

#[rstest]
#[case::store_failure(None)]
#[case::missing_setting(Some("RELYING_PARTY_ORIGINS"))]
#[tokio::test]
async fn an_internal_failure_answers_only_the_fixed_message(#[case] missing: Option<&'static str>) {
    let relay = if let Some(setting) = missing {
        start_relay_without(setting)
    } else {
        let relay = start_relay();
        relay.execute("DROP TABLE webauthn_challenges");
        relay
    };
    let mut request = post(ISSUE_PATH, &json!({}), &[]);
    request
        .extensions_mut()
        .insert(RequestId("ray-500".to_owned()));
    let (status, _, refusal) = call(&relay.router, request).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        refusal,
        json!({
            "code": "system.internalError",
            "category": "internal",
            "message": "Unexpected internal error",
        })
    );
}
