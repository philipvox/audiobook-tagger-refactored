# M4B Conversion Testing Checklist

This checklist covers manual testing scenarios for the M4B conversion pipeline.
Run through these tests before releasing a new version.

## Prerequisites

- [ ] FFmpeg installed and available in PATH
- [ ] Run `cargo test converter::tests` - all tests should pass

## Quick Test Command

Run all converter tests:
```bash
cd src-tauri && cargo test converter::tests -- --nocapture
```

---

## Standard Pipeline Tests

### Basic Conversion (3-file audiobook)

- [ ] **Test:** Convert a folder with 3 MP3/M4A files
- [ ] **Expected:** Conversion succeeds, output plays correctly
- [ ] **Verify:**
  - Output file exists with .m4b extension
  - Duration matches sum of source files
  - All 3 chapters present and navigable
  - Metadata (title, author) present

### Large Conversion (50+ files)

- [ ] **Test:** Convert a folder with 50+ audio files
- [ ] **Expected:** Conversion succeeds with progress updates
- [ ] **Verify:**
  - Progress bar updates smoothly (no jumps)
  - All chapters created (one per file)
  - No timeout during conversion

### Cover Art Embedding

- [ ] **Test:** Convert folder containing `cover.jpg`
- [ ] **Expected:** Cover embedded in output
- [ ] **Verify:**
  - Cover displays in Apple Books/player
  - Cover displays in file info/Finder preview

### Metadata Preservation

- [ ] **Test:** Convert with full metadata (title, author, narrator, series, year)
- [ ] **Expected:** All metadata present in output
- [ ] **Verify:**
  - Title, artist tags correct
  - Narrator in composer field
  - Year/date correct
  - Description/comment present

---

## Quality Preset Tests

### Economy Preset (32k HE-AAC)

- [ ] **Test:** Convert with Economy preset
- [ ] **Expected:** Smallest file size, good quality
- [ ] **Verify:**
  - Output is ~14 MB/hour
  - Audio is clear for speech

### Standard Preset (64k AAC-LC)

- [ ] **Test:** Convert with Standard preset
- [ ] **Expected:** Balanced quality/size
- [ ] **Verify:**
  - Output is ~28 MB/hour
  - Audio quality excellent

### High Preset (96k AAC-LC)

- [ ] **Test:** Convert with High preset
- [ ] **Expected:** Largest file, pristine quality
- [ ] **Verify:**
  - Output is ~43 MB/hour
  - No perceptible quality loss

---

## Decode Pipeline Tests

### Corrupted Source Files

- [ ] **Test:** Convert files with known AAC corruption (frame errors)
- [ ] **Expected:** Conversion succeeds with warnings
- [ ] **Verify:**
  - Output is playable
  - Warning messages logged about frame errors
  - Duration is approximately correct

### Mixed Sample Rates

- [ ] **Test:** Convert folder with 44.1kHz and 48kHz files mixed
- [ ] **Expected:** Output normalized to 44.1kHz
- [ ] **Verify:**
  - No clicks/pops at file boundaries
  - Chapters align correctly

### Long Audiobook (40+ hours)

- [ ] **Test:** Convert a 40+ hour audiobook (100+ files)
- [ ] **Expected:** Completes without timeout
- [ ] **Verify:**
  - Progress accurate throughout
  - Temp files cleaned up
  - Duration correct

---

## Error Handling Tests

### Missing FFmpeg

- [ ] **Test:** Attempt conversion without FFmpeg installed
- [ ] **Expected:** Clear error message
- [ ] **Verify:**
  - Error says "FFmpeg not available"
  - Suggests installing FFmpeg

### Invalid Source Folder

- [ ] **Test:** Convert empty folder or non-existent path
- [ ] **Expected:** Clear error message
- [ ] **Verify:**
  - Error indicates no audio files found
  - No crash

### Disk Full Simulation

