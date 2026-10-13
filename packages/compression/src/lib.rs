//! Packs and unpacks one chunk of text at a time in LZ4's block format, compiled to a WebAssembly
//! module the desktop loads to hold long transcript text packed.
//!
//! The module keeps two buffers in its own memory and allocates nothing, so its memory never grows.
//! A caller writes a chunk of at most 16 KiB at `plain_ptr` and calls `compress`, then reads the
//! packed bytes at `packed_ptr`; `decompress` runs the other way. The module runs on one thread and
//! no call re-enters it, so each call has both buffers to itself.

#![cfg_attr(target_arch = "wasm32", no_std)]

/// The most bytes one plain chunk holds.
const PLAIN_CAPACITY: usize = 16 * 1024;

/// The most bytes a full plain chunk packs into: LZ4's worst case, for input that does not pack.
const PACKED_CAPACITY: usize = lz4_flex::block::get_maximum_output_size(PLAIN_CAPACITY);

/// What `compress` and `decompress` return when they fail.
const FAILED: u32 = u32::MAX;

static mut PLAIN: [u8; PLAIN_CAPACITY] = [0; PLAIN_CAPACITY];
static mut PACKED: [u8; PACKED_CAPACITY] = [0; PACKED_CAPACITY];

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

/// The address of the plain buffer, 16 KiB, where a chunk is written before `compress` and read
/// after `decompress`.
#[unsafe(no_mangle)]
pub extern "C" fn plain_ptr() -> *mut u8 {
    (&raw mut PLAIN).cast()
}

/// The address of the packed buffer, where `compress` writes and `decompress` reads.
#[unsafe(no_mangle)]
pub extern "C" fn packed_ptr() -> *mut u8 {
    (&raw mut PACKED).cast()
}

/// Packs the first `length` bytes of the plain buffer into the packed buffer and returns the packed
/// length. Returns `u32::MAX`, which JavaScript reads as -1, when `length` is past 16 KiB.
#[unsafe(no_mangle)]
pub extern "C" fn compress(length: u32) -> u32 {
    // SAFETY: one call runs at a time, so nothing else reads or writes either buffer while these
    // references live.
    let (plain, packed) = unsafe { (&*(&raw const PLAIN), &mut *(&raw mut PACKED)) };
    let Some(input) = plain.get(..length as usize) else {
        return FAILED;
    };
    lz4_flex::block::compress_into(input, packed)
        .map_or(FAILED, |packed_length| packed_length as u32)
}

/// Unpacks the first `length` bytes of the packed buffer into the plain buffer and returns the
/// plain length. Returns `u32::MAX`, which JavaScript reads as -1, when `length` is past the packed
/// buffer, or the bytes are no LZ4 block or unpack past 16 KiB.
#[unsafe(no_mangle)]
pub extern "C" fn decompress(length: u32) -> u32 {
    // SAFETY: one call runs at a time, so nothing else reads or writes either buffer while these
    // references live.
    let (packed, plain) = unsafe { (&*(&raw const PACKED), &mut *(&raw mut PLAIN)) };
    let Some(input) = packed.get(..length as usize) else {
        return FAILED;
    };
    lz4_flex::block::decompress_into(input, plain)
        .map_or(FAILED, |plain_length| plain_length as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard, PoisonError};

    /// Held by each test, since the tests run on parallel threads and share the module's buffers.
    static BUFFERS: Mutex<()> = Mutex::new(());

    /// Takes the buffers, even from a test that failed holding them, so each test reports its own
    /// failure.
    fn hold_buffers() -> MutexGuard<'static, ()> {
        BUFFERS.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn plain_buffer() -> &'static mut [u8] {
        // SAFETY: the caller holds `BUFFERS`, so no other test touches the buffer.
        unsafe { core::slice::from_raw_parts_mut(plain_ptr(), PLAIN_CAPACITY) }
    }

    fn packed_buffer() -> &'static mut [u8] {
        // SAFETY: the caller holds `BUFFERS`, so no other test touches the buffer.
        unsafe { core::slice::from_raw_parts_mut(packed_ptr(), PACKED_CAPACITY) }
    }

    /// Exactly 16 KiB of whole UTF-8 characters, two, three and four bytes wide among ASCII.
    fn full_chunk_of_multibyte_text() -> Vec<u8> {
        let mut text = String::new();
        for line in 0.. {
            let next = format!("{line}. Café — 漢字とかな 🙂 ok\n");
            if text.len() + next.len() > PLAIN_CAPACITY {
                break;
            }
            text.push_str(&next);
        }
        text.push_str(&"x".repeat(PLAIN_CAPACITY - text.len()));
        text.into_bytes()
    }

    #[test]
    fn round_trips_a_full_chunk_of_multibyte_text_and_an_empty_chunk() {
        let _buffers = hold_buffers();
        let chunk = full_chunk_of_multibyte_text();
        assert_eq!(chunk.len(), PLAIN_CAPACITY);

        plain_buffer().copy_from_slice(&chunk);
        let packed_length = compress(chunk.len() as u32) as usize;
        assert!(
            packed_length < chunk.len(),
            "packed to {packed_length} bytes"
        );
        let packed = packed_buffer()[..packed_length].to_vec();

        // The empty chunk overwrites the packed buffer, as packing another chunk does.
        let empty_packed_length = compress(0);
        assert_ne!(empty_packed_length, FAILED);
        assert_eq!(decompress(empty_packed_length), 0);

        plain_buffer().fill(0);
        packed_buffer()[..packed_length].copy_from_slice(&packed);
        assert_eq!(decompress(packed_length as u32) as usize, chunk.len());
        assert_eq!(
            std::str::from_utf8(plain_buffer()).unwrap(),
            std::str::from_utf8(&chunk).unwrap()
        );
    }

    #[test]
    fn fails_on_a_length_past_its_buffer_or_bytes_that_are_no_chunk() {
        let _buffers = hold_buffers();
        assert_eq!(compress(PLAIN_CAPACITY as u32 + 1), u32::MAX);
        assert_eq!(decompress(PACKED_CAPACITY as u32 + 1), u32::MAX);

        // A literal run that says 15 bytes follow, and none do.
        packed_buffer()[0] = 0xF0;
        assert_eq!(decompress(1), u32::MAX);

        // A real LZ4 block that unpacks one byte past the plain buffer.
        let oversized = vec![b'a'; PLAIN_CAPACITY + 1];
        let mut packed = vec![0; lz4_flex::block::get_maximum_output_size(oversized.len())];
        let packed_length = lz4_flex::block::compress_into(&oversized, &mut packed).unwrap();
        packed_buffer()[..packed_length].copy_from_slice(&packed[..packed_length]);
        assert_eq!(decompress(packed_length as u32), u32::MAX);
    }
}
