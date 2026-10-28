//! The person's group verbs. Each is one write whose guards decide it, so a check and its change
//! can never be split by another write; the sessions list learns of a change once it has committed.

use std::sync::Arc;

use rusqlite::types::{Type, Value};
use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::name_fold::fold_name;
use sidekicks_contracts::session::groups::{
    SessionGroupCreateRequest, SessionGroupCreateResponse, SessionGroupId, SessionGroupMoveRequest,
    SessionGroupRenameRequest, SessionGroupUngroupRequest,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_ipc::session_not_found::session_not_found;
use sidekicks_store::database::statement::{StatementResult, WriteStatement};
use sidekicks_store::database::stored_column::wrong_type_failure;
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};

use crate::directory::list_feed::SessionListFeed;
use crate::directory::lookups::session_exists_statement;
use crate::groups::store::{
    NewSessionGroup, delete_group_statement, group_exists_statement, group_members_statement,
    group_name_free_for_rename_statement, group_name_free_in_session_project_statement,
    insert_group_statement, leave_group_statement, project_session_statement,
    release_group_sessions_statement, remove_empty_groups_of_session_project_statement,
    rename_group_statement, session_group_placement_statement, session_project_kept_statement,
};

/// Why a group verb failed; a refused verb keeps nothing.
#[derive(Debug, thiserror::Error)]
pub enum SessionGroupError {
    /// The verb was refused: `session.notFound`, `session.group.refused` or
    /// `session.group.nameTaken`.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// The write was not kept.
    #[error(transparent)]
    Write(#[from] WriteError),
    /// The write committed, but a session id it answered is not one, which only a write outside
    /// the session verbs can leave; the sessions list was not told of the change.
    #[error("a session id the group write answered is not a session id")]
    StoredSessionId(#[source] rusqlite::Error),
}

impl From<SessionGroupError> for HandlerError {
    /// A refusal answers with its code; every other failure is a fault in the daemon.
    fn from(error: SessionGroupError) -> Self {
        match error {
            SessionGroupError::Refused(refusal) => Self::Refused(refusal),
            fault @ (SessionGroupError::Write(_) | SessionGroupError::StoredSessionId(_)) => {
                Self::Internal(Box::new(fault))
            }
        }
    }
}

/// Places a project's sessions in named groups: a group is made with a session in it, a session
/// sits in at most one group of its project, a name is unique in its project ignoring case, and a
/// group no session of any state sits in is removed in the write that emptied it.
pub struct SessionGroupService {
    writer: Arc<DatabaseWriter>,
    list_feed: Arc<SessionListFeed>,
}

impl SessionGroupService {
    /// The verbs writing through `writer` and telling `list_feed` which sessions changed group, or
    /// sit in a renamed one, once each write commits.
    pub fn new(writer: Arc<DatabaseWriter>, list_feed: Arc<SessionListFeed>) -> Self {
        Self { writer, list_feed }
    }

    /// Makes a group in the session's project with the session moved into it. Fails with
    /// [`SessionGroupError::Refused`]: `session.notFound`, `session.group.refused` for a chat or a
    /// session whose project was forgotten, or `session.group.nameTaken` when another group of the
    /// project holds the name ignoring case.
    pub async fn create(
        &self,
        request: &SessionGroupCreateRequest,
    ) -> Result<SessionGroupCreateResponse, SessionGroupError> {
        let session_id = request.session_id;
        let group_id =
            SessionGroupId::try_from(mint_uuid_v7()).expect("a minted UUID is a session group id");
        let name_folded = fold_name(request.name.as_str());
        let group = NewSessionGroup {
            group_id,
            session_id,
            name: request.name.as_str().to_owned(),
            name_folded,
            created_at: WireInstant::now().as_str().to_owned(),
        };
        self.write(
            vec![
                session_exists_statement(&session_id),
                project_session_statement(&session_id),
                session_project_kept_statement(&session_id),
                group_name_free_in_session_project_statement(&session_id, &group.name_folded),
                insert_group_statement(&group),
                session_group_placement_statement(&session_id, &group_id),
                remove_empty_groups_of_session_project_statement(&session_id),
            ],
            |statement_index| match statement_index {
                0 => Some(session_not_found(&session_id)),
                1 => Some(group_refusal("A chat sits in no group.", &session_id)),
                2 => Some(group_refusal(
                    "This session's project was forgotten.",
                    &session_id,
                )),
                3 => Some(group_name_taken(request.name.as_str())),
                _ => None,
            },
        )
        .await?;
        self.list_feed.refresh([session_id]);
        Ok(SessionGroupCreateResponse { group_id })
    }

    /// Moves the session into a group of its own project, or out of any group with `groupId`
    /// `null`. Fails with [`SessionGroupError::Refused`]: `session.notFound`, or
    /// `session.group.refused` for a chat or a group not in the session's project.
    pub async fn move_session(
        &self,
        request: &SessionGroupMoveRequest,
    ) -> Result<(), SessionGroupError> {
        let session_id = request.session_id;
        let placement = match &request.group_id {
            Some(group_id) => session_group_placement_statement(&session_id, group_id),
            None => leave_group_statement(&session_id),
        };
        self.write(
            vec![
                session_exists_statement(&session_id),
                placement,
                remove_empty_groups_of_session_project_statement(&session_id),
            ],
            |statement_index| match (statement_index, request.group_id) {
                (0, _) => Some(session_not_found(&session_id)),
                (1, Some(group_id)) => Some(
                    DomainError::new(
                        "The session cannot sit in that group.",
                        RefusalCode::SessionGroupRefused,
                    )
                    .with_detail(json!({ "sessionId": session_id, "groupId": group_id })),
                ),
                _ => None,
            },
        )
        .await?;
        self.list_feed.refresh([session_id]);
        Ok(())
    }

    /// Renames a group, and the list then shows the new name on every session in it. Fails with
    /// [`SessionGroupError::Refused`]: `session.group.refused` when the group no longer exists, or
    /// `session.group.nameTaken` when another group of its project holds the name ignoring case.
    pub async fn rename(
        &self,
        request: &SessionGroupRenameRequest,
    ) -> Result<(), SessionGroupError> {
        let group_id = request.group_id;
        let name_folded = fold_name(request.name.as_str());
        let results = self
            .write(
                vec![
                    group_exists_statement(&group_id),
                    group_name_free_for_rename_statement(&group_id, &name_folded),
                    rename_group_statement(&group_id, request.name.as_str(), &name_folded),
                    group_members_statement(&group_id),
                ],
                |statement_index| match statement_index {
                    0 => Some(
                        DomainError::new(
                            "That group no longer exists.",
                            RefusalCode::SessionGroupRefused,
                        )
                        .with_detail(json!({ "groupId": group_id })),
                    ),
                    1 => Some(group_name_taken(request.name.as_str())),
                    _ => None,
                },
            )
            .await?;
        self.list_feed.refresh(session_ids_of(results.last())?);
        Ok(())
    }

    /// Puts the group's sessions back loose and removes the group; a group already gone is done.
    /// Fails with [`SessionGroupError::Write`] when the write is not kept.
    pub async fn ungroup(
        &self,
        request: &SessionGroupUngroupRequest,
    ) -> Result<(), SessionGroupError> {
        let results = self
            .write(
                vec![
                    release_group_sessions_statement(&request.group_id),
                    delete_group_statement(&request.group_id),
                ],
                |_statement_index| None,
            )
            .await?;
        self.list_feed.refresh(session_ids_of(results.first())?);
        Ok(())
    }

    // Writes `statements` as one write; a statement whose row count refused it answers the refusal
    // `refusal_at` gives its index, and any other failure is the write's own.
    async fn write(
        &self,
        statements: Vec<WriteStatement>,
        refusal_at: impl FnOnce(usize) -> Option<DomainError> + Send,
    ) -> Result<Vec<StatementResult>, SessionGroupError> {
        match self.writer.write(statements).await {
            Ok(results) => Ok(results),
            Err(error) => Err(match error.refused_statement_index().and_then(refusal_at) {
                Some(refusal) => SessionGroupError::Refused(refusal),
                None => SessionGroupError::Write(error),
            }),
        }
    }
}

// The session ids a statement selecting `id` from `sessions` answered.
fn session_ids_of(result: Option<&StatementResult>) -> Result<Vec<SessionId>, SessionGroupError> {
    result
        .map_or(&[][..], |result| result.rows.as_slice())
        .iter()
        .map(|row| match row.first() {
            Some(Value::Text(text)) => SessionId::new(text).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(0, Type::Text, Box::new(error))
            }),
            Some(other @ (Value::Null | Value::Integer(_) | Value::Real(_) | Value::Blob(_))) => {
                Err(wrong_type_failure(0, other))
            }
            None => Err(rusqlite::Error::InvalidColumnIndex(0)),
        })
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(SessionGroupError::StoredSessionId)
}

