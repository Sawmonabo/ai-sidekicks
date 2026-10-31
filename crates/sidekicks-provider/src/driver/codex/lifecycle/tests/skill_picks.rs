//! A skill pick resolved for a session with no live command list: Codex's skills read in the
//! folder the session's runs work in.

use std::path::PathBuf;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::json;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::run::queue::QueuedSkillPick;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;

use super::super::CodexDriver;
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::supervisor::test_service::start_scripted_codex_service;
use crate::driver::test_registry::{new_session_id, test_driver_services};
use crate::driver::{ProviderAccountFolders, SessionSpawnContext, SessionSpawnContextResolver};
use crate::runtime_binding::test_store::test_provider_account_id;

/// The folder every session's process starts in.
const WORKING_DIRECTORY: &str = "/sessions/worktree";

/// The folder every session's runs work in, apart from the process's.
const RUN_FOLDER: &str = "/sessions/bound-root";

// Every session's process starts in one folder and its runs work in another.
struct RunFolderApart;

impl SessionSpawnContextResolver for RunFolderApart {
    fn resolve_spawn_context(
        &self,
        _session_id: SessionId,
        _provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<SessionSpawnContext, Box<dyn std::error::Error + Send + Sync>>> {
        async {
            Ok(SessionSpawnContext {
                working_directory: PathBuf::from(WORKING_DIRECTORY),
                git_common_folder: None,
                every_project_rows: Vec::new(),
                project_rows: Vec::new(),
                account_folders: ProviderAccountFolders {
                    configuration_folder: PathBuf::from(WORKING_DIRECTORY),
                    credential_store_folder: PathBuf::from(WORKING_DIRECTORY),
                },
                step_bound: None,
                advisor_model: None,
            })
        }
        .boxed()
    }

    fn resolve_run_folder(
        &self,
        _session_id: SessionId,
    ) -> BoxFuture<'_, Result<PathBuf, Box<dyn std::error::Error + Send + Sync>>> {
        async { Ok(PathBuf::from(RUN_FOLDER)) }.boxed()
    }
}

// Kills the read going back to the spawn context's working folder: Codex would be asked for the
// skills of the process's folder, which a session whose first run has not prepared its root does
// not yet have.
#[tokio::test]
async fn a_skill_pick_with_no_live_listing_is_read_in_the_run_folder() {
    let mut scripted = start_scripted_codex_service();
    let services = test_driver_services();
    services
        .ports
        .spawn_contexts
        .register(Arc::new(RunFolderApart) as _)
        .expect("the spawn contexts register once");
    let mut driver = CodexDriver::new(&services);
    driver.registry = CodexServiceRegistry::holding(&scripted);
    let skill_folder = format!("{RUN_FOLDER}/.codex/skills/review");
    let pick = QueuedSkillPick {
        name: FreeFormText::new("review".to_owned()).expect("a skill name"),
        folder_path: FilesystemPath::new(skill_folder.clone()).expect("a short path"),
    };

    let (picked, ()) = tokio::join!(
        driver.resolve_skill_picks(new_session_id(), test_provider_account_id(), vec![pick]),
        async {
            let sent = scripted.script.next_sent().await;
            assert_eq!(sent["method"], "skills/list", "{sent}");
            assert_eq!(sent["params"]["cwds"], json!([RUN_FOLDER]), "{sent}");
            let skill = json!({"name": "review", "path": format!("{skill_folder}/SKILL.md")});
            scripted.script.answer(
                &sent,
                &json!({"data": [{"cwd": RUN_FOLDER, "skills": [skill]}]}),
            );
        },
    );

    let picked = picked.expect("the pick is listed in the run folder");
    let paths: Vec<&str> = picked.iter().map(|skill| skill.path.as_str()).collect();
    assert_eq!(paths, [format!("{skill_folder}/SKILL.md").as_str()]);
}
