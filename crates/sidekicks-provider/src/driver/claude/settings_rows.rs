//! The Settings rows Claude Code's driver declares, `Output style` and `Advisor`, each a choice
//! among what the installed build offers, holding the app's pick where there is one. A pick reaches
//! sessions started later through their `--settings`, so neither row runs anything when it changes.

use sidekicks_contracts::machine::settings::ProviderRowValues;
use sidekicks_contracts::provider::declaration::{
    PROVIDER_DECLARATION_TEXT_MAX_LEN, ProviderChoiceOption, ProviderChoiceOptions,
    ProviderDeclarationId, ProviderDeclarationText, ProviderRow, ProviderSettingControl,
    ProviderValueText,
};
use sidekicks_std::text_cut::cut_to_code_points;

use crate::driver::claude::session::answered_commands::{
    ClaudeAdvisorChoices, ClaudeCommandChoices, ClaudeOutputStyleDescriptions,
};
use crate::driver::claude::session::establishment::context::{
    CLAUDE_ADVISOR_ROW_ID, CLAUDE_OUTPUT_STYLE_ROW_ID, read_claude_row_choice, read_claude_row_text,
};

/// The line under the `Output style` row.
const OUTPUT_STYLE_LINE: &str = concat!(
    "Applies to sessions started later. ",
    "A session already running changes its own style from its composer."
);

/// The line under the `Advisor` row.
const ADVISOR_LINE: &str = concat!(
    "Applies to sessions started later. ",
    "A session already running changes its own advisor from its composer."
);

/// The words of the advisor choice's none.
const NO_ADVISOR_LABEL: &str = "No advisor";

/// The two rows from what the installed build offers, `offers`, or each as a status naming
/// `unread` where the build could not be read. Each value is the app's pick in `app_values`, else
/// the person's own Claude Code setting (`person_output_style`, `person_advisor_model`); an advisor
/// neither sets reads `No advisor`.
pub(crate) fn compose_claude_rows(
    offers: Result<ClaudeCommandChoices, String>,
    app_values: &ProviderRowValues,
    person_output_style: Option<String>,
    person_advisor_model: Option<String>,
) -> Vec<ProviderRow> {
    let output_style =
        read_claude_row_text(app_values, CLAUDE_OUTPUT_STYLE_ROW_ID).or(person_output_style);
    let advisor =
        read_claude_row_choice(app_values, CLAUDE_ADVISOR_ROW_ID).unwrap_or(person_advisor_model);
    let offers = match offers {
        Ok(offers) => offers,
        Err(unread) => {
            let line = format!("Claude Code's choices could not be read: {unread}");
            return vec![
                compose_status_row(CLAUDE_OUTPUT_STYLE_ROW_ID, "Output style", &line),
                compose_status_row(CLAUDE_ADVISOR_ROW_ID, "Advisor", &line),
            ];
        }
    };
    let style_options = offers.output_style_names.iter().filter_map(|style| {
        let line = match &offers.output_styles {
            ClaudeOutputStyleDescriptions::Listed(described) => described.get(style),
            ClaudeOutputStyleDescriptions::Unlisted { .. } => None,
        };
        compose_option(style, line.map(String::as_str))
    });
    let style_row = match ProviderChoiceOptions::new(style_options.collect()) {
        Some(options) => compose_choice_row(
            CLAUDE_OUTPUT_STYLE_ROW_ID,
            "Output style",
            OUTPUT_STYLE_LINE,
            output_style,
            None,
            options,
        ),
        None => compose_status_row(
            CLAUDE_OUTPUT_STYLE_ROW_ID,
            "Output style",
            "This Claude Code build names no output styles.",
        ),
    };
    let advisor_row = match &offers.advisor {
        ClaudeAdvisorChoices::Listed(advisors) => {
            match ProviderChoiceOptions::new(
                advisors
                    .iter()
                    .filter_map(|advisor| compose_option(advisor, None))
                    .collect(),
            ) {
                Some(options) => compose_choice_row(
                    CLAUDE_ADVISOR_ROW_ID,
                    "Advisor",
                    ADVISOR_LINE,
                    advisor,
                    Some(NO_ADVISOR_LABEL),
                    options,
                ),
                None => compose_status_row(
                    CLAUDE_ADVISOR_ROW_ID,
                    "Advisor",
                    "Claude Code offers no advisor.",
                ),
            }
        }
        ClaudeAdvisorChoices::Unoffered { line } | ClaudeAdvisorChoices::Unlisted { line } => {
            compose_status_row(CLAUDE_ADVISOR_ROW_ID, "Advisor", line)
        }
    };
    vec![style_row, advisor_row]
}

fn compose_choice_row(
    row_id: &str,
    label: &str,
    line: &str,
    value: Option<String>,
    none_label: Option<&str>,
    options: ProviderChoiceOptions,
) -> ProviderRow {
    ProviderRow::Setting {
        id: row_id_of(row_id),
        label: written_text(label),
        line: Some(written_text(line)),
        control: ProviderSettingControl::Choice {
            value: value.and_then(|value| ProviderValueText::new(value).ok()),
            none_label: none_label.map(written_text),
            options,
        },
    }
}

// A row whose text is the driver's own words or a line Claude Code printed, which reads as the
// driver's own where it is no text a declaration carries.
fn compose_status_row(row_id: &str, label: &str, text: &str) -> ProviderRow {
    ProviderRow::Status {
        id: row_id_of(row_id),
        label: written_text(label),
        line: None,
        text: printed_text(text).unwrap_or_else(|| written_text("Claude Code's line is not text.")),
    }
}

// One offered name, labeled as Claude Code's own lists name it; `None` for a name no value
// carries.
fn compose_option(value: &str, line: Option<&str>) -> Option<ProviderChoiceOption> {
    Some(ProviderChoiceOption {
        value: ProviderValueText::new(value.to_owned()).ok()?,
        label: printed_text(value)?,
        line: line.and_then(printed_text),
        unavailable_reason: None,
    })
}

fn row_id_of(row_id: &str) -> ProviderDeclarationId {
    ProviderDeclarationId::new(row_id.to_owned()).expect("a row's id fits the id pattern")
}

// The driver's own words.
fn written_text(text: &str) -> ProviderDeclarationText {
    ProviderDeclarationText::new(text.to_owned()).expect("the driver's words are short text")
}

// Text Claude Code printed, cut to a declaration's cap; `None` where it is blank or holds NUL.
fn printed_text(text: &str) -> Option<ProviderDeclarationText> {
    ProviderDeclarationText::new(
        cut_to_code_points(text, PROVIDER_DECLARATION_TEXT_MAX_LEN).to_owned(),
    )
    .ok()
}
