// dscm-backup - nightly backup of DSCM production data to SharePoint.
//
// Each run:
//   1. Database: dumps every table of D1 dscm-db (schema + all rows) to
//      <folder>/d1/dscm-db-YYYY-MM-DD.json.
//   2. Files: incremental copy of R2 dscm-files. Every object version is
//      uploaded once to <folder>/r2/objects/<key>; a later changed version is
//      saved alongside under a dated name, never over the old one.
//      <folder>/state/r2-index.json remembers what's already uploaded, and a
//      dated <folder>/r2/manifests/r2-manifest-YYYY-MM-DD.json lists exactly
//      which files existed that day and where each one's backup copy is.
//   3. Pruning (only after a complete run): keeps 14 daily + 8 weekly + 12
//      monthly dumps/manifests; a backed-up file is deleted only once no kept
//      manifest references it and it's no longer in R2.
//   4. Appends to <folder>/state/run-log.json, emails an alert on failure or
//      an incomplete run, and sends a weekly summary on Mondays.
//
// See README.md for setup and restore instructions.

import { Budget, BudgetExceeded, Graph, SIMPLE_UPLOAD_MAX, CHUNK_SIZE } from './graph.js';
import { assignPath, objectId } from './names.js';
import { selectRetained, dateFromName, DEFAULT_RETENTION } from './retention.js';

const DEFAULT_MAX_SUBREQUESTS = 900;       // stays under the per-invocation subrequest cap
const TIME_BUDGET_MS = 12 * 60 * 1000;     // cron invocations get up to 15 minutes
const RESERVE_CALLS = 15;                  // held back for saving the index, run log and emails
const INDEX_SAVE_EVERY = 25;               // save progress every N uploaded files
const D1_PAGE_SIZE = 500;
const RUN_LOG_KEEP = 120;
const LOCK_STALE_MS = 20 * 60 * 1000;      // longer than any run can last (15 min cron cap)

class ObjectChanged extends Error {}

