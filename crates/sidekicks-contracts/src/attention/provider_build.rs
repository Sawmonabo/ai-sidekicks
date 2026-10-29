//! A provider's new build as an attention entry: the build its command moved to, or a newer build
//! the provider was kept from taking. It belongs to no session, never counts, and no notification
//! carries it.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::attention::{AttentionId, InformationalSeverity};
use crate::provider::id::ProviderId;
use crate::provider::settings::ProviderVersion;
use crate::web_address::HttpsAddress;
use crate::wire::instant::WireInstant;
use crate::wire::literal;
use crate::wire::text::NonEmptyText;

literal! {
    /// The trigger of a provider's new build.
    pub enum ProviderBuildTrigger = "providerBuild";
    /// The banner state of an entry no notification carries.
    pub enum WithheldBannerState = "withheld";
}

fn release_notes_go_with_a_move(has_from_version: bool, has_address: bool) -> garde::Result {
    if has_from_version == has_address {
        Ok(())
    } else {
        Err(garde::Error::new(
            "releaseNotesAddress and fromVersion are present together",
        ))
    }
}

/// A provider's new build: the build its command moved from and to, with the address of the
/// provider's own release notes for the new build, or a build only available, with neither.
/// Versions are as the command printed them, never ordered.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[schemars(extend("dependentRequired" = {
    "fromVersion": ["releaseNotesAddress"],
    "releaseNotesAddress": ["fromVersion"],
}))]
pub struct AttentionProviderBuild {
    /// The provider.
    pub provider: ProviderId,
    /// The build the command moved from; absent on a build only available.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProviderVersion")]
    pub from_version: Option<ProviderVersion>,
    /// The new build.
    pub to_version: ProviderVersion,
    /// The provider's official release notes for the new build; present exactly with
    /// `fromVersion`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "HttpsAddress<{ usize::MAX }>")]
    #[garde(custom(|address: &Option<HttpsAddress<{ usize::MAX }>>, (): &()| {
        release_notes_go_with_a_move(self.from_version.is_some(), address.is_some())
    }))]
    pub release_notes_address: Option<HttpsAddress<{ usize::MAX }>>,
}

/// A provider's new build in the notifications list: listed once under `Earlier`, never counted,
/// and never sent anywhere. It carries no session, run, source event, resolution, web-address
/// state or seen fact, so a member naming one is refused.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[schemars(inline)]
pub struct AttentionProviderBuildItem {
    /// The entry, the same as its moment id.
    pub id: AttentionId,
    /// `providerBuild:` and 32 hex digits of the BLAKE3 hash of the provider and the build.
    pub moment_id: AttentionId,
    /// Always `providerBuild`.
    pub trigger: ProviderBuildTrigger,
    /// Always `informational`.
    pub severity: InformationalSeverity,
    /// The provider's name.
    pub display_name: NonEmptyText,
    /// What follows the name: `updated · <from> → <to>`, or `<to> available`.
    pub state_word: NonEmptyText,
    /// The build.
    #[garde(dive)]
    pub provider_build: AttentionProviderBuild,
    /// When the build was recorded.
    #[garde(dive)]
    pub created_at: WireInstant,
    /// Always `withheld`: no banner is raised for it.
    pub banner_state: WithheldBannerState,
}

#[cfg(test)]
mod tests {
    use garde::Validate as _;
    use rstest::rstest;
    use serde_json::{Value, json};

    use crate::attention::AttentionItem;
    use crate::schema::closed_schema_for;

    const SESSION: &str = "0190d2b4-7c3a-7e21-9a4b-5f6c7d8e9f01";
    const ADDRESS: &str = "https://code.claude.com/docs/en/changelog#2-1-294";

    /// A provider's build entry with `build` as its build and `extra` merged over it.
    fn build_item(build: &Value, extra: &Value) -> Value {
        let mut item = json!({
            "id": "providerBuild:0123456789abcdef0123456789abcdef",
            "momentId": "providerBuild:0123456789abcdef0123456789abcdef",
            "trigger": "providerBuild",
            "severity": "informational",
            "displayName": "Claude Code",
            "stateWord": "updated · 2.1.293 → 2.1.294",
            "providerBuild": build,
            "createdAt": "2026-10-28T12:00:00.000Z",
            "bannerState": "withheld",
        });
        if let (Some(item), Some(extra)) = (item.as_object_mut(), extra.as_object()) {
            item.extend(extra.clone());
        }
        item
    }

    fn installed() -> Value {
        json!({
            "provider": "claude",
            "fromVersion": "2.1.293",
            "toVersion": "2.1.294",
            "releaseNotesAddress": ADDRESS,
        })
    }

    /// Which arm the daemon's checks take `item` as, `None` when they refuse it.
    fn rust_arm(item: &Value) -> Option<&'static str> {
        let parsed: AttentionItem = serde_json::from_value(item.clone()).ok()?;
        parsed.validate().ok()?;
        Some(match parsed {
            AttentionItem::Moment(_) => "moment",
            AttentionItem::Notify(_) => "notify",
            AttentionItem::ProviderBuild(_) => "providerBuild",
        })
    }

    // The garde check and the closed schema both hold the build entry closed, so the daemon and a
    // client refuse the same entry. Killed by dropping the garde check, the `dependentRequired` or
    // the new arm's `deny_unknown_fields`.
    #[rstest]
    #[case::installed(build_item(&installed(), &json!({})), Some("providerBuild"))]
    #[case::available(
        build_item(
            &json!({ "provider": "codex", "toVersion": "0.163.0" }),
            &json!({ "stateWord": "0.163.0 available" }),
        ),
        Some("providerBuild")
    )]
    #[case::from_version_without_address(
        build_item(
            &json!({ "provider": "claude", "fromVersion": "2.1.293", "toVersion": "2.1.294" }),
            &json!({}),
        ),
        None
    )]
    #[case::address_without_from_version(
        build_item(
            &json!({ "provider": "claude", "toVersion": "2.1.294", "releaseNotesAddress": ADDRESS }),
            &json!({}),
        ),
        None
    )]
    #[case::with_a_session(build_item(&installed(), &json!({ "sessionId": SESSION })), None)]
    #[case::with_a_seen_fact(build_item(&installed(), &json!({ "seen": false })), None)]
    #[case::pending_banner(build_item(&installed(), &json!({ "bannerState": "pending" })), None)]
    #[case::a_sessions_moment(
        json!({
            "id": "event-1",
            "momentId": format!("session:{SESSION}"),
            "sessionId": SESSION,
            "trigger": "runCompleted",
            "severity": "informational",
            "displayName": "Release notes",
            "stateWord": "Finished",
            "sourceEventId": "event-1",
            "createdAt": "2026-10-28T12:00:00.000Z",
            "seen": false,
        }),
        Some("moment")
    )]
    fn a_provider_build_entry_is_closed_and_never_a_sessions(
        #[case] item: Value,
        #[case] arm: Option<&str>,
    ) {
        assert_eq!(rust_arm(&item), arm, "garde: {item}");

        let schema = closed_schema_for::<AttentionItem>().expect("the schema writes");
        let check = jsonschema::validator_for(&schema).expect("the schema builds a check");
        assert_eq!(check.is_valid(&item), arm.is_some(), "schema: {item}");
    }
}
