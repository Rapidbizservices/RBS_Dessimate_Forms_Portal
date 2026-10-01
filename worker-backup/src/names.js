// Maps R2 object keys to SharePoint-safe paths. R2 keys can hold characters
// SharePoint rejects in file/folder names (e.g. ":" or "?" from a PDIR title),
// so each path segment is cleaned up here. The manifest always records the
// original key next to the backup path, so a restore never has to reverse this.

const INVALID_CHARS = /["*:<>?\\|\u0000-\u001f]/g;
const RESERVED_NAMES = /^(con|prn|aux|nul|com\d|lpt\d|desktop\.ini|\.lock)$/i;
const MAX_SEGMENT_LENGTH = 200;

export function sanitizeSegment(segment) {
  let s = String(segment).replace(INVALID_CHARS, '_');
  // No leading/trailing spaces, no trailing dots, no "~$" prefix, no "_vti_".
  s = s.replace(/^\s+/, m => '_'.repeat(m.length)).replace(/[\s.]+$/, m => '_'.repeat(m.length));
  if (s.startsWith('~$')) s = '_' + s.slice(1);
  s = s.replace(/_vti_/gi, '_vti-');
  if (!s) s = '_';
  if (RESERVED_NAMES.test(s)) s = '_' + s;
  if (s.length > MAX_SEGMENT_LENGTH) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : '';
    s = s.slice(0, MAX_SEGMENT_LENGTH - ext.length) + ext;
  }
  return s;
}

export function sanitizeKey(key) {
  return String(key).split('/').map(sanitizeSegment).join('/');
}

// Inserts a suffix before the last segment's extension:
// ("a/b/report.pdf", "~2") -> "a/b/report~2.pdf".
export function withSuffix(path, suffix) {
  const slash = path.lastIndexOf('/');
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  if (dot > 0) return path.slice(0, slash + 1) + name.slice(0, dot) + suffix + name.slice(dot);
  return path + suffix;
}

// The index's identity for one version of one object.
export function objectId(key, etag) {
  return key + '\n' + etag;
}

// Picks the backup path (relative to r2/objects/) for a not-yet-backed-up
// object version. The first version of a key gets the plain cleaned-up key;
// a later changed version, or a different key that cleans up to the same
// name, gets a dated suffix instead - so nothing is ever overwritten.
export function assignPath(index, key, etag, date) {
  const base = sanitizeKey(key);
  const id = objectId(key, etag);
  if (!index.paths[base] || index.paths[base] === id) return base;
  const dated = withSuffix(base, '~' + date + '-' + String(etag).replace(/[^A-Za-z0-9]/g, '').slice(0, 8));
  if (!index.paths[dated] || index.paths[dated] === id) return dated;
  for (let n = 2; ; n++) {
    const candidate = withSuffix(dated, '~' + n);
    if (!index.paths[candidate] || index.paths[candidate] === id) return candidate;
  }
}
