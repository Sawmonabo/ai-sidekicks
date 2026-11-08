//! Claude Code's limits read of one account's home: `get_usage` on a process that keeps nothing,
//! run on a folder the daemon makes for the read over the account's own credential store, with
//! Claude Code's debug log written there. The reply is read in the order Claude Code answers it: a
//! refusal of the request, then whether plan limits apply, then the limits. The windows are the
//! reply's `limits[]` rows classified by their `kind`, never by a label, so an account with no
//! `session` row has no five-hour window; only a reply without rows is read by its flat keys.

use std::io;
use std::path::Path;

use futures::FutureExt;
use futures::future::BoxFuture;
use jiff::Timestamp;
use serde_json::value::RawValue;
use serde_json::{Map, Value};
use sidekicks_contracts::event::usage::compose_scoped_limit_id;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::account::read_folder::run_in_read_folder;
use crate::driver::ProviderAccountFolders;
use crate::driver::claude::account::ClaudeAccountLegs;
use crate::driver::claude::rate_limit_windows::{SESSION_WINDOW_MINUTES, WEEKLY_WINDOW_MINUTES};
use crate::driver::claude::session::errors::ClaudeSessionError;
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::control::ClaudeControlRequest;
use crate::driver::claude::spawn::environment::{ClaudeAccountFolders, ClaudeProcessHome};
use crate::driver::claude::spawn::launch::control_only::{
    ClaudeShortProcess, compose_claude_control_only_arguments,
};
use crate::driver::contract::account::{
    ObservedAccountIdentity, ProviderAccountFigures, ProviderObservation, ProviderObserveLegs,
};
use crate::driver::contract::error::DriverError;
use crate::port::usage_sink::ProviderQuotaWindow;

/// The data folder's folder of the limits reads' own folders, one per read.
const CLAUDE_LIMITS_READ_FOLDER: [&str; 2] = ["claude", "limits-read"];

/// The debug log's name in a read's folder.
const DEBUG_FILE_NAME: &str = "debug.log";

/// The debug lines that name a refused sign-in on the way to the usage read: Claude Code's
/// bootstrap fetch, then its profile fetch, each followed by the failure's text.
const BOOTSTRAP_FAILURE_LINE: &str = "[Bootstrap] Fetch failed: ";
const PROFILE_FAILURE_LINE: &str = "Failed to fetch oauth profile from OAuth token: ";

impl ProviderObserveLegs for ClaudeAccountLegs {
    fn observe(
        &self,
        provider_account_id: ProviderAccountId,
        folders: ProviderAccountFolders,
    ) -> BoxFuture<'_, Result<ProviderObservation, DriverError>> {
        observe_claude_limits(self, provider_account_id, folders).boxed()
    }

    /// Yes: each read starts a Claude Code process of its own.
    fn reads_one_at_a_time(&self) -> bool {
        true
    }

    /// Yes: a Claude Code turn's events name only the windows its answer's headers carried, so a
    /// turn's end is followed by a whole read.
    fn reads_at_turn_end(&self) -> bool {
        true
    }
}