export default {
  async scheduled(event, env, ctx) {
    await runAndReport(env, { trigger: 'scheduled' });
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isRun = url.pathname === '/run' && request.method === 'POST';
    const isStatus = url.pathname === '/status' && request.method === 'GET';
    if (!isRun && !isStatus) return new Response('Not found', { status: 404 });

    const auth = request.headers.get('Authorization') || '';
    const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!env.BACKUP_TRIGGER_TOKEN || !constantTimeEqual(supplied, env.BACKUP_TRIGGER_TOKEN)) {
      return json({ message: 'Unauthorized.' }, 401);
    }

    if (isStatus) {
      // Last few runs from SharePoint's run log - lets someone without the
      // Graph secret check what actually landed.
      const graph = new Graph(env, new Budget(10, Date.now() + 60000));
      const root = (env.BACKUP_FOLDER || 'DSCM-Backups').replace(/^\/+|\/+$/g, '');
      try {
        const log = await graph.getJson(root + '/state/run-log.json');
        const index = await graph.getJson(root + '/state/r2-index.json');
        return json({
          runs: log ? log.runs.slice(-Number(url.searchParams.get('n') || 5)) : [],
          indexedFileVersions: index ? Object.keys(index.entries).length : 0
        });
      } catch (err) {
        return json({ message: (err && err.message) || String(err) }, 500);
      }
    }

    // A full run can take minutes; stream a heartbeat line every 10 seconds
    // so no proxy or client drops the connection as idle, then the result.
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    const work = (async () => {
      const started = Date.now();
      const beat = setInterval(() => { writer.write(enc.encode('running... ' + Math.round((Date.now() - started) / 1000) + 's\n')).catch(() => {}); }, 10000);
      try {
        const run = await runAndReport(env, { trigger: 'manual', forceSummary: url.searchParams.get('summary') === '1' });
        await writer.write(enc.encode(JSON.stringify(run, null, 2) + '\n'));
      } catch (err) {
        await writer.write(enc.encode(JSON.stringify({ status: 'failed', error: (err && err.message) || String(err) }) + '\n')).catch(() => {});
      } finally {
        clearInterval(beat);
        await writer.close().catch(() => {});
      }
    })();
    ctx.waitUntil(work);
    return new Response(readable, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
};

export async function runAndReport(env, { trigger, forceSummary = false, now = new Date() }) {
  const date = now.toISOString().slice(0, 10);
  const budget = new Budget(Number(env.MAX_SUBREQUESTS) || DEFAULT_MAX_SUBREQUESTS, Date.now() + TIME_BUDGET_MS);
  const graph = new Graph(env, budget);
  const root = (env.BACKUP_FOLDER || 'DSCM-Backups').replace(/^\/+|\/+$/g, '');
  const run = { date, trigger, startedAt: now.toISOString(), status: 'running', step: 'starting' };

  // Only one run at a time: two overlapping runs would fight over the index
  // and run log. A run that died without releasing the lock stops blocking
  // others after LOCK_STALE_MS.
  const lockPath = root + '/state/run.lock';
  let haveLock = false;
  try {
    const lock = { startedAt: run.startedAt, trigger };
    haveLock = await graph.createJsonIfAbsent(lockPath, lock);
    if (!haveLock) {
      const existing = await graph.getJson(lockPath).catch(() => null);
      const age = existing && existing.startedAt ? Date.now() - Date.parse(existing.startedAt) : Infinity;
      if (age < LOCK_STALE_MS) {
        run.status = 'skipped';
        run.error = 'Another backup run has been in progress since ' + existing.startedAt + '.';
        if (trigger === 'scheduled') {
          await sendEmail(env, 'DSCM backup skipped - ' + date, '<p>The scheduled backup for ' + esc(date) + ' was skipped: ' + esc(run.error) +
            ' If no run is actually in progress, the lock clears itself after 20 minutes and tomorrow\'s run proceeds normally.</p>').catch(() => {});
        }
        return run;
      }
      await graph.putJson(lockPath, lock); // take over a stale lock
      haveLock = true;
    }
  } catch (err) {
    run.status = 'failed';
    run.step = 'connecting to SharePoint';
    run.error = (err && err.message) || String(err);
    await sendEmail(env, 'DSCM backup FAILED - ' + date, failureHtml(run)).catch(e => { run.emailError = e.message; });
    return run;
  }

  try {
    run.step = 'database';
    run.database = await backupDatabase(env, graph, budget, root, date);
    run.step = 'files';
    const files = await backupFiles(env, graph, budget, root, date);
    run.files = files.summary;
    if (files.summary.complete) {
      run.step = 'pruning';
      run.pruning = await prune(graph, budget, root, files);
      run.status = 'ok';
    } else {
      run.status = 'incomplete';
    }
    run.step = 'done';
  } catch (err) {
    run.status = 'failed';
    run.error = (err && err.message) || String(err);
    console.error('Backup failed during ' + run.step, err);
  }
  run.finishedAt = new Date().toISOString();
  run.subrequests = budget.used;

  // Bookkeeping gets a small allowance of its own, so even a run that used up
  // its budget can still record itself and send the alert.
  budget.max = budget.used + RESERVE_CALLS;
  budget.deadline = Date.now() + 60 * 1000;
  let runLog = null;
  try {
    runLog = await appendRunLog(graph, root, run);
  } catch (err) {
    run.runLogError = (err && err.message) || String(err);
  }

  try {
    if (run.status === 'failed') {
      await sendEmail(env, 'DSCM backup FAILED - ' + date, failureHtml(run));
    } else if (run.status === 'incomplete') {
      await sendEmail(env, 'DSCM backup incomplete - ' + date, incompleteHtml(run));
    }
    const isMonday = now.getUTCDay() === 1;
    if (forceSummary || (trigger === 'scheduled' && isMonday)) {
      const recent = (runLog ? runLog.runs : [run]).filter(r => r.startedAt >= new Date(now - 7 * 86400000).toISOString());
      const problems = recent.filter(r => r.status !== 'ok').length;
      await sendEmail(env, problems ? 'DSCM weekly backup summary - ' + problems + ' problem run(s)' : 'DSCM backups OK - week ending ' + date, summaryHtml(recent, run));
    }
  } catch (err) {
    run.emailError = (err && err.message) || String(err);
    console.error('Could not send backup email', err);
  }
  if (haveLock) {
    budget.max = Math.max(budget.max, budget.used + 3);
    await graph.deletePath(lockPath).catch(err => { run.lockReleaseError = (err && err.message) || String(err); });
  }
  return run;
}

// ---- 1. Database ------------------------------------------------------------

async function backupDatabase(env, graph, budget, root, date) {
  budget.take(1);
  const schema = (await env.DB.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' " +
    "ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name"
  ).all()).results;

  const tables = [];
  for (const entry of schema.filter(s => s.type === 'table')) {
    const quoted = '"' + entry.name.replace(/"/g, '""') + '"';
    const rows = [];
    for (let offset = 0; ; offset += D1_PAGE_SIZE) {
      budget.take(1);
      const page = (await env.DB.prepare('SELECT * FROM ' + quoted + ' ORDER BY rowid LIMIT ? OFFSET ?').bind(D1_PAGE_SIZE, offset).all()).results;
      rows.push(...page);
      if (page.length < D1_PAGE_SIZE) break;
    }
    tables.push({ name: entry.name, rowCount: rows.length, rows });
  }

  const dump = {
    format: 'dscm-d1-backup',
    formatVersion: 1,
    database: 'dscm-db',
    createdAt: new Date().toISOString(),
    schema: schema.map(s => ({ type: s.type, name: s.name, table: s.tbl_name, sql: s.sql })),
    tables
  };
  const bytes = new TextEncoder().encode(JSON.stringify(dump));
  const path = root + '/d1/dscm-db-' + date + '.json';
  await graph.putBytes(path, bytes, 'application/json');
  return { path, bytes: bytes.byteLength, tables: tables.map(t => ({ name: t.name, rows: t.rowCount })) };
}

// ---- 2. Files ---------------------------------------------------------------

async function listAllObjects(env, budget) {
  const objects = [];
  let cursor;
  do {
    budget.take(1);
    const page = await env.FILES.list({ cursor, limit: 1000 });
    for (const o of page.objects) {
      objects.push({ key: o.key, size: o.size, etag: o.etag, uploaded: o.uploaded instanceof Date ? o.uploaded.toISOString() : String(o.uploaded) });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

async function uploadObject(env, graph, budget, o, path) {
  if (o.size <= SIMPLE_UPLOAD_MAX) {
    budget.take(1);
    const obj = await env.FILES.get(o.key);
    if (!obj || obj.etag !== o.etag) throw new ObjectChanged(o.key);
    const bytes = new Uint8Array(await obj.arrayBuffer());
    await graph.putBytes(path, bytes, (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream');
    return;
  }
  await graph.uploadSession(path, o.size, async (offset, length) => {
    budget.take(1);
    const obj = await env.FILES.get(o.key, { range: { offset, length }, onlyIf: { etagMatches: o.etag } });
    if (!obj || !('body' in obj) || !obj.body) throw new ObjectChanged(o.key);
    return new Uint8Array(await obj.arrayBuffer());
  });
}

async function backupFiles(env, graph, budget, root, date) {
  const indexPath = root + '/state/r2-index.json';
  const index = (await graph.getJson(indexPath)) || { format: 'dscm-r2-index', formatVersion: 1, entries: {}, paths: {} };
  const objects = await listAllObjects(env, budget);
  const pending = objects.filter(o => !index.entries[objectId(o.key, o.etag)]);

  let uploaded = 0, uploadedBytes = 0, sinceSave = 0, stoppedForBudget = false;
  const changedDuringRun = [];
  try {
    for (const o of pending) {
      const calls = o.size <= SIMPLE_UPLOAD_MAX ? 2 : 1 + 2 * Math.ceil(o.size / CHUNK_SIZE);
      if (!budget.canAfford(calls + RESERVE_CALLS)) { stoppedForBudget = true; break; }
      const id = objectId(o.key, o.etag);
      const rel = assignPath(index, o.key, o.etag, date);
      try {
        await uploadObject(env, graph, budget, o, root + '/r2/objects/' + rel);
      } catch (err) {
        if (err instanceof ObjectChanged) { changedDuringRun.push(o.key); continue; }
        throw err;
      }
      index.entries[id] = { path: rel, size: o.size, backedUpAt: date };
      index.paths[rel] = id;
      uploaded++;
      uploadedBytes += o.size;
      if (++sinceSave >= INDEX_SAVE_EVERY) { await graph.putJson(indexPath, index); sinceSave = 0; }
    }
  } catch (err) {
    if (!(err instanceof BudgetExceeded)) {
      // Keep whatever did upload, so the next run doesn't redo it.
      if (sinceSave) await graph.putJson(indexPath, index).catch(() => {});
      throw err;
    }
    stoppedForBudget = true;
  }
  if (sinceSave) await graph.putJson(indexPath, index);

  const missing = objects.filter(o => !index.entries[objectId(o.key, o.etag)]);
  const summary = {
    complete: missing.length === 0,
    objectCount: objects.length,
    totalBytes: objects.reduce((sum, o) => sum + o.size, 0),
    newUploads: uploaded,
    uploadedBytes,
    remaining: missing.length,
    stoppedForBudget,
    changedDuringRun
  };

  if (summary.complete) {
    const manifest = {
      format: 'dscm-r2-manifest',
      formatVersion: 1,
      bucket: 'dscm-files',
      date,
      createdAt: new Date().toISOString(),
      objectsFolder: root + '/r2/objects',
      objectCount: summary.objectCount,
      totalBytes: summary.totalBytes,
      objects: objects.map(o => ({ key: o.key, size: o.size, etag: o.etag, uploaded: o.uploaded, backupPath: index.entries[objectId(o.key, o.etag)].path }))
    };
    summary.manifestPath = root + '/r2/manifests/r2-manifest-' + date + '.json';
    await graph.putJson(summary.manifestPath, manifest);
  }
  return { summary, index, indexPath, currentIds: new Set(objects.map(o => objectId(o.key, o.etag))) };
}

// ---- 3. Pruning -------------------------------------------------------------

async function prune(graph, budget, root, files) {
  const result = { dumpsDeleted: 0, manifestsDeleted: 0, objectsDeleted: 0, partial: false, skippedObjects: false };
  const canContinue = () => budget.canAfford(1 + RESERVE_CALLS);
  try {
    // Dated database dumps.
    const dumps = (await graph.listChildren(root + '/d1'))
      .map(item => ({ item, date: dateFromName(item.name, 'dscm-db-', '.json') })).filter(x => x.date);
    const keepDumps = selectRetained(dumps.map(x => x.date), DEFAULT_RETENTION);
    for (const x of dumps.filter(x => !keepDumps.has(x.date))) {
      if (!canContinue()) { result.partial = true; return result; }
      await graph.deletePath(root + '/d1/' + x.item.name);
      result.dumpsDeleted++;
    }

    // Dated manifests - first collect everything the kept ones still need.
    const manifests = (await graph.listChildren(root + '/r2/manifests'))
      .map(item => ({ item, date: dateFromName(item.name, 'r2-manifest-', '.json') })).filter(x => x.date);
    const keepManifests = selectRetained(manifests.map(x => x.date), DEFAULT_RETENTION);
    const needed = new Set(files.currentIds);
    for (const x of manifests.filter(x => keepManifests.has(x.date))) {
      if (!canContinue()) { result.partial = true; return result; }
      const m = await graph.getJson(root + '/r2/manifests/' + x.item.name);
      // A kept manifest we can't read means we can't be sure what's still
      // needed - skip deleting any backed-up files this run rather than guess.
      if (!m || !Array.isArray(m.objects)) { result.skippedObjects = true; break; }
      for (const o of m.objects) needed.add(objectId(o.key, o.etag));
    }
    for (const x of manifests.filter(x => !keepManifests.has(x.date))) {
      if (!canContinue()) { result.partial = true; return result; }
      await graph.deletePath(root + '/r2/manifests/' + x.item.name);
      result.manifestsDeleted++;
    }

    if (!result.skippedObjects) {
      for (const [id, entry] of Object.entries(files.index.entries)) {
        if (needed.has(id)) continue;
        if (!canContinue()) { result.partial = true; break; }
        await graph.deletePath(root + '/r2/objects/' + entry.path);
        delete files.index.entries[id];
        if (files.index.paths[entry.path] === id) delete files.index.paths[entry.path];
        result.objectsDeleted++;
      }
    }
  } catch (err) {
    if (!(err instanceof BudgetExceeded)) throw err;
    result.partial = true;
  } finally {
    if (result.objectsDeleted) await graph.putJson(files.indexPath, files.index);
  }
  return result;
}

// ---- 4. Run log + email -----------------------------------------------------

async function appendRunLog(graph, root, run) {
  const path = root + '/state/run-log.json';
  const log = (await graph.getJson(path)) || { format: 'dscm-backup-run-log', runs: [] };
  log.runs.push(run);
  log.runs = log.runs.slice(-RUN_LOG_KEEP);
  await graph.putJson(path, log);
  return log;
}

async function sendEmail(env, subject, html) {
  if (!env.RESEND_API_KEY || !env.ALERT_EMAIL) throw new Error('RESEND_API_KEY or ALERT_EMAIL secret is not set.');
  const res = await fetch(env.RESEND_API_BASE || 'https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.RESEND_API_KEY },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL || 'DSCM Backups <onboarding@resend.dev>',
      to: env.ALERT_EMAIL.split(',').map(s => s.trim()).filter(Boolean),
      subject,
      html
    })
  });
  if (!res.ok) throw new Error('Resend returned HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300));
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mb = bytes => (bytes / (1024 * 1024)).toFixed(1) + ' MB';

function failureHtml(run) {
  return '<p><strong>The DSCM backup run for ' + esc(run.date) + ' failed.</strong></p>' +
    '<p>Step: ' + esc(run.step) + '<br>Error: ' + esc(run.error) + '<br>Trigger: ' + esc(run.trigger) + '</p>' +
    (run.database ? '<p>The database dump for today did upload (' + esc(run.database.path) + ').</p>' : '<p>No database dump was saved today.</p>') +
    '<p>Earlier backups on SharePoint are untouched - nothing is pruned on a failed run. The next scheduled run retries automatically; ' +
    'if this repeats, check the worker/README in worker-backup/ (an expired Graph client secret is the most common cause).</p>';
}

function incompleteHtml(run) {
  const f = run.files || {};
  return '<p><strong>The DSCM backup run for ' + esc(run.date) + ' finished, but not every file was backed up yet.</strong></p>' +
    '<p>' + esc(f.remaining) + ' file(s) still to upload' + (f.stoppedForBudget ? ' (the run hit its per-run size/time limit)' : '') +
    (f.changedDuringRun && f.changedDuringRun.length ? '; ' + esc(f.changedDuringRun.length) + ' changed while being copied' : '') + '.</p>' +
    '<p>The database dump did upload. No manifest was written for today and nothing was pruned; the next run continues where this one stopped.</p>';
}

function summaryHtml(runs, current) {
  const rows = runs.map(r => '<tr><td>' + esc(r.date) + '</td><td>' + esc(r.status) + '</td><td>' +
    (r.database ? esc(mb(r.database.bytes)) : '-') + '</td><td>' +
    (r.files ? esc(r.files.objectCount) + ' files, ' + esc(mb(r.files.totalBytes)) : '-') + '</td><td>' +
    (r.files ? esc(r.files.newUploads) + ' new' : '-') + '</td><td>' + esc(r.error || '') + '</td></tr>').join('');
  return '<p>DSCM backup runs in the last 7 days:</p>' +
    '<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:13px">' +
    '<tr><th>Date</th><th>Status</th><th>Database dump</th><th>Files in R2</th><th>Uploaded</th><th>Error</th></tr>' + rows + '</table>' +
    '<p>If this weekly email ever stops arriving, the scheduled job itself may have stopped - check the dscm-backup worker in Cloudflare.</p>' +
    (current.runLogError ? '<p>Note: the run log could not be updated this time: ' + esc(current.runLogError) + '</p>' : '');
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), { status, headers: { 'Content-Type': 'application/json' } });
}

function constantTimeEqual(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i % x.length] || 0) ^ (y[i % y.length] || 0);
  return diff === 0 && x.length > 0;
}
