// Minimal Microsoft Graph client for the backup job: app-only token (client
// credentials), upload/download/list/delete by path inside the backup site's
// default document library. Every outbound call goes through a Budget so one
// run can't exceed the Worker's subrequest/time limits - when the budget runs
// low the job stops cleanly and picks up where it left off next run.

export const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
// Upload-session chunks must be a multiple of 320 KiB; 10 MiB = 32 x 320 KiB.
export const CHUNK_SIZE = 32 * 320 * 1024;

export class BudgetExceeded extends Error {}

export class Budget {
  constructor(maxCalls, deadlineMs) {
    this.max = maxCalls;
    this.used = 0;
    this.deadline = deadlineMs;
  }
  remaining() { return this.max - this.used; }
  canAfford(calls) { return this.used + calls <= this.max && Date.now() < this.deadline; }
  take(calls = 1) {
    if (this.used + calls > this.max) throw new BudgetExceeded('Subrequest budget used up (' + this.max + ').');
    if (Date.now() >= this.deadline) throw new BudgetExceeded('Time budget used up.');
    this.used += calls;
  }
}

export class GraphError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Graph {
  constructor(env, budget) {
    this.env = env;
    this.budget = budget;
    this.base = env.GRAPH_BASE || 'https://graph.microsoft.com/v1.0';
    this.loginBase = env.GRAPH_LOGIN_BASE || 'https://login.microsoftonline.com';
    this.accessToken = null;
    this.tokenExpires = 0;
    this.driveUrl = null;
  }

