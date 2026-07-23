// performLookup — pure async helper for MetadataPanel's ASIN/ISBN lookup.
// Returns a result descriptor the component turns into toasts. Extracted so
// the error-detail formatting (URL + HTTP status + body preview — matches
// @kyleviloria's #53 ask) is unit-testable without mounting MetadataPanel.

const MAX_BODY_PREVIEW = 200;

// M5: candidate verification so a title/author mismatch doesn't yield a wrong
// ISBN/ASIN. Title uses a Levenshtein-lite check (normalized contains/startsWith
// either way); author requires a token overlap, but only when BOTH the book and
// the candidate carry author data (a candidate lacking authors is not rejected).
function normText(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function titleMatches(bookTitle, candTitle) {
  const x = normText(bookTitle);
  const y = normText(candTitle);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  if (x.startsWith(y) || y.startsWith(x)) return true;
  return false;
}

function authorTokens(author) {
  return new Set(
    String(author || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(t => t.length > 2)
  );
}

function authorOverlap(bookAuthor, candAuthors) {
  if (!bookAuthor) return true; // book has no author to check against
  const names = (Array.isArray(candAuthors) ? candAuthors : [candAuthors]).filter(Boolean);
  if (names.length === 0) return true; // candidate carries no author data
  const bookToks = authorTokens(bookAuthor);
  if (bookToks.size === 0) return true;
  return names.some(n => {
    const nameStr = typeof n === 'string' ? n : (n?.name || '');
    return nameStr
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .some(t => t.length > 2 && bookToks.has(t));
  });
}

function buildDetail({ message, status, url, bodyPreview }) {
  const parts = message ? [message] : [];
  if (status !== null && status !== undefined) parts.push(`Status: ${status}.`);
  if (url) parts.push(`URL: ${url}.`);
  if (bodyPreview) parts.push(`Body: ${bodyPreview}`);
  return parts.join(' ').trim();
}

export async function performLookup({ field, title, author, fetcher }) {
  if (!title) {
    return { kind: 'error', detail: 'No title to search for' };
  }

  let url = '';
  let status = null;
  let bodyPreview = '';

  try {
    let found = null;

    if (field === 'asin') {
      const titleParam = encodeURIComponent(title);
      const authorParam = encodeURIComponent(author || '');
      url = `https://api.audible.com/1.0/catalog/products?title=${titleParam}&author=${authorParam}&num_results=5&response_groups=product_desc`;
      const res = await fetcher(url);
      status = res.status;
      if (res.ok) {
        const raw = await res.text();
        bodyPreview = raw.slice(0, MAX_BODY_PREVIEW);
        const data = JSON.parse(raw); // throws on HTML fallback — caught below
        const products = data.products || [];
        if (products.length > 0) {
          const titleLower = title.toLowerCase();
          // Prefer an exact title hit; otherwise fall back to the first product
          // that VERIFIES (title + author), replacing the blind products[0].
          const verify = (p) => titleMatches(title, p.title) && authorOverlap(author, p.authors);
          const match =
            products.find(p => p.title?.toLowerCase() === titleLower && authorOverlap(author, p.authors)) ||
            products.find(verify);
          if (match) found = match.asin;
        }
      } else {
        bodyPreview = (await res.text().catch(() => '')).slice(0, MAX_BODY_PREVIEW);
      }
    } else {
      const query = encodeURIComponent(`${title} ${author || ''}`);
      url = `https://openlibrary.org/search.json?q=${query}&limit=5&fields=isbn,title,author_name`;
      const res = await fetcher(url);
      status = res.status;
      if (res.ok) {
        const raw = await res.text();
        bodyPreview = raw.slice(0, MAX_BODY_PREVIEW);
        const data = JSON.parse(raw);
        for (const doc of (data.docs || [])) {
          if (!doc.isbn || doc.isbn.length === 0) continue;
          // M5: only take an ISBN from a doc whose title matches and (when the
          // book has an author) whose author_name overlaps.
          if (!titleMatches(title, doc.title)) continue;
          if (!authorOverlap(author, doc.author_name)) continue;
          found = doc.isbn.find(i => i.length === 13) || doc.isbn[0];
          if (found) break;
        }
      } else {
        bodyPreview = (await res.text().catch(() => '')).slice(0, MAX_BODY_PREVIEW);
      }
    }

    if (found) return { kind: 'found', value: found, url, status };
    if (status && status >= 400) {
      return { kind: 'error', detail: buildDetail({
        message: `HTTP ${status} from the lookup endpoint.`,
        status, url, bodyPreview: bodyPreview || '(empty)',
      }) };
    }
    return { kind: 'not-found', url, status };
  } catch (err) {
    return { kind: 'error', detail: buildDetail({
      message: err?.message || String(err), status, url, bodyPreview,
    }) };
  }
}
