//! A session's inbox addresses, one per place where a provider that messages other sessions is
//! installed, the session's own place first. Each is derived from the session id alone, so it
//! reads the same whether or not a process runs for the session, for the session's whole life.

use std::sync::Arc;

use sidekicks_contracts::place::{Place, WindowsPlace};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionAddress;
use sidekicks_contracts::wire::list::UniqueList;
use sidekicks_platforms::PathRules;
use sidekicks_provider::port::session_inbox_address::SessionInboxAddresser;

/// A place listed for a computer whose own system cannot hold it: on Windows every place, the
/// computer's own system included, is named, and on macOS and Linux none is.
#[derive(Debug, thiserror::Error)]
#[error("{place:?} is not a place on a computer whose own system follows {native_rules:?} rules")]
pub struct ForeignPlaceError {
    /// The place listed.
    pub(crate) place: Option<Place>,
    /// The rules of the computer's own system.
    pub(crate) native_rules: PathRules,
}

/// Composes each session's inbox addresses on this computer.
pub struct SessionInboxAddresses {
    /// The computer's own system: `windows` on Windows, `None` on macOS and Linux.
    own_system: Option<Place>,
    /// The places a messaging provider is installed in, each once.
    installed_places: Vec<Option<Place>>,
    /// Whether the computer has a WSL 2 distribution, whether or not a provider is installed there.
    has_wsl_distribution: bool,
    /// Answers the address in each place.
    addresser: Arc<dyn SessionInboxAddresser>,
}

impl SessionInboxAddresses {
    /// The composer for a computer whose own system follows `native_rules`, with a messaging
    /// provider installed in `installed_places` and addresses answered by `addresser`. Refuses a
    /// place the computer's own system cannot hold: `None` on Windows, any place elsewhere.
    pub fn new(
        native_rules: PathRules,
        installed_places: Vec<Option<Place>>,
        has_wsl_distribution: bool,
        addresser: Arc<dyn SessionInboxAddresser>,
    ) -> Result<Self, ForeignPlaceError> {
        let is_windows = native_rules == PathRules::Windows;
        if let Some(place) = installed_places
            .iter()
            .find(|place| place.is_some() != is_windows)
        {
            return Err(ForeignPlaceError {
                place: place.clone(),
                native_rules,
            });
        }
        Ok(Self {
            own_system: is_windows.then_some(Place::Windows(WindowsPlace::Value)),
            installed_places,
            has_wsl_distribution,
            addresser,
        })
    }

    /// `session_id`'s inbox addresses: its own place's first (the computer's own system where
    /// `own_place` is `None`), then each other installed place's once. The own place's entry is
    /// always built, so the list is never empty; on a computer without a WSL 2 distribution it is
    /// that one entry, naming no place.
    pub fn addresses_of(
        &self,
        session_id: &SessionId,
        own_place: Option<&Place>,
    ) -> UniqueList<SessionAddress, 1, { usize::MAX }> {
        let own_place = own_place.or(self.own_system.as_ref());
        let address_in = |place: Option<&Place>| SessionAddress {
            address: self.addresser.session_inbox_address(session_id, place),
            place: place.cloned().filter(|_| self.has_wsl_distribution),
        };
        let mut addresses = vec![address_in(own_place)];
        if self.has_wsl_distribution {
            for place in &self.installed_places {
                if place.as_ref() != own_place {
                    addresses.push(address_in(place.as_ref()));
                }
            }
        }
        UniqueList::new(addresses).expect("each place is listed once")
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;
    use sidekicks_contracts::free_form_string::FilesystemPath;
    use sidekicks_contracts::place::{Place, WindowsPlace};
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_platforms::PathRules;
    use sidekicks_provider::port::session_inbox_address::SessionInboxAddresser;
    use sidekicks_store::database::writer::test_file::test_session_id;

    use super::SessionInboxAddresses;

    /// Answers each inbox as the place's wire form, then the session id, so a composed list shows
    /// which place each address was asked for.
    struct PlaceNamingAddresser;

    impl SessionInboxAddresser for PlaceNamingAddresser {
        fn session_inbox_address(
            &self,
            session_id: &SessionId,
            place: Option<&Place>,
        ) -> FilesystemPath {
            let place_key = serde_json::to_string(&place).expect("a place serializes");
            FilesystemPath::new(format!("{place_key}/{}", session_id.text().as_str()))
                .expect("the address holds no NUL")
        }

        fn daemon_inbox_address(&self, place: Option<&Place>) -> FilesystemPath {
            let place_key = serde_json::to_string(&place).expect("a place serializes");
            FilesystemPath::new(format!("{place_key}/daemon")).expect("the address holds no NUL")
        }
    }

    #[test]
    fn each_place_gets_its_own_address_and_the_session_s_own_place_comes_first() {
        let session_id = test_session_id();
        let ubuntu: Place =
            serde_json::from_value(json!({ "distro": "Ubuntu" })).expect("a WSL place");
        let windows = Place::Windows(WindowsPlace::Value);
        let addresser: Arc<dyn SessionInboxAddresser> = Arc::new(PlaceNamingAddresser);
        let socket = addresser
            .session_inbox_address(&session_id, Some(&ubuntu))
            .as_str()
            .to_owned();
        let pipe = addresser
            .session_inbox_address(&session_id, Some(&windows))
            .as_str()
            .to_owned();
        let compose = |rules, installed: Vec<Option<Place>>, has_wsl, own: Option<&Place>| {
            let addresses =
                SessionInboxAddresses::new(rules, installed, has_wsl, Arc::clone(&addresser))
                    .expect("the places fit the computer");
            serde_json::to_value(addresses.addresses_of(&session_id, own))
                .expect("the addresses serialize")
        };

        assert_eq!(
            compose(PathRules::Windows, vec![Some(windows.clone())], false, None),
            json!([{ "address": pipe }])
        );
        assert_eq!(
            compose(
                PathRules::Windows,
                vec![Some(windows.clone()), Some(ubuntu.clone())],
                true,
                Some(&ubuntu)
            ),
            json!([
                { "place": { "distro": "Ubuntu" }, "address": socket },
                { "place": "windows", "address": pipe },
            ])
        );
        assert_eq!(
            compose(PathRules::Windows, vec![Some(ubuntu)], true, Some(&windows)),
            json!([
                { "place": "windows", "address": pipe },
                { "place": { "distro": "Ubuntu" }, "address": socket },
            ])
        );
        assert!(
            SessionInboxAddresses::new(PathRules::Windows, vec![None], true, addresser).is_err()
        );
    }
}
