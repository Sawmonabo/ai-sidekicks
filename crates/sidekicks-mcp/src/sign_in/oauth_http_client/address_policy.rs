//! Which addresses a server's OAuth calls may reach, judged from the server's own address: its
//! reach, each address's class and the cloud metadata names.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use reqwest::Url;
use url::Host;

use crate::oauth::loopback::{
    embedded_ipv4, is_loopback_address, is_loopback_ip, literal_ip, normalized_host,
};

/// The names cloud providers serve instance metadata under, refused whatever they resolve to.
const CLOUD_METADATA_HOSTS: [&str; 3] = [
    "metadata",
    "metadata.google.internal",
    "metadata.azure.internal",
];

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
        if is_loopback_ip(address) {
            return Self::Loopback;
        }
        match address {
            IpAddr::V4(v4) => Self::of_ipv4(v4),
            IpAddr::V6(v6) => embedded_ipv4(v6).map_or_else(|| Self::of_ipv6(v6), Self::of_ipv4),
        }
    }

    fn of_ipv4(address: Ipv4Addr) -> Self {
        let [first, second, ..] = address.octets();
        if address.is_private() || (first == 100 && (64..=127).contains(&second)) {
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
        if (segments[0] & 0xfe00) == 0xfc00 {
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
