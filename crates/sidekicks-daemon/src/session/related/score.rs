//! How related two linked sessions are: personalized PageRank from one session, cut at two steps.
//! A link's weight is its kind's, grown with its use count and halved for every 30 days since its
//! last use; a pair's links add up, each walk step goes to a neighbor in proportion to the pair's
//! weight, and a two-step walk counts half of a direct one. Only linked sessions are scored, since
//! each related entry names its link, so a two-step walk counts only where it ends on one.

use std::collections::BTreeMap;
use std::time::Duration;

use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::links::SessionLinkKind;

/// How long a link goes unused before its weight halves.
const HALVING_PERIOD: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// What a walk that took a second step keeps of the first step's share.
const SECOND_STEP_FACTOR: f64 = 0.5;

/// Each link kind's weight before its use count and age are applied.
pub(crate) const fn session_link_kind_weight(kind: SessionLinkKind) -> f64 {
    match kind {
        SessionLinkKind::CopiedFrom => 1.0,
        SessionLinkKind::Started | SessionLinkKind::Related => 0.9,
        SessionLinkKind::Messaged => 0.5,
        SessionLinkKind::Asked => 0.4,
        SessionLinkKind::Mentioned => 0.3,
    }
}

/// One link as either of its two sessions sees it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SessionLinkEnd {
    /// The session at the link's other end.
    pub(crate) other_session_id: SessionId,
    /// The link's kind.
    pub(crate) kind: SessionLinkKind,
    /// Whether the seeing session is the link's source.
    pub(crate) is_source: bool,
    /// How many times the link was used, at least 1.
    pub(crate) use_count: u32,
    /// When the link was last used, read from its stored text.
    pub(crate) last_at: jiff::Timestamp,
}

/// A link's weight at `now`: its kind's weight times `1 + log2(use_count)`, halved every 30 days
/// since its last use. A last use in the future counts as now.
pub(crate) fn session_link_weight(link: &SessionLinkEnd, now: jiff::Timestamp) -> f64 {
    let age = now.duration_since(link.last_at).as_secs_f64().max(0.0);
    let halving = 0.5_f64.powf(age / HALVING_PERIOD.as_secs_f64());
    session_link_kind_weight(link.kind) * (1.0 + f64::from(link.use_count).log2()) * halving
}

/// Each neighbor's share of `session_id`'s walk: the pair's weight over the session's total.
fn step_shares(
    links: &[SessionLinkEnd],
    session_id: &SessionId,
    now: jiff::Timestamp,
) -> BTreeMap<SessionId, f64> {
    let mut shares = BTreeMap::new();
    let mut total = 0.0;
    for link in links
        .iter()
        .filter(|link| link.other_session_id != *session_id)
    {
        let weight = session_link_weight(link, now);
        *shares.entry(link.other_session_id.clone()).or_insert(0.0) += weight;
        total += weight;
    }
    if total > 0.0 {
        for share in shares.values_mut() {
            *share /= total;
        }
    }
    shares
}

/// Scores every session linked to `session_id`: its share of the walk's first step, plus half of
/// what each two-step walk through another linked session brings it. `links_of` answers a
/// session's links as that session sees them.
pub(crate) fn score_related_sessions<'links>(
    session_id: &SessionId,
    links_of: impl Fn(&SessionId) -> &'links [SessionLinkEnd],
    now: jiff::Timestamp,
) -> BTreeMap<SessionId, f64> {
    let first_shares = step_shares(links_of(session_id), session_id, now);
    let mut scores = first_shares.clone();
    for (neighbor_id, first_share) in &first_shares {
        for (second_id, second_share) in step_shares(links_of(neighbor_id), neighbor_id, now) {
            // The session itself is never in `scores`, so a walk back to it adds nothing.
            if let Some(score) = scores.get_mut(&second_id) {
                *score += SECOND_STEP_FACTOR * first_share * second_share;
            }
        }
    }
    scores
}
