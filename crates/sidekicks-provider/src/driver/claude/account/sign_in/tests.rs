use std::path::Path;
use std::sync::{Arc, Weak};
use std::time::Duration;

use futures::StreamExt as _;
use rstest::rstest;
use sidekicks_contracts::provider::account::record::{
    ProviderAccountHealthState, ProviderAuthMode,
};
use sidekicks_contracts::provider::account::sign_in::{
    PROVIDER_SIGN_IN_CODE_MAX_LEN, ProviderSignInArm,
};
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_platforms::NO_BROWSER_OPENER;
use sidekicks_std::file::atomic_write::write_file_atomically;

use crate::account::credential_home::CredentialHome;
use crate::driver::claude::account::{ClaudeAccountLegs, test_account_legs};
use crate::driver::contract::account::{ProviderSignInEnd, ProviderSignInLegs};
use crate::driver::diagnostics::RecordedEvents;
use crate::driver::test_registry::test_driver_services;
use crate::runtime_binding::test_store::test_provider_account_id;

mod failed_stop;

/// The address the stand-in's sign-in page sits at.
const SIGN_IN_ADDRESS: &str = "https://claude.com/cai/oauth/authorize?code=true&state=test";

/// The code the person pastes.
const PASTED_CODE: &str = "pasted-code-7f3a#state-test";

/// The browser opener the person's own environment names.
const OWN_BROWSER: &str = "/opt/own/browser";

/// The last line the stand-in writes to its error stream before it exits unfinished.
const CLAUDE_FAILURE: &str = "OAuth error: Request failed with status code 400";

/// The account Claude Code's `initialize` reply names for a claude.ai subscriber.
const SUBSCRIBER_ACCOUNT: &str =
    r#"{"email":"person@example.test","subscriptionType":"Claude Max","apiProvider":"firstParty"}"#;

/// How long a test waits on the stand-in.
const WAIT: Duration = Duration::from_secs(10);

// A stand-in for `claude auth login`: records its environment and process id, writes the
// opener and the address wrapped in a terminal link, then the prompt with no line end, takes
// a line, refuses it first where `refuses_first`, records the code it took and signs in.
fn login_stand_in(folder: &Path, address: &str, refuses_first: bool) -> String {
    let refusal = if refuses_first {
        "printf 'Invalid code. Please make sure the full code was copied.\\n' >&2\nread -r code\n"
    } else {
        ""
    };
    format!(
        "#!/bin/sh\nenv > '{folder}/environment'\necho $$ > '{folder}/pid'\n\
             printf 'Opening browser to sign in\\n'\n\
             printf \"If the browser didn't open, visit: \\033]8;;%s\\007%s\\033]8;;\\007\\n\" \
             '{address}' '{address}'\n\
             printf 'Paste code here if prompted > '\nread -r code\n{refusal}\
             printf '%s\\n' \"$code\" > '{folder}/code'\nprintf 'Login successful.\\n'\n",
        folder = folder.display(),
    )
}

// The legs over a `claude` stand-in running `script`, in an environment holding the person's
// own browser, a display, every variable that signs in ahead of a home, a refused custom host,
// and `extra`.
async fn legs_running(root: &Path, script: String, extra: &[(&str, &str)]) -> ClaudeAccountLegs {
    let programs = root.join("programs");
    tokio::fs::create_dir_all(&programs)
        .await
        .expect("the programs folder is made");
    write_file_atomically(&programs.join("claude"), script, 0o755)
        .await
        .expect("the stand-in is written");
    let mut services = test_driver_services();
    services.data_folder = root.join("data");
    services.home_folder = root.join("own-home");
    let mut base_environment = vec![
        (
            "PATH".to_owned(),
            format!("{}:/usr/bin:/bin", programs.display()),
        ),
        ("BROWSER".to_owned(), OWN_BROWSER.to_owned()),
        ("DISPLAY".to_owned(), ":0".to_owned()),
        (
            "CLAUDE_CODE_OAUTH_TOKEN".to_owned(),
            "sk-ant-oat01-own".to_owned(),
        ),
        (
            "ANTHROPIC_API_KEY".to_owned(),
            "sk-ant-api03-own".to_owned(),
        ),
        (
            "CLAUDE_CODE_OAUTH_REFRESH_TOKEN".to_owned(),
            "own-refresh".to_owned(),
        ),
        (
            "CLAUDE_CODE_CUSTOM_OAUTH_URL".to_owned(),
            "https://sign-in.example.test".to_owned(),
        ),
    ];
    base_environment.extend(
        extra
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned())),
    );
    services.base_environment = Arc::from(base_environment);
    test_account_legs(&services, Weak::new())
}

