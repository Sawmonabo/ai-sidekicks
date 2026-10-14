//! The dev servers the daemon discovers listening in a session's project.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::session::id::SessionId;
use crate::wire::integer::Port;
use crate::wire::text::NonEmptyText;

/// The session whose project's dev servers a `preview.devServerList` subscription streams.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewDevServerListRequest {
    /// The session.
    pub session_id: SessionId,
}

/// One dev server the daemon found listening in the session's project. `name` and `framework` are
/// `null` where the daemon could not tell; `startedHere` means this session started it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewDevServer {
    /// Its port.
    pub port: Port,
    /// The name it gave.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<NonEmptyText>")]
    pub name: Option<NonEmptyText>,
    /// Its framework.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<NonEmptyText>")]
    pub framework: Option<NonEmptyText>,
    /// Whether this session started it, by its agent or in its own shell.
    pub started_here: bool,
}

/// One frame of the discovered servers: every server listening now. The stream sends the newest
/// list once the reader has room, never a queue of the lists between.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(transparent)]
#[garde(allow_unvalidated)]
pub struct PreviewDevServerListFrame(pub Vec<PreviewDevServer>);
