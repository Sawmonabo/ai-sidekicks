//! The random spread on a wait between tries, which keeps two waiters from trying at once: one
//! uniform draw and its scale to a fraction.

/// A uniform random 64-bit draw for a wait's spread. A draw the system cannot make is logged and
/// answers the middle, so the wait still runs, unspread.
pub fn draw_jitter_sample() -> u64 {
    match getrandom::u64() {
        Ok(sample) => sample,
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "a wait's random spread could not be drawn; it waits the middle"
            );
            u64::MAX / 2
        }
    }
}

/// The top 53 bits of `sample` as a uniform fraction in [0, 1]: 0 for `u64::MIN`, 1 for
/// `u64::MAX`.
#[expect(
    clippy::cast_precision_loss,
    reason = "a 53-bit integer is exact as a 64-bit float"
)]
pub fn scale_to_unit(sample: u64) -> f64 {
    (sample >> 11) as f64 / ((1_u64 << 53) - 1) as f64
}
