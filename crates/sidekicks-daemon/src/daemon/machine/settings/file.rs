//! The machine's settings file, read and written by the daemon, its only writer. Every read goes to
//! disk, so the daemon holds no copy that could drift from the file. A missing file reads as the
//! defaults and is written with them, with nothing for the page to say. A broken file, one that is
//! not JSON or that the schema refuses, reads as the defaults and is rewritten with them, and the
//! repair is carried on every reading until the next change is written, so the page can say both
//! happened. Reads, writes and repairs run one at a time, so a change never interleaves with
//! another and a new listener's first reading is never older than a change announced after it.

use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError, Weak};

use sidekicks_contracts::machine::settings::{
    BranchNamePattern, MachineSettings, MachineSettingsChange, MachineSettingsReading,
    ProjectBranchPatternRefusedDetails, SettingsFileRepair, SettingsFileRepairCause,
    parse_machine_settings_file,
};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_platforms::create_private_folder;
use tokio::sync::watch;

use crate::file::atomic_write::{AtomicWriteError, write_file_atomically};
use crate::ipc::stream::latest_value::{LatestValueOutlet, LatestValueOutlets};

/// The settings file's name in the daemon's data folder.
pub(crate) const MACHINE_SETTINGS_FILE_NAME: &str = "machine-settings.json";

// Readable and writable by the person alone: an environment row's value can carry a proxy's
// credentials.
const SETTINGS_FILE_MODE: u32 = 0o600;

/// Why the settings file could not be read or written.
#[derive(Debug, thiserror::Error)]
pub(crate) enum MachineSettingsFileError {
    /// The file could not be read.
    #[error("the machine settings file could not be read")]
    Read(#[source] io::Error),
    /// The file's folder could not be made private.
    #[error("the machine settings file's folder could not be made")]
    Folder(#[source] io::Error),
    /// The file could not be written.
    #[error(transparent)]
    Write(#[from] AtomicWriteError),
    /// The change's branch-name pattern does not hold its title placeholder exactly once.
    #[error("the machine settings change's branch-name pattern is refused: {0:?}")]
    BranchNamePattern(ProjectBranchPatternRefusedDetails),
}

/// The settings file with its read, write and repair rules.
pub(crate) struct MachineSettingsFile {
    file_path: PathBuf,
    /// The repair made since the last change; the lock runs every operation one at a time.
    repair: tokio::sync::Mutex<Option<SettingsFileRepair>>,
    /// Every listener's outlet and in-process reader's channel.
    listeners: Mutex<Listeners>,
}

#[derive(Default)]
struct Listeners {
    outlets: LatestValueOutlets<MachineSettingsReading>,
    /// Every in-process reader's channel, dropped once its last receiver goes.
    watchers: Vec<watch::Sender<MachineSettings>>,
}

impl MachineSettingsFile {
    /// The settings file at `file_path`, `<home>/.ai-sidekicks/machine-settings.json` in the
    /// daemon.
    pub(crate) fn new(file_path: PathBuf) -> Self {
        Self {
            file_path,
            repair: tokio::sync::Mutex::new(None),
            listeners: Mutex::default(),
        }
    }

    /// The file as it stands, with the repair made since the last change, if any. Fails with
    /// [`MachineSettingsFileError`] when the file cannot be read or rewritten.
    pub(crate) async fn read(&self) -> Result<MachineSettingsReading, MachineSettingsFileError> {
        let mut repair = self.repair.lock().await;
        self.read_from_disk(&mut repair).await
    }

    /// Writes `change` over the file as it stands, clears the repair and tells every listener.
    /// Fails with [`MachineSettingsFileError::BranchNamePattern`] for a refused pattern, and as
    /// [`Self::read`] does.
    pub(crate) async fn update(
        &self,
        change: MachineSettingsChange,
    ) -> Result<MachineSettings, MachineSettingsFileError> {
        let mut repair = self.repair.lock().await;
        let current = self.read_from_disk(&mut repair).await?;
        let settings = apply_change(current.settings, change)?;
        self.write(&settings).await?;
        *repair = None;
        self.announce(&MachineSettingsReading {
            settings: settings.clone(),
            repair: None,
        });
        Ok(settings)
    }

    /// Sends the file as it stands through `outlet`, then every later reading, until the answered
    /// detach runs. Fails as [`Self::read`] does, with nothing followed.
    pub(crate) async fn follow(
        self: &Arc<Self>,
        outlet: LatestValueOutlet<MachineSettingsReading>,
    ) -> Result<impl FnOnce() + Send + use<>, MachineSettingsFileError> {
        let mut repair = self.repair.lock().await;
        outlet.send(self.read_from_disk(&mut repair).await?);
        let id = self.lock_listeners().outlets.attach(outlet);
        let file: Weak<Self> = Arc::downgrade(self);
        Ok(move || {
            if let Some(file) = file.upgrade() {
                file.lock_listeners().outlets.detach(id);
            }
        })
    }

    /// A receiver holding the settings as they stand and each later change, which any number of
    /// the service's own readers clone: keep-awake follows its switches from it, and each spawn
    /// reads its `Every project` rows from it. Fails as [`Self::read`] does.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's start hands the settings to keep-awake and to each spawn"
        )
    )]
    pub(crate) async fn watch(
        &self,
    ) -> Result<watch::Receiver<MachineSettings>, MachineSettingsFileError> {
        let mut repair = self.repair.lock().await;
        let reading = self.read_from_disk(&mut repair).await?;
        let (watcher, settings) = watch::channel(reading.settings);
        self.lock_listeners().watchers.push(watcher);
        Ok(settings)
    }

