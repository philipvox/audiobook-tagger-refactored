// src-tauri/src/download.rs
// Pinned downloads for the local tools (Ollama, FFmpeg, whisper.cpp, Whisper
// models): stream into a `.partial` file, resume after a stall instead of
// starting over, and keep the file only if its SHA-256 matches the pin.

use std::future::Future;
use std::path::Path;
use std::time::Duration;

/// Longest wait for the next chunk of an install download. There is no
/// overall deadline: a large file on a slow line is fine as long as bytes
/// keep arriving. (The shared download client sets a 30 s connect timeout and
/// the same per-read timeout.)
pub(crate) const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// How many times one download is picked up again after a stall or a broken
/// stream before it is given up.
pub(crate) const MAX_RETRIES: usize = 3;

/// An error and its sources, so "error decoding response body" also says why
/// (for example "operation timed out").
pub(crate) fn error_chain(e: &dyn std::error::Error) -> String {
    let mut msg = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        msg.push_str(": ");
        msg.push_str(&s.to_string());
        source = s.source();
    }
    msg
}

/// The next item of `stream`, failing if nothing arrives within `idle`.
pub(crate) async fn next_chunk<S, B, E>(stream: &mut S, idle: Duration) -> Result<Option<B>, String>
where
    S: futures::Stream<Item = Result<B, E>> + Unpin,
    E: std::error::Error,
{
    use futures::StreamExt;
    match tokio::time::timeout(idle, stream.next()).await {
        Err(_) => Err(format!("No data received for {} seconds; the connection stalled", idle.as_secs())),
        Ok(None) => Ok(None),
        Ok(Some(Err(e))) => Err(format!("Stream error: {}", error_chain(&e))),
        Ok(Some(Ok(chunk))) => Ok(Some(chunk)),
    }
}

/// What a downloaded file must be to be kept.
pub(crate) struct Pinned<'a> {
    /// SHA-256 of the whole file, lowercase or uppercase hex.
    pub sha256: &'a str,
    /// The exact size, when it is pinned too.
    pub size: Option<u64>,
    /// Abort as soon as more than this many bytes have arrived (when the
    /// exact size is not pinned).
    pub max_size: Option<u64>,
}

/// One opened response body.
pub(crate) struct Opened<S> {
    /// Offset in the file of the body's first byte: the offset that was
    /// asked for when the server honoured the Range request, 0 when it sent
    /// the whole file.
    pub start: u64,
    /// Size of the whole file, when the server said.
    pub total: Option<u64>,
    pub stream: S,
}

/// Why a body could not be opened.
#[derive(Debug)]
pub(crate) enum FetchError {
    /// Worth another try from where the partial file ends (a connect error).
    Retry(String),
    /// Worth another try, but from zero: the partial file is discarded.
    Restart(String),
    /// Trying again would not help (HTTP 404).
    Fatal(String),
}

/// How one attempt ended, when not with the finished file's digest.
enum Stop {
    Retry(String),
    Fatal(String),
}

/// SHA-256 state and length of what `path` holds now; an empty state when
/// the file does not exist.
fn hash_existing(path: &Path) -> std::io::Result<(sha2::Sha256, u64)> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut hasher = Sha256::new();
    let mut len = 0u64;
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((hasher, 0)),
        Err(e) => return Err(e),
    };
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            return Ok((hasher, len));
        }
        hasher.update(&buf[..n]);
        len += n as u64;
    }
}

/// Lowercase hex SHA-256 of a file, hashed off the async runtime's threads.
pub(crate) async fn sha256_of_file(path: &Path) -> Result<String, String> {
    use sha2::Digest;
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || hash_existing(&path))
        .await
        .map_err(|e| format!("Hash task failed: {}", e))?
        .map(|(hasher, _)| crate::whisper_local::hex_digest(&hasher.finalize()))
        .map_err(|e| format!("Read error: {}", e))
}

