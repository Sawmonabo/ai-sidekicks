//! The context window's arithmetic both drivers' readings share: a count as a share of the window,
//! and the headroom the bottom compaction stop keeps.

/// The share of the window the bottom stop keeps above the session's fixed start.
pub(crate) const BOTTOM_STOP_HEADROOM_PERCENT: f64 = 10.0;

/// `part` as a percent of `whole`, at most 100.
#[expect(
    clippy::cast_precision_loss,
    reason = "token counts stay far below 2^52, which an f64 holds exactly"
)]
pub(crate) fn share_percent(part: u64, whole: u64) -> f64 {
    (part as f64 * 100.0 / whole as f64).min(100.0)
}