- [ ] **Test:** Attempt conversion with insufficient disk space
- [ ] **Expected:** Error before conversion starts
- [ ] **Verify:**
  - Error mentions disk space
  - No partial temp files left

### Cancel Mid-Conversion

- [ ] **Test:** Start conversion, then cancel
- [ ] **Expected:** Cancellation acknowledged
- [ ] **Verify:**
  - Temp files cleaned up
  - No partial output file
  - App remains responsive

---

## Progress UI Tests

### Progress Bar Smoothness

- [ ] **Test:** Watch progress during conversion
- [ ] **Expected:** Smooth progress updates
- [ ] **Verify:**
  - No jumps from 0% to 50%
  - Phase messages update correctly
  - ETA reasonably accurate

### Phase Transitions

- [ ] **Test:** Observe all phases during conversion
- [ ] **Expected:** Clear phase indicators
- [ ] **Phases to verify:**
  - [ ] Analyzing
  - [ ] Decoding (shown per file)
  - [ ] Encoding
  - [ ] Verifying
  - [ ] Complete

---

## Output Validation Tests

### Apple Books Playback

- [ ] **Test:** Open output in Apple Books
- [ ] **Expected:** Plays correctly
- [ ] **Verify:**
  - Chapters navigate correctly
  - Cover displays
  - Metadata shows in library

### Chapter Navigation

- [ ] **Test:** Skip between chapters
- [ ] **Expected:** Chapters aligned with content
- [ ] **Verify:**
  - Chapter boundaries are at correct timestamps
  - Chapter names display correctly

### Duration Accuracy

- [ ] **Test:** Compare input total duration to output
- [ ] **Expected:** Duration matches within 2 seconds
- [ ] **Verify:**
  - No audio missing
  - No extra silence at end

---

## Unicode/Special Characters Tests

### Unicode Filenames

- [ ] **Test:** Convert files with Japanese/Chinese/emoji in names
- [ ] **Expected:** Conversion succeeds
- [ ] **Verify:**
  - Chapter names preserve unicode
  - No path escaping issues

### Special Characters in Metadata

- [ ] **Test:** Title with colons, quotes, semicolons
- [ ] **Expected:** Metadata preserved correctly
- [ ] **Verify:**
  - Characters properly escaped in FFmpeg metadata
  - Display correctly in player

---

## Regression Tests

### Per-Input Flag Scoping (Bug Fix)

- [ ] **Test:** Convert with metadata file and cover
- [ ] **Expected:** No "Error parsing options" for metadata.txt
- [ ] **Verify:**
  - `-err_detect` only applies to audio input
  - `-f ffmetadata` correctly identifies metadata file

### Two-Step Decode Pipeline

- [ ] **Test:** Convert M4A files with minor corruption
- [ ] **Expected:** Uses decode-then-encode pipeline
- [ ] **Verify:**
  - WAV intermediates created in temp dir
  - Clean encode from WAVs
  - Temp files cleaned up

---

## Test Data Locations

If you have test audiobooks, note their locations here:

- Clean MP3s: `~/Audiobooks/Test/Clean/`
- Corrupted AAC: `~/Audiobooks/Test/Corrupted/`
- Long book: `~/Audiobooks/Test/LongBook/`
- Unicode names: `~/Audiobooks/Test/Unicode/`

---

## Sign-Off

| Date | Tester | Version | Result | Notes |
|------|--------|---------|--------|-------|
| | | | | |

---

## Automated Test Coverage

The following are covered by `cargo test converter::tests`:

- [x] FFmpeg builder input options ordering
- [x] Error tolerance flag skipping
- [x] Metadata format specification
- [x] Cover mapping indices
- [x] Quality preset configurations
- [x] Chapter generation from files
- [x] Chapter validation (gaps, overlap)
- [x] Disk space checking
- [x] Metadata escaping
- [x] Full conversion pipeline (basic)
- [x] Conversion with cover
- [x] Quality preset file sizes
- [x] Source analysis
