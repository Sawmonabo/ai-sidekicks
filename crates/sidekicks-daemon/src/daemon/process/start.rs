//! The daemon's start: its steps, in the order each service needs the ones before it, each part
//! kept in the process as it is taken, so a failed step's release lets it go.

pub(crate) mod error;
pub(crate) mod options;

use std::error::Error;
use std::sync::{Arc, OnceLock};

use jiff::Timestamp;
use sidekicks_artifact::plans::store::StoredPlanHolds;
use sidekicks_contracts::daemon::lifecycle::DAEMON_READY_LINE;
use sidekicks_contracts::jsonrpc::negotiation::CURRENT_PROTOCOL_VERSION;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_ipc::caller_process::descent::CallerCheck;
use sidekicks_ipc::in_flight_mutations::InFlightMutations;
use sidekicks_ipc::protocol_negotiation::ProtocolNegotiator;
use sidekicks_ipc::registry::MethodRegistryBuilder;
use sidekicks_ipc::stream::subscriptions::Subscriptions;
use sidekicks_platforms::{
    KeepAwakeHold, PowerSourceWatch, WakeWatch, WallClock, WallClockTimer, askpass_socket_path,
    check_socket_path, read_command_argument_limit,
};
use sidekicks_policy::authorizer::Authorizer;
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_provider::command::channel::remove_channel_folders;
use sidekicks_provider::tool_call_arguments::remove_left_tool_call_arguments;
use sidekicks_recovery::database_file::copy::DatabaseFileCopier;
use sidekicks_recovery::database_file::sqlite_shell::SqliteShell;
use sidekicks_session::directory::list_feed::SessionListFeed;
use sidekicks_session::search::index::live::{LiveIndex, LiveIndexOptions};
use sidekicks_shell::orphan::guard::open_orphan_guard;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_store::credential_store::items::{SecretItems, SecretItemsStart};
use sidekicks_store::credential_store::os::KEYCHAIN_CALL_TIMEOUT;
use sidekicks_store::data_folder::{data_folder, program_link_folder, tools_folder};
use sidekicks_store::database::connection::writer_open::{
    DAEMON_DATABASE_FILE_NAME, SEARCH_INDEX_FOLDER_NAME,
};
use sidekicks_store::machine::identity_key::MachineIdentity;
use sidekicks_store::machine::local::read_or_mint_local_machine;
use sidekicks_workspace::git::process::environment::find_git_executable;
use sidekicks_workspace::git::process::{GitLimits, GitRunner};
use tokio::runtime::Handle;

