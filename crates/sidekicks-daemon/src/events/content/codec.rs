//! The one encode and decode of a stored body. A body of 1 KiB or more is stored as one zstd stream
//! at level 3, made of one frame per page of text, each frame ending at a character boundary and
//! recording its decoded size and a checksum; a smaller body is stored as its UTF-8 bytes. The
//! payload names the encoding and the body's whole length, so a reader decodes by them, a part
//! read decodes only the frames its part covers, and a reader of a body too long to hold takes it
//! a frame at a time from the stored column. The writer thread encodes, through one reused
//! compressor; every reader decodes here.

use std::io::{self, BufRead, BufReader, Read as _};
use std::mem;
use std::ops::{ControlFlow, Range};
use std::string::FromUtf8Error;

use rusqlite::blob::Blob;
use rusqlite::types::{FromSqlError, Type, Value};
use rusqlite::{Connection, MAIN_DB, Row};
use sidekicks_contracts::event::declared_variants::{
    CONTENT_ENCODING_PAYLOAD_KEY, CONTENT_LENGTH_PAYLOAD_KEY, ContentEncoding,
};
use sidekicks_contracts::jsonrpc::page::PAGE_MAX_BYTES;
use zstd::bulk::Compressor;
use zstd::stream::read::Decoder;
use zstd::zstd_safe::zstd_sys::ZSTD_ErrorCode;
use zstd::zstd_safe::{self, CParameter, DCtx};

use crate::database::schema::SESSION_EVENTS_TABLE;
use crate::database::stored_column::closed_word;

/// The smallest body stored compressed, in UTF-8 bytes.
const COMPRESSED_FROM_BYTES: usize = 1024;

/// The zstd level every compressed body is stored at.
const COMPRESSION_LEVEL: i32 = 3;

/// The most text one frame holds, in UTF-8 bytes: a page, so a part read decodes at most two.
const FRAME_TEXT_MAX_BYTES: usize = PAGE_MAX_BYTES;

/// The longest zstd frame header, in bytes, which holds the frame's decoded size.
const FRAME_HEADER_MAX_BYTES: usize = 18;

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

/// Why a stored body does not read back as the text its payload describes: the row is damaged,
/// unless zstd ran out of memory decoding it.
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
    /// zstd had no memory to make or feed a decoding context; the row is not at fault.
    #[error("zstd ran out of memory decoding the stored body")]
    OutOfMemory,
}

