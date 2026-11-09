//! The malformed entries `claude doctor` reports Claude Code skipped while the rest of their file
//! loaded, which no `get_settings` reply names: one run in the background per distinct settings
//! content, in the session's folder on its build and home, its `Invalid settings` block read from
//! its output and kept by that content for the daemon's lifetime.

use std::collections::HashMap;
use std::error::Error;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use sidekicks_platforms::Spawner;
use sidekicks_std::mutex_lock::lock;

use super::ClaudeDroppedSetting;
use crate::driver::claude::session::rules::{
    CLAUDE_SHARED_SETTINGS_FILE, list_claude_local_settings_files, settings_path,
};
use crate::driver::claude::session::settings_file::{
    ClaudeSettingsSources, list_managed_settings_files,
};
use crate::driver::claude::spawn::one_shot_command::run_claude_one_shot;
use crate::driver::claude::terminal_text::strip_terminal_controls;
use crate::spawned_version::ResolvedProviderExecutable;

/// The arguments after the Claude Code command that print its checks.
const CLAUDE_DOCTOR_ARGUMENTS: [&str; 1] = ["doctor"];

/// How long one doctor run may take before it is ended; its checks take about 5.5 s.
const CLAUDE_DOCTOR_TIMEOUT: Duration = Duration::from_secs(60);

/// The line that opens the doctor's list of the settings it skipped.
const INVALID_SETTINGS_HEADING: &str = "Invalid settings";

/// What opens each entry of the list.
const ENTRY_MARKER: &str = "- ";

/// What parts an entry's place from Claude Code's words.
const PLACE_SEPARATOR: &str = ": ";

/// What parts an entry's file from its key.
const FILE_KEY_SEPARATOR: &str = " \u{203a} ";

/// One doctor reading, shared by every session on the same settings content.
pub(crate) type ClaudeDoctorReading = Shared<BoxFuture<'static, Arc<[ClaudeDroppedSetting]>>>;

/// The `claude doctor` reading of each distinct settings content, kept for the daemon's lifetime,
/// so every session on one content shares one run.
pub(crate) struct ClaudeDoctorReadings {
    spawner: Spawner,
    readings: Mutex<HashMap<blake3::Hash, ClaudeDoctorReading>>,
}

impl ClaudeDoctorReadings {
    /// No reading yet; each run starts on `spawner`.
    pub(crate) fn new(spawner: Spawner) -> Self {
        Self {
            spawner,
            readings: Mutex::default(),
        }
    }

    /// The entries `claude doctor` reports for the settings content `content`: the first reading
    /// of that content runs `executable`'s doctor in `working_folder` once, in the background, and
    /// every later reading of it, and every one while it runs, shares that run. A run that fails
    /// or passes its time limit is logged and reads as no entries.
    pub(crate) fn read(
        &self,
        content: blake3::Hash,
        executable: &Arc<ResolvedProviderExecutable>,
        working_folder: &Path,
    ) -> ClaudeDoctorReading {
        lock(&self.readings)
            .entry(content)
            .or_insert_with(|| {
                let spawner = self.spawner.clone();
                let executable = Arc::clone(executable);
                let working_folder = working_folder.to_path_buf();
                // Spawned, so the run finishes and is kept even when no session waits for it.
                let run = tokio::spawn(async move {
                    run_claude_doctor(&spawner, &executable, &working_folder).await
                });
                async move {
                    match run.await {
                        Ok(entries) => Arc::from(entries),
                        Err(error) => {
                            tracing::warn!(
                                error = &error as &(dyn Error + 'static),
                                "the claude doctor run ended before its report was read"
                            );
                            Arc::from([])
                        }
                    }
                }
                .boxed()
                .shared()
            })
            .clone()
    }
}

/// The settings content a session's Claude Code reads, as one hash: the build that reads it, then
/// each settings file `sources` names by its path and bytes, a file the daemon cannot read by its
/// path alone, as Claude Code reads it as absent. A managed drop-in folder that cannot be listed
/// adds no file, as it adds none to Claude Code's settings.
pub(crate) async fn hash_claude_settings_content(
    sources: &ClaudeSettingsSources<'_>,
    build: &Path,
) -> blake3::Hash {
    let mut files = Vec::new();
    if let Some(folder) = sources.managed_settings_folder {
        files.extend(list_managed_settings_files(folder, &mut Vec::new()).await);
    }
    files.extend(list_claude_local_settings_files(
        &sources.project_folder,
        sources.home_folder,
        sources.path_rules,
    ));
    files.push(settings_path(
        sources.project_folder.working_folder,
        CLAUDE_SHARED_SETTINGS_FILE,
    ));
    files.push(sources.account_settings_file.to_path_buf());
    let mut hasher = blake3::Hasher::new();
    // A path holds no NUL, so one ends each path.
    hasher.update(build.as_os_str().as_encoded_bytes());
    hasher.update(&[0]);
    for file in files {
        hasher.update(file.as_os_str().as_encoded_bytes());
        hasher.update(&[0]);
        if let Ok(bytes) = tokio::fs::read(&file).await {
            hasher.update(&bytes.len().to_le_bytes());
            hasher.update(&bytes);
        }
    }
    hasher.finalize()
}

// Runs the doctor and reads its block; a run that cannot start, cannot be waited for or passes
// its time limit is logged and reads as no entries. The doctor exits 0 whatever it found, so its
// exit is not read.
async fn run_claude_doctor(
    spawner: &Spawner,
    executable: &ResolvedProviderExecutable,
    working_folder: &Path,
) -> Vec<ClaudeDroppedSetting> {
    let ran = tokio::time::timeout(
        CLAUDE_DOCTOR_TIMEOUT,
        run_claude_one_shot(
            spawner,
            executable,
            &CLAUDE_DOCTOR_ARGUMENTS,
            working_folder,
            true,
            false,
        ),
    )
    .await;
    match ran {
        Ok(Ok(ended)) => read_invalid_settings(ended.output.as_deref().unwrap_or_default()),
        Ok(Err(error)) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "claude doctor did not run, so the settings entries it reports go unreported"
            );
            Vec::new()
        }
        Err(_) => {
            tracing::warn!(
                "claude doctor ran past its time limit and was ended, so the settings entries it \
                 reports go unreported"
            );
            Vec::new()
        }
    }
}

