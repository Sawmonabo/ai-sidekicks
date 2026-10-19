//! What the system starts, with no shell, to run a program's build: the build itself, or on Windows
//! the Node script an npm or pnpm command shim wraps, run under Node.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::{Regex, RegexBuilder};

use crate::path::rules::PathRules;

// The script an npm or pnpm shim hands its arguments to, written relative to the shim's folder:
// `"%dp0%\…\cli.js" %*` from npm, `"%~dp0\…\cli.js" %*` from pnpm.
static SHIM_SCRIPT_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#""%~?dp0%?\\([^"]+)"\s+%\*"#).expect("the shim script pattern compiles")
});

// A shim whose program is Node names the `node.exe` it prefers, beside the shim.
static SHIM_NODE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    RegexBuilder::new(r"%~?dp0%?\\node\.exe")
        .case_insensitive(true)
        .build()
        .expect("the shim Node pattern compiles")
});

/// What the system starts to run one build.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProgramStart {
    /// The program the system starts.
    pub program: PathBuf,
    /// The arguments put before the caller's own: the script a command shim wraps, or none.
    pub leading_arguments: Vec<PathBuf>,
}

/// What the system starts, with no shell, to run the build at `build`: the build itself, except on
/// Windows a `.cmd` or `.bat` npm or pnpm shim, whose Node script runs under the shim's own
/// `node.exe`, else the `node` `find_on_search_path` finds. Fails with the read's error for a shim,
/// or a `node.exe` beside it, that cannot be read, `InvalidData` for a shim that wraps no Node
/// script and `NotFound` when no Node is found; it reads a file, so it runs on the daemon's
/// spawner thread or in `spawn_blocking`.
pub fn program_start(
    build: &Path,
    find_on_search_path: impl FnOnce(&str) -> Option<PathBuf>,
) -> io::Result<ProgramStart> {
    program_start_with_rules(PathRules::NATIVE, build, find_on_search_path)
}

// Started through `cmd.exe` the shim would read the caller's arguments as its own syntax, refuse
// an argument holding a line break and answer `cmd.exe`'s process id, so its script runs under
// Node directly and a shim that cannot be read is refused rather than started.
fn program_start_with_rules(
    rules: PathRules,
    build: &Path,
    find_on_search_path: impl FnOnce(&str) -> Option<PathBuf>,
) -> io::Result<ProgramStart> {
    let is_command_shim = match rules {
        PathRules::Posix => false,
        PathRules::Windows => build.extension().is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        }),
    };
    if !is_command_shim {
        return Ok(ProgramStart {
            program: build.to_path_buf(),
            leading_arguments: Vec::new(),
        });
    }
    let shim_text = String::from_utf8_lossy(&std::fs::read(build)?).into_owned();
    let script = read_command_shim_script(&shim_text).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "{} is not an npm or pnpm shim of a Node script, so it cannot be started",
                build.display()
            ),
        )
    })?;
    let shim_folder = build.parent().unwrap_or(Path::new(""));
    let beside_node = shim_folder.join("node.exe");
    let is_node_beside = match std::fs::metadata(&beside_node) {
        Ok(metadata) => metadata.is_file(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(error),
    };
    let program = if is_node_beside {
        beside_node
    } else {
        find_on_search_path("node").ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!(
                    "{} runs its script under Node, and no node is on its search path",
                    build.display()
                ),
            )
        })?
    };
    Ok(ProgramStart {
        program,
        leading_arguments: vec![shim_folder.join(script)],
    })
}

// The script an npm or pnpm command shim runs, relative to the shim's folder: the last one its
// text hands its arguments to, and only where the shim names a `node.exe`.
fn read_command_shim_script(shim_text: &str) -> Option<&str> {
    let script = SHIM_SCRIPT_PATTERN
        .captures_iter(shim_text)
        .last()?
        .get(1)?
        .as_str();
    SHIM_NODE_PATTERN.is_match(shim_text).then_some(script)
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::path::PathBuf;

    use rstest::rstest;

    use super::{program_start_with_rules, read_command_shim_script};
    use crate::path::rules::PathRules;

    const NPM_SHIM: &str = concat!(
        r#"@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "#,
        r#""%_prog%"  "%dp0%\node_modules\@example\tool\bin\tool.js" %*
"#
    );

    const PNPM_SHIM: &str = r#"@SETLOCAL
@IF NOT DEFINED NODE_PATH (
  @SET "NODE_PATH=%~dp0\..\@example\tool\node_modules"
)
@IF EXIST "%~dp0\node.exe" (
  "%~dp0\node.exe"  "%~dp0\..\@example\tool\bin\tool.js" %*
) ELSE (
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\..\@example\tool\bin\tool.js" %*
)
"#;

    // A shim that runs a setup script before the one it hands the caller's arguments to last.
    const TWO_SCRIPT_SHIM: &str = r#"@IF EXIST "%~dp0\node.exe" (
  "%~dp0\node.exe"  "%~dp0\setup\prepare.js" %*
  "%~dp0\node.exe"  "%~dp0\bin\cli.js" %*
)
"#;

    const NO_NODE_SHIM: &str = r#"@ECHO off
"%~dp0\runner.exe"  "%~dp0\scripts\task.js" %*
"#;

    // Kills: taking the first match (the two-script shim would read `setup\prepare.js`), and
    // dropping the Node check (the no-Node shim would read `scripts\task.js`).
    #[rstest]
    #[case::npm(NPM_SHIM, Some(r"node_modules\@example\tool\bin\tool.js"))]
    #[case::pnpm(PNPM_SHIM, Some(r"..\@example\tool\bin\tool.js"))]
    #[case::two_scripts(TWO_SCRIPT_SHIM, Some(r"bin\cli.js"))]
    #[case::no_node(NO_NODE_SHIM, None)]
    fn command_shim_script_is_the_node_script_the_shim_runs_last(
        #[case] shim_text: &str,
        #[case] expected: Option<&str>,
    ) {
        assert_eq!(read_command_shim_script(shim_text), expected);
    }

    // Kills: falling back to starting the shim itself when its text cannot be read, and turning
    // the read's own error into another.
    #[test]
    fn program_start_refuses_a_shim_it_cannot_read() {
        let folder = tempfile::tempdir().expect("the temporary folder is made");
        let missing_shim = folder.path().join("tool.cmd");

        let start = program_start_with_rules(PathRules::Windows, &missing_shim, |_| {
            Some(PathBuf::from("node"))
        });

        assert_eq!(
            start.expect_err("a missing shim is refused").kind(),
            io::ErrorKind::NotFound
        );
    }
}
