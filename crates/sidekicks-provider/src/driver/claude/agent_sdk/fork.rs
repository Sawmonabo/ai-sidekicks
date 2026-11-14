//! The fork of a Claude Code conversation up to one of its entries, made by the Agent SDK's own
//! `forkSession` run under bun in a config folder of the daemon's own that holds only a copy of
//! the source conversation, so the one file the SDK writes there is the fork, which is copied
//! beside its source once the fork answers and is otherwise removed with that folder.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use sidekicks_platforms::{PathRules, Spawner};
use sidekicks_std::child_run::ChildRunError;
use sidekicks_std::file::clone_or_copy::clone_or_copy;
use tokio_util::task::TaskTracker;
use uuid::Uuid;

use super::{AgentSdkModule, SDK_FILE_NAME};
use crate::program_run::{ProgramRunRequest, run_program_to_end};
use crate::spawn_environment::remove_environment_prefixes;

// Takes every input from its arguments, so none is ever read as code; sets the config folder
// before the SDK loads, and imports the SDK by file URL, since an absolute Windows path is no
// module specifier. A refusal exits 1 with its message alone on standard error.
const FORK_SCRIPT: &str = r#"try { const [sdk, configFolder, sessionId, upToMessageId, title] = process.argv.slice(1); process.env.CLAUDE_CONFIG_DIR = configFolder; const { pathToFileURL } = await import("node:url"); const { forkSession } = await import(pathToFileURL(sdk).href); const forked = await forkSession(sessionId, { upToMessageId, title }); process.stdout.write(JSON.stringify({ sessionId: forked.sessionId })); } catch (error) { process.stderr.write(String(error?.message ?? error)); process.exit(1); }"#;

// A small conversation's fork answers in well under a second, and a hung bun is still ended.
const FORK_DEADLINE_FLOOR: Duration = Duration::from_secs(60);

// The SDK reads the whole conversation file; this allows several times its read rate on a busy
// machine, so no healthy fork of a large conversation is cut.
const FORK_DEADLINE_PER_MIB: Duration = Duration::from_millis(500);

// The answer is one short line, a refusal one message.
const FORK_OUTPUT_BOUND: usize = 64 * 1024;

// The fork needs no bun or Node setting of the person's, and such settings run code, connect out
// to a debugger or write a cache.
const WITHHELD_PREFIXES: &[&str] = &["BUN_", "NODE_"];

// Turned off, so importing the SDK's file writes no transpiler cache in the home.
const TRANSPILER_CACHE_VARIABLE: &str = "BUN_RUNTIME_TRANSPILER_CACHE_PATH";
const TRANSPILER_CACHE_OFF: &str = "0";

// The extension of a conversation's file, which the fork's file shares.
const CONVERSATION_FILE_EXTENSION: &str = "jsonl";

// The folder of a config folder that holds one folder per project, which the SDK searches for the
// source conversation when it is named no project, and the one project folder the fork's own
// config folder holds.
const PROJECTS_FOLDER_NAME: &str = "projects";
const FORK_PROJECT_FOLDER_NAME: &str = "project";

// The title Claude Code keeps beside a conversation, in a folder named as it is, which the SDK
// names an untitled fork after.
const TITLE_FILE_NAME: &str = "custom-title.json";

/// One fork of a Claude Code conversation: whose, up to which entry, under which title.
pub(crate) struct ClaudeForkRequest {
    /// The session's spawn environment, which the fork runs in less every bun and Node setting.
    pub(crate) environment: Vec<(String, String)>,
    /// A path where nothing stands yet, in a folder of the daemon's own: the fork makes its own
    /// config folder there and removes it whole on every exit.
    pub(crate) work_folder: PathBuf,
    /// The folder holding the source conversation's file, where the fork's file is put.
    pub(crate) project_folder: PathBuf,
    /// The conversation forked.
    pub(crate) source_conversation_id: String,
    /// The last entry the fork keeps.
    pub(crate) entry_id: String,
    /// The fork's title; an empty one names it after its source.
    pub(crate) title: String,
    /// The length of the source conversation file, in bytes, which sets the fork's deadline.
    pub(crate) source_bytes: u64,
}

