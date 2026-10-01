import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeR2, FakeD1, FakeGraph, makeEnv } from './fakes.js';
import { runAndReport } from '../src/index.js';
import { objectId } from '../src/names.js';

const R = 'DSCM-Backups';
const day = (iso, h = 10) => new Date(iso + 'T' + String(h).padStart(2, '0') + ':00:00Z');
const rows = n => Array.from({ length: n }, (_, i) => ({ path: 'data/doc' + i + '.json', content: '{"i":' + i + '}', version: 'v' + i, updated_at: '2026-09-01' }));

function setup(extraEnv = {}) {
  const graph = new FakeGraph(); graph.install();
  const r2 = new FakeR2();
  const db = new FakeD1(rows(1234));
  const env = makeEnv(Object.assign({ DB: db, FILES: r2 }, extraEnv));
  return { graph, r2, db, env };
}

test('first run backs up the database and every file, then writes a manifest', async () => {
  const { graph, r2, env } = setup();
  r2.put('parts/FN-2201/drawing.pdf', 'pdf-bytes');
  r2.put('pdir/Report: rev #3?.pdf', 'pdir-bytes');        // SharePoint-invalid characters
  r2.put('org_docs/NDA.pdf', new Uint8Array(25 * 1024 * 1024).fill(7)); // 25 MB -> chunked upload
  const run = await runAndReport(env, { trigger: 'manual', now: day('2026-10-01') });
  assert.equal(run.status, 'ok', JSON.stringify(run));

  const dump = graph.json(R + '/d1/dscm-db-2026-10-01.json');
  assert.equal(dump.tables[0].rowCount, 1234);            // paged in 500s
  assert.equal(dump.tables[0].rows[1233].path, 'data/doc1233.json');
  assert.equal(dump.schema.length, 2);

  const m = graph.json(R + '/r2/manifests/r2-manifest-2026-10-01.json');
  assert.equal(m.objectCount, 3);
  for (const o of m.objects) {
    const backed = graph.files.get(R + '/r2/objects/' + o.backupPath);
    assert.ok(backed, 'missing backup for ' + o.key);
    assert.deepEqual(Buffer.from(backed), Buffer.from(r2.objects.get(o.key).bytes), 'content mismatch for ' + o.key);
  }
  assert.equal(m.objects.find(o => o.key.startsWith('pdir/')).backupPath, 'pdir/Report_ rev #3_.pdf');
  assert.equal(graph.emails.length, 0);
});

test('later runs upload only new or changed files and never overwrite old copies', async () => {
  const { graph, r2, env } = setup();
  r2.put('a/one.pdf', 'v1');
  r2.put('a/two.pdf', 'two');
  await runAndReport(env, { trigger: 'scheduled', now: day('2026-10-01') });
  const callsBefore = graph.calls;

  r2.put('a/one.pdf', 'v2 - edited');   // overwritten in place in R2
  r2.put('a/three.pdf', 'three');       // new
  const run = await runAndReport(env, { trigger: 'scheduled', now: day('2026-10-02') });
  assert.equal(run.status, 'ok');
  assert.equal(run.files.newUploads, 2);
  assert.ok(graph.calls - callsBefore < 20, 'second run should be small');

  assert.equal(new TextDecoder().decode(graph.files.get(R + '/r2/objects/a/one.pdf')), 'v1'); // old copy intact
  const m2 = graph.json(R + '/r2/manifests/r2-manifest-2026-10-02.json');
  const one = m2.objects.find(o => o.key === 'a/one.pdf');
  assert.match(one.backupPath, /^a\/one~2026-10-02-[0-9a-f]{8}\.pdf$/);
  assert.equal(new TextDecoder().decode(graph.files.get(R + '/r2/objects/' + one.backupPath)), 'v2 - edited');
  // Yesterday's manifest still points at v1.
  const m1 = graph.json(R + '/r2/manifests/r2-manifest-2026-10-01.json');
  assert.equal(m1.objects.find(o => o.key === 'a/one.pdf').backupPath, 'a/one.pdf');
});

