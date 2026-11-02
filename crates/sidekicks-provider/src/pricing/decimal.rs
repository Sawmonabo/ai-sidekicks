//! An exact non-negative decimal read from a JSON number's own text, so a price keeps every digit
//! the list wrote, where a float would round it.

use std::cmp::Ordering;

/// A non-negative decimal, `significand × 10^-scale`, kept normalized: no trailing zero while the
/// scale is above 0, so one value has one form and equality is by value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ExactDecimal {
    significand: u128,
    scale: u8,
}

impl ExactDecimal {
    /// The largest scale a decimal holds: 38 fractional digits.
    pub const MAX_SCALE: u8 = 38;

    /// Reads the raw text of one JSON number (digits, an optional fraction, an optional exponent)
    /// exactly, never through a float; `None` for a negative number, for text that is not a
    /// number, and for a value past `u128` or the largest scale once normalized.
    pub fn parse_json_number(text: &str) -> Option<Self> {
        let (mantissa, exponent) = match text.find(['e', 'E']) {
            Some(at) => (&text[..at], parse_exponent(&text[at + 1..])?),
            None => (text, 0),
        };
        let (integer_digits, fraction) = match mantissa.split_once('.') {
            Some((integer_digits, fraction_digits)) => (integer_digits, Some(fraction_digits)),
            None => (mantissa, None),
        };
        if !is_digits(integer_digits) {
            return None;
        }
        let fraction_digits = match fraction {
            None => "",
            Some(fraction_digits) if is_digits(fraction_digits) => fraction_digits,
            Some(_) => return None,
        };
        // Trailing zeros move into the power before the digits are summed, so a long run of them
        // neither overflows the significand nor leaves the value unnormalized.
        let digits = integer_digits.bytes().chain(fraction_digits.bytes());
        let trailing_zeros = digits
            .clone()
            .rev()
            .take_while(|digit| *digit == b'0')
            .count();
        let kept_digits = integer_digits.len() + fraction_digits.len() - trailing_zeros;
        let mut significand: u128 = 0;
        for digit in digits.take(kept_digits) {
            significand = significand
                .checked_mul(10)?
                .checked_add(u128::from(digit - b'0'))?;
        }
        if significand == 0 {
            return Some(Self {
                significand: 0,
                scale: 0,
            });
        }
        // The value is the kept digits times ten to this power.
        let power = exponent
            .checked_add(i64::try_from(trailing_zeros).ok()?)?
            .checked_sub(i64::try_from(fraction_digits.len()).ok()?)?;
        if power >= 0 {
            let factor = 10_u128.checked_pow(u32::try_from(power).ok()?)?;
            Some(Self {
                significand: significand.checked_mul(factor)?,
                scale: 0,
            })
        } else {
            let scale = u8::try_from(power.unsigned_abs())
                .ok()
                .filter(|scale| *scale <= Self::MAX_SCALE)?;
            Some(Self { significand, scale })
        }
    }

    /// The decimal's digits as a whole number, the value being this times `10^-scale`.
    pub fn significand(&self) -> u128 {
        self.significand
    }

    /// How many of the significand's digits sit after the decimal point, at most
    /// [`Self::MAX_SCALE`].
    pub fn scale(&self) -> u8 {
        self.scale
    }
}

impl Ord for ExactDecimal {
    fn cmp(&self, other: &Self) -> Ordering {
        match self.scale.cmp(&other.scale) {
            Ordering::Equal => self.significand.cmp(&other.significand),
            Ordering::Less => compare_aligned(
                self.significand,
                other.scale - self.scale,
                other.significand,
            ),
            Ordering::Greater => compare_aligned(
                other.significand,
                self.scale - other.scale,
                self.significand,
            )
            .reverse(),
        }
    }
}

impl PartialOrd for ExactDecimal {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

// Compares a coarser significand, scaled up by the gap between the two scales, with a finer one.
// A gap is at most 38, so its power of ten fits; a scaled side past `u128` is the larger, since the
// finer significand is within it.
fn compare_aligned(coarse: u128, scale_gap: u8, fine: u128) -> Ordering {
    10_u128
        .checked_pow(u32::from(scale_gap))
        .and_then(|factor| coarse.checked_mul(factor))
        .map_or(Ordering::Greater, |aligned| aligned.cmp(&fine))
}

// A JSON exponent's text after its `e`: an optional sign and at least one digit.
fn parse_exponent(text: &str) -> Option<i64> {
    let (is_negative, digits) = match text.strip_prefix('-') {
        Some(digits) => (true, digits),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    if !is_digits(digits) {
        return None;
    }
    let magnitude: i64 = digits.parse().ok()?;
    Some(if is_negative { -magnitude } else { magnitude })
}

fn is_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
}
