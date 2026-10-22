//! The commands a person types that the daemon answers itself on Claude Code and never sends:
//! Claude Code's own `/output-style` writes the project's local settings, its `/advisor` saves the
//! choice for the whole machine, and its `/config` writes the person's settings, so each is applied
//! for this one session instead. Only the `/config` keys a console control owns are the daemon's;
//! every other `/config` goes as typed. Typed with nothing, `/output-style` and `/advisor` list
//! what a control-only process in the session's folder printed for each; an argument the session
//! cannot take goes as typed, and Claude Code answers it.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;
use sidekicks_contracts::wire::text::is_ecmascript_whitespace;

use crate::provider::driver::claude::session::transport::readings::{
    ClaudeCreationFiguresReading, ClaudeLocalCommandReply,
};

/// The `/config` keys a console control owns, as Claude Code's parser names them, matched as it
/// matches them, ignoring case.
const CLAUDE_CONSOLE_OWNED_CONFIG_KEYS: [&str; 3] = ["model", "permissionmode", "autocompact"];

/// The words that turn the advisor off, as Claude Code's own `/advisor` reads them.
const CLAUDE_ADVISOR_OFF_WORDS: [&str; 2] = ["off", "unset"];

/// The line Claude Code's `/advisor` prints its choices on, `Usage: /advisor <a|b|off>`.
const CLAUDE_ADVISOR_USAGE: (&str, &str) = ("Usage: /advisor <", ">");

/// The outcome Claude Code stamps on a command this session cannot open, which for `/advisor`
/// means it offers no advisor here.
const CLAUDE_UNAVAILABLE_HEADLESS_OUTCOME: &str = "unavailable_headless";

/// The mark Claude Code puts after the style in force in its `/output-style` listing.
const CLAUDE_CURRENT_STYLE_MARK: &str = " (current)";

/// The words Claude Code's own commands read as asking what the session holds, not as a value.
const CLAUDE_SHOW_WORDS: [&str; 16] = [
    "list", "show", "display", "current", "view", "get", "check", "describe", "print", "version",
    "about", "status", "?", "help", "-h", "--help",
];

/// The descriptions Claude Code printed for its output styles, by name, or why it printed none.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeOutputStyleDescriptions {
    /// It printed them.
    Listed(HashMap<String, String>),
    /// It printed none; the line says why.
    Unlisted {
        /// The line shown in their place.
        line: String,
    },
}

/// The advisors Claude Code's `/advisor` offers; or that it offers none here, with the line it
/// printed, shown as sent; or that they could not be listed, with why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeAdvisorChoices {
    /// The advisors offered, `off` left out.
    Listed(Vec<String>),
    /// None is offered here.
    Unoffered {
        /// Claude Code's own line.
        line: String,
    },
    /// They could not be listed.
    Unlisted {
        /// Why, in words.
        line: String,
    },
}

/// What a session holds for the commands the daemon answers itself with no argument.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeCommandChoices {
    /// The style names the build offers, in its order.
    pub(crate) output_style_names: Vec<String>,
    /// The style descriptions.
    pub(crate) output_styles: ClaudeOutputStyleDescriptions,
    /// The advisors.
    pub(crate) advisor: ClaudeAdvisorChoices,
}

/// The advisor Claude Code says it will attach to the session's requests (`get_settings`
/// `applied.advisor`): a model, none, or unreported by a build whose reply carries no such field.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeAttachedAdvisor {
    /// This model attaches.
    Attached {
        /// The model.
        model: String,
    },
    /// None attaches.
    Detached,
    /// The build does not report it.
    Unreported,
}

/// One command the daemon answers itself, with the words typed after it, trimmed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeAnsweredCommand {
    /// `/output-style <argument>`.
    OutputStyle {
        /// The words after it.
        argument: String,
    },
    /// `/advisor <argument>`.
    Advisor {
        /// The words after it.
        argument: String,
    },
    /// `/config` naming a key a console control owns.
    Config,
}

/// What a command comes to: a listing to show or a value to apply. It is never sent as typed,
/// since Claude Code's own command would save the choice beyond the session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeCommandOutcome<V> {
    /// The listing to show, laid out as Claude Code's own.
    Listing {
        /// Its text.
        line: String,
    },
    /// The value to apply.
    Apply(V),
}

// A `get_settings` reply's `applied` member; every other member is left unread.
#[derive(Deserialize)]
struct SettingsReply {
    #[serde(default)]
    applied: Option<Value>,
}

/// Reads the advisor a `get_settings` reply says will attach to the session's requests.
pub(crate) fn read_claude_attached_advisor(reply: Option<&RawValue>) -> ClaudeAttachedAdvisor {
    let applied = reply
        .and_then(|reply| serde_json::from_str::<SettingsReply>(reply.get()).ok())
        .and_then(|reply| reply.applied);
    let Some(Value::Object(applied)) = applied else {
        return ClaudeAttachedAdvisor::Unreported;
    };
    match applied.get("advisor") {
        None => ClaudeAttachedAdvisor::Unreported,
        Some(Value::String(model)) if !model.is_empty() => ClaudeAttachedAdvisor::Attached {
            model: model.clone(),
        },
        Some(_) => ClaudeAttachedAdvisor::Detached,
    }
}

