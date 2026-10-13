//! The attachments a message carries: artifact ids in the order they were staged.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::artifacts::id::ArtifactId;
use crate::typescript::{Definition, TypeScriptModule};

/// A message's attachments: artifact ids, kept in the order the sender staged them. How many a
/// message carries is what the daemon and the provider accept, never a count of the app's own.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct AttachmentReferenceList(pub Vec<ArtifactId>);

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "artifacts/attachment-reference",
    doc: "The attachments a message carries: artifact ids in the order they were staged.",
    definitions: &[Definition::read::<AttachmentReferenceList>().checked()],
    constants: &[],
    method_tables: &[],
};
