//! One process's conversation file as the goal reads follow it: found in its Claude Code home,
//! followed from where the process came up, the goal a resumed process restores read from it, and
//! the records a fork copied from its predecessor passed over. A process whose settings carry
//! `disableAllHooks` restores no goal.

use std::collections::HashSet;
use std::error::Error;
use std::io;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::Value;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_std::mutex_lock::lock;

use super::records::{GoalStatusRecord, goal_status_uuids_through, read_goal_status_tail};
use crate::driver::claude::session::conversation_file::conversation_file_of;
use crate::driver::claude::session::settings_file::{ClaudeSettingsSources, read_claude_setting};

// The settings key that turns off every hook, the goal's own check among them.
const CLAUDE_DISABLE_ALL_HOOKS_SETTING: &str = "disableAllHooks";

/// What one process's goal is read against: the session's lead, whose goal it is, and the
/// conversation file its outcomes are written to.
pub(crate) struct ClaudeProcessGoal {
    /// The session's lead.
    pub(crate) agent_id: AgentId,
    /// The conversation file, which only the session's task reads.
    pub(crate) file: Mutex<ClaudeGoalFile>,
}

/// The conversation a fork copies and the entry it copies it through.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ClaudeGoalFork<'fork> {
    /// The conversation forked.
    pub(crate) resume_handle: &'fork str,
    /// The entry the fork keeps the conversation up to.
    pub(crate) resume_at_message_uuid: &'fork str,
}

/// One process's conversation file as the goal reads follow it: where Claude Code keeps it, once
/// found, the offset the next read starts from, and the uuids of the records a fork copied that
/// no read has passed over yet.
#[derive(Debug)]
pub(crate) struct ClaudeGoalFile {
    spawn_environment: Vec<(String, String)>,
    provider_session_id: String,
    path: Option<PathBuf>,
    end: u64,
    copied_records: HashSet<String>,
}

impl ClaudeGoalFile {
    /// The file of conversation `provider_session_id` in the Claude Code home `spawn_environment`
    /// names, followed from its length as the process comes up, so what an earlier process wrote
    /// is never read again; one not yet written is followed from its start once it appears. A
    /// home that cannot be listed is logged, and the file looked for again at the next read.
    /// Beside it, the goal the process restores from the records already written, where the file
    /// exists and reads; a file that cannot be read is logged and restores none. A process whose
    /// `settings` carry `disableAllHooks` restores no goal, whatever its file holds; settings that
    /// cannot be read are logged and restore none. For a `fork`, the records its predecessor's
    /// file holds through the fork point are passed over when the fork's copy of them is read; a
    /// predecessor's file that cannot be found or read is logged, and its copies are read as they
    /// come.
    pub(crate) async fn open(
        spawn_environment: &[(String, String)],
        provider_session_id: &str,
        fork: Option<ClaudeGoalFork<'_>>,
        settings: &ClaudeSettingsSources<'_>,
    ) -> (Self, Option<RestoredGoal>) {
        let disables_all_hooks = read_claude_setting(
            settings,
            &[CLAUDE_DISABLE_ALL_HOOKS_SETTING],
            Value::as_bool,
        )
        .await
        .map(|setting| setting.is_some_and(|(_source, is_disabled)| is_disabled))
        .inspect_err(|failures| {
            tracing::warn!(
                provider_session_id,
                error = failures as &(dyn Error + 'static),
                "Claude Code's settings could not be read for the goal a resume restores"
            );
        })
        .ok();
        // The goal the settings leave the process with, whatever its file holds: none under
        // `disableAllHooks`, and nothing known where they could not be read.
        let restored_by_settings =
            || (disables_all_hooks == Some(true)).then_some(RestoredGoal { condition: None });
        let copied_records = match fork {
            Some(fork) => read_copied_records(spawn_environment, fork).await,
            None => HashSet::new(),
        };
        let mut file = Self {
            spawn_environment: spawn_environment.to_vec(),
            provider_session_id: provider_session_id.to_owned(),
            path: None,
            end: 0,
            copied_records,
        };
        let found = match conversation_file_of(spawn_environment, provider_session_id).await {
            Ok(found) => found,
            Err(error) => {
                report_unlocated(provider_session_id, &error);
                None
            }
        };
        let Some(path) = found else {
            return (file, restored_by_settings());
        };
        match tokio::fs::metadata(&path).await {
            Ok(metadata) => file.end = metadata.len(),
            Err(error) => {
                report_unlocated(provider_session_id, &error);
                return (file, restored_by_settings());
            }
        }
        if disables_all_hooks != Some(false) {
            file.path = Some(path);
            return (file, restored_by_settings());
        }
        let restored_goal = match read_goal_status_tail(&path, 0).await {
            Ok(tail) => Some(RestoredGoal {
                condition: restored_condition(tail.records),
            }),
            Err(error) => {
                report_unlocated(provider_session_id, &error);
                None
            }
        };
        file.path = Some(path);
        (file, restored_goal)
    }
}

/// The goal a resumed Claude Code process restores by itself from its conversation file.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct RestoredGoal {
    /// The active goal's condition, or `None` when the newest record ended or cleared it.
    pub(crate) condition: Option<String>,
}

