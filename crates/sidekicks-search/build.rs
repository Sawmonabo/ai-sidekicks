//! Gives the matcher's WebAssembly module a 64 KiB stack in place of the linker's 1 MiB default:
//! the scorer keeps its rows and buffers on the heap, so the stack holds only call frames, and the
//! module's memory starts at two 64 KiB pages instead of seventeen.

fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_ARCH").is_ok_and(|arch| arch == "wasm32") {
        println!("cargo::rustc-link-arg-cdylib=-zstack-size=65536");
    }
}
