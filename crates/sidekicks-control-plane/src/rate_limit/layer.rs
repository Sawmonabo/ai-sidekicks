//! The middleware a counted route runs first: it counts the request per source address and refuses
//! one over its endpoint group's limit with a 429, `Retry-After` and the rate-limit body. An
//! admitted request reaches its route with no rate-limit header added.

use std::net::{IpAddr, Ipv6Addr};
use std::str::FromStr;

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use jiff::Timestamp;
use sidekicks_contracts::rate_limiter::{
    RateLimitResponse, RelayRateLimitedCategory, RelayRateLimitedCode,
};
use sidekicks_contracts::wire::integer::SafeInt;

use crate::rate_limit::enforcement_pipeline::AdmissionCheck;
use crate::rate_limit::limiter::{
    RateLimitCheckRequest, RateLimitCheckResponse, RateLimitEndpointGroup, wall_clock,
};
use crate::server::router::{ControlPlaneRefusal, RequestId, SourceAddress};

/// What `rate_limit` counts with: the admission check and the endpoint group of the route it wraps.
#[derive(Clone)]
pub struct RateLimitGate<A> {
    /// The host's admission check.
    pub admission: A,
    /// The group the wrapped route counts in.
    pub endpoint: RateLimitEndpointGroup,
}

/// Counts each request of the route it wraps, as `axum::middleware::from_fn_with_state(gate,
/// rate_limit)` on that route: a request with no address it can count is refused 400 before
/// anything is counted, one over the limit 429, and a counter failure fails that one request 500.
pub async fn rate_limit<A: AdmissionCheck>(
    State(gate): State<RateLimitGate<A>>,
    request: Request,
    next: Next,
) -> Response {
    let request_id = request.extensions().get::<RequestId>().cloned();
    let Some(identity) = request
        .extensions()
        .get::<SourceAddress>()
        .and_then(|address| canonical_identity(&address.0))
    else {
        return ControlPlaneRefusal::source_address_unresolvable().into_response();
    };
    let counted = gate
        .admission
        .check_admission(
            RateLimitCheckRequest {
                identity,
                endpoint: gate.endpoint,
            },
            request_id.clone(),
        )
        .await;
    let check = match counted {
        Ok(check) => check,
        Err(error) => {
            return ControlPlaneRefusal::internal(request_id.as_ref(), &error).into_response();
        }
    };
    if !check.allowed {
        let refusal = match wall_clock() {
            Ok(now) => ControlPlaneRefusal::RateLimited(rate_limit_response(check, now)),
            Err(error) => ControlPlaneRefusal::internal(request_id.as_ref(), &error),
        };
        return refusal.into_response();
    }
    next.run(request).await
}

/// The caller's source address as the counter keys it: an IPv4 address as itself, an IPv4-mapped
/// IPv6 address as its IPv4 address, and any other IPv6 address by its /64, so a host cannot step
/// around its count across the addresses one network hands it; `None` when it is no address.
pub fn canonical_identity(source_address: &str) -> Option<String> {
    match IpAddr::from_str(source_address).ok()?.to_canonical() {
        IpAddr::V4(address) => Some(address.to_string()),
        IpAddr::V6(address) => {
            let network = Ipv6Addr::from_bits(address.to_bits() & !u128::from(u64::MAX));
            Some(format!("{network}/64"))
        }
    }
}

// The one place `retryAfter` is computed, whole seconds up to the window's reset, never below 0:
// the body carries it and the refusal sets the header from it.
fn rate_limit_response(check: RateLimitCheckResponse, now: Timestamp) -> RateLimitResponse {
    let reset_at = check
        .reset_at
        .unix_millisecond()
        .unwrap_or_else(|| now.as_millisecond());
    let wait = u64::try_from(reset_at - now.as_millisecond()).unwrap_or(0);
    let safe =
        |value: u64| SafeInt::new(value).expect("a window's count or wait is a safe integer");
    RateLimitResponse {
        code: RelayRateLimitedCode::Value,
        category: RelayRateLimitedCategory::Value,
        message: format!(
            "Too many requests from this address; retry in {} seconds.",
            wait.div_ceil(1000)
        ),
        retry_after: safe(wait.div_ceil(1000)),
        limit: safe(u64::from(check.limit)),
        remaining: safe(u64::from(check.remaining)),
        reset_at: check.reset_at,
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::canonical_identity;

    #[rstest]
    #[case::ipv4("198.51.100.7", Some("198.51.100.7"))]
    #[case::ipv4_mapped("::ffff:1.2.3.4", Some("1.2.3.4"))]
    #[case::ipv6_network("2001:db8:1:2:aaaa::1", Some("2001:db8:1:2::/64"))]
    #[case::ipv6_same_network("2001:db8:1:2:bbbb:cccc:dddd:eeee", Some("2001:db8:1:2::/64"))]
    #[case::ipv4_shorthand("127.1", None)]
    #[case::ipv4_leading_zero("01.2.3.4", None)]
    #[case::not_an_address("relay.example", None)]
    fn an_address_counts_by_its_canonical_form(
        #[case] source_address: &str,
        #[case] expected: Option<&str>,
    ) {
        assert_eq!(canonical_identity(source_address).as_deref(), expected);
    }
}
