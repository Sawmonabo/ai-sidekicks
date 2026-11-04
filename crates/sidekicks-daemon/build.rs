//! Compiles SQLite's shell, vendored byte for byte, into the static library the `database shell`
//! mode runs, once the file's hash and its release are checked against the SQLite `libsqlite3-sys`
//! bundles, so the shell and the library always run the same SQLite. On macOS it also links the
//! `Info.plist` `sidekicks-platforms` names into the program's `__TEXT,__info_plist` section, so
//! the Local Network alert reads in the product's words with no app behind the daemon. It also
//! checks LiteLLM's price list, vendored byte for byte, against the hash its sidecar records, and
//! packs it with gzip into the seed the program carries.

use std::env::VarError;
use std::error::Error;
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::{env, fs};

use flate2::Compression;
use flate2::write::GzEncoder;
use sha3::{Digest, Sha3_256};

/// The shell's source, from the SQLite release's amalgamation.
const SHELL_SOURCE: &str = "vendor/sqlite/shell.c";

/// The SHA3-256 of [`SHELL_SOURCE`] as the release ships it.
const SHELL_SOURCE_SHA3_256: &str =
    "4a706af46c794ad4665459891b8acbc7faab738b0d2f989ed7eb9d0219f35b54";

/// The `SQLITE_SOURCE_ID` of the release [`SHELL_SOURCE`] comes from.
const SHELL_SQLITE_SOURCE_ID: &str =
    "2026-06-03 19:12:13 d6e03d8c777cfa2d35e3b60d8ec3e0187f3e9f99d8e2ee9cac695fd6fcdf1a24";

/// LiteLLM's price list, kept byte for byte from the commit [`PRICE_LIST_SOURCE`] names.
const PRICE_LIST: &str = "vendor/litellm/model_prices_and_context_window.json";

/// The price list's sidecar: a `commit=` line and a `sha3-256=` line, which a refresh rewrites
/// together with the file.
const PRICE_LIST_SOURCE: &str = "vendor/litellm/source.txt";

/// The packed price list in `OUT_DIR`, which the program embeds as its seed through the
/// `PRICE_LIST_SEED` path the build hands the compiler.
const PRICE_LIST_SEED: &str = "model_prices_and_context_window.json.gz";

fn main() -> Result<(), Box<dyn Error>> {
    // The folder of the `sqlite3.h` that `libsqlite3-sys` builds its bundled SQLite from.
    let include = PathBuf::from(env::var("DEP_SQLITE3_INCLUDE")?);
    let header = include.join("sqlite3.h");
    println!("cargo::rerun-if-changed=build.rs");
    println!("cargo::rerun-if-changed={SHELL_SOURCE}");
    println!("cargo::rerun-if-changed={PRICE_LIST}");
    println!("cargo::rerun-if-changed={PRICE_LIST_SOURCE}");
    println!("cargo::rerun-if-changed={}", header.display());

    // Set only when building for macOS. Each linker argument is its own `-Xlinker`, never one
    // `-Wl,` list, which would split a path holding a comma.
    match env::var("DEP_SIDEKICKS_PLATFORMS_INFO_PLIST") {
        Ok(info_plist) => {
            println!("cargo::rerun-if-changed={info_plist}");
            for argument in ["-sectcreate", "__TEXT", "__info_plist", &info_plist] {
                println!("cargo::rustc-link-arg-bins=-Xlinker");
                println!("cargo::rustc-link-arg-bins={argument}");
            }
        }
        Err(VarError::NotPresent) => {}
        Err(error) => return Err(error.into()),
    }

    let source_hash = sha3_256_hex(SHELL_SOURCE)?;
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

    let seed = PathBuf::from(env::var("OUT_DIR")?).join(PRICE_LIST_SEED);
    write_price_list_seed(&seed)?;
    println!("cargo::rustc-env=PRICE_LIST_SEED={}", seed.display());
    Ok(())
}

/// Checks the price list against its sidecar's hash, then writes it gzipped at best compression.
fn write_price_list_seed(seed: &Path) -> Result<(), Box<dyn Error>> {
    let sidecar = fs::read_to_string(PRICE_LIST_SOURCE)?;
    let sidecar_value = |key: &str| {
        sidecar
            .lines()
            .find_map(|line| line.strip_prefix(key)?.strip_prefix('='))
            .ok_or_else(|| format!("{PRICE_LIST_SOURCE} has no {key}= line"))
    };
    let commit = sidecar_value("commit")?;
    let recorded_hash = sidecar_value("sha3-256")?;
    let list_hash = sha3_256_hex(PRICE_LIST)?;
    if list_hash != recorded_hash {
        return Err(format!(
            "{PRICE_LIST} hashes to {list_hash}, not the {recorded_hash} {PRICE_LIST_SOURCE} \
             records for LiteLLM commit {commit}"
        )
        .into());
    }
    let mut encoder = GzEncoder::new(File::create(seed)?, Compression::best());
    io::copy(&mut File::open(PRICE_LIST)?, &mut encoder)?;
    encoder.finish()?;
    Ok(())
}

/// The lowercase hex SHA3-256 of the file at `path`.
fn sha3_256_hex(path: &str) -> io::Result<String> {
    let contents = fs::read(path)?;
    Ok(base16ct::lower::encode_string(&Sha3_256::digest(contents)))
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
