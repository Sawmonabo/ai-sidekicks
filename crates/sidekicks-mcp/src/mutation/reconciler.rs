//! The settle of a mutation whose provider leg may or may not have landed: what the provider's
//! config is observed to hold, compared against the receipt's digests or a switch's wanted state.

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the mutation service writes, checks and settles the receipts"
    )
)]

use crate::mutation::receipts::McpReceiptDigest;

/// How a pending mutation settles against what the provider's config holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum McpIntentSettlement {
    /// The config holds what the mutation wrote.
    Landed,
    /// The config holds what it held before the mutation.
    Unlanded,
    /// The config holds neither: another writer changed the entry.
    ChangedByAnother,
    /// The binding a switch was meant for is gone.
    BindingGone,
    /// The config could not be read, so nothing is known yet.
    Unsettled,
}

/// What the provider's config is observed to hold for a binding's declaration.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum McpDeclarationObservation {
    /// The config declares no such binding.
    Absent,
    /// The config declares the binding; the digest of its entry under the receipt's key.
    Present(McpReceiptDigest),
    /// The config could not be read.
    Unread,
}

/// What the provider's config is observed to hold for a binding's switch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum McpSwitchObservation {
    /// The config declares no such binding.
    Absent,
    /// The binding's switch as the config holds it.
    Switch(bool),
    /// The config could not be read.
    Unread,
}

/// How a declaration's write settles, given its `before` digest (`None` for an add), its `after`
/// digest (`None` for a remove) and what is `observed`. The after digest is compared first, since
/// a write that changes nothing has one digest for both.
pub(crate) fn settle_declaration(
    before: Option<&McpReceiptDigest>,
    after: Option<&McpReceiptDigest>,
    observed: &McpDeclarationObservation,
) -> McpIntentSettlement {
    match observed {
        McpDeclarationObservation::Absent => match (before, after) {
            (_, None) => McpIntentSettlement::Landed,
            (None, Some(_)) => McpIntentSettlement::Unlanded,
            (Some(_), Some(_)) => McpIntentSettlement::ChangedByAnother,
        },
        McpDeclarationObservation::Present(digest) => {
            if after == Some(digest) {
                McpIntentSettlement::Landed
            } else if before == Some(digest) {
                McpIntentSettlement::Unlanded
            } else {
                McpIntentSettlement::ChangedByAnother
            }
        }
        McpDeclarationObservation::Unread => McpIntentSettlement::Unsettled,
    }
}

/// How a switch to `wanted` settles against what is `observed`.
pub(crate) fn settle_switch(wanted: bool, observed: McpSwitchObservation) -> McpIntentSettlement {
    match observed {
        McpSwitchObservation::Switch(switch) if switch == wanted => McpIntentSettlement::Landed,
        McpSwitchObservation::Switch(_) => McpIntentSettlement::Unlanded,
        McpSwitchObservation::Absent => McpIntentSettlement::BindingGone,
        McpSwitchObservation::Unread => McpIntentSettlement::Unsettled,
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::json;

    use super::{
        McpDeclarationObservation, McpIntentSettlement, McpSwitchObservation, settle_declaration,
        settle_switch,
    };
    use crate::mutation::receipts::McpReceiptDigest;
    use crate::mutation::receipts::tests::{entry, idempotency_key, project_binding, receipt_key};

    /// What a test observes: nothing, one of its named entries, or an unread config.
    #[derive(Clone, Copy)]
    enum Seen {
        Absent,
        Entry(&'static str),
        Unread,
    }

    /// The test's named entries: `changed` has `old`'s members with one value changed.
    fn declaration(name: &str) -> serde_json::Value {
        match name {
            "old" => json!({ "command": "npx", "args": ["docs-server@1"] }),
            "changed" => json!({ "command": "npx", "args": ["docs-server@2"] }),
            "new" => json!({ "url": "https://docs.example.com/mcp" }),
            _ => json!({ "command": "another-writers-server" }),
        }
    }

    /// Each declaration's settle, its digests taken over real entries under one receipt key and
    /// idempotency key. Killed by an absent remove read as unlanded, by a digest blind to values
    /// (the value-only update reads landed), by the before digest compared first (the no-op
    /// update reads unlanded), by another's entry read as landed, and by an unread config read
    /// as unlanded or refused.
    #[rstest]
    #[case::remove_found_absent(Some("old"), None, Seen::Absent, McpIntentSettlement::Landed)]
    #[case::add_found_absent(None, Some("new"), Seen::Absent, McpIntentSettlement::Unlanded)]
    #[case::update_found_absent(
        Some("old"),
        Some("new"),
        Seen::Absent,
        McpIntentSettlement::ChangedByAnother
    )]
    #[case::value_only_update_found_before(
        Some("old"),
        Some("changed"),
        Seen::Entry("old"),
        McpIntentSettlement::Unlanded
    )]
    #[case::no_op_update_found(
        Some("old"),
        Some("old"),
        Seen::Entry("old"),
        McpIntentSettlement::Landed
    )]
    #[case::update_found_another(
        Some("old"),
        Some("new"),
        Seen::Entry("other"),
        McpIntentSettlement::ChangedByAnother
    )]
    #[case::remove_found_another(
        Some("old"),
        None,
        Seen::Entry("other"),
        McpIntentSettlement::ChangedByAnother
    )]
    #[case::remove_unread(Some("old"), None, Seen::Unread, McpIntentSettlement::Unsettled)]
    #[case::add_unread(None, Some("new"), Seen::Unread, McpIntentSettlement::Unsettled)]
    #[case::update_unread(Some("old"), Some("new"), Seen::Unread, McpIntentSettlement::Unsettled)]
    fn a_declaration_settles_by_what_is_observed(
        #[case] before: Option<&str>,
        #[case] after: Option<&str>,
        #[case] seen: Seen,
        #[case] settlement: McpIntentSettlement,
    ) {
        let key = receipt_key(1);
        let idempotency_key = idempotency_key();
        let binding = project_binding();
        let digest = |name: &str| -> McpReceiptDigest {
            key.digest_declaration(&idempotency_key, &binding, &entry(declaration(name)))
                .expect("the entry digests")
        };
        let observed = match seen {
            Seen::Absent => McpDeclarationObservation::Absent,
            Seen::Entry(name) => McpDeclarationObservation::Present(digest(name)),
            Seen::Unread => McpDeclarationObservation::Unread,
        };

        let settled = settle_declaration(
            before.map(digest).as_ref(),
            after.map(digest).as_ref(),
            &observed,
        );

        assert_eq!(settled, settlement);
    }

    /// A switch lands when the config holds the wanted state, is unlanded when it holds the
    /// other, finds its binding gone when the config declares none, and stays unsettled unread.
    #[rstest]
    #[case::wanted_on(true, McpSwitchObservation::Switch(true), McpIntentSettlement::Landed)]
    #[case::wanted_off(
        false,
        McpSwitchObservation::Switch(false),
        McpIntentSettlement::Landed
    )]
    #[case::still_off(
        true,
        McpSwitchObservation::Switch(false),
        McpIntentSettlement::Unlanded
    )]
    #[case::gone(true, McpSwitchObservation::Absent, McpIntentSettlement::BindingGone)]
    #[case::unread(false, McpSwitchObservation::Unread, McpIntentSettlement::Unsettled)]
    fn a_switch_settles_by_what_is_observed(
        #[case] wanted: bool,
        #[case] observed: McpSwitchObservation,
        #[case] settlement: McpIntentSettlement,
    ) {
        assert_eq!(settle_switch(wanted, observed), settlement);
    }
}
