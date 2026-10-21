//! The retention an account home the app manages keeps: `cleanupPeriodDays` in its own
//! `settings.json`, because Claude Code's cleanup judges every file in the home by its age,
//! whatever process wrote it. The person's own Claude Code home is never written.

use std::path::Path;

use serde_json::Value;

use crate::provider::driver::claude::session::settings_file::{
    ClaudeSettingsFileError, hold_settings_file, read_settings_file, set_settings_value,
    write_settings_file,
};
use crate::provider::driver::claude::spawn::settings::CLAUDE_CLEANUP_PERIOD_DAYS;

// The home's own settings file, in its config folder.
const CLAUDE_HOME_SETTINGS_FILE: &str = "settings.json";

// The setting that holds how many days Claude Code keeps a conversation file.
const CLAUDE_CLEANUP_PERIOD_SETTING: &str = "cleanupPeriodDays";

// The home's settings file is readable by the person alone.
const CLAUDE_HOME_SETTINGS_MODE: u32 = 0o600;

/// Sets `cleanupPeriodDays` in the `settings.json` of the account home at `config_folder` to
/// [`CLAUDE_CLEANUP_PERIOD_DAYS`], every other byte kept, and writes nothing when it already holds
/// it. Fails as the file cannot be read or written, or is refused as not a strict JSON object.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "each spawn on a home the app manages sets its retention through it"
    )
)]
pub(crate) async fn write_claude_home_retention(
    config_folder: &Path,
) -> Result<(), ClaudeSettingsFileError> {
    let file = config_folder.join(CLAUDE_HOME_SETTINGS_FILE);
    let hold = hold_settings_file(&file).await?;
    let text = read_settings_file(&hold, &file).await?;
    let retention = Value::from(CLAUDE_CLEANUP_PERIOD_DAYS);
    if let Some(edited) = set_settings_value(
        &file,
        text.as_deref(),
        CLAUDE_CLEANUP_PERIOD_SETTING,
        &retention,
    )? {
        write_settings_file(&hold, &file, edited, CLAUDE_HOME_SETTINGS_MODE).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs::{self, File};
    use std::time::{Duration, SystemTime};

    use super::write_claude_home_retention;

    // Killed by a `serde_json` round trip, which rewrites the person's spacing and key order, by a
    // retention left unset, and by a rewrite of a file that already holds it.
    #[tokio::test]
    async fn the_retention_is_set_in_place_and_an_equal_value_writes_nothing() {
        let home = tempfile::tempdir().expect("a config folder");
        let file = home.path().join("settings.json");
        let held = concat!(
            "{\n\t\"model\":\"opus\" ,\n",
            "\t\"cleanupPeriodDays\": 30,\n",
            "\t\"env\": {\"A\":  \"1\"}\n}\n",
        );
        fs::write(&file, held).expect("the settings are written");

        write_claude_home_retention(home.path())
            .await
            .expect("the retention is set");

        assert_eq!(
            fs::read_to_string(&file).expect("the settings read"),
            held.replace("\": 30,", "\": 36500,")
        );

        let modified = || {
            fs::metadata(&file)
                .and_then(|metadata| metadata.modified())
                .expect("the file's time reads")
        };
        File::options()
            .write(true)
            .open(&file)
            .and_then(|opened| opened.set_modified(SystemTime::now() - Duration::from_secs(3_600)))
            .expect("the file's time is set back");
        let set_back = modified();

        write_claude_home_retention(home.path())
            .await
            .expect("the retention is checked");

        assert_eq!(modified(), set_back);
    }
}
