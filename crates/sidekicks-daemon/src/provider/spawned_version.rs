//! The spawned build's version: the configured command resolved to one build, and the version that
//! build reports in-band through its driver's handshake, so a binding row names the build that ran
//! and never a launcher's idea of it. Any version runs; the reading is recorded.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::text::is_ecmascript_whitespace;
use sidekicks_platforms::{
    PathRules, ProgramFolder, ProgramStart, find_executables, is_path_command, program_start,
    real_path,
};

use crate::provider::command_search::ProviderCommandSearch;
use crate::provider::driver::contract::{
    DriverCliVersionReport, DriverError, SpawnedVersionBindingCarriers,
};
use crate::provider::driver::error_causes::ExecutableUnresolvable;
use crate::provider::output_validation::{check_cli_version_report, is_canonical_semver};
use crate::provider::spawn_environment::place_folder_first_on_search_path;

// The first `X.Y.Z` word in prose such as `cli-name 2.1.245 (build 7)`. A partial version such as
// `v2` is no match, so it stays unparsed.
static VERSION_TOKEN_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?")
        .expect("the version token pattern compiles")
});

/// The one build a spawn and its binding row both name, resolved from the configured command.
#[expect(
    dead_code,
    reason = "each driver's capability read and session start read the spawned build's version \
              through it"
)]
pub(crate) struct ResolvedProviderExecutable {
    /// The command as configured: a bare name or a path.
    pub(crate) requested_command: String,
    /// The build's absolute, symlink-resolved path, recorded as what ran.
    pub(crate) resolved_executable_path: PathBuf,
    /// What the system starts to run the build, with no shell.
    pub(crate) start: ProgramStart,
    /// The child's whole environment: the provider's spawn environment, with the folder the
    /// command search found the build in first on its `PATH`.
    pub(crate) environment: Vec<(String, String)>,
}

/// What one zero-turn version handshake needs: the provider, its build as resolved, and the client
/// name the handshake sends, which a provider may echo beside its own version.
#[expect(
    dead_code,
    reason = "each driver's capability read and session start read the spawned build's version \
              through it"
)]
pub(crate) struct ProviderVersionHandshakeRequest {
    /// The provider.
    pub(crate) provider: ProviderId,
    /// The build to start, never the configured name.
    pub(crate) executable: ResolvedProviderExecutable,
    /// The client name sent, with no `/` or whitespace.
    pub(crate) client_name: &'static str,
}

/// A driver's zero-turn version handshake: starts the request's build as resolved, under a
/// deadline the driver owns, and answers the version text its own reader took from the reply. It
/// fails with the driver's error when the build cannot be started or does not answer.
#[expect(
    dead_code,
    reason = "each driver's capability read and session start read the spawned build's version \
              through it"
)]
pub(crate) trait ProviderVersionHandshake:
    AsyncFnOnce(&ProviderVersionHandshakeRequest) -> Result<String, DriverError>
{
}

impl<Handshake> ProviderVersionHandshake for Handshake where
    Handshake: AsyncFnOnce(&ProviderVersionHandshakeRequest) -> Result<String, DriverError>
{
}

/// One spawned-build reading: the build that answered the handshake and what it reported. Never
/// kept across spawns, so a later read sees a build replaced in the meantime.
#[derive(Clone, Debug)]
pub(crate) struct SpawnedProviderVersionReading {
    /// The build's absolute, symlink-resolved path, the one that answered.
    pub(crate) resolved_executable_path: PathBuf,
    /// The version it reported.
    pub(crate) report: DriverCliVersionReport,
}

/// The version a provider printed: the text as printed, and the first `X.Y.Z` word in it as its
/// parse when that word is a canonical semantic version. Never fails.
pub(crate) fn parse_cli_version_report(raw: &str) -> DriverCliVersionReport {
    let parsed_version = VERSION_TOKEN_PATTERN
        .find(raw)
        .as_ref()
        .map(regex::Match::as_str)
        .filter(|token| is_canonical_semver(token))
        .map(str::to_owned);
    DriverCliVersionReport {
        raw_version: raw.to_owned(),
        parsed_version,
    }
}

