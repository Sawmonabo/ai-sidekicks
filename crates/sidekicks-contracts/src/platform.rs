//! The operating systems and processor architectures a build runs on, in Node's spelling, which
//! the wire and the release manifest's keys (`darwin-arm64`, `linux-x64`) carry.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::typescript::{Definition, TypeScriptModule, ts_constants};

/// An operating system a build runs on, in Node's spelling.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(rename = "SupportedPlatform")]
pub enum Platform {
    /// macOS.
    Darwin,
    /// Linux.
    Linux,
    /// Windows.
    Win32,
}

impl Platform {
    /// Every platform.
    pub const ALL: &[Self] = &[Self::Darwin, Self::Linux, Self::Win32];
}

/// A processor architecture a build runs on, in Node's spelling.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Arch {
    /// x86-64.
    X64,
    /// 64-bit ARM.
    Arm64,
}

ts_constants! {
    /// The operating systems a build runs on.
    SUPPORTED_PLATFORMS = Platform::ALL;
}

/// The TypeScript module of the platforms.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "platform",
    doc: "The operating systems and processor architectures a build runs on, in Node's spelling.",
    definitions: &[Definition::read::<Platform>(), Definition::read::<Arch>()],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