/// One attempt: continue `partial` from where it ends (or start it), until
/// the body ends. Ok is the SHA-256 of the whole file.
async fn attempt<F, Fut, S, B, E>(
    fetch: &mut F,
    partial: &Path,
    pin: &Pinned<'_>,
    idle: Duration,
    on_progress: &mut impl FnMut(u64, Option<u64>),
) -> Result<String, Stop>
where
    F: FnMut(u64) -> Fut,
    Fut: Future<Output = Result<Opened<S>, FetchError>>,
    S: futures::Stream<Item = Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
    E: std::error::Error,
{
    use sha2::{Digest, Sha256};
    use std::io::Write;

    // The hash is over the whole file, so what an earlier attempt left on
    // disk is hashed again (from the disk, not from memory: a failed write
    // may have left part of a chunk behind).
    let existing = partial.to_path_buf();
    let (mut hasher, mut written) = tokio::task::spawn_blocking(move || hash_existing(&existing))
        .await
        .map_err(|e| Stop::Fatal(format!("Hash task failed: {}", e)))?
        .map_err(|e| Stop::Fatal(format!("Read error: {}", e)))?;

    // The stall came after the last byte: nothing left to ask for.
    if written > 0 && pin.size == Some(written) {
        return Ok(crate::whisper_local::hex_digest(&hasher.finalize()));
    }

    let opened = match fetch(written).await {
        Ok(o) => o,
        Err(FetchError::Retry(e)) => return Err(Stop::Retry(e)),
        Err(FetchError::Restart(e)) => {
            let _ = std::fs::remove_file(partial);
            return Err(Stop::Retry(e));
        }
        Err(FetchError::Fatal(e)) => return Err(Stop::Fatal(e)),
    };
    let mut file = if written > 0 && opened.start == written {
        std::fs::OpenOptions::new().append(true).open(partial)
    } else if opened.start == 0 {
        // First attempt, or the server ignored the Range request and sent
        // the whole file: start over from zero.
        hasher = Sha256::new();
        written = 0;
        std::fs::File::create(partial)
    } else {
        let _ = std::fs::remove_file(partial);
        return Err(Stop::Retry(format!(
            "The server answered with bytes from {} when asked to continue at {}",
            opened.start, written
        )));
    }
    .map_err(|e| Stop::Fatal(format!("File error: {}", e)))?;

    let total = pin.size.or(opened.total);
    let limit = pin.size.or(pin.max_size);
    let mut stream = opened.stream;
    loop {
        let chunk = match next_chunk(&mut stream, idle).await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(e) => return Err(Stop::Retry(e)),
        };
        let chunk = chunk.as_ref();
        file.write_all(chunk).map_err(|e| Stop::Fatal(format!("Write error: {}", e)))?;
        hasher.update(chunk);
        written += chunk.len() as u64;
        if let Some(limit) = limit.filter(|l| written > *l) {
            return Err(Stop::Fatal(format!("Download is larger than the expected {} bytes", limit)));
        }
        on_progress(written, total);
    }
    file.flush().map_err(|e| Stop::Fatal(format!("Write error: {}", e)))?;
    if let Some(total) = total.filter(|t| written < *t) {
        return Err(Stop::Retry(format!("Download ended early: got {} of {} bytes", written, total)));
    }
    Ok(crate::whisper_local::hex_digest(&hasher.finalize()))
}

