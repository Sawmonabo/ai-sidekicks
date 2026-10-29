//! The checks on provider-declared text the daemon stores, beside the SQL CHECK constraints: the
//! bounds of `runtime_bindings` and `driver_contract_meta` live here once, and every refusal is a
//! [`ProviderOutputValidationError`] that names the field and never the value.

use sidekicks_contracts::provider::driver::methods::PROVIDER_WIRE_CONTRACT_VERSION_MAX_LEN;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::integer::MAX_SAFE_INTEGER;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::driver::contract::params_and_results::DriverCliVersionReport;

/// The longest provider-owned `resume_handle`, in code points; equals the SQL CHECK bound.
pub(crate) const RESUME_HANDLE_MAX_LEN: usize = 4096;

/// The longest `DriverCliVersionReport::raw_version`, in code points; equals the SQL CHECK bound.
pub(crate) const CLI_VERSION_RAW_MAX_LEN: usize = 128;

/// The longest `DriverCliVersionReport::parsed_version`, in code points; equals the SQL CHECK
/// bound.
pub(crate) const CLI_VERSION_SEMVER_MAX_LEN: usize = 64;

/// A provider-declared value refused where it would be stored. It names the field and why, and the
/// provider when one is known, but never the value, which is provider-supplied and may carry an
/// install path.
#[derive(Debug, thiserror::Error)]
#[error("invalid provider {field}: {reason}")]
pub struct ProviderOutputValidationError {
    /// The provider whose report was refused, when the check knows it.
    pub(crate) provider_name: Option<ProviderId>,
    /// The stored field refused.
    pub(crate) field: &'static str,
    /// Why, in words.
    pub(crate) reason: &'static str,
}

/// Whether `token` is a canonical, identifying semantic version: it parses, carries no build
/// metadata (which does not identify a version), each of major, minor and patch is at most
/// 2^53 − 1, and it prints back as itself, so `v1.2.3`, ` 1.2.3` and `1.2.3+build` are refused.
pub(crate) fn is_canonical_semver(token: &str) -> bool {
    semver::Version::parse(token).is_ok_and(|version| {
        version.build.is_empty()
            && [version.major, version.minor, version.patch]
                .iter()
                .all(|number| *number <= MAX_SAFE_INTEGER)
            && version.to_string() == token
    })
}

/// Checks a driver's declared contract version, whose text bounds its type already holds. An error
/// when it is not a canonical semantic version.
pub(crate) fn check_contract_version(
    contract_version: &FreeFormText<PROVIDER_WIRE_CONTRACT_VERSION_MAX_LEN>,
) -> Result<(), ProviderOutputValidationError> {
    if is_canonical_semver(contract_version.as_str()) {
        return Ok(());
    }
    Err(ProviderOutputValidationError {
        provider_name: None,
        field: "contract_version",
        reason: "must be a canonical, identifying semver string (no build metadata)",
    })
}

/// Checks a resume handle before it is stored. An error when it is blank, holds a NUL or passes
/// its length bound.
pub(crate) fn check_resume_handle(
    resume_handle: &str,
) -> Result<(), ProviderOutputValidationError> {
    if is_free_form_text::<RESUME_HANDLE_MAX_LEN>(resume_handle) {
        return Ok(());
    }
    Err(ProviderOutputValidationError {
        provider_name: None,
        field: "resume_handle",
        reason: "must be a non-empty, non-whitespace, NUL-free string within length bounds",
    })
}

/// Checks a version report against its storage bounds, once, where the daemon reads the version
/// off the spawned build; the stores trust the report after that. An error naming `provider_name`
/// when the printed version is blank, holds a NUL or is too long, or the parsed one is not a
/// canonical semantic version within its bound.
pub(crate) fn check_cli_version_report(
    provider_name: ProviderId,
    report: &DriverCliVersionReport,
) -> Result<(), ProviderOutputValidationError> {
    if !is_free_form_text::<CLI_VERSION_RAW_MAX_LEN>(&report.raw_version) {
        return Err(ProviderOutputValidationError {
            provider_name: Some(provider_name),
            field: "cli_version_raw",
            reason: "must be a non-empty, non-whitespace, NUL-free string within length bounds",
        });
    }
    if report
        .parsed_version
        .as_deref()
        .is_some_and(|parsed_version| {
            !is_free_form_text::<CLI_VERSION_SEMVER_MAX_LEN>(parsed_version)
                || !is_canonical_semver(parsed_version)
        })
    {
        return Err(ProviderOutputValidationError {
            provider_name: Some(provider_name),
            field: "cli_version_semver",
            reason: "must be a canonical, NUL-free semver string within length bounds",
        });
    }
    Ok(())
}

// Whether `text` meets the free-form text rules at `MAX` code points.
fn is_free_form_text<const MAX: usize>(text: &str) -> bool {
    FreeFormText::<MAX>::new(text.to_owned()).is_ok()
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::is_canonical_semver;

    #[rstest]
    #[case::plain("1.2.3", true)]
    #[case::prerelease("1.2.3-beta.1", true)]
    #[case::largest_safe_major("9007199254740991.0.0", true)]
    #[case::leading_v("v1.2.3", false)]
    #[case::leading_space(" 1.2.3", false)]
    #[case::build_metadata("1.2.3+b", false)]
    #[case::major_past_safe_integer("9007199254740992.0.0", false)]
    fn a_version_is_kept_only_in_its_canonical_form(#[case] token: &str, #[case] is_kept: bool) {
        assert_eq!(is_canonical_semver(token), is_kept, "{token}");
    }
}
