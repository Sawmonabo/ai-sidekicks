//! The fork of a Claude Code conversation up to one of its entries, made by the Agent SDK's own
//! `forkSession` run under bun.

use std::collections::HashSet;
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use sidekicks_platforms::{PathRules, Spawner};
use sidekicks_std::child_run::ChildRunError;
use uuid::Uuid;

use super::{AgentSdkModule, SDK_FILE_NAME};
use crate::driver::claude::session::conversation_file::forks::read_claude_fork_source;
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

/// One fork of a Claude Code conversation: whose, up to which entry, under which title.
pub(crate) struct ClaudeForkRequest {
    /// The session's spawn environment, which the fork runs in less every bun and Node setting.
    pub(crate) environment: Vec<(String, String)>,
    /// The Claude Code config folder the source conversation was read from, so the fork lands
    /// beside it.
    pub(crate) config_folder: PathBuf,
    /// The folder holding the source conversation's file, where the SDK writes the fork's.
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
    /// The folder holding the source conversation's file could not be listed before the run.
    #[error("the source conversation's folder could not be listed")]
    Listing(#[source] io::Error),
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

/// The fork's conversation id, exactly as the SDK named the fork's file, or why there is none.
/// Runs the SDK in `module` under the bun at `bun`; the caller bounds its own waits for both. A
/// fork that fails after the SDK began writing has the file it began removed.
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
    let deadline = fork_deadline(request.source_bytes);
    let project_folder = request.project_folder.clone();
    let source = request.source_conversation_id.clone();
    let before = list_conversation_files(&project_folder)
        .await
        .map_err(ClaudeForkError::Listing)?;
    let forked = run_fork(spawner, fork_run_request(bun, module, request), deadline).await;
    if forked.is_err()
        && let Err(error) = remove_begun_forks(&project_folder, &before, &source).await
    {
        tracing::error!(
            error = &error as &dyn std::error::Error,
            folder = %project_folder.display(),
            "a failed fork's begun file could not be removed"
        );
    }
    forked
}

// The fork run to its end and its answer read.
async fn run_fork(
    spawner: &Spawner,
    run: ProgramRunRequest,
    deadline: Duration,
) -> Result<String, ClaudeForkError> {
    let output = run_program_to_end(spawner, run, deadline, FORK_OUTPUT_BOUND)
        .await
        .map_err(ClaudeForkError::Run)?;
    if !output.status.success() {
        return Err(ClaudeForkError::Refused {
            message: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    read_fork_answer(&output.stdout).ok_or(ClaudeForkError::UnreadableAnswer)
}

// Every conversation file in `folder`.
async fn list_conversation_files(folder: &Path) -> io::Result<HashSet<PathBuf>> {
    let mut files = HashSet::new();
    let mut entries = tokio::fs::read_dir(folder).await?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path
            .extension()
            .is_some_and(|extension| extension == CONVERSATION_FILE_EXTENSION)
        {
            files.insert(path);
        }
    }
    Ok(files)
}

// Removes each conversation file in `folder` that `before` did not list and whose first entry
// names `source` as the conversation it was forked from: the file a failed fork began.
async fn remove_begun_forks(
    folder: &Path,
    before: &HashSet<PathBuf>,
    source: &str,
) -> io::Result<()> {
    for file in list_conversation_files(folder).await? {
        if !before.contains(&file)
            && read_claude_fork_source(&file).await?.as_deref() == Some(source)
        {
            tokio::fs::remove_file(&file).await?;
        }
    }
    Ok(())
}

// bun with every input an argument after `--`, run in the SDK's own folder, which holds no
// `bunfig.toml` or `.env`, with every bun and Node setting withheld and the transpiler cache off.
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
        request.config_folder.into_os_string(),
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
        fork_run_request, list_conversation_files, remove_begun_forks,
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
            config_folder: PathBuf::from("/home/person/.claude"),
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
            "/home/person/.claude".into(),
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

    // Killed by accepting an id that is no UUID, by answering a normalized id in place of the one
    // written, by reading a failed run's output as its answer, and by reading exit 1 as an
    // unreadable answer.
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
    async fn a_forks_answer_is_its_conversation_or_a_named_failure(
        #[case] standard_output: &str,
        #[case] exit_code: u8,
        #[case] expected: ForkOutcome,
    ) {
        let programs = tempfile::tempdir().expect("the programs folder is made");
        let bun = write_stand_in_program(
            programs.path(),
            "bun",
            &StandInProgram {
                answers_by_first_argument: Vec::new(),
                otherwise: StandInAnswer {
                    standard_output: standard_output.to_owned(),
                    exit_code,
                    argument_record: None,
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
            config_folder: module_folder.path().join("config"),
            project_folder: module_folder.path().to_path_buf(),
            source_conversation_id: SOURCE_ID.to_owned(),
            entry_id: "entry".to_owned(),
            title: String::new(),
            source_bytes: 0,
        };

        let forked = fork_claude_conversation(&spawner, &bun, &module, request).await;

        match (&expected, &forked) {
            (ForkOutcome::Answered(id), Ok(answered)) => assert_eq!(answered, id),
            (ForkOutcome::Refused, Err(ClaudeForkError::Refused { .. }))
            | (ForkOutcome::UnreadableAnswer, Err(ClaudeForkError::UnreadableAnswer)) => {}
            _ => panic!("expected {expected:?}, got {forked:?}"),
        }
    }

    // Killed by removing a file listed before the run, a fork of another conversation or a file
    // that is no conversation's, and by keeping the fork the failed run began.
    #[tokio::test]
    async fn a_failed_forks_begun_file_alone_is_removed() {
        let folder = tempfile::tempdir().expect("the project folder is made");
        let write = |name: &str, first_entry: Value| {
            std::fs::write(folder.path().join(name), format!("{first_entry}\n"))
                .expect("the file is written");
        };
        let fork_of = |source: &str| {
            json!({
                "type": "user",
                "uuid": "copy",
                "forkedFrom": {"sessionId": source, "messageUuid": "entry"},
            })
        };
        write("source.jsonl", json!({"type": "user", "uuid": "entry"}));
        write("earlier-fork.jsonl", fork_of(SOURCE_ID));
        let before = list_conversation_files(folder.path())
            .await
            .expect("the folder lists");
        write("begun.jsonl", fork_of(SOURCE_ID));
        write("other-fork.jsonl", fork_of(FORK_ID));
        write("begun.txt", fork_of(SOURCE_ID));

        remove_begun_forks(folder.path(), &before, SOURCE_ID)
            .await
            .expect("the begun fork is removed");

        let kept: BTreeSet<PathBuf> = [
            "source.jsonl",
            "earlier-fork.jsonl",
            "other-fork.jsonl",
            "begun.txt",
        ]
        .iter()
        .map(|name| folder.path().join(name))
        .collect();
        assert_eq!(list_files(folder.path()), kept);
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
    // conversation through its middle entry, write only the fork's file, run no preload the
    // person's bun settings name, and refuse an unknown source with the SDK's own message.
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
        let request = |source_conversation_id: &str| ClaudeForkRequest {
            environment: environment.clone(),
            config_folder: config.clone(),
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
        assert!(!marker.exists(), "the person's bun preload did not run");

        let unknown = Uuid::from_u128(u128::MAX).hyphenated().to_string();
        let refused = fork_claude_conversation(&spawner, &bun, &module, request(&unknown)).await;
        match refused {
            Err(ClaudeForkError::Refused { message }) => {
                assert!(message.contains("not found"), "{message}");
            }
            other => panic!("expected the SDK's refusal, got {other:?}"),
        }
    }
}
