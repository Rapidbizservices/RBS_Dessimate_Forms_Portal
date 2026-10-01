// In-memory stand-ins for D1, R2, Microsoft Graph (SharePoint) and Resend, so
// the whole backup job can be exercised in Node without touching anything real.
import { createHash } from 'node:crypto';

const md5 = bytes => createHash('md5').update(bytes).digest('hex');

export class FakeR2 {
  constructor() { this.objects = new Map(); }
  put(key, bytes, contentType = 'application/octet-stream') {
    const b = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
    this.objects.set(key, { bytes: b, etag: md5(b), uploaded: new Date(), contentType });
  }
  async list({ cursor, limit = 1000 } = {}) {
    const keys = [...this.objects.keys()].sort();
    const start = cursor ? Number(cursor) : 0;
    const page = keys.slice(start, start + limit);
    return {
      objects: page.map(k => ({ key: k, size: this.objects.get(k).bytes.byteLength, etag: this.objects.get(k).etag, uploaded: this.objects.get(k).uploaded })),
      truncated: start + limit < keys.length,
      cursor: String(start + limit)
    };
  }
  async get(key, opts = {}) {
    const o = this.objects.get(key);
    if (!o) return null;
    if (opts.onlyIf && opts.onlyIf.etagMatches && opts.onlyIf.etagMatches !== o.etag) return { etag: o.etag }; // no body
    let bytes = o.bytes;
    if (opts.range) bytes = bytes.subarray(opts.range.offset, opts.range.offset + opts.range.length);
    return { etag: o.etag, body: true, httpMetadata: { contentType: o.contentType }, arrayBuffer: async () => bytes.slice().buffer };
  }
}

export class FakeD1 {
  constructor(rows) { this.rows = rows; }
  prepare(sql) {
    const self = this;
    let params = [];
    return {
      bind(...p) { params = p; return this; },
      async all() {
        if (sql.includes('sqlite_master')) {
          return { results: [
            { type: 'table', name: 'documents', tbl_name: 'documents', sql: 'CREATE TABLE documents (path TEXT PRIMARY KEY, content TEXT NOT NULL, version TEXT NOT NULL, updated_at TEXT NOT NULL)' },
            { type: 'index', name: 'idx_docs', tbl_name: 'documents', sql: 'CREATE INDEX idx_docs ON documents(updated_at)' }
          ] };
        }
        const [limit, offset] = params;
        return { results: self.rows.slice(offset, offset + limit) };
      }
    };
  }
}

// Fake SharePoint drive: files keyed by their decoded path.
export class FakeGraph {
  constructor() {
    this.files = new Map();
    this.sessions = new Map();
    this.emails = [];
    this.calls = 0;
    this.failNext = null; // (url, init) => Response | null, to inject errors
    this.tokenOk = true;
  }
  install() {
    const self = this;
    globalThis.fetch = async (url, init = {}) => self.handle(String(url), init);
  }
  pathFrom(url, marker) {
    const i = url.indexOf('/root:/');
    const rest = url.slice(i + '/root:/'.length);
    const end = rest.indexOf(':');
    return rest.slice(0, end).split('/').map(decodeURIComponent).join('/');
  }
  async handle(url, init) {
    this.calls++;
    const method = (init.method || 'GET').toUpperCase();
    if (this.failNext) { const r = this.failNext(url, init); if (r) return r; }
    if (url.startsWith('https://api.resend.com')) { this.emails.push(JSON.parse(init.body)); return new Response('{"id":"x"}', { status: 200 }); }
    if (url.includes('/oauth2/v2.0/token')) {
      return this.tokenOk
        ? Response.json({ access_token: 'tok', expires_in: 3600 })
        : Response.json({ error: 'invalid_client', error_description: 'AADSTS7000222: The provided client secret keys are expired.' }, { status: 401 });
    }
    if (url.startsWith('https://upload.test/')) {
      const s = this.sessions.get(url);
      if (init.headers.Authorization) throw new Error('uploadUrl must not get an Authorization header');
      if (method === 'DELETE') { this.sessions.delete(url); return new Response(null, { status: 204 }); }
      const [, start, end, total] = /bytes (\d+)-(\d+)\/(\d+)/.exec(init.headers['Content-Range']).map(Number);
      if (start !== s.received) return Response.json({ error: { message: 'bad range' } }, { status: 416 });
      if ((end - start + 1) % (320 * 1024) !== 0 && end + 1 !== total) throw new Error('chunk not a multiple of 320 KiB');
      s.parts.push(new Uint8Array(init.body));
      s.received = end + 1;
      if (s.received === total) {
        const all = new Uint8Array(total); let o = 0;
        for (const p of s.parts) { all.set(p, o); o += p.byteLength; }
        this.files.set(s.path, all);
        return Response.json({ id: s.path, size: total }, { status: 201 });
      }
      return Response.json({ nextExpectedRanges: [s.received + '-'] }, { status: 202 });
    }
    if (!init.headers || init.headers.Authorization !== 'Bearer tok') return new Response('no auth', { status: 401 });
    if (url.includes('/sites/') && url.includes('/drive?')) return Response.json({ id: 'drv' });
    const path = this.pathFrom(url);
    for (const seg of path.split('/')) if (/["*:<>?\\|]/.test(seg)) return Response.json({ error: { message: 'invalid name ' + seg } }, { status: 400 });
    const bare = url.split('?')[0];
    if (bare.endsWith(':/content') && method === 'PUT') {
      if (url.includes('conflictBehavior=fail') && this.files.has(path)) return Response.json({ error: { message: 'nameAlreadyExists' } }, { status: 409 });
      this.files.set(path, new Uint8Array(init.body)); return Response.json({ id: path }, { status: 201 });
    }
    if (bare.endsWith(':/content') && method === 'GET') {
      return this.files.has(path) ? new Response(this.files.get(path), { status: 200 }) : Response.json({ error: { message: 'itemNotFound' } }, { status: 404 });
    }
    if (url.endsWith(':/createUploadSession')) {
      const uploadUrl = 'https://upload.test/' + (this.sessions.size + 1) + '-' + Math.random().toString(36).slice(2);
      this.sessions.set(uploadUrl, { path, parts: [], received: 0 });
      return Response.json({ uploadUrl });
    }
    if (url.includes(':/children')) {
      const prefix = path + '/';
      const names = new Set();
      for (const p of this.files.keys()) if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) names.add(p.slice(prefix.length));
      return Response.json({ value: [...names].map(n => ({ id: prefix + n, name: n, size: this.files.get(prefix + n).byteLength, file: {} })) });
    }
    if (method === 'DELETE') { const had = this.files.delete(path); return new Response(null, { status: had ? 204 : 404 }); }
    throw new Error('Fake Graph: unhandled ' + method + ' ' + url);
  }
  json(path) { return JSON.parse(new TextDecoder().decode(this.files.get(path))); }
  has(path) { return this.files.has(path); }
}

export function makeEnv(overrides = {}) {
  return Object.assign({
    GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's', GRAPH_SITE_ID: 'site',
    ALERT_EMAIL: 'me@example.com', RESEND_API_KEY: 'rk', BACKUP_FOLDER: 'DSCM-Backups'
  }, overrides);
}