/// Download into `partial`, then rename it to `dest` only if the whole file
/// matches `pin`.
///
/// `fetch(offset)` opens the body from `offset` (0 = the whole file). A
/// stall (`idle` without a chunk), a broken stream or an early end does not
/// cost the bytes already on disk: up to `max_retries` times the download is
/// picked up from where `partial` ends. A server that answers the continued
/// request with the whole file restarts that attempt from zero.
///
/// Nothing is kept on failure: after the last retry, on a fatal error or on
/// a hash mismatch `partial` is removed, so no half file can later be taken
/// for a finished one. A `partial` left by an earlier run is never continued.
pub(crate) async fn download_verified<F, Fut, S, B, E>(
    mut fetch: F,
    partial: &Path,
    dest: &Path,
    pin: &Pinned<'_>,
    idle: Duration,
    max_retries: usize,
    mut on_progress: impl FnMut(u64, Option<u64>),
) -> Result<(), String>
where
    F: FnMut(u64) -> Fut,
    Fut: Future<Output = Result<Opened<S>, FetchError>>,
    S: futures::Stream<Item = Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
    E: std::error::Error,
{
    let _ = std::fs::remove_file(partial);
    let mut retries = 0;
    let actual_hex = loop {
        let error = match attempt(&mut fetch, partial, pin, idle, &mut on_progress).await {
            Ok(hex) => break hex,
            Err(Stop::Fatal(e)) => e,
            Err(Stop::Retry(e)) if retries == max_retries && max_retries > 0 => {
                format!("Download failed after {} attempts. Last error: {}", max_retries + 1, e)
            }
            Err(Stop::Retry(e)) if retries == max_retries => e,
            Err(Stop::Retry(_)) => {
                retries += 1;
                continue;
            }
        };
        let _ = std::fs::remove_file(partial);
        return Err(error);
    };
    crate::whisper_local::finalize_model_download(partial, dest, &actual_hex, pin.sha256)
}

/// `start` and the total size from a `Content-Range: bytes 100-999/1000`
/// header value ("*" for an unknown total).
fn parse_content_range(value: &str) -> Option<(u64, Option<u64>)> {
    let rest = value.trim().strip_prefix("bytes")?.trim_start();
    let (range, total) = rest.split_once('/')?;
    let start = range.split_once('-')?.0.trim().parse().ok()?;
    Some((start, total.trim().parse().ok()))
}

