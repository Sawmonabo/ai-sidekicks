//! The native Codex program behind the npm launcher, which the daemon starts itself so the
//! process it pins is the service, never a Node process that would leave the service unpinned,
//! with the variables the launcher would set on it.

use std::io;
use std::path::{Path, PathBuf};

use sidekicks_contracts::platform::Arch;
use sidekicks_platforms::{PathRules, PerSystem, ProgramStart, RUNNING_ARCH, real_path};

/// The npm launcher's script, in its package's `bin` folder.
const LAUNCHER_SCRIPT_NAME: &str = "codex.js";

/// The folder the launcher's script sits in.
const LAUNCHER_FOLDER_NAME: &str = "bin";

/// The folder Node finds packages in.
const NODE_MODULES_FOLDER_NAME: &str = "node_modules";

/// The launcher package's name, under `@openai`.
const LAUNCHER_PACKAGE_NAME: &str = "codex";

/// What the launcher names the running system by: Node's platform word, the target triple's
/// system part, and the native program's file name.
const SYSTEM_NAMES: PerSystem<(&str, &str, &str)> = PerSystem {
    macos: ("darwin", "apple-darwin", "codex"),
    linux: ("linux", "unknown-linux-musl", "codex"),
    windows: ("win32", "pc-windows-msvc", "codex.exe"),
};

/// The variable naming the launcher package's folder, every link resolved.
const PACKAGE_ROOT_ENVIRONMENT_NAME: &str = "CODEX_MANAGED_PACKAGE_ROOT";

/// The variable naming each package manager that installed Codex, one set to `1`.
const PACKAGE_MANAGER_ENVIRONMENT_NAMES: [&str; 4] = [
    "CODEX_MANAGED_BY_NPM",
    "CODEX_MANAGED_BY_BUN",
    "CODEX_MANAGED_BY_PNPM",
    "CODEX_MANAGED_BY_VITE_PLUS",
];

/// The package manager that installed Codex, as its launcher tells them apart.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PackageManager {
    Npm,
    Bun,
    Pnpm,
    VitePlus,
}

impl PackageManager {
    // The variable the launcher sets to `1` for this package manager.
    fn environment_name(self) -> &'static str {
        let [npm, bun, pnpm, vite_plus] = PACKAGE_MANAGER_ENVIRONMENT_NAMES;
        match self {
            Self::Npm => npm,
            Self::Bun => bun,
            Self::Pnpm => pnpm,
            Self::VitePlus => vite_plus,
        }
    }
}

/// The native Codex program a start runs, and what Codex's npm launcher would set on it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexNativeProgram {
    /// The native program, every link resolved.
    pub(crate) program: PathBuf,
    /// The variables the launcher sets on the program it spawns, which tell Codex how it was
    /// installed: `CODEX_MANAGED_PACKAGE_ROOT` and the one `CODEX_MANAGED_BY_*` of the package
    /// manager; empty for a start that runs the native program already.
    pub(crate) launcher_environment: Vec<(String, String)>,
}

impl CodexNativeProgram {
    /// Sets the launcher's variables over `environment` as the launcher does, every
    /// `CODEX_MANAGED_BY_*` taken off first so one package manager is named; leaves it alone for a
    /// start that runs the native program already.
    pub(crate) fn set_launcher_environment(&self, environment: &mut Vec<(String, String)>) {
        if self.launcher_environment.is_empty() {
            return;
        }
        let rules = PathRules::NATIVE;
        environment.retain(|(name, _)| {
            let key = rules.environment_name_key(name);
            !PACKAGE_MANAGER_ENVIRONMENT_NAMES
                .iter()
                .any(|managed| rules.environment_name_key(managed) == key)
        });
        environment.extend(self.launcher_environment.iter().cloned());
    }
}