fn home(root: &Path) -> CredentialHome {
    CredentialHome::at(root.join("account"))
}

fn code() -> FreeFormText<PROVIDER_SIGN_IN_CODE_MAX_LEN> {
    FreeFormText::new(PASTED_CODE.to_owned()).expect("a code is free-form text")
}

// Killed by reading the output as lines (the prompt ends none, so no prompt arrives before the
// code), by a dropped removal list, by the no-op browser opener tied to the arm alone, by the
// browser check read from the process's own environment (the test process sets no SSH variable),
// by a provider-opened browser claimed where the no-op opener is set, and by a logged code. The
// browser case reads the fixture's display on Linux and, on macOS, the test's own security
// session, which has graphics in a desktop login, so that case fails in a run over SSH.
#[rstest]
#[case::device_code(ProviderSignInArm::DeviceCode, &[], NO_BROWSER_OPENER, false)]
#[case::browser(ProviderSignInArm::Browser, &[], OWN_BROWSER, true)]
#[case::browser_over_ssh(
    ProviderSignInArm::Browser,
    &[("SSH_CONNECTION", "192.0.2.1 50000 192.0.2.2 22")],
    NO_BROWSER_OPENER,
    false
)]
#[tokio::test]
async fn a_sign_in_shows_its_address_waits_for_a_code_and_finishes_on_it(
    #[case] arm: ProviderSignInArm,
    #[case] extra: &[(&str, &str)],
    #[case] browser: &str,
    #[case] is_browser_opened_by_provider: bool,
) {
    let root = tempfile::tempdir().expect("a scratch folder is made");
    let record = root.path().join("record");
    tokio::fs::create_dir_all(&record)
        .await
        .expect("the record folder is made");
    let legs = legs_running(
        root.path(),
        login_stand_in(&record, SIGN_IN_ADDRESS, false),
        extra,
    )
    .await;
    let recorded = RecordedEvents::default();
    let _recording = recorded.record_until_dropped();

    let mut handle = legs
        .start_sign_in(test_provider_account_id(), home(root.path()), arm)
        .await
        .expect("the sign-in starts");
    assert_eq!(handle.verification_uri.as_str(), SIGN_IN_ADDRESS);
    assert_eq!(
        handle.is_browser_opened_by_provider,
        is_browser_opened_by_provider
    );
    tokio::time::timeout(WAIT, handle.code_prompts.next())
        .await
        .expect("the prompt arrives before any code")
        .expect("the flow waits for a code");
    handle
        .input
        .write_code(code())
        .await
        .expect("the code is written");
    let end = tokio::time::timeout(WAIT, handle.completion)
        .await
        .expect("the flow ends");

    assert_eq!(end, ProviderSignInEnd::Finished);
    let taken = tokio::fs::read_to_string(record.join("code"))
        .await
        .expect("the stand-in took a code");
    assert_eq!(taken.trim_end(), PASTED_CODE);
    let environment = tokio::fs::read_to_string(record.join("environment"))
        .await
        .expect("the stand-in recorded its environment");
    assert!(
        environment
            .lines()
            .any(|line| line == format!("BROWSER={browser}")),
        "the opener is {browser}: {environment}"
    );
    for removed in [
        "CLAUDE_CODE_OAUTH_TOKEN=",
        "ANTHROPIC_API_KEY=",
        "CLAUDE_CODE_OAUTH_REFRESH_TOKEN=",
        "CLAUDE_CODE_CUSTOM_OAUTH_URL=",
    ] {
        assert!(
            !environment.lines().any(|line| line.starts_with(removed)),
            "{removed} reached the sign-in"
        );
    }
    assert!(
        recorded
            .texts()
            .iter()
            .all(|text| !text.contains(PASTED_CODE)),
        "the code reached a log line"
    );
}

