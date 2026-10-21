//! The one encode and decode of a stored body. A body of 1 KiB or more is stored as one zstd stream
//! at level 3, made of one frame per page of text, each frame ending at a character boundary and
//! recording its decoded size and a checksum; a smaller body is stored as its UTF-8 bytes. The
//! payload names the encoding and the body's whole length, so a reader decodes by them and a part
//! read decodes only the frames its part covers. The writer thread encodes, through one reused
//! compressor; every reader decodes here.

use std::io;
use std::string::FromUtf8Error;

use rusqlite::Row;
use rusqlite::types::Type;
use sidekicks_contracts::event::declared_variants::{
    CONTENT_ENCODING_PAYLOAD_KEY, CONTENT_LENGTH_PAYLOAD_KEY, ContentEncoding,
};
use sidekicks_contracts::jsonrpc::page::PAGE_MAX_BYTES;
use zstd::bulk::{Compressor, Decompressor};
use zstd::zstd_safe::{self, CParameter};

use crate::database::stored_column::{closed_word, optional_text_column};

/// The smallest body stored compressed, in UTF-8 bytes.
const COMPRESSED_FROM_BYTES: usize = 1024;

/// The zstd level every compressed body is stored at.
const COMPRESSION_LEVEL: i32 = 3;

/// The most text one frame holds, in UTF-8 bytes: a page, so a part read decodes at most two.
const FRAME_TEXT_MAX_BYTES: usize = PAGE_MAX_BYTES;

/// A body as the append path hands it to the writer: its whole text, which the writer stores as it
/// is or compressed by its length. Only the append path makes one, so every stored body went
/// through the encoding its payload names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StoredBody {
    text: String,
}

impl StoredBody {
    /// The body `text` will be stored as.
    pub(in crate::events) fn new(text: String) -> Self {
        Self { text }
    }

    /// The encoding its payload names: `zstd` from 1 KiB, none below.
    pub(crate) fn encoding(&self) -> Option<ContentEncoding> {
        (self.text.len() >= COMPRESSED_FROM_BYTES).then_some(ContentEncoding::Zstd)
    }

    /// Its UTF-8 length, the `contentLength` its payload states.
    pub(crate) fn len(&self) -> usize {
        self.text.len()
    }
}

/// The writer thread's encoder: one zstd compressor and one output buffer, both reused for every
/// body the thread stores.
pub(crate) struct BodyEncoder {
    compressor: Compressor<'static>,
    frame: Vec<u8>,
    stream: Vec<u8>,
}

impl BodyEncoder {
    /// An encoder at level 3 whose frames carry their checksum. Panics only when zstd cannot make
    /// its context, which only a failed allocation does.
    pub(crate) fn new() -> Self {
        let mut compressor =
            Compressor::new(COMPRESSION_LEVEL).expect("zstd makes a context at level 3");
        compressor
            .set_parameter(CParameter::ChecksumFlag(true))
            .expect("zstd takes the checksum flag");
        Self {
            compressor,
            frame: Vec::new(),
            stream: Vec::new(),
        }
    }

    /// The bytes `body` is stored as: its text, or its zstd stream of one frame per page of text
    /// cut at character boundaries. Fails only when zstd refuses a frame.
    pub(crate) fn encode<'body>(
        &'body mut self,
        body: &'body StoredBody,
    ) -> io::Result<&'body [u8]> {
        if body.encoding().is_none() {
            return Ok(body.text.as_bytes());
        }
        self.stream.clear();
        let text = body.text.as_str();
        let mut start = 0;
        while start < text.len() {
            let end = text.floor_char_boundary((start + FRAME_TEXT_MAX_BYTES).min(text.len()));
            let page = &text.as_bytes()[start..end];
            self.frame.clear();
            self.frame.reserve(zstd::compress_bound(page.len()));
            self.compressor.compress_to_buffer(page, &mut self.frame)?;
            self.stream.extend_from_slice(&self.frame);
            start = end;
        }
        Ok(&self.stream)
    }
}

