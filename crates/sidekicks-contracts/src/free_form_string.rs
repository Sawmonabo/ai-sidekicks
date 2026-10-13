//! The longest path a wire string may carry, and the path itself. Free-form text is
//! [`FreeFormText`](crate::wire::text::FreeFormText).

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};

use crate::typescript::{TypeScriptModule, ts_constants};
use crate::wire::text::NulFreeText;

ts_constants! {
    /// The longest filesystem path any wire string carries, in code points. 4096 is Linux's
    /// `PATH_MAX`, above macOS's 1024 and Windows' 260-character default; a longer Windows
    /// extended-length path is refused.
    pub const FILE_PATH_MAX_LEN: usize = 4096;
}

/// A filesystem path: 1 to [`FILE_PATH_MAX_LEN`] code points and no NUL, which would cut it short
/// where it reaches the operating system. Blank stays legal, since a folder may be named with a
/// single space.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct FilesystemPath(NulFreeText<FILE_PATH_MAX_LEN>);

impl FilesystemPath {
    /// `path` when it is non-empty, within the cap and holds no NUL, else `None`.
    pub fn new(path: String) -> Option<Self> {
        if path.is_empty() {
            return None;
        }
        NulFreeText::new(path).ok().map(Self)
    }

    /// The path.
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl<'de> Deserialize<'de> for FilesystemPath {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?).ok_or_else(|| {
            D::Error::custom(format!(
                "a path is 1 to {FILE_PATH_MAX_LEN} code points with no NUL"
            ))
        })
    }
}

impl JsonSchema for FilesystemPath {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "FilesystemPath".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let mut schema = NulFreeText::<FILE_PATH_MAX_LEN>::json_schema(generator);
        schema.insert("minLength".into(), 1.into());
        schema
    }
}

/// The TypeScript module of the path cap.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "free-form-string",
    doc: "The longest path a wire string may carry.",
    definitions: &[],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