  async token() {
    if (this.accessToken && Date.now() < this.tokenExpires) return this.accessToken;
    for (const name of ['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET', 'GRAPH_SITE_ID']) {
      if (!this.env[name]) throw new GraphError('Missing Worker secret ' + name + '.', 0);
    }
    const res = await this.send(this.loginBase + '/' + encodeURIComponent(this.env.GRAPH_TENANT_ID) + '/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.env.GRAPH_CLIENT_ID,
        client_secret: this.env.GRAPH_CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default'
      }).toString()
    }, false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new GraphError('Could not get a Microsoft Graph token (HTTP ' + res.status + '): ' + (data.error_description || data.error || 'no details') +
        ' - check the tenant/client IDs and that the client secret has not expired.', res.status);
    }
    this.accessToken = data.access_token;
    this.tokenExpires = Date.now() + Math.max(60, (data.expires_in || 3600) - 300) * 1000;
    return this.accessToken;
  }

  // One HTTP call, counted against the budget, retried on throttling (429)
  // and transient server errors (5xx) with Retry-After / backoff.
  async send(url, init, auth = true) {
    for (let attempt = 1; ; attempt++) {
      this.budget.take(1);
      const headers = Object.assign({}, init.headers || {});
      if (auth) headers.Authorization = 'Bearer ' + (await this.token());
      const res = await fetch(url, Object.assign({}, init, { headers }));
      const retryable = res.status === 429 || res.status === 503 || res.status === 504 || res.status === 500 || res.status === 502;
      if (!retryable || attempt >= 4) return res;
      const retryAfter = Number(res.headers.get('Retry-After'));
      await sleep(Math.min(30000, (retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt)));
    }
  }

  async fail(res, what) {
    let detail = '';
    try { const d = await res.json(); detail = (d.error && (d.error.message || d.error.code)) || ''; } catch (e) {}
    const hint = res.status === 403 ? ' (403 usually means the app has not been granted write access to this site - see README step C)' : '';
    throw new GraphError(what + ' failed (HTTP ' + res.status + ')' + (detail ? ': ' + detail : '') + hint, res.status);
  }

  async drive() {
    if (this.driveUrl) return this.driveUrl;
    const res = await this.send(this.base + '/sites/' + encodeURIComponent(this.env.GRAPH_SITE_ID) + '/drive?$select=id', { method: 'GET' });
    if (!res.ok) await this.fail(res, 'Looking up the backup site\'s document library');
    const data = await res.json();
    this.driveUrl = this.base + '/drives/' + encodeURIComponent(data.id);
    return this.driveUrl;
  }

  async itemUrl(path) {
    return (await this.drive()) + '/root:/' + path.split('/').map(encodeURIComponent).join('/') + ':';
  }

  // Uploads a whole in-memory file (JSON dumps, manifests, state).
  async putBytes(path, bytes, contentType = 'application/octet-stream') {
    if (bytes.byteLength <= SIMPLE_UPLOAD_MAX) {
      const put = async () => this.send((await this.itemUrl(path)) + '/content', { method: 'PUT', headers: { 'Content-Type': contentType }, body: bytes });
      let res = await put();
      if (res.status === 409) { await this.clearConflict(path); res = await put(); }
      if (!res.ok) await this.fail(res, 'Uploading ' + path);
      return res.json();
    }
    return this.uploadSession(path, bytes.byteLength, async (offset, length) => bytes.subarray(offset, offset + length));
  }

  async putJson(path, value) {
    return this.putBytes(path, new TextEncoder().encode(JSON.stringify(value, null, 1)), 'application/json');
  }

  // Creates a small JSON file only if nothing exists at the path yet.
  // Returns true if created, false if something was already there.
  async createJsonIfAbsent(path, value) {
    const res = await this.send((await this.itemUrl(path)) + '/content?@microsoft.graph.conflictBehavior=fail', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(value))
    });
    if (res.status === 409) return false;
    if (!res.ok) await this.fail(res, 'Creating ' + path);
    return true;
  }

  // Large-file upload: readChunk(offset, length) supplies each piece, so a big
  // file is streamed through in CHUNK_SIZE pieces instead of held in memory.
  async uploadSession(path, size, readChunk) {
    const create = async () => this.send((await this.itemUrl(path)) + '/createUploadSession', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } })
    });
    let res = await create();
    if (res.status === 409) { await this.clearConflict(path); res = await create(); }
    if (!res.ok) await this.fail(res, 'Starting upload of ' + path);
    const { uploadUrl } = await res.json();
    let last;
    for (let offset = 0; offset < size; offset += CHUNK_SIZE) {
      const length = Math.min(CHUNK_SIZE, size - offset);
      const chunk = await readChunk(offset, length);
      if (chunk.byteLength !== length) throw new GraphError('Short read while uploading ' + path + ' at byte ' + offset + '.', 0);
      // The pre-authorized uploadUrl must NOT carry the Authorization header.
      last = await this.send(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Length': String(length), 'Content-Range': 'bytes ' + offset + '-' + (offset + length - 1) + '/' + size },
        body: chunk
      }, false);
      if (!last.ok) {
        this.send(uploadUrl, { method: 'DELETE' }, false).catch(() => {});
        await this.fail(last, 'Uploading ' + path + ' (bytes ' + offset + '+)');
      }
    }
    return last.json();
  }

  // Returns parsed JSON, or null if the file doesn't exist.
  async getJson(path) {
    const res = await this.send((await this.itemUrl(path)) + '/content', { method: 'GET' });
    if (res.status === 404) return null;
    if (!res.ok) await this.fail(res, 'Reading ' + path);
    return res.json();
  }

  // Every child (name, id, size) of a folder; [] if the folder doesn't exist.
  async listChildren(folderPath) {
    let url = (await this.itemUrl(folderPath)) + '/children?$select=id,name,size,file,folder&$top=999';
    const items = [];
    while (url) {
      const res = await this.send(url, { method: 'GET' });
      if (res.status === 404) return [];
      if (!res.ok) await this.fail(res, 'Listing ' + folderPath);
      const data = await res.json();
      items.push(...(data.value || []));
      url = data['@odata.nextLink'] || null;
    }
    return items;
  }

  // A 409 on upload means something is already sitting at this path in a
  // conflicting state - in practice a half-finished copy left by a run that
  // was cut off mid-upload. Callers only upload to paths reserved for this
  // exact file version (the index records a file only once fully uploaded),
  // so whatever is there is our own leftover and safe to remove.
  async clearConflict(path) {
    await this.deletePath(path);
    await sleep(1000);
  }

  // Deletes by path; a file that's already gone counts as success.
  async deletePath(path) {
    const res = await this.send(await this.itemUrl(path), { method: 'DELETE' });
    if (res.ok || res.status === 404) return;
    await this.fail(res, 'Deleting ' + path);
  }
}
