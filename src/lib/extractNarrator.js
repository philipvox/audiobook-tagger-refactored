// extractNarrator - pull a narrator name out of a book description, or return
// null. It never guesses: a capture that is not clearly a person's name
// ("the author", "a full cast", "various") gives null, and the capture stops
// at connectors ("with", "featuring", "including") instead of running on.

const LEAD = /\b(?:read|narrated|voiced|performed)\s+by\s+/gi;
const NAME_WORD = /^[A-Z][A-Za-zÀ-ɏ'’-]*$/;
const INITIALS = /^(?:[A-Z]\.){1,3}$/;
const PARTICLE = /^(?:de|di|da|del|della|der|den|du|la|le|van|von|bin|ibn|al|el|ter|ten|dos|das|do)$/;
const NOT_NAME = new Set([
  'the', 'a', 'an', 'various', 'full', 'cast', 'ensemble', 'author', 'authors',
  'multiple', 'many', 'several', 'actors', 'artists', 'voice', 'narrator',
  'narrators', 'unknown', 'others', 'team', 'company', 'players',
]);
const MAX_NAME_WORDS = 4;

// Parse one name starting at tokens[i]. Returns { name, next, ended } or null.
function parseName(tokens, i) {
  const words = [];
  let ended = false;
  let j = i;
  for (; j < tokens.length; j++) {
    let tok = tokens[j];
    let stop = false;
    const trail = tok.match(/[,;:!?.]+$/);
    if (trail && !INITIALS.test(tok)) {
      tok = tok.slice(0, -trail[0].length);
      stop = true;
    }
    const isWord = NAME_WORD.test(tok) || INITIALS.test(tok);
    const isParticle = words.length > 0 && PARTICLE.test(tok) && !stop;
    if (!isWord && !isParticle) break;
    if (/['’]s$/.test(tok)) break;
    if (isWord && NOT_NAME.has(tok.toLowerCase())) {
      if (words.length === 0) return null;
      break;
    }
    words.push(tok);
    if (stop) { ended = true; j++; break; }
  }
  // A trailing particle means the name was cut off.
  while (words.length && PARTICLE.test(words[words.length - 1])) words.pop();
  if (words.length < 2 || words.length > MAX_NAME_WORDS) return null;
  if (!words.some((w) => NAME_WORD.test(w) && !INITIALS.test(w))) return null;
  return { name: words.join(' '), next: j, ended };
}

function fromCapture(rest) {
  const tokens = rest.trim().split(/\s+/).filter(Boolean).slice(0, 14);
  const first = parseName(tokens, 0);
  if (!first) return null;
  const names = [first.name];
  if (!first.ended && /^(?:and|&)$/.test(tokens[first.next] || '')) {
    const second = parseName(tokens, first.next + 1);
    if (second) names.push(second.name);
  }
  return names.join(', ');
}

export function extractNarrator(description) {
  if (typeof description !== 'string' || !description) return null;
  const text = description.replace(/<[^>]*>/g, ' ');
  for (const m of text.matchAll(LEAD)) {
    const found = fromCapture(text.slice(m.index + m[0].length));
    if (found) return found;
  }
  return null;
}
