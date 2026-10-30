//! The web address: one signed `POST` of each moment's message to the address the person saved.
//! The address is a secret, since chat services put their token in it, so it is kept in the
//! keychain beside its signing secret and shown back only as its scheme and host.

mod message;
mod post;
pub(crate) mod queue;
#[cfg(test)]
mod receiver_double;
pub mod sender;
pub(crate) mod signature;

use reqwest::Url;
use sidekicks_contracts::web_address::WebAddress;
use sidekicks_contracts::wire::text::NonEmptyText;

/// The delivery secrets' keychain account holding the saved address.
pub(crate) const WEB_ADDRESS_ACCOUNT: &str = "web-address";

/// The delivery secrets' keychain account holding the address's signing secret.
pub(crate) const SIGNING_SECRET_ACCOUNT: &str = "web-address-signing-secret";

/// The part of `address` that may be shown back: its scheme and host, `https://ntfy.sh`, with no
/// port, path, query or user info; an IPv6 host keeps its brackets and an international one reads
/// in its ASCII form.
pub(crate) fn shown_host(address: &WebAddress) -> NonEmptyText {
    let parsed = Url::parse(address.as_str()).expect("a web address parses");
    let host = parsed
        .host_str()
        .expect("an http or https address has a host");
    NonEmptyText::new(format!("{}://{host}", parsed.scheme()))
        .expect("a scheme and host are not empty")
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::web_address::WebAddress;
    use sidekicks_contracts::wire::text::NonEmptyText;

    use super::shown_host;

    /// Mutations: the port, path, query or user info kept in what is shown; text with no scheme
    /// and host taken as an address.
    #[rstest]
    #[case::a_path_and_query("https://ntfy.sh/topic?auth=SECRET", Some("https://ntfy.sh"))]
    #[case::a_port(
        "http://homeassistant.local:8123/api/webhook/x",
        Some("http://homeassistant.local")
    )]
    #[case::user_info("https://user:pass@host.example/p", Some("https://host.example"))]
    #[case::ipv6_with_a_port("https://[::1]:9000/x", Some("https://[::1]"))]
    #[case::an_international_host(
        "https://bücher.example/x",
        Some("https://xn--bcher-kva.example")
    )]
    #[case::upper_case("HTTPS://Example.COM/Hook", Some("https://example.com"))]
    #[case::no_scheme("ntfy.sh/topic", None)]
    #[case::a_word("hello", None)]
    #[case::mail("mailto:a@b", None)]
    #[case::ftp("ftp://h/x", None)]
    #[case::no_slashes("http:example.com", None)]
    #[case::no_host("https://", None)]
    fn only_an_address_is_taken_and_only_its_scheme_and_host_shown(
        #[case] text: &str,
        #[case] shown: Option<&str>,
    ) {
        let read = WebAddress::new(text).map(|address| shown_host(&address));
        assert_eq!(read.as_ref().map(NonEmptyText::as_str), shown);
    }
}