// Reads `provider_account_id`'s limits through `get_usage`, in a folder of the read's own over
// the account's credential store, and notes the model its weekly window over one model names.
// Fails as the folder cannot be made, the build cannot be resolved, the process cannot start or
// gives no answer, or the debug log cannot be read.
async fn observe_claude_limits(
    legs: &ClaudeAccountLegs,
    provider_account_id: ProviderAccountId,
    folders: ProviderAccountFolders,
) -> Result<ProviderObservation, DriverError> {
    run_in_read_folder(
        &legs.sources.0.data_folder,
        &CLAUDE_LIMITS_READ_FOLDER,
        async |folder| {
            let folders = ClaudeAccountFolders::from(&folders);
            let executable = legs
                .sources
                .resolve_build_on(
                    ClaudeProcessHome::AccountStore {
                        folder,
                        credential_store_folder: &folders.credential_store_folder,
                    },
                    &[],
                )
                .await?;
            let debug_file = folder.join(DEBUG_FILE_NAME);
            let mut arguments = compose_claude_control_only_arguments(None);
            arguments.extend([
                "--debug-file".to_owned(),
                debug_file.to_string_lossy().into_owned(),
            ]);
            let short = ClaudeShortProcess::start(
                &legs.launcher,
                &executable,
                arguments,
                legs.launcher.control_only_folder().await?,
                Some(provider_account_id.clone()),
                None,
            )
            .await?;
            let answer = read_usage(&short).await;
            // Closed before its log is read, so every line it wrote is on disk.
            short.close().await;
            let reading = read_usage_reply(answer?.as_deref());
            Ok(match reading {
                UsageReading::Limits {
                    windows,
                    plan,
                    scoped_model,
                } => {
                    if let Some(scoped_model) = scoped_model {
                        legs.usage_probe_models
                            .note(provider_account_id.clone(), scoped_model);
                    }
                    if windows.is_empty() {
                        ProviderObservation::Unanswered
                    } else {
                        ProviderObservation::Figures(ProviderAccountFigures {
                            windows,
                            identity: ObservedAccountIdentity {
                                plan: plan.and_then(|plan| FreeFormText::new(plan).ok()),
                                ..ObservedAccountIdentity::default()
                            },
                            refreshed_at: None,
                        })
                    }
                }
                UsageReading::Fieldless => {
                    if is_sign_in_refused_in(&debug_file).await? {
                        ProviderObservation::SignInRefusedBeforeAnswer
                    } else {
                        ProviderObservation::RefusedInBand
                    }
                }
                UsageReading::SignedOut => ProviderObservation::SignInGone,
                UsageReading::Unread => ProviderObservation::Unanswered,
            })
        },
    )
    .await
}

// Initializes `short` and sends `get_usage`, answering its reply; `None` where Claude Code refused
// the request, which a build or context that does not serve it does, or answered with no reply.
async fn read_usage(
    short: &ClaudeShortProcess,
) -> Result<Option<Box<RawValue>>, ClaudeSessionError> {
    short.initialize().await?;
    match short
        .process
        .send_control_request(ClaudeControlRequest::GetUsage {
            skip_behaviors: true,
        })
        .await
    {
        Ok(answer) => Ok(answer.response),
        Err(ClaudeSessionError::ControlRequestRefused { .. }) => Ok(None),
        Err(error) => Err(error),
    }
}

/// What one `get_usage` reply said of the account's limits.
#[derive(Debug, PartialEq)]
enum UsageReading {
    /// The reply carried the account's limits: its windows, its plan as Claude Code names it, and
    /// the model its weekly window over one model is for.
    Limits {
        windows: Vec<ProviderQuotaWindow>,
        plan: Option<String>,
        scoped_model: Option<String>,
    },
    /// Plan limits apply and the reply carried none: the usage endpoint refused the read.
    Fieldless,
    /// Plan limits do not apply and no plan is named: the account's store holds no sign-in.
    SignedOut,
    /// Claude Code refused the request, or the reply is one no rule above reads.
    Unread,
}

// Reads a reply in Claude Code's order: `None` (the request refused) first, then
// `rate_limits_available`, then `rate_limits`. `reply` is untrusted provider output.
fn read_usage_reply(reply: Option<&RawValue>) -> UsageReading {
    let Some(reply) = reply else {
        return UsageReading::Unread;
    };
    let Ok(Value::Object(reply)) = serde_json::from_str::<Value>(reply.get()) else {
        return UsageReading::Unread;
    };
    let plan = reply
        .get("subscription_type")
        .and_then(Value::as_str)
        .map(str::to_owned);
    match reply.get("rate_limits_available").and_then(Value::as_bool) {
        Some(false) if plan.is_none() => UsageReading::SignedOut,
        Some(false) | None => UsageReading::Unread,
        Some(true) => match reply.get("rate_limits").and_then(Value::as_object) {
            None => UsageReading::Fieldless,
            Some(rate_limits) => UsageReading::Limits {
                windows: read_limit_windows(rate_limits),
                plan,
                scoped_model: read_scoped_model(rate_limits),
            },
        },
    }
}