/// What a session holds from the command replies of its creation-time process: the style
/// descriptions, unlisted when the build no longer lists `/output-style`, and the advisors.
pub(crate) fn read_claude_command_choices(
    reading: &ClaudeCreationFiguresReading,
) -> ClaudeCommandChoices {
    let output_style = &reading.output_style;
    let output_styles = match (output_style.is_listed, &output_style.text) {
        (false, _) => ClaudeOutputStyleDescriptions::Unlisted {
            line: "This Claude Code build does not list style descriptions.".to_owned(),
        },
        (true, None) => ClaudeOutputStyleDescriptions::Unlisted {
            line: "Claude Code printed no style descriptions.".to_owned(),
        },
        (true, Some(text)) => ClaudeOutputStyleDescriptions::Listed(
            read_output_style_descriptions(text, &reading.output_style_names),
        ),
    };
    ClaudeCommandChoices {
        output_style_names: reading.output_style_names.clone(),
        output_styles,
        advisor: read_advisor_choices(&reading.advisor),
    }
}

/// What a session holds when its command choices could not be read, with the reason given.
pub(crate) fn unreadable_claude_command_choices(detail: &str) -> ClaudeCommandChoices {
    ClaudeCommandChoices {
        output_style_names: Vec::new(),
        output_styles: ClaudeOutputStyleDescriptions::Unlisted {
            line: format!("Claude Code's style descriptions could not be read: {detail}"),
        },
        advisor: ClaudeAdvisorChoices::Unlisted {
            line: format!("Claude Code's advisors could not be read: {detail}"),
        },
    }
}

/// The command typed `text` is when the daemon answers it itself, or `None` for text that goes to
/// Claude Code as typed. Only text that starts with the command reads as one, as Claude Code reads
/// it.
#[expect(
    dead_code,
    reason = "message admission reads each typed message through it before writing it"
)]
pub(crate) fn read_claude_answered_command(text: &str) -> Option<ClaudeAnsweredCommand> {
    let typed = text.strip_prefix('/')?;
    let mut words = typed
        .split(is_ecmascript_whitespace)
        .filter(|word| !word.is_empty());
    let command = words.next()?;
    match command {
        "output-style" => Some(ClaudeAnsweredCommand::OutputStyle {
            argument: words.collect::<Vec<_>>().join(" "),
        }),
        "advisor" => Some(ClaudeAnsweredCommand::Advisor {
            argument: words.collect::<Vec<_>>().join(" "),
        }),
        // `key=value` pairs; a `/config` naming none of the owned keys goes as typed.
        "config" => words
            .any(|pair| {
                let key = pair.split('=').next().unwrap_or_default().to_lowercase();
                CLAUDE_CONSOLE_OWNED_CONFIG_KEYS.contains(&key.as_str())
            })
            .then_some(ClaudeAnsweredCommand::Config),
        _ => None,
    }
}

/// What `/output-style <argument>` does on a session offering `styles` with `current` in force: a
/// style named in any case applies by its own name; anything else, nothing or a word asking to
/// show included, is the listing laid out as Claude Code's own with the descriptions it printed.
#[expect(
    dead_code,
    reason = "message admission answers a typed /output-style through it"
)]
pub(crate) fn answer_claude_output_style(
    argument: &str,
    styles: &[String],
    current: Option<&str>,
    descriptions: &ClaudeOutputStyleDescriptions,
) -> ClaudeCommandOutcome<String> {
    let requested = argument.to_lowercase();
    // A word asking what the session holds lists it, as Claude Code's own command reads it.
    if !CLAUDE_SHOW_WORDS.contains(&requested.as_str())
        && let Some(style) = styles.iter().find(|name| name.to_lowercase() == requested)
    {
        return ClaudeCommandOutcome::Apply(style.clone());
    }
    let mut lines = Vec::with_capacity(styles.len() + 7);
    if let Some(current) = current {
        lines.extend([format!("Output style: {current}"), String::new()]);
    }
    lines.push("Available styles:".to_owned());
    for name in styles {
        let mark = if Some(name.as_str()) == current {
            CLAUDE_CURRENT_STYLE_MARK
        } else {
            ""
        };
        let description = match descriptions {
            ClaudeOutputStyleDescriptions::Listed(listed) => listed.get(name),
            ClaudeOutputStyleDescriptions::Unlisted { .. } => None,
        };
        lines.push(match description {
            Some(description) => format!("- {name}{mark}: {description}"),
            None => format!("- {name}{mark}"),
        });
    }
    lines.push(String::new());
    if let ClaudeOutputStyleDescriptions::Unlisted { line } = descriptions {
        lines.extend([line.clone(), String::new()]);
    }
    lines.push("Usage: /output-style <style>".to_owned());
    ClaudeCommandOutcome::Listing {
        line: lines.join("\n"),
    }
}

