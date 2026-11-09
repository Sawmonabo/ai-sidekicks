//! Claude Code's `Auto memory` switch: the value one process runs with, the value a session reads
//! from the first source that holds one, and when a press takes effect.

use sidekicks_contracts::session::inspector::{SessionAutoMemory, SessionAutoMemoryAppliesAt};

use crate::driver::claude::session::settings_file::ClaudeSettingsSource;
use crate::driver::claude::spawn::environment::claude_text_variable;
use crate::driver::contract::params_and_results::SessionProcessState;

/// The settings key that turns Claude Code's auto memory on or off.
pub(crate) const CLAUDE_AUTO_MEMORY_SETTING: &str = "autoMemoryEnabled";

/// The variable that turns auto memory off at `1` and on at `0`, over every settings file.
pub(crate) const CLAUDE_AUTO_MEMORY_VARIABLE: &str = "CLAUDE_CODE_DISABLE_AUTO_MEMORY";

/// The value one process runs with: the variable it was spawned with where that is `1` (off) or
/// `0` (on), since it wins over every file, else `effective`, the value its settings resolve to.
pub(crate) fn read_claude_process_auto_memory(
    spawn_environment: &[(String, String)],
    effective: Option<bool>,
) -> Option<bool> {
    claude_text_variable(spawn_environment, CLAUDE_AUTO_MEMORY_VARIABLE)
        .and_then(read_auto_memory_variable)
        .or(effective)
}

/// What a session's `Auto memory` value is read from, each `None` where it holds no value.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Claude driver's memory read and switch call it"
    )
)]
pub(crate) struct ClaudeAutoMemorySources<'a> {
    /// The value of the process serving the session, or of the one a restart brings back, as
    /// `read_claude_process_auto_memory` reads it.
    pub(crate) running: Option<bool>,
    /// The session's stored switch.
    pub(crate) stored_switch: Option<bool>,
    /// The value of the session's last process, kept after it ended.
    pub(crate) kept: Option<bool>,
    /// The variable's text, as `claude_text_variable` reads it, in the environment the next
    /// process starts with.
    pub(crate) variable: Option<&'a str>,
    /// The tier and value of the first settings file that sets `autoMemoryEnabled` to a boolean.
    pub(crate) setting: Option<(ClaudeSettingsSource, bool)>,
}

/// The session's `Auto memory` switch: the first source holding a value decides it, in the order
/// the running process, the stored switch (a managed file's value outranks it), the kept value,
/// the variable, the settings files, then on. A stored switch that differs from a running process
/// waits for the next start.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Claude driver's memory read and switch call it"
    )
)]
pub(crate) fn read_claude_auto_memory(sources: &ClaudeAutoMemorySources<'_>) -> SessionAutoMemory {
    let managed = match sources.setting {
        Some((ClaudeSettingsSource::Managed, value)) => Some(value),
        _ => None,
    };
    let switch = sources
        .stored_switch
        .map(|switch| managed.unwrap_or(switch));
    let enabled = sources
        .running
        .or(switch)
        .or(sources.kept)
        .or_else(|| sources.variable.and_then(read_auto_memory_variable))
        .or(sources.setting.map(|(_, value)| value))
        .unwrap_or(true);
    SessionAutoMemory {
        enabled,
        enabled_at_next_turn: switch.filter(|switch| *switch != enabled),
    }
}

/// When a press of the switch takes effect: from the session's next turn while a process serves
/// the session or a restart brings one back, since Claude Code takes it between turns, and at once
/// otherwise.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the press of the Claude driver's memory switch calls it"
    )
)]
pub(crate) fn claude_auto_memory_applies_at(
    state: SessionProcessState,
) -> SessionAutoMemoryAppliesAt {
    match state {
        SessionProcessState::Live | SessionProcessState::Restarting => {
            SessionAutoMemoryAppliesAt::NextTurn
        }
        SessionProcessState::Down => SessionAutoMemoryAppliesAt::Now,
    }
}

