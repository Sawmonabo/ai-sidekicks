//! `daemon.config.read` and `daemon.config.update`: the service's settings on Settings › Runtime,
//! read from and written through the configuration store. A port another program holds is saved
//! all the same; the listener's own state reports that nothing listens there.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::daemon::config::{
    DaemonConfig, DaemonConfigRead, DaemonConfigUpdate, DaemonConfigUpdateRequest,
};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::method_descriptor::EmptyPayload;

use crate::daemon::configuration::{
    ConfigurationChange, ConfigurationError, ConfigurationStore, DaemonConfiguration,
};
use crate::ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};

/// What the config methods read beside the store.
pub(crate) struct ConfigMethodsDeps {
    /// The configuration store.
    pub(crate) configuration: Arc<ConfigurationStore>,
    /// Whether this operating system lets the service enforce the tool-process memory cap.
    pub(crate) tool_memory_cap_enforceable: bool,
    /// The folder raw provider messages are written to.
    pub(crate) provider_messages_path: FilesystemPath,
}

impl From<ConfigurationError> for HandlerError {
    /// A configuration the daemon cannot read or write is a fault in the daemon.
    fn from(error: ConfigurationError) -> Self {
        Self::Internal(Box::new(error))
    }
}

/// Registers `daemon.config.read` and `daemon.config.update`; an update changes exactly one
/// setting and answers the settings with it. Fails the start when a method is already registered.
pub(crate) fn register_config_methods(
    registry: &mut MethodRegistryBuilder,
    deps: ConfigMethodsDeps,
) -> Result<(), RegistrationError> {
    let deps = Arc::new(deps);
    let reading = Arc::clone(&deps);
    registry.register::<DaemonConfigRead, _>(
        move |_: EmptyPayload, _context: HandlerContext| {
            let deps = Arc::clone(&reading);
            async move { Ok(daemon_config_of(&deps, &deps.configuration.current())) }.boxed()
        },
    )?;
    registry.register::<DaemonConfigUpdate, _>(
        move |request: DaemonConfigUpdateRequest, _context: HandlerContext| {
            let deps = Arc::clone(&deps);
            async move {
                let configuration = deps
                    .configuration
                    .update(ConfigurationChange::Setting(&request))
                    .await?;
                Ok(daemon_config_of(&deps, &configuration))
            }
            .boxed()
        },
    )
}

// The settings the wire reads, from the stored configuration and the two facts beside it.
fn daemon_config_of(deps: &ConfigMethodsDeps, configuration: &DaemonConfiguration) -> DaemonConfig {
    DaemonConfig {
        workflow_listener_port: configuration.workflow_listener_port,
        run_time_limit_minutes: configuration.run_time_limit_minutes,
        workflow_chain_ask_after_runs: configuration.workflow_chain_ask_after_runs,
        max_steps_per_turn: configuration.max_steps_per_turn,
        spend_limit_usd_micros: configuration.spend_limit_usd_micros,
        tokens_per_run: configuration.tokens_per_run,
        tool_memory_cap_bytes: configuration.tool_memory_cap_bytes,
        package_cache_limit_bytes: configuration.package_cache_limit_bytes,
        record_traces: configuration.record_traces,
        record_provider_messages: configuration.record_provider_messages,
        tool_memory_cap_enforceable: deps.tool_memory_cap_enforceable,
        provider_messages_path: deps.provider_messages_path.clone(),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;
    use sidekicks_contracts::daemon::config::{
        DEFAULT_WORKFLOW_LISTENER_PORT, DaemonConfig, DaemonConfigRead, DaemonConfigUpdate,
    };
    use sidekicks_contracts::free_form_string::FilesystemPath;
    use sidekicks_contracts::method::Method as _;

    use super::{ConfigMethodsDeps, register_config_methods};
    use crate::daemon::configuration::{
        ConfigurationStore, DAEMON_CONFIGURATION_STATEMENT_CAPACITY,
    };
    use crate::database::connection::read_pool::DatabaseReadPool;
    use crate::database::writer::test_file::TestDatabase;
    use crate::events::log_service::tests::open_log;
    use crate::ipc::call_fixtures::{context, request};
    use crate::ipc::registry::{Dispatch as _, DispatchError, MethodRegistryBuilder, Reply};
    use crate::remote::shared_ports::schema::schema_parts;

    // The port and step bound as the row holds them.
    fn stored_settings(database: &TestDatabase) -> (i64, Option<i64>) {
        database
            .reader()
            .query_row(
                "SELECT workflow_listener_port, max_steps_per_turn FROM daemon_configuration",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the test reads the row")
    }

    // A value out of its range is refused before anything is written, and a port another program
    // holds is saved and read back. Killed by the check moved behind the write, and by a port
    // refused for being taken.
    #[tokio::test]
    async fn a_refused_setting_writes_nothing_and_a_held_port_is_saved() {
        let database = TestDatabase::new(schema_parts());
        let log = open_log(&database, None).await;
        let reads = DatabaseReadPool::new(database.path(), DAEMON_CONFIGURATION_STATEMENT_CAPACITY);
        let configuration = Arc::new(
            ConfigurationStore::open(Arc::clone(&log.writer), &reads)
                .await
                .expect("the configuration store opens"),
        );
        let mut builder = MethodRegistryBuilder::new();
        register_config_methods(
            &mut builder,
            ConfigMethodsDeps {
                configuration,
                tool_memory_cap_enforceable: false,
                provider_messages_path: FilesystemPath::new("/messages".to_owned())
                    .expect("the test's path is a path"),
            },
        )
        .expect("the config methods register");
        let registry = builder.freeze();
        let update = |params: serde_json::Value| {
            registry.dispatch(
                request(DaemonConfigUpdate::DESCRIPTOR.method, Some(&params)),
                context(1),
            )
        };
        let default_port = i64::from(DEFAULT_WORKFLOW_LISTENER_PORT);

        for refused in [
            json!({ "workflowListenerPort": 0 }),
            json!({ "workflowListenerPort": "7391" }),
            json!({ "maxStepsPerTurn": 0 }),
        ] {
            assert!(
                matches!(update(refused).await, Err(DispatchError::ParamsInvalid(_))),
                "an out-of-range value is refused"
            );
        }
        assert_eq!(stored_settings(&database), (default_port, None));

        let held = std::net::TcpListener::bind("127.0.0.1:0").expect("the test holds a port");
        let held_port = held.local_addr().expect("the port reads").port();
        assert!(
            update(json!({ "workflowListenerPort": held_port }))
                .await
                .is_ok(),
            "a held port is saved"
        );
        let Ok(Reply::Result(read)) = registry
            .dispatch(
                request(DaemonConfigRead::DESCRIPTOR.method, Some(&json!({}))),
                context(1),
            )
            .await
        else {
            panic!("the read answers");
        };
        let read: DaemonConfig = serde_json::from_slice(&read.json).expect("the read is a config");
        assert_eq!(read.workflow_listener_port.get(), held_port);
        assert_eq!(stored_settings(&database), (i64::from(held_port), None));
    }
}
