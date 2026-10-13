//! Where the background service runs on a Windows computer, and the record that says so: on
//! Windows itself or inside one WSL 2 distribution, wherever the person's Claude Code and Codex are
//! installed. The place is known before any service exists, so it is kept in a per-user Windows
//! file apart from the service's own settings; a backup's manifest names the same place.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::free_form_string::FilesystemPath;
use crate::release_manifest::{ReleaseVersion, Sha256Hex};
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::literal;
use crate::wire::text::FreeFormText;

ts_constants! {
    /// The record's file name, in `%LOCALAPPDATA%\ai-sidekicks\`.
    pub const SERVICE_RECORD_FILE_NAME: &str = "service.json";
    /// The longest WSL distribution name accepted.
    pub const WSL_DISTRO_NAME_MAX_LEN: usize = 256;
}

literal! {
    /// The service runs on Windows itself.
    pub enum WindowsPlace = "windows";
}

/// The service runs inside a WSL distribution, named here.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WslPlace {
    /// The distribution's name.
    pub distro: FreeFormText<WSL_DISTRO_NAME_MAX_LEN>,
}

/// A place the service can run on Windows: Windows itself, or a WSL distribution by name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ServicePlaceLocation {
    /// Windows itself.
    Windows(WindowsPlace),
    /// A WSL distribution.
    Wsl(WslPlace),
}

/// The record when the service runs on Windows itself.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WindowsServiceRecord {
    /// Always `windows`.
    pub place: WindowsPlace,
}

/// The record when the service runs inside a WSL distribution, from the runtime the app installed
/// there: the runtime's release, the SHA-256 of its archive (which also names its folder), and the
/// distribution's home folder as the install resolved it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WslServiceRecord {
    /// The distribution.
    pub place: WslPlace,
    /// The installed runtime's release.
    pub runtime_version: ReleaseVersion,
    /// The SHA-256 of the runtime's archive.
    pub runtime_digest: Sha256Hex,
    /// The distribution's home folder.
    pub distro_home: FilesystemPath,
}

/// The contents of `service.json`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ServiceRecord {
    /// On Windows itself.
    Windows(WindowsServiceRecord),
    /// Inside a WSL distribution.
    Wsl(WslServiceRecord),
}

/// The TypeScript module of the service's place.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "service-place",
    doc: "Where the background service runs on a Windows computer, and the record that says so.",
    definitions: &[
        Definition::read::<WslPlace>(),
        Definition::read::<WindowsServiceRecord>(),
        Definition::read::<WslServiceRecord>(),
        Definition::read::<ServicePlaceLocation>(),
        Definition::read::<ServiceRecord>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
