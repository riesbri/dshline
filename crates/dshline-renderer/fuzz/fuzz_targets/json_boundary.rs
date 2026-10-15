#![no_main]
use libfuzzer_sys::fuzz_target;
fuzz_target!(|bytes: &[u8]| if bytes.len() <= 1_048_577 {
    let _ = dshline_renderer::protocol::execute_bytes(bytes);
});
