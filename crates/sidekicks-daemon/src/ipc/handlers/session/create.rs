//! `session.create`: starts a session where the request binds it, led by the lead it names, and
//! keeps that lead's model and effort as the person's last pick.

use std::error::Error;
use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::machine::settings::{LastLeadModel, MachineSettingsChange};
use sidekicks_contracts::session::directory::{
    SessionCreate, SessionCreateRequest, SessionCreateResponse,
};
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_session::create::SessionCreation;

use crate::daemon::machine_settings::file::MachineSettingsFile;

/// Registers `session.create` over `creation`, which refuses as its doc names. After every
/// create that answers a session, a repeated key's among them, the lead's model and effort are
/// kept in `settings_file` as the last pick, whatever the setting that carries it to a new
/// session says; a pick that cannot be kept is logged and the session answered. Fails the start
/// when the method is already registered.
pub(crate) fn register_session_create(
    registry: &mut MethodRegistryBuilder,
    creation: Arc<SessionCreation>,
    settings_file: Arc<MachineSettingsFile>,
) -> Result<(), RegistrationError> {
    registry.register::<SessionCreate, _>(
        move |request: SessionCreateRequest, _context: HandlerContext| {
            let creation = Arc::clone(&creation);
            let settings_file = Arc::clone(&settings_file);
            async move {
                let created = creation.create(&request).await?;
                keep_last_lead_pick(&settings_file, &created).await;
                Ok(created)
            }
            .boxed()
        },
    )
}

// The last pick is a remembered preference and the session already exists, so a pick that
// cannot be kept is logged rather than failing the create.
async fn keep_last_lead_pick(settings_file: &MachineSettingsFile, created: &SessionCreateResponse) {
    let pick = LastLeadModel {
        provider_name: created.lead.provider_name.clone(),
        model_id: created.lead.model_id.clone(),
        effort: created.lead.effort.clone(),
    };
    if let Err(error) = settings_file
        .update(MachineSettingsChange::LastLeadModel(Some(pick)))
        .await
    {
        tracing::warn!(
            session_id = %created.session_id,
            error = &error as &(dyn Error + 'static),
            "the lead model the session was created on could not be kept as the last pick"
        );
    }
}
