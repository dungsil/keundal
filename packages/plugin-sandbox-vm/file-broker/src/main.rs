#[cfg(any(unix, windows))]
mod broker;

fn main() {
    #[cfg(any(unix, windows))]
    let result = broker::run();
    #[cfg(not(any(unix, windows)))]
    let result: std::io::Result<()> = Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "platform not security-qualified",
    ));
    if let Err(error) = result {
        // Never echo paths, JSON parser diagnostics, or file contents to the guest.
        eprintln!("file broker failed ({:?})", error.kind());
        std::process::exit(1);
    }
}