/// GET `url` from `offset`, asking for the rest of the file with a Range
/// header when `offset` is not zero.
async fn open_url(
    client: &reqwest::Client,
    url: &str,
    offset: u64,
) -> Result<Opened<impl futures::Stream<Item = reqwest::Result<impl AsRef<[u8]>>> + Unpin>, FetchError> {
    use reqwest::header::{CONTENT_RANGE, RANGE};
    use reqwest::StatusCode;
    let mut request = client.get(url);
    if offset > 0 {
        request = request.header(RANGE, format!("bytes={}-", offset));
    }
    let resp = request
        .send()
        .await
        .map_err(|e| FetchError::Retry(format!("Download failed: {}", error_chain(&e))))?;
    let status = resp.status();
    if status == StatusCode::PARTIAL_CONTENT {
        let range = resp
            .headers()
            .get(CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(parse_content_range);
        return match range {
            Some((start, total)) => Ok(Opened { start, total, stream: resp.bytes_stream() }),
            None => Err(FetchError::Restart("The server sent part of the file without saying which part".to_string())),
        };
    }
    if status.is_success() {
        return Ok(Opened { start: 0, total: resp.content_length(), stream: resp.bytes_stream() });
    }
    if offset > 0 && status == StatusCode::RANGE_NOT_SATISFIABLE {
        return Err(FetchError::Restart(format!("The server could not continue the download at byte {}", offset)));
    }
    Err(FetchError::Fatal(format!("Download failed: HTTP {}", status)))
}

/// `download_verified` over HTTP: see there. `client` should carry no
/// overall request timeout (`whisper_local::download_client`).
pub(crate) async fn download_url_verified(
    client: &reqwest::Client,
    url: &str,
    partial: &Path,
    dest: &Path,
    pin: &Pinned<'_>,
    idle: Duration,
    max_retries: usize,
    on_progress: impl FnMut(u64, Option<u64>),
) -> Result<(), String> {
    download_verified(|offset| open_url(client, url, offset), partial, dest, pin, idle, max_retries, on_progress).await
}

/// `<dest>.partial`, next to `dest`.
pub(crate) fn partial_path_for(dest: &Path) -> std::path::PathBuf {
    let mut s = dest.as_os_str().to_os_string();
    s.push(".partial");
    std::path::PathBuf::from(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// What the test server does with one request.
    #[derive(Clone, Copy, Debug)]
    enum Plan {
        /// Answer properly, honouring a Range header.
        Serve,
        /// Like Serve, but send only this many body bytes and then go silent
        /// with the connection open.
        StallAfter(usize),
        /// Like Serve, but close the connection after this many body bytes.
        DropAfter(usize),
        /// Send the whole file with 200 whatever was asked for.
        IgnoreRange,
        /// Honour the Range header but send other bytes than the file's.
        CorruptRest,
        /// Answer 206 for a range that starts 10 bytes late.
        ShiftedRange,
        /// Answer with this status and no body.
        Status(u16),
    }

    /// A local HTTP server for `body`. Request N follows `plans[N]`; the last
    /// plan repeats. Returns the URL and the `Range` offset of each request.
    async fn serve(body: Vec<u8>, plans: Vec<Plan>) -> (String, Arc<Mutex<Vec<Option<u64>>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/file.bin", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen_by_server = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                let mut request = Vec::new();
                let mut buf = [0u8; 1024];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match socket.read(&mut buf).await {
                        Ok(n) if n > 0 => request.extend_from_slice(&buf[..n]),
                        _ => break,
                    }
                }
                let text = String::from_utf8_lossy(&request).to_lowercase();
                let range: Option<u64> = text
                    .lines()
                    .find_map(|l| l.strip_prefix("range: bytes="))
                    .and_then(|r| r.trim().trim_end_matches('-').parse().ok());
                let index = {
                    let mut seen = seen_by_server.lock().unwrap();
                    seen.push(range);
                    seen.len() - 1
                };
                let plan = plans[index.min(plans.len() - 1)];
                let body = body.clone();
                tokio::spawn(async move {
                    let total = body.len();
                    let from = match plan {
                        Plan::IgnoreRange => 0,
                        Plan::ShiftedRange => range.unwrap_or(0) as usize + 10,
                        _ => range.unwrap_or(0) as usize,
                    };
                    let mut payload = body[from.min(total)..].to_vec();
                    if matches!(plan, Plan::CorruptRest) {
                        payload.iter_mut().for_each(|b| *b = b.wrapping_add(1));
                    }
                    let head = match plan {
                        Plan::Status(code) => format!("HTTP/1.1 {code} Nope\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
                        _ if from > 0 => format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            from,
                            total - 1,
                            total,
                            payload.len()
                        ),
                        _ => format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", payload.len()),
                    };
                    let _ = socket.write_all(head.as_bytes()).await;
                    match plan {
                        Plan::Status(_) => {}
                        Plan::StallAfter(n) => {
                            let _ = socket.write_all(&payload[..n.min(payload.len())]).await;
                            let _ = socket.flush().await;
                            // Hold the connection open and say nothing more.
                            std::future::pending::<()>().await;
                        }
                        Plan::DropAfter(n) => {
                            let _ = socket.write_all(&payload[..n.min(payload.len())]).await;
                        }
                        _ => {
                            let _ = socket.write_all(&payload).await;
                        }
                    }
                    let _ = socket.shutdown().await;
                });
            }
        });
        (url, seen)
    }

    fn test_body() -> Vec<u8> {
        (0..50_000u32).map(|i| (i.wrapping_mul(31).wrapping_add(i >> 7)) as u8).collect()
    }

    fn sha_hex(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        crate::whisper_local::hex_digest(&Sha256::digest(bytes))
    }

    const SHORT_IDLE: Duration = Duration::from_millis(300);

    struct Run {
        result: Result<(), String>,
        dest: std::path::PathBuf,
        partial: std::path::PathBuf,
        ranges: Vec<Option<u64>>,
        _dir: tempfile::TempDir,
    }

    /// Download `body` from a server following `plans`, pinned to `sha256`.
    async fn run(body: &[u8], plans: Vec<Plan>, sha256: &str, max_size: Option<u64>) -> Run {
        let (url, seen) = serve(body.to_vec(), plans).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("file.bin");
        let partial = partial_path_for(&dest);
        // A leftover from an earlier run must never be continued.
        std::fs::write(&partial, b"stale bytes from an earlier run").unwrap();
        let pin = Pinned { sha256, size: None, max_size };
        let client = reqwest::Client::new();
        let result =
            download_url_verified(&client, &url, &partial, &dest, &pin, SHORT_IDLE, MAX_RETRIES, |_, _| {}).await;
        let ranges = seen.lock().unwrap().clone();
        Run { result, dest, partial, ranges, _dir: dir }
    }

    #[tokio::test]
    async fn a_stall_mid_download_resumes_and_the_hash_matches() {
        let body = test_body();
        let r = run(&body, vec![Plan::StallAfter(20_000), Plan::Serve], &sha_hex(&body), None).await;
        assert_eq!(r.result, Ok(()));
        assert_eq!(std::fs::read(&r.dest).unwrap(), body);
        assert!(!r.partial.exists());
        assert_eq!(r.ranges, vec![None, Some(20_000)], "the second request continues where the first stopped");
    }

    #[tokio::test]
    async fn a_dropped_connection_resumes_too() {
        let body = test_body();
        let r = run(&body, vec![Plan::DropAfter(20_000), Plan::DropAfter(10_000), Plan::Serve], &sha_hex(&body), None).await;
        assert_eq!(r.result, Ok(()));
        assert_eq!(std::fs::read(&r.dest).unwrap(), body);
        assert_eq!(r.ranges, vec![None, Some(20_000), Some(30_000)]);
    }

    #[tokio::test]
    async fn a_server_that_ignores_range_restarts_cleanly() {
        let body = test_body();
        let r = run(&body, vec![Plan::StallAfter(20_000), Plan::IgnoreRange], &sha_hex(&body), None).await;
        assert_eq!(r.result, Ok(()));
        assert_eq!(std::fs::read(&r.dest).unwrap(), body, "the whole file once, not appended to the partial");
        assert_eq!(r.ranges, vec![None, Some(20_000)]);
        assert!(!r.partial.exists());
    }

    #[tokio::test]
    async fn a_reply_for_the_wrong_range_starts_over() {
        let body = test_body();
        let r = run(&body, vec![Plan::StallAfter(20_000), Plan::ShiftedRange, Plan::Serve], &sha_hex(&body), None).await;
        assert_eq!(r.result, Ok(()));
        assert_eq!(std::fs::read(&r.dest).unwrap(), body);
        assert_eq!(r.ranges, vec![None, Some(20_000), None], "the mismatched partial is dropped");
    }

    #[tokio::test]
    async fn repeated_failures_give_up_and_leave_nothing() {
        let body = test_body();
        let r = run(&body, vec![Plan::StallAfter(5_000)], &sha_hex(&body), None).await;
        let err = r.result.unwrap_err();
        assert!(err.contains("after 4 attempts"), "{err}");
        assert!(err.contains("stalled"), "{err}");
        assert_eq!(r.ranges, vec![None, Some(5_000), Some(10_000), Some(15_000)], "one try and three retries");
        assert!(!r.partial.exists(), "a partial that could be taken for a finished file");
        assert!(!r.dest.exists());
    }

    #[tokio::test]
    async fn a_resumed_file_with_the_wrong_hash_is_discarded() {
        let body = test_body();
        let r = run(&body, vec![Plan::StallAfter(20_000), Plan::CorruptRest], &sha_hex(&body), None).await;
        assert!(r.result.unwrap_err().contains("Checksum mismatch"));
        assert!(!r.partial.exists() && !r.dest.exists());
    }

    #[tokio::test]
    async fn too_large_and_http_errors_stop_at_once() {
        let body = test_body();
        let r = run(&body, vec![Plan::Serve], &sha_hex(&body), Some(10_000)).await;
        assert!(r.result.unwrap_err().contains("larger than the expected 10000 bytes"));
        assert_eq!(r.ranges.len(), 1, "not retried");
        assert!(!r.partial.exists() && !r.dest.exists());

        let r = run(&body, vec![Plan::Status(404)], &sha_hex(&body), None).await;
        assert!(r.result.unwrap_err().contains("HTTP 404"));
        assert_eq!(r.ranges.len(), 1, "not retried");
        assert!(!r.partial.exists() && !r.dest.exists());
    }

    #[test]
    fn content_range_is_parsed() {
        assert_eq!(parse_content_range("bytes 100-999/1000"), Some((100, Some(1000))));
        assert_eq!(parse_content_range("bytes 0-9/*"), Some((0, None)));
        assert_eq!(parse_content_range("items 0-9/10"), None);
        assert_eq!(parse_content_range("bytes */1000"), None);
    }

    #[tokio::test]
    async fn file_hash_matches_the_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f");
        std::fs::write(&path, b"abc").unwrap();
        assert_eq!(sha256_of_file(&path).await.unwrap(), sha_hex(b"abc"));
        assert!(sha256_of_file(&dir.path().join("missing")).await.is_ok(), "a missing file hashes as empty");
    }

    /// A real resume against the real host: the pinned whisper.cpp Windows
    /// zip (a few MB from GitHub). The first body is cut off after 256 KB as
    /// a broken stream would; the rest must arrive through a Range request
    /// and the whole file must match its pinned SHA-256. Run with
    /// `cargo test real_pinned_download_resumes -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn real_pinned_download_resumes() {
        use futures::StreamExt;
        let (url, sha256) = crate::whisper_local::smallest_pinned_download();
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("asset.zip");
        let partial = partial_path_for(&dest);
        let client = crate::whisper_local::download_client().unwrap();
        let offsets = Arc::new(Mutex::new(Vec::new()));
        let seen = offsets.clone();
        let cut = std::io::Error::new(std::io::ErrorKind::ConnectionReset, "cut off by the test");
        let cut = Arc::new(Mutex::new(Some(cut)));
        let fetch = |offset: u64| {
            let (client, seen, cut) = (client.clone(), seen.clone(), cut.clone());
            async move {
                let opened = open_url(&client, url, offset).await?;
                seen.lock().unwrap().push((offset, opened.start, opened.total));
                let body = opened.stream.map(|c| c.map(|b| b.as_ref().to_vec()).map_err(std::io::Error::other));
                // The first body only: 256 KB, then an error.
                let stream: futures::stream::BoxStream<'static, std::io::Result<Vec<u8>>> = match cut.lock().unwrap().take() {
                    Some(err) => {
                        let mut budget = 256 * 1024usize;
                        body.take_while(move |c| {
                            let more = budget > 0;
                            budget = budget.saturating_sub(c.as_ref().map(|b| b.len()).unwrap_or(0));
                            futures::future::ready(more)
                        })
                        .chain(futures::stream::once(async move { Err(err) }))
                        .boxed()
                    }
                    None => body.boxed(),
                };
                Ok(Opened { start: opened.start, total: opened.total, stream })
            }
        };
        let pin = Pinned { sha256, size: None, max_size: None };
        download_verified(fetch, &partial, &dest, &pin, IDLE_TIMEOUT, MAX_RETRIES, |_, _| {}).await.unwrap();
        let offsets = offsets.lock().unwrap().clone();
        eprintln!("requests (asked offset, body start, total): {offsets:?}");
        assert_eq!(offsets.len(), 2);
        assert!(offsets[1].0 >= 256 * 1024, "the second request continues: {offsets:?}");
        assert_eq!(offsets[1].1, offsets[1].0, "the host honoured the Range request");
        assert_eq!(sha256_of_file(&dest).await.unwrap(), sha256);
        assert_eq!(std::fs::metadata(&dest).unwrap().len(), offsets[0].2.unwrap());
        assert!(!partial.exists());
    }
}
