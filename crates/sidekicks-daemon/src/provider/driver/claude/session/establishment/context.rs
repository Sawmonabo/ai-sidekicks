//! Where and with what a session's process starts, read at every spawn: the place the daemon
//! resolves for it, and the session's own settings the daemon stores (its advisor, its output
//! style and its step bound), each read again so a relaunch starts with the newest.

use std::error::Error;
use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::machine::settings::{ProviderRowValue, ProviderRowValues};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::declaration::ProviderDeclarationId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::provider::driver::SessionSpawnContextResolver;
use crate::provider::driver::claude::spawn::environment::ClaudeAccountFolders;
use crate::provider::driver::claude::spawn::legs::ClaudeSpawnContext;
use crate::provider::driver::claude::spawn::settings::ClaudeSessionAdvisor;
use crate::session::console_state::{read_session_advisor_model, read_session_max_steps_per_turn};

/// The id of the Settings row holding the output style new sessions start with.
pub(crate) const CLAUDE_OUTPUT_STYLE_ROW_ID: &str = "outputStyle";

/// The id of the Settings row holding the advisor new sessions start with.
pub(crate) const CLAUDE_ADVISOR_ROW_ID: &str = "advisor";

// The newest output style the session's own command set.
const SELECT_OUTPUT_STYLE_SQL: &str = "SELECT json_extract(payload, '$.outputStyle')
  FROM session_events WHERE session_id = ? AND type = ? ORDER BY sequence DESC LIMIT 1";

/// Why a session's stored settings could not be read.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudeStoredReadError {
    /// The read reached no connection.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// SQLite refused the read.
    #[error("the session's stored settings could not be read")]
    Sql(#[from] rusqlite::Error),
}

/// Why a session's spawn context could not be resolved.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudeSpawnContextError {
    /// The daemon could not say where the session runs.
    #[error("where the session runs could not be resolved")]
    Place(#[source] Box<dyn Error + Send + Sync>),
    /// The session's own settings could not be read.
    #[error(transparent)]
    Stored(#[from] ClaudeStoredReadError),
}

/// The session's own settings a process starts with.
struct ClaudeStoredSettings {
    advisor: Option<ClaudeSessionAdvisor>,
    output_style: Option<String>,
}

/// Resolves the context `session_id`'s process starts in on `provider_account_id`'s account,
/// `row_values` being the Settings values the app stored for the provider. Fails as the place or
/// the session's stored settings cannot be read.
pub(crate) async fn resolve_claude_spawn_context(
    spawn_contexts: &dyn SessionSpawnContextResolver,
    pool: &DatabaseReadPool,
    session_id: SessionId,
    provider_account_id: Option<ProviderAccountId>,
    row_values: &ProviderRowValues,
) -> Result<ClaudeSpawnContext, ClaudeSpawnContextError> {
    let context = spawn_contexts
        .resolve_spawn_context(session_id, provider_account_id)
        .await
        .map_err(ClaudeSpawnContextError::Place)?;
    let stored = pool
        .read(ReadLength::Short, move |reader| {
            read_stored_settings(reader, &session_id)
        })
        .await?;
    Ok(ClaudeSpawnContext {
        working_directory: context.working_directory,
        every_project_rows: context.every_project_rows,
        project_rows: context.project_rows,
        account_folders: context
            .account_folders
            .as_ref()
            .map(ClaudeAccountFolders::from),
        // Claude Code finds each folder's memory itself; the daemon names none beside them.
        memory_folders: Vec::new(),
        // The session's own advisor and style, else the ones the app keeps for new sessions.
        advisor: stored.advisor.unwrap_or_else(|| {
            read_claude_row_choice(row_values, CLAUDE_ADVISOR_ROW_ID)
                .map_or(ClaudeSessionAdvisor::Unpicked, |choice| {
                    ClaudeSessionAdvisor::of(choice.as_deref())
                })
        }),
        output_style: stored
            .output_style
            .or_else(|| read_claude_row_text(row_values, CLAUDE_OUTPUT_STYLE_ROW_ID)),
    })
}

/// The session's own bound on the steps one turn takes, `None` where none is set. Fails as the
/// read fails.
pub(crate) async fn read_claude_step_bound(
    pool: &Arc<DatabaseReadPool>,
    session_id: SessionId,
) -> Result<Option<SafeInt<1>>, ClaudeStoredReadError> {
    pool.read(ReadLength::Short, move |reader| {
        read_session_max_steps_per_turn(reader, &session_id).map_err(ClaudeStoredReadError::from)
    })
    .await
}

fn read_stored_settings(
    reader: &Connection,
    session_id: &SessionId,
) -> Result<ClaudeStoredSettings, ClaudeStoredReadError> {
    let advisor = read_session_advisor_model(reader, session_id)?
        .map(|advisor_model| ClaudeSessionAdvisor::of(advisor_model.as_deref()));
    let output_style = reader
        .prepare_cached(SELECT_OUTPUT_STYLE_SQL)?
        .query_row(
            [
                session_id.text().as_str(),
                SessionEventType::SessionOutputStyleChanged.as_str(),
            ],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    Ok(ClaudeStoredSettings {
        advisor,
        output_style,
    })
}

/// The choice the app keeps for new sessions on the Settings row `row_id`, where one is chosen.
pub(crate) fn read_claude_row_text(row_values: &ProviderRowValues, row_id: &str) -> Option<String> {
    read_claude_row_choice(row_values, row_id).flatten()
}

/// The pick the app made for new sessions on the choice row `row_id`: `None` where it made none,
/// so Claude Code's own setting holds, and `Some(None)` for the row's none.
#[expect(
    clippy::option_option,
    reason = "a row the app never set differs from one set to its none"
)]
pub(crate) fn read_claude_row_choice(
    row_values: &ProviderRowValues,
    row_id: &str,
) -> Option<Option<String>> {
    let id = ProviderDeclarationId::new(row_id.to_owned()).expect("a row's id fits the id pattern");
    match row_values.as_map().get(&id)? {
        ProviderRowValue::Value(value) => Some(value.as_ref().map(|text| text.as_str().to_owned())),
        ProviderRowValue::Places(_) => None,
    }
}