/// The native program `start` runs, with `environment`, the provider's own. A start that runs
/// Codex's npm launcher, `bin/codex.js` (on Windows through the shim's `node`, its script the
/// first leading argument), gives the program the launcher would spawn, found as it finds it
/// (`codex-cli/bin/codex.js` in `openai/codex`): the package `@openai/codex-<Node platform>-<Node
/// arch>` resolved from the script's folder as Node resolves `<package>/package.json`, its
/// `vendor` folder, or the launcher package's own `vendor` beside `bin` when none resolves, then
/// `<target triple>/bin/codex` (`codex.exe` on Windows) in it; and the variables the launcher sets
/// on it, the package manager told apart as it tells them. Any other start is the native program
/// already. Reads the file system, so it runs on the daemon's spawner thread or in
/// `spawn_blocking`. Fails with the resolve's error, `NotFound` when the native program is
/// missing, and `InvalidData` for a launcher package folder that is not text.
pub(crate) fn resolve_codex_native_program(
    start: &ProgramStart,
    environment: &[(String, String)],
) -> io::Result<CodexNativeProgram> {
    let invoked_script = start.leading_arguments.first().unwrap_or(&start.program);
    let script = real_path(invoked_script)?;
    let Some(launcher_folder) = launcher_folder(&script) else {
        return Ok(CodexNativeProgram {
            program: start.program.clone(),
            launcher_environment: Vec::new(),
        });
    };
    let (node_platform, triple_system, program_name) = *SYSTEM_NAMES.native();
    let (node_arch, triple_arch) = arch_names(RUNNING_ARCH);
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
    let package_root = launcher_package.to_str().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "Codex's launcher package folder is not text",
        )
    })?;
    let invoked_folder = invoked_script.parent().unwrap_or(Path::new(""));
    let package_manager = detect_package_manager(
        launcher_package,
        launcher_folder,
        invoked_folder,
        environment,
    );
    Ok(CodexNativeProgram {
        program,
        launcher_environment: vec![
            (
                PACKAGE_ROOT_ENVIRONMENT_NAME.to_owned(),
                package_root.to_owned(),
            ),
            (
                package_manager.environment_name().to_owned(),
                "1".to_owned(),
            ),
        ],
    })
}

