import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeKey, sanitizeSegment, withSuffix, assignPath, objectId } from '../src/names.js';
import { selectRetained, isoWeek, dateFromName } from '../src/retention.js';

test('sanitizeSegment strips characters SharePoint rejects', () => {
  assert.equal(sanitizeSegment('PDIR: rev #3?.pdf'), 'PDIR_ rev #3_.pdf');
  assert.equal(sanitizeSegment(' lead'), '_lead');
  assert.equal(sanitizeSegment('trail. '), 'trail__');
  assert.equal(sanitizeSegment('~$lock.docx'), '_$lock.docx');
  assert.equal(sanitizeSegment('CON'), '_CON');
  assert.equal(sanitizeSegment(''), '_');
  const long = sanitizeSegment('x'.repeat(300) + '.pdf');
  assert.ok(long.length <= 200 && long.endsWith('.pdf'));
});

test('sanitizeKey keeps folder structure', () => {
  assert.equal(sanitizeKey('parts/FN-2201/draw|ing.pdf'), 'parts/FN-2201/draw_ing.pdf');
  assert.equal(sanitizeKey('a//b'), 'a/_/b');
});

test('withSuffix goes before the extension', () => {
  assert.equal(withSuffix('a/b/report.pdf', '~2'), 'a/b/report~2.pdf');
  assert.equal(withSuffix('a/b/README', '~2'), 'a/b/README~2');
  assert.equal(withSuffix('a.b/c', '~2'), 'a.b/c~2');
});

test('assignPath never reuses a path for different content', () => {
  const index = { entries: {}, paths: {} };
  const p1 = assignPath(index, 'docs/a.pdf', 'e1', '2026-10-01');
  assert.equal(p1, 'docs/a.pdf');
  index.paths[p1] = objectId('docs/a.pdf', 'e1');
  assert.equal(assignPath(index, 'docs/a.pdf', 'e1', '2026-10-01'), 'docs/a.pdf'); // same version -> same path (idempotent)
  const p2 = assignPath(index, 'docs/a.pdf', 'e2abcdef99', '2026-10-02');
  assert.equal(p2, 'docs/a~2026-10-02-e2abcdef.pdf');
  index.paths[p2] = objectId('docs/a.pdf', 'e2abcdef99');
  // A different key that cleans up to the same name also gets its own path.
  const p3 = assignPath(index, 'docs/a?.pdf'.replace('?', ''), 'zz', '2026-10-02');
  assert.notEqual(p3, p1);
});

test('isoWeek matches ISO-8601', () => {
  assert.equal(isoWeek('2026-01-01'), '2026-W01');
  assert.equal(isoWeek('2027-01-01'), '2026-W53');
  assert.equal(isoWeek('2026-09-28'), '2026-W40');
  assert.equal(isoWeek('2026-10-04'), '2026-W40');
});

test('selectRetained keeps 14 daily + 8 weekly + 12 monthly', () => {
  const dates = [];
  for (let d = new Date('2025-01-01T00:00:00Z'); d <= new Date('2026-09-30T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) dates.push(d.toISOString().slice(0, 10));
  const keep = selectRetained(dates);
  const sorted = [...keep].sort();
  // The 14 newest days are all kept.
  for (let i = 0; i < 14; i++) assert.ok(keep.has(dates[dates.length - 1 - i]));
  // Nothing older than 12 months back is kept.
  assert.ok(sorted[0] >= '2025-10-01', 'oldest kept ' + sorted[0]);
  // Each of the last 12 months has its newest day kept.
  for (const m of ['2025-10-31', '2025-11-30', '2025-12-31', '2026-01-31', '2026-08-31']) assert.ok(keep.has(m), m);
  assert.ok(keep.size <= 14 + 8 + 12 && keep.size >= 20, 'kept ' + keep.size);
});

test('selectRetained with few backups keeps them all', () => {
  const keep = selectRetained(['2026-09-28', '2026-09-29', '2026-09-30']);
  assert.equal(keep.size, 3);
});

test('dateFromName only matches our own dated files', () => {
  assert.equal(dateFromName('dscm-db-2026-09-30.json', 'dscm-db-', '.json'), '2026-09-30');
  assert.equal(dateFromName('dscm-db-2026-09-30.json.bak', 'dscm-db-', '.json'), null);
  assert.equal(dateFromName('notes.txt', 'dscm-db-', '.json'), null);
});
