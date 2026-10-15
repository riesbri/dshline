use std::io::{Read, Write};
fn main() {
    let mut bytes = Vec::new();
    let result = match std::io::stdin().take(1_048_577).read_to_end(&mut bytes) {
        Ok(_) if bytes.len() > 1_048_576 => dshline_renderer::protocol::error("RESOURCE_LIMIT"),
        Ok(_) => dshline_renderer::protocol::execute_bytes(&bytes),
        Err(_) => dshline_renderer::protocol::error("INVALID_INPUT"),
    };
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let _ = serde_json::to_writer(&mut out, &result);
    let _ = out.write_all(b"\n");
}
