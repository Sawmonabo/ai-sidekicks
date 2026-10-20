//! A shell table for tests whose shells start a `shell` mode that is not there, so each keeps its
//! record as one that did not start.

use std::path::PathBuf;
use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionShape;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_platforms::{Spawner, create_private_folder};
use sidekicks_terminal::{CommandLine, Terminals};
use tempfile::TempDir;
use tokio::runtime::Handle;
use tokio::sync::watch;

use crate::provider::spawn_environment::ReservedEnvironmentNames;
use crate::pty::orphan::guard::open_orphan_guard;
use crate::pty::shell::integration::injection::ShellStartupFolders;
use crate::pty::shell::table::{
    ReadSessionWorkingFolder, ShellSettings, ShellTable, ShellTableDeps,
};
use crate::session::not_found::session_not_found;
use crate::session::working_folder::SessionWorkingFolder;

/// The session the table's tests open shells in.
pub(crate) const SESSION: &str = "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d0e";

/// A table whose shells start a `shell` mode that is not there, so each keeps its record as one
/// that did not start, and the scratch folder its files live in.
pub(crate) struct TableFixture {
    /// The table.
    pub(crate) table: Arc<ShellTable>,
    /// The terminals its shells start in.
    pub(crate) terminals: Arc<Terminals>,
    _scratch: TempDir,
}

/// The session's working folder, read only once `gate` opens, refusing any session but
/// [`SESSION`].
fn working_folder_read(folder: PathBuf, gate: watch::Receiver<bool>) -> ReadSessionWorkingFolder {
    Arc::new(move |session_id: SessionId| {
        let folder = folder.clone();
        let mut gate = gate.clone();
        async move {
            if session_id != session() {
                return Err(session_not_found(&session_id).into());
            }
            gate.wait_for(|is_open| *is_open)
                .await
                .expect("the gate's sender outlives the table");
            Ok(SessionWorkingFolder {
                shape: SessionShape::Project,
                working_folder: Some(folder),
                place: None,
            })
        }
        .boxed()
    })
}

pub(crate) async fn table_fixture(gate: watch::Receiver<bool>) -> TableFixture {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let working_folder = scratch.path().join("work");
    let startup_folder = scratch.path().join("startup");
    let nonce_folder = startup_folder.join("nonces");
    let data_folder = scratch.path().join("data");
    for folder in [&working_folder, &nonce_folder, &data_folder] {
        create_private_folder(folder).expect("a folder is made");
    }
    let terminals = Arc::new(Terminals::new(
        Spawner::new(Handle::current()).expect("the spawner starts"),
        CommandLine {
            program: "console-helper".to_owned(),
            arguments: Vec::new(),
        },
    ));
    let orphan_guard = open_orphan_guard(&data_folder)
        .await
        .expect("the orphan guard opens");
    let table = ShellTable::new(ShellTableDeps {
        terminals: Arc::clone(&terminals),
        machine_device_id: DeviceId::new("device-machine".to_owned()).expect("a device id"),
        terminal_version: "test".to_owned(),
        append_control_change: Arc::new(|_change| async { Ok(()) }.boxed()),
        read_working_folder: working_folder_read(working_folder, gate),
        read_shell_settings: Arc::new(|_session| {
            async {
                Ok(ShellSettings {
                    is_screen_reader_mode_on: false,
                    every_project_rows: Vec::new(),
                    project_rows: Vec::new(),
                })
            }
            .boxed()
        }),
        base_environment: Vec::new(),
        reserved_names: Arc::new(ReservedEnvironmentNames::of_providers(&[])),
        screen_reader_environment_names: Vec::new(),
        startup_folders: ShellStartupFolders {
            startup_folder,
            nonce_folder,
        },
        shell_mode: CommandLine {
            program: scratch
                .path()
                .join("no shell mode")
                .to_string_lossy()
                .into_owned(),
            arguments: Vec::new(),
        },
        orphan_guard: Arc::new(orphan_guard),
        runtime: Handle::current(),
    });
    TableFixture {
        table: Arc::new(table),
        terminals,
        _scratch: scratch,
    }
}

/// The one session the table reads a working folder for.
pub(crate) fn session() -> SessionId {
    SessionId::new(SESSION).expect("a session id")
}
