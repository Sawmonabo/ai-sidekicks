//! The scalars the git modules share: a commit's short id, a ref name, an address on the
//! hosting service, a change request's number and an id the hosting service minted.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::typescript::{Definition, TypeScriptModule};
use crate::web_address::WebAddress;
use crate::wire::integer::SafeInt;
use crate::wire::named_scalar;
use crate::wire::text::{FreeFormText, branded_text, pattern_text};

pattern_text! {
    /// A commit's short id, git's own abbreviation, which is as long as the repository needs.
    pub struct GitShortObjectId("^[0-9a-f]{4,64}$");
}

/// A branch or other ref name; git's own rule judges it, so the wire sets no length.
pub type GitRefName = FreeFormText<{ usize::MAX }>;

branded_text! {
    /// An id the hosting service minted (a thread, a comment, a check), opaque to every client.
    pub struct HostHandle(1..=usize::MAX);
}

/// A change request's number on its host: `#482` on GitHub, `!482` on GitLab.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(transparent)]
pub struct ChangeRequestNumber(SafeInt<1>);

named_scalar! {
    /// An `http:` or `https:` address on the hosting service, written with its `//` and opened in
    /// the system browser.
    HostingAddress(WebAddress)
}

/// The TypeScript module of the scalars the git modules share.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "git/shared",
    doc: "The scalars the git modules share.",
    definitions: &[
        Definition::read::<GitShortObjectId>().checked(),
        Definition::read::<HostHandle>(),
        Definition::read::<ChangeRequestNumber>().checked(),
        Definition::read::<HostingAddress>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
