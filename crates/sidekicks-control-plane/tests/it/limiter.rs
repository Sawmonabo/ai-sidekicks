//! The sliding window over a real account file: the shared scenario table, and the cleanup that
//! leaves nothing counted once every window has passed.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use jiff::Timestamp;
use rstest::rstest;
use serde::Deserialize;
use sidekicks_control_plane::rate_limit::enforcement_pipeline::{
    AccountFileAdmission, AdmissionCheck,
};
use sidekicks_control_plane::rate_limit::limiter::{
    RateLimitCheckRequest, RateLimitEndpointGroup, check,
};

use crate::helpers::account_file;

/// Any instant works as a scenario's start; this one is fixed so a failure reads the same twice.
const START_MS: i64 = 1_900_000_000_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scenarios {
    scenarios: Vec<Scenario>,
}

#[derive(Deserialize)]
struct Scenario {
    name: String,
    endpoint: RateLimitEndpointGroup,
    steps: Vec<Step>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    at_ms: i64,
    identity: String,
    times: u32,
    allowed: bool,
    remaining: u32,
    reset_at_ms: i64,
}

#[rstest]
#[case("counts down then refuses")]
#[case("frees at exactly the reported reset")]
#[case("a refusal never extends the window")]
#[case("addresses are counted apart")]
fn the_window_answers_each_scenario(#[case] name: &str) {
    let table: Scenarios =
        serde_json::from_str(include_str!("../fixtures/rate_limiter_scenarios.json")).unwrap();
    let scenario = table
        .scenarios
        .into_iter()
        .find(|scenario| scenario.name == name)
        .unwrap();
    let account = account_file();
    let connection = account.connection.lock().unwrap();
    for step in scenario.steps {
        let now = Timestamp::from_millisecond(START_MS + step.at_ms).unwrap();
        let request = RateLimitCheckRequest {
            identity: step.identity.clone(),
            endpoint: scenario.endpoint,
        };
        let mut last = None;
        for _ in 0..step.times {
            let answer = check(&*connection, &request, now).unwrap();
            assert_eq!(answer.allowed, step.allowed, "{name}: at {} ms", step.at_ms);
            last = Some(answer);
        }
        let last = last.unwrap();
        assert_eq!(
            (last.remaining, last.reset_at.unix_millisecond().unwrap()),
            (step.remaining, START_MS + step.reset_at_ms),
            "{name}: at {} ms",
            step.at_ms
        );
    }
}

static CLOCK_MS: AtomicI64 = AtomicI64::new(START_MS);

fn test_clock() -> Result<Timestamp, jiff::Error> {
    Timestamp::from_millisecond(CLOCK_MS.load(Ordering::SeqCst))
}

#[tokio::test(start_paused = true)]
async fn nothing_counted_outlives_its_window() {
    let account = account_file();
    let admission = AccountFileAdmission::new(Arc::clone(&account.connection), test_clock);
    for identity in ["198.51.100.7", "203.0.113.9"] {
        let request = RateLimitCheckRequest {
            identity: identity.to_owned(),
            endpoint: RateLimitEndpointGroup::AuthEndpoint,
        };
        assert!(
            admission
                .check_admission(request, None)
                .await
                .unwrap()
                .allowed
        );
    }
    assert_eq!(account.counted_requests(), 2);

    CLOCK_MS.store(START_MS + 60_000, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_secs(61)).await;

    assert_eq!(account.counted_requests(), 0, "every window has passed");
    // The test and the admission hold the file; a cleanup task still waiting would hold a third.
    assert_eq!(
        Arc::strong_count(&account.connection),
        2,
        "no cleanup task is left"
    );
}