// The windows of `rate_limits`: its `limits[]` rows where it carries them, an empty list meaning
// no meter; else its flat `five_hour` and `seven_day` keys, `null` or absent each no window.
fn read_limit_windows(rate_limits: &Map<String, Value>) -> Vec<ProviderQuotaWindow> {
    match rate_limits.get("limits").and_then(Value::as_array) {
        Some(rows) => rows
            .iter()
            .filter_map(|row| read_limit_row(row.as_object()?))
            .collect(),
        None => [
            ("five_hour", "session", SESSION_WINDOW_MINUTES),
            ("seven_day", "weekly_all", WEEKLY_WINDOW_MINUTES),
        ]
        .into_iter()
        .filter_map(|(key, limit_id, window_mins)| {
            let window = rate_limits.get(key)?.as_object()?;
            Some(ProviderQuotaWindow {
                limit_id: limit_id.to_owned(),
                window_mins,
                used_percent: read_percent(window.get("utilization"))?,
                resets_at: read_reset(window),
            })
        })
        .collect(),
    }
}

// One `limits[]` row by its `kind`: `session`, `weekly_all`, or `weekly_scoped` named for its
// model; any other kind, or a scoped row naming no model, is no account limit read here.
fn read_limit_row(row: &Map<String, Value>) -> Option<ProviderQuotaWindow> {
    let (limit_id, window_mins) = match row.get("kind")?.as_str()? {
        "session" => ("session".to_owned(), SESSION_WINDOW_MINUTES),
        "weekly_all" => ("weekly_all".to_owned(), WEEKLY_WINDOW_MINUTES),
        "weekly_scoped" => {
            let model = row
                .get("scope")?
                .get("model")?
                .get("display_name")?
                .as_str()
                .filter(|name| !name.is_empty())?;
            (
                compose_scoped_limit_id("weekly_scoped", model),
                WEEKLY_WINDOW_MINUTES,
            )
        }
        _ => return None,
    };
    Some(ProviderQuotaWindow {
        limit_id,
        window_mins,
        used_percent: read_percent(row.get("percent"))?,
        resets_at: read_reset(row),
    })
}

// A share used, already in percent in this reply.
fn read_percent(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|percent| percent.is_finite())
}

// The reset time an ISO 8601 `resets_at` names; `None` where it names none or none that parses.
fn read_reset(window: &Map<String, Value>) -> Option<Timestamp> {
    window
        .get("resets_at")
        .and_then(Value::as_str)
        .and_then(|reset| reset.parse().ok())
}

// The first model `model_scoped` names, which the account's weekly window over one model is for.
fn read_scoped_model(rate_limits: &Map<String, Value>) -> Option<String> {
    rate_limits
        .get("model_scoped")?
        .as_array()?
        .iter()
        .find_map(|row| {
            row.get("display_name")?
                .as_str()
                .filter(|name| !name.is_empty())
        })
        .map(str::to_owned)
}

// Whether the read's debug log names a 401 from the bootstrap or the profile fetch, a sign-in
// refused before the fieldless answer; a log never written names none. Fails as the log cannot be
// read.
async fn is_sign_in_refused_in(debug_file: &Path) -> Result<bool, DriverError> {
    let log = match tokio::fs::read(debug_file).await {
        Ok(log) => log,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(DriverError::Internal(Box::new(error))),
    };
    Ok(String::from_utf8_lossy(&log)
        .lines()
        .any(is_sign_in_refusal_line))
}