/// Resolves the configured command to the build to spawn and how the system starts it, in
/// `spawn_environment`, the provider's own: a command holding a separator is taken as a path, a
/// bare one is searched along the environment's `PATH` (never the daemon's), then through
/// `command_search` in `search_folders`; the build found is resolved to its real path. Fails with
/// [`DriverError::ExecutableUnresolvable`] naming the command as configured when it is blank, names
/// no build, or names one the system cannot start, and with [`DriverError::Internal`] when a
/// blocking task ends before it answers.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "each driver's session start and capability read resolve its command to the \
                  build they start through it"
    )
)]
pub(crate) async fn resolve_provider_executable(
    command_search: &ProviderCommandSearch,
    provider: &ProviderId,
    requested_command: String,
    spawn_environment: Vec<(String, String)>,
    search_folders: Vec<ProgramFolder>,
) -> Result<ResolvedProviderExecutable, DriverError> {
    if requested_command.chars().all(is_ecmascript_whitespace) {
        let cause = io::Error::new(
            io::ErrorKind::InvalidInput,
            "the configured provider command is empty",
        );
        return Err(unresolvable(provider, requested_command, cause, false));
    }
    let (command, environment) = (requested_command.clone(), spawn_environment);
    let (along_search_path, spawn_environment) = tokio::task::spawn_blocking(move || {
        (
            resolve_along_search_path(&command, &environment),
            environment,
        )
    })
    .await
    .map_err(|error| DriverError::Internal(Box::new(error)))?;
    let (build, environment) = match along_search_path {
        Ok(build) => (build, spawn_environment),
        Err(SearchPathMiss {
            cause,
            is_build_found,
        }) => {
            let found = command_search
                .find(&requested_command, search_folders, &spawn_environment)
                .await
                .map_err(|error| DriverError::Internal(Box::new(error)))?;
            let Some(hit) = found else {
                return Err(unresolvable(
                    provider,
                    requested_command,
                    cause,
                    is_build_found,
                ));
            };
            let mut environment = spawn_environment;
            place_folder_first_on_search_path(&mut environment, &hit.folder, PathRules::NATIVE);
            (hit.build, environment)
        }
    };
    let (start, build, environment) = tokio::task::spawn_blocking(move || {
        (
            start_resolved_build(&build, &environment),
            build,
            environment,
        )
    })
    .await
    .map_err(|error| DriverError::Internal(Box::new(error)))?;
    let start = match start {
        Ok(start) => start,
        Err(cause) => return Err(unresolvable(provider, requested_command, cause, true)),
    };
    Ok(ResolvedProviderExecutable {
        requested_command,
        resolved_executable_path: build,
        start,
        environment,
    })
}

/// How the system starts `build` in `environment`, any program it names found along that
/// environment's `PATH`. Reads files, so it runs on the daemon's spawner thread or in
/// `spawn_blocking`. Fails as [`program_start`] does for a build the system cannot start without
/// a shell.
pub(crate) fn start_resolved_build(
    build: &Path,
    environment: &[(String, String)],
) -> io::Result<ProgramStart> {
    program_start(build, |program| {
        find_executables(program, environment, Path::new(""), &[]).next()
    })
}

/// Reads the version the build `request` names reports in-band, through its driver's `handshake`,
/// and checks it against what a binding row stores. A reply that carried no version keeps its text
/// unparsed, since a version-shaped word in it may name something else, such as the caller's own
/// client version. Fails with the handshake's error, or [`DriverError::Internal`] when the report
/// is blank, holds a NUL or passes its storage bounds.
#[expect(
    dead_code,
    reason = "each driver's capability read and session start read the spawned build's version \
              through it"
)]
pub(crate) async fn read_spawned_version(
    request: &ProviderVersionHandshakeRequest,
    handshake: impl ProviderVersionHandshake,
) -> Result<SpawnedProviderVersionReading, DriverError> {
    let version_text = handshake(request).await?;
    // A driver's reader answers a canonical version alone, or the reply text that carried none.
    let report = DriverCliVersionReport {
        parsed_version: is_canonical_semver(&version_text).then(|| version_text.clone()),
        raw_version: version_text,
    };
    check_cli_version_report(request.provider.clone(), &report)
        .map_err(|error| DriverError::Internal(Box::new(error)))?;
    Ok(SpawnedProviderVersionReading {
        resolved_executable_path: request.executable.resolved_executable_path.clone(),
        report,
    })
}

