//! What every screen names a provider account by, and what a workflow step's spent account
//! carries: the identity its provider reported, or for a pasted token or API key the name the
//! person gave it beside the credential's kind. Never the account's id.

use crate::provider::account::record::{AccountLabelFields, ProviderAuthMode};
use crate::provider::settings::ProviderPlanWord;

/// The plan id a provider sends when it cannot say which plan the account is on.
const UNKNOWN_PLAN: &str = "unknown";

/// The plan in its provider's own word from `plan_words`; a plan the list names no word for reads
/// as its own words in sentence case (`edu_max` as `Edu max`), so a plan a provider adds is still
/// drawn.
fn plan_word(plan_words: &[ProviderPlanWord], plan: &str) -> Option<String> {
    if plan == UNKNOWN_PLAN {
        return None;
    }
    if let Some(named) = plan_words.iter().find(|named| named.plan.as_str() == plan) {
        return Some(named.word.as_str().to_owned());
    }
    let words = plan.replace('_', " ");
    let mut characters = words.chars();
    Some(match characters.next() {
        Some(first) => first.to_uppercase().chain(characters).collect(),
        None => words,
    })
}

/// The kind of credential a token or API-key account holds, drawn beside its typed name after the
/// provider's name; every other mode draws none.
fn credential_kind(provider_name: &str, mode: ProviderAuthMode) -> Option<String> {
    match mode {
        ProviderAuthMode::OauthToken => Some(format!("{provider_name} token")),
        ProviderAuthMode::ApiKey => Some(format!("{provider_name} API key")),
        ProviderAuthMode::OauthSubscription
        | ProviderAuthMode::External
        | ProviderAuthMode::None
        | ProviderAuthMode::Unknown => None,
    }
}

/// The label every screen names an account by, drawn from its `fields`, its provider's name as a
/// person reads it and its provider's `plan_words`, both from the provider read; `None` for an
/// account still signing in that its provider has not named yet. A token or API-key account reads
/// its typed name beside the credential's kind (`Work · <provider> API key`); every other account
/// reads the email, the plan in its provider's own word, then the organization
/// (`sam@example.org · Business · Example Inc`).
pub fn account_label(
    fields: &AccountLabelFields<'_>,
    provider_name: &str,
    plan_words: &[ProviderPlanWord],
) -> Option<String> {
    if let Some(display_label) = fields.display_label {
        let kind = fields
            .observed_auth_mode
            .and_then(|mode| credential_kind(provider_name, mode));
        return Some(match kind {
            Some(kind) => format!("{display_label} · {kind}"),
            None => display_label.to_owned(),
        });
    }
    let plan = fields
        .observed_account_plan
        .and_then(|plan| plan_word(plan_words, plan));
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
    use std::collections::HashMap;

    use serde::Deserialize;
    use serde_json::{Map, Value};

    use super::account_label;
    use crate::provider::account::record::ProviderAccount;
    use crate::provider::settings::ProviderPlanWord;

    /// The case table: one account, the words each provider's read carries, and the members each
    /// case lays over the account.
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct CaseTable {
        account: Map<String, Value>,
        providers: HashMap<String, ProviderWords>,
        cases: Vec<Case>,
    }

    /// One provider's name and plan words, as its read sends them.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ProviderWords {
        name: String,
        plan_words: Vec<ProviderPlanWord>,
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
            let words = members
                .get("provider")
                .and_then(Value::as_str)
                .and_then(|provider| table.providers.get(provider))
                .expect("the case's provider has words in the table");
            let account: ProviderAccount =
                serde_json::from_value(Value::Object(members)).expect("the case's account parses");
            assert_eq!(
                account_label(&account.label_fields(), &words.name, &words.plan_words),
                case.label,
                "{}",
                case.name
            );
        }
    }
}
