//! How many bytes a value takes on the wire, which the message cap and the page budget both
//! measure: the UTF-8 byte length of what `JSON.stringify` writes for it, since the desktop's
//! validators measure the same caps that way, plus the bytes of the attachments its byte members
//! carry. The JSON's bytes are counted while serializing, so no text is allocated. `serde_json`
//! writes strings as `JSON.stringify` does and member order does not change a length, but its
//! numbers differ (`1.0` where JavaScript writes `1`, `1e+20` where it writes
//! `100000000000000000000`, an integer past 2^53 in full), so a formatter writes every number in
//! ECMAScript's `Number::toString` form, a number `serde_json` kept as its text (its
//! `arbitrary_precision` feature, which a dependency of the daemon turns on for every build that
//! links it) included, as the double `JSON.parse` reads from that text. The one check that holds a
//! value to a byte cap lives here too.

use std::io;

use serde::Serialize;
use serde_json::ser::Formatter;

use crate::wire::attachment::collect_attachments;

/// The UTF-8 byte length of `value` written as JSON, with the bytes of every attachment its byte
/// members carry beside it, since those travel in the same frame. Fails where the value's own
/// `Serialize` fails or the value holds a raw JSON fragment.
pub fn json_utf8_byte_length<T: Serialize>(value: &T) -> serde_json::Result<usize> {
    let (json_bytes, attachments) = collect_attachments(|| {
        let mut serializer =
            serde_json::Serializer::with_formatter(ByteCount::default(), EcmaScriptNumbers);
        value
            .serialize(&mut serializer)
            .map(|()| serializer.into_inner().bytes)
    });
    Ok(json_bytes? + attachments.iter().map(bytes::Bytes::len).sum::<usize>())
}

/// A sink that keeps only how many bytes were written to it.
#[derive(Default)]
struct ByteCount {
    /// The bytes written so far.
    bytes: usize,
}

impl io::Write for ByteCount {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.bytes += buffer.len();
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// `serde_json`'s compact form with every number written as JavaScript writes it: an integer as
/// the double it rounds to, a float as its own shortest text, both in ECMAScript's
/// `Number::toString` form. `serde_json` writes `null` for a non-finite
/// float before reaching the formatter, as `JSON.stringify` does. A raw JSON fragment is refused,
/// since its text is written as it came and not as JavaScript would write its value.
struct EcmaScriptNumbers;

impl Formatter for EcmaScriptNumbers {
    fn write_i8<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: i8) -> io::Result<()> {
        self.write_f64(writer, f64::from(value))
    }

    fn write_i16<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: i16) -> io::Result<()> {
        self.write_f64(writer, f64::from(value))
    }

    fn write_i32<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: i32) -> io::Result<()> {
        self.write_f64(writer, f64::from(value))
    }

    #[expect(
        clippy::cast_precision_loss,
        reason = "a large integer rounds to the double JavaScript holds"
    )]
    fn write_i64<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: i64) -> io::Result<()> {
        self.write_f64(writer, value as f64)
    }

    #[expect(
        clippy::cast_precision_loss,
        reason = "a large integer rounds to the double JavaScript holds"
    )]
    fn write_i128<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: i128) -> io::Result<()> {
        self.write_f64(writer, value as f64)
    }

    fn write_u8<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: u8) -> io::Result<()> {
        self.write_f64(writer, f64::from(value))
    }

    fn write_u16<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: u16) -> io::Result<()> {
        self.write_f64(writer, f64::from(value))
    }

    fn write_u32<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: u32) -> io::Result<()> {
        self.write_f64(writer, f64::from(value))
    }

    #[expect(
        clippy::cast_precision_loss,
        reason = "a large integer rounds to the double JavaScript holds"
    )]
    fn write_u64<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: u64) -> io::Result<()> {
        self.write_f64(writer, value as f64)
    }

    #[expect(
        clippy::cast_precision_loss,
        reason = "a large integer rounds to the double JavaScript holds"
    )]
    fn write_u128<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: u128) -> io::Result<()> {
        self.write_f64(writer, value as f64)
    }

    fn write_f32<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: f32) -> io::Result<()> {
        writer.write_all(ryu_js::Buffer::new().format_finite(value).as_bytes())
    }

    fn write_f64<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: f64) -> io::Result<()> {
        writer.write_all(ryu_js::Buffer::new().format_finite(value).as_bytes())
    }

    fn write_number_str<W: ?Sized + io::Write>(
        &mut self,
        writer: &mut W,
        value: &str,
    ) -> io::Result<()> {
        // A number kept as its text is the double `JSON.parse` reads from it; a text `serde_json`
        // kept is a JSON number, which always parses.
        let parsed: f64 = value
            .parse()
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        self.write_f64(writer, parsed)
    }

    fn write_raw_fragment<W: ?Sized + io::Write>(
        &mut self,
        _writer: &mut W,
        _fragment: &str,
    ) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "a raw JSON fragment has no measurable JavaScript form",
        ))
    }
}

/// A garde check that `value` measures at most `budget_bytes` JSON bytes, counted as
/// [`json_utf8_byte_length`] counts them; a value it cannot measure is refused too.
pub fn fits_budget<T: Serialize>(value: &T, budget_bytes: usize) -> garde::Result {
    let measured_bytes = json_utf8_byte_length(value)
        // serde's message can quote a value, so the failure is named, never carried.
        .map_err(|_unquoted| garde::Error::new("the value does not serialize as JSON"))?;
    if measured_bytes > budget_bytes {
        return Err(garde::Error::new(format!(
            "the value measures {measured_bytes} JSON bytes, over its {budget_bytes}-byte cap"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::Value;
    use serde_json::value::RawValue;

    use super::{fits_budget, json_utf8_byte_length};

    /// One case of the table the TypeScript copy also reads: a value, or its JSON text where
    /// parsing changes how it is written, and its length.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ByteLengthCase {
        note: String,
        value: Option<Value>,
        value_text: Option<String>,
        bytes: usize,
    }

    #[test]
    fn a_value_measures_what_javascript_writes() {
        let cases: Vec<ByteLengthCase> = serde_json::from_str(include_str!(
            "../../tests/fixtures/jsonrpc/byte-length.json"
        ))
        .expect("the case table reads");
        for case in cases {
            let value = match (case.value, case.value_text) {
                (Some(value), None) => value,
                (None, Some(text)) => serde_json::from_str(&text).expect("the text is JSON"),
                (Some(_), Some(_)) | (None, None) => panic!("{}: one value per case", case.note),
            };
            assert_eq!(
                json_utf8_byte_length(&value).expect("a value serializes"),
                case.bytes,
                "{}",
                case.note
            );
        }
    }

    #[test]
    fn a_raw_fragment_is_refused() {
        let fragment =
            RawValue::from_string(r#"{ "a" : 1.0 }"#.to_owned()).expect("the text is JSON");
        assert!(json_utf8_byte_length(&fragment).is_err());
        assert!(fits_budget(&fragment, usize::MAX).is_err());
    }
}