// A flow that exits unfinished gives the last line with text Claude Code wrote to its error stream
// as its reason, whatever came before it and the blank line after it. Killed by the line dropped.
#[tokio::test]
async fn a_failed_sign_in_gives_claude_code_s_last_error_line() {
    let root = tempfile::tempdir().expect("a scratch folder is made");
    let script = format!(
        "#!/bin/sh\nprintf \"If the browser didn't open, visit: %s\\n\" '{SIGN_IN_ADDRESS}'\n\
         printf 'Opening browser to sign in\\n' >&2\n\
         printf '{CLAUDE_FAILURE}\\n\\n' >&2\nexit 1\n"
    );
    let legs = legs_running(root.path(), script, &[]).await;

    let handle = legs
        .start_sign_in(
            test_provider_account_id(),
            home(root.path()),
            ProviderSignInArm::DeviceCode,
        )
        .await
        .expect("the sign-in starts");
    let end = tokio::time::timeout(WAIT, handle.completion)
        .await
        .expect("the flow ends");

    assert_eq!(
        end,
        ProviderSignInEnd::Failed {
            reason: Some(FreeFormText::new(CLAUDE_FAILURE.to_owned()).expect("a reason")),
        }
    );
}

// Killed by reading prompts from the output alone (no second wait after a refused code), and
// by an address on any host taken (the start answers, and its child stays waiting).
#[tokio::test]
async fn a_refused_code_is_a_second_wait_and_an_address_on_another_host_is_refused() {
    let root = tempfile::tempdir().expect("a scratch folder is made");
    let record = root.path().join("record");
    tokio::fs::create_dir_all(&record)
        .await
        .expect("the record folder is made");
    let legs = legs_running(
        root.path(),
        login_stand_in(&record, SIGN_IN_ADDRESS, true),
        &[],
    )
    .await;
    let mut handle = legs
        .start_sign_in(
            test_provider_account_id(),
            home(root.path()),
            ProviderSignInArm::DeviceCode,
        )
        .await
        .expect("the sign-in starts");
    for wait in ["the first", "the second"] {
        tokio::time::timeout(WAIT, handle.code_prompts.next())
            .await
            .unwrap_or_else(|_elapsed| panic!("{wait} wait arrives"))
            .expect("the flow waits for a code");
        handle
            .input
            .write_code(code())
            .await
            .expect("the code is written");
    }
    let end = tokio::time::timeout(WAIT, handle.completion)
        .await
        .expect("the flow ends");
    assert_eq!(end, ProviderSignInEnd::Finished);

    let elsewhere = tempfile::tempdir().expect("a scratch folder is made");
    let record = elsewhere.path().join("record");
    tokio::fs::create_dir_all(&record)
        .await
        .expect("the record folder is made");
    let legs = legs_running(
        elsewhere.path(),
        login_stand_in(&record, "https://claude.com.example.test/oauth", false),
        &[],
    )
    .await;
    legs.start_sign_in(
        test_provider_account_id(),
        home(elsewhere.path()),
        ProviderSignInArm::DeviceCode,
    )
    .await
    .err()
    .expect("an address on another host fails the start");
    let pid = tokio::fs::read_to_string(record.join("pid"))
        .await
        .expect("the stand-in recorded its process id");
    let is_running = std::process::Command::new("kill")
        .args(["-0", pid.trim()])
        .status()
        .expect("kill runs")
        .success();
    assert!(!is_running, "the refused flow's child is gone");
}

// A stand-in for the status read's process: answers `initialize` with `account`.
fn status_stand_in(account: &str) -> String {
    format!(
        r#"#!/bin/sh
read -r line
id=$(printf '%s' "$line" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{{"type":"control_response","response":{{"subtype":"success",'\
'"request_id":"%s","response":{{"account":%s}}}}}}\n' "$id" '{account}'
cat > /dev/null
"#
    )
}

// Killed by a claude.ai sign-in read as anything but a subscription, and by an account named
// without its email.
#[rstest]
#[case::subscription_with_email(
    r#"{"tokenSource":"claude.ai","apiKeySource":"none","email":"person@example.test"}"#,
    Some(ProviderAuthMode::OauthSubscription),
    true
)]
#[case::subscription_without_email(
    r#"{"tokenSource":"claude.ai","apiKeySource":"none"}"#,
    Some(ProviderAuthMode::OauthSubscription),
    false
)]
#[case::api_key(
    r#"{"tokenSource":"none","apiKeySource":"ANTHROPIC_API_KEY"}"#,
    Some(ProviderAuthMode::ApiKey),
    false
)]
#[case::signed_out(r#"{"tokenSource":"none","apiKeySource":"none"}"#, None, false)]
#[tokio::test(flavor = "multi_thread")]
async fn the_status_read_names_the_sign_in_as_claude_code_s_own_status_does(
    #[case] account: &str,
    #[case] mode: Option<ProviderAuthMode>,
    #[case] is_named: bool,
) {
    let root = tempfile::tempdir().expect("a scratch folder is made");
    let legs = legs_running(root.path(), status_stand_in(account), &[]).await;

    let observed = legs
        .observe_sign_in(test_provider_account_id(), home(root.path()))
        .await
        .expect("the status read answers");

    assert_eq!(
        observed.observed_auth_mode,
        Some(mode.unwrap_or(ProviderAuthMode::None))
    );
    assert_eq!(observed.is_account_named, is_named);
    assert_eq!(
        observed.health.state,
        if mode.is_some() {
            ProviderAccountHealthState::Authenticated
        } else {
            ProviderAccountHealthState::ReauthRequired
        }
    );
}

