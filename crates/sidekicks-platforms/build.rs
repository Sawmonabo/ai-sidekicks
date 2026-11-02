//! Hands the daemon's build script, on macOS, the `Info.plist` the daemon's program embeds, so a
//! login agent or command-line daemon with no app behind it shows the Local Network alert in the
//! product's words. The plist is a macOS fact, so it is named here and the daemon forwards it.

use std::env;
use std::error::Error;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn Error>> {
    println!("cargo::rerun-if-changed=build.rs");
    if env::var("CARGO_CFG_TARGET_OS").is_ok_and(|target_os| target_os == "macos") {
        let info_plist = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?).join("daemon-info.plist");
        println!("cargo::metadata=info_plist={}", info_plist.display());
    }
    Ok(())
}
