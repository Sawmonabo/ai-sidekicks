//! The relay's sign-in-route limit as a device reads it: the body of a 429 refusal, and the code a
//! sign-in route refuses with when the relay cannot tell which address a request came from.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::jsonrpc::refusal::RefusalCode;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::literal;

ts_constants! {
    /// The code every 429 refusal of a sign-in route carries.
    RELAY_RATE_LIMITED_CODE = RefusalCode::RelayRateLimited;
    /// The code of the 400 a sign-in route answers when the request carries no source address the
    /// relay can count, so it is refused rather than counted in a bucket other callers share.
    RELAY_SOURCE_ADDRESS_UNRESOLVABLE_CODE = RefusalCode::RelaySourceAddressUnresolvable;
}

literal! {
    /// The code of a sign-in route's 429.
    pub enum RelayRateLimitedCode = const RefusalCode::RelayRateLimited.as_str();
}

literal! {
    /// The category of a sign-in route's 429, the one `relay.rateLimited` carries.
    pub enum RelayRateLimitedCategory =
        const RefusalCode::RelayRateLimited.known_category().as_str();
}

/// The body of a 429 from a sign-in route. `retryAfter` is whole seconds until a retry is allowed,
/// the same value as the `Retry-After` header; `resetAt` is the instant the oldest counted request
/// leaves the window, when the next request is admitted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct RateLimitResponse {
    /// Always `relay.rateLimited`.
    pub code: RelayRateLimitedCode,
    /// Always `resourceExhausted`.
    pub category: RelayRateLimitedCategory,
    /// A sentence for a person.
    pub message: String,
    /// Whole seconds until a retry is allowed.
    pub retry_after: SafeInt<0>,
    /// The requests the window admits.
    pub limit: SafeInt<0>,
    /// The requests the window still admits.
    pub remaining: SafeInt<0>,
    /// When the oldest counted request leaves the window.
    #[garde(dive)]
    pub reset_at: WireInstant,
}

/// The TypeScript module of the sign-in-route limit.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "rate-limiter",
    doc: "The relay's sign-in-route limit as a device reads it: the body of a 429 refusal, and the \
          code a sign-in route refuses with when the relay cannot tell which address a request \
          came from.",
    definitions: &[Definition::read::<RateLimitResponse>().checked()],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
