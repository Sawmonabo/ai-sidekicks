//! A run's checkout: where it works, the checkout that holds that folder, and the place of the
//! repository it was mounted from, read from its execution context. A chat's own folder writes no
//! context, so a chat's run reads none here.

use std::path::PathBuf;

use rusqlite::{Connection, OptionalExtension as _, named_params};
use sidekicks_contracts::place::Place;
use sidekicks_contracts::run::id::RunId;
use sidekicks_store::database::stored_column::optional_text_column;

/// The statements [`read_run_checkout`] prepares on a pooled connection: the run's checkout and
/// place.
pub const RUN_CHECKOUT_STATEMENT_CAPACITY: usize = 1;

// The run's checkout and the place of the repository it was mounted from, by its execution
// context.
const SELECT_RUN_CHECKOUT_SQL: &str = "SELECT context.execution_root, context.checkout_root,
       mount.place
  FROM run_execution_contexts AS context
  JOIN workspaces AS workspace ON workspace.id = context.workspace_id
  JOIN repo_mounts AS mount ON mount.id = workspace.repo_mount_id
 WHERE context.run_id = @run_id";

/// Where a run works and the place git runs for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunCheckout {
    /// Where the run executes: the worktree, or the bound folder of a bound root.
    pub execution_root: PathBuf,
    /// The top level of the working tree holding the execution root.
    pub checkout_root: PathBuf,
    /// Where git runs for the repository, `None` on macOS and Linux.
    pub place: Option<Place>,
}

/// The checkout `run_id` works in, `None` for a run with no execution context. Fails as SQLite
/// does, or when a stored place does not read.
pub fn read_run_checkout(
    reader: &Connection,
    run_id: RunId,
) -> rusqlite::Result<Option<RunCheckout>> {
    reader
        .prepare_cached(SELECT_RUN_CHECKOUT_SQL)?
        .query_row(named_params! { "@run_id": run_id.text().as_str() }, |row| {
            Ok(RunCheckout {
                execution_root: PathBuf::from(row.get::<_, String>(0)?),
                checkout_root: PathBuf::from(row.get::<_, String>(1)?),
                // The column holds the place's wire JSON.
                place: optional_text_column(row, 2, |text| serde_json::from_str::<Place>(&text))?,
            })
        })
        .optional()
}
