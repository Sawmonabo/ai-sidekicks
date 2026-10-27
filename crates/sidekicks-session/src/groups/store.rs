//! The statements the group verbs write. A chat has no project, so it matches none of these guards.
//! Every check that decides a group write is one of these statements, inside that write.

use std::borrow::Cow;
use std::sync::LazyLock;

use sidekicks_contracts::session::groups::SessionGroupId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionShape;

use crate::directory::lookups::session_project_sql;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};

// The project of the session bound as `@sessionId`.
static SESSION_PROJECT_SQL: LazyLock<String> = LazyLock::new(|| session_project_sql("@sessionId"));

static PLACE_SESSION_SQL: LazyLock<String> = LazyLock::new(|| {
    let project = <&'static str>::from(SessionShape::Project);
    format!(
        "UPDATE sessions SET group_id = @groupId
  WHERE id = @sessionId
    AND shape = '{project}'
    AND EXISTS (SELECT 1 FROM session_groups
                 WHERE id = @groupId AND project_id = {})",
        *SESSION_PROJECT_SQL
    )
});

static PROJECT_SESSION_SQL: LazyLock<String> = LazyLock::new(|| {
    let project = <&'static str>::from(SessionShape::Project);
    format!(
        "SELECT 1 FROM sessions
           WHERE id = @sessionId AND shape = '{project}' AND {} IS NOT NULL",
        *SESSION_PROJECT_SQL
    )
});

static GROUP_NAME_FREE_IN_SESSION_PROJECT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM session_groups
           WHERE project_id = {} AND name_folded = @nameFolded",
        *SESSION_PROJECT_SQL
    )
});

static INSERT_GROUP_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO session_groups (id, project_id, name, name_folded, created_at)
          SELECT @groupId, project.id, @name, @nameFolded, @createdAt
            FROM (SELECT {} AS id) AS project
           WHERE project.id IS NOT NULL",
        *SESSION_PROJECT_SQL
    )
});

static REMOVE_EMPTY_GROUPS_OF_SESSION_PROJECT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "DELETE FROM session_groups
           WHERE project_id = {}
             AND NOT EXISTS (SELECT 1 FROM sessions WHERE group_id = session_groups.id)",
        *SESSION_PROJECT_SQL
    )
});

const LEAVE_GROUP_SQL: &str = "UPDATE sessions SET group_id = NULL WHERE id = @sessionId";

const GROUP_EXISTS_SQL: &str = "SELECT 1 FROM session_groups WHERE id = @groupId";

const GROUP_NAME_FREE_FOR_RENAME_SQL: &str = "SELECT 1 FROM session_groups AS other
           WHERE other.project_id = (SELECT project_id FROM session_groups WHERE id = @groupId)
             AND other.name_folded = @nameFolded
             AND other.id <> @groupId";

const GROUP_MEMBERS_SQL: &str = "SELECT id FROM sessions WHERE group_id = @groupId";

const RENAME_GROUP_SQL: &str =
    "UPDATE session_groups SET name = @name, name_folded = @nameFolded WHERE id = @groupId";

const RELEASE_GROUP_SESSIONS_SQL: &str =
    "UPDATE sessions SET group_id = NULL WHERE group_id = @groupId RETURNING id";

const DELETE_GROUP_SQL: &str = "DELETE FROM session_groups WHERE id = @groupId";

/// A group to make in a session's project.
#[derive(Clone, Debug)]
pub(crate) struct NewSessionGroup {
    /// The new group's id.
    pub(crate) group_id: SessionGroupId,
    /// The session whose project the group belongs to.
    pub(crate) session_id: SessionId,
    /// The group's name as the person wrote it.
    pub(crate) name: String,
    /// The name's fold, which keeps two groups of one project from sharing a name.
    pub(crate) name_folded: String,
    /// When it was made.
    pub(crate) created_at: String,
}

