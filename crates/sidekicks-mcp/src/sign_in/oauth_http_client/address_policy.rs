//! Which addresses a server's OAuth calls may reach, judged from the server's own address: its
//! reach, each address's class, the cloud metadata names, and what counts as loopback.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use reqwest::Url;
use url::Host;

/// The names cloud providers serve instance metadata under, refused whatever they resolve to.
const CLOUD_METADATA_HOSTS: [&str; 3] = [
    "metadata",
    "metadata.google.internal",
    "metadata.azure.internal",
];

/// `host` as names are compared: lowercase, without a trailing dot.
pub(super) fn normalized_host(host: &str) -> String {
    host.trim_end_matches('.').to_ascii_lowercase()
}

/// Whether `address`'s host is loopback: `localhost` or a name under it, compared as names are,
/// or a loopback literal, an IPv4 one an IPv6 address carries included.
pub(crate) fn is_loopback_address(address: &Url) -> bool {
    match address.host() {
        Some(Host::Domain(domain)) => {
            let host = normalized_host(domain);
            host == "localhost" || host.ends_with(".localhost")
        }
        Some(_) => {
            literal_ip(address).is_some_and(|ip| AddressClass::of(ip) == AddressClass::Loopback)
        }
        None => false,
    }
}

/// What a server's own address lets its OAuth calls reach besides public addresses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ServerReach {
    /// Public addresses only.
    Public,
    /// Loopback addresses too: the server is `localhost` or a loopback literal.
    Loopback,
    /// Private addresses too: the server is a private literal.
    Private,
}

impl ServerReach {
    /// Whether an address of `class` is in this reach.
    pub(super) fn allows(self, class: AddressClass) -> bool {
        match class {
            AddressClass::Public => true,
            AddressClass::Loopback => self == Self::Loopback,
            AddressClass::Private => self == Self::Private,
            AddressClass::Blocked => false,
        }
    }
}

/// The filter's judgment for one server: its reach and its own literal address, if it has one.
#[derive(Debug, Clone, Copy)]
pub(super) struct AddressPolicy {
    /// What the server's address lets its calls reach.
    pub(super) reach: ServerReach,
    server_ip: Option<IpAddr>,
}

impl AddressPolicy {
    /// The policy of the server at `server`.
    pub(super) fn of_server(server: &Url) -> Self {
        let server_ip = literal_ip(server);
        let reach = if is_loopback_address(server) {
            ServerReach::Loopback
        } else if server_ip.map(AddressClass::of) == Some(AddressClass::Private) {
            ServerReach::Private
        } else {
            ServerReach::Public
        };
        Self { reach, server_ip }
    }

    /// Whether a call may go to `url`: a literal host by its class or as the server's own
    /// literal; a name unless it is a cloud metadata name, its addresses judged as it resolves.
    pub(super) fn allows_url(&self, url: &Url) -> bool {
        match url.host() {
            Some(Host::Domain(domain)) => !is_cloud_metadata_name(&normalized_host(domain)),
            Some(_) => literal_ip(url).is_some_and(|ip| {
                self.server_ip == Some(ip) || self.reach.allows(AddressClass::of(ip))
            }),
            None => false,
        }
    }
}

/// Whether `host` is a name cloud providers serve instance metadata under.
pub(super) fn is_cloud_metadata_name(host: &str) -> bool {
    CLOUD_METADATA_HOSTS.contains(&host)
}

// The address `url` names as a literal host.
fn literal_ip(url: &Url) -> Option<IpAddr> {
    match url.host()? {
        Host::Ipv4(v4) => Some(IpAddr::V4(v4)),
        Host::Ipv6(v6) => Some(IpAddr::V6(v6)),
        Host::Domain(_) => None,
    }
}

/// The class of an address the filter judges.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AddressClass {
    Public,
    Loopback,
    Private,
    /// Link-local, unspecified, broadcast, multicast or reserved: never reached.
    Blocked,
}