    async fn read_from_disk(
        &self,
        repair: &mut Option<SettingsFileRepair>,
    ) -> Result<MachineSettingsReading, MachineSettingsFileError> {
        let file_text = match tokio::fs::read(&self.file_path).await {
            Ok(file_text) => file_text,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let settings = MachineSettings::default();
                self.write(&settings).await?;
                return Ok(reading_of(settings, repair.as_ref()));
            }
            Err(error) => return Err(MachineSettingsFileError::Read(error)),
        };
        let cause = match serde_json::from_slice(&file_text) {
            Err(_) => SettingsFileRepairCause::Unparsable,
            Ok(file_json) => match parse_machine_settings_file(file_json) {
                Ok(settings) => return Ok(reading_of(settings, repair.as_ref())),
                Err(_) => SettingsFileRepairCause::SchemaRefused,
            },
        };
        let settings = MachineSettings::default();
        self.write(&settings).await?;
        *repair = Some(SettingsFileRepair {
            repaired_at: WireInstant::now(),
            cause,
        });
        let reading = reading_of(settings, repair.as_ref());
        self.announce(&reading);
        Ok(reading)
    }

    // A reader sees the old file or the new one, never half of either.
    async fn write(&self, settings: &MachineSettings) -> Result<(), MachineSettingsFileError> {
        if let Some(folder) = self.file_path.parent() {
            create_private_folder(folder).map_err(MachineSettingsFileError::Folder)?;
        }
        let mut contents =
            serde_json::to_vec_pretty(settings).expect("the settings serialize as JSON");
        contents.push(b'\n');
        write_file_atomically(&self.file_path, contents, SETTINGS_FILE_MODE).await?;
        Ok(())
    }

    fn announce(&self, reading: &MachineSettingsReading) {
        let mut listeners = self.lock_listeners();
        listeners.outlets.send(reading);
        listeners
            .watchers
            .retain(|watcher| watcher.send(reading.settings.clone()).is_ok());
    }

    fn lock_listeners(&self) -> std::sync::MutexGuard<'_, Listeners> {
        // A panic while the list was held leaves a list still whole.
        self.listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

fn reading_of(
    settings: MachineSettings,
    repair: Option<&SettingsFileRepair>,
) -> MachineSettingsReading {
    MachineSettingsReading {
        settings,
        repair: repair.cloned(),
    }
}

