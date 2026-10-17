//! The sliding-window counter both hosts run over the account store. Every request counted is one
//! row kept until it leaves its window, and a check reads and writes with nothing awaited between,
//! so two requests never both take the window's last place.

use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use sidekicks_contracts::wire::instant::WireInstant;

use crate::account_store::{AccountStore, AccountStoreError, SqlValue};
use crate::rate_limit::endpoint_groups::endpoint_group_limit;

/// The key of each counted group of routes; the sign-in routes are the only group.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RateLimitEndpointGroup {
    /// Sign-in, token refresh and device linking.
    #[serde(rename = "auth.endpoint")]
    AuthEndpoint,
}

impl RateLimitEndpointGroup {
    /// The group's key as the account store keeps it.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AuthEndpoint => "auth.endpoint",
        }
    }
}

/// One request to count: who sent it and which group of routes it reached.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RateLimitCheckRequest {
    /// The caller's source address in canonical form: an IPv4 address, or an IPv6 /64 prefix.
    pub identity: String,
    /// The group of routes the request reached.
    pub endpoint: RateLimitEndpointGroup,
}

/// The window's state after one check: whether the request was counted, the places left, the
/// instant the oldest counted request leaves the window, and the window's limit.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RateLimitCheckResponse {
    /// Whether the request was counted and may run.
    pub allowed: bool,
    /// The requests the window still admits.
    pub remaining: u32,
    /// When the oldest counted request leaves the window, which frees the next place.
    pub reset_at: WireInstant,
    /// The requests the window admits.
    pub limit: u32,
}

/// A check or a cleanup the counter could not finish, its cause kept.
#[derive(Debug, thiserror::Error)]
pub enum RateLimiterError {
    /// The account store refused a statement.
    #[error("the account store failed the rate limit's statement")]
    Store(#[from] AccountStoreError),
    /// An instant fell outside what a timestamp holds.
    #[error("an instant of the rate limit's window is out of range")]
    Instant(#[from] jiff::Error),
    /// The window's reset instant is before the year 0000, which the wire cannot write.
    #[error("the rate limit's reset instant has no wire form")]
    ResetUnwritable,
}

/// Reads the wall clock through `time`, which reads `Date.now()` on the Worker, where std's
/// clock panics; fails only when the clock reads outside what a timestamp holds.
pub fn wall_clock() -> Result<Timestamp, jiff::Error> {
    let now = time::OffsetDateTime::now_utc();
    Timestamp::new(now.unix_timestamp(), now.nanosecond().cast_signed())
}

/// Counts `request` against its group's window at `now`: a request over the limit is refused and
/// not recorded, so a caller that keeps knocking never pushes its own window later.
pub fn check<S: AccountStore>(
    store: &S,
    request: &RateLimitCheckRequest,
    now: Timestamp,
) -> Result<RateLimitCheckResponse, RateLimiterError> {
    #[derive(Deserialize)]
    struct Window {
        counted: i64,
        oldest_expiry: Option<i64>,
    }

    let group = endpoint_group_limit(request.endpoint);
    let expires_at = now.checked_add(group.period)?.as_millisecond();
    let key = [
        SqlValue::Text(request.endpoint.as_str().to_owned()),
        SqlValue::Text(request.identity.clone()),
    ];

    drop_expired(store, now)?;
    let window = store
        .query::<Window>(
            "SELECT COUNT(*) AS counted, MIN(expires_at_ms) AS oldest_expiry \
             FROM counted_requests WHERE endpoint_group = ?1 AND identity = ?2",
            &key,
        )?
        .pop()
        .unwrap_or(Window {
            counted: 0,
            oldest_expiry: None,
        });
    // An empty window starts with this request, so it is the oldest one.
    let reset_at = wire_instant(window.oldest_expiry.unwrap_or(expires_at))?;
    let counted = u32::try_from(window.counted).unwrap_or(u32::MAX);
    if counted >= group.limit {
        return Ok(RateLimitCheckResponse {
            allowed: false,
            remaining: 0,
            reset_at,
            limit: group.limit,
        });
    }

    let [endpoint_group, identity] = key;
    store.execute(
        "INSERT INTO counted_requests (endpoint_group, identity, expires_at_ms) VALUES (?1, ?2, ?3)",
        &[endpoint_group, identity, SqlValue::Integer(expires_at)],
    )?;
    Ok(RateLimitCheckResponse {
        allowed: true,
        remaining: group.limit - counted - 1,
        reset_at,
        limit: group.limit,
    })
}

/// Drops every counted request that has left its window at `now`, and answers when the next
/// address's window empties, the moment the next cleanup is due; `None` once nothing is left.
pub fn prune<S: AccountStore>(
    store: &S,
    now: Timestamp,
) -> Result<Option<Timestamp>, RateLimiterError> {
    drop_expired(store, now)?;
    next_cleanup_at(store)
}

/// When the first address's whole window empties, one window after its newest counted request;
/// `None` when nothing is counted.
pub fn next_cleanup_at<S: AccountStore>(store: &S) -> Result<Option<Timestamp>, RateLimiterError> {
    #[derive(Deserialize)]
    struct Next {
        next: Option<i64>,
    }

    let next = store
        .query::<Next>(
            "SELECT MIN(last_expiry) AS next FROM (SELECT MAX(expires_at_ms) AS last_expiry \
             FROM counted_requests GROUP BY endpoint_group, identity)",
            &[],
        )?
        .pop()
        .and_then(|row| row.next);
    Ok(next.map(Timestamp::from_millisecond).transpose()?)
}

fn drop_expired<S: AccountStore>(store: &S, now: Timestamp) -> Result<(), RateLimiterError> {
    store.execute(
        "DELETE FROM counted_requests WHERE expires_at_ms <= ?1",
        &[SqlValue::Integer(now.as_millisecond())],
    )?;
    Ok(())
}

fn wire_instant(millisecond: i64) -> Result<WireInstant, RateLimiterError> {
    WireInstant::from_timestamp(Timestamp::from_millisecond(millisecond)?)
        .ok_or(RateLimiterError::ResetUnwritable)
}
