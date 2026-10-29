//! The session-level item chosen from the run-level items under it.

use std::borrow::Borrow;

use jiff::Timestamp;
use sidekicks_contracts::attention::{AttentionId, AttentionSeverity};

/// The members of a run-level item the session-level choice reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AttentionContributor {
    /// The item's id.
    pub(crate) id: AttentionId,
    /// Whether it blocks on the person.
    pub(crate) severity: AttentionSeverity,
    /// When it was raised.
    pub(crate) created_at: Timestamp,
}

/// The session-level item's representative and severity, `None` when no run item exists. The
/// severity is actionable while any contributor is; the representative, whose trigger, source
/// event and time the session item carries, is the one of highest severity, then earliest
/// `created_at`, then smallest id, a total order so two readers never name different ones.
pub(crate) fn derive_session_aggregate<Contributor: Borrow<AttentionContributor>>(
    contributors: &[Contributor],
) -> Option<(&Contributor, AttentionSeverity)> {
    let is_actionable =
        |item: &AttentionContributor| item.severity == AttentionSeverity::Actionable;
    let representative = contributors.iter().min_by(|left, right| {
        let left: &AttentionContributor = (*left).borrow();
        let right: &AttentionContributor = (*right).borrow();
        is_actionable(right)
            .cmp(&is_actionable(left))
            .then_with(|| left.created_at.cmp(&right.created_at))
            // Ids are daemon-minted ASCII, so their text order is JavaScript's.
            .then_with(|| left.id.cmp(&right.id))
    })?;
    // Actionable sorts first, so the representative is actionable whenever any contributor is.
    let chosen: &AttentionContributor = representative.borrow();
    Some((representative, chosen.severity))
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;
    use rstest::rstest;
    use sidekicks_contracts::attention::AttentionSeverity::{self, Actionable, Informational};
    use sidekicks_contracts::wire::text::FreeFormText;

    use super::{AttentionContributor, derive_session_aggregate};

    #[rstest]
    // An earlier informational item loses to an actionable one.
    #[case(
        &[
            ("a", Informational, "2026-01-01T00:00:00.000Z"),
            ("z", Actionable, "2026-01-01T09:00:00.000Z"),
        ],
        "z",
        Actionable
    )]
    // 01:00 at +02:00 is 23:00 the day before, earlier than the Z stamp its text sorts after.
    #[case(
        &[
            ("a", Informational, "2026-01-01T00:30:00.000Z"),
            ("b", Informational, "2026-01-01T01:00:00.000+02:00"),
        ],
        "b",
        Informational
    )]
    // One instant in two spellings ties, and the smaller id decides.
    #[case(
        &[
            ("b", Actionable, "2026-01-01T00:00:00.000Z"),
            ("a", Actionable, "2026-01-01T02:00:00.000+02:00"),
        ],
        "a",
        Actionable
    )]
    fn the_aggregate_ranks_severity_then_the_earlier_instant_then_the_smaller_id(
        #[case] items: &[(&str, AttentionSeverity, &str)],
        #[case] expected_id: &str,
        #[case] expected_severity: AttentionSeverity,
    ) {
        let contributors: Vec<AttentionContributor> = items
            .iter()
            .map(|&(id, severity, created_at)| AttentionContributor {
                id: FreeFormText::new(id.to_owned()).expect("a test id is an id"),
                severity,
                created_at: created_at
                    .parse::<Timestamp>()
                    .expect("a test stamp is an instant"),
            })
            .collect();

        let (representative, severity) =
            derive_session_aggregate(&contributors).expect("the items aggregate");

        assert_eq!(representative.id.as_str(), expected_id);
        assert_eq!(severity, expected_severity);
    }
}
