# Narrator Detection via Local Whisper (GPU)

## Summary
Run Whisper `turbo` locally on the Windows machine's RTX 3090s to transcribe audiobook intros. Extract narrator/title/author from the spoken intro. Wire into book metadata with priority: **Whisper → Audible → other sources**.

The app will run natively on the Windows machine. Whisper is invoked via WSL (`wsl -e ...`).

## GPU Memory Management
- `turbo` uses ~2GB VRAM per process (vs 6GB for large-v3)
- Dual 3090s = 48GB total, plenty of headroom
- Subprocess isolation: each `whisper` invocation is a separate process — when it exits, CUDA memory is fully released. No accumulation.
- Sequential processing via semaphore to serialize Whisper calls
- `CUDA_VISIBLE_DEVICES` pins to one GPU. Default `0`.
- Timeout: kill subprocess if >60s (stuck/OOM)

## Files to Modify

| File | Change |
|------|--------|
| `src-tauri/src/scanner/types.rs` | Add `Whisper` variant to `MetadataSource` enum |
| `src-tauri/src/scanner/processor.rs` | Extract + apply narrator from transcription; priority over Audible |
| `src-tauri/src/whisper.rs` | Replace OpenAI API with local Whisper via WSL |
| `src-tauri/src/config.rs` | Add `whisper_gpu_device` config field |
| `src/pages/SettingsPage.jsx` | Add GPU device selector |

## Implementation Steps

### 1. Add `Whisper` to MetadataSource (`types.rs:133`)
Add after `CustomProvider`:
```rust
/// Extracted from audio transcription (Whisper)
Whisper,
```

### 2. Replace OpenAI Whisper API with local WSL execution (`whisper.rs`)

Replace `call_whisper_api()` with `call_whisper_local()`:
- Run via `wsl -e bash -c '...'` command
- Activate Python venv: `source ~/audiobook-env/bin/activate`
- Run: `CUDA_VISIBLE_DEVICES=0 whisper <file> --model turbo --output_format txt --language en --device cuda`
- Parse the `.txt` output file

FFmpeg extraction stays the same (extracts 90s to 16kHz mono MP3).

Flow:
```
1. FFmpeg: extract first 90s → temp mp3
2. wsl: CUDA_VISIBLE_DEVICES=0 whisper temp.mp3 --model turbo --output_format txt --language en --device cuda
3. Read output .txt
4. Parse with existing parse_book_info_from_transcript()
5. Subprocess exits → GPU memory freed automatically
```

### 3. Extract narrator from transcription (`processor.rs:~791`)
Change existing extraction to also capture narrator:
```rust
let (trans_title, trans_author, trans_narrator) = if let Some(ref t) = transcription {
    (
        t.extracted_title.clone().filter(|s| !s.is_empty()),
        t.extracted_author.clone().filter(|s| !s.is_empty()),
        t.extracted_narrator.clone().filter(|s| !s.is_empty()),
    )
} else {
    (None, None, None)
};
```

### 4. Apply Whisper narrator with priority over Audible (`processor.rs:~1679`)
Insert **before** the existing Audible narrator block:
```rust
if let Some(ref whisper_narrator) = trans_narrator {
    let cleaned = normalize::clean_narrator_name(whisper_narrator);
    metadata.narrators = vec![cleaned.clone()];
    metadata.narrator = Some(cleaned);
    sources.narrator = Some(MetadataSource::Whisper);
}
```

Guard the Audible block so it only runs as fallback:
```rust
if sources.narrator != Some(MetadataSource::Whisper) {
    // existing Audible narrator code...
}
```

### 5. Add config field (`config.rs`)
```rust
#[serde(default)]
pub whisper_gpu_device: Option<u8>,  // CUDA device index, default 0
```

### 6. Settings UI (`SettingsPage.jsx`)
Add number input for "Whisper GPU Device" (0 or 1).

### 7. Use shared client in whisper.rs
Replace `reqwest::Client::new()` with `crate::cache::shared_client()`.

## Performance Estimate
- turbo on RTX 3090: ~3s per 90s clip
- 2500 books × 3s = **~2 hours** for first full scan
- All results cached in sled (`transcription_{id}`), re-scans are instant
- ~2GB VRAM per invocation, well within 24GB per GPU

## Verification
1. `cargo check` — compiles cleanly
2. Build Windows exe, deploy to Windows machine
3. Run scan with `enable_transcription: true` on ~10 books
4. Verify narrator appears in metadata panel
5. Monitor GPU memory with `nvidia-smi` — should spike ~2GB and release per book
6. Re-scan same folder — should hit cache (no Whisper calls)
