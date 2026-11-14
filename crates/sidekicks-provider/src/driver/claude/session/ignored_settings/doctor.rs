//! The malformed entries `claude doctor` reports Claude Code skipped while the rest of their file
//! loaded, which no `get_settings` reply names: one run at a time in the daemon, in the session's
//! folder on its build and home, its `Invalid settings` block read from its output and kept, for
//! each set of settings files an open session reads, for the newest content alone.

use std::collections::HashMap;
use std::error::Error;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use sidekicks_contracts::session::id::SessionId;
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

/// One doctor reading, shared by every session on the same settings content; `None` where a newer
/// content of the same files was asked for before its run began, so it never ran.
pub(crate) type ClaudeDoctorReading =
    Shared<BoxFuture<'static, Option<Arc<[ClaudeDroppedSetting]>>>>;

/// The settings a session's Claude Code reads: which files, as one hash of their paths, and what
/// they hold, as one hash of the build that reads them and each file's bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeSettingsContent {
    /// The files, by path.
    pub(crate) files: blake3::Hash,
    /// The build and what the files hold.
    pub(crate) content: blake3::Hash,
}

/// The `claude doctor` readings: one run at a time in the daemon, each waiting run of a set of
/// files replaced by a newer content of them, and only each set's newest reading kept while an
/// open session reads that set, so every session on one content shares one run and the map holds
/// at most one reading per open session.
pub(crate) struct ClaudeDoctorReadings {
    spawner: Spawner,
    // Held across each run; tokio's lock hands it on in the order it was asked for.
    run_turn: Arc<tokio::sync::Mutex<()>>,
    newest: Arc<Mutex<ClaudeNewestDoctorReadings>>,
}

/// Each set of files' newest reading, by the order it was asked for, and the set each open session
/// last asked a reading of.
#[derive(Default)]
struct ClaudeNewestDoctorReadings {
    asked: u64,
    by_files: HashMap<blake3::Hash, ClaudeNewestDoctorReading>,
    files_of_session: HashMap<SessionId, blake3::Hash>,
}

impl ClaudeNewestDoctorReadings {
    // Marks `session_id` a reader of `files`, dropping the reading of the set it read before where
    // no other session reads that one.
    fn note_reader(&mut self, session_id: SessionId, files: blake3::Hash) {
        if let Some(earlier) = self.files_of_session.insert(session_id, files)
            && earlier != files
        {
            self.drop_unread(earlier);
        }
    }

    // Drops `files`' reading where no open session reads that set.
    fn drop_unread(&mut self, files: blake3::Hash) {
        if !self.files_of_session.values().any(|read| *read == files) {
            self.by_files.remove(&files);
        }
    }
}

/// A set of files' newest reading: of which content, its place in the order asked, and the run.
struct ClaudeNewestDoctorReading {
    content: blake3::Hash,
    asked: u64,
    reading: ClaudeDoctorReading,
}

impl ClaudeDoctorReadings {
    /// No reading yet; each run starts on `spawner`.
    pub(crate) fn new(spawner: Spawner) -> Self {
        Self {
            spawner,
            run_turn: Arc::default(),
            newest: Arc::default(),
        }
    }

