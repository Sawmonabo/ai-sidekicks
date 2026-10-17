//! The two gates every request passes before the router, both allow-lists: the bootstrap flag must
//! be exactly `1` and the environment exactly `development`, so a typo, an omission or any other
//! value keeps an unfinished control plane unreachable.

use axum::http::StatusCode;
use axum::http::header::CONTENT_TYPE;
use axum::response::{IntoResponse, Response};

/// The variable the bootstrap gate reads, a kill switch that is off unless set.
pub const BOOTSTRAP_ENABLED_KEY: &str = "CONTROL_PLANE_BOOTSTRAP_ENABLED";

/// The variable the environment gate reads.
pub const ENVIRONMENT_KEY: &str = "ENVIRONMENT";

const BOOTSTRAP_ENABLED_VALUE: &str = "1";
const DEVELOPMENT_VALUE: &str = "development";

/// Why a gate refused a request, the reason its host logs; the caller reads only a 503.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum GateRefusal {
    /// The bootstrap flag is absent or not exactly `1`.
    #[error("feature flag {BOOTSTRAP_ENABLED_KEY} not set to '{BOOTSTRAP_ENABLED_VALUE}'")]
    BootstrapDisabled,
    /// The environment is absent or not exactly `development`.
    #[error("{ENVIRONMENT_KEY} allow-list rejected {observed} (only '{DEVELOPMENT_VALUE}' passes)")]
    NotDevelopment {
        /// The value seen, quoted, or `absent`.
        observed: String,
    },
}

/// Passes a request only when `bootstrap_enabled` is exactly `1` and `environment` exactly
/// `development`, each `None` when its variable is absent.
pub fn check_request_gates(
    bootstrap_enabled: Option<&str>,
    environment: Option<&str>,
) -> Result<(), GateRefusal> {
    if bootstrap_enabled != Some(BOOTSTRAP_ENABLED_VALUE) {
        return Err(GateRefusal::BootstrapDisabled);
    }
    if environment != Some(DEVELOPMENT_VALUE) {
        let observed =
            environment.map_or_else(|| "absent".to_owned(), |value| format!("'{value}'"));
        return Err(GateRefusal::NotDevelopment { observed });
    }
    Ok(())
}

impl IntoResponse for GateRefusal {
    fn into_response(self) -> Response {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            [(CONTENT_TYPE, "text/plain; charset=utf-8")],
            "Service Unavailable",
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::{GateRefusal, check_request_gates};

    #[rstest]
    #[case::flag_absent(None, Some("development"), Err(GateRefusal::BootstrapDisabled))]
    #[case::flag_empty(Some(""), Some("development"), Err(GateRefusal::BootstrapDisabled))]
    #[case::flag_true(Some("true"), Some("development"), Err(GateRefusal::BootstrapDisabled))]
    #[case::environment_absent(
        Some("1"),
        None,
        Err(GateRefusal::NotDevelopment { observed: "absent".to_owned() })
    )]
    #[case::environment_empty(
        Some("1"),
        Some(""),
        Err(GateRefusal::NotDevelopment { observed: "''".to_owned() })
    )]
    #[case::production(
        Some("1"),
        Some("production"),
        Err(GateRefusal::NotDevelopment { observed: "'production'".to_owned() })
    )]
    #[case::both_pass(Some("1"), Some("development"), Ok(()))]
    fn only_both_exact_values_pass(
        #[case] bootstrap_enabled: Option<&str>,
        #[case] environment: Option<&str>,
        #[case] expected: Result<(), GateRefusal>,
    ) {
        assert_eq!(
            check_request_gates(bootstrap_enabled, environment),
            expected
        );
    }
}