/// Why a fork answered no conversation.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudeForkError {
    /// The fork's own config folder could not be made, or the source conversation could not be
    /// copied into it.
    #[error("the source conversation could not be copied into the fork's own folder")]
    Staging(#[source] io::Error),
    /// The fork's file could not be copied beside its source; nothing is left there.
    #[error("the fork's conversation file could not be put beside its source")]
    Publishing(#[source] io::Error),
    /// bun could not be started, its output could not be read or passed its bound, or it did not
    /// exit within the fork's deadline.
    #[error("the Agent SDK's fork did not run to its end")]
    Run(#[source] ChildRunError),
    /// bun exited with a failure; `message` is its standard error, the SDK's refusal.
    #[error("the Agent SDK refused the fork: {message}")]
    Refused {
        /// What bun wrote on standard error, read as UTF-8 with replacement.
        message: String,
    },
    /// bun exited 0 without answering a conversation id in the form the SDK names a fork's file.
    #[error("the Agent SDK's fork answered no conversation id")]
    UnreadableAnswer,
}

// What the fork's script prints once the SDK has written the fork.
#[derive(Deserialize)]
struct ForkAnswer {
    #[serde(rename = "sessionId")]
    session_id: String,
}

/// The fork's conversation id, exactly as the SDK named the fork's file, which then stands in the
/// project folder beside its source, or why there is none. Runs the SDK in `module` under the bun
/// at `bun`, in a config folder made at the request's work folder that holds only a copy of the
/// source conversation and its title, so the SDK writes nothing anywhere else; the caller bounds
/// its own waits for both. That folder is removed once the fork's processes have ended, whatever
/// the fork answered, so a fork that fails leaves no file, and no file of the project folder is
/// touched but the new one.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the undo's fork before Claude Code's last compaction runs it"
    )
)]
pub(crate) async fn fork_claude_conversation(
    spawner: &Spawner,
    bun: &Path,
    module: &AgentSdkModule,
    request: ClaudeForkRequest,
) -> Result<String, ClaudeForkError> {
    let work_folder = request.work_folder.clone();
    // A folder that stood already is not the fork's own, so it is never filled or removed.
    tokio::fs::create_dir(&work_folder)
        .await
        .map_err(ClaudeForkError::Staging)?;
    let forked = fork_in_work_folder(spawner, bun, module, request).await;
    if let Err(error) = tokio::fs::remove_dir_all(&work_folder).await {
        tracing::error!(
            error = &error as &(dyn std::error::Error + 'static),
            folder = %work_folder.display(),
            "a fork's own config folder could not be removed"
        );
    }
    forked
}

// The fork made in the request's work folder, once its processes have ended, and its file put
// beside its source.
async fn fork_in_work_folder(
    spawner: &Spawner,
    bun: &Path,
    module: &AgentSdkModule,
    request: ClaudeForkRequest,
) -> Result<String, ClaudeForkError> {
    let deadline = fork_deadline(request.source_bytes);
    let fork_project = request
        .work_folder
        .join(PROJECTS_FOLDER_NAME)
        .join(FORK_PROJECT_FOLDER_NAME);
    let project_folder = request.project_folder.clone();
    copy_source(
        project_folder.clone(),
        fork_project.clone(),
        request.source_conversation_id.clone(),
    )
    .await
    .map_err(ClaudeForkError::Staging)?;
    let tree_ends = TaskTracker::new();
    let forked = run_fork(
        spawner,
        fork_run_request(bun, module, request),
        deadline,
        &tree_ends,
    )
    .await;
    // A failed run's processes are ended on a task of their own; none writes once it is done.
    tree_ends.close();
    tree_ends.wait().await;
    let fork_id = forked?;
    let file_name = conversation_file_name(&fork_id);
    let (forked_file, placed_file) = (
        fork_project.join(&file_name),
        project_folder.join(&file_name),
    );
    // Never over a file already there, and a failed copy leaves nothing at the name.
    tokio::task::spawn_blocking(move || clone_or_copy(&forked_file, &placed_file))
        .await
        .map_err(|error| ClaudeForkError::Publishing(io::Error::other(error)))?
        .map_err(ClaudeForkError::Publishing)?;
    Ok(fork_id)
}

// Copies the source conversation's file from `project_folder` into `fork_project`, made with its
// parents, with the title Claude Code keeps beside it where there is one.
async fn copy_source(
    project_folder: PathBuf,
    fork_project: PathBuf,
    source_conversation_id: String,
) -> io::Result<()> {
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&fork_project)?;
        let file_name = conversation_file_name(&source_conversation_id);
        clone_or_copy(
            &project_folder.join(&file_name),
            &fork_project.join(&file_name),
        )?;
        let title = project_folder
            .join(&source_conversation_id)
            .join(TITLE_FILE_NAME);
        let fork_title_folder = fork_project.join(&source_conversation_id);
        std::fs::create_dir(&fork_title_folder)?;
        match clone_or_copy(&title, &fork_title_folder.join(TITLE_FILE_NAME)) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            copied => copied,
        }
    })
    .await
    .map_err(io::Error::other)?
}

