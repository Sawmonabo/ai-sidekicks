//! The router's own refusals, as a caller reads them: a path no route serves, a method a route
//! does not serve, and a body that breaks the envelope or fails the call's contract.

use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::rejection::JsonRejection;
use axum::http::header::{ALLOW, CONTENT_TYPE};
use axum::http::{Method, Request, StatusCode};
use axum::routing::post;
use rstest::rstest;
use serde::Deserialize;
use sidekicks_control_plane::server::router::{ControlPlaneRefusal, with_refusal_fallbacks};

use crate::helpers::call;

#[derive(Deserialize)]
struct Greeting {
    #[expect(
        dead_code,
        reason = "the route only reads that the body has this shape"
    )]
    name: String,
}

async fn greet(
    body: Result<Json<Greeting>, JsonRejection>,
) -> Result<StatusCode, ControlPlaneRefusal> {
    let Json(_greeting) = body?;
    Ok(StatusCode::NO_CONTENT)
}

#[rstest]
#[case::unknown_path(
    Method::GET,
    "/nowhere",
    None,
    "",
    StatusCode::NOT_FOUND,
    "request.methodNotFound",
    "unimplemented"
)]
#[case::wrong_method(
    Method::GET,
    "/greet",
    None,
    "",
    StatusCode::METHOD_NOT_ALLOWED,
    "request.methodNotAllowed",
    "invalidArgument"
)]
#[case::unparsable_body(
    Method::POST,
    "/greet",
    Some("application/json"),
    "{",
    StatusCode::BAD_REQUEST,
    "request.envelopeInvalid",
    "invalidArgument"
)]
#[case::no_json_content_type(
    Method::POST,
    "/greet",
    None,
    r#"{"name":"Sam"}"#,
    StatusCode::BAD_REQUEST,
    "request.envelopeInvalid",
    "invalidArgument"
)]
#[case::wrong_shape(
    Method::POST,
    "/greet",
    Some("application/json"),
    r#"{"name":3}"#,
    StatusCode::UNPROCESSABLE_ENTITY,
    "request.paramsInvalid",
    "invalidArgument"
)]
#[tokio::test]
async fn the_router_refuses_with_its_own_codes(
    #[case] method: Method,
    #[case] path: &str,
    #[case] content_type: Option<&str>,
    #[case] body: &'static str,
    #[case] status: StatusCode,
    #[case] code: &str,
    #[case] category: &str,
) {
    let router = with_refusal_fallbacks(Router::new().route("/greet", post(greet)));
    let mut request = Request::builder().method(method).uri(path);
    if let Some(content_type) = content_type {
        request = request.header(CONTENT_TYPE, content_type);
    }
    let (answered, headers, refusal) = call(&router, request.body(Body::from(body)).unwrap()).await;
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
}