/// The text of a stored body: `stored`, encoded as `encoding`, whose payload states
/// `content_length`. Fails when it does not decode to exactly that many bytes of UTF-8, or with
/// [`BodyDecodeError::OutOfMemory`] when zstd runs out of memory; a body stored as it is and
/// stating no length is taken as it is.
pub(crate) fn decode_body(
    stored: Vec<u8>,
    encoding: Option<ContentEncoding>,
    content_length: Option<u64>,
) -> Result<String, BodyDecodeError> {
    let decoded = match encoding {
        None => stored,
        Some(ContentEncoding::Zstd) => {
            let stated = content_length.ok_or(BodyDecodeError::NoLength)?;
            walk_frames(&stored, stated, |_, _| {})?;
            let capacity =
                usize::try_from(stated).map_err(|_overflow| BodyDecodeError::Length {
                    stated,
                    decoded: u64::MAX,
                })?;
            decompress_frames(&stored, capacity)?
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
    // The covered frames' start in the text, their stored bytes and their text's length.
    let mut covered: Option<(u64, Range<usize>, usize)> = None;
    walk_frames(&stored, stated, |text, frame| {
        if text.end > from as u64 && text.start < to as u64 {
            let frame_text = usize::try_from(text.end - text.start)
                .expect("a frame holds at most a page of text");
            match &mut covered {
                None => covered = Some((text.start, frame, frame_text)),
                Some((_, frames, covered_text)) => {
                    frames.end = frame.end;
                    *covered_text += frame_text;
                }
            }
        }
    })?;
    let Some((start, frames, capacity)) = covered else {
        return Ok(DecodedStretch {
            start: usize::try_from(stated).unwrap_or(usize::MAX),
            text: String::new(),
        });
    };
    let decoded = decompress_frames(&stored[frames], capacity)?;
    Ok(DecodedStretch {
        start: usize::try_from(start).expect("a stretch held in memory starts within usize"),
        text: String::from_utf8(decoded).map_err(BodyDecodeError::Utf8)?,
    })
}

// Walks the zstd frames of `stored` by their headers alone, before any is decoded, handing `each`
// each frame's stretch of the text and of the stored bytes. Fails as the damage it is on a frame
// whose header records no size or more than a page of text, or that runs past the stored bytes,
// and on frames whose text is not `stated` bytes in all, so a reader reserves room only for the
// text the frames hold.
fn walk_frames(
    stored: &[u8],
    stated: u64,
    mut each: impl FnMut(Range<u64>, Range<usize>),
) -> Result<(), BodyDecodeError> {
    let mut rest = stored;
    let mut text_start: u64 = 0;
    let mut stream_offset = 0;
    while !rest.is_empty() {
        let frame_bytes = zstd_safe::find_frame_compressed_size(rest)
            .map_err(|code| stream_fault(StreamFault::Zstd(code)))?;
        let frame_text = frame_text_bytes(rest)?;
        if frame_text > FRAME_TEXT_MAX_BYTES as u64 {
            return Err(stream_fault(StreamFault::FrameOverPage));
        }
        let text_end = text_start
            .checked_add(frame_text)
            .ok_or(BodyDecodeError::Length {
                stated,
                decoded: u64::MAX,
            })?;
        rest = rest
            .get(frame_bytes..)
            .ok_or_else(|| stream_fault(StreamFault::FramePastEnd))?;
        each(
            text_start..text_end,
            stream_offset..stream_offset + frame_bytes,
        );
        stream_offset += frame_bytes;
        text_start = text_end;
    }
    if text_start != stated {
        return Err(BodyDecodeError::Length {
            stated,
            decoded: text_start,
        });
    }
    Ok(())
}

// The text of the whole zstd frames `frames`, whose headers record `capacity` bytes, decoded
// through a context made for the call. Fails with `OutOfMemory` when the context or the text's
// buffer cannot be had, and as the damage it is when zstd refuses the frames.
fn decompress_frames(frames: &[u8], capacity: usize) -> Result<Vec<u8>, BodyDecodeError> {
    let mut context = DCtx::try_create().ok_or(BodyDecodeError::OutOfMemory)?;
    let mut decoded = Vec::new();
    decoded
        .try_reserve_exact(capacity)
        .map_err(|_no_room| BodyDecodeError::OutOfMemory)?;
    context
        .decompress(&mut decoded, frames)
        .map_err(|code| match code {
            ZSTD_OUT_OF_MEMORY => BodyDecodeError::OutOfMemory,
            refused => stream_fault(StreamFault::Zstd(refused)),
        })?;
    Ok(decoded)
}

/// The code a zstd call answers when it could not allocate.
pub(in crate::events) const ZSTD_OUT_OF_MEMORY: usize =
    (ZSTD_ErrorCode::ZSTD_error_memory_allocation as usize).wrapping_neg();

// What a frame walk met that no whole frame of a stored body holds.
#[derive(Clone, Copy)]
enum StreamFault {
    // zstd's own error code, from a header it could not read.
    Zstd(usize),
    // A frame whose header records no decoded size.
    NoDecodedSize,
    // A frame that decodes to more than a page of text, which no writer stores.
    FrameOverPage,
    // A frame whose stated size runs past the stored bytes.
    FramePastEnd,
}

// A frame walk's fault, as the stream fault it is.
fn stream_fault(fault: StreamFault) -> BodyDecodeError {
    let name = match fault {
        StreamFault::Zstd(code) => zstd_safe::get_error_name(code),
        StreamFault::NoDecodedSize => "the frame records no decoded size",
        StreamFault::FrameOverPage => "the frame decodes to more than a page of text",
        StreamFault::FramePastEnd => "the frame runs past the stored bytes",
    };
    BodyDecodeError::Stream(io::Error::new(io::ErrorKind::InvalidData, name))
}

/// A failed read of a stored body's stream: SQLite's own refusal of the column as that, running
/// out of memory as that, whether the system or zstd says so (the zstd crate carries zstd's own
/// error by its name), and anything else as the damage it is.
pub(in crate::events) fn stream_read_failure(error: io::Error) -> BodyStreamError {
    match error.downcast::<rusqlite::Error>() {
        Ok(refused) => BodyStreamError::Read(refused),
        Err(no_memory)
            if no_memory.kind() == io::ErrorKind::OutOfMemory
                || no_memory.to_string() == zstd_safe::get_error_name(ZSTD_OUT_OF_MEMORY) =>
        {
            BodyStreamError::OutOfMemory
        }
        Err(damage) => BodyDecodeError::Stream(damage).into(),
    }
}

// The decoded size the header at the start of `stored` records for its frame.
fn frame_text_bytes(stored: &[u8]) -> Result<u64, BodyDecodeError> {
    zstd_safe::get_frame_content_size(stored)
        .ok()
        .flatten()
        .ok_or_else(|| stream_fault(StreamFault::NoDecodedSize))
}

/// Why a stored body could not be read a frame at a time.
#[derive(Debug, thiserror::Error)]
pub(crate) enum BodyStreamError {
    /// The body does not read back as the text its payload describes; the row is damaged.
    #[error(transparent)]
    Damaged(BodyDecodeError),
    /// SQLite refused to open or read the stored column.
    #[error("the stored body could not be read")]
    Read(#[from] rusqlite::Error),
    /// The reader refused a frame's text.
    #[error("a stored body's text could not be written")]
    Write(#[source] io::Error),
    /// zstd had no memory to make or feed a decoding context; the row is not at fault.
    #[error("zstd ran out of memory decoding the stored body")]
    OutOfMemory,
}

impl From<BodyDecodeError> for BodyStreamError {
    fn from(error: BodyDecodeError) -> Self {
        match error {
            BodyDecodeError::OutOfMemory => Self::OutOfMemory,
            damage @ (BodyDecodeError::Length { .. }
            | BodyDecodeError::NoLength
            | BodyDecodeError::Stream(_)
            | BodyDecodeError::Utf8(_)) => Self::Damaged(damage),
        }
    }
}

/// The read failure a body zstd had no memory to decode is, as SQLite names running out of
/// memory, so a caller reads it as a failed read and never as a damaged row.
pub(crate) fn out_of_memory_read_failure() -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_NOMEM),
        Some(BodyStreamError::OutOfMemory.to_string()),
    )
}

/// Where a stored body sits before it is read: its row and what its payload states, read back by
/// [`StoredBodyPlace::read`] from the columns [`stored_body_place_sql`] selects.
#[derive(Clone, Debug)]
pub(crate) struct StoredBodyPlace {
    /// The `session_events` row whose `content_payload` holds it.
    pub(crate) rowid: i64,
    /// The encoding its payload names.
    pub(crate) encoding: Option<ContentEncoding>,
    /// The length its payload states.
    pub(crate) content_length: Option<u64>,
}

/// The columns a reader selects to find the body of the row aliased `alias` without loading it:
/// its rowid, the encoding and the length its payload states.
pub(crate) fn stored_body_place_sql(alias: &str) -> String {
    format!(
        "{alias}.rowid, {}, {}",
        stored_body_encoding_sql(alias),
        stored_body_length_sql(alias)
    )
}

impl StoredBodyPlace {
    /// Reads the three columns from `index` on, `None` when the rowid is NULL, as an outer join
    /// leaves it. Fails as [`StoredBodyColumns::read`] does.
    pub(crate) fn read(row: &Row<'_>, index: usize) -> rusqlite::Result<Option<Self>> {
        let Some(rowid) = row.get::<_, Option<i64>>(index)? else {
            return Ok(None);
        };
        Ok(Some(Self {
            rowid,
            encoding: stated_encoding_column(row, index + 1)?,
            content_length: stated_length_column(row, index + 2)?,
        }))
    }

    /// The body's whole text, read on `connection`. Fails with [`BodyStreamError::Damaged`] or
    /// [`BodyStreamError::OutOfMemory`] as [`decode_body`] does, and with
    /// [`BodyStreamError::Read`] when SQLite refuses the column.
    pub(crate) fn decode(&self, connection: &Connection) -> Result<String, BodyStreamError> {
        let blob = self.open(connection)?;
        Ok(decode_body(
            read_whole(&blob)?,
            self.encoding,
            self.content_length,
        )?)
    }

    /// Hands the body's text to `each` a frame at a time, in order, reading each stored byte once
    /// through one zstd input buffer, so no more than that buffer and a page of text are held at
    /// once; a body stored as it is, under 1 KiB, is handed whole. Stops once `each` breaks,
    /// answering what it broke with, before the rest is read or the length checked. Fails as
    /// [`StoredBodyPlace::decode`] does, after handing over the frames before a damaged one, and
    /// with [`BodyStreamError::Write`] when `each` fails.
    pub(crate) fn stream<Stop>(
        &self,
        connection: &Connection,
        mut each: impl FnMut(&str) -> io::Result<ControlFlow<Stop>>,
    ) -> Result<ControlFlow<Stop>, BodyStreamError> {
        let blob = self.open(connection)?;
        let Some(ContentEncoding::Zstd) = self.encoding else {
            let text = decode_body(read_whole(&blob)?, self.encoding, self.content_length)?;
            return each(&text).map_err(BodyStreamError::Write);
        };
        let stated = self.content_length.ok_or(BodyDecodeError::NoLength)?;
        stream_frames(
            BufReader::with_capacity(DCtx::in_size(), blob),
            stated,
            each,
        )
    }

    /// Hands the body's text to `each` a frame at a time as [`StoredBodyPlace::stream`] does,
    /// stopping once `each` breaks, for a reader of the row's columns from `index`: a damaged body
    /// fails with rusqlite's conversion error on that column, keeping why, and a refused read with
    /// SQLite's own error.
    pub(crate) fn stream_column<Stop>(
        &self,
        connection: &Connection,
        index: usize,
        mut each: impl FnMut(&str) -> ControlFlow<Stop>,
    ) -> rusqlite::Result<ControlFlow<Stop>> {
        self.stream(connection, |frame| Ok(each(frame)))
            .map_err(|error| match error {
                BodyStreamError::Read(error) => error,
                BodyStreamError::OutOfMemory => out_of_memory_read_failure(),
                other @ (BodyStreamError::Damaged(_) | BodyStreamError::Write(_)) => {
                    rusqlite::Error::FromSqlConversionFailure(index, Type::Blob, Box::new(other))
                }
            })
    }

    fn open<'connection>(
        &self,
        connection: &'connection Connection,
    ) -> rusqlite::Result<Blob<'connection>> {
        connection.blob_open(
            MAIN_DB,
            SESSION_EVENTS_TABLE,
            "content_payload",
            self.rowid,
            true,
        )
    }
}