// The name of the file Claude Code keeps conversation `conversation_id` in.
fn conversation_file_name(conversation_id: &str) -> String {
    format!("{conversation_id}.{CONVERSATION_FILE_EXTENSION}")
}

// The fork run to its end and its answer read.
async fn run_fork(
    spawner: &Spawner,
    run: ProgramRunRequest,
    deadline: Duration,
    tree_ends: &TaskTracker,
) -> Result<String, ClaudeForkError> {
    let output = run_program_to_end(spawner, run, deadline, FORK_OUTPUT_BOUND, Some(tree_ends))
        .await
        .map_err(ClaudeForkError::Run)?;
    if !output.status.success() {
        return Err(ClaudeForkError::Refused {
            message: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    read_fork_answer(&output.stdout).ok_or(ClaudeForkError::UnreadableAnswer)
}

// bun with every input an argument after `--`, the work folder as Claude Code's config folder, run
// in the SDK's own folder, which holds no `bunfig.toml` or `.env`, with every bun and Node setting
// withheld and the transpiler cache off.
fn fork_run_request(
    bun: &Path,
    module: &AgentSdkModule,
    request: ClaudeForkRequest,
) -> ProgramRunRequest {
    let mut environment = request.environment;
    remove_environment_prefixes(&mut environment, WITHHELD_PREFIXES, PathRules::NATIVE);
    environment.push((
        TRANSPILER_CACHE_VARIABLE.to_owned(),
        TRANSPILER_CACHE_OFF.to_owned(),
    ));
    // The two inputs bun may drop a `--` in place of are paths the daemon makes.
    let arguments: Vec<OsString> = vec![
        "--no-env-file".into(),
        "--no-install".into(),
        "-e".into(),
        FORK_SCRIPT.into(),
        "--".into(),
        module.folder.join(SDK_FILE_NAME).into_os_string(),
        request.work_folder.into_os_string(),
        request.source_conversation_id.into(),
        request.entry_id.into(),
        request.title.into(),
    ];
    ProgramRunRequest {
        program: bun.to_path_buf(),
        arguments,
        environment,
        working_folder: Some(module.folder.clone()),
    }
}

// The floor and the allowance for each MiB of the source file, a part MiB counted whole.
fn fork_deadline(source_bytes: u64) -> Duration {
    let mebibytes = u32::try_from(source_bytes.div_ceil(1024 * 1024)).unwrap_or(u32::MAX);
    FORK_DEADLINE_FLOOR.saturating_add(FORK_DEADLINE_PER_MIB.saturating_mul(mebibytes))
}

// The fork's id when the script printed one in the hyphenated lowercase form `randomUUID` gives,
// the one the fork's file is named by, answered exactly as written.
fn read_fork_answer(stdout: &[u8]) -> Option<String> {
    let answer: ForkAnswer = serde_json::from_slice(stdout).ok()?;
    let parsed = Uuid::parse_str(&answer.session_id).ok()?;
    (parsed.hyphenated().to_string() == answer.session_id).then_some(answer.session_id)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};

    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_platforms::{Spawner, StandInAnswer, StandInProgram, write_stand_in_program};
    use uuid::Uuid;

    use super::{
        AgentSdkModule, ClaudeForkError, ClaudeForkRequest, FORK_SCRIPT, fork_claude_conversation,
        fork_run_request,
    };

    const SOURCE_ID: &str = "5b0c5a0e-6f2a-4d47-9a8e-0f6c2d1e3b4a";
    const FORK_ID: &str = "084ec445-d4d4-48cc-a100-566217f0a468";

    fn pairs(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect()
    }

    // Killed by an input spliced into the script, by an input before `--`, by any one of
    // `BUN_OPTIONS`, `BUN_INSPECT_PRELOAD`, `NODE_COMPILE_CACHE` or `NODE_PATH` kept, by the
    // person's cache path kept in place of `0`, and by no working folder.
    #[test]
    fn the_forks_inputs_reach_bun_only_as_arguments_and_no_bun_or_node_setting_rides_along() {
        let folder = tempfile::tempdir().expect("the module folder is made");
        let module = AgentSdkModule {
            folder: folder.path().to_path_buf(),
        };
        let title = r#"x"); process.exit(9); (""#;
        let request = ClaudeForkRequest {
            environment: pairs(&[
                ("PATH", "/usr/bin:/bin"),
                ("HOME", "/home/person"),
                ("BUN_OPTIONS", "--preload /home/person/trap.js"),
                ("BUN_INSPECT_PRELOAD", "/home/person/trap.js"),
                ("BUN_RUNTIME_TRANSPILER_CACHE_PATH", "/elsewhere"),
                ("NODE_COMPILE_CACHE", "/home/person/compile-cache"),
                ("NODE_PATH", "/home/person/modules"),
            ]),
            work_folder: PathBuf::from("/daemon/forks/fork-1"),
            project_folder: PathBuf::from("/home/person/.claude/projects/-project"),
            source_conversation_id: SOURCE_ID.to_owned(),
            entry_id: "-e".to_owned(),
            title: title.to_owned(),
            source_bytes: 0,
        };

        let run = fork_run_request(Path::new("/opt/bun/bun"), &module, request);

        assert_eq!(run.program, Path::new("/opt/bun/bun"));
        let expected: Vec<OsString> = vec![
            "--no-env-file".into(),
            "--no-install".into(),
            "-e".into(),
            FORK_SCRIPT.into(),
            "--".into(),
            folder.path().join("sdk.mjs").into_os_string(),
            "/daemon/forks/fork-1".into(),
            SOURCE_ID.into(),
            "-e".into(),
            title.into(),
        ];
        assert_eq!(run.arguments, expected);
        assert_eq!(
            run.environment,
            pairs(&[
                ("PATH", "/usr/bin:/bin"),
                ("HOME", "/home/person"),
                ("BUN_RUNTIME_TRANSPILER_CACHE_PATH", "0"),
            ])
        );
        assert_eq!(run.working_folder.as_deref(), Some(folder.path()));
    }

    // What a fork's run answers.
    #[derive(Debug)]
    enum ForkOutcome {
        Answered(&'static str),
        Refused,
        UnreadableAnswer,
    }

    // A fork's answer, and what it leaves: its file beside its source when it answered, and
    // nothing at all when it failed, though the stand-in bun wrote a fork's file as the SDK does,
    // no file of the project folder touched and the fork's own folder gone either way. Killed by
    // accepting an id that is no UUID, by answering a normalized id in place of the one written,
    // by reading a failed run's output as its answer, by reading exit 1 as an unreadable answer,
    // by the fork made in the project folder, by its file kept after a failure, and by its own
    // folder left behind.
    #[rstest]
    #[case::answered(
        r#"{"sessionId":"084ec445-d4d4-48cc-a100-566217f0a468"}"#,
        0,
        ForkOutcome::Answered(FORK_ID)
    )]
    #[case::refused("", 1, ForkOutcome::Refused)]
    #[case::answer_on_a_failure(
        r#"{"sessionId":"084ec445-d4d4-48cc-a100-566217f0a468"}"#,
        1,
        ForkOutcome::Refused
    )]
    #[case::not_json("forked", 0, ForkOutcome::UnreadableAnswer)]
    #[case::not_a_uuid(r#"{"sessionId":"fork-1"}"#, 0, ForkOutcome::UnreadableAnswer)]
    #[case::not_as_written(
        r#"{"sessionId":"084EC445-D4D4-48CC-A100-566217F0A468"}"#,
        0,
        ForkOutcome::UnreadableAnswer
    )]
    #[tokio::test]
    async fn a_fork_answers_its_conversation_beside_its_source_or_leaves_no_file(
        #[case] standard_output: &str,
        #[case] exit_code: u8,
        #[case] expected: ForkOutcome,
    ) {
        let scratch = tempfile::tempdir().expect("the scratch folder is made");
        let project = scratch.path().join("projects").join("-project");
        std::fs::create_dir_all(project.join("other")).expect("the project folder is made");
        let source = project.join(format!("{SOURCE_ID}.jsonl"));
        std::fs::write(&source, "{}\n").expect("the source conversation is written");
        std::fs::write(project.join("other").join("notes.md"), "kept")
            .expect("another file is written");
        let before: BTreeSet<(PathBuf, Vec<u8>)> = list_files(&project)
            .into_iter()
            .map(|file| {
                let bytes = std::fs::read(&file).expect("the file reads");
                (file, bytes)
            })
            .collect();
        let work_folder = scratch.path().join("fork");
        // The stand-in appends its arguments to the file the SDK names a fork's, in the one
        // project folder of the config folder it is handed.
        let written_fork = work_folder
            .join("projects")
            .join("project")
            .join(format!("{FORK_ID}.jsonl"));
        let programs = tempfile::tempdir().expect("the programs folder is made");
        let bun = write_stand_in_program(
            programs.path(),
            "bun",
            &StandInProgram {
                answers_by_first_argument: Vec::new(),
                otherwise: StandInAnswer {
                    standard_output: standard_output.to_owned(),
                    exit_code,
                    argument_record: Some(written_fork),
                },
                first_call_wait: None,
            },
        )
        .expect("the stand-in bun is written");
        let module_folder = tempfile::tempdir().expect("the module folder is made");
        let module = AgentSdkModule {
            folder: module_folder.path().to_path_buf(),
        };
        let spawner =
            Spawner::new(tokio::runtime::Handle::current()).expect("the spawner thread starts");
        let request = ClaudeForkRequest {
            environment: pairs(&[(
                "PATH",
                &std::env::var("PATH").expect("the test runs with a search path"),
            )]),
            work_folder: work_folder.clone(),
            project_folder: project.clone(),
            source_conversation_id: SOURCE_ID.to_owned(),
            entry_id: "entry".to_owned(),
            title: String::new(),
            source_bytes: 0,
        };

        let forked = fork_claude_conversation(&spawner, &bun, &module, request).await;

        let mut expected_files: BTreeSet<PathBuf> =
            before.iter().map(|(file, _)| file.clone()).collect();
        match (&expected, &forked) {
            (ForkOutcome::Answered(id), Ok(answered)) => {
                assert_eq!(answered, id);
                let placed = project.join(format!("{id}.jsonl"));
                assert!(
                    std::fs::read_to_string(&placed)
                        .expect("the fork's file reads")
                        .contains(SOURCE_ID),
                    "the fork's file is the one the SDK wrote"
                );
                expected_files.insert(placed);
            }
            (ForkOutcome::Refused, Err(ClaudeForkError::Refused { .. }))
            | (ForkOutcome::UnreadableAnswer, Err(ClaudeForkError::UnreadableAnswer)) => {}
            _ => panic!("expected {expected:?}, got {forked:?}"),
        }
        assert_eq!(list_files(&project), expected_files);
        for (file, bytes) in &before {
            assert_eq!(&std::fs::read(file).expect("the file reads"), bytes);
        }
        assert!(!work_folder.exists(), "the fork's own folder is removed");
    }

    // Every file under `folder`, at any depth.
    fn list_files(folder: &Path) -> BTreeSet<PathBuf> {
        let mut files = BTreeSet::new();
        let mut folders = vec![folder.to_path_buf()];
        while let Some(folder) = folders.pop() {
            for entry in std::fs::read_dir(&folder).expect("the folder lists") {
                let path = entry.expect("the entry reads").path();
                if path.is_dir() {
                    folders.push(path);
                } else {
                    files.insert(path);
                }
            }
        }
        files
    }

    // Run by hand on scratch folders only: a real bun and the SDK's own `sdk.mjs` fork a written
    // conversation through its middle entry in the fork's own folder, leave only the fork's file,
    // beside its source, run no preload the person's bun settings name, and refuse an unknown
    // source before the SDK runs.
    #[tokio::test]
    #[ignore = "needs bun and the Agent SDK's sdk.mjs, named by SIDEKICKS_TEST_BUN_PROGRAM and SIDEKICKS_TEST_AGENT_SDK_FOLDER"]
    async fn a_real_fork_keeps_the_conversation_through_the_entry_and_writes_nowhere_else() {
        let bun = PathBuf::from(
            std::env::var_os("SIDEKICKS_TEST_BUN_PROGRAM")
                .expect("SIDEKICKS_TEST_BUN_PROGRAM names a bun program"),
        );
        let module = AgentSdkModule {
            folder: PathBuf::from(
                std::env::var_os("SIDEKICKS_TEST_AGENT_SDK_FOLDER")
                    .expect("SIDEKICKS_TEST_AGENT_SDK_FOLDER names the folder holding sdk.mjs"),
            ),
        };
        let scratch = tempfile::tempdir().expect("the scratch folder is made");
        let config = scratch.path().join("config");
        let home = scratch.path().join("home");
        let project = config.join("projects").join("-scratch-project");
        std::fs::create_dir_all(&project).expect("the project folder is made");
        std::fs::create_dir_all(&home).expect("the scratch home is made");
        let trap = scratch.path().join("trap.js");
        let marker = scratch.path().join("trap-ran");
        std::fs::write(
            &trap,
            format!(
                "require('node:fs').writeFileSync({}, 'ran');",
                serde_json::to_string(&marker.to_string_lossy()).expect("the path is text")
            ),
        )
        .expect("the trap is written");

        let entry_ids: Vec<String> = (1..=60_u128)
            .map(|index| Uuid::from_u128(index).hyphenated().to_string())
            .collect();
        let mut source = String::new();
        for (index, entry_id) in entry_ids.iter().enumerate() {
            let parent = index
                .checked_sub(1)
                .map(|parent| entry_ids[parent].as_str());
            let message = if index % 2 == 0 {
                json!({"role": "user", "content": format!("message {index}")})
            } else {
                json!({
                    "role": "assistant",
                    "content": [{"type": "text", "text": format!("reply {index}")}],
                })
            };
            let row = json!({
                "type": if index % 2 == 0 { "user" } else { "assistant" },
                "uuid": entry_id,
                "parentUuid": parent,
                "sessionId": SOURCE_ID,
                "timestamp": "2026-01-01T00:00:00.000Z",
                "isSidechain": false,
                "cwd": "/scratch/project",
                "message": message,
            });
            source.push_str(&row.to_string());
            source.push('\n');
        }
        let source_file = project.join(format!("{SOURCE_ID}.jsonl"));
        std::fs::write(&source_file, &source).expect("the source conversation is written");
        let watched = [config.clone(), home.clone(), module.folder.clone()];
        let before: BTreeSet<PathBuf> = watched
            .iter()
            .flat_map(|folder| list_files(folder))
            .collect();
        let spawner =
            Spawner::new(tokio::runtime::Handle::current()).expect("the spawner thread starts");
        let home_text = home.to_string_lossy().into_owned();
        let environment = pairs(&[
            (
                "PATH",
                &std::env::var("PATH").expect("the test runs with a search path"),
            ),
            ("HOME", &home_text),
            ("USERPROFILE", &home_text),
            ("XDG_CACHE_HOME", &home.join("cache").to_string_lossy()),
            (
                "BUN_OPTIONS",
                &format!("--preload {}", trap.to_string_lossy()),
            ),
        ]);
        let entry = &entry_ids[29];
        let work_folder = scratch.path().join("fork");
        let request = |source_conversation_id: &str| ClaudeForkRequest {
            environment: environment.clone(),
            work_folder: work_folder.clone(),
            project_folder: project.clone(),
            source_conversation_id: source_conversation_id.to_owned(),
            entry_id: entry.clone(),
            title: "--".to_owned(),
            source_bytes: u64::try_from(source.len()).expect("the length fits"),
        };

        let fork_id = fork_claude_conversation(&spawner, &bun, &module, request(SOURCE_ID))
            .await
            .expect("the fork answers");

        let fork_file = project.join(format!("{fork_id}.jsonl"));
        let rows: Vec<Value> = std::fs::read_to_string(&fork_file)
            .expect("the fork's file reads")
            .lines()
            .map(|line| serde_json::from_str(line).expect("each row is JSON"))
            .collect();
        let copied: Vec<&str> = rows
            .iter()
            .filter_map(|row| row["forkedFrom"]["messageUuid"].as_str())
            .collect();
        assert_eq!(
            copied,
            entry_ids[..=29]
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
        );
        assert!(
            rows.iter()
                .any(|row| row["type"] == "custom-title" && row["customTitle"] == "--"),
            "the fork is titled as asked"
        );
        assert_eq!(
            std::fs::read_to_string(&source_file).expect("the source reads"),
            source
        );
        let mut expected = before;
        expected.insert(fork_file);
        let after: BTreeSet<PathBuf> = watched
            .iter()
            .flat_map(|folder| list_files(folder))
            .collect();
        assert_eq!(after, expected);
        assert!(!work_folder.exists(), "the fork's own folder is removed");
        assert!(!marker.exists(), "the person's bun preload did not run");

        let unknown = Uuid::from_u128(u128::MAX).hyphenated().to_string();
        let refused = fork_claude_conversation(&spawner, &bun, &module, request(&unknown)).await;
        match refused {
            Err(ClaudeForkError::Staging(error)) => {
                assert_eq!(error.kind(), std::io::ErrorKind::NotFound, "{error}");
            }
            other => panic!("expected the source's absence, got {other:?}"),
        }
        assert!(
            !work_folder.exists(),
            "the refused fork's own folder is removed"
        );
    }
}