    /// The entries `claude doctor` reports for `settings`, which `session_id` reads: a content not
    /// yet read runs `executable`'s doctor in `working_folder` in the background once the runs
    /// before it ended, unless a newer content of the same files is asked for first or no open
    /// session reads those files any longer, and every later reading of it, and every one while it
    /// waits or runs, shares that run. A run that fails or passes its time limit is logged and
    /// reads as no entries.
    pub(crate) fn read(
        &self,
        session_id: SessionId,
        settings: ClaudeSettingsContent,
        executable: &Arc<ResolvedProviderExecutable>,
        working_folder: &Path,
    ) -> ClaudeDoctorReading {
        let mut newest = lock(&self.newest);
        newest.note_reader(session_id, settings.files);
        if let Some(held) = newest.by_files.get(&settings.files)
            && held.content == settings.content
        {
            return held.reading.clone();
        }
        newest.asked += 1;
        let asked = newest.asked;
        let spawner = self.spawner.clone();
        let executable = Arc::clone(executable);
        let working_folder = working_folder.to_path_buf();
        let run_turn = Arc::clone(&self.run_turn);
        let newest_readings = Arc::clone(&self.newest);
        // Spawned, so the run finishes and is kept even when no session waits for it.
        let run = tokio::spawn(async move {
            let _turn = run_turn.lock().await;
            // A set no open session reads any longer has no reading to replace it.
            let is_replaced = lock(&newest_readings)
                .by_files
                .get(&settings.files)
                .is_none_or(|held| held.asked > asked);
            if is_replaced {
                return None;
            }
            Some(run_claude_doctor(&spawner, &executable, &working_folder).await)
        });
        let reading = async move {
            match run.await {
                Ok(entries) => entries.map(Arc::from),
                Err(error) => {
                    tracing::warn!(
                        error = &error as &(dyn Error + 'static),
                        "the claude doctor run ended before its report was read"
                    );
                    Some(Arc::from([]))
                }
            }
        }
        .boxed()
        .shared();
        newest.by_files.insert(
            settings.files,
            ClaudeNewestDoctorReading {
                content: settings.content,
                asked,
                reading: reading.clone(),
            },
        );
        reading
    }

    /// Forgets the closed session `session_id`, dropping the reading of its set of files where no
    /// other open session reads that set.
    pub(crate) fn forget_session(&self, session_id: SessionId) {
        let mut newest = lock(&self.newest);
        if let Some(files) = newest.files_of_session.remove(&session_id) {
            newest.drop_unread(files);
        }
    }
}

/// The settings a session's Claude Code reads: each settings file `sources` names by its path,
/// and as content the build that reads them, then each file by its path and bytes, a file the
/// daemon cannot read by its path alone, as Claude Code reads it as absent. A managed drop-in
/// folder that cannot be listed adds no file, as it adds none to Claude Code's settings.
pub(crate) async fn hash_claude_settings_content(
    sources: &ClaudeSettingsSources<'_>,
    build: &Path,
) -> ClaudeSettingsContent {
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
    let mut paths = blake3::Hasher::new();
    let mut content = blake3::Hasher::new();
    // A path holds no NUL, so one ends each path.
    content.update(build.as_os_str().as_encoded_bytes());
    content.update(&[0]);
    for file in files {
        for hasher in [&mut paths, &mut content] {
            hasher.update(file.as_os_str().as_encoded_bytes());
            hasher.update(&[0]);
        }
        if let Ok(bytes) = tokio::fs::read(&file).await {
            content.update(&bytes.len().to_le_bytes());
            content.update(&bytes);
        }
    }
    ClaudeSettingsContent {
        files: paths.finalize(),
        content: content.finalize(),
    }
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
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::Duration;

    use sidekicks_platforms::{
        ProgramStart, Spawner, StandInAnswer, StandInProgram, read_recorded_arguments,
        write_stand_in_program,
    };
    use tokio::runtime::Handle;

    use super::{ClaudeDoctorReadings, ClaudeSettingsContent};
    use crate::driver::claude::session::ignored_settings::ClaudeDroppedSetting;
    use crate::driver::test_registry::new_session_id;
    use crate::spawned_version::ResolvedProviderExecutable;

    // The block as Claude Code 2.1.319 printed it under a private home, between its other checks.
    const DOCTOR_OUTPUT: &str = "Claude Code doctor\n\nRunning: native (2.1.319)\n\n\
        Invalid settings\n\
        - /home/project/.claude/settings.json \u{203a} permissions.allow: Invalid permission rule \
        \"Bash(foo\" was skipped: Malformed Tool(content) rule.\n  \
        Suggested fix: Rules take the form Tool or Tool(content)\n\
        - /home/project/.claude/settings.local.json: Invalid or malformed JSON\n\n\
        Remote Control\n- Not signed in to claude.ai\n";

    // A stand-in doctor in `folder` printing `DOCTOR_OUTPUT`, its first call waiting
    // `first_call_wait`, and the file its calls' arguments are recorded in.
    fn stand_in_doctor(
        folder: &Path,
        first_call_wait: Option<Duration>,
    ) -> (Arc<ResolvedProviderExecutable>, PathBuf) {
        let record = folder.join("arguments");
        let program = write_stand_in_program(
            folder,
            "claude",
            &StandInProgram {
                answers_by_first_argument: Vec::new(),
                otherwise: StandInAnswer {
                    standard_output: DOCTOR_OUTPUT.to_owned(),
                    exit_code: 0,
                    argument_record: Some(record.clone()),
                },
                first_call_wait,
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
        (executable, record)
    }

    fn count_runs(record: &Path) -> usize {
        read_recorded_arguments(record)
            .expect("the stand-in recorded its calls")
            .into_iter()
            .filter(|argument| argument == "doctor")
            .count()
    }

    fn settings(content: &[u8]) -> ClaudeSettingsContent {
        ClaudeSettingsContent {
            files: blake3::hash(b"one set of settings files"),
            content: blake3::hash(content),
        }
    }

    // Two sessions on one settings content read the doctor's block from one run. Killed by a
    // reading kept by anything but its content, which runs the doctor twice, and by a block read
    // past its blank line, which takes the Remote Control line as an entry.
    #[tokio::test]
    async fn one_doctor_run_serves_two_sessions_on_the_same_settings() {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let (executable, record) = stand_in_doctor(folder.path(), None);
        let readings =
            ClaudeDoctorReadings::new(Spawner::new(Handle::current()).expect("a spawner starts"));
        let content = settings(b"one settings content");
        let session_id = new_session_id();

        let (first, second) = tokio::join!(
            readings.read(session_id, content, &executable, folder.path()),
            readings.read(session_id, content, &executable, folder.path()),
        );
        let later = readings
            .read(session_id, content, &executable, folder.path())
            .await;

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
        let expected = Some(expected);
        assert_eq!((&first, &second, &later), (&expected, &expected, &expected));
        assert_eq!(count_runs(&record), 1);
    }

    // A burst of settings contents asked while a run is going starts nothing beside it and runs,
    // once it ends, the newest content alone; the contents it replaced never run. Killed by runs
    // that do not wait for each other, which ends the newest while the first still runs, by a
    // waiting run that is not replaced, which runs the doctor more than twice, and by a reading
    // kept beside the newest, which serves the first content from the map again.
    #[tokio::test]
    async fn a_burst_of_settings_changes_runs_one_doctor_at_a_time_and_only_the_newest_next() {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let (executable, record) =
            stand_in_doctor(folder.path(), Some(Duration::from_millis(1500)));
        let readings =
            ClaudeDoctorReadings::new(Spawner::new(Handle::current()).expect("a spawner starts"));
        let first_call = folder.path().join("claude.first-call");
        let session_id = new_session_id();

        let first = readings.read(session_id, settings(b"first"), &executable, folder.path());
        while !first_call.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let replaced = [b"second".as_slice(), b"third"].map(|content| {
            readings.read(session_id, settings(content), &executable, folder.path())
        });
        let newest = readings.read(session_id, settings(b"newest"), &executable, folder.path());

        assert!(
            tokio::time::timeout(Duration::from_millis(300), newest.clone())
                .await
                .is_err(),
            "the newest run waits for the first to end"
        );
        assert!(first.await.is_some());
        for reading in replaced {
            assert_eq!(reading.await, None);
        }
        assert!(newest.await.is_some());
        assert_eq!(count_runs(&record), 2);
        assert!(
            readings
                .read(session_id, settings(b"first"), &executable, folder.path())
                .await
                .is_some()
        );
        assert_eq!(count_runs(&record), 3);
    }
}
