//! The volume holding a path: the folder it is mounted at and the id that tells it from another
//! volume across mounts and restarts, each system's module reading both.

use std::fmt;
use std::path::PathBuf;
use std::str::FromStr;

/// The volume holding a path, as [`read_volume`](crate::read_volume) reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Volume {
    /// The folder the volume is mounted at, in [`real_path`](crate::real_path)'s form.
    pub top: PathBuf,
    /// What tells this volume from another across mounts and restarts.
    pub id: VolumeId,
}

/// What tells one volume from another across mounts and restarts, as text a stored row keeps: on
/// macOS the volume's UUID, uppercase and hyphenated; on Linux the mount's source, root and file
/// system type as the mount table writes them, joined by spaces; on Windows the volume GUID path
/// (`\\?\Volume{…}\`).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct VolumeId(String);

impl VolumeId {
    /// The id a system's volume read wrote as `text`, never empty.
    pub(crate) fn new(text: String) -> Self {
        Self(text)
    }
}

/// Text that is no [`VolumeId`]: an empty one.
#[derive(Debug, thiserror::Error)]
#[error("a volume id is never empty")]
pub struct NotAVolumeId;

impl fmt::Display for VolumeId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl FromStr for VolumeId {
    type Err = NotAVolumeId;

    /// Reads an id back from its text; refuses empty text.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        if text.is_empty() {
            return Err(NotAVolumeId);
        }
        Ok(Self(text.to_owned()))
    }
}
