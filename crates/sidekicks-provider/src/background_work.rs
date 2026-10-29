//! Which shell lines start a provider's background work, read wherever a line runs it, the strings
//! its shells run included: work no agent of the session holds, that `Stop` and `Interrupt` never
//! reach and that the session's receipt never shows, refused at every level in every session. The
//! forms come from each registered provider's own background-work facts, which the daemon's start
//! gathers once, so nothing here names a provider.

use std::sync::Arc;

use sidekicks_policy::shell_commands::{
    ShellCommand, ShellLineReader, ShellLineReading, WordText, is_option,
};

use crate::driver::{BackgroundWork, ProviderDescriptor};

/// Every registered provider's background work: the names its command runs under, the
/// subcommands and flags that start the work, and the refusal an agent reads. Built once at the
/// daemon's start.
pub struct BackgroundWorkForms {
    providers: Vec<ProviderBackgroundWork>,
}

// One provider's background work and the program names that run it.
struct ProviderBackgroundWork {
    command_names: Vec<&'static str>,
    work: &'static BackgroundWork,
}

impl BackgroundWorkForms {
    /// The background work of each of `descriptors` that has any, in their order.
    pub fn of_providers(descriptors: &[&'static ProviderDescriptor]) -> Self {
        Self {
            providers: descriptors
                .iter()
                .filter_map(|descriptor| {
                    Some(ProviderBackgroundWork {
                        command_names: descriptor.command_names().collect(),
                        work: descriptor.background_work.as_ref()?,
                    })
                })
                .collect(),
        }
    }
}

/// The reason the agent reads when the line `reading` holds starts background work of one of
/// `forms`' providers, or `None` when it starts none. The `-c` and `eval` strings its shells run
/// are reread on `reader` and judged only when read whole; a line not read whole refuses nothing,
/// since what the parser could not read is no ground for a refusal.
pub fn refuse_background_work(
    forms: &BackgroundWorkForms,
    reader: &mut ShellLineReader,
    reading: &ShellLineReading,
) -> Option<&'static str> {
    if !reading.is_whole() {
        return None;
    }
    // The strings still to judge, so a nesting depth costs a list entry and never a stack frame.
    let mut rereads: Vec<Arc<ShellLineReading>> = Vec::new();
    if let Some(refusal) = refusal_in(forms, reader, reading, &mut rereads) {
        return Some(refusal);
    }
    while let Some(reread) = rereads.pop() {
        if reread.is_whole()
            && let Some(refusal) = refusal_in(forms, reader, &reread, &mut rereads)
        {
            return Some(refusal);
        }
    }
    None
}

/// Each of `forms`' background-work forms written plainly, `<program> <subcommand or flag>`, once
/// each, for a provider's own deny rules at the levels that never ask; every other spelling is
/// read by [`refuse_background_work`] in the provider's pre-tool hook.
pub(crate) fn plain_background_work_forms(forms: &BackgroundWorkForms) -> Vec<String> {
    let mut plain: Vec<String> = Vec::new();
    for provider in &forms.providers {
        let work = provider.work;
        for name in &provider.command_names {
            for word in work.subcommands.iter().chain(work.flags) {
                let form = format!("{name} {word}");
                if !plain.contains(&form) {
                    plain.push(form);
                }
            }
        }
    }
    plain
}

// The refusal for a command of `reading` that hands a shell no string and starts background work;
// each string a command hands a shell is read and left in `rereads` to be judged in its place.
fn refusal_in(
    forms: &BackgroundWorkForms,
    reader: &mut ShellLineReader,
    reading: &ShellLineReading,
    rereads: &mut Vec<Arc<ShellLineReading>>,
) -> Option<&'static str> {
    for command in reading.commands() {
        match reader.read_command_string(command) {
            Some(reread) => rereads.push(reread),
            None => {
                if let Some(refusal) = forms
                    .providers
                    .iter()
                    .find_map(|provider| background_work_refusal(provider, command))
                {
                    return Some(refusal);
                }
            }
        }
    }
    None
}