use crate::bootstrap::{SecureDefaults, SecureDefaultsConfig};
use crate::daemon::artifact_methods::{ArtifactMethodsDeps, register_artifact_methods};
use crate::daemon::backup::git_folders::BackupGitFolders;
use crate::daemon::backup::roots::mirror_roots_reader;
use crate::daemon::backup::run::{
    BackupDeps, Backups, backup_folder, backup_manifest_facts, default_backup_folder,
};
use crate::daemon::bun::BunInstall;
use crate::daemon::configuration::ConfigurationStore;
use crate::daemon::crash::monitor::{crash_monitor_socket_path, remove_dead_monitor_sockets};
use crate::daemon::keep_awake::{KeepAwakeDeps, keep_machine_awake};
use crate::daemon::login_shell_environment::capture_provider_base_environment;
use crate::daemon::machine_settings::file::{MachineSettingsFile, machine_settings_file_path};
use crate::daemon::process::DaemonProcess;
use crate::daemon::process::crash_monitor::CrashMonitor;
use crate::daemon::process::damage_gate::DispatchDamageWatch;
use crate::daemon::process::database::{DatabaseFileStart, open_database_file};
use crate::daemon::process::jobs::{IdleMemoryCollect, JobDeps, schedule_jobs};
use crate::daemon::process::mcp_attribution::McpAttributionFills;
use crate::daemon::process::method_inputs::{
    MethodInputsStart, device_id_of, register_method_inputs,
};
use crate::daemon::process::method_tables::gate_chain;
use crate::daemon::process::providers::pricing::{PricingStart, build_pricing};
use crate::daemon::process::providers::stored_rows::apply_stored_rows;
use crate::daemon::process::providers::{
    ProviderStart, build_providers, hydrate_capabilities, register_providers,
    sweep_left_settings_files, sweep_left_sign_in_folders, sweep_left_staged_worktrees,
};
use crate::daemon::process::repo_services::{
    RepoServiceStart, build_repo_services, make_worktrees_folder, managed_writes_watermark_path,
    read_managed_writes_watermark, start_repo_attachments,
};
use crate::daemon::process::session_services::{follow_binding_cursors, start_session_attachments};
use crate::daemon::process::start::error::DaemonStartError;
use crate::daemon::process::start::options::{DaemonStartOptions, ProviderBaseEnvironment};
use crate::daemon::process::supervision::ServingSocketHooks;
use crate::daemon::process::workspace_services::settle_interrupted_creations;
use crate::daemon::run_folder::{bind_socket, mint_session_token, prepare_run_folder};
use crate::daemon::service_status::remove_service_status;
use crate::daemon::start_stopped_error::DaemonStartStoppedError;
use crate::data_acts::export::set_aside_cut_short_export;
use crate::ipc::local_gateway::{GatewayServices, LocalGateway};
use crate::observability::diagnostic_buckets::expiry::{
    DiagnosticExpiryDeps, live_diagnostic_files,
};

