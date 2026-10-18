//! A session's inbox addresses, one per place where a provider that messages other sessions is
//! installed, the session's own place first. Each is derived from the session id alone, so it
//! reads the same whether or not a process runs for the session, for the session's whole life.

use std::sync::Arc;

use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionAddress;
use sidekicks_contracts::wire::list::UniqueList;
use sidekicks_platforms::PathRules;

use crate::provider::port::session_inbox_folder::SessionInboxFolders;

/// Composes each session's inbox addresses on this computer.
pub(crate) struct SessionInboxAddresses {
    /// The rules of the computer's own system.
    native_rules: PathRules,
    /// The places a messaging provider is installed in, `None` the computer's own system.
    installed_places: Vec<Option<Place>>,
    /// The folder each place's inbox socket sits in.
    inbox_folders: Arc<dyn SessionInboxFolders>,
}

impl SessionInboxAddresses {
    /// The composer for a computer whose own system follows `native_rules`, with a messaging
    /// provider installed in `installed_places` and its inbox folders answered by `inbox_folders`.
    pub(crate) fn new(
        native_rules: PathRules,
        installed_places: Vec<Option<Place>>,
        inbox_folders: Arc<dyn SessionInboxFolders>,
    ) -> Self {
        Self {
            native_rules,
            installed_places,
            inbox_folders,
        }
    }

    /// `session_id`'s inbox addresses: its own place's first, then each other installed place's
    /// once. The own place's entry is always built, so the list is never empty; on a computer
    /// without a WSL distribution it is that one entry, naming no place.
    pub(crate) fn addresses_of(
        &self,
        session_id: &SessionId,
        own_place: Option<&Place>,
    ) -> UniqueList<SessionAddress, 1, { usize::MAX }> {
        let has_distributions = own_place
            .into_iter()
            .chain(self.installed_places.iter().flatten())
            .any(|place| matches!(place, Place::Wsl(_)));
        let mut places = vec![own_place.cloned().filter(|_| has_distributions)];
        if has_distributions {
            for place in &self.installed_places {
                if !places.contains(place) {
                    places.push(place.clone());
                }
            }
        }
        let addresses = places
            .into_iter()
            .map(|place| SessionAddress {
                address: self.address_in(session_id, place.as_ref()),
                place,
            })
            .collect();
        UniqueList::new(addresses).expect("each place is listed once")
    }

    // The socket `sidekicks-<session id>.sock` in the place's inbox folder, or on Windows the
    // named pipe `\\.\pipe\sidekicks-<session id>`.
    fn address_in(&self, session_id: &SessionId, place: Option<&Place>) -> FilesystemPath {
        let rules = match place {
            None => self.native_rules,
            Some(Place::Windows(_)) => PathRules::Windows,
            Some(Place::Wsl(_)) => PathRules::Posix,
        };
        let separator = rules.separator();
        let name = format!("sidekicks-{}", session_id.text().as_str());
        let address = match rules {
            PathRules::Windows => {
                format!("{separator}{separator}.{separator}pipe{separator}{name}")
            }
            PathRules::Posix => format!(
                "{}{separator}{name}.sock",
                self.inbox_folders.inbox_folder(place).to_string_lossy()
            ),
        };
        FilesystemPath::new(address).expect("an inbox address is short and holds no NUL")
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;

    use serde_json::json;
    use sidekicks_contracts::place::{Place, WindowsPlace};
    use sidekicks_platforms::PathRules;

    use super::SessionInboxAddresses;
    use crate::database::writer::test_file::test_session_id;
    use crate::provider::port::session_inbox_folder::SessionInboxFolders;

    /// An inbox folder that is the same in every place.
    pub(crate) struct FixedInboxFolder(pub(crate) &'static str);

    impl SessionInboxFolders for FixedInboxFolder {
        fn inbox_folder(&self, _place: Option<&Place>) -> PathBuf {
            PathBuf::from(self.0)
        }
    }

    #[test]
    fn each_place_gets_its_own_form_and_the_session_s_own_place_comes_first() {
        let session_id = test_session_id();
        let id = session_id.text();
        let socket = format!("/tmp/cc-socks/sidekicks-{}.sock", id.as_str());
        let pipe = format!(r"\\.\pipe\sidekicks-{}", id.as_str());
        let ubuntu: Place =
            serde_json::from_value(json!({ "distro": "Ubuntu" })).expect("a WSL place");
        let windows = Place::Windows(WindowsPlace::Value);
        let compose = |rules, installed: Vec<Option<Place>>, own: Option<&Place>| {
            let addresses = SessionInboxAddresses::new(
                rules,
                installed,
                Arc::new(FixedInboxFolder("/tmp/cc-socks")),
            );
            serde_json::to_value(addresses.addresses_of(&session_id, own))
                .expect("the addresses serialize")
        };

        assert_eq!(
            compose(PathRules::Posix, vec![None], None),
            json!([{ "address": socket }])
        );
        assert_eq!(
            compose(
                PathRules::Windows,
                vec![Some(windows.clone())],
                Some(&windows)
            ),
            json!([{ "address": pipe }])
        );
        assert_eq!(
            compose(
                PathRules::Windows,
                vec![Some(windows.clone()), Some(ubuntu.clone())],
                Some(&ubuntu)
            ),
            json!([
                { "place": { "distro": "Ubuntu" }, "address": socket },
                { "place": "windows", "address": pipe },
            ])
        );
    }
}
