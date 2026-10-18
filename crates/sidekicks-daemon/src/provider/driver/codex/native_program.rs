//! The native Codex program behind the npm launcher, which the daemon starts itself so the
//! process it pins is the service, never a Node process that would leave the service unpinned.

use std::io;
use std::path::{Path, PathBuf};

use sidekicks_platforms::{PerSystem, ProgramStart, real_path};

/// The npm launcher's script, in its package's `bin` folder.
const LAUNCHER_SCRIPT_NAME: &str = "codex.js";

/// The folder the launcher's script sits in.
const LAUNCHER_FOLDER_NAME: &str = "bin";

/// The folder Node finds packages in.
const NODE_MODULES_FOLDER_NAME: &str = "node_modules";

/// What the launcher names the running system by: Node's platform word, the target triple's
/// system part, and the native program's file name.
const SYSTEM_NAMES: PerSystem<(&str, &str, &str)> = PerSystem {
    macos: ("darwin", "apple-darwin", "codex"),
    linux: ("linux", "unknown-linux-musl", "codex"),
    windows: ("win32", "pc-windows-msvc", "codex.exe"),
};

/// The native program `start` runs. A start that runs Codex's npm launcher, `bin/codex.js` (on
/// Windows through the shim's `node`, its script the first leading argument), gives the program
/// the launcher would spawn, found as it finds it (`codex-cli/bin/codex.js` in `openai/codex`):
/// the package `@openai/codex-<Node platform>-<Node arch>` resolved from the script's folder as
/// Node resolves `<package>/package.json`, its `vendor` folder, or the launcher package's own
/// `vendor` beside `bin` when none resolves, then `<target triple>/bin/codex` (`codex.exe` on
/// Windows) in it. Any other start is the native program already. Reads the file system, so it
/// runs on the daemon's spawner thread or in `spawn_blocking`. Fails with the resolve's error,
/// `Unsupported` on a processor the launcher has no build for, and `NotFound` when the native
/// program is missing.
pub(crate) fn resolve_codex_native_program(start: &ProgramStart) -> io::Result<PathBuf> {
    let script = match start.leading_arguments.first() {
        Some(script) => real_path(script)?,
        None => real_path(&start.program)?,
    };
    let Some(launcher_folder) = launcher_folder(&script) else {
        return Ok(start.program.clone());
    };
    let (node_platform, triple_system, program_name) = *SYSTEM_NAMES.native();
    let (node_arch, triple_arch) = match std::env::consts::ARCH {
        "x86_64" => ("x64", "x86_64"),
        "aarch64" => ("arm64", "aarch64"),
        other => {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                format!("Codex's launcher has no build for the {other} processor"),
            ));
        }
    };
    let platform_package = format!("codex-{node_platform}-{node_arch}");
    let launcher_package = launcher_folder.parent().unwrap_or(launcher_folder);
    let vendor = resolve_node_package(launcher_folder, &platform_package)
        .unwrap_or_else(|| launcher_package.to_path_buf())
        .join("vendor");
    let program = vendor
        .join(format!("{triple_arch}-{triple_system}"))
        .join("bin")
        .join(program_name);
    if !program.try_exists()? {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "Codex's launcher names {}, which is missing; reinstalling Codex restores it",
                program.display()
            ),
        ));
    }
    Ok(program)
}

// The `bin` folder `script` sits in, when it is Codex's npm launcher.
fn launcher_folder(script: &Path) -> Option<&Path> {
    let folder = script.parent()?;
    let is_launcher =
        script.file_name()? == LAUNCHER_SCRIPT_NAME && folder.file_name()? == LAUNCHER_FOLDER_NAME;
    is_launcher.then_some(folder)
}

// The folder of the `@openai/<package>` Node resolves from `from`: the first
// `node_modules/@openai/<package>` holding a `package.json` in `from` or a folder above it, a
// folder that is itself `node_modules` skipped, as Node's module paths skip it.
fn resolve_node_package(from: &Path, package: &str) -> Option<PathBuf> {
    from.ancestors()
        .filter(|folder| folder.file_name() != Some(NODE_MODULES_FOLDER_NAME.as_ref()))
        .map(|folder| {
            folder
                .join(NODE_MODULES_FOLDER_NAME)
                .join("@openai")
                .join(package)
        })
        .find(|candidate| candidate.join("package.json").is_file())
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use rstest::rstest;
    use sidekicks_platforms::ProgramStart;

    use super::{SYSTEM_NAMES, resolve_codex_native_program};

    // The native program's path under `vendor` for the running system and processor.
    fn native_program_under(vendor: &Path) -> PathBuf {
        let (_, triple_system, program_name) = *SYSTEM_NAMES.native();
        vendor
            .join(format!("{}-{triple_system}", std::env::consts::ARCH))
            .join("bin")
            .join(program_name)
    }

    fn node_arch() -> &'static str {
        if std::env::consts::ARCH == "aarch64" {
            "arm64"
        } else {
            "x64"
        }
    }

    // Mutations killed: answering the launcher itself leaves Node pinned; skipping the platform
    // package reads the launcher's own `vendor`, which npm leaves empty.
    #[rstest]
    #[case::a_hoisted_platform_package(true)]
    #[case::the_launcher_vendor_folder(false)]
    fn resolve_codex_native_program_finds_the_program_the_launcher_spawns(
        #[case] is_platform_package_installed: bool,
    ) {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let modules = folder.path().join("lib").join("node_modules");
        let launcher_package = modules.join("@openai").join("codex");
        let script = launcher_package.join("bin").join("codex.js");
        std::fs::create_dir_all(script.parent().expect("the script has a folder"))
            .expect("the launcher's folder is made");
        std::fs::write(&script, b"").expect("the launcher is written");
        let vendor = if is_platform_package_installed {
            let (node_platform, _, _) = *SYSTEM_NAMES.native();
            let package = modules
                .join("@openai")
                .join(format!("codex-{node_platform}-{}", node_arch()));
            std::fs::create_dir_all(&package).expect("the platform package is made");
            std::fs::write(package.join("package.json"), b"{}").expect("its manifest is written");
            package.join("vendor")
        } else {
            launcher_package.join("vendor")
        };
        let program = native_program_under(&vendor);
        std::fs::create_dir_all(program.parent().expect("the program has a folder"))
            .expect("the program's folder is made");
        std::fs::write(&program, b"").expect("the program is written");

        let resolved = resolve_codex_native_program(&ProgramStart {
            program: script,
            leading_arguments: Vec::new(),
        })
        .expect("the native program resolves");

        assert_eq!(
            resolved,
            sidekicks_platforms::real_path(&program).expect("the program resolves")
        );
    }
}
