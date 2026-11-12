# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.2.x   | Yes       |
| < 2.2   | No        |

Only the latest release receives security updates.

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

- **Email:** [philip@secretlibrary.org](mailto:philip@secretlibrary.org)
- **Subject line:** `[SECURITY] audiobook-tagger-v2 - brief description`
- **Response time:** You should receive an acknowledgment within 48 hours and a resolution timeline within 7 days.

**Please include:**

- A clear description of the vulnerability
- Steps to reproduce the issue
- The potential impact
- Any suggested fixes (if you have them)

Do **not** open a public GitHub issue for security vulnerabilities. Use the email above so the issue can be addressed before disclosure.

## Security Model

### API Keys and Tokens

- **Storage:** AI provider API keys (OpenAI, Anthropic) and the ABS server token are stored in the webview's `localStorage`, in plain text. They are not encrypted and not kept in the operating system keychain.
- **Transmission:** The ABS token goes only to your ABS server. An AI key goes only to the configured AI provider (see the host list below). Neither is sent to any other server, analytics service or third party.
- **ABS token and child processes:** The ABS token is never passed on a command line. When Check by Audio needs audio from your server, the Rust backend fetches it itself and hands the file to FFmpeg, so the token does not appear in the process list.
- **No account system:** The app has no user accounts, no cloud backend and no server-side component of its own.

### Ollama (Local AI)

- Ollama runs as a local process on your machine and the app talks to it on `localhost` (default `127.0.0.1:11434`). AI prompts sent to Ollama never leave your computer.
- The Rust backend manages the Ollama lifecycle (install, start, stop) as a child process. An Ollama you already run yourself is detected and is never stopped by the app.
- Ollama itself downloads models from its own registry (`registry.ollama.ai` and its CDN) when you pull one. That traffic comes from the Ollama process, not from the app.

### Network Requests

The app contacts only the hosts below. This list was built from the `https://` and `http://` URLs in `src/` and `src-tauri/src/`.

| Host | Why | When |
|------|-----|------|
| Your ABS server (any host and port you enter, HTTP or HTTPS) | Import the library, push changes, fetch audio for Check by Audio | Always, once you connect |
| `api.openai.com` | AI enrichment, and audio transcription and extraction for Check by Audio | When OpenAI is your provider or you use OpenAI Whisper |
| `api.anthropic.com` | AI enrichment | When Anthropic is your provider |
| A custom base URL | AI enrichment | Only if you set one in Settings |
| `localhost` / `127.0.0.1` | Ollama | When local AI is on |
| `api.audnex.us` | ASIN metadata lookups | When you run a lookup |
| `openlibrary.org` | ISBN and metadata lookups | When you run a lookup |
| `api.audible.com` | Audible catalog lookups (ASIN, age rating, ISBN) | When you run a lookup |
| `provider.vito0912.de` | Optional ABS metadata provider, only if you add it in the provider settings | Only if you enable it |
| `github.com` (release downloads redirect to `objects.githubusercontent.com`) | whisper.cpp release (Windows), the pinned Ollama release, and the FFmpeg mirror on Windows | When you install those components |
| `huggingface.co` | Whisper model files | When you download a Whisper model |
| `gyan.dev` | FFmpeg for Windows | When you install Whisper on Windows |
| `johnvansickle.com` | FFmpeg for Linux | When you install Whisper on Linux |
| Homebrew's hosts (`brew.sh`, ghcr.io and the formula sources it uses) | whisper-cpp and FFmpeg on macOS, whisper-cpp on Linux | When you install Whisper through Homebrew |
| `registry.ollama.ai` and its CDN | Model pulls, made by Ollama, not by the app | When you pull an Ollama model |

`ollama.com` and `api.github.com` appear in the source only in user-facing text and comments (install hints, a note about where release digests came from). The app does not contact them.

- **The HTTP scope allows any host.** The Tauri HTTP capability (`src-tauri/capabilities/default.json`) permits `https://**` and `http://**` because ABS servers and custom AI base URLs are chosen by the user and can be anywhere, including a private LAN address. The scope is therefore not a restriction. The list above is what the code actually contacts.
- **No default third-party proxy.** Earlier versions could fall back to a hosted proxy when a direct request failed. That default is gone. A proxy is used only if you build the web version with `VITE_PROXY_URL` set yourself.
- **Downloads are pinned and verified.** Executables the app downloads itself (whisper.cpp and FFmpeg on Windows, FFmpeg on Linux, Ollama on macOS and Linux, Whisper model files) are fixed to a specific version and checked against a SHA-256 hash stored in the source before they are used. Components installed through Homebrew are verified by Homebrew, not by the app. The Windows and Linux install paths were checked against the real release archives but have not been run on those platforms in this release.
- **No telemetry.** No analytics. No crash reporting. No phone-home behavior of any kind.

### Content Security Policy

The app enforces a CSP that restricts script sources to `'self'`, limits connections to `'self'`, HTTPS origins and `localhost`/`127.0.0.1`, and restricts image sources to `'self'`, data URIs, blob URIs and HTTPS. Requests to your ABS server and AI provider are made by Tauri's HTTP plugin and are governed by the capability scope described above.

## Known Limitations

### localStorage is not encrypted

API keys stored in `localStorage` are accessible to any code running within the WebView context. While Tauri's CSP and security model mitigate this significantly (no third-party scripts are loaded), the keys are stored in plaintext on disk. On shared machines, any user with filesystem access to the WebView storage directory could read them.

**Mitigation:** Use API keys with minimal permissions and rotate them if you suspect compromise. Consider using a dedicated API key for this app rather than sharing one with other services.

### CSP allows unsafe-inline for styles

The Content Security Policy includes `style-src 'self' 'unsafe-inline'` to support Tailwind CSS's inline style generation. This is a common trade-off for Tailwind-based applications and does not affect script execution (scripts are restricted to `'self'` only).

### Ollama runs as a local process

When using local AI, Ollama runs as an uncontained process on your machine. It binds to `localhost:11434` by default and is accessible to any local application. This is Ollama's standard operating mode and is not specific to this app.

### No code signing or notarization

Pre-built binaries are not notarized (macOS, where they are only ad-hoc signed) and not code-signed (Windows). Your operating system may show warnings when running the app for the first time. Each release carries `SHA256SUMS-<platform>.txt` files so you can check a download. You can also build from source.

## Auditing Dependencies

### Rust Dependencies

```bash
# Install cargo-audit if you don't have it
cargo install cargo-audit

# Run audit
cd src-tauri
cargo audit
```

### JavaScript Dependencies

```bash
# Built-in npm audit
npm audit

# For a more detailed report
npx audit-ci --config audit-ci.json
```

### Keeping Dependencies Updated

```bash
# Check for outdated JS packages
npm outdated

# Check for outdated Rust crates
cd src-tauri
cargo install cargo-outdated
cargo outdated
```

We recommend running dependency audits regularly and before each release.