// `1` turns auto memory off and `0` on; any other text leaves the value to the settings.
fn read_auto_memory_variable(text: &str) -> Option<bool> {
    match text {
        "1" => Some(false),
        "0" => Some(true),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::*;

    fn spawned_with(variable: &str, effective: Option<bool>) -> Option<bool> {
        read_claude_process_auto_memory(
            &[(CLAUDE_AUTO_MEMORY_VARIABLE.to_owned(), variable.to_owned())],
            effective,
        )
    }

    fn no_sources() -> ClaudeAutoMemorySources<'static> {
        ClaudeAutoMemorySources {
            running: None,
            stored_switch: None,
            kept: None,
            variable: None,
            setting: None,
        }
    }

    // Killed by a fallback other than on, by the settings files read before the variable, by a
    // process's effective value read before the variable it was spawned with, by any set variable
    // read as off, by the stored switch read over the managed file, by the kept value read before
    // a stored switch, by the kept value dropped or read after the variable, by the settings files
    // dropped, and by the managed file read before the variable where no switch is stored.
    #[rstest]
    #[case::nothing_anywhere(no_sources(), true)]
    #[case::variable_over_files(
        ClaudeAutoMemorySources {
            variable: Some("1"),
            setting: Some((ClaudeSettingsSource::Person, true)),
            ..no_sources()
        },
        false
    )]
    #[case::process_variable_over_effective(
        ClaudeAutoMemorySources { running: spawned_with("1", Some(true)), ..no_sources() },
        false
    )]
    #[case::other_variable_takes_effective(
        ClaudeAutoMemorySources { running: spawned_with("yes", Some(true)), ..no_sources() },
        true
    )]
    #[case::managed_over_switch(
        ClaudeAutoMemorySources {
            stored_switch: Some(true),
            setting: Some((ClaudeSettingsSource::Managed, false)),
            ..no_sources()
        },
        false
    )]
    #[case::switch_over_kept(
        ClaudeAutoMemorySources { stored_switch: Some(false), kept: Some(true), ..no_sources() },
        false
    )]
    #[case::kept_over_variable(
        ClaudeAutoMemorySources { kept: Some(true), variable: Some("1"), ..no_sources() },
        true
    )]
    #[case::files_over_default(
        ClaudeAutoMemorySources {
            setting: Some((ClaudeSettingsSource::Person, false)),
            ..no_sources()
        },
        false
    )]
    #[case::variable_over_managed_file(
        ClaudeAutoMemorySources {
            variable: Some("0"),
            setting: Some((ClaudeSettingsSource::Managed, false)),
            ..no_sources()
        },
        true
    )]
    fn the_first_auto_memory_source_holding_a_value_decides(
        #[case] sources: ClaudeAutoMemorySources<'static>,
        #[case] enabled: bool,
    ) {
        assert_eq!(read_claude_auto_memory(&sources).enabled, enabled);
    }

    // Killed by a fixed time of effect, by a missing value for the next turn, and by a value for
    // the next turn always set to the stored switch.
    #[rstest]
    #[case::live(
        SessionProcessState::Live,
        ClaudeAutoMemorySources { running: Some(true), stored_switch: Some(false), ..no_sources() },
        SessionAutoMemoryAppliesAt::NextTurn,
        SessionAutoMemory { enabled: true, enabled_at_next_turn: Some(false) }
    )]
    #[case::restarting(
        SessionProcessState::Restarting,
        ClaudeAutoMemorySources { running: Some(true), stored_switch: Some(false), ..no_sources() },
        SessionAutoMemoryAppliesAt::NextTurn,
        SessionAutoMemory { enabled: true, enabled_at_next_turn: Some(false) }
    )]
    #[case::down(
        SessionProcessState::Down,
        ClaudeAutoMemorySources { stored_switch: Some(false), kept: Some(true), ..no_sources() },
        SessionAutoMemoryAppliesAt::Now,
        SessionAutoMemory { enabled: false, enabled_at_next_turn: None }
    )]
    fn a_running_process_takes_a_press_at_its_next_turn(
        #[case] state: SessionProcessState,
        #[case] sources: ClaudeAutoMemorySources<'static>,
        #[case] applies_at: SessionAutoMemoryAppliesAt,
        #[case] read: SessionAutoMemory,
    ) {
        assert_eq!(claude_auto_memory_applies_at(state), applies_at);
        assert_eq!(read_claude_auto_memory(&sources), read);
    }
}