test('a run that hits its budget stops cleanly, alerts, and the next run finishes the job', async () => {
  const { graph, r2, env } = setup({ MAX_SUBREQUESTS: '60' });
  for (let i = 0; i < 80; i++) r2.put('bulk/file' + String(i).padStart(3, '0') + '.pdf', 'content ' + i);
  const first = await runAndReport(env, { trigger: 'scheduled', now: day('2026-10-01') });
  assert.equal(first.status, 'incomplete');
  assert.ok(first.files.remaining > 0 && first.files.newUploads > 0);
  assert.ok(!graph.has(R + '/r2/manifests/r2-manifest-2026-10-01.json'), 'no manifest for an incomplete run');
  assert.match(graph.emails.at(-1).subject, /incomplete/);

  let run, n = 0;
  do { run = await runAndReport(env, { trigger: 'manual', now: day('2026-10-01', 11) }); n++; } while (run.status === 'incomplete' && n < 10);
  assert.equal(run.status, 'ok');
  const m = graph.json(R + '/r2/manifests/r2-manifest-2026-10-01.json');
  assert.equal(m.objectCount, 80);
  const index = graph.json(R + '/state/r2-index.json');
  assert.equal(Object.keys(index.entries).length, 80);
});

test('failures email an alert with the step and error, and prune nothing', async () => {
  const { graph, r2, env } = setup();
  r2.put('a/one.pdf', 'x');
  await runAndReport(env, { trigger: 'scheduled', now: day('2026-10-01') });
  graph.tokenOk = false;
  const run = await runAndReport(env, { trigger: 'scheduled', now: day('2026-10-02') });
  assert.equal(run.status, 'failed');
  assert.match(run.error, /client secret/);
  const mail = graph.emails.at(-1);
  assert.match(mail.subject, /FAILED - 2026-10-02/);
  assert.match(mail.html, /Step: connecting to SharePoint/);
  assert.deepEqual(mail.to, ['me@example.com']);
  assert.ok(graph.has(R + '/r2/manifests/r2-manifest-2026-10-01.json'));
});

test('a mid-run upload error keeps progress already made', async () => {
  const { graph, r2, env } = setup();
  for (let i = 0; i < 30; i++) r2.put('f/' + i + '.pdf', 'c' + i);
  let puts = 0;
  graph.failNext = (url, init) => (init.method === 'PUT' && url.includes('/r2/objects/') && ++puts === 28)
    ? Response.json({ error: { message: 'boom' } }, { status: 400 }) : null;
  const run = await runAndReport(env, { trigger: 'scheduled', now: day('2026-10-01') });
  assert.equal(run.status, 'failed');
  graph.failNext = null;
  const index = graph.json(R + '/state/r2-index.json');
  assert.equal(Object.keys(index.entries).length, 27);
  const again = await runAndReport(env, { trigger: 'manual', now: day('2026-10-01', 12) });
  assert.equal(again.status, 'ok');
  assert.equal(again.files.newUploads, 3);
});