// Hands the text of the zstd frames `reader` holds to `each` a frame at a time, as
// `StoredBodyPlace::stream` does, checking that they decode to `stated` bytes unless `each` stops
// them first.
fn stream_frames<Stop>(
    mut reader: impl BufRead,
    stated: u64,
    mut each: impl FnMut(&str) -> io::Result<ControlFlow<Stop>>,
) -> Result<ControlFlow<Stop>, BodyStreamError> {
    let mut context: DCtx<'static> = DCtx::try_create().ok_or(BodyStreamError::OutOfMemory)?;
    let mut header = [0; FRAME_HEADER_MAX_BYTES];
    let mut text = Vec::new();
    let mut decoded: u64 = 0;
    loop {
        let buffered = reader.fill_buf().map_err(stream_read_failure)?;
        if buffered.is_empty() {
            break;
        }
        // A header the buffer ends inside is carried out of it, read on from the next fill,
        // and handed to the decoder ahead of the reader, so every stored byte is read once.
        let carried = if buffered.len() < FRAME_HEADER_MAX_BYTES {
            buffered.len()
        } else {
            0
        };
        header[..carried].copy_from_slice(&buffered[..carried]);
        reader.consume(carried);
        let ahead = reader.fill_buf().map_err(stream_read_failure)?;
        let peeked = ahead.len().min(FRAME_HEADER_MAX_BYTES - carried);
        header[carried..carried + peeked].copy_from_slice(&ahead[..peeked]);
        if frame_text_bytes(&header[..carried + peeked])? > FRAME_TEXT_MAX_BYTES as u64 {
            return Err(stream_fault(StreamFault::FrameOverPage).into());
        }
        text.clear();
        Decoder::with_context((&header[..carried]).chain(&mut reader), &mut context)
            .single_frame()
            .take(FRAME_TEXT_MAX_BYTES as u64 + 1)
            .read_to_end(&mut text)
            .map_err(stream_read_failure)?;
        if text.len() > FRAME_TEXT_MAX_BYTES {
            return Err(stream_fault(StreamFault::FrameOverPage).into());
        }
        let frame = String::from_utf8(mem::take(&mut text)).map_err(BodyDecodeError::Utf8)?;
        if let ControlFlow::Break(stop) = each(&frame).map_err(BodyStreamError::Write)? {
            return Ok(ControlFlow::Break(stop));
        }
        decoded += frame.len() as u64;
        text = frame.into_bytes();
    }
    if decoded != stated {
        return Err(BodyDecodeError::Length { stated, decoded }.into());
    }
    Ok(ControlFlow::Continue(()))
}