// A stand-in for `claude` whose `auth login` shows its address and prompt, finishes in the browser
// a moment later with no code pasted, and whose status read then answers as Claude Code answers for
// a claude.ai subscriber: its subscription and email, and no token source.
fn browser_login_stand_in() -> String {
    format!(
        "#!/bin/sh\nif [ \"$1\" = auth ]; then\n\
         printf \"If the browser didn't open, visit: %s\\n\" '{SIGN_IN_ADDRESS}'\n\
         printf 'Paste code here if prompted > '\nsleep 1\nprintf 'Login successful.\\n'\nexit 0\n\
         fi\n{}",
        status_stand_in(SUBSCRIBER_ACCOUNT)
    )
}

// A browser sign-in that finishes keeps its account: the flow ends with Claude Code's own login,
// and the status read after it names the subscriber signed in. Killed by a subscription named in
// place of a token source read as signed out, which leaves the account unnamed.
#[tokio::test(flavor = "multi_thread")]
async fn a_finished_browser_sign_in_reads_its_subscriber_as_signed_in_and_named() {
    let root = tempfile::tempdir().expect("a scratch folder is made");
    let legs = legs_running(root.path(), browser_login_stand_in(), &[]).await;

    let handle = legs
        .start_sign_in(
            test_provider_account_id(),
            home(root.path()),
            ProviderSignInArm::Browser,
        )
        .await
        .expect("the sign-in starts");
    let end = tokio::time::timeout(WAIT, handle.completion)
        .await
        .expect("the flow ends");
    assert_eq!(end, ProviderSignInEnd::Finished);
    let observed = legs
        .observe_sign_in(test_provider_account_id(), home(root.path()))
        .await
        .expect("the status read answers");

    assert_eq!(
        observed.health.state,
        ProviderAccountHealthState::Authenticated
    );
    assert_eq!(
        observed.observed_auth_mode,
        Some(ProviderAuthMode::OauthSubscription)
    );
    assert!(observed.is_account_named, "the subscriber was left unnamed");
}

// The installed Claude Code's sign-in from another device: it reaches the prompt, and the code
// a person writes to the file `SIDEKICKS_SIGN_IN_PROBE_CODE` names, after opening the address
// written beside it, finishes it. Run by hand on a machine signed in to nothing it needs.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "a probe of the installed Claude Code that a person finishes"]
async fn the_installed_claude_code_finishes_a_sign_in_from_another_device_on_a_written_code() {
    let code_file = std::env::var_os("SIDEKICKS_SIGN_IN_PROBE_CODE")
        .expect("the probe names the file its code is written to");
    let root = tempfile::tempdir().expect("a scratch folder is made");
    let mut services = test_driver_services();
    services.data_folder = root.path().join("data");
    services.home_folder = std::env::home_dir().expect("the probe runs with a home");
    services.base_environment = Arc::from([(
        "PATH".to_owned(),
        std::env::var("PATH").expect("the probe runs with a search path"),
    )]);
    let legs = test_account_legs(&services, Weak::new());
    let mut handle = legs
        .start_sign_in(
            test_provider_account_id(),
            home(root.path()),
            ProviderSignInArm::DeviceCode,
        )
        .await
        .expect("the installed Claude Code starts its sign-in");
    let address_file = Path::new(&code_file).with_extension("address");
    tokio::fs::write(&address_file, handle.verification_uri.as_str())
        .await
        .expect("the address is written for the person");
    handle
        .code_prompts
        .next()
        .await
        .expect("the installed Claude Code waits for a code");
    let code = loop {
        if let Ok(code) = tokio::fs::read_to_string(&code_file).await {
            break code;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    };
    handle
        .input
        .write_code(FreeFormText::new(code.trim().to_owned()).expect("a code"))
        .await
        .expect("the code is written");
    assert_eq!(handle.completion.await, ProviderSignInEnd::Finished);
}
