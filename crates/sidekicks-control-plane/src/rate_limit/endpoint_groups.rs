//! Each counted group's limit, the one source both hosts and the 429 read.

use jiff::SignedDuration;

use crate::rate_limit::limiter::RateLimitEndpointGroup;

/// How many requests one source address may make in a sliding window of `period`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EndpointGroupLimit {
    /// The requests the window admits.
    pub limit: u32,
    /// The window's length.
    pub period: SignedDuration,
}

/// The limit of `group`: the sign-in routes take 20 requests a minute per address.
pub const fn endpoint_group_limit(group: RateLimitEndpointGroup) -> EndpointGroupLimit {
    match group {
        RateLimitEndpointGroup::AuthEndpoint => EndpointGroupLimit {
            limit: 20,
            period: SignedDuration::from_secs(60),
        },
    }
}
