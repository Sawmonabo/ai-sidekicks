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
    Clock, RateLimitCheckRequest, RateLimitCheckResponse, RateLimitEndpointGroup,
};
use crate::server::router::{ControlPlaneRefusal, RequestId, SourceAddress};

/// What `rate_limit` counts a route with: the host's admission check, the endpoint group of the
/// route it wraps, and the clock the 429's wait is read from.
#[derive(Clone)]
pub struct CountedRoute<A> {
    /// The host's admission check.
    pub admission: A,
    /// The group the wrapped route counts in.
    pub endpoint: RateLimitEndpointGroup,
    /// Reads the time the 429's wait counts from: `read_wall_clock` on a host.
    pub clock: Clock,
}

/// A refusal's wait that has no wire form: a reset instant the store sent unreadable, or a figure
/// past what the wire's integers hold.
#[derive(Debug, thiserror::Error)]
#[error("the rate limit's refusal has no wire form")]
struct RefusalUnwritable;

/// Counts each request of the route it wraps, as `axum::middleware::from_fn_with_state(route,
/// rate_limit)` on that route: a request with no address it can count is refused 400 before
/// anything is counted, one over the limit 429, and a counter failure fails that one request 500.
pub async fn rate_limit<A: AdmissionCheck>(
    State(route): State<CountedRoute<A>>,
    request: Request,
    next: Next,
) -> Response {
    let request_id = request.extensions().get::<RequestId>().cloned();
    let Some(identity) = request
        .extensions()
        .get::<SourceAddress>()
        .and_then(|address| canonicalize_identity(&address.0))
    else {
        return ControlPlaneRefusal::refuse_unresolvable_source_address().into_response();
    };
    let counted = route
        .admission
        .check_admission(
            RateLimitCheckRequest {
                identity,
                endpoint: route.endpoint,
            },
            request_id.clone(),
        )
        .await;
    let check = match counted {
        Ok(check) => check,
        Err(error) => {
            return ControlPlaneRefusal::refuse_internal_failure(request_id.as_ref(), &error)
                .into_response();
        }
    };
    if !check.allowed {
        let refusal = match (route.clock)() {
            Ok(now) => match build_rate_limit_response(check, now) {
                Ok(body) => ControlPlaneRefusal::RateLimited(body),
                Err(error) => {
                    ControlPlaneRefusal::refuse_internal_failure(request_id.as_ref(), &error)
                }
            },
            Err(error) => ControlPlaneRefusal::refuse_internal_failure(request_id.as_ref(), &error),
        };
        return refusal.into_response();
    }
    next.run(request).await
}

/// The caller's source address as the counter keys it: an IPv4 address as itself, an IPv4-mapped
/// IPv6 address as its IPv4 address, and any other IPv6 address by its /64, so a host cannot step
/// around its count across the addresses one network hands it; `None` when it is no address.
pub(crate) fn canonicalize_identity(source_address: &str) -> Option<String> {
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
fn build_rate_limit_response(
    check: RateLimitCheckResponse,
    now: Timestamp,
) -> Result<RateLimitResponse, RefusalUnwritable> {
    let reset_at = check.reset_at.unix_millisecond().ok_or(RefusalUnwritable)?;
    let retry_after = u64::try_from(reset_at - now.as_millisecond())
        .unwrap_or(0)
        .div_ceil(1000);
    let safe = |value: u64| SafeInt::new(value).ok_or(RefusalUnwritable);
    Ok(RateLimitResponse {
        code: RelayRateLimitedCode::Value,
        category: RelayRateLimitedCategory::Value,
        message: format!("Too many requests from this address; retry in {retry_after} seconds."),
        retry_after: safe(retry_after)?,
        limit: safe(u64::from(check.limit))?,
        remaining: safe(u64::from(check.remaining))?,
        reset_at: check.reset_at,
    })
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::canonicalize_identity;

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
        assert_eq!(canonicalize_identity(source_address).as_deref(), expected);
    }
}