// Every stored byte of `blob`.
fn read_whole(blob: &Blob<'_>) -> rusqlite::Result<Vec<u8>> {
    let mut stored = vec![0; blob.len()];
    blob.read_at_exact(&mut stored, 0)?;
    Ok(stored)
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
    /// encoding no build writes, a length that is negative or not an integer, or either of another
    /// type.
    pub(crate) fn read(row: &Row<'_>, index: usize) -> rusqlite::Result<Self> {
        Ok(Self {
            stored: row.get(index)?,
            encoding: stated_encoding_column(row, index + 1)?,
            content_length: stated_length_column(row, index + 2)?,
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

// The encoding a payload names, read from `index`; text naming no encoding, or a value of another
// type, fails with rusqlite's conversion error, as the damage it is.
fn stated_encoding_column(
    row: &Row<'_>,
    index: usize,
) -> rusqlite::Result<Option<ContentEncoding>> {
    match row.get::<_, Value>(index)? {
        Value::Null => Ok(None),
        Value::Text(word) => closed_word(word).map(Some).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(index, Type::Text, Box::new(error))
        }),
        other => Err(wrong_type_failure(index, &other)),
    }
}

// The length a payload states, read from `index`; a negative one, or a value of another type than
// an integer, fails with rusqlite's conversion error, as the damage it is.
fn stated_length_column(row: &Row<'_>, index: usize) -> rusqlite::Result<Option<u64>> {
    match row.get::<_, Value>(index)? {
        Value::Null => Ok(None),
        Value::Integer(length) => u64::try_from(length).map(Some).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(index, Type::Integer, Box::new(error))
        }),
        other => Err(wrong_type_failure(index, &other)),
    }
}

// A payload value of a type no writer stores there, as rusqlite's conversion error on its column.
fn wrong_type_failure(index: usize, value: &Value) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        index,
        value.data_type(),
        Box::new(FromSqlError::InvalidType),
    )
}

/// A body that does not decode, as the read's conversion failure on its column; zstd out of memory
/// as the failed read it is.
fn decode_failure(index: usize, error: BodyDecodeError) -> rusqlite::Error {
    match error {
        BodyDecodeError::OutOfMemory => out_of_memory_read_failure(),
        damage @ (BodyDecodeError::Length { .. }
        | BodyDecodeError::NoLength
        | BodyDecodeError::Stream(_)
        | BodyDecodeError::Utf8(_)) => {
            rusqlite::Error::FromSqlConversionFailure(index, Type::Blob, Box::new(damage))
        }
    }
}

#[cfg(test)]
mod tests;
