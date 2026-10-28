//! The daemon's three machine-settings methods: the read, the one write the desktop and every other
//! device go through, and the live read every console window follows.

use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::json;
use sidekicks_contracts::jsonrpc::issue::{Issue, IssuePathSegment};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::machine::settings::{
    BranchNamePattern, MachineSettingsChange, MachineSettingsRead, MachineSettingsReading,
    MachineSettingsSubscribe, MachineSettingsUpdate, MachineSettingsUpdateRequest,
    MachineSettingsUpdateResponse, ProjectBranchPatternRefusedDetails,
};
use sidekicks_contracts::place::PlacedPath;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_ipc::stream::feed::Feed;
use sidekicks_ipc::stream::latest_value::LatestValueFeed;
use sidekicks_platforms::PathRules;
use sidekicks_workspace::project::refusals::{refuse_branch_pattern, refuse_environment_rows};

use crate::daemon::machine_settings::file::{MachineSettingsFile, MachineSettingsFileError};

/// Why a `Branch names` pattern cannot be saved, `None` when it can: git's branch-name rule and
/// a clash in each project that keeps no pattern of its own. Fails when git could not run.
pub(crate) type FindBranchPatternRefusal = Arc<
    dyn Fn(
            BranchNamePattern,
        )
            -> BoxFuture<'static, Result<Option<ProjectBranchPatternRefusedDetails>, HandlerError>>
        + Send
        + Sync,
>;

/// What the machine-settings methods need.
pub(crate) struct MachineSettingsMethodsDeps {
    /// The settings file.
    pub(crate) settings_file: Arc<MachineSettingsFile>,
    /// The names a registered provider's driver sets, which no environment row may name.
    pub(crate) driver_set_names: Vec<&'static str>,
    /// The check of a pattern past its placeholder rule.
    pub(crate) find_branch_pattern_refusal: FindBranchPatternRefusal,
}

impl From<MachineSettingsFileError> for HandlerError {
    /// A file the daemon cannot read or write is a fault in the daemon.
    fn from(error: MachineSettingsFileError) -> Self {
        Self::Internal(Box::new(error))
    }
}

