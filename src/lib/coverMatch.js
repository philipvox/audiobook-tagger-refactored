// coverMatch — pure title<->image matching for BulkCoverAssignment.
//
// H4: exact normalized equality scores 1.0; a substring containment only earns
// the 0.9 credit when the shorter string is >= 80% the length of the longer
// (so "harrypotter" vs "harrypotter2" no longer scores 0.9). Assignment scores
// every eligible book/image pair and assigns greedily by descending score,
// rather than committing in book order.

function normalize(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Extract a probable title from an image filename.
export function extractTitleFromFilename(filename) {
  let name = String(filename || '').replace(/\.(jpg|jpeg|png|webp|gif)$/i, '');
  name = name.replace(/_cover$/i, '');
  name = name.replace(/-cover$/i, '');
  name = name.replace(/_artwork$/i, '');
  name = name.replace(/[_-]/g, ' ');
  return name.trim();
}

export function stringSimilarity(str1, str2) {
  const s1 = normalize(str1);
  const s2 = normalize(str2);

  if (s1 === s2) return s1.length === 0 ? 0 : 1;
  if (s1.length === 0 || s2.length === 0) return 0;

  // H4: substring containment only counts when the strings are close in length.
  if (s1.includes(s2) || s2.includes(s1)) {
    const shorter = Math.min(s1.length, s2.length);
    const longer = Math.max(s1.length, s2.length);
    if (shorter / longer >= 0.8) return 0.9;
    // Otherwise fall through to Levenshtein, which will score the length gap.
  }

  // Levenshtein distance ratio.
  const matrix = Array(s2.length + 1).fill(null).map(() => Array(s1.length + 1).fill(null));
  for (let i = 0; i <= s1.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= s2.length; j++) matrix[j][0] = j;

  for (let j = 1; j <= s2.length; j++) {
    for (let i = 1; i <= s1.length; i++) {
      const indicator = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + indicator
      );
    }
  }

  const maxLen = Math.max(s1.length, s2.length);
  return 1 - matrix[s2.length][s1.length] / maxLen;
}

// Assign images to books greedily by best score, preserving `existing`
// assignments (H5). `books` is [{ id, title }]; `images` is [{ name }];
// `existing` is a { [bookId]: { imageIndex, score, manual? } } map to keep.
// Returns a new assignments map.
export function assignCovers({ books = [], images = [], existing = {}, threshold = 0.3 }) {
  const assignments = { ...existing };
  const usedImages = new Set(Object.values(assignments).map(a => a.imageIndex));
  const assignedBooks = new Set(Object.keys(assignments));

  const pairs = [];
  for (const book of books) {
    if (assignedBooks.has(String(book.id))) continue;
    images.forEach((img, imageIndex) => {
      if (usedImages.has(imageIndex)) return;
      const score = stringSimilarity(book.title || '', extractTitleFromFilename(img.name || ''));
      if (score > threshold) {
        pairs.push({ bookId: book.id, imageIndex, score });
      }
    });
  }

  pairs.sort((a, b) => b.score - a.score);

  for (const p of pairs) {
    if (assignedBooks.has(String(p.bookId)) || usedImages.has(p.imageIndex)) continue;
    assignments[p.bookId] = { imageIndex: p.imageIndex, score: p.score };
    assignedBooks.add(String(p.bookId));
    usedImages.add(p.imageIndex);
  }

  return assignments;
}
