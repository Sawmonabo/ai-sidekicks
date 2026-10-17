//! A repository mount's ids and states, its probed health and the payload of a health change, and
//! the payload every `workspace.*` and `worktree.*` lifecycle event carries. The mount methods are
//! in `repo::folders`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::{IntoStaticStr, VariantArray};

use crate::event::version::EVENT_FIELD_MAX_LEN;
use crate::internal::branded::branded_uuid_id;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::Never;
use crate::wire::instant::WireInstant;
use crate::wire::text::FreeFormText;

branded_uuid_id! {
    /// The daemon-minted id of one repository mount.
    RepoMountId
}

branded_uuid_id! {
    /// The daemon-minted id of one workspace.
    WorkspaceId
}

/// How a workspace uses its mount: `boundRoot` works in the root already bound to it (the mount's
/// own checkout), `provisionedWorktree` in a worktree the daemon provisions for it.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Hash,
    Serialize,
    Deserialize,
    JsonSchema,
    VariantArray,
    IntoStaticStr,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum ExecutionMode {
    /// The mount's own checkout.
    BoundRoot,
    /// A worktree the daemon provisions.
    ProvisionedWorktree,
}

/// A workspace's lifecycle state. `stale` means its path became unavailable and write runs are
/// blocked until repair.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Hash,
    Serialize,
    Deserialize,
    JsonSchema,
    VariantArray,
    IntoStaticStr,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum WorkspaceState {
    /// Being prepared.
    Preparing,
    /// Ready for runs.
    Ready,
    /// Its path became unavailable.
    Stale,
    /// Archived.
    Archived,
}

/// A mount's lifecycle state. `detached` is terminal: re-attaching creates a new mount rather than
/// reviving the old one.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Hash,
    Serialize,
    Deserialize,
    JsonSchema,
    VariantArray,
    IntoStaticStr,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum RepoMountState {
    /// Attached.
    Attached,
    /// Detached, for good.
    Detached,
    /// Archived.
    Archived,
}

/// The version-control system behind a mount. `repoMount.attach` refuses a path that is not a git
/// repository, so every mount is `git`.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Hash,
    Serialize,
    Deserialize,
    JsonSchema,
    VariantArray,
    IntoStaticStr,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum VcsType {
    /// Git.
    Git,
}

/// A mount's health, probed on every read and never stored. `unreachable` means the root cannot be
/// probed and outranks the rest; `identityMismatch` means the root's git common directory is not
/// the one recorded at attach, and `isRepository` says whether git still answers for the root,
/// which decides whether re-attaching can recover it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum RepoMountHealth {
    /// The root answers as recorded.
    Healthy {
        /// When it was probed.
        #[garde(dive)]
        checked_at: WireInstant,
        /// Only a mismatch says whether git still answers.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        is_repository: Option<Never>,
    },
    /// The root cannot be probed.
    Unreachable {
        /// When it was probed.
        #[garde(dive)]
        checked_at: WireInstant,
        /// Only a mismatch says whether git still answers.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        is_repository: Option<Never>,
    },
    /// The root's git common directory is not the one recorded at attach.
    IdentityMismatch {
        /// Whether git still answers for the root.
        is_repository: bool,
        /// When it was probed.
        #[garde(dive)]
        checked_at: WireInstant,
    },
}

/// The `repoMount.health.changed` payload: a mount's health after the daemon's re-probe changed
/// it, sent on the stream of every session on that mount.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct RepoMountHealthChangedPayload {
    /// The mount.
    pub repo_mount_id: RepoMountId,
    /// Its health now.
    #[garde(dive)]
    pub health: RepoMountHealth,
}

/// Who a lifecycle event names as its actor.
pub type LifecycleActor = FreeFormText<EVENT_FIELD_MAX_LEN>;

/// Declares a lifecycle event's payload over its emitter's state vocabulary, with any members of
/// its own after the shared ones. The subject is whichever id the payload carries; none is
/// required, because a detach's `workspace.archived` names both the mount and the workspace.
macro_rules! lifecycle_payload {
    (
        $(#[doc = $doc:literal])+
        pub struct $name:ident($state:ty) { $($extra:tt)* }
    ) => {
        $(#[doc = $doc])+
        #[derive(
            Clone,
            Debug,
            PartialEq,
            Eq,
            serde::Serialize,
            serde::Deserialize,
            schemars::JsonSchema,
        )]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name {
            /// The envelope's session, repeated so a projector can read the payload alone.
            pub session_id: $crate::session::id::SessionId,
            /// The mount, when it is the subject or beside it.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "crate::repo::mount::RepoMountId")]
            pub repo_mount_id: Option<$crate::repo::mount::RepoMountId>,
            /// The workspace, when it is the subject or beside it.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "crate::repo::mount::WorkspaceId")]
            pub workspace_id: Option<$crate::repo::mount::WorkspaceId>,
            /// The worktree, when it is the subject.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "crate::wire::id::UuidTextForm")]
            pub worktree_id: Option<$crate::wire::id::UuidTextForm>,
            /// The subject's state after the transition.
            pub state: $state,
            /// The envelope's actor, repeated; a system event sends `null` or leaves it out.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                with = "serde_with::rust::double_option"
            )]
            #[schemars(with = "crate::wire::NullableSchema<crate::repo::mount::LifecycleActor>")]
            pub actor: Option<Option<$crate::repo::mount::LifecycleActor>>,
            $($extra)*
        }
    };
}

pub(crate) use lifecycle_payload;

lifecycle_payload! {
    /// The payload of a `workspace.*` lifecycle event.
    pub struct RepoWorkspaceLifecyclePayload(WorkspaceState) {}
}

/// The TypeScript module of a repository mount.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "repo/mount",
    doc: "A repository mount's ids and states, its probed health and the payload of a health \
          change, and the payload every `workspace.*` and `worktree.*` lifecycle event carries.",
    definitions: &[
        Definition::read::<RepoMountId>().checked(),
        Definition::read::<WorkspaceId>().checked(),
        Definition::read::<ExecutionMode>().checked(),
        Definition::read::<WorkspaceState>().checked(),
        Definition::read::<RepoMountState>().checked(),
        Definition::read::<VcsType>().checked(),
        Definition::read::<RepoMountHealth>().checked(),
        Definition::read::<RepoMountHealthChangedPayload>().checked(),
        Definition::read::<RepoWorkspaceLifecyclePayload>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
