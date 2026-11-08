//! The bound on one environment entry a program starts with on Windows.

use std::io;

use sidekicks_contracts::machine::settings::ENVIRONMENT_ENTRY_MAX_UNITS;
use sidekicks_contracts::workflow::run::failures::WorkflowStepValueMeasure;

use crate::environment_value_limits::EnvironmentValueLimits;

/// The environment bounds on Windows: 32,767 UTF-16 units for one `NAME=value` entry with its NUL,
/// and no total. Windows states 32,767 characters a variable and no limit on the whole block, and
/// says neither whether the name or the NUL counts nor what fails past it, so the bound is the
/// strictest reading of it; std encodes the block to UTF-16 and checks it only for NULs. Never
/// fails.
pub fn read_environment_value_limits() -> io::Result<EnvironmentValueLimits> {
    Ok(EnvironmentValueLimits {
        per_value: ENVIRONMENT_ENTRY_MAX_UNITS,
        total: None,
        measure: WorkflowStepValueMeasure::Utf16Units,
    })
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use super::read_environment_value_limits;

    // The variable's name; its entry is this, `=`, the value and a NUL.
    const PROBE_NAME: &str = "SIDEKICKS_PROBE";

    // An entry that fills the bound, its NUL counted, reaches the child whole: the bound is safe,
    // though no Windows page says a longer one is refused. Fails when `per_value` is set past what
    // Windows passes whole in one variable.
    #[test]
    fn an_entry_at_the_bound_reaches_the_child_whole() {
        let limits = read_environment_value_limits().expect("the limits read");
        let value_units = limits.per_value - PROBE_NAME.len() - 2;

        let output = Command::new("powershell")
            .args(["-NoProfile", "-Command", "$env:SIDEKICKS_PROBE.Length"])
            .env(PROBE_NAME, "a".repeat(value_units))
            .output()
            .expect("PowerShell starts");

        assert!(output.status.success(), "{output:?}");
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            value_units.to_string()
        );
    }
}
