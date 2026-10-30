//! A remote server's address as a config declares it: stripped to what may leave the driver, and
//! kept whole only in memory, folded, to tell two servers apart.

use std::fmt;

use sidekicks_ipc::redaction::{scrub_credentials, strip_url_queries};
use url::{Position, Url};

/// A remote server's address read from a config: the stripped address a reading carries, the
/// names of the query parameters stripped from it, and its folded whole form where it parses.
pub(crate) struct ServerAddressReading {
    /// The address as the config writes it, with its user name, password, query and fragment
    /// removed and any credential in it scrubbed.
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
        stripped_url: strip_written_address(address),
        query_param_names,
        identity: Some(ServerAddressIdentity(identity)),
    }
}

// `address`, which parses as a web address with a host, as the config writes it with its user name,
// password, query and fragment cut out and any credential left in its path scrubbed, so a `${VAR}`
// in its path reads back as written. The cuts sit where the WHATWG parse finds them: the query or
// fragment at the first `?` or `#`, the authority after `scheme:` and any run of `/` or `\` up to
// the next `/` or `\`, and the user name and password before the authority's last `@`.
fn strip_written_address(address: &str) -> String {
    let written = address.trim_matches(|character: char| character <= ' ');
    let addressed = &written[..written.find(['?', '#']).unwrap_or(written.len())];
    let (scheme, rest) = addressed
        .split_once(':')
        .expect("an address that parses with a host has a scheme");
    let authority_start = rest.len() - rest.trim_start_matches(['/', '\\']).len();
    let (slashes, rest) = rest.split_at(authority_start);
    let (authority, path) = rest.split_at(rest.find(['/', '\\']).unwrap_or(rest.len()));
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_user, host)| host);
    scrub_credentials(&format!("{scheme}:{slashes}{host}{path}"))
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::read_server_address;

    // The stripped address keeps what the config wrote, a `${VAR}` in its path and the case of its
    // host among it, and loses its user name, password, query, fragment and any token in its path,
    // its authority found as the WHATWG parse finds it with no `//`, a `\\` or three slashes before
    // it. Killed by the address taken from the parse's serialization (`$%7BTENANT%7D`, a folded
    // host), by a cut that leaves the user name or the query in, by an authority looked for only
    // after `://`, and by the scrub dropped.
    #[rstest]
    #[case::variable_path(
        "https://mcp.example.com/${TENANT}/mcp?key=secret",
        "https://mcp.example.com/${TENANT}/mcp"
    )]
    #[case::credentials_and_fragment(
        " https://user:p@ss@Mcp.Example.com:8443/mcp#tools ",
        "https://Mcp.Example.com:8443/mcp"
    )]
    #[case::no_path("https://mcp.example.com?sig=abc", "https://mcp.example.com")]
    #[case::no_slashes("https:user:pw@host.example/mcp", "https:host.example/mcp")]
    #[case::backslashes(r"https:\\user:pw@host.example/mcp", r"https:\\host.example/mcp")]
    #[case::three_slashes("https:///user:pw@host.example/mcp", "https:///host.example/mcp")]
    #[case::path_token(
        "https://host.example/mcp/sk-ant-abcdefgh12345",
        "https://host.example/mcp/***"
    )]
    fn a_stripped_address_is_cut_from_what_the_config_wrote(
        #[case] written: &str,
        #[case] stripped: &str,
    ) {
        assert_eq!(read_server_address(written).stripped_url, stripped);
    }
}
