// performLookup — pure async helper for MetadataPanel's ASIN/ISBN lookup.
// Returns a result descriptor the component turns into toasts. Extracted so
// the error-detail formatting (URL + HTTP status + body preview — matches
// @kyleviloria's #53 ask) is unit-testable without mounting MetadataPanel.

const MAX_BODY_PREVIEW = 200;

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
          const match = products.find(p => p.title?.toLowerCase() === titleLower) || products[0];
          found = match.asin;
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
