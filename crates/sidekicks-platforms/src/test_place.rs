//! A `Place` for tests: a WSL distribution named Ubuntu.

use sidekicks_contracts::place::{DistroName, Place, WslPlace};

/// The place of a WSL distribution named Ubuntu.
pub fn ubuntu_place() -> Place {
    Place::Wsl(WslPlace {
        distro: DistroName::new("Ubuntu".to_owned()).expect("Ubuntu is a distribution's name"),
    })
}