// The settings with the change's one member replaced by its whole value.
fn apply_change(
    mut settings: MachineSettings,
    change: MachineSettingsChange,
) -> Result<MachineSettings, MachineSettingsFileError> {
    match change {
        MachineSettingsChange::UpdatesAutomatic(value) => settings.updates_automatic = value,
        MachineSettingsChange::KeepCrashReports(value) => settings.keep_crash_reports = value,
        MachineSettingsChange::EditorId(value) => settings.editor_id = value,
        MachineSettingsChange::CommitTextModel(value) => settings.commit_text_model = value,
        MachineSettingsChange::DefaultCheckout(value) => settings.default_checkout = value,
        MachineSettingsChange::NewSessionCarriesLastModel(value) => {
            settings.new_session_carries_last_model = value;
        }
        MachineSettingsChange::LastLeadModel(value) => settings.last_lead_model = value,
        MachineSettingsChange::KeepAwakeWhileAgentWorks(value) => {
            settings.keep_awake_while_agent_works = value;
        }
        MachineSettingsChange::KeepAwakeForOtherDevices(value) => {
            settings.keep_awake_for_other_devices = value;
        }
        MachineSettingsChange::Notifications(value) => settings.notifications = value,
        MachineSettingsChange::RememberSiteData(value) => settings.remember_site_data = value,
        MachineSettingsChange::BrowserToolsForAgents(value) => {
            settings.browser_tools_for_agents = value;
        }
        MachineSettingsChange::SandboxBackgroundBrowser(value) => {
            settings.sandbox_background_browser = value;
        }
        MachineSettingsChange::ScreenReaderMode(value) => settings.screen_reader_mode = value,
        MachineSettingsChange::EnvironmentRows(value) => settings.environment_rows = value,
        MachineSettingsChange::Backup(value) => settings.backup = value,
        MachineSettingsChange::BranchNamePattern(value) => {
            settings.branch_name_pattern = BranchNamePattern::new(value)
                .map_err(MachineSettingsFileError::BranchNamePattern)?;
        }
        MachineSettingsChange::CloneFolder(value) => settings.clone_folder = value,
        MachineSettingsChange::Voice(value) => settings.voice = value,
    }
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sidekicks_contracts::machine::settings::{
        MachineSettings, MachineSettingsChange, SettingsFileRepairCause,
    };

    use super::{MACHINE_SETTINGS_FILE_NAME, MachineSettingsFile};

    // A broken file reads as the defaults with its repair until a change is written, and a
    // reader of the watch holds the settings and hears the change. Killed by a watch the
    // change's announce does not reach.
    #[tokio::test]
    async fn an_unparsable_file_is_repaired_and_the_repair_carried_until_the_next_write() {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let file_path = folder.path().join(MACHINE_SETTINGS_FILE_NAME);
        std::fs::write(&file_path, "{ not json").expect("the broken file is written");
        let file = Arc::new(MachineSettingsFile::new(file_path.clone()));

        let first = file.read().await.expect("the broken file reads");
        assert_eq!(first.settings, MachineSettings::default());
        let repair = first.repair.expect("the reading carries the repair");
        assert_eq!(repair.cause, SettingsFileRepairCause::Unparsable);
        let rewritten = std::fs::read(&file_path).expect("the repaired file reads");
        assert!(serde_json::from_slice::<serde_json::Value>(&rewritten).is_ok());

        let second = file.read().await.expect("the repaired file reads");
        assert_eq!(second.repair, Some(repair));
        let mut watched = file.watch().await.expect("the repaired file reads");
        assert!(watched.borrow_and_update().updates_automatic);

        let settings = file
            .update(MachineSettingsChange::UpdatesAutomatic(false))
            .await
            .expect("the change is written");
        assert!(!settings.updates_automatic);
        assert!(
            watched
                .has_changed()
                .expect("the file keeps the watch's sender")
        );
        assert!(!watched.borrow_and_update().updates_automatic);
        let third = file.read().await.expect("the changed file reads");
        assert_eq!(third.repair, None);
        assert!(!third.settings.updates_automatic);
    }
}
