# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.0.x   | Yes       |
| < 2.0   | No        |

Only the latest release receives security updates.

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

- **Email:** [philip@secretlibrary.org](mailto:philip@secretlibrary.org)
- **Subject line:** `[SECURITY] audiobook-tagger-v2 — brief description`
- **Response time:** You should receive an acknowledgment within 48 hours and a resolution timeline within 7 days.

**Please include:**

- A clear description of the vulnerability
- Steps to reproduce the issue
- The potential impact
- Any suggested fixes (if you have them)

Do **not** open a public GitHub issue for security vulnerabilities. Use the email above so the issue can be addressed before disclosure.

## Security Model

### API Keys and Tokens

- **Storage:** All API keys (OpenAI, Anthropic) and ABS server tokens are stored exclusively in the browser's `localStorage` within the Tauri WebView.
- **Transmission:** Keys are sent only to their respective provider APIs (OpenAI, Anthropic, or your ABS server). They are never transmitted to any other server, analytics service, or third party.
- **No account system:** The app has no user accounts, no cloud backend, and no server-side component.

### Ollama (Local AI)

- Ollama runs as a local process on your machine, listening only on `localhost:11434`.
- AI prompts sent to Ollama never leave your computer.
- The Rust backend manages the Ollama lifecycle (install, start, stop) as a child process with proper cleanup.

### Network Requests

- All outbound HTTP requests are made through Tauri's HTTP plugin, which enforces scope restrictions defined in the app configuration.
- The app communicates only with: your configured ABS server, the selected AI provider API, and `localhost` (Ollama).
- **No telemetry.** No analytics. No crash reporting. No phone-home behavior of any kind.

### Content Security Policy

The app enforces a CSP that restricts script sources to `'self'`, limits connections to `'self'`, HTTPS origins, and localhost, and restricts image sources to `'self'`, data URIs, blob URIs, and HTTPS.

## Known Limitations

### localStorage is not encrypted

API keys stored in `localStorage` are accessible to any code running within the WebView context. While Tauri's CSP and security model mitigate this significantly (no third-party scripts are loaded), the keys are stored in plaintext on disk. On shared machines, any user with filesystem access to the WebView storage directory could read them.

**Mitigation:** Use API keys with minimal permissions and rotate them if you suspect compromise. Consider using a dedicated API key for this app rather than sharing one with other services.

### CSP allows unsafe-inline for styles

The Content Security Policy includes `style-src 'self' 'unsafe-inline'` to support Tailwind CSS's inline style generation. This is a common trade-off for Tailwind-based applications and does not affect script execution (scripts are restricted to `'self'` only).

### Ollama runs as a local process

When using local AI, Ollama runs as an uncontained process on your machine. It binds to `localhost:11434` by default and is accessible to any local application. This is Ollama's standard operating mode and is not specific to this app.

### No code signing

Pre-built binaries are not currently code-signed. Your operating system may show warnings when running the app for the first time. You can verify the build by compiling from source.

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