/// Why a stored body does not read back as the text its payload describes; the row is damaged.
#[derive(Debug, thiserror::Error)]
pub(crate) enum BodyDecodeError {
    /// The body decodes to another length than its payload states.
    #[error("the stored body decodes to {decoded} bytes where its payload states {stated}")]
    Length {
        /// The length the payload states.
        stated: u64,
        /// The length it decodes to.
        decoded: u64,
    },
    /// The body's payload states no length, which every compressed body and every sized read
    /// needs.
    #[error("the stored body's payload states no length")]
    NoLength,
    /// The bytes are not a zstd stream of frames that record their size, or a frame fails its
    /// checksum.
    #[error("the stored body is not a whole zstd stream")]
    Stream(#[source] io::Error),
    /// The decoded bytes are not UTF-8.
    #[error("the stored body is not UTF-8")]
    Utf8(#[source] FromUtf8Error),
}

/// The text of a stored body: `stored`, encoded as `encoding`, whose payload states
/// `content_length`. Fails when it does not decode to exactly that many bytes of UTF-8; a body
/// stored as it is and stating no length is taken as it is.
pub(crate) fn decode_body(
    stored: Vec<u8>,
    encoding: Option<ContentEncoding>,
    content_length: Option<u64>,
) -> Result<String, BodyDecodeError> {
    let decoded = match encoding {
        None => stored,
        Some(ContentEncoding::Zstd) => {
            let stated = content_length.ok_or(BodyDecodeError::NoLength)?;
            let capacity =
                usize::try_from(stated).map_err(|_overflow| BodyDecodeError::Length {
                    stated,
                    decoded: u64::MAX,
                })?;
            Decompressor::new()
                .and_then(|mut decompressor| decompressor.decompress(&stored, capacity))
                .map_err(BodyDecodeError::Stream)?
        }
    };
    let decoded_length = decoded.len() as u64;
    if let Some(stated) = content_length
        && stated != decoded_length
    {
        return Err(BodyDecodeError::Length {
            stated,
            decoded: decoded_length,
        });
    }
    String::from_utf8(decoded).map_err(BodyDecodeError::Utf8)
}

/// A stretch of a stored body's text, decoded alone.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct DecodedStretch {
    /// Where the stretch starts in the body, a character boundary at or before the asked start.
    pub(crate) start: usize,
    /// Its text, through the asked end or the body's end.
    pub(crate) text: String,
}

/// The stretch of a stored body that covers `from..to`, decoding only the frames it falls in: a
/// body stored as it is reads whole. A range no frame covers, such as one starting at the body's
/// end, reads as an empty stretch at the end. Fails as [`decode_body`] does, and on a stream whose
/// frames do not record their decoded size.
pub(crate) fn decode_body_stretch(
    stored: Vec<u8>,
    encoding: Option<ContentEncoding>,
    content_length: Option<u64>,
    from: usize,
    to: usize,
) -> Result<DecodedStretch, BodyDecodeError> {
    let Some(ContentEncoding::Zstd) = encoding else {
        return Ok(DecodedStretch {
            start: 0,
            text: decode_body(stored, encoding, content_length)?,
        });
    };
    let stated = content_length.ok_or(BodyDecodeError::NoLength)?;
    let mut rest = stored.as_slice();
    let mut frame_start: u64 = 0;
    let mut covered: Option<(u64, usize, usize)> = None;
    let mut stream_offset = 0;
    while !rest.is_empty() {
        let frame_bytes = zstd_safe::find_frame_compressed_size(rest).map_err(stream_fault)?;
        let frame_text = zstd_safe::get_frame_content_size(rest)
            .ok()
            .flatten()
            .ok_or_else(|| stream_fault(0))?;
        let frame_end = frame_start + frame_text;
        if frame_end > from as u64 && frame_start < to as u64 {
            let (start, first, _) = covered.unwrap_or((frame_start, stream_offset, 0));
            covered = Some((start, first, stream_offset + frame_bytes));
        }
        stream_offset += frame_bytes;
        frame_start = frame_end;
        rest = rest.get(frame_bytes..).ok_or_else(|| stream_fault(0))?;
    }
    if frame_start != stated {
        return Err(BodyDecodeError::Length {
            stated,
            decoded: frame_start,
        });
    }
    let Some((start, first, last)) = covered else {
        return Ok(DecodedStretch {
            start: usize::try_from(stated).unwrap_or(usize::MAX),
            text: String::new(),
        });
    };
    let frames = &stored[first..last];
    let capacity = Decompressor::upper_bound(frames).ok_or_else(|| stream_fault(0))?;
    let decoded = Decompressor::new()
        .and_then(|mut decompressor| decompressor.decompress(frames, capacity))
        .map_err(BodyDecodeError::Stream)?;
    Ok(DecodedStretch {
        start: usize::try_from(start).expect("a stretch held in memory starts within usize"),
        text: String::from_utf8(decoded).map_err(BodyDecodeError::Utf8)?,
    })
}

// A frame walk that met bytes no frame header reads, as the stream fault it is.
fn stream_fault(code: usize) -> BodyDecodeError {
    let name = if code == 0 {
        "the frame records no decoded size"
    } else {
        zstd_safe::get_error_name(code)
    };
    BodyDecodeError::Stream(io::Error::new(io::ErrorKind::InvalidData, name))
}

/// The columns a reader selects to decode the body of the row aliased `alias`: the stored bytes,
/// the encoding and the length its payload states, read back by [`StoredBodyColumns::read`].
pub(crate) fn stored_body_columns_sql(alias: &str) -> String {
    format!(
        "{alias}.content_payload, {}, {}",
        stored_body_encoding_sql(alias),
        stored_body_length_sql(alias)
    )
}

/// The encoding the payload of the row aliased `alias` names for its body.
pub(crate) fn stored_body_encoding_sql(alias: &str) -> String {
    format!("json_extract({alias}.payload, '$.{CONTENT_ENCODING_PAYLOAD_KEY}')")
}

/// The decoded length of the body of the row aliased `alias`, as its payload states it; a reader
/// sizes a body by it, never by its stored bytes.
pub(crate) fn stored_body_length_sql(alias: &str) -> String {
    format!("json_extract({alias}.payload, '$.{CONTENT_LENGTH_PAYLOAD_KEY}')")
}

/// The stored bytes, encoding and length at `index` and the two columns after it, as
/// [`stored_body_columns_sql`] selects them.
pub(crate) struct StoredBodyColumns {
    /// The stored bytes, `None` for a row with no body.
    pub(crate) stored: Option<Vec<u8>>,
    /// The encoding its payload names.
    pub(crate) encoding: Option<ContentEncoding>,
    /// The length its payload states.
    pub(crate) content_length: Option<u64>,
}

impl StoredBodyColumns {
    /// Reads the three columns from `index` on. Fails with rusqlite's conversion error on an
    /// encoding no build writes or a negative length.
    pub(crate) fn read(row: &Row<'_>, index: usize) -> rusqlite::Result<Self> {
        let content_length: Option<i64> = row.get(index + 2)?;
        Ok(Self {
            stored: row.get(index)?,
            encoding: optional_text_column(row, index + 1, closed_word::<ContentEncoding>)?,
            content_length: content_length
                .map(|length| {
                    u64::try_from(length).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            index + 2,
                            Type::Integer,
                            Box::new(error),
                        )
                    })
                })
                .transpose()?,
        })
    }

    /// The length its payload states, which every stored body carries; fails with rusqlite's
    /// conversion error, keeping [`BodyDecodeError::NoLength`], when it states none.
    pub(crate) fn stated_length(&self, index: usize) -> rusqlite::Result<u64> {
        self.content_length
            .ok_or_else(|| decode_failure(index, BodyDecodeError::NoLength))
    }

    /// The body's text, `None` for a row with no body. Fails with rusqlite's conversion error,
    /// keeping the [`BodyDecodeError`], when it does not decode.
    pub(crate) fn decode(self, index: usize) -> rusqlite::Result<Option<String>> {
        self.stored
            .map(|stored| {
                decode_body(stored, self.encoding, self.content_length)
                    .map_err(|error| decode_failure(index, error))
            })
            .transpose()
    }

    /// The stretch of the body covering `from..to`, `None` for a row with no body; fails as
    /// [`StoredBodyColumns::decode`] does.
    pub(crate) fn decode_stretch(
        self,
        index: usize,
        from: usize,
        to: usize,
    ) -> rusqlite::Result<Option<DecodedStretch>> {
        self.stored
            .map(|stored| {
                decode_body_stretch(stored, self.encoding, self.content_length, from, to)
                    .map_err(|error| decode_failure(index, error))
            })
            .transpose()
    }
}

/// A body that does not decode, as the read's conversion failure on its column.
fn decode_failure(index: usize, error: BodyDecodeError) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(index, Type::Blob, Box::new(error))
}

#[cfg(test)]
mod tests;
