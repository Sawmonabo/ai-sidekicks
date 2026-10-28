//! The wait before each redial of a service whose connection dropped while it still runs: from 1
//! second, each wait 1.6 times the last, a fifth either way, never past 120 seconds, and never
//! giving up. The base stops growing at 100 seconds, so the jittered wait at the cap stays within
//! 80 to 120 seconds and keeps its fifth either way.

use std::time::Duration;

/// How long a connection stays up before its next drop counts from the first wait again; a drop
/// sooner keeps the grown wait, so a service that takes a connection and drops it at once is not
/// dialed every second.
pub(crate) const RECONNECT_STABLE_UPTIME: Duration = Duration::from_secs(120);

/// The first wait, before the jitter.
const FIRST_WAIT_SECONDS: f64 = 1.0;

/// How much each wait grows over the last.
const WAIT_GROWTH: f64 = 1.6;

/// The base past which the waits stop growing, so the jittered wait never passes 120 seconds.
const LONGEST_BASE_SECONDS: f64 = 100.0;

/// How far the jitter moves a wait either way, as a share of it.
const JITTER_SHARE: f64 = 0.2;

/// The wait before redial `attempt` (0 for the first), jittered by `sample`, a uniform random
/// 64-bit draw: `min(1.6^attempt, 100) × U(0.8, 1.2)` seconds.
pub(crate) fn reconnect_wait(attempt: u32, sample: u64) -> Duration {
    let exponent = i32::try_from(attempt).unwrap_or(i32::MAX);
    let base = (FIRST_WAIT_SECONDS * WAIT_GROWTH.powi(exponent)).min(LONGEST_BASE_SECONDS);
    // The sample's top 53 bits as a uniform fraction in [0, 1].
    #[expect(
        clippy::cast_precision_loss,
        reason = "a 53-bit integer is exact as a 64-bit float"
    )]
    let fraction = (sample >> 11) as f64 / ((1_u64 << 53) - 1) as f64;
    let jitter = 1.0 - JITTER_SHARE + 2.0 * JITTER_SHARE * fraction;
    Duration::from_secs_f64(base * jitter)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use rstest::rstest;

    use super::reconnect_wait;

    // Kills: the factor changed from 1.6, the cap moved past the jitter (144 s at the top), the
    // jitter made one-sided, or a limit on attempts.
    #[rstest]
    #[case::first_wait_low(0, u64::MIN, 0.8)]
    #[case::first_wait_high(0, u64::MAX, 1.2)]
    #[case::second_wait_grows_by_1_6(1, u64::MAX, 1.92)]
    #[case::fifth_wait(4, u64::MIN, 0.8 * 6.5536)]
    #[case::capped_low(30, u64::MIN, 80.0)]
    #[case::capped_high(30, u64::MAX, 120.0)]
    #[case::never_gives_up(u32::MAX, u64::MAX, 120.0)]
    fn reconnect_waits_grow_by_1_6_within_a_fifth_and_never_pass_120_s(
        #[case] attempt: u32,
        #[case] sample: u64,
        #[case] seconds: f64,
    ) {
        let wait = reconnect_wait(attempt, sample);
        let expected = Duration::from_secs_f64(seconds);
        let difference = wait.abs_diff(expected);
        assert!(
            difference < Duration::from_millis(1),
            "attempt {attempt} waits {wait:?}, not {expected:?}"
        );
        assert!(wait <= Duration::from_secs(120));
    }
}