// Node's word and the target triple's processor part for `arch`.
fn arch_names(arch: Arch) -> (&'static str, &'static str) {
    match arch {
        Arch::X64 => ("x64", "x86_64"),
        Arch::Arm64 => ("arm64", "aarch64"),
    }
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

// The package manager that installed the launcher package at `package_root`, as the launcher
// tells: Vite+ or pnpm when an install record above `package_root` or above `invoked_folder`, the
// script's folder as it was started, names this package; Bun by the variables npm sets or a
// launcher under Bun's global folder; npm otherwise. A record that cannot be read names nothing.
fn detect_package_manager(
    package_root: &Path,
    launcher_folder: &Path,
    invoked_folder: &Path,
    environment: &[(String, String)],
) -> PackageManager {
    for start in [package_root, invoked_folder] {
        let mut folders = start.ancestors().peekable();
        while let Some(folder) = folders.next() {
            let is_root = folders.peek().is_none();
            if !is_root && is_vite_plus_install(folder, package_root) {
                return PackageManager::VitePlus;
            }
            if is_pnpm_install(&folder.join(NODE_MODULES_FOLDER_NAME), package_root) {
                return PackageManager::Pnpm;
            }
        }
    }
    let variable = |name: &str| {
        PathRules::NATIVE
            .environment_value(environment, name)
            .unwrap_or("")
    };
    // `bun/` after a word boundary, as the launcher's `/\bbun\//` matches it.
    let user_agent = variable("npm_config_user_agent");
    let is_bun_user_agent = user_agent.match_indices("bun/").any(|(index, _)| {
        !user_agent[..index]
            .chars()
            .next_back()
            .is_some_and(|character| character.is_ascii_alphanumeric() || character == '_')
    });
    let launcher_text = launcher_folder.to_string_lossy();
    let is_bun_global = launcher_text.contains(".bun/install/global")
        || launcher_text.contains(".bun\\install\\global");
    if is_bun_user_agent || variable("npm_execpath").contains("bun") || is_bun_global {
        return PackageManager::Bun;
    }
    PackageManager::Npm
}

// Whether `node_modules` is a pnpm install folder whose `@openai/codex` is `package_root`.
fn is_pnpm_install(node_modules: &Path, package_root: &Path) -> bool {
    node_modules.join(".modules.yaml").exists()
        && real_path(&node_modules.join("@openai").join(LAUNCHER_PACKAGE_NAME))
            .is_ok_and(|installed| installed == package_root)
}

// Whether `packages` is a Vite+ packages folder whose active `@openai/codex` install, which its
// `@openai/codex.json` names by install id, is `package_root`.
fn is_vite_plus_install(packages: &Path, package_root: &Path) -> bool {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct InstallRecord {
        name: String,
        // `null` reads as no install id, as the launcher reads it.
        #[serde(default)]
        install_id: Option<String>,
    }
    if packages.file_name() != Some("packages".as_ref()) {
        return false;
    }
    let Ok(text) = std::fs::read(packages.join("@openai").join("codex.json")) else {
        return false;
    };
    let Ok(record) = serde_json::from_slice::<InstallRecord>(&text) else {
        return false;
    };
    if record.name != "@openai/codex" {
        return false;
    }
    let install_id = record.install_id.unwrap_or_default();
    let install = if install_id.starts_with('#') {
        packages
            .join("@openai")
            .join(format!("{LAUNCHER_PACKAGE_NAME}{install_id}"))
    } else {
        packages
            .join("@openai")
            .join(LAUNCHER_PACKAGE_NAME)
            .join(&install_id)
    };
    [
        install.join("lib").join(NODE_MODULES_FOLDER_NAME),
        install.join(NODE_MODULES_FOLDER_NAME),
    ]
    .iter()
    .any(|node_modules| {
        real_path(&node_modules.join("@openai").join(LAUNCHER_PACKAGE_NAME))
            .is_ok_and(|installed| installed == package_root)
    })
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use rstest::rstest;
    use sidekicks_platforms::{ProgramStart, RUNNING_ARCH, real_path};

    use super::{SYSTEM_NAMES, arch_names, is_vite_plus_install, resolve_codex_native_program};

    // The native program's path under `vendor` for the running system and processor.
    fn native_program_under(vendor: &Path) -> PathBuf {
        let (_, triple_system, program_name) = *SYSTEM_NAMES.native();
        let (_, triple_arch) = arch_names(RUNNING_ARCH);
        vendor
            .join(format!("{triple_arch}-{triple_system}"))
            .join("bin")
            .join(program_name)
    }

    // Fails when the launcher itself is answered, so Node stays pinned; when the platform package
    // is skipped for the launcher's own `vendor` folder, which npm leaves empty; or when a pnpm
    // install is named npm, or no variable is set, so Codex sees another install than its own
    // start would show it.
    #[rstest]
    #[case::a_hoisted_platform_package(true, false, "CODEX_MANAGED_BY_NPM")]
    #[case::the_launcher_vendor_folder(false, false, "CODEX_MANAGED_BY_NPM")]
    #[case::a_pnpm_install(true, true, "CODEX_MANAGED_BY_PNPM")]
    fn resolve_codex_native_program_finds_the_program_the_launcher_spawns(
        #[case] is_platform_package_installed: bool,
        #[case] is_pnpm_install: bool,
        #[case] package_manager_name: &str,
    ) {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let modules = folder.path().join("lib").join("node_modules");
        let launcher_package = modules.join("@openai").join("codex");
        let script = launcher_package.join("bin").join("codex.js");
        std::fs::create_dir_all(script.parent().expect("the script has a folder"))
            .expect("the launcher's folder is made");
        std::fs::write(&script, b"").expect("the launcher is written");
        if is_pnpm_install {
            std::fs::write(modules.join(".modules.yaml"), b"").expect("pnpm's record is written");
        }
        let vendor = if is_platform_package_installed {
            let (node_platform, _, _) = *SYSTEM_NAMES.native();
            let (node_arch, _) = arch_names(RUNNING_ARCH);
            let package = modules
                .join("@openai")
                .join(format!("codex-{node_platform}-{node_arch}"));
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

        let resolved = resolve_codex_native_program(
            &ProgramStart {
                program: script,
                leading_arguments: Vec::new(),
            },
            &[],
        )
        .expect("the native program resolves");

        let package_root = real_path(&launcher_package).expect("the launcher package resolves");
        assert_eq!(
            resolved.program,
            real_path(&program).expect("the program resolves")
        );
        assert_eq!(
            resolved.launcher_environment,
            [
                (
                    "CODEX_MANAGED_PACKAGE_ROOT".to_owned(),
                    package_root
                        .to_str()
                        .expect("the folder is text")
                        .to_owned()
                ),
                (package_manager_name.to_owned(), "1".to_owned()),
            ]
        );
    }

    // Fails when an install record whose id is `null` is refused, so a Vite+ install reads as
    // npm's.
    #[test]
    fn a_vite_plus_record_with_a_null_install_id_names_the_unversioned_install() {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let packages = folder.path().join("packages");
        let installed = packages
            .join("@openai")
            .join("codex")
            .join("node_modules")
            .join("@openai")
            .join("codex");
        std::fs::create_dir_all(&installed).expect("the install is made");
        std::fs::write(
            packages.join("@openai").join("codex.json"),
            br#"{"name":"@openai/codex","installId":null}"#,
        )
        .expect("the install record is written");

        let package_root = real_path(&installed).expect("the install resolves");

        assert!(is_vite_plus_install(&packages, &package_root));
    }
}