/// Puts the session in the group: one UPDATE of `sessions.group_id` that holds only while the
/// session is a project session and the group belongs to its project, expecting one row. A refusal
/// means a chat, a group of another project, or no such group or session.
pub(crate) fn session_group_placement_statement(
    session_id: &SessionId,
    group_id: &SessionGroupId,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(PLACE_SESSION_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@sessionId", session_id.text().as_str()),
            text_binding("@groupId", group_id.text().as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

/// Holds only while the session is a project session bound to its project.
pub(crate) fn project_session_statement(session_id: &SessionId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(PROJECT_SESSION_SQL.as_str()),
        bindings: StatementBindings::Named(vec![text_binding(
            "@sessionId",
            session_id.text().as_str(),
        )]),
        expected_row_count: Some(1),
    }
}

/// Holds only while no group of the session's project carries the folded name.
pub(crate) fn group_name_free_in_session_project_statement(
    session_id: &SessionId,
    name_folded: &str,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(GROUP_NAME_FREE_IN_SESSION_PROJECT_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@sessionId", session_id.text().as_str()),
            text_binding("@nameFolded", name_folded),
        ]),
        expected_row_count: Some(0),
    }
}

/// Makes a group in the session's project; refused when the session has no project.
pub(crate) fn insert_group_statement(group: &NewSessionGroup) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(INSERT_GROUP_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@groupId", group.group_id.text().as_str()),
            text_binding("@sessionId", group.session_id.text().as_str()),
            text_binding("@name", &group.name),
            text_binding("@nameFolded", &group.name_folded),
            text_binding("@createdAt", &group.created_at),
        ]),
        expected_row_count: Some(1),
    }
}

/// Takes the session out of any group; a chat, in none, changes nothing but still matches.
pub(crate) fn leave_group_statement(session_id: &SessionId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(LEAVE_GROUP_SQL),
        bindings: StatementBindings::Named(vec![text_binding(
            "@sessionId",
            session_id.text().as_str(),
        )]),
        expected_row_count: Some(1),
    }
}

/// Removes every group of the session's project that no session sits in, so a move that empties a
/// group removes it in the same write.
pub(crate) fn remove_empty_groups_of_session_project_statement(
    session_id: &SessionId,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(REMOVE_EMPTY_GROUPS_OF_SESSION_PROJECT_SQL.as_str()),
        bindings: StatementBindings::Named(vec![text_binding(
            "@sessionId",
            session_id.text().as_str(),
        )]),
        expected_row_count: None,
    }
}

/// Holds only while the group exists.
pub(crate) fn group_exists_statement(group_id: &SessionGroupId) -> WriteStatement {
    group_statement(GROUP_EXISTS_SQL, group_id, Some(1))
}

/// Holds only while no other group of the group's project carries the folded name.
pub(crate) fn group_name_free_for_rename_statement(
    group_id: &SessionGroupId,
    name_folded: &str,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(GROUP_NAME_FREE_FOR_RENAME_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@groupId", group_id.text().as_str()),
            text_binding("@nameFolded", name_folded),
        ]),
        expected_row_count: Some(0),
    }
}

/// Answers the ids of the sessions sitting in the group.
pub(crate) fn group_members_statement(group_id: &SessionGroupId) -> WriteStatement {
    group_statement(GROUP_MEMBERS_SQL, group_id, None)
}

/// Renames the group, writing the fold beside the name.
pub(crate) fn rename_group_statement(
    group_id: &SessionGroupId,
    name: &str,
    name_folded: &str,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(RENAME_GROUP_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@groupId", group_id.text().as_str()),
            text_binding("@name", name),
            text_binding("@nameFolded", name_folded),
        ]),
        expected_row_count: Some(1),
    }
}

/// Puts every session of the group back loose and answers their ids.
pub(crate) fn release_group_sessions_statement(group_id: &SessionGroupId) -> WriteStatement {
    group_statement(RELEASE_GROUP_SESSIONS_SQL, group_id, None)
}

/// Removes the group itself.
pub(crate) fn delete_group_statement(group_id: &SessionGroupId) -> WriteStatement {
    group_statement(DELETE_GROUP_SQL, group_id, None)
}

/// A statement that binds only the group as `@groupId`.
fn group_statement(
    sql: &'static str,
    group_id: &SessionGroupId,
    expected_row_count: Option<usize>,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(sql),
        bindings: StatementBindings::Named(vec![text_binding(
            "@groupId",
            group_id.text().as_str(),
        )]),
        expected_row_count,
    }
}
