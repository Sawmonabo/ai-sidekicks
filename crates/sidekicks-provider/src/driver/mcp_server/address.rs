//! A remote server's address as a config declares it: stripped to what may leave the driver, and
//! kept whole only in memory, folded, to tell two servers apart.

use std::fmt;

use sidekicks_ipc::redaction::{scrub_credentials, strip_url_queries};
use url::{Position, Url};

/// A remote server's address read from a config: the stripped address a reading carries, the
/// names of the query parameters stripped from it, and its folded whole form where it parses.
pub(crate) struct ServerAddressReading {
    /// The address with its user name, password, query and fragment removed.
    pub(crate) stripped_url: String,
    /// The names of the query's parameters, each once, in the order the address gives them.
    pub(crate) query_param_names: Vec<String>,
    /// The whole address, folded; `None` where it does not parse as an address with a host, as
    /// one holding a `${VAR}` reference does.
    pub(crate) identity: Option<ServerAddressIdentity>,
}

/// A remote server's whole address folded so two spellings of one server compare equal: the case
/// of its scheme and host, its scheme's default port and a trailing slash fold, while its user
/// name, password, path, query and any other port stay apart. It holds credentials, so it lives
/// only in memory, and its `Debug` prints none of it.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct ServerAddressIdentity(String);

impl fmt::Debug for ServerAddressIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ServerAddressIdentity(..)")
    }
}

/// Reads `address`, a remote server's address as a config writes it, into its stripped form and
/// its folded identity. An address that does not parse is scrubbed as text and gets no identity.
pub(crate) fn read_server_address(address: &str) -> ServerAddressReading {
    let Some(url) = Url::parse(address).ok().filter(Url::has_host) else {
        return ServerAddressReading {
            stripped_url: strip_url_queries(&scrub_credentials(address)),
            query_param_names: Vec::new(),
            identity: None,
        };
    };
    let mut query_param_names: Vec<String> = Vec::new();
    for (name, _value) in url.query_pairs() {
        if !query_param_names.iter().any(|kept| *kept == name) {
            query_param_names.push(name.into_owned());
        }
    }
    // The parse already folds the case of a web scheme and host and drops a default port.
    let path = &url[Position::BeforePath..Position::AfterPath];
    let folded_path = path.strip_suffix('/').unwrap_or(path);
    let mut identity = format!("{}{folded_path}", &url[..Position::AfterPort]);
    if let Some(query) = url.query() {
        identity.push('?');
        identity.push_str(query);
    }
    ServerAddressReading {
        stripped_url: format!(
            "{}://{}",
            url.scheme(),
            &url[Position::BeforeHost..Position::AfterPath]
        ),
        query_param_names,
        identity: Some(ServerAddressIdentity(identity)),
    }
}
