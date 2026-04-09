# Audiobook Tagger

AI-powered metadata manager for [AudiobookShelf](https://www.audiobookshelf.org/). Connects to your ABS server and uses AI to enrich book metadata — genres, tags, descriptions, DNA fingerprints, and more. Supports cloud AI (OpenAI, Anthropic) and fully local AI via Ollama.

![Screenshot](docs/screenshot.png)

## Download

| Platform | Download |
|----------|----------|
| macOS (Apple Silicon) | [Audiobook.Tagger_aarch64.dmg](https://github.com/philipvox/audiobook-tagger-refactored/releases/latest/download/Audiobook.Tagger_2.0.0_aarch64.dmg) |
| macOS (Intel) | [Audiobook.Tagger_x64.dmg](https://github.com/philipvox/audiobook-tagger-refactored/releases/latest/download/Audiobook.Tagger_2.0.0_x64.dmg) |
| Windows (installer) | [Audiobook.Tagger_x64-setup.exe](https://github.com/philipvox/audiobook-tagger-refactored/releases/latest/download/Audiobook.Tagger_2.0.0_x64-setup.exe) |
| Windows (MSI) | [Audiobook.Tagger_x64.msi](https://github.com/philipvox/audiobook-tagger-refactored/releases/latest/download/Audiobook.Tagger_2.0.0_x64_en-US.msi) |
| Linux (Debian/Ubuntu) | [Audiobook.Tagger_amd64.deb](https://github.com/philipvox/audiobook-tagger-refactored/releases/latest/download/Audiobook.Tagger_2.0.0_amd64.deb) |
| Linux (AppImage) | [Audiobook.Tagger_amd64.AppImage](https://github.com/philipvox/audiobook-tagger-refactored/releases/latest/download/Audiobook.Tagger_2.0.0_amd64.AppImage) |
| Linux (RPM) | [Audiobook.Tagger_x86_64.rpm](https://github.com/philipvox/audiobook-tagger-refactored/releases/latest/download/Audiobook.Tagger-2.0.0-1.x86_64.rpm) |

[All releases](https://github.com/philipvox/audiobook-tagger-refactored/releases)

## Features

- **AI enrichment** — Auto-generate genres, tags, descriptions, DNA fingerprints, and resolve missing metadata (authors, narrators, series)
- **Three AI providers** — OpenAI (GPT-5 Nano), Anthropic Claude, or local AI via Ollama with no API keys needed
- **One-click local AI** — Install Ollama, download models, and run everything offline from within the app
- **ABS integration** — Import your full library and push enriched metadata back to your server
- **Local folder scanning** — Scan local audiobook folders (M4B, MP3) without needing an ABS server
- **Batch processing** — Process your entire library with progress bars and time estimates
- **Configurable concurrency** — Tune push workers for your server (NAS users: set to 1-2)
- **Genre normalization** — Clean up messy Audible-style genres into a consistent taxonomy

## Setup

### Connect to AudiobookShelf

1. Open Settings
2. Enter your ABS server URL (HTTP or HTTPS both work) and API token
3. Click "Connect & Detect Libraries"

### Local AI (Ollama)

1. Go to Settings > Local AI
2. Click "Install Ollama" or use an existing installation
3. Choose a model (Gemma 4 recommended: ~2.6 GB for the 4B model, ~8 GB for 12B)
4. All AI features work locally with no API keys

### Cloud AI

1. Go to Settings > AI Provider
2. Enter an OpenAI or Anthropic API key
3. Default model is GPT-5 Nano (fast, less than $0.01 per book)

API keys are stored locally on your machine and sent only to the AI provider.

## NAS Users

If your ABS server runs on a NAS and crashes during push operations, lower the ABS Push Workers setting in Settings > Performance. Default is 5. Set it to 1-2 for low-powered hardware.

## Building from Source

Requires [Node.js](https://nodejs.org/) 18+, [Rust](https://www.rust-lang.org/tools/install) stable, and [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
git clone https://github.com/philipvox/audiobook-tagger-refactored.git
cd audiobook-tagger-refactored
npm install
npm run tauri dev    # Development with hot reload
npm run tauri build  # Production build
```

## Web Version

A browser-based version is available at [github.com/philipvox/audiobook-tagger-web](https://github.com/philipvox/audiobook-tagger-web). Same ABS integration and cloud AI features without a desktop install. Does not support local AI or folder scanning.

## Contributing

1. Fork the repo and create a feature branch
2. Make changes, run `npm test` and `cd src-tauri && cargo test`
3. Open a PR with a clear description

## License

[MIT](LICENSE)
