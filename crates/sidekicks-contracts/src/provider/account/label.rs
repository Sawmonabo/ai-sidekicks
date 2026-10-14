//! What every screen names a provider account by, and what a workflow step's spent account
//! carries: the identity its provider reported, or for a pasted token or API key the name the
//! person gave it beside the credential's kind. Never the account's id.

use crate::provider::account::record::{AccountLabelFields, ProviderAuthMode};
use crate::provider::name::ProviderName;

/// The plan id a provider sends when it cannot say which plan the account is on.
const UNKNOWN_PLAN: &str = "unknown";

/// The name Codex's own app gives a plan id it sends; Claude Code's plans read as their ids.
fn codex_plan_word(plan: &str) -> Option<&'static str> {
    Some(match plan {
        "free" => "Free",
        "go" => "Go",
        "plus" => "Plus",
        "prolite" => "Pro",
        "pro" => "Pro (More)",
        "promax" => "Pro (Max)",
        "team" | "self_serve_business_usage_based" => "Business",
        "self_serve_business_prolite" => "Business Premium",
        "business" | "ent26" | "enterprise_cbp_usage_based" | "enterprise" => "Enterprise",
        "enterprise_cbp_automation" => "Enterprise (Automation)",
        "edu" => "Edu",
        "edu_plus" => "Edu Plus",
        "edu_pro" => "Edu Pro",
        _ => return None,
    })
}

/// The plan in its provider's own word; a plan no table names reads as its own words in sentence
/// case (`edu_max` as `Edu max`), so a plan a provider adds is still drawn.
fn plan_word(provider: ProviderName, plan: &str) -> Option<String> {
    if plan == UNKNOWN_PLAN {
        return None;
    }
    let named = match provider {
        ProviderName::Claude => None,
        ProviderName::Codex => codex_plan_word(plan),
    };
    if let Some(word) = named {
        return Some(word.to_owned());
    }
    let words = plan.replace('_', " ");
    let mut characters = words.chars();
    Some(match characters.next() {
        Some(first) => first.to_uppercase().chain(characters).collect(),
        None => words,
    })
}

/// The kind of credential a token or API-key account holds, drawn beside its typed name; every
/// other mode draws none.
fn credential_kind(provider: ProviderName, mode: ProviderAuthMode) -> Option<String> {
    match mode {
        ProviderAuthMode::OauthToken => Some(format!("{} token", provider.label())),
        ProviderAuthMode::ApiKey => Some(format!("{} API key", provider.label())),
        ProviderAuthMode::OauthSubscription
        | ProviderAuthMode::External
        | ProviderAuthMode::None
        | ProviderAuthMode::Unknown => None,
    }
}

/// The label every screen names an account by, drawn from its `fields`, or `None` for an account
/// still signing in that its provider has not named yet. A token or API-key account reads its typed name beside the
/// credential's kind (`Work · Codex API key`); every other account reads the email, the plan in
/// its provider's own word, then the organization (`sam@example.org · Business · Example Inc`).
pub fn account_label(fields: &AccountLabelFields<'_>) -> Option<String> {
    if let Some(display_label) = fields.display_label {
        let kind = fields
            .observed_auth_mode
            .and_then(|mode| credential_kind(fields.provider, mode));
        return Some(match kind {
            Some(kind) => format!("{display_label} · {kind}"),
            None => display_label.to_owned(),
        });
    }
    let plan = fields
        .observed_account_plan
        .and_then(|plan| plan_word(fields.provider, plan));
    let identity: Vec<&str> = [
        fields.observed_account_email,
        plan.as_deref(),
        fields.observed_account_org_name,
    ]
    .into_iter()
    .flatten()
    .collect();
    (!identity.is_empty()).then(|| identity.join(" · "))
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::{Map, Value};

    use super::account_label;
    use crate::provider::account::record::ProviderAccount;

    /// The case table: one account and the members each case lays over it.
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct CaseTable {
        account: Map<String, Value>,
        cases: Vec<Case>,
    }

    /// One account's overrides and the label it must read, or none.
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Case {
        name: String,
        overrides: Map<String, Value>,
        label: Option<String>,
    }

    #[test]
    fn names_each_account_as_the_case_table_says() {
        let table: CaseTable =
            serde_json::from_str(include_str!("../../../tests/fixtures/account-label.json"))
                .expect("the case table parses");
        for case in table.cases {
            let mut members = table.account.clone();
            members.extend(case.overrides);
            let account: ProviderAccount =
                serde_json::from_value(Value::Object(members)).expect("the case's account parses");
            assert_eq!(
                account_label(&account.label_fields()),
                case.label,
                "{}",
                case.name
            );
        }
    }
}