fn group_refusal(message: &str, session_id: &SessionId) -> DomainError {
    DomainError::new(message, RefusalCode::SessionGroupRefused)
        .with_detail(json!({ "sessionId": session_id }))
}

fn group_name_taken(name: &str) -> DomainError {
    DomainError::new(
        format!("Another group of this project is already named {name}."),
        RefusalCode::SessionGroupNameTaken,
    )
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use rusqlite::{Connection, params};
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::repo::mount::ExecutionMode;
    use sidekicks_contracts::session::directory::{SessionListChange, SessionListEntry};
    use sidekicks_contracts::session::groups::{
        SessionGroupCreateRequest, SessionGroupMoveRequest, SessionGroupRenameRequest,
        SessionGroupUngroupRequest,
    };
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::session::methods::SessionShape;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_contracts::wire::text::FreeFormText;
    use sidekicks_ipc::stream::feed::{CreditGate, Feed as _};
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
    use sidekicks_store::events::log_service::test_fixture::open_log;
    use sidekicks_workspace::test_rows::project_and_mount_rows;
    use tokio::time::timeout;

    use super::{SessionGroupError, SessionGroupService};
    use crate::directory::list_feed::SessionListFeed;
    use crate::directory::list_feed::subscriber::SessionListSubscriber;
    use crate::questions::schema::schema_parts;

    // Bounds the wait for a list change.
    const WAIT: Duration = Duration::from_secs(5);

    // A project session of the project `project_id`, found in it through its create request.
    fn insert_project_session(connection: &Connection, project_id: &str) -> SessionId {
        let session_id = test_session_id();
        let session_text = session_id.text();
        insert_session_row(connection, session_text.as_str(), None, None);
        connection
            .execute(
                "UPDATE sessions SET shape = ?1 WHERE id = ?2",
                params![
                    <&'static str>::from(SessionShape::Project),
                    session_text.as_str()
                ],
            )
            .expect("the test makes the session a project session");
        connection
            .execute(
                "INSERT INTO session_create_requests (client_idempotency_key, session_id, \
                 project_id, execution_mode) VALUES (?1, ?1, ?2, ?3)",
                params![
                    session_text.as_str(),
                    project_id,
                    <&'static str>::from(ExecutionMode::ProvisionedWorktree)
                ],
            )
            .expect("the test stores the session's create request");
        session_id
    }

    fn create_request(session_id: SessionId, name: &str) -> SessionGroupCreateRequest {
        SessionGroupCreateRequest {
            session_id,
            name: FreeFormText::new(name.to_owned()).expect("the test's name is a group name"),
        }
    }

    fn refusal_code(answer: Result<impl std::fmt::Debug, SessionGroupError>) -> RefusalCode {
        match answer {
            Err(SessionGroupError::Refused(refusal)) => refusal.code,
            other => panic!("the verb is refused, got {other:?}"),
        }
    }

    // The group a session's list row shows, waiting past every other change for the session's.
    async fn listed_group(
        subscriber: &mut SessionListSubscriber,
        session_id: SessionId,
    ) -> Option<String> {
        let gate = CreditGate::with_credit(1);
        loop {
            let change = timeout(WAIT, subscriber.next(&gate))
                .await
                .expect("the list changes")
                .expect("the list reads")
                .expect("the list goes on");
            if let SessionListChange::Upsert { entry, .. } = change
                && let SessionListEntry::Project(project) = *entry
                && project.session_id == session_id
            {
                return project.group.map(|group| group.name.as_str().to_owned());
            }
        }
    }

    // Kills: the fold dropped (a name differing only in case would make a second group), the
    // removal of empty groups dropped (the emptied group would stay), and a rename or an ungroup
    // that tells the sessions list of no member, or reads the wrong statement's rows.
    #[tokio::test]
    async fn a_folded_name_is_taken_an_emptied_group_is_removed_and_a_chat_is_refused() {
        let database = TestDatabase::new(schema_parts());
        let log = open_log(&database, None).await;
        let connection = database.reader();
        let project_id = mint_uuid_v7().to_string();
        for row in project_and_mount_rows(&project_id, None) {
            connection
                .execute_batch(&row)
                .expect("the project and its mount are stored");
        }
        let first = insert_project_session(&connection, &project_id);
        let second = insert_project_session(&connection, &project_id);
        let chat = test_session_id();
        insert_session_row(&connection, chat.text().as_str(), None, None);
        let list_feed = SessionListFeed::for_test(&database, &log.followers);
        let groups = SessionGroupService::new(Arc::clone(&log.writer), Arc::clone(&list_feed));
        let group_count = || -> i64 {
            connection
                .query_row("SELECT COUNT(*) FROM session_groups", [], |row| row.get(0))
                .expect("the groups are counted")
        };

        groups
            .create(&create_request(first, "Billing"))
            .await
            .expect("the first group is made");
        assert_eq!(
            refusal_code(groups.create(&create_request(second, "BILLING")).await),
            RefusalCode::SessionGroupNameTaken
        );
        assert_eq!(group_count(), 1);

        groups
            .move_session(&SessionGroupMoveRequest {
                session_id: first,
                group_id: None,
            })
            .await
            .expect("the session leaves its group");
        assert_eq!(group_count(), 0);

        assert_eq!(
            refusal_code(groups.create(&create_request(chat, "Notes")).await),
            RefusalCode::SessionGroupRefused
        );
        assert_eq!(group_count(), 0);

        let mut subscriber = list_feed.open().await.expect("the list opens").subscriber;
        let group_id = groups
            .create(&create_request(second, "Ops"))
            .await
            .expect("the group is made")
            .group_id;
        assert_eq!(
            listed_group(&mut subscriber, second).await.as_deref(),
            Some("Ops")
        );
        groups
            .rename(&SessionGroupRenameRequest {
                group_id,
                name: FreeFormText::new("Release".to_owned()).expect("a group name"),
            })
            .await
            .expect("the group is renamed");
        assert_eq!(
            listed_group(&mut subscriber, second).await.as_deref(),
            Some("Release")
        );
        groups
            .ungroup(&SessionGroupUngroupRequest { group_id })
            .await
            .expect("the group is let go");
        assert_eq!(listed_group(&mut subscriber, second).await, None);
    }
}
