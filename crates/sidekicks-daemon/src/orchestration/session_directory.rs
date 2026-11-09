//! The session directory: every session a session tool can name, the ones this daemon hosts on any
//! provider and the ones a person typed in a terminal, whether a provider's shared service holds
//! them or they run on their own, and the one resolution of a name or id a model passes to the
//! session it names.
//!
//! The directory keeps nothing between lookups: each lookup reads the sessions' rows, every
//! driver's terminal sessions and this computer's name as they are then, so a session started or
//! renamed, a terminal that left or a computer renamed since the daemon started is seen, and a
//! restart has nothing to rebuild.

use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use futures::future::try_join_all;
use sidekicks_agent::tools::session::SessionReference;
use sidekicks_agent::tools::session::errors::{SharedNameHolder, shared_name};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::controls::methods::{
    TerminalProviderSession, TerminalProviderSessionState,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::contract::params_and_results::StandaloneTerminalSession;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::session_messages::no_session_named;
use sidekicks_session::run::agent::read_session_lead;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::stored_column::{closed_word, text_column};
use sidekicks_store::events::session::read::{DamagedFromSequenceReader, session_read_bound};
use sidekicks_store::machine::local::{LocalMachineError, read_local_machine};
use sidekicks_workspace::project::records::session_project_sql;
use sidekicks_workspace::project::service::project_name_of;

/// The word `session_update` and `session_group` read as the calling session.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the session tools' handlers resolve a reference")
)]
const THIS_SESSION: &str = "this";

/// Where the shared-name refusal places a session that belongs to no project: a chat, or a session
/// typed in a terminal whose provider names no folder.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the session tools' handlers resolve a reference")
)]
const NO_PROJECT: &str = "no project";

// Every session this daemon hosts that is not being purged, in the table's order, with its
// project's name.
static HOSTED_SESSIONS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT hosted.id, hosted.name, hosted.state,
                (SELECT owning.name FROM projects AS owning WHERE owning.id = {})
           FROM sessions AS hosted
          WHERE hosted.state <> '{}'
          ORDER BY hosted.rowid",
        session_project_sql("hosted.id"),
        <&'static str>::from(SessionState::PurgeRequested),
    )
});

/// The daemon's session directory, built once at its start over the daemon's reads and drivers.
pub(crate) struct SessionDirectory {
    /// The daemon's read connections, which read the sessions' rows, their leads and this machine.
    pub(crate) pool: Arc<DatabaseReadPool>,
    /// The drivers, each asked for the sessions a person typed in a terminal, those its shared
    /// service holds and those that run on their own.
    pub(crate) providers: Arc<ProviderRegistry>,
    /// Where each session's log reads as damaged, so a lead is read from its readable part only.
    pub(crate) read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
}

/// How a session came to be in the directory.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SessionOrigin {
    /// This daemon hosts it.
    Hosted,
    /// A person typed it in a terminal.
    TypedInTerminal {
        /// Where it stands in the provider's shared service the daemon runs, where that service
        /// holds it; `None` for a session that runs on its own.
        shared_service_state: Option<TerminalProviderSessionState>,
    },
}

/// One session a session tool can name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SessionDirectoryEntry {
    /// The id a model names it by: the session's id, or the provider's id for a session typed in
    /// a terminal.
    pub(crate) id: String,
    /// Its name; `None` while it is unnamed, which only its id reaches.
    pub(crate) name: Option<String>,
    /// The provider it runs on.
    pub(crate) provider: ProviderId,
    /// The model its lead runs on now; `None` for a session typed in a terminal.
    pub(crate) model: Option<String>,
    /// Its project's name: a hosted session's project, or for a session typed in a terminal the
    /// name a project in its folder takes; `None` for a chat and for a terminal session whose
    /// provider names no folder.
    pub(crate) project: Option<String>,
    /// The folder a session typed in a terminal runs in, where its provider names it; `None` for a
    /// hosted session.
    pub(crate) folder: Option<PathBuf>,
    /// The name of the computer it runs on.
    pub(crate) computer: Arc<str>,
    /// Whether the person archived it.
    pub(crate) is_archived: bool,
    /// How it came to be in the directory.
    pub(crate) origin: SessionOrigin,
}

