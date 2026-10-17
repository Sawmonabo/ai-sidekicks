//! Where work runs on a computer: Windows itself, or a WSL 2 distribution by name. A project, a
//! session and a provider reading carry a place on a Windows computer; it is written once and never
//! changes.

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
#[serde(deny_unknown_fields)]
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

    use super::{Place, WSL_DISTRO_NAME_MAX_LEN};

    #[test]
    fn a_place_round_trips_in_both_forms_and_refuses_a_too_long_distribution_name() {
        for sent in [json!("windows"), json!({ "distro": "Ubuntu-24.04" })] {
            let place: Place = serde_json::from_value(sent.clone()).expect("the place reads");
            assert_eq!(serde_json::to_value(&place).expect("it writes"), sent);
        }
        let at_the_cap = json!({ "distro": "a".repeat(WSL_DISTRO_NAME_MAX_LEN) });
        assert!(serde_json::from_value::<Place>(at_the_cap).is_ok());
        let past_the_cap = json!({ "distro": "a".repeat(WSL_DISTRO_NAME_MAX_LEN + 1) });
        assert!(serde_json::from_value::<Place>(past_the_cap).is_err());
    }
}