// A bootstrap failure whose text is the status 401, or a profile failure whose error names it.
fn is_sign_in_refusal_line(line: &str) -> bool {
    let after = |marker: &str| line.find(marker).map(|at| &line[at + marker.len()..]);
    after(BOOTSTRAP_FAILURE_LINE).is_some_and(|failure| failure.trim() == "401")
        || after(PROFILE_FAILURE_LINE)
            .is_some_and(|failure| failure.trim_end().ends_with("status code 401"))
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    use jiff::Timestamp;
    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_std::file::atomic_write::write_file_atomically;

    use super::{CLAUDE_LIMITS_READ_FOLDER, read_limit_windows};
    use crate::account::read_folder::compose_reads_folder;
    use crate::driver::CurrentProviderAccount;
    use crate::driver::ProviderAccountFolders;
    use crate::driver::claude::account::ClaudeAccountLegs;
    use crate::driver::claude::rate_limit_windows::read_claude_quota_windows;
    use crate::driver::claude::spawn::launch::ClaudeProcessLauncher;
    use crate::driver::contract::account::{
        ObservedAccountIdentity, ProviderAccountFigures, ProviderObservation, ProviderObserveLegs,
    };
    use crate::driver::test_registry::{registered_test_accounts, test_driver_services};
    use crate::port::usage_sink::ProviderQuotaWindow;
    use crate::runtime_binding::test_store::test_provider_account_id;

    // A stand-in for Claude Code on the read's command line: it writes `debug_lines` to the file
    // its `--debug-file` names, records its two homes, answers `initialize`, and answers
    // `get_usage` with the `response` body in `answer`, its request id filled in.
    fn stand_in(answer: &Path, debug_lines: &Path, record: &Path) -> String {
        format!(
            r#"#!/bin/sh
debug=''
while [ $# -gt 0 ]; do
  if [ "$1" = --debug-file ]; then debug=$2; fi
  shift
done
cat '{debug_lines}' > "$debug"
printf '%s|%s\n' "$CLAUDE_CONFIG_DIR" "$CLAUDE_SECURESTORAGE_CONFIG_DIR" > '{record}'
while read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
  case "$line" in
    *'"subtype":"get_usage"'*)
      printf '{{"type":"control_response","response":%s}}\n' \
        "$(sed "s/REQUEST_ID/$id/" '{answer}')" ;;
    *)
      printf '{{"type":"control_response","response":{{"subtype":"success",'\
'"request_id":"%s","response":{{}}}}}}\n' "$id" ;;
  esac
done
"#,
            answer = answer.display(),
            debug_lines = debug_lines.display(),
            record = record.display(),
        )
    }

    // What one read ran on: the legs, the account's folders, the data folder and the file the
    // stand-in records its homes in.
    struct ScriptedRead {
        _root: tempfile::TempDir,
        legs: ClaudeAccountLegs,
        folders: ProviderAccountFolders,
        data_folder: PathBuf,
        record: PathBuf,
    }

    async fn scripted_read(answer: &Value, debug_lines: &str) -> ScriptedRead {
        let root = tempfile::tempdir().expect("a scratch folder is made");
        let programs = root.path().join("programs");
        tokio::fs::create_dir_all(&programs)
            .await
            .expect("the programs folder is made");
        let answer_file = root.path().join("answer.json");
        tokio::fs::write(&answer_file, answer.to_string())
            .await
            .expect("the answer is written");
        let debug_file = root.path().join("debug-lines");
        tokio::fs::write(&debug_file, debug_lines)
            .await
            .expect("the debug lines are written");
        let record = root.path().join("homes");
        write_file_atomically(
            &programs.join("claude"),
            stand_in(&answer_file, &debug_file, &record),
            0o755,
        )
        .await
        .expect("the stand-in is written");
        let mut services = test_driver_services();
        services.data_folder = root.path().join("data");
        services.home_folder = root.path().join("home");
        services.base_environment = Arc::from([(
            "PATH".to_owned(),
            format!("{}:/usr/bin:/bin", programs.display()),
        )]);
        // The account is no token account, so its start reads no sealed token.
        let launcher = ClaudeProcessLauncher::new(
            services.spawner.clone(),
            Arc::clone(&services.child_records),
            Arc::clone(&services.processes),
            registered_test_accounts(CurrentProviderAccount::NoneRegistered),
            Arc::clone(&services.ports.raw_provider_messages),
            &services.data_folder,
        );
        ScriptedRead {
            legs: ClaudeAccountLegs::new(&services, Arc::new(launcher), Arc::default()),
            folders: ProviderAccountFolders {
                configuration_folder: root.path().join("account"),
                credential_store_folder: root.path().join("account").join("store"),
            },
            data_folder: services.data_folder.clone(),
            record,
            _root: root,
        }
    }

    impl ScriptedRead {
        async fn observe(&self) -> ProviderObservation {
            self.legs
                .observe(test_provider_account_id(), self.folders.clone())
                .await
                .expect("the read answers")
        }
    }

    fn success(body: &Value) -> Value {
        json!({"subtype": "success", "request_id": "REQUEST_ID", "response": body})
    }

    // The 2.1.316 reply measured on an account with no five-hour limit, its `rate_limits`
    // trimmed to the members a reader may take, and its flat `five_hour` given figures `limits[]`
    // does not carry.
    fn measured_reply() -> Value {
        json!({
            "session": {"total_cost_usd": 0.000_045_2, "model_usage": {}},
            "subscription_type": "max",
            "rate_limits_available": true,
            "rate_limits": {
                "five_hour": {"utilization": 12, "resets_at": "2026-11-01T23:00:00+00:00"},
                "seven_day": {"utilization": 47, "resets_at": "2026-11-06T14:00:00.078508+00:00"},
                "seven_day_opus": null,
                "seven_day_sonnet": null,
                "iguana_necktie": {"utilization": 0, "resets_at": "2026-11-05T07:59:00+00:00"},
                "limits": [
                    {"kind": "weekly_all", "group": "weekly", "percent": 47,
                     "severity": "normal", "resets_at": "2026-11-06T14:00:00.078508+00:00",
                     "scope": null, "is_active": true},
                    {"kind": "weekly_scoped", "group": "weekly", "percent": 31,
                     "severity": "normal", "resets_at": "2026-11-06T14:00:00.078702+00:00",
                     "scope": {"model": {"id": null, "display_name": "Fable"}, "surface": null},
                     "is_active": false}
                ],
                "model_scoped": [{"display_name": "Fable", "utilization": 31,
                                  "resets_at": "2026-11-06T14:00:00.078702+00:00"}]
            },
            "behaviors": null
        })
    }

    fn reset(text: &str) -> Timestamp {
        text.parse().expect("a reset time parses")
    }

    // Killed by the flat `five_hour` read while `limits[]` is present (a `session` window
    // appears), by a row classified other than by its kind, by the plan dropped, by the read run
    // on the account's own configuration home or another store, by its folder kept, and by the
    // model `model_scoped` names never noted: the event's weekly window over one model then reads
    // as no window.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_reply_s_limit_rows_are_the_account_s_windows_and_its_model_is_noted() {
        let read = scripted_read(&success(&measured_reply()), "").await;

        let observation = read.observe().await;

        assert_eq!(
            observation,
            ProviderObservation::Figures(ProviderAccountFigures {
                windows: vec![
                    ProviderQuotaWindow {
                        limit_id: "weekly_all".to_owned(),
                        window_mins: 10_080,
                        used_percent: 47.0,
                        resets_at: Some(reset("2026-11-06T14:00:00.078508Z")),
                    },
                    ProviderQuotaWindow {
                        limit_id: "weekly_scoped:Fable".to_owned(),
                        window_mins: 10_080,
                        used_percent: 31.0,
                        resets_at: Some(reset("2026-11-06T14:00:00.078702Z")),
                    },
                ],
                identity: ObservedAccountIdentity {
                    plan: Some(
                        sidekicks_contracts::wire::text::FreeFormText::new("max".to_owned())
                            .expect("the plan fits"),
                    ),
                    ..ObservedAccountIdentity::default()
                },
                refreshed_at: None,
            })
        );
        let event = json!({"rate_limit_info": {"unifiedWindows": {
            "seven_day_overage_included": {"utilization": 0.31, "resetsAt": 1_793_973_600}
        }}});
        let event_windows = read_claude_quota_windows(
            event.as_object().expect("the event is an object"),
            &read.legs.usage_probe_models,
            &test_provider_account_id(),
        );
        let event_ids: Vec<&str> = event_windows
            .iter()
            .map(|window| window.limit_id.as_str())
            .collect();
        assert_eq!(event_ids, ["weekly_scoped:Fable"]);
        let recorded = tokio::fs::read_to_string(&read.record)
            .await
            .expect("the stand-in recorded its homes");
        let (config_folder, credential_store_folder) = recorded
            .trim_end()
            .split_once('|')
            .expect("both homes are recorded");
        let reads_folder = compose_reads_folder(&read.data_folder, &CLAUDE_LIMITS_READ_FOLDER);
        assert!(
            Path::new(config_folder).starts_with(&reads_folder),
            "the read's configuration home is its own folder: {config_folder}"
        );
        assert_eq!(
            Path::new(credential_store_folder),
            read.folders.credential_store_folder
        );
        let mut left = tokio::fs::read_dir(&reads_folder)
            .await
            .expect("the reads' folder stays");
        assert!(
            left.next_entry()
                .await
                .expect("the reads' folder lists")
                .is_none(),
            "the read's own folder is removed after it"
        );
    }

    // Killed by the typed refusal read as figures or as a refused sign-in, by a login with no
    // read held on the ladder as a throttle, by a fieldless answer read as figures or as a lost
    // sign-in, and by a 401 on the way to the read missed in the debug log, or one from any other
    // fetch, or of any other status, taken for it.
    #[rstest]
    #[case::the_typed_refusal(
        json!({"subtype": "error", "request_id": "REQUEST_ID",
               "error": "get_usage is not supported in this context"}),
        "",
        ProviderObservation::Unanswered
    )]
    #[case::no_read_for_the_login(
        success(&json!({"subscription_type": null, "rate_limits_available": false,
                       "rate_limits": null})),
        "",
        ProviderObservation::SignInGone
    )]
    #[case::a_fieldless_answer(
        success(&json!({"subscription_type": "max", "rate_limits_available": true,
                       "rate_limits": null})),
        "2026-11-01T21:02:20.110Z [DEBUG] fetchUtilization: GET /api/oauth/usage (attempt 1)\n\
         2026-11-01T21:02:20.200Z [DEBUG] [Bootstrap] Fetch failed: 403\n\
         2026-11-01T21:02:20.300Z [DEBUG] fetchUtilization: 401 during another read\n",
        ProviderObservation::RefusedInBand
    )]
    #[case::a_bootstrap_401_before_it(
        success(&json!({"subscription_type": "max", "rate_limits_available": true,
                       "rate_limits": null})),
        "2026-11-01T21:02:20.110Z [DEBUG] [Bootstrap] Fetching\n\
         2026-11-01T21:02:20.200Z [DEBUG] [Bootstrap] Fetch failed: 401\n",
        ProviderObservation::SignInRefusedBeforeAnswer
    )]
    #[case::a_profile_401_before_it(
        success(&json!({"subscription_type": "max", "rate_limits_available": true,
                       "rate_limits": null})),
        "2026-11-01T21:02:20.200Z [ERROR] Failed to fetch oauth profile from OAuth token: \
         AxiosError: Request failed with status code 401\n",
        ProviderObservation::SignInRefusedBeforeAnswer
    )]
    #[tokio::test(flavor = "multi_thread")]
    async fn each_get_usage_answer_reads_as_what_it_says_of_the_account(
        #[case] answer: Value,
        #[case] debug_lines: &str,
        #[case] expected: ProviderObservation,
    ) {
        let read = scripted_read(&answer, debug_lines).await;

        assert_eq!(read.observe().await, expected);
    }

    // Killed by the flat keys read beside `limits[]`, by a `null` flat window read as one, by the
    // idle window's zero row dropped, and by a row classified by its label.
    #[rstest]
    #[case::flat_keys_with_no_rows(
        json!({"five_hour": null, "seven_day": {"utilization": 47, "resets_at": null}}),
        vec![("weekly_all", 47.0)]
    )]
    #[case::flat_keys_without_five_hour(
        json!({"seven_day": {"utilization": 47}}),
        vec![("weekly_all", 47.0)]
    )]
    #[case::no_meters_beside_flat_keys(
        json!({"five_hour": {"utilization": 12}, "limits": []}),
        vec![]
    )]
    #[case::the_idle_session_window(
        json!({"limits": [
            {"kind": "session", "group": "session", "percent": 0, "resets_at": null},
            {"kind": "weekly_all", "group": "weekly", "percent": 5, "resets_at": null,
             "label": "Current session"}
        ]}),
        vec![("session", 0.0), ("weekly_all", 5.0)]
    )]
    fn the_windows_are_the_rows_and_else_the_flat_keys(
        #[case] rate_limits: Value,
        #[case] expected: Vec<(&str, f64)>,
    ) {
        let windows =
            read_limit_windows(rate_limits.as_object().expect("the limits are an object"));

        let read: Vec<(&str, f64)> = windows
            .iter()
            .map(|window| (window.limit_id.as_str(), window.used_percent))
            .collect();
        assert_eq!(read, expected);
    }
}
