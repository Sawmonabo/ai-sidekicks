//! Gives the WebAssembly module a 64 KiB stack in place of the linker's 1 MiB default, so the
//! module's memory stays at two 64 KiB pages: the stack, which holds LZ4's packing table, and the
//! two chunk buffers.

fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_ARCH").is_ok_and(|arch| arch == "wasm32") {
        println!("cargo::rustc-link-arg-cdylib=-zstack-size=65536");
    }
}