// The entries of the doctor's `Invalid settings` block in `output`, each line read as a terminal
// shows it: `- <file> › <key>: <words>` for one key, `- <file>: <words>` for a whole file. A
// suggestion under an entry is passed over, and the block ends at its first blank line.
fn read_invalid_settings(output: &str) -> Vec<ClaudeDroppedSetting> {
    let mut lines = output
        .lines()
        .map(|line| strip_terminal_controls(line.as_bytes()));
    if !lines.any(|line| line == INVALID_SETTINGS_HEADING) {
        return Vec::new();
    }
    lines
        .take_while(|line| !line.is_empty())
        .filter_map(|line| read_entry(line.strip_prefix(ENTRY_MARKER)?))
        .collect()
}

// One entry after its marker; `None` for one naming no place.
fn read_entry(entry: &str) -> Option<ClaudeDroppedSetting> {
    let (place, message) = entry.split_once(PLACE_SEPARATOR)?;
    let (file, key) = place.split_once(FILE_KEY_SEPARATOR).unwrap_or((place, ""));
    Some(ClaudeDroppedSetting {
        file: file.to_owned(),
        key: key.to_owned(),
        message: message.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sidekicks_platforms::{
        ProgramStart, Spawner, StandInAnswer, StandInProgram, read_recorded_arguments,
        write_stand_in_program,
    };
    use tokio::runtime::Handle;

    use super::ClaudeDoctorReadings;
    use crate::driver::claude::session::ignored_settings::ClaudeDroppedSetting;
    use crate::spawned_version::ResolvedProviderExecutable;

    // The block as Claude Code 2.1.319 printed it under a private home, between its other checks.
    const DOCTOR_OUTPUT: &str = "Claude Code doctor\n\nRunning: native (2.1.319)\n\n\
        Invalid settings\n\
        - /home/project/.claude/settings.json \u{203a} permissions.allow: Invalid permission rule \
        \"Bash(foo\" was skipped: Malformed Tool(content) rule.\n  \
        Suggested fix: Rules take the form Tool or Tool(content)\n\
        - /home/project/.claude/settings.local.json: Invalid or malformed JSON\n\n\
        Remote Control\n- Not signed in to claude.ai\n";

    // Two sessions on one settings content read the doctor's block from one run. Killed by a
    // reading kept by anything but its content, which runs the doctor twice, and by a block read
    // past its blank line, which takes the Remote Control line as an entry.
    #[tokio::test]
    async fn one_doctor_run_serves_two_sessions_on_the_same_settings() {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let record = folder.path().join("arguments");
        let program = write_stand_in_program(
            folder.path(),
            "claude",
            &StandInProgram {
                answers_by_first_argument: Vec::new(),
                otherwise: StandInAnswer {
                    standard_output: DOCTOR_OUTPUT.to_owned(),
                    exit_code: 0,
                    argument_record: Some(record.clone()),
                    first_call_delay: None,
                },
            },
        )
        .expect("the stand-in is written");
        let executable = Arc::new(ResolvedProviderExecutable {
            requested_command: "claude".to_owned(),
            resolved_executable_path: program.clone(),
            start: ProgramStart {
                program,
                leading_arguments: Vec::new(),
            },
            environment: Vec::new(),
        });
        let readings =
            ClaudeDoctorReadings::new(Spawner::new(Handle::current()).expect("a spawner starts"));
        let content = blake3::hash(b"one settings content");

        let (first, second) = tokio::join!(
            readings.read(content, &executable, folder.path()),
            readings.read(content, &executable, folder.path()),
        );
        let later = readings.read(content, &executable, folder.path()).await;

        let expected: Arc<[ClaudeDroppedSetting]> = Arc::from([
            ClaudeDroppedSetting {
                file: "/home/project/.claude/settings.json".to_owned(),
                key: "permissions.allow".to_owned(),
                message: "Invalid permission rule \"Bash(foo\" was skipped: Malformed \
                          Tool(content) rule."
                    .to_owned(),
            },
            ClaudeDroppedSetting {
                file: "/home/project/.claude/settings.local.json".to_owned(),
                key: String::new(),
                message: "Invalid or malformed JSON".to_owned(),
            },
        ]);
        assert_eq!((&first, &second, &later), (&expected, &expected, &expected));
        let runs = read_recorded_arguments(&record)
            .expect("the stand-in recorded its calls")
            .into_iter()
            .filter(|argument| argument == "doctor")
            .count();
        assert_eq!(runs, 1);
    }
}