// The uuids of the records `fork` copies, read from its predecessor's file through the fork
// point; Claude Code keeps each copy's uuid. None where that file cannot be found or read.
async fn read_copied_records(
    spawn_environment: &[(String, String)],
    fork: ClaudeGoalFork<'_>,
) -> HashSet<String> {
    let predecessor = conversation_file_of(spawn_environment, fork.resume_handle)
        .await
        .and_then(|found| {
            found.ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    "the forked conversation has no file",
                )
            })
        });
    let copied = match predecessor {
        Ok(path) => goal_status_uuids_through(&path, fork.resume_at_message_uuid).await,
        Err(error) => Err(error),
    };
    copied.unwrap_or_else(|error| {
        report_unlocated(fork.resume_handle, &error);
        HashSet::new()
    })
}

// Claude Code's own rule: the newest record holds the goal, unless it reads met or failed.
fn restored_condition(records: Vec<GoalStatusRecord>) -> Option<String> {
    records
        .into_iter()
        .next_back()
        .filter(|record| !record.is_met && !record.is_failed)
        .and_then(|record| record.condition)
}

fn report_unlocated(provider_session_id: &str, error: &io::Error) {
    tracing::warn!(
        provider_session_id,
        error = error as &(dyn Error + 'static),
        "Claude Code's conversation file could not be located for the goal reads"
    );
}

/// The records `file` gained since its last read, its offset moved past them, without those a
/// fork copied from its predecessor; the lock is never held across the read. Fails as the home
/// cannot be listed or the file read.
pub(crate) async fn read_new_records(
    file: &Mutex<ClaudeGoalFile>,
) -> io::Result<Vec<GoalStatusRecord>> {
    let (path, from, spawn_environment, provider_session_id) = {
        let file = lock(file);
        (
            file.path.clone(),
            file.end,
            file.spawn_environment.clone(),
            file.provider_session_id.clone(),
        )
    };
    let path = match path {
        Some(path) => path,
        None => match conversation_file_of(&spawn_environment, &provider_session_id).await? {
            Some(path) => path,
            None => return Ok(Vec::new()),
        },
    };
    let tail = read_goal_status_tail(&path, from).await?;
    let mut records = tail.records;
    let mut file = lock(file);
    file.path = Some(path);
    file.end = tail.end;
    // Each copy is passed over once, so the set empties as the fork's file catches up.
    records.retain(|record| {
        record
            .uuid
            .as_ref()
            .is_none_or(|uuid| !file.copied_records.remove(uuid))
    });
    Ok(records)
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use rstest::rstest;
    use serde_json::json;
    use sidekicks_platforms::PathRules;

    use super::{
        ClaudeGoalFile, ClaudeGoalFork, RestoredGoal, read_new_records, restored_condition,
    };
    use crate::driver::claude::goals::records::GoalStatusRecord;
    use crate::driver::claude::goals::records::tests::{append, goal_status_line, record};
    use crate::driver::claude::session::establishment::spawn_sources::claude_account_settings_file;
    use crate::driver::claude::session::rules::ClaudeProjectFolder;
    use crate::driver::claude::session::scripted::binding_id;
    use crate::driver::claude::session::scripted::driver::{ScriptedDriver, resume_params};
    use crate::driver::claude::session::settings_file::ClaudeSettingsSources;
    use crate::driver::test_registry::new_run_id;

    // Settings read from the account home's own file alone.
    fn person_settings_only<'a>(
        home: &'a Path,
        project: &'a Path,
        account_settings_file: &'a Path,
    ) -> ClaudeSettingsSources<'a> {
        ClaudeSettingsSources {
            managed_settings_folder: None,
            project_folder: ClaudeProjectFolder {
                working_folder: project,
                repository: None,
            },
            home_folder: home,
            account_settings_file,
            path_rules: PathRules::NATIVE,
        }
    }

    // Killed by reading the oldest record, by a met or failed record read as active, and by a clear
    // read as active; `unmet_check` by reading only a set's sentinel as active.
    #[rstest]
    #[case::set(vec![record(false, false, true, Some("c"))], Some("c"))]
    #[case::set_then_met(
        vec![record(false, false, true, Some("c")), record(true, false, false, Some("c"))],
        None
    )]
    #[case::set_then_cleared(
        vec![record(false, false, true, Some("c")), record(true, false, true, Some("c"))],
        None
    )]
    #[case::set_then_impossible(
        vec![record(false, false, true, Some("c")), record(false, true, false, Some("c"))],
        None
    )]
    #[case::set_then_another(
        vec![record(false, false, true, Some("c")), record(false, false, true, Some("d"))],
        Some("d")
    )]
    #[case::unmet_check(
        vec![record(false, false, true, Some("c")), record(false, false, false, Some("c"))],
        Some("c")
    )]
    #[case::no_record(Vec::new(), None)]
    fn a_resumed_process_restores_the_newest_goal_unless_it_ended(
        #[case] records: Vec<GoalStatusRecord>,
        #[case] restored: Option<&str>,
    ) {
        assert_eq!(restored_condition(records).as_deref(), restored);
    }

    // Killed by the fork's copies read as new, which would post the copied set's goal again, and by
    // the fork's own records passed over with them, which would lose its met check.
    #[tokio::test]
    async fn a_fork_reads_only_the_records_it_wrote_itself() {
        let home = tempfile::tempdir().expect("a scratch home");
        let project = home.path().join("projects/work");
        std::fs::create_dir_all(&project).expect("the project folder is made");
        let spawn_environment = vec![(
            "CLAUDE_CONFIG_DIR".to_owned(),
            home.path().display().to_string(),
        )];
        let set = goal_status_line(
            "set",
            json!({"met": false, "sentinel": true, "condition": "c"}),
        );
        let unmet = goal_status_line("unmet", json!({"met": false, "condition": "c"}));
        let fork_point = concat!(
            r#"{"type":"user","uuid":"at","message":{"content":"go"}}"#,
            "\n"
        );
        let predecessor = project.join("before.jsonl");
        for line in [set.as_str(), unmet.as_str(), fork_point] {
            append(&predecessor, line);
        }
        append(
            &predecessor,
            &goal_status_line("met-before", json!({"met": true, "condition": "c"})),
        );
        let fork = ClaudeGoalFork {
            resume_handle: "before",
            resume_at_message_uuid: "at",
        };
        let settings_file = claude_account_settings_file(&spawn_environment);
        let settings = person_settings_only(home.path(), &project, &settings_file);
        let (file, restored) =
            ClaudeGoalFile::open(&spawn_environment, "after", Some(fork), &settings).await;
        assert_eq!(restored, None);
        let file = Mutex::new(file);
        let forked = project.join("after.jsonl");

        append(&forked, &set);
        let first = read_new_records(&file)
            .await
            .expect("the fork's file reads");
        append(&forked, &unmet);
        append(&forked, fork_point);
        append(
            &forked,
            &goal_status_line("met", json!({"met": true, "condition": "c"})),
        );
        let second = read_new_records(&file)
            .await
            .expect("the fork's file reads");

        assert_eq!(first, Vec::new());
        assert_eq!(
            second,
            vec![GoalStatusRecord {
                uuid: Some("met".to_owned()),
                ..record(true, false, false, Some("c"))
            }]
        );
    }

    // Killed by the branch on `disableAllHooks` read as hooks on, which would restore the goal
    // Claude Code does not, and by that branch taken with no setting, which would restore none.
    #[rstest]
    #[case::hooks_disabled(Some(r#"{"disableAllHooks": true}"#), None)]
    #[case::hooks_on(None, Some("c"))]
    #[tokio::test]
    async fn a_saved_goal_is_restored_only_while_the_settings_leave_hooks_on(
        #[case] person_settings: Option<&str>,
        #[case] restored: Option<&str>,
    ) {
        let home = tempfile::tempdir().expect("a scratch home");
        let project = home.path().join("projects/work");
        std::fs::create_dir_all(&project).expect("the project folder is made");
        let spawn_environment = vec![(
            "CLAUDE_CONFIG_DIR".to_owned(),
            home.path().display().to_string(),
        )];
        append(
            &project.join("resumed.jsonl"),
            &goal_status_line(
                "set",
                json!({"met": false, "sentinel": true, "condition": "c"}),
            ),
        );
        let settings_file = claude_account_settings_file(&spawn_environment);
        if let Some(person_settings) = person_settings {
            std::fs::write(&settings_file, person_settings).expect("the settings are written");
        }
        let settings = person_settings_only(home.path(), &project, &settings_file);

        let (_file, restored_goal) =
            ClaudeGoalFile::open(&spawn_environment, "resumed", None, &settings).await;

        assert_eq!(
            restored_goal,
            Some(RestoredGoal {
                condition: restored.map(str::to_owned),
            })
        );
    }

    // Killed by the bring-up never seeding the goal the resumed process restored: the turn's
    // `result` with no record, nothing live and no interrupt would then draw nothing.
    #[tokio::test(start_paused = true)]
    async fn a_resumed_process_with_an_active_goal_draws_an_unfinished_check() {
        let fixture = ScriptedDriver::new();
        let session_id = fixture.closed_session_resumed_on(Arc::default()).await;
        let params = resume_params(session_id);
        let project = fixture.home.join(".claude/projects/work");
        std::fs::create_dir_all(&project).expect("the project folder is made");
        let set = json!({
            "type": "attachment",
            "attachment": {
                "type": "goal_status", "met": false, "sentinel": true, "condition": "ship it",
            },
        });
        std::fs::write(
            project.join(format!("{}.jsonl", params.resume_handle)),
            format!("{set}\n"),
        )
        .expect("the conversation is written");
        fixture
            .driver
            .resume_session(params)
            .await
            .expect("the resume answers");
        let start = fixture.next_start().await;
        fixture
            .driver
            .composed_parts()
            .expect("the pieces are composed")
            .run_start
            .routes
            .hold_turn(new_run_id(), session_id, binding_id("lead"))
            .expect("the session's turn is free");

        fixture.end_turn(&start, session_id);

        tokio::time::timeout(
            Duration::from_secs(10),
            fixture.engine.wait_until(|_| {
                fixture
                    .engine
                    .deliveries()
                    .into_iter()
                    .filter(|delivery| delivery.kind == "sessionNotice")
                    .filter_map(|delivery| delivery.payload)
                    .any(|row| row["kind"] == "goalCheckUnfinished")
                    .then_some(())
            }),
        )
        .await
        .expect("the unfinished check is noticed");
    }
}