/// What `/advisor <argument>` does on a session whose Claude Code attaches `attached` and offers
/// `advisors`: `off` applies `None`; an offered advisor applies; anything else, nothing included,
/// is the listing in Claude Code's own layout naming only an advisor that attaches, or, where it
/// offers none here, its own line as sent. `current` is the session's own value, shown where the
/// build does not report what attaches; `display_name_of` names a model as Claude Code's own lines
/// name it.
#[expect(
    dead_code,
    reason = "message admission answers a typed /advisor through it"
)]
pub(crate) fn answer_claude_advisor(
    argument: &str,
    current: Option<&str>,
    attached: &ClaudeAttachedAdvisor,
    advisors: &ClaudeAdvisorChoices,
    display_name_of: &dyn Fn(&str) -> String,
) -> ClaudeCommandOutcome<Option<String>> {
    let requested = argument.to_lowercase();
    if CLAUDE_ADVISOR_OFF_WORDS.contains(&requested.as_str()) {
        return ClaudeCommandOutcome::Apply(None);
    }
    let choices = match advisors {
        ClaudeAdvisorChoices::Listed(choices) if choices.contains(&requested) => {
            return ClaudeCommandOutcome::Apply(Some(requested));
        }
        ClaudeAdvisorChoices::Unoffered { line } => {
            return ClaudeCommandOutcome::Listing { line: line.clone() };
        }
        ClaudeAdvisorChoices::Listed(choices) => {
            let mut offered = choices.clone();
            offered.push("off".to_owned());
            format!(
                "{}{}{}",
                CLAUDE_ADVISOR_USAGE.0,
                offered.join("|"),
                CLAUDE_ADVISOR_USAGE.1
            )
        }
        ClaudeAdvisorChoices::Unlisted { line } => line.clone(),
    };
    let shown = match attached {
        ClaudeAttachedAdvisor::Attached { model } => Some(model.as_str()),
        ClaudeAttachedAdvisor::Detached => None,
        ClaudeAttachedAdvisor::Unreported => current,
    };
    let header = shown.map_or_else(|| "off".to_owned(), display_name_of);
    ClaudeCommandOutcome::Listing {
        line: format!("Advisor: {header}\n{choices}"),
    }
}

// Each style's description from what `/output-style` printed, one `- <name>[ (current)][:
// <description>]` row per style, matched on the longest of `names` a row starts with, so a colon
// inside a name or a description never moves the split. A row naming no known style is skipped.
fn read_output_style_descriptions(text: &str, names: &[String]) -> HashMap<String, String> {
    let mut longest_first: Vec<&String> = names.iter().collect();
    longest_first.sort_by_key(|name| std::cmp::Reverse(name.len()));
    let mut descriptions = HashMap::new();
    for row in text.split('\n').filter_map(|line| line.strip_prefix("- ")) {
        for name in &longest_first {
            let Some(after_name) = row.strip_prefix(name.as_str()) else {
                continue;
            };
            let after_mark = after_name
                .strip_prefix(CLAUDE_CURRENT_STYLE_MARK)
                .unwrap_or(after_name);
            if after_mark.is_empty() {
                break;
            }
            if let Some(description) = after_mark.strip_prefix(": ") {
                descriptions.insert((*name).clone(), description.to_owned());
                break;
            }
        }
    }
    descriptions
}

// The advisors from `/advisor`'s usage line. Without one, an `unavailable_headless` reply means
// Claude Code offers no advisor here; any other reply from a build that stopped listing the
// command is a version fault.
fn read_advisor_choices(advisor: &ClaudeLocalCommandReply) -> ClaudeAdvisorChoices {
    let offered = advisor.text.as_deref().and_then(|text| {
        // Each line as a multiline pattern's `^` and `$` read it, at every line terminator.
        text.split(['\n', '\r', '\u{2028}', '\u{2029}'])
            .find_map(|line| {
                line.strip_prefix(CLAUDE_ADVISOR_USAGE.0)?
                    .strip_suffix(CLAUDE_ADVISOR_USAGE.1)
                    .filter(|choices| !choices.contains('>'))
            })
    });
    if let Some(offered) = offered {
        return ClaudeAdvisorChoices::Listed(
            offered
                .split('|')
                .filter(|choice| !CLAUDE_ADVISOR_OFF_WORDS.contains(choice))
                .map(str::to_owned)
                .collect(),
        );
    }
    match (&advisor.text, advisor.outcome.as_deref()) {
        (Some(text), Some(CLAUDE_UNAVAILABLE_HEADLESS_OUTCOME)) => {
            ClaudeAdvisorChoices::Unoffered { line: text.clone() }
        }
        _ => ClaudeAdvisorChoices::Unlisted {
            line: if advisor.is_listed {
                "Claude Code printed no advisor choices."
            } else {
                "This Claude Code build does not list its advisors."
            }
            .to_owned(),
        },
    }
}
