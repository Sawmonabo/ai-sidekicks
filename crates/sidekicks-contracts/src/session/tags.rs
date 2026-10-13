//! A session's tags as the person adds and removes them on the inspector, and the tags in use that
//! `Add tag` suggests.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::jsonrpc::page::fits_one_page;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::session::id::SessionId;
use crate::session::methods::SessionVerbResponse;
use crate::tag::{Tag, TagList};
use crate::typescript::{Definition, TypeScriptModule};

/// Adds a tag to a session or removes one. A tag is matched ignoring case and nests with `/`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionTagRequest {
    /// The session.
    pub session_id: SessionId,
    /// The tag.
    pub tag: Tag,
}

/// The tags in use across every session, which `Add tag` suggests. They fit the shared page
/// budget.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionTagListResponse {
    /// The tags.
    #[garde(custom(fits_one_page))]
    pub tags: TagList,
}

methods! {
    /// The session tag methods' wire contract: name, procedure type and types.
    pub const SESSION_TAG_METHOD_DESCRIPTORS = [
        /// Adds a tag to a session.
        SessionTagAdd = mutation "session.tagAdd" {
            mutating: true,
            params: SessionTagRequest,
            result: SessionVerbResponse,
            refusals: [SessionNotFound],
        },
        /// Removes a tag from a session.
        SessionTagRemove = mutation "session.tagRemove" {
            mutating: true,
            params: SessionTagRequest,
            result: SessionVerbResponse,
            refusals: [SessionNotFound],
        },
        /// Lists the tags in use.
        SessionTagList = query "session.tagList" {
            mutating: false,
            params: EmptyPayload,
            result: SessionTagListResponse,
            refusals: [],
        },
    ];
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "session/tags",
    doc: "A session's tags as the person adds and removes them, and the tags in use that `Add \
          tag` suggests.",
    definitions: &[
        Definition::read::<SessionTagRequest>().checked(),
        Definition::read::<SessionTagListResponse>().checked(),
    ],
    constants: &[],
    method_tables: &[&SESSION_TAG_METHOD_DESCRIPTORS],
};