/// How a tool reads a reference to the session calling it.
#[derive(Clone, Copy, Debug)]
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the session tools' handlers resolve a reference")
)]
pub(crate) enum CallerReference {
    /// The tool cannot act on the calling session and refuses it with this text, given the
    /// caller's name (`session_wait`, `session_stop`, `session_ask`).
    Refused(fn(&str) -> String),
    /// `"this"` names the calling session (`session_update`, `session_group`).
    ThisNamesCaller,
    /// The calling session resolves like any other.
    AnySession,
}

/// Why the directory could not be read.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SessionDirectoryError {
    /// No read connection could be had.
    #[error("no connection could read the sessions")]
    Read(#[from] DatabaseReadError),
    /// The sessions' rows or a lead could not be read.
    #[error("the sessions' rows could not be read")]
    Query(#[from] rusqlite::Error),
    /// This machine's row could not be read.
    #[error(transparent)]
    LocalMachine(#[from] LocalMachineError),
    /// This machine has no row, so its sessions have no computer to name.
    #[error("this machine's row is not recorded")]
    NoLocalMachine,
    /// A driver's lists of sessions typed in a terminal could not be read.
    #[error(transparent)]
    TerminalSessions(#[from] DriverError),
}

impl SessionDirectory {
    /// Every session in the directory as it is now: the hosted ones in the table's order, then
    /// each driver's sessions typed in a terminal in the drivers' order, those its shared service
    /// holds before those that run on their own. A hosted session whose readable log names no lead
    /// is bound to no provider here and is left out. Fails when a read fails or a driver's terminal
    /// lists cannot be read, so a lookup never misses a session it would have named.
    pub(crate) async fn read_entries(
        &self,
    ) -> Result<Vec<SessionDirectoryEntry>, SessionDirectoryError> {
        let (machine, hosted, terminal) = tokio::try_join!(
            async {
                read_local_machine(&self.pool)
                    .await?
                    .ok_or(SessionDirectoryError::NoLocalMachine)
            },
            self.read_hosted_sessions(),
            self.read_terminal_sessions(),
        )?;
        let computer: Arc<str> = machine.name.into();
        let mut entries: Vec<SessionDirectoryEntry> = hosted
            .into_iter()
            .map(|session| SessionDirectoryEntry {
                id: session.id.to_string(),
                name: session.name,
                provider: session.provider,
                model: Some(session.model),
                project: session.project,
                folder: None,
                computer: Arc::clone(&computer),
                is_archived: session.state == SessionState::Archived,
                origin: SessionOrigin::Hosted,
            })
            .collect();
        for DriverTerminalSessions {
            provider,
            in_service,
            standalone,
        } in terminal
        {
            entries.extend(
                in_service
                    .into_iter()
                    .map(|session: TerminalProviderSession| {
                        let folder = session.folder.map(|folder| PathBuf::from(folder.as_str()));
                        SessionDirectoryEntry {
                            id: session.thread_id.as_str().to_owned(),
                            name: Some(session.name.as_str().to_owned()),
                            provider: session.provider,
                            model: None,
                            project: folder.as_deref().map(folder_project_name),
                            folder,
                            computer: Arc::clone(&computer),
                            is_archived: false,
                            origin: SessionOrigin::TypedInTerminal {
                                shared_service_state: Some(session.state),
                            },
                        }
                    }),
            );
            entries.extend(
                standalone
                    .into_iter()
                    .map(|session: StandaloneTerminalSession| SessionDirectoryEntry {
                        id: session.id,
                        name: session.name,
                        provider: provider.clone(),
                        model: None,
                        project: session.folder.as_deref().map(folder_project_name),
                        folder: session.folder,
                        computer: Arc::clone(&computer),
                        is_archived: false,
                        origin: SessionOrigin::TypedInTerminal {
                            shared_service_state: None,
                        },
                    }),
            );
        }
        Ok(entries)
    }

    // Each driver's sessions typed in a terminal in the drivers' order, read together.
    async fn read_terminal_sessions(
        &self,
    ) -> Result<Vec<DriverTerminalSessions<'_>>, SessionDirectoryError> {
        let lists = try_join_all(
            self.providers
                .drivers()
                .map(|(provider, driver)| async move {
                    let (in_service, standalone) = tokio::try_join!(
                        driver.list_terminal_sessions(),
                        driver.list_standalone_terminal_sessions(),
                    )?;
                    Ok::<_, DriverError>(DriverTerminalSessions {
                        provider,
                        in_service,
                        standalone,
                    })
                }),
        )
        .await?;
        Ok(lists)
    }

    // The hosted sessions with a lead, each with its lead's provider and model, in one read.
    async fn read_hosted_sessions(&self) -> Result<Vec<HostedSession>, SessionDirectoryError> {
        let read_damaged_from_sequence = Arc::clone(&self.read_damaged_from_sequence);
        self.pool
            .read(ReadLength::Long, move |reader| {
                let rows = reader
                    .prepare_cached(&HOSTED_SESSIONS_SQL)?
                    .query_map([], |row| {
                        Ok((
                            text_column(row, 0, |text| SessionId::new(&text))?,
                            row.get::<_, Option<String>>(1)?,
                            text_column(row, 2, closed_word::<SessionState>)?,
                            row.get::<_, Option<String>>(3)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let mut sessions = Vec::with_capacity(rows.len());
                for (id, name, state, project) in rows {
                    let read_bound = session_read_bound(&*read_damaged_from_sequence, &id, None);
                    let Some(lead) = read_session_lead(reader, &id, read_bound)? else {
                        continue;
                    };
                    sessions.push(HostedSession {
                        id,
                        name,
                        state,
                        project,
                        provider: lead.binding.provider_name,
                        model: lead.running_model.as_str().to_owned(),
                    });
                }
                Ok::<_, SessionDirectoryError>(sessions)
            })
            .await
    }
}

// The project name a session typed in a terminal in `folder` reads under, as a project there would
// be named.
fn folder_project_name(folder: &Path) -> String {
    project_name_of(folder).as_str().to_owned()
}

// One driver's sessions typed in a terminal: those its shared service holds and those that run on
// their own.
struct DriverTerminalSessions<'registry> {
    provider: &'registry ProviderId,
    in_service: Vec<TerminalProviderSession>,
    standalone: Vec<StandaloneTerminalSession>,
}

// One hosted session's directory facts as its row and its lead's binding give them.
struct HostedSession {
    id: SessionId,
    name: Option<String>,
    state: SessionState,
    project: Option<String>,
    provider: ProviderId,
    model: String,
}

/// The session `reference` names for a tool `caller` calls, by the first rule that matches: the
/// caller itself where the tool refuses it, an id, `"this"` where it names the caller, a name one
/// session has; a name several share is refused with each holder, and anything else, an address
/// among it, is a name no session has. An id is matched before any name, and a name is never
/// guessed among several. The error is the refusal's text for the model.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the session tools' handlers resolve a reference")
)]
pub(crate) fn resolve_session_reference<'directory>(
    entries: &'directory [SessionDirectoryEntry],
    caller: &SessionId,
    reference: &SessionReference,
    caller_reference: CallerReference,
) -> Result<&'directory SessionDirectoryEntry, String> {
    let reference = reference.as_str();
    let caller_id = caller.to_string();
    let named: Vec<&SessionDirectoryEntry> = entries
        .iter()
        .filter(|entry| entry.name.as_deref() == Some(reference))
        .collect();
    if let CallerReference::Refused(refusal) = caller_reference {
        let is_caller =
            reference == caller_id || matches!(named.as_slice(), [only] if only.id == caller_id);
        if is_caller {
            let caller_name = entries
                .iter()
                .find(|entry| entry.id == caller_id)
                .and_then(|entry| entry.name.as_deref())
                .unwrap_or(caller_id.as_str());
            return Err(refusal(caller_name));
        }
    }
    if let Some(entry) = entries.iter().find(|entry| entry.id == reference) {
        return Ok(entry);
    }
    if matches!(caller_reference, CallerReference::ThisNamesCaller) && reference == THIS_SESSION {
        return entries
            .iter()
            .find(|entry| entry.id == caller_id)
            .ok_or_else(|| no_session_named(&caller_id));
    }
    match named.as_slice() {
        [only] => Ok(only),
        [] => Err(no_session_named(reference)),
        several => {
            let holders: Vec<SharedNameHolder<'_>> = several
                .iter()
                .map(|entry| SharedNameHolder {
                    name: reference,
                    id: &entry.id,
                    project: entry.project.as_deref().unwrap_or(NO_PROJECT),
                })
                .collect();
            Err(shared_name(reference, &holders))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;

    use futures::FutureExt as _;
    use sidekicks_agent::tools::session::SessionReference;
    use sidekicks_agent::tools::session::errors::{SharedNameHolder, shared_name};
    use sidekicks_agent::tools::session::wait::not_waiting_self;
    use sidekicks_contracts::free_form_string::FilesystemPath;
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::session::controls::methods::{
        TerminalProviderSession, TerminalProviderSessionState,
    };
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_contracts::wire::text::ComposedText;
    use sidekicks_provider::driver::PROVIDERS;
    use sidekicks_provider::driver::contract::MockProviderDriver;
    use sidekicks_provider::driver::contract::params_and_results::StandaloneTerminalSession;
    use sidekicks_provider::driver::session_messages::no_session_named;
    use sidekicks_provider::driver::test_registry::registry_of_first_providers;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::database::writer::test_file::{
        TestDatabase, insert_lead, test_session_id,
    };

    use super::{
        CallerReference, SessionDirectory, SessionDirectoryEntry, SessionOrigin, SessionState,
        resolve_session_reference,
    };
    use crate::daemon::schema::schema_parts;

    fn provider(index: usize) -> ProviderId {
        ProviderId::new(PROVIDERS[index].id.to_owned()).expect("a table id")
    }

    fn entry(id: &str, name: &str, project: &str) -> SessionDirectoryEntry {
        SessionDirectoryEntry {
            id: id.to_owned(),
            name: Some(name.to_owned()),
            provider: provider(0),
            model: None,
            project: Some(project.to_owned()),
            folder: None,
            computer: Arc::from("this Mac"),
            is_archived: false,
            origin: SessionOrigin::Hosted,
        }
    }

    fn reference(text: &str) -> SessionReference {
        SessionReference::new(text.to_owned()).expect("a valid reference")
    }

    #[test]
    fn a_reference_resolves_by_the_first_row_it_matches_the_caller_first() {
        let caller = test_session_id();
        let caller_id = caller.to_string();
        let builder_id = test_session_id().to_string();
        let entries = vec![
            entry(&caller_id, "planner", "shop-api"),
            entry(&builder_id, "builder", "shop-api"),
            entry("s-2c07", "builder", "docs"),
            entry("s-77aa", "solo", "docs"),
            // A session named like another's id, which the id reaches before the name.
            entry("s-9e10", &builder_id, "docs"),
        ];
        let resolve = |text: &str, caller_reference| {
            resolve_session_reference(&entries, &caller, &reference(text), caller_reference)
                .map(|entry| entry.id.clone())
        };
        let waits = CallerReference::Refused(not_waiting_self);

        // The caller, by its id or a name only it has, is refused where the tool cannot act on
        // it, before the id row would answer it.
        assert_eq!(resolve(&caller_id, waits), Err(not_waiting_self("planner")));
        assert_eq!(resolve("planner", waits), Err(not_waiting_self("planner")));
        // Elsewhere the caller resolves like any session.
        assert_eq!(
            resolve(&caller_id, CallerReference::AnySession),
            Ok(caller_id.clone())
        );
        // An id is matched before a name that spells it.
        assert_eq!(resolve(&builder_id, waits), Ok(builder_id.clone()));
        // `this` names the caller only where the tool reads it so.
        assert_eq!(
            resolve("this", CallerReference::ThisNamesCaller),
            Ok(caller_id)
        );
        assert_eq!(resolve("this", waits), Err(no_session_named("this")));
        // A name one session has resolves; one two share is refused with both, never picked.
        assert_eq!(resolve("solo", waits), Ok("s-77aa".to_owned()));
        assert_eq!(
            resolve("builder", CallerReference::AnySession),
            Err(shared_name(
                "builder",
                &[
                    SharedNameHolder {
                        name: "builder",
                        id: &builder_id,
                        project: "shop-api",
                    },
                    SharedNameHolder {
                        name: "builder",
                        id: "s-2c07",
                        project: "docs",
                    },
                ],
            ))
        );
        // An address is a name no session has, as is any other unknown name.
        assert_eq!(
            resolve("uds:/tmp/claude.sock", waits),
            Err(no_session_named("uds:/tmp/claude.sock"))
        );
        assert_eq!(
            resolve("reviewer", waits),
            Err(no_session_named("reviewer"))
        );
    }

    #[tokio::test]
    async fn the_directory_names_the_sessions_of_every_provider() {
        let database = TestDatabase::new(schema_parts());
        // The daemon's own open creates the file and its schema, which every later read needs.
        let reader = database.opener()().expect("the test creates its database");
        reader
            .execute(
                "INSERT INTO local_machine (singleton, machine_id, owner_user_id, name, minted_at)
                 VALUES (1, ?1, ?2, 'this Mac', ?3)",
                [
                    mint_uuid_v7().to_string(),
                    mint_uuid_v7().to_string(),
                    WireInstant::now().as_str().to_owned(),
                ],
            )
            .expect("the test records this machine");
        let planner: SessionId = test_session_id();
        insert_session_row(&reader, planner.text().as_str(), Some("planner"), None);
        insert_lead(&database, planner, PROVIDERS[0].id);
        let archived: SessionId = test_session_id();
        insert_session_row(&reader, archived.text().as_str(), Some("reviewer"), None);
        insert_lead(&database, archived, PROVIDERS[1].id);
        reader
            .execute(
                "UPDATE sessions SET state = 'archived' WHERE id = ?1",
                [archived.text().as_str()],
            )
            .expect("the test archives the session");
        // Killed by dropping the purge condition, which would list a session being deleted.
        let purged: SessionId = test_session_id();
        insert_session_row(&reader, purged.text().as_str(), Some("purged"), None);
        insert_lead(&database, purged, PROVIDERS[0].id);
        reader
            .execute(
                "UPDATE sessions SET state = ?2 WHERE id = ?1",
                [
                    purged.text().as_str(),
                    <&'static str>::from(SessionState::PurgeRequested),
                ],
            )
            .expect("the test marks the session purged");

        let mut first = MockProviderDriver::new();
        first
            .expect_list_terminal_sessions()
            .returning(|| async { Ok(Vec::new()) }.boxed());
        first
            .expect_list_standalone_terminal_sessions()
            .returning(|| {
                async {
                    Ok(vec![StandaloneTerminalSession {
                        id: "s-typed".to_owned(),
                        name: None,
                        folder: Some(PathBuf::from("/work/tax")),
                    }])
                }
                .boxed()
            });
        let mut second = MockProviderDriver::new();
        second.expect_list_terminal_sessions().returning(|| {
            async {
                Ok(vec![TerminalProviderSession {
                    provider: provider(1),
                    name: ComposedText::new("tax-fix".to_owned()).expect("a name"),
                    thread_id: ComposedText::new("thread-1".to_owned()).expect("an id"),
                    state: TerminalProviderSessionState::Idle,
                    folder: Some(
                        FilesystemPath::new("/work/shop-api".to_owned()).expect("a folder"),
                    ),
                }])
            }
            .boxed()
        });
        second
            .expect_list_standalone_terminal_sessions()
            .returning(|| async { Ok(Vec::new()) }.boxed());
        let directory = SessionDirectory {
            pool: Arc::new(DatabaseReadPool::new(database.path(), 8)),
            providers: Arc::new(registry_of_first_providers(vec![
                Arc::new(first),
                Arc::new(second),
            ])),
            read_damaged_from_sequence: Arc::new(|_: &SessionId| None),
        };

        let entries = directory.read_entries().await.expect("the directory reads");
        let facts: Vec<_> = entries
            .iter()
            .map(|entry| {
                (
                    entry.id.as_str(),
                    entry.name.as_deref(),
                    entry.provider.clone(),
                    entry.model.as_deref(),
                    entry.project.as_deref(),
                    entry.folder.as_deref().and_then(|folder| folder.to_str()),
                    &*entry.computer,
                    entry.is_archived,
                    entry.origin,
                )
            })
            .collect();
        let planner_id = planner.to_string();
        let archived_id = archived.to_string();
        assert_eq!(
            facts,
            vec![
                (
                    planner_id.as_str(),
                    Some("planner"),
                    provider(0),
                    Some("test-model"),
                    None,
                    None,
                    "this Mac",
                    false,
                    SessionOrigin::Hosted,
                ),
                (
                    archived_id.as_str(),
                    Some("reviewer"),
                    provider(1),
                    Some("test-model"),
                    None,
                    None,
                    "this Mac",
                    true,
                    SessionOrigin::Hosted,
                ),
                (
                    "s-typed",
                    None,
                    provider(0),
                    None,
                    Some("tax"),
                    Some("/work/tax"),
                    "this Mac",
                    false,
                    SessionOrigin::TypedInTerminal {
                        shared_service_state: None,
                    },
                ),
                (
                    "thread-1",
                    Some("tax-fix"),
                    provider(1),
                    None,
                    Some("shop-api"),
                    Some("/work/shop-api"),
                    "this Mac",
                    false,
                    SessionOrigin::TypedInTerminal {
                        shared_service_state: Some(TerminalProviderSessionState::Idle),
                    },
                ),
            ]
        );
    }
}
