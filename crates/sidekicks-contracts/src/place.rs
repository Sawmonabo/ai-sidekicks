//! Where work runs on a computer: Windows itself, or a WSL 2 distribution by name. A project and a
//! session carry one on a Windows computer, written once; a provider's reading carries one where a
//! WSL 2 distribution exists.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::free_form_string::FilesystemPath;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::list::ListKey;
use crate::wire::literal;
use crate::wire::text::FreeFormText;

ts_constants! {
    /// The longest WSL distribution name accepted.
    pub const WSL_DISTRO_NAME_MAX_LEN: usize = 256;
}

/// A WSL distribution's name.
pub type DistroName = FreeFormText<WSL_DISTRO_NAME_MAX_LEN>;

literal! {
    /// Windows itself.
    pub enum WindowsPlace = "windows";
}

/// A WSL distribution, named exactly as `wsl -l` prints it. Work runs only in a WSL 2
/// distribution; a WSL 1 one appears only as a provider's `Command` row that says it needs WSL 2.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WslPlace {
    /// The distribution's name.
    pub distro: DistroName,
}

/// Where work runs: `"windows"`, or `{distro}` for a WSL 2 distribution. A provider's `Command`
/// row may also name a WSL 1 distribution, the one place no work runs.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Place {
    /// Windows itself.
    Windows(WindowsPlace),
    /// A WSL distribution.
    Wsl(WslPlace),
}

/// A path, and the WSL 2 distribution it is in where it is in Linux form there; the place is absent
/// wherever the path's own form says it.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlacedPath {
    /// The path.
    pub path: FilesystemPath,
    /// The distribution.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WslPlace")]
    pub place: Option<WslPlace>,
}

// A place, a distribution's name and a placed path carry no rule their read does not hold.
impl ListKey for Place {
    type Key = Self;

    fn list_key(&self) -> Self {
        self.clone()
    }

    fn validate_item(&self, _parent: &mut dyn FnMut() -> garde::Path, _report: &mut garde::Report) {
    }
}

impl ListKey for WslPlace {
    type Key = Self;

    fn list_key(&self) -> Self {
        self.clone()
    }

    fn validate_item(&self, _parent: &mut dyn FnMut() -> garde::Path, _report: &mut garde::Report) {
    }
}

impl ListKey for DistroName {
    type Key = Self;

    fn list_key(&self) -> Self {
        self.clone()
    }

    fn validate_item(&self, _parent: &mut dyn FnMut() -> garde::Path, _report: &mut garde::Report) {
    }
}

impl ListKey for PlacedPath {
    type Key = Self;

    fn list_key(&self) -> Self {
        self.clone()
    }

    fn validate_item(&self, _parent: &mut dyn FnMut() -> garde::Path, _report: &mut garde::Report) {
    }
}

/// The details of a refusal naming a WSL distribution, a repository's or a provider's: the
/// distribution the request names, exactly as given.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DistributionRefusalDetails {
    /// The distribution.
    pub distro: DistroName,
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "place",
    doc: "Where work runs on a computer: Windows itself, or a WSL 2 distribution by name.",
    definitions: &[
        Definition::read::<WslPlace>(),
        Definition::read::<Place>(),
        Definition::read::<PlacedPath>(),
        Definition::read::<DistributionRefusalDetails>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{Place, WindowsPlace};

    #[test]
    fn reads_and_writes_windows_as_its_literal() {
        let windows: Place = serde_json::from_value(json!("windows")).expect("windows reads");
        assert_eq!(windows, Place::Windows(WindowsPlace::Value));
        assert_eq!(
            serde_json::to_value(&windows).expect("it writes"),
            json!("windows")
        );
    }
}
