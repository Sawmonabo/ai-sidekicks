//! Compiles SQLite's shell, vendored byte for byte, into the static library the `database shell`
//! mode runs, once the file's hash and its release are checked against the SQLite `libsqlite3-sys`
//! bundles, so the shell and the library always run the same SQLite.

use std::error::Error;
use std::path::PathBuf;
use std::{env, fs};

use sha3::{Digest, Sha3_256};

/// The shell's source, from the SQLite release's amalgamation.
const SHELL_SOURCE: &str = "vendor/sqlite/shell.c";

/// The SHA3-256 of [`SHELL_SOURCE`] as the release ships it.
const SHELL_SOURCE_SHA3_256: &str =
    "4a706af46c794ad4665459891b8acbc7faab738b0d2f989ed7eb9d0219f35b54";

/// The `SQLITE_SOURCE_ID` of the release [`SHELL_SOURCE`] comes from.
const SHELL_SQLITE_SOURCE_ID: &str =
    "2026-06-03 19:12:13 d6e03d8c777cfa2d35e3b60d8ec3e0187f3e9f99d8e2ee9cac695fd6fcdf1a24";

fn main() -> Result<(), Box<dyn Error>> {
    // The folder of the `sqlite3.h` that `libsqlite3-sys` builds its bundled SQLite from.
    let include = PathBuf::from(env::var("DEP_SQLITE3_INCLUDE")?);
    let header = include.join("sqlite3.h");
    println!("cargo::rerun-if-changed=build.rs");
    println!("cargo::rerun-if-changed={SHELL_SOURCE}");
    println!("cargo::rerun-if-changed={}", header.display());

    let source_hash = base16ct::lower::encode_string(&Sha3_256::digest(fs::read(SHELL_SOURCE)?));
    if source_hash != SHELL_SOURCE_SHA3_256 {
        return Err(format!(
            "{SHELL_SOURCE} hashes to {source_hash}, not the release's {SHELL_SOURCE_SHA3_256}"
        )
        .into());
    }
    let header_text = fs::read_to_string(&header)?;
    let bundled_source_id = read_source_id(&header_text)
        .ok_or_else(|| format!("{} defines no SQLITE_SOURCE_ID", header.display()))?;
    if bundled_source_id != SHELL_SQLITE_SOURCE_ID {
        return Err(format!(
            "{SHELL_SOURCE} is SQLite {SHELL_SQLITE_SOURCE_ID}, while libsqlite3-sys bundles \
             {bundled_source_id}; take the shell from the bundled release"
        )
        .into());
    }

    // The file is never edited, so its warnings are upstream's to fix.
    cc::Build::new()
        .file(SHELL_SOURCE)
        .include(&include)
        .define("main", "sqlite3_shell_main")
        .define("SQLITE_ENABLE_DBPAGE_VTAB", None)
        .warnings(false)
        .compile("sqlite_shell");
    Ok(())
}

/// The quoted text of the header's `#define SQLITE_SOURCE_ID` line.
fn read_source_id(header: &str) -> Option<&str> {
    header.lines().find_map(|line| {
        line.strip_prefix("#define SQLITE_SOURCE_ID")?
            .trim()
            .strip_prefix('"')?
            .strip_suffix('"')
    })
}