impl DaemonProcess {
    // The start's steps, each part kept in the process as it is taken, so a failure releases it.
    pub(super) async fn run_start(
        &mut self,
        options: DaemonStartOptions,
    ) -> Result<(), DaemonStartError> {
        let DaemonStartOptions {
            home_folder,
            data_folder_lock,
            run_folder,
            daemon_program,
            process_identity,
            version,
            caller_process_reader,
            stop: _,
            base_environment,
            credential_store,
            runs_while_logged_out,
            service_log_files,
            provider_registrations,
        } = options;
        self.data_folder_lock = Some(data_folder_lock);
        let (home_folder, run_folder, daemon_program) =
            (home_folder.as_path(), &run_folder, daemon_program.as_path());
        let monitor_socket_path =
            crash_monitor_socket_path(&run_folder.folder_path, std::process::id());
        let askpass_socket_path = askpass_socket_path(&run_folder.folder_path);
        for path in [
            &run_folder.socket_path,
            &monitor_socket_path,
            &askpass_socket_path,
        ] {
            check_socket_path(path).map_err(|source| DaemonStartError::SocketPathRefused {
                path: path.clone(),
                source,
            })?;
        }
        let data_folder = data_folder(home_folder);
        let bun = Arc::new(
            BunInstall::for_release(&tools_folder(&data_folder))
                .map_err(DaemonStartError::BunClient)?,
        );
        prepare_run_folder(run_folder).await?;
        remove_dead_monitor_sockets(&run_folder.folder_path).await;
        // Under the data folder's lock and before the socket binds, so no export runs meanwhile;
        // the folder is renamed aside here and removed once the socket serves.
        let cut_short_export = set_aside_cut_short_export(&data_folder).await;
        let session_token = mint_session_token().map_err(DaemonStartError::SessionToken)?;
        self.crash_monitor = Some(CrashMonitor::start(
            &self.spawner,
            daemon_program,
            monitor_socket_path,
        ));
        let shell_lines = Arc::new(ShellLineReadingBound::new(
            read_command_argument_limit().map_err(DaemonStartError::CommandArgumentLimit)?,
        ));
        let capture = async {
            match base_environment {
                ProviderBaseEnvironment::Capture => {
                    capture_provider_base_environment(&self.spawner, home_folder, &self.work_stop)
                        .await
                        .map(Arc::from)
                }
                ProviderBaseEnvironment::Given(pairs) => Ok(pairs),
            }
        };
        let (base_environment, orphan_guard) =
            tokio::join!(capture, open_orphan_guard(&data_folder));
        let orphan_guard = Arc::new(orphan_guard.map_err(DaemonStartError::OrphanGuard)?);
        self.orphan_guard = Some(Arc::clone(&orphan_guard));
        let base_environment = base_environment.map_err(DaemonStartError::BaseEnvironment)?;
        let settings = Arc::new(MachineSettingsFile::new(machine_settings_file_path(
            home_folder,
        )));
        // The repair reads the newest backup, which a failed settings read still finds in the
        // default folder.
        let backup_folder = match backup_folder(&settings, home_folder).await {
            Ok(folder) => folder,
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "the backup settings could not be read, so the repair reads the default \
                     backups folder"
                );
                default_backup_folder(home_folder)
            }
        };
        let shell = SqliteShell::new(daemon_program.to_path_buf(), self.spawner.clone());
        let copier = Arc::new(DatabaseFileCopier::new(
            daemon_program.to_path_buf(),
            self.spawner.clone(),
        ));
        let secure_defaults = SecureDefaults::load(SecureDefaultsConfig {
            local_ipc_path: run_folder.socket_path.clone(),
        })?;
        let index_folder = data_folder.join(SEARCH_INDEX_FOLDER_NAME);
        // Taken before the database's hold on the process, which lasts to the method tables.
        let accept_stop = self.accept_stop();
        let stop_work_step = self.stop_work_step();
        let close_data_folder_step = self.close_data_folder_step();
        let daemon_started_at =
            WireInstant::from_timestamp(self.started_at).expect("the clock reads after year 0000");
        let database = self.database.insert(
            open_database_file(DatabaseFileStart {
                database_path: data_folder.join(DAEMON_DATABASE_FILE_NAME),
                data_folder: data_folder.clone(),
                index_folder_path: index_folder.clone(),
                shell: &shell,
                copier: &copier,
                now: Timestamp::now(),
                daemon_started_at: daemon_started_at.clone(),
                backup_folder,
                run_folder,
                secure_defaults: &secure_defaults,
                caller_process_reader: Arc::clone(&caller_process_reader),
                process_state: Arc::clone(&self.process_state),
                stop: &self.work_stop,
            })
            .await?,
        );
        let database_path = database.database_path.clone();
        let writer = Arc::clone(&database.writer);
        let reads = Arc::clone(&database.pool);
        let event_log = Arc::clone(&database.event_log);
        let truncation = Arc::clone(&database.truncation);
        let read_damaged_from_sequence = Arc::clone(&database.read_damaged_from_sequence);
        let followers = Arc::clone(&database.followers);
        let status = Arc::clone(&database.status);
        let damage = DispatchDamageWatch(Arc::clone(&database.damage));
        let live_runs = database.live_runs.clone();
        let attention_changes = database.attention_changes.clone();
        let idle_memory = Arc::clone(self.idle_memory.insert(Arc::new(IdleMemoryCollect::start(
            live_runs.clone(),
            self.work_stop.clone(),
        ))));
        // The power source is heard for as long as the hold moves.
        let power_source = PowerSourceWatch::start();
        let keep_awake = KeepAwakeDeps {
            hold: KeepAwakeHold::new().map_err(DaemonStartError::KeepAwake)?,
            live_runs: live_runs.clone(),
            settings: settings
                .watch()
                .await
                .map_err(DaemonStartError::KeepAwakeSettings)?,
            is_on_power: power_source.receiver(),
            stop: self.work_stop.clone(),
        };
        self.keep_awake = Some(tokio::spawn(async move {
            keep_machine_awake(keep_awake).await;
            drop(power_source);
        }));
        let machine = read_or_mint_local_machine(&reads, &writer, &self.spawner).await?;
        let machine_device_id = device_id_of(&machine.machine_id)?;
        let wall_clock: Arc<dyn WallClock> =
            Arc::new(WallClockTimer::new().map_err(DaemonStartError::WallClock)?);
        // With no wake heard, a wall-clock job still runs at its instant, only not at once after
        // a sleep that passed it.
        let wake_watch = match WakeWatch::start().await {
            Ok(wake_watch) => Some(wake_watch),
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "the computer's wakes cannot be heard, so the scheduler runs without them"
                );
                None
            }
        };
        let scheduler = Arc::clone(self.scheduler.insert(Arc::new(Scheduler::start(
            Arc::clone(&wall_clock),
            wake_watch,
            live_runs,
        ))));
        let search_index = Arc::clone(self.search_index.insert(Arc::new(LiveIndex::start(
            LiveIndexOptions {
                database_path,
                index_folder,
                program: daemon_program.to_path_buf(),
                spawner: self.spawner.clone(),
                reads: Arc::clone(&reads),
                writer: Arc::clone(&writer),
                scheduler: Arc::clone(&scheduler),
            },
        ))));
        self.check_stop("capturing the providers' base environment")?;
        let git = GitRunner::new(
            self.spawner.clone(),
            find_git_executable(&base_environment),
            Arc::clone(&base_environment),
            GitLimits::DAEMON,
        );
        self.git = Some(git.clone());
        let worktrees_folder = make_worktrees_folder(home_folder)
            .await
            .map_err(DaemonStartError::WorktreesFolder)?;
        let missed_since =
            read_managed_writes_watermark(&managed_writes_watermark_path(home_folder)).await;
        let list_feed = Arc::new(SessionListFeed::new(
            Arc::clone(&reads),
            &followers,
            Arc::clone(&scheduler),
            &StoredPlanHolds,
        ));
        self.repo = Some(build_repo_services(RepoServiceStart {
            home_folder: home_folder.to_path_buf(),
            run_folder: run_folder.folder_path.clone(),
            program_link_folder: program_link_folder(&data_folder),
            git: git.clone(),
            reads: Arc::clone(&reads),
            writer: Arc::clone(&writer),
            event_log: Arc::clone(&event_log),
            machine_id: machine.machine_id.clone(),
            scheduler: Arc::clone(&scheduler),
            list_feed: Arc::clone(&list_feed),
            stop: self.work_stop.clone(),
            worktrees_folder: worktrees_folder.clone(),
            missed_since,
        })?);
        let authorizer = Arc::new(Authorizer::load_built_in()?);
        let secret_items = SecretItems::new(SecretItemsStart {
            data_folder: data_folder.clone(),
            runs_while_logged_out,
            access: credential_store,
            call_timeout: KEYCHAIN_CALL_TIMEOUT,
        })
        .map_err(DaemonStartError::SecretItems)?;
        // Its first read runs on its own task, so the start never waits on the keychain.
        let machine_identity = Arc::clone(self.machine_identity.insert(MachineIdentity::new(
            &machine,
            &secret_items,
            Arc::clone(&reads),
            Arc::clone(&writer),
        )));
        let configuration =
            Arc::new(ConfigurationStore::open(Arc::clone(&writer), Arc::clone(&reads)).await?);
        let mut builder = MethodRegistryBuilder::new();
        let artifacts = register_artifact_methods(
            &mut builder,
            ArtifactMethodsDeps {
                event_log: Arc::clone(&event_log),
                reads: Arc::clone(&reads),
                data_folder: data_folder.clone(),
                clock: Arc::clone(&wall_clock),
            },
        )
        .await?;
        let providers = build_providers(
            provider_registrations,
            ProviderStart {
                spawner: self.spawner.clone(),
                data_folder: data_folder.clone(),
                home_folder: home_folder.to_path_buf(),
                worktrees_folder,
                session_token_path: run_folder.token_path.clone(),
                reads: Arc::clone(&reads),
                writer: Arc::clone(&writer),
                read_damaged_from_sequence,
                attachments: Arc::clone(&artifacts.attachments) as _,
                git: git.clone(),
                base_environment: Arc::clone(&base_environment),
                shell_lines: Arc::clone(&shell_lines),
                scheduler: Arc::clone(&scheduler),
                caller_processes: Arc::clone(&caller_process_reader),
                build_record_readers: Arc::new(attention_changes),
                child_records: Arc::clone(&orphan_guard) as _,
                keychain_turn: secret_items.keychain_turn(),
            },
        );
        let backups = Backups::new(BackupDeps {
            writer: Arc::clone(&writer),
            event_log,
            reads: Arc::clone(&reads),
            truncation,
            settings: Arc::clone(&settings),
            home_folder: home_folder.to_path_buf(),
            read_mirror_roots: mirror_roots_reader(
                home_folder.to_path_buf(),
                Arc::clone(&reads),
                Arc::clone(&providers.registry),
            ),
            git_folders: Arc::new(BackupGitFolders::new(
                Arc::clone(
                    &self
                        .repo
                        .as_ref()
                        .expect("the repository services are built before the backups")
                        .packing,
                ),
                git.clone(),
                Handle::current(),
            )),
            manifest_facts: backup_manifest_facts(version.clone()),
        });
        hydrate_capabilities(&providers).await;
        sweep_left_staged_worktrees(&providers).await;
        sweep_left_sign_in_folders(&providers).await;
        sweep_left_settings_files(&providers).await;
        // A channel a previous run left served processes that ended with it; a new one takes new
        // keys, so a folder left behind is only logged.
        if let Err(error) = remove_channel_folders(&data_folder).await {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "a command channel folder a previous run left was not removed"
            );
        }
        // A file of tool call arguments a previous run left belonged to a process that ended
        // with it.
        if let Err(error) = remove_left_tool_call_arguments(&data_folder).await {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "the tool call arguments a previous run left on disk were not removed"
            );
        }
        // Before the socket, any session's recovery and the capability reads, so a lasting provider
        // service is joined, or started on the same socket, before anything reaches for it.
        apply_stored_rows(&providers.registry, &settings, &self.work_stop).await;
        self.check_stop("applying the providers' stored settings")?;
        let drivers = Arc::clone(&providers.registry);
        let in_flight: Arc<OnceLock<Arc<InFlightMutations>>> = Arc::default();
        let inputs = register_method_inputs(
            &mut builder,
            MethodInputsStart {
                database: self
                    .database
                    .as_ref()
                    .expect("the database file opens before the method tables"),
                repo: self
                    .repo
                    .as_mut()
                    .expect("the repository services are built before the method tables"),
                providers: &providers,
                artifacts: &artifacts,
                machine,
                machine_device_id,
                scheduler: Arc::clone(&scheduler),
                search_index: Arc::clone(&search_index),
                clock: Arc::clone(&wall_clock),
                spawner: self.spawner.clone(),
                git,
                base_environment,
                shell_lines,
                authorizer,
                secret_items,
                machine_identity,
                settings: Arc::clone(&settings),
                configuration: Arc::clone(&configuration),
                backups: Arc::clone(&backups),
                bun: Arc::clone(&bun),
                list_feed,
                plan_holds: Arc::new(StoredPlanHolds),
                orphan_guard,
                copier,
                home_folder,
                data_folder: &data_folder,
                run_folder,
                daemon_program,
                process_identity,
                version: version.clone(),
                started_at: self.started_at,
                process_state: Arc::clone(&self.process_state),
                in_flight: Arc::clone(&in_flight),
                accept_stop,
                stop_intent: Arc::clone(&self.stop_intent),
                stop_work: stop_work_step,
                close_data_folder: close_data_folder_step,
            },
        )
        .await?;
        // Before the recovery pass and any session start, so every held request reaches it.
        let pricing = build_pricing(PricingStart {
            providers: &providers,
            reads: Arc::clone(&reads),
            writer: Arc::clone(&writer),
            scheduler: Arc::clone(&scheduler),
            clock: wall_clock,
            data_folder: &data_folder,
            daemon_started_at,
            account_notices: inputs.provider_accounts.account_notices(),
        })
        .await?;
        self.recovery = Some(inputs.recovery);
        let attention = inputs.attention;
        let web_address_sender = inputs.web_address_sender;
        self.project_list_feed = Some(inputs.project_list_feed);
        self.clones = inputs.clones;
        self.worktree_setup = Some(inputs.worktree_setup);
        // Before the recovery pass and the socket, whose runs capture.
        self.workspace_work
            .insert(inputs.workspace_work)
            .expect_moved_captures()
            .await;
        // Before the socket serves, so no creation is under way.
        settle_interrupted_creations(self.worktree_creator.insert(inputs.worktree_creator)).await;
        let mcp_inventory = inputs.mcp_inventory;
        let mcp_owed_sign_outs = inputs.mcp_owed_sign_outs;
        let mcp_mutations = Arc::clone(self.mcp_mutations.insert(inputs.mcp_mutations));
        self.mcp_sign_ins = Some(inputs.mcp_sign_ins);
        self.mcp_client = Some(inputs.mcp_client);
        let mut provider_accounts = inputs.provider_accounts;
        self.restart_settle = Some(inputs.restart_settle);
        let session = self.session.insert(inputs.session);
        let queue = Arc::clone(&session.queue);
        let caller_check = CallerCheck::new(
            Arc::clone(&caller_process_reader),
            Arc::new(Default::default),
            Arc::clone(&providers.provider_services),
        );
        let negotiator =
            ProtocolNegotiator::new(session_token.clone(), caller_check.admission_check());
        let subscriptions = Subscriptions::new(Arc::new(damage.clone()));
        negotiator.register_handshake(&mut builder)?;
        subscriptions.register_cancel(&mut builder)?;
        let registry = Arc::new(builder.freeze());
        let gates = gate_chain(&negotiator, &registry, status, damage, &idle_memory);
        assert!(
            in_flight.set(Arc::clone(&gates.in_flight)).is_ok(),
            "the gate chain is built once"
        );
        self.in_flight = Some(gates.in_flight);
        let services = GatewayServices {
            device_id: Some(inputs.machine_device_id),
            dispatch: gates.dispatch,
            registry,
            negotiator,
            subscriptions,
            presence: inputs.presence,
            hooks: Arc::new(ServingSocketHooks {
                process_state: Arc::clone(&self.process_state),
            }),
        };
        self.gateway = Some(
            bind_socket(
                || LocalGateway::start(services, caller_process_reader, &secure_defaults),
                run_folder,
                session_token,
            )
            .await?,
        );
        remove_service_status(run_folder)
            .await
            .map_err(DaemonStartError::ServiceStatus)?;
        self.check_stop("binding the socket")?;
        // A stop that ends the removal leaves the folder marked, so the next start goes on.
        if let Some(cut_short_export) = cut_short_export {
            tokio::spawn(cut_short_export.remove());
        }
        // A stop settles the wait, so the registration never waits on an index that cannot open.
        let index_opened = {
            let stop = self.work_stop.clone();
            async move {
                tokio::select! {
                    () = search_index.when_open_settled() => {}
                    () = stop.cancelled() => {}
                }
            }
        };
        let registration = self
            .providers_registration
            .insert(register_providers(&providers, index_opened));
        self.providers = Some(providers);
        let session = self
            .session
            .as_ref()
            .expect("the session services are built before their follows begin");
        // Attached before the recovery pass, whose resumes end runs on the bindings they open.
        let binding_cursors = follow_binding_cursors(session, &followers);
        // Before the recovery pass, whose resumes and the socket's first writes are the first calls
        // that can run a command, so every open window it reads is the last run's.
        match session.command_windows.settle_open_windows().await {
            Ok(settled) if settled > 0 => {
                tracing::info!(
                    settled,
                    "the command windows the last stop left open closed uncovered"
                );
            }
            Ok(_) => {}
            Err(error) => tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "the command windows the last stop left open could not be settled"
            ),
        }
        // Before the recovery pass too, so a turn its resumes end is captured.
        self.turn_capturing = Some(session.turn_capture.start(&followers));
        // Settles what the last stop left before any other follow of the log or any folder watch
        // starts.
        self.recovery
            .as_ref()
            .expect("the recovery pass is built with the start's inputs")
            .run(&self.work_stop)
            .await;
        // Right after the recovery pass, so the sweep reads what the last stop left before the
        // session services' follows begin.
        self.attention = Some(attention.start(self.work_stop.clone()).await?);
        // After the pass, so no read or window start meets a run the last stop left live.
        provider_accounts.start(&followers).await?;
        self.provider_accounts = Some(provider_accounts);
        // After the pass too, so the repricing's start pass meets no run the last stop left live.
        self.pricing = Some(pricing.start(&self.work_stop));
        // After the sweep, so a delivery the stop left pending is decided before it is sent.
        let send_settings = settings
            .watch()
            .await
            .map_err(DaemonStartError::WebAddressSettings)?;
        self.web_address_sender =
            Some(web_address_sender.start(send_settings, self.work_stop.clone()));
        self.workspace_work
            .as_mut()
            .expect("the workspace services are built before their work begins")
            .start();
        self.session_attachments =
            Some(start_session_attachments(session, &followers, binding_cursors).await?);
        let repo = self
            .repo
            .as_ref()
            .expect("the repository services are built before their work begins");
        self.repo_attachments = Some(start_repo_attachments(repo, &followers).await?);
        schedule_jobs(
            &scheduler,
            JobDeps {
                writer,
                diagnostic_expiry: Arc::new(DiagnosticExpiryDeps {
                    data_folder: data_folder.clone(),
                    live_files: live_diagnostic_files(service_log_files, Arc::clone(&drivers)),
                    configuration,
                    reads,
                    drivers,
                }),
                data_folder,
                settings,
                backups,
                bun,
                version,
                checkpoint_sweep: Arc::clone(&session.checkpoint_sweep),
            },
        )
        .await?;
        artifacts
            .start(&scheduler)
            .map_err(DaemonStartError::ArtifactReaper)?;
        // A stop leaves the registration to the stop, which ends it within the drain bound.
        tokio::select! {
            finished = registration.finished() => {
                finished.map_err(DaemonStartError::ProvidersRegistration)?;
            }
            () = self.work_stop.cancelled() => {}
        }
        self.check_stop("waiting for the providers' first reads")?;
        // After the first reads too: a settle reads each provider's config, which may start its
        // service. It runs in the background and never holds the start.
        mcp_mutations.settle_pending();
        mcp_owed_sign_outs.start_settle();
        // After the first reads, so each provider's read joins what its start runs.
        self.mcp_attribution_fills = Some(McpAttributionFills::start(
            mcp_inventory,
            Arc::clone(
                self.repo
                    .as_ref()
                    .expect("the repository services are built before their work begins")
                    .mounts
                    .attach_notice(),
            ),
            self.work_stop.clone(),
        ));
        // Once the drivers are read, the runs a stop left waiting are delivered again.
        for (session_id, error) in queue
            .recover()
            .await
            .map_err(|error| DaemonStartError::QueueRecovery(Box::new(error)))?
        {
            tracing::warn!(
                %session_id,
                error = &error as &(dyn Error + 'static),
                "a session's waiting runs could not be recovered, so they wait for its next send"
            );
        }
        self.process_state.mark_ready();
        tracing::info!(
            process_id = std::process::id(),
            protocol = CURRENT_PROTOCOL_VERSION,
            "{DAEMON_READY_LINE}"
        );
        Ok(())
    }

    // Fails with [`DaemonStartError::Stopped`] once a stop has come, naming the `step` just done.
    fn check_stop(&self, step: &'static str) -> Result<(), DaemonStartError> {
        if self.work_stop.is_cancelled() {
            return Err(DaemonStartStoppedError { step }.into());
        }
        Ok(())
    }
}
