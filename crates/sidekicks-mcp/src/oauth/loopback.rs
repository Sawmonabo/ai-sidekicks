//! Whether an address is loopback, judged one way for the redirect receiver's owner-issued
//! callback and for the reach of a server's OAuth calls, with the host readings that judgment
//! rests on.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use reqwest::Url;
use url::Host;

/// `host` as names are compared: lowercase, without a trailing dot.
pub(crate) fn normalized_host(host: &str) -> String {
    host.trim_end_matches('.').to_ascii_lowercase()
}

/// The address `url` names as a literal host, or `None` for a name.
pub(crate) fn literal_ip(url: &Url) -> Option<IpAddr> {
    match url.host()? {
        Host::Ipv4(v4) => Some(IpAddr::V4(v4)),
        Host::Ipv6(v6) => Some(IpAddr::V6(v6)),
        Host::Domain(_) => None,
    }
}

/// The IPv4 address an IPv6 address carries: mapped, compatible, NAT64 (`64:ff9b::/96`) or 6to4
/// (`2002::/16`). Teredo and local NAT64 carry none here; the address filter blocks them by their
/// own prefixes.
pub(crate) fn embedded_ipv4(address: Ipv6Addr) -> Option<Ipv4Addr> {
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

/// Whether `address` is loopback, an IPv4 address an IPv6 one carries judged as that address.
pub(crate) fn is_loopback_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => embedded_ipv4(v6).map_or_else(|| v6.is_loopback(), |v4| v4.is_loopback()),
    }
}

/// Whether `address`'s host is loopback: `localhost` or a name under it, compared as names are,
/// or a loopback literal, an IPv4 one an IPv6 address carries included.
pub(crate) fn is_loopback_address(address: &Url) -> bool {
    match address.host() {
        Some(Host::Domain(domain)) => {
            let host = normalized_host(domain);
            host == "localhost" || host.ends_with(".localhost")
        }
        Some(_) => literal_ip(address).is_some_and(is_loopback_ip),
        None => false,
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