/// Registers `machine.settings.read`, `machine.settings.update` and `machine.settings.subscribe`.
/// An update with a refused environment row or branch-name pattern, or a clone folder that names
/// no complete location, is refused before anything is written. Fails the start when a method is
/// already registered.
pub(crate) fn register_machine_settings_methods(
    registry: &mut MethodRegistryBuilder,
    deps: MachineSettingsMethodsDeps,
) -> Result<(), RegistrationError> {
    let reading_file = Arc::clone(&deps.settings_file);
    registry.register::<MachineSettingsRead, _>(move |_params, _context: HandlerContext| {
        let file = Arc::clone(&reading_file);
        async move { Ok(file.read().await?) }.boxed()
    })?;

    let updating_file = Arc::clone(&deps.settings_file);
    let driver_set_names: Arc<[&'static str]> = deps.driver_set_names.into();
    let find_branch_pattern_refusal = deps.find_branch_pattern_refusal;
    registry.register::<MachineSettingsUpdate, _>(
        move |request: MachineSettingsUpdateRequest, _context: HandlerContext| {
            let file = Arc::clone(&updating_file);
            let driver_set_names = Arc::clone(&driver_set_names);
            let find_branch_pattern_refusal = Arc::clone(&find_branch_pattern_refusal);
            async move {
                match &request.change {
                    MachineSettingsChange::EnvironmentRows(rows) => {
                        refuse_environment_rows(rows, &driver_set_names)?;
                    }
                    MachineSettingsChange::BranchNamePattern(pattern) => {
                        let refusal = match BranchNamePattern::new(pattern.clone()) {
                            Ok(pattern) => find_branch_pattern_refusal(pattern).await?,
                            Err(refusal) => Some(refusal),
                        };
                        refuse_branch_pattern(refusal)?;
                    }
                    MachineSettingsChange::CloneFolder(folder) => {
                        refuse_relative_clone_folder(folder.as_ref())?;
                    }
                    MachineSettingsChange::UpdatesAutomatic(_)
                    | MachineSettingsChange::KeepCrashReports(_)
                    | MachineSettingsChange::EditorId(_)
                    | MachineSettingsChange::CommitTextModel(_)
                    | MachineSettingsChange::DefaultCheckout(_)
                    | MachineSettingsChange::NewSessionCarriesLastModel(_)
                    | MachineSettingsChange::LastLeadModel(_)
                    | MachineSettingsChange::KeepAwakeWhileAgentWorks(_)
                    | MachineSettingsChange::KeepAwakeForOtherDevices(_)
                    | MachineSettingsChange::Notifications(_)
                    | MachineSettingsChange::RememberSiteData(_)
                    | MachineSettingsChange::BrowserToolsForAgents(_)
                    | MachineSettingsChange::SandboxBackgroundBrowser(_)
                    | MachineSettingsChange::ScreenReaderMode(_)
                    | MachineSettingsChange::Backup(_)
                    | MachineSettingsChange::Voice(_) => {}
                }
                Ok(MachineSettingsUpdateResponse {
                    settings: file.update(request.change).await?,
                })
            }
            .boxed()
        },
    )?;

    let following_file = deps.settings_file;
    registry.register_subscription::<MachineSettingsSubscribe, _>(
        move |_params, _context: HandlerContext, subscription_id: SubscriptionId| {
            let file = Arc::clone(&following_file);
            async move {
                // The registry writes the acknowledgment before the feed's first read, so the
                // first reading never reaches a client ahead of its subscription's id.
                let feed =
                    LatestValueFeed::open(|outlet| async move { Ok(file.follow(outlet).await?) })
                        .await?;
                let feed: Box<dyn Feed<Emission = MachineSettingsReading>> = Box::new(feed);
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )
}

// Refuses as the request's own params a clone folder that names no complete location, its issue
// at the folder's path, since a relative one would be completed from the daemon's own folder; a
// cleared folder passes. A folder in a WSL distribution is in Linux form there.
fn refuse_relative_clone_folder(folder: Option<&PlacedPath>) -> Result<(), DomainError> {
    let Some(folder) = folder else {
        return Ok(());
    };
    let rules = if folder.place.is_some() {
        PathRules::Posix
    } else {
        PathRules::NATIVE
    };
    if rules.names_complete_location(folder.path.as_str()) {
        return Ok(());
    }
    let member = |name: &str| IssuePathSegment::Member(name.to_owned());
    Err(DomainError::new(
        "the params break the method's contract",
        RefusalCode::RequestParamsInvalid,
    )
    .with_detail(json!({
        "issues": [Issue {
            path: vec![member("change"), member("cloneFolder"), member("path")],
            message: "the folder must name one complete location".to_owned(),
            params: None,
        }],
    })))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use futures::FutureExt as _;
    use serde_json::json;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::machine::settings::{
        MachineSettingsReading, MachineSettingsSubscribe, MachineSettingsUpdate,
    };
    use sidekicks_contracts::method::Method as _;
    use sidekicks_ipc::call_fixtures::{context, request};
    use sidekicks_ipc::registry::{Dispatch as _, DispatchError, MethodRegistryBuilder, Reply};
    use sidekicks_ipc::stream::feed::CreditGate;

    use super::{MachineSettingsMethodsDeps, register_machine_settings_methods};
    use crate::daemon::machine_settings::file::{MachineSettingsFile, machine_settings_file_path};

    const WAIT: Duration = Duration::from_secs(10);

    // A change one client makes reaches a second client's subscription and the file on disk, and
    // a credential-shaped environment row or a relative clone folder is refused with nothing
    // written. Killed by either check moved behind the write, and by an update that reaches no
    // follower.
    #[tokio::test]
    async fn an_update_reaches_another_client_and_the_file_and_a_refused_change_writes_nothing() {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let file_path = machine_settings_file_path(folder.path());
        let mut builder = MethodRegistryBuilder::new();
        register_machine_settings_methods(
            &mut builder,
            MachineSettingsMethodsDeps {
                settings_file: Arc::new(MachineSettingsFile::new(file_path.clone())),
                driver_set_names: Vec::new(),
                find_branch_pattern_refusal: Arc::new(|_pattern| async { Ok(None) }.boxed()),
            },
        )
        .expect("the settings methods register");
        let registry = builder.freeze();
        let Ok(Reply::Subscription { mut feed, .. }) = registry
            .dispatch(
                request(
                    MachineSettingsSubscribe::DESCRIPTOR.method,
                    Some(&json!({})),
                ),
                context(2),
            )
            .await
        else {
            panic!("the subscribe answers a subscription");
        };
        let gate = CreditGate::with_credit(4);
        let mut next_reading = async || -> MachineSettingsReading {
            let value = tokio::time::timeout(WAIT, feed.next(&gate))
                .await
                .expect("an emission comes")
                .expect("the reading reads")
                .expect("the stream goes on");
            serde_json::from_slice(&value.json).expect("the emission reads as its type")
        };
        assert!(next_reading().await.settings.updates_automatic);
        let file_before = std::fs::read(&file_path).ok();

        let refused = registry
            .dispatch(
                request(
                    MachineSettingsUpdate::DESCRIPTOR.method,
                    Some(&json!({ "change": { "environmentRows": [
                        { "name": "GITHUB_TOKEN", "value": "planted" }
                    ] } })),
                ),
                context(1),
            )
            .await;
        let Err(DispatchError::Refused(refusal)) = refused else {
            panic!("a credential-shaped row is refused");
        };
        assert_eq!(refusal.code, RefusalCode::ProjectEnvironmentNameRefused);
        assert_eq!(
            std::fs::read(&file_path).ok(),
            file_before,
            "nothing is written"
        );

        let refused = registry
            .dispatch(
                request(
                    MachineSettingsUpdate::DESCRIPTOR.method,
                    Some(&json!({ "change": { "cloneFolder": { "path": "repos" } } })),
                ),
                context(1),
            )
            .await;
        let Err(DispatchError::Refused(refusal)) = refused else {
            panic!("a relative clone folder is refused");
        };
        assert_eq!(refusal.code, RefusalCode::RequestParamsInvalid);
        assert_eq!(
            refusal
                .detail
                .and_then(|fields| fields.get("issues").cloned()),
            Some(json!([{
                "path": ["change", "cloneFolder", "path"],
                "message": "the folder must name one complete location",
            }]))
        );
        assert_eq!(
            std::fs::read(&file_path).ok(),
            file_before,
            "nothing is written"
        );

        let updated = registry
            .dispatch(
                request(
                    MachineSettingsUpdate::DESCRIPTOR.method,
                    Some(&json!({ "change": { "updatesAutomatic": false } })),
                ),
                context(1),
            )
            .await;
        assert!(matches!(updated, Ok(Reply::Result(_))));
        assert!(!next_reading().await.settings.updates_automatic);
        let on_disk = MachineSettingsFile::new(file_path)
            .read()
            .await
            .expect("the file reads");
        assert!(!on_disk.settings.updates_automatic);
        assert_eq!(on_disk.settings.environment_rows, Vec::new());
    }
}