impl AddressClass {
    /// The class of `address`, an IPv4 address an IPv6 one carries judged as that IPv4 address.
    pub(super) fn of(address: IpAddr) -> Self {
        match address {
            IpAddr::V4(v4) => Self::of_ipv4(v4),
            IpAddr::V6(v6) => embedded_ipv4(v6).map_or_else(|| Self::of_ipv6(v6), Self::of_ipv4),
        }
    }

    fn of_ipv4(address: Ipv4Addr) -> Self {
        let [first, second, ..] = address.octets();
        if address.is_loopback() {
            Self::Loopback
        } else if address.is_private() || (first == 100 && (64..=127).contains(&second)) {
            Self::Private
        } else if address.is_link_local()
            || address.is_multicast()
            || first == 0
            || first >= 240
            || (first == 198 && matches!(second, 18 | 19))
        {
            Self::Blocked
        } else {
            Self::Public
        }
    }

    fn of_ipv6(address: Ipv6Addr) -> Self {
        let segments = address.segments();
        if address.is_loopback() {
            Self::Loopback
        } else if (segments[0] & 0xfe00) == 0xfc00 {
            Self::Private
        } else if address.is_unspecified()
            || address.is_multicast()
            || (segments[0] & 0xffc0) == 0xfe80
            || segments[..2] == [0x2001, 0]
            || segments[..3] == [0x64, 0xff9b, 1]
        {
            Self::Blocked
        } else {
            Self::Public
        }
    }
}

// The IPv4 address an IPv6 address carries: mapped, compatible, NAT64 (`64:ff9b::/96`) or 6to4
// (`2002::/16`). Teredo and local NAT64 are blocked by their own prefixes instead.
fn embedded_ipv4(address: Ipv6Addr) -> Option<Ipv4Addr> {
    let segments = address.segments();
    let last_two = Ipv4Addr::from((u32::from(segments[6]) << 16) | u32::from(segments[7]));
    match segments {
        [0, 0, 0, 0, 0, 0xffff, ..] | [0x64, 0xff9b, 0, 0, 0, 0, ..] => Some(last_two),
        [0, 0, 0, 0, 0, 0, ..] if !address.is_loopback() && !address.is_unspecified() => {
            Some(last_two)
        }
        [0x2002, high, low, ..] => Some(Ipv4Addr::from((u32::from(high) << 16) | u32::from(low))),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use reqwest::Url;
    use rstest::rstest;

    use super::is_loopback_address;

    // Mutations: compare names without folding case and the trailing dot, judge an IPv6 literal
    // by its text, or skip the IPv4 address an IPv6 one carries.
    #[rstest]
    #[case::localhost("http://localhost:8080/callback", true)]
    #[case::localhost_in_capitals_with_its_dot("http://LOCALHOST.:8080/", true)]
    #[case::a_name_under_localhost("http://mcp.localhost/", true)]
    #[case::an_ipv4_loopback("http://127.0.0.1:7341/callback", true)]
    #[case::another_ipv4_loopback("http://127.8.9.10/", true)]
    #[case::the_ipv6_loopback("http://[::1]:7341/callback", true)]
    #[case::a_mapped_ipv4_loopback("http://[::ffff:127.0.0.1]/", true)]
    #[case::a_name_ending_in_localhost("http://notlocalhost/", false)]
    #[case::localhost_under_a_public_name("http://localhost.example.com/", false)]
    #[case::a_private_literal("http://10.0.0.1/", false)]
    #[case::another_ipv6_literal("http://[::2]/", false)]
    #[case::a_public_name("https://callback.example.com/oauth", false)]
    fn a_loopback_address_is_localhost_or_a_loopback_literal(
        #[case] address: &str,
        #[case] is_loopback: bool,
    ) {
        assert_eq!(
            is_loopback_address(&Url::parse(address).expect("a URL")),
            is_loopback
        );
    }
}
