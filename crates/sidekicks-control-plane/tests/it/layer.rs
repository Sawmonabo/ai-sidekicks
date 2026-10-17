//! The rate-limit middleware on a counted route: the 400 before counting, the 429 with its header
//! and body, and a counter failure that fails only its own request.

use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::Router;
use axum::body::Body;
use axum::http::header::RETRY_AFTER;
use axum::http::{Request, StatusCode};
use axum::middleware::from_fn_with_state;
use axum::routing::post;
use jiff::Timestamp;
use serde_json::json;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_control_plane::rate_limit::enforcement_pipeline::{
    AccountFileAdmission, AdmissionCheck, AdmissionError,
};
use sidekicks_control_plane::rate_limit::layer::{RateLimitGate, rate_limit};
use sidekicks_control_plane::rate_limit::limiter::{
    RateLimitCheckRequest, RateLimitCheckResponse, RateLimitEndpointGroup, RateLimiterError,
    wall_clock,
};
use sidekicks_control_plane::server::router::{RequestId, SourceAddress, with_refusal_fallbacks};

use crate::helpers::{account_file, call};

fn counted_route<A: AdmissionCheck>(admission: A) -> Router {
    let gate = RateLimitGate {
        admission,
        endpoint: RateLimitEndpointGroup::AuthEndpoint,
    };
    with_refusal_fallbacks(
        Router::new().route(
            "/sign-in",
            post(|| async { StatusCode::NO_CONTENT })
                .route_layer(from_fn_with_state(gate, rate_limit::<A>)),
        ),
    )
}

fn sign_in(source_address: Option<&str>) -> Request<Body> {
    let mut request = Request::post("/sign-in")
        .body(Body::empty())
        .expect("the request builds");
    request
        .extensions_mut()
        .insert(RequestId("ray-1".to_owned()));
    if let Some(address) = source_address {
        request
            .extensions_mut()
            .insert(SourceAddress(address.to_owned()));
    }
    request
}

#[tokio::test]
async fn a_request_with_no_countable_address_is_refused_before_counting() {
    let account = account_file();
    let route = counted_route(AccountFileAdmission::new(
        account.connection.clone(),
        wall_clock,
    ));
    for address in [None, Some("127.1")] {
        let (status, _, body) = call(&route, sign_in(address)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["code"], "relay.sourceAddressUnresolvable");
        assert_eq!(body["category"], "invalidArgument");
    }
    assert_eq!(account.counted_requests(), 0);
}

#[tokio::test]
async fn the_request_past_the_limit_is_refused_with_its_wait() {
    let account = account_file();
    let route = counted_route(AccountFileAdmission::new(
        account.connection.clone(),
        wall_clock,
    ));
    for _ in 0..20 {
        let (status, headers, _) = call(&route, sign_in(Some("::ffff:198.51.100.7"))).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert!(
            headers.get(RETRY_AFTER).is_none(),
            "an admitted request has no rate-limit header"
        );
    }

    // The mapped address and its IPv4 form are one address, counted once.
    let (status, headers, body) = call(&route, sign_in(Some("198.51.100.7"))).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["code"], "relay.rateLimited");
    assert_eq!(body["category"], "resourceExhausted");
    assert_eq!(
        (body["limit"].clone(), body["remaining"].clone()),
        (json!(20), json!(0))
    );
    let retry_after = body["retryAfter"].as_u64().unwrap();
    assert!(
        (59..=60).contains(&retry_after),
        "the window frees in about a minute"
    );
    assert_eq!(headers[RETRY_AFTER], retry_after.to_string());
    assert!(
        body["message"]
            .as_str()
            .is_some_and(|message| !message.is_empty())
    );
    assert!(body["resetAt"].is_string());
    assert_eq!(
        account.counted_requests(),
        20,
        "the refusal was not counted"
    );
}

/// An admission check that refuses with a window that freed long ago.
#[derive(Clone)]
struct RefusedLongAgo;

impl AdmissionCheck for RefusedLongAgo {
    fn check_admission(
        &self,
        _request: RateLimitCheckRequest,
        _request_id: Option<RequestId>,
    ) -> impl Future<Output = Result<RateLimitCheckResponse, AdmissionError>> + Send {
        let reset_at =
            WireInstant::from_timestamp(Timestamp::UNIX_EPOCH).expect("the epoch has a wire form");
        async move {
            Ok(RateLimitCheckResponse {
                allowed: false,
                remaining: 0,
                reset_at,
                limit: 20,
            })
        }
    }
}

#[tokio::test]
async fn the_wait_never_falls_below_zero() {
    let (status, headers, body) = call(
        &counted_route(RefusedLongAgo),
        sign_in(Some("198.51.100.7")),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(headers[RETRY_AFTER], "0");
    assert_eq!(body["retryAfter"], 0);
}

/// The account file's admission, whose first count fails.
#[derive(Clone)]
struct FailsOnce {
    admission: AccountFileAdmission,
    has_failed: Arc<AtomicBool>,
}

impl AdmissionCheck for FailsOnce {
    fn check_admission(
        &self,
        request: RateLimitCheckRequest,
        request_id: Option<RequestId>,
    ) -> impl Future<Output = Result<RateLimitCheckResponse, AdmissionError>> + Send {
        let has_failed = self.has_failed.swap(true, Ordering::SeqCst);
        let admission = self.admission.clone();
        async move {
            if !has_failed {
                return Err(AdmissionError::Limiter(RateLimiterError::ResetUnwritable));
            }
            admission.check_admission(request, request_id).await
        }
    }
}

#[tokio::test]
async fn a_counter_failure_fails_only_its_own_request() {
    let account = account_file();
    let route = counted_route(FailsOnce {
        admission: AccountFileAdmission::new(account.connection.clone(), wall_clock),
        has_failed: Arc::default(),
    });

    let (status, _, body) = call(&route, sign_in(Some("198.51.100.7"))).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        body,
        json!({
            "code": "system.internalError",
            "category": "internal",
            "message": "Unexpected internal error",
        })
    );

    let (status, _, _) = call(&route, sign_in(Some("198.51.100.7"))).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        account.counted_requests(),
        1,
        "the next request was counted"
    );
}
