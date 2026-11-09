//! The answer of a provider's sign-in probe: what it found and the account or plan descriptor it
//! read, cut to its cap.

use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::text_cut::cut_to_code_points;

/// The longest account or plan descriptor an authentication probe keeps, in code points; a longer
/// one is cut, and dropping it loses only words, never the probe's status.
const PROVIDER_AUTH_DETAIL_MAX_LEN: usize = 512;

/// What an authentication probe found. An indeterminate probe counts as not signed in for
/// admission, yet stays apart from a signed-out one, so a person can tell probe health from
/// credential state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DriverAuthProbeStatus {
    /// Signed in.
    Authenticated,
    /// Signed out.
    Unauthenticated,
    /// The probe could not be read.
    Indeterminate,
}

/// The answer of the zero-turn authentication probe. Admission reads `status`; a turn mid-run whose
/// credential expired is a recovery condition, not this probe.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DriverAuthProbeResult {
    /// What the probe found.
    pub(crate) status: DriverAuthProbeStatus,
    /// The provider's account or plan descriptor, which can hold an email address: shown to the
    /// person and never stored or carried on an event.
    pub(crate) detail: Option<FreeFormText<PROVIDER_AUTH_DETAIL_MAX_LEN>>,
}

/// A probe's answer with `detail` cut to its cap, and dropped where it is still not valid text,
/// since `status` alone carries the decision.
pub(crate) fn build_auth_probe_result(
    status: DriverAuthProbeStatus,
    detail: &str,
) -> DriverAuthProbeResult {
    // A blank or NUL-holding descriptor is dropped: it only explains the status.
    let detail =
        FreeFormText::new(cut_to_code_points(detail, PROVIDER_AUTH_DETAIL_MAX_LEN).to_owned()).ok();
    DriverAuthProbeResult { status, detail }
}