/// The two binding carriers of one reading, so a binding row never pairs one build's version with
/// another build's path.
#[expect(
    dead_code,
    reason = "each driver's capability read and session start read the spawned build's version \
              through it"
)]
pub(crate) fn to_binding_version_carriers(
    reading: &SpawnedProviderVersionReading,
) -> SpawnedVersionBindingCarriers {
    SpawnedVersionBindingCarriers {
        cli_version: reading.report.clone(),
        resolved_executable_path: reading.resolved_executable_path.clone(),
    }
}

// Why the search path gave no build: the last candidate's resolve error, or none was found.
struct SearchPathMiss {
    cause: io::Error,
    is_build_found: bool,
}

// The first build `command` names along `environment`'s `PATH`, resolved to its real path. Fails
// with the last candidate's resolve error, or `NotFound` when no candidate is found. Reads the
// file system, so it runs in `spawn_blocking`.
fn resolve_along_search_path(
    command: &str,
    environment: &[(String, String)],
) -> Result<PathBuf, SearchPathMiss> {
    let mut failure = None;
    for candidate in find_executables(command, environment, Path::new(""), &[]) {
        match real_path(&candidate) {
            Ok(build) => return Ok(build),
            // Gone between the search and the resolve: the next candidate is tried, never the
            // launcher's own path.
            Err(error) => failure = Some(error),
        }
    }
    Err(match failure {
        Some(cause) => SearchPathMiss {
            cause,
            is_build_found: true,
        },
        None => SearchPathMiss {
            cause: io::Error::new(
                io::ErrorKind::NotFound,
                "the configured provider command names no executable file",
            ),
            is_build_found: false,
        },
    })
}

// The refusal for a command that resolves to no build, naming it as configured.
fn unresolvable(
    provider: &ProviderId,
    requested_command: String,
    cause: io::Error,
    is_build_found: bool,
) -> DriverError {
    DriverError::ExecutableUnresolvable(ExecutableUnresolvable {
        provider: provider.clone(),
        is_typed_path: is_path_command(&requested_command),
        is_build_found,
        requested_command,
        cause,
    })
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_platforms::Spawner;

    use super::resolve_provider_executable;
    use crate::provider::command_search::ProviderCommandSearch;
    use crate::provider::driver::PROVIDERS;
    use crate::provider::driver::contract::DriverError;

    // A typed command path that names nothing is refused as a path the person typed, never as a
    // provider not installed, and a bare name no search finds is not installed. Killed by reading
    // every command as a bare name, or a typed path as one.
    #[rstest]
    #[case::typed_path("/sidekicks-test-missing/provider", true)]
    #[case::bare_name("sidekicks-test-missing-provider", false)]
    #[tokio::test]
    async fn a_command_that_names_no_build_is_refused_by_how_it_was_typed(
        #[case] command: &str,
        #[case] is_typed_path: bool,
    ) {
        let empty_search_path = tempfile::tempdir().expect("the temporary folder is made");
        let search = ProviderCommandSearch::new(
            Spawner::new(tokio::runtime::Handle::current()).expect("the spawner thread starts"),
        );
        let provider = ProviderId::new(PROVIDERS[0].id.to_owned()).expect("a provider id");
        let environment = vec![(
            "PATH".to_owned(),
            empty_search_path.path().to_string_lossy().into_owned(),
        )];

        let resolved = resolve_provider_executable(
            &search,
            &provider,
            command.to_owned(),
            environment,
            Vec::new(),
        )
        .await;

        let Err(DriverError::ExecutableUnresolvable(unresolvable)) = resolved else {
            panic!("the command resolves to no build");
        };
        assert_eq!(unresolvable.is_typed_path, is_typed_path);
        assert_eq!(unresolvable.is_not_installed(), !is_typed_path);
        let expected_code = if is_typed_path {
            RefusalCode::ProviderCommandPathNotRunnable
        } else {
            RefusalCode::ProviderUnavailable
        };
        assert_eq!(unresolvable.into_refusal().code, expected_code);
    }
}