test('400 days of runs: retention keeps 14 daily + 8 weekly + 12 monthly, and files only while referenced', async () => {
  const { graph, r2, env } = setup();
  r2.put('keep/forever.pdf', 'always here');
  let d = new Date('2026-10-01T10:00:00Z');
  for (let i = 0; i < 400; i++) {
    const iso = d.toISOString().slice(0, 10);
    if (i === 5) r2.put('temp/short-lived.pdf', 'gone soon');
    if (i === 6) r2.objects.delete('temp/short-lived.pdf'); // deleted in R2 (e.g. by mistake)
    if (i % 3 === 0) r2.put('rolling/log.pdf', 'version ' + i); // changes every 3 days
    const run = await runAndReport(env, { trigger: 'scheduled', now: d });
    assert.equal(run.status, 'ok', iso + ' ' + JSON.stringify(run.error));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  const dumps = [...graph.files.keys()].filter(p => p.startsWith(R + '/d1/'));
  const manifests = [...graph.files.keys()].filter(p => p.startsWith(R + '/r2/manifests/'));
  assert.ok(dumps.length >= 20 && dumps.length <= 34, 'dumps kept: ' + dumps.length);
  assert.equal(dumps.length, manifests.length);
  const oldest = dumps.sort()[0].slice(-15, -5);
  // Last run is 2027-11-04; the 12 monthly slots are 2026-12 .. 2027-11.
  assert.equal(oldest, '2026-12-31', 'oldest dump ' + oldest);

  // Every file referenced by a kept manifest still exists; nothing else does.
  const referenced = new Set();
  for (const p of manifests) for (const o of graph.json(p).objects) referenced.add(R + '/r2/objects/' + o.backupPath);
  const stored = [...graph.files.keys()].filter(p => p.startsWith(R + '/r2/objects/'));
  for (const p of referenced) assert.ok(graph.has(p), 'referenced file missing: ' + p);
  for (const p of stored) assert.ok(referenced.has(p), 'unreferenced file kept: ' + p);
  assert.ok(!graph.has(R + '/r2/objects/temp/short-lived.pdf'), 'deleted file pruned after retention');
  const index = graph.json(R + '/state/r2-index.json');
  assert.equal(Object.keys(index.entries).length, stored.length);

  // Weekly summary went out on Mondays only.
  const summaries = graph.emails.filter(e => /weekly|backups OK/.test(e.subject));
  assert.ok(summaries.length >= 56 && summaries.length <= 58, 'summaries ' + summaries.length);
  assert.ok(graph.emails.every(e => /backups OK/.test(e.subject)), 'no failure emails expected');
});

test('a leftover from an interrupted upload (409 conflict) is cleared and retried', async () => {
  const { graph, r2, env } = setup();
  r2.put('big/deck.pptx', new Uint8Array(6 * 1024 * 1024).fill(3)); // upload-session path
  r2.put('small/note.pdf', 'note');                                 // simple PUT path
  graph.files.set(R + '/r2/objects/big/deck.pptx', new Uint8Array(10)); // half-finished leftover
  const conflicted = new Set();
  graph.failNext = (url, init) => {
    const target = url.includes('createUploadSession') ? 'big' : (url.includes('/small/') && init.method === 'PUT' ? 'small' : null);
    if (target && !conflicted.has(target)) {
      conflicted.add(target);
      return Response.json({ error: { message: 'The resource has changed since the caller last read it; usually an eTag mismatch' } }, { status: 409 });
    }
    return null;
  };
  const run = await runAndReport(env, { trigger: 'manual', now: day('2026-10-01') });
  assert.equal(run.status, 'ok', run.error);
  assert.equal(conflicted.size, 2);
  assert.equal(graph.files.get(R + '/r2/objects/big/deck.pptx').byteLength, 6 * 1024 * 1024);
});

test('only one run at a time: a live lock skips, a stale lock is taken over, and the lock is released', async () => {
  const { graph, r2, env } = setup();
  r2.put('a/one.pdf', 'x');
  const lockPath = R + '/state/run.lock';
  graph.files.set(lockPath, new TextEncoder().encode(JSON.stringify({ startedAt: new Date(Date.now() - 2 * 60000).toISOString() })));
  const skipped = await runAndReport(env, { trigger: 'scheduled', now: day('2026-10-01') });
  assert.equal(skipped.status, 'skipped');
  assert.match(graph.emails.at(-1).subject, /skipped/);
  assert.ok(!graph.has(R + '/d1/dscm-db-2026-10-01.json'), 'skipped run must not do any work');

  graph.files.set(lockPath, new TextEncoder().encode(JSON.stringify({ startedAt: new Date(Date.now() - 25 * 60000).toISOString() })));
  const ok = await runAndReport(env, { trigger: 'scheduled', now: day('2026-10-01') });
  assert.equal(ok.status, 'ok');
  assert.ok(!graph.has(lockPath), 'lock released after the run');

  // A failed run releases the lock too.
  graph.tokenOk = true;
  graph.failNext = (url, init) => url.includes('/d1/') && init.method === 'PUT' ? Response.json({ error: { message: 'boom' } }, { status: 400 }) : null;
  const failed = await runAndReport(env, { trigger: 'scheduled', now: day('2026-10-02') });
  assert.equal(failed.status, 'failed');
  assert.ok(!graph.has(lockPath), 'lock released after a failed run');
});

test('manual /run is token-protected', async () => {
  const { env } = setup({ BACKUP_TRIGGER_TOKEN: 'secret-token' });
  const worker = (await import('../src/index.js')).default;
  const ctx = { waitUntil() {} };
  const bad = await worker.fetch(new Request('https://x/run', { method: 'POST', headers: { Authorization: 'Bearer nope' } }), env, ctx);
  assert.equal(bad.status, 401);
  const none = await worker.fetch(new Request('https://x/run', { method: 'POST' }), Object.assign({}, env, { BACKUP_TRIGGER_TOKEN: '' }), ctx);
  assert.equal(none.status, 401);
  const badStatus = await worker.fetch(new Request('https://x/status'), env, ctx);
  assert.equal(badStatus.status, 401);
  const other = await worker.fetch(new Request('https://x/anything'), env, ctx);
  assert.equal(other.status, 404);
  const ok = await worker.fetch(new Request('https://x/run?summary=1', { method: 'POST', headers: { Authorization: 'Bearer secret-token' } }), env, ctx);
  assert.equal(ok.status, 200);
  const body = await ok.text();
  assert.match(body, /"status": "ok"/);
  const status = await worker.fetch(new Request('https://x/status', { headers: { Authorization: 'Bearer secret-token' } }), env, ctx);
  const s = await status.json();
  assert.equal(s.runs.at(-1).status, 'ok');
});
