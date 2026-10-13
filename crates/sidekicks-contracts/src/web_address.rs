//! The one rule every web address the app opens is held to: only `http:` and `https:`. A user name
//! or a password in the authority is part of an address as typed and is not refused. Only an
//! already parsed address is judged; turning typed text into an address is the caller's parsing.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::typescript::{Definition, TypeScriptModule, ts_constants};

ts_constants! {
    /// The schemes a web address may carry, in the WHATWG parser's form, which is always lower
    /// case and ends in a colon.
    pub const WEB_ADDRESS_SCHEMES: &[&str] = &["http:", "https:"];
    /// Every [`WebAddressFault`].
    WEB_ADDRESS_FAULTS = WebAddressFault::ALL;
}

/// Why a parsed address is not a web address the app opens: `scheme` when its scheme is neither
/// `http:` nor `https:`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum WebAddressFault {
    /// The scheme is neither `http:` nor `https:`.
    Scheme,
}

impl WebAddressFault {
    /// Every fault.
    pub const ALL: &[Self] = &[Self::Scheme];
}

/// Judges one parsed address against the rule: the fault, or `None` when it passes. The fault
/// names the class of the problem and never echoes the address, so it is safe to log.
pub fn web_address_fault(address: &Url) -> Option<WebAddressFault> {
    let scheme = address.scheme();
    let is_web = WEB_ADDRESS_SCHEMES
        .iter()
        .any(|allowed| allowed.strip_suffix(':') == Some(scheme));
    (!is_web).then_some(WebAddressFault::Scheme)
}

/// The TypeScript module of the web-address rule.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "web-address",
    doc: "The one rule every web address the app opens is held to: only `http:` and `https:`.",
    definitions: &[Definition::read::<WebAddressFault>()],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use url::Url;

    use super::{WebAddressFault, web_address_fault};

    /// One case of the table the TypeScript rule also reads.
    #[derive(Deserialize)]
    struct WebAddressCase {
        address: String,
        fault: Option<WebAddressFault>,
    }

    #[test]
    fn an_address_passes_only_with_a_web_scheme() {
        let cases: Vec<WebAddressCase> =
            serde_json::from_str(include_str!("../tests/fixtures/web-address.json"))
                .expect("the case table reads");
        for case in cases {
            let address = Url::parse(&case.address).expect("each address parses");
            assert_eq!(web_address_fault(&address), case.fault, "{}", case.address);
        }
    }
}
