//! The daemon's three machine-settings methods: the read, the one write the desktop and every other
//! device go through, and the live read every console window follows.

use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::machine::settings::{
    BranchNamePattern, MachineSettingsChange, MachineSettingsRead, MachineSettingsReading,
    MachineSettingsSubscribe, MachineSettingsUpdate, MachineSettingsUpdateRequest,
    MachineSettingsUpdateResponse, ProjectBranchPatternRefusedDetails,
};

use crate::daemon::machine::settings::file::{MachineSettingsFile, MachineSettingsFileError};
use crate::daemon::machine::settings::refusals::{refuse_branch_pattern, refuse_environment_rows};
use crate::ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use crate::ipc::stream::feed::Feed;
use crate::ipc::stream::latest_value::LatestValueFeed;

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
/// An update with a refused environment row or branch-name pattern is refused before anything is
/// written. Fails the start when a method is already registered.
#[expect(
    dead_code,
    reason = "the daemon's start registers the settings methods once the file is open"
)]
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
                    _ => {}
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
