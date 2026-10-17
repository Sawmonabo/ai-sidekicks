//! Where work runs on a computer: Windows itself, or a WSL 2 distribution by name. A project and a
//! session carry one on a Windows computer, written once; a provider's reading carries one where a
//! WSL 2 distribution exists.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::literal;
use crate::wire::text::FreeFormText;

ts_constants! {
    /// The longest WSL distribution name accepted.
    pub const WSL_DISTRO_NAME_MAX_LEN: usize = 256;
}

/// A WSL 2 distribution's name, exactly as `wsl -l` prints it.
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

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "place",
    doc: "Where work runs on a computer: Windows itself, or a WSL 2 distribution by name.",
    definitions: &[Definition::read::<WslPlace>(), Definition::read::<Place>()],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{Place, WindowsPlace, WslPlace};

    #[test]
    fn reads_windows_as_the_literal_and_a_distribution_by_name() {
        let windows: Place = serde_json::from_value(json!("windows")).expect("windows reads");
        assert_eq!(windows, Place::Windows(WindowsPlace::Value));
        let sent = json!({ "distro": "Ubuntu-24.04" });
        let distribution: Place = serde_json::from_value(sent.clone()).expect("a distro reads");
        let Place::Wsl(WslPlace { distro }) = &distribution else {
            panic!("a distribution reads as the WSL arm: {distribution:?}");
        };
        assert_eq!(distro.as_str(), "Ubuntu-24.04");
        assert_eq!(
            serde_json::to_value(&distribution).expect("it writes"),
            sent
        );
        assert_eq!(
            serde_json::to_value(&windows).expect("it writes"),
            json!("windows")
        );
    }
}