// The provider's refusal when `command` runs its own program in a background-work form.
fn background_work_refusal(
    provider: &ProviderBackgroundWork,
    command: ShellCommand<'_>,
) -> Option<&'static str> {
    let work = provider.work;
    let program = command.program();
    if !provider.command_names.iter().any(|name| program.is(name)) {
        return None;
    }
    let is_background = names_background_subcommand(work, command)
        || command
            .argument_words()
            .any(|word| work.flags.iter().any(|flag| is_option(word, flag)));
    is_background.then_some(work.refusal)
}

// The subcommand is the first word that is no option. A word right after an option may be that
// option's value or the subcommand, so it counts when it names one and is skipped otherwise; any
// other word is the prompt, and no word after it is a subcommand.
fn names_background_subcommand(work: &BackgroundWork, command: ShellCommand<'_>) -> bool {
    let mut may_be_option_value = false;
    for word in command.argument_words() {
        if word.is("--") {
            may_be_option_value = false;
        } else if word.starts_with("-") {
            may_be_option_value = !word.chars().any(|character| character == '=');
        } else if work
            .subcommands
            .iter()
            .any(|subcommand| word.is(subcommand))
        {
            return true;
        } else if may_be_option_value {
            may_be_option_value = false;
        } else {
            return false;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_policy::shell_commands::ShellLineReader;

    use super::{BackgroundWorkForms, refuse_background_work};
    use crate::driver::PROVIDERS;

    // Far past every line here, so the cases read the walk and never the cap.
    const LIMIT: usize = 4096;

    // Killed by dropping the reread of a shell's string (the `-c`, `eval` and nested cases), the
    // option-value arm (`--model opus agents`), the `=<value>` form, the stop at the prompt
    // (`"explain" agents`), a refusal of a line not read whole, or a form the table holds (one of
    // each kind: a background subcommand, its supervisor, a restart, a session served from
    // elsewhere, the background flag, the cloud flag).
    #[rstest]
    #[case::subcommand("claude agents", true)]
    #[case::supervisor_subcommand("claude daemon stop --any", true)]
    #[case::restart("claude respawn --all", true)]
    #[case::served_elsewhere("claude remote-control --name x", true)]
    #[case::runner("claude self-hosted-runner setup", true)]
    #[case::background_flag("claude -p --bg x", true)]
    #[case::background_flag_with_value("claude --background=yes x", true)]
    #[case::cloud_flag(r#"claude --cloud "fix the bug""#, true)]
    #[case::remote_control_flag("claude --rc", true)]
    #[case::option_value_before_subcommand("claude --model opus agents", true)]
    #[case::flag_before_subcommand("claude --dangerously-skip-permissions daemon run", true)]
    #[case::shell_string("sh -c 'claude --bg x'", true)]
    #[case::bash_string(r#"bash -c "claude agents""#, true)]
    #[case::eval_string("eval claude daemon", true)]
    #[case::nested_string(r#"sh -c "bash -c 'claude agents'""#, true)]
    #[case::through_a_wrapper("env FOO=1 claude --bg x", true)]
    #[case::split_string_inside_the_word("env -S'claude --bg x'", true)]
    #[case::prompt_naming_a_subcommand(r#"claude "list the agents""#, false)]
    #[case::subcommand_after_the_prompt(r#"claude "explain" agents"#, false)]
    #[case::session_listing("claude attach 7c5dcf5d", false)]
    #[case::other_program("agents daemon --bg", false)]
    #[case::unterminated_line(r#"claude --bg x && echo "unterminated"#, false)]
    #[case::unread_string(r#"sh -c 'claude --bg "x'"#, false)]
    fn a_line_starts_background_work(#[case] line: &str, #[case] is_refused: bool) {
        let mut reader = ShellLineReader::new(LIMIT);
        let reading = reader.read(line);

        assert_eq!(
            refuse_background_work(
                &BackgroundWorkForms::of_providers(PROVIDERS),
                &mut reader,
                &reading
            )
            .is_some(),
            is_refused
        );
    }
}
