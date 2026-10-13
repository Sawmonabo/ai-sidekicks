//! The `sidekicks://` link: the one address form that reaches a session or a workflow run from
//! outside the app. `sidekicks open` parses it here; the desktop's copy of the two functions reads
//! the same case table, so the form a link is written in and the form it is read in never differ.
//! A link arrives from any program on the machine, so the parser accepts only the exact form
//! [`compose_app_link`] writes and hands back nothing but a checked id.

use schemars::JsonSchema;

use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::workflow::run::id::WorkflowRunId;

ts_constants! {
    /// The link's URI scheme, which the desktop registers with the operating system as the app's
    /// own and finds a link by on a command line.
    pub const APP_LINK_SCHEME: &str = "sidekicks";
}

/// What a `sidekicks://` link opens: a session, or a workflow run's page.
#[derive(Clone, Debug, PartialEq, Eq, JsonSchema)]
#[cfg_attr(test, derive(serde::Deserialize))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AppLinkTarget {
    /// A session.
    Session {
        /// The session's id.
        session_id: SessionId,
    },
    /// A workflow run's page.
    WorkflowRun {
        /// The run's id.
        workflow_run_id: WorkflowRunId,
    },
}

/// The link's host for a session.
const SESSION_HOST: &str = "session";

/// The link's host for a workflow run's page.
const WORKFLOW_RUN_HOST: &str = "workflow-run";

/// Writes the link for a target: `sidekicks://session/<id>` or `sidekicks://workflow-run/<id>`.
/// An id is a UUID, whose characters a URI leaves unescaped, so the link needs no encoding.
pub fn compose_app_link(target: &AppLinkTarget) -> String {
    let (host, id) = match target {
        AppLinkTarget::Session { session_id } => (SESSION_HOST, session_id.as_str()),
        AppLinkTarget::WorkflowRun { workflow_run_id } => {
            (WORKFLOW_RUN_HOST, workflow_run_id.as_str())
        }
    };
    format!("{APP_LINK_SCHEME}://{host}/{id}")
}

/// Reads a link back into its target, or `None` when the text is not exactly a link
/// [`compose_app_link`] writes: another scheme or host, a trailing slash, a query, a fragment, a
/// second path segment, or an id its kind refuses.
pub fn parse_app_link(address: &str) -> Option<AppLinkTarget> {
    let rest = address.strip_prefix(APP_LINK_SCHEME)?.strip_prefix("://")?;
    let (host, id) = rest.split_once('/')?;
    match host {
        SESSION_HOST => SessionId::new(id.to_owned())
            .ok()
            .map(|session_id| AppLinkTarget::Session { session_id }),
        WORKFLOW_RUN_HOST => WorkflowRunId::new(id.to_owned())
            .ok()
            .map(|workflow_run_id| AppLinkTarget::WorkflowRun { workflow_run_id }),
        _ => None,
    }
}

/// The TypeScript module of the link's scheme and target; the hand-written pair that composes and
/// parses a link sits beside it.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "app-link/target",
    doc: "What a `sidekicks://` link opens, and the link's URI scheme.",
    definitions: &[Definition::read::<AppLinkTarget>()],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::{AppLinkTarget, compose_app_link, parse_app_link};

    /// The case table the desktop's pair also reads: each target with its link, and each text with
    /// the target it parses to, or none.
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct AppLinkCases {
        composed: Vec<ComposedCase>,
        parsed: Vec<ParsedCase>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct ComposedCase {
        target: AppLinkTarget,
        link: String,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct ParsedCase {
        link: String,
        target: Option<AppLinkTarget>,
    }

    #[test]
    fn a_link_parses_back_to_exactly_the_target_it_was_written_for() {
        let cases: AppLinkCases =
            serde_json::from_str(include_str!("../tests/fixtures/app-link.json"))
                .expect("the case table reads");
        for case in cases.composed {
            assert_eq!(compose_app_link(&case.target), case.link);
            assert_eq!(parse_app_link(&case.link), Some(case.target));
        }
        for case in cases.parsed {
            assert_eq!(parse_app_link(&case.link), case.target, "{}", case.link);
        }
    }
}
