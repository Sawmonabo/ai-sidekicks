//! The id of one artifact manifest, the element type of every attachment list.

use crate::internal::branded::branded_uuid_id;
use crate::typescript::{Definition, TypeScriptModule};

branded_uuid_id! {
    /// Identifies an artifact manifest; the element type of every attachment list. It names the
    /// manifest, never its content, which carries a separate SHA-256 `digest`.
    ArtifactId
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "artifacts/id",
    doc: "The id of one artifact manifest, the element type of every attachment list.",
    definitions: &[Definition::read::<ArtifactId>().checked()],
    constants: &[],
    method_tables: &[],
};
