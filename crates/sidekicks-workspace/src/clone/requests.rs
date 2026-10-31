//! A clone start's key record: what a start under a client's key asked, kept beside the project it
//! made, so a resend of that request answers the same project and a different request under the
//! key is refused. The address is kept with any user and password taken out, so two requests that
//! differ only in their credentials read the same.

use std::borrow::Cow;
use std::sync::Arc;

use rusqlite::types::Value;
use rusqlite::{OptionalExtension, named_params};
use sidekicks_contracts::place::Place;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::repo::clone::ProjectCloneStartRequest;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, place_value, text_binding,
};
use sidekicks_store::database::stored_column::text_column;

use crate::clone::destination::address_without_credentials;
use crate::project::records::ProjectReadError;

/// The statements the key record's read prepares, counted into the read pool's statement capacity.
pub const CLONE_REQUESTS_STATEMENT_CAPACITY: usize = 1;

const KEY_RECORD_SQL: &str = "SELECT project_id, clone_url, parent_folder, place, rerun_project_id
  FROM project_clone_requests
 WHERE client_idempotency_key = @key";

const INSERT_KEY_RECORD_SQL: &str = "INSERT INTO project_clone_requests (
    client_idempotency_key, project_id, clone_url, parent_folder, place, rerun_project_id
  ) VALUES (@key, @project_id, @clone_url, @parent_folder, @place, @rerun_project_id)";

/// A start request's own fields as its key record keeps and compares them: the address without
/// credentials, the parent folder, the place and the project run again, each as sent.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CloneRequestFields([Value; 4]);

impl CloneRequestFields {
    /// The fields of `request`, in the record's columns' form.
    pub(crate) fn of(request: &ProjectCloneStartRequest) -> Self {
        let place = request.place.clone().map(Place::Wsl);
        Self([
            Value::Text(address_without_credentials(request.url.as_str())),
            Value::from(
                request
                    .parent_folder
                    .as_ref()
                    .map(|folder| folder.as_str().to_owned()),
            ),
            place_value(place.as_ref()),
            Value::from(
                request
                    .project_id
                    .map(|project_id| project_id.text().as_str().to_owned()),
            ),
        ])
    }

    /// The statement that keeps these fields under `key` for `project_id`, run in the write that
    /// inserts or retargets the project.
    pub(crate) fn record_statement(
        &self,
        key: &ClientUuid,
        project_id: ProjectId,
    ) -> WriteStatement {
        let [clone_url, parent_folder, place, rerun_project_id] = self.0.clone();
        WriteStatement {
            sql: Cow::Borrowed(INSERT_KEY_RECORD_SQL),
            bindings: StatementBindings::Named(vec![
                text_binding("@key", key.as_str()),
                text_binding("@project_id", project_id.text().as_str()),
                (Cow::Borrowed("@clone_url"), clone_url),
                (Cow::Borrowed("@parent_folder"), parent_folder),
                (Cow::Borrowed("@place"), place),
                (Cow::Borrowed("@rerun_project_id"), rerun_project_id),
            ]),
            expected_row_count: Some(1),
        }
    }
}

/// What a start's key answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum KeyRecord {
    /// No start used the key: the start goes on.
    New,
    /// The key's start asked the same: answer its project, running nothing again.
    Answers(ProjectId),
    /// The key's start asked something else: refuse, naming its project.
    Conflicts(ProjectId),
}

/// Reads what the start under `key` asked and compares it with `fields`. A record whose project
/// was forgotten went with it, so the key reads as new. Fails as the read fails.
pub(crate) async fn read_key_record(
    reads: &Arc<DatabaseReadPool>,
    key: &ClientUuid,
    fields: CloneRequestFields,
) -> Result<KeyRecord, ProjectReadError> {
    let key = key.as_str().to_owned();
    reads
        .read(ReadLength::Short, move |connection| {
            let recorded = connection
                .prepare_cached(KEY_RECORD_SQL)?
                .query_row(named_params! { "@key": key }, |row| {
                    let project_id = text_column(row, 0, |text| ProjectId::new(&text))?;
                    let recorded =
                        CloneRequestFields([row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?]);
                    Ok((project_id, recorded))
                })
                .optional()?;
            Ok(match recorded {
                None => KeyRecord::New,
                Some((project_id, recorded)) if recorded == fields => {
                    KeyRecord::Answers(project_id)
                }
                Some((project_id, _)) => KeyRecord::Conflicts(project_id),
            })
        })
        .await
}
