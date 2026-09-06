/**
 * Dessimate Forms Portal - backend
 * ---------------------------------------------------------------------------
 * A thin, authenticated proxy in front of the GitHub Contents API.
 *
 * WHY THIS EXISTS
 * The Forms Portal pages (PDIR_Form_Filler.html, PDIR_Portal.html, and
 * eventually the PSW form) are plain static files with no server of their
 * own. Saving data into the GitHub repo therefore requires *someone's*
 * GitHub credentials. Originally each staff member pasted in their own
 * GitHub Personal Access Token — which meant every staff member needed a
 * GitHub account with write access to the repo. That doesn't work for
 * non-technical staff.
 *
 * This Worker fixes that by being the only thing that holds the real GitHub
 * token (as a Worker secret, never sent to the browser). Staff instead log
 * in with a username/password, and get back a short-lived signed session
 * token. Every route except /login and /health requires a valid session
 * token.
 *
 * The response *shapes* for /contents and /commits deliberately mirror
 * GitHub's own Contents API (an object with base64 "content" for a file, an
 * array of {name,type,...} for a directory listing, etc.) so the existing
 * frontend code — which already treats "the API" as a configurable base URL
 * — needed almost no changes beyond pointing at this Worker and swapping the
 * Authorization header from a GitHub PAT to a session token.
 *
 * USER DIRECTORY (Organization, Role, Email, Phone, Active, etc.)
 * The full user directory (everyone with a Portal login, plus Supplier /
 * Customer contact records with no login) lives in one JSON file in the
 * repo, USERS_FILE_PATH below, read and written only through the /admin/users
 * routes — never through the generic /contents proxy, so a signed-in staff
 * member's own browser can never fetch anyone's password hash directly (see
 * the guard at the top of proxyContents).
 *
 * This replaces the original design, where logins lived only in a
 * STAFF_USERS Worker secret you edited by hand with `wrangler secret put`.
 * That secret still works and is never deleted by this code — if a
 * username isn't found in the new file, login falls back to checking it —
 * so nobody who was already able to log in loses access. A username becomes
 * "migrated" (and the STAFF_USERS secret stops being consulted for it) the
 * moment it's edited and saved once from the Users admin page, or pulled in
 * with the page's "Import" action. There's no cutover step required.
 *
 * ORGANIZATION DIRECTORY (Suppliers / Customers - address, docs, etc.)
 * A second directory file, ORGANIZATIONS_FILE_PATH below, holds Supplier and
 * Customer companies (not people - that's the user directory above). Its
 * documents (company presentation, NDA, self-assessment, and any number of
 * generic files) are ordinary files under ORG_DOC_FOLDER in the repo,
 * uploaded/read through the normal /contents proxy - only the metadata
 * record (name, address, phone, website, which files exist) goes through
 * the dedicated /organizations routes. Unlike users.json there's no secret
 * data here (no passwords), so there's no legacy-secret fallback to worry
 * about and no need to keep this file's path out of the generic /contents
 * proxy — it's blocked anyway for consistency, since everything under data/
 * is reserved for these directory files.
 *
 * PARTS DIRECTORY (the part master - linked to a Customer and any number of
 * Suppliers by organization name, same as the PDIR form's own Supplier /
 * Organization field)
 * A third directory file, PARTS_FILE_PATH below, holds one record per part
 * number: description, revision, status, and which Organizations records
 * (by name) are its Customer and its Suppliers. Its optional drawing file
 * is an ordinary file under PART_DOC_FOLDER, uploaded/read through the
 * normal /contents proxy, same as organization documents - only the
 * metadata record goes through the dedicated /parts routes. This is what
 * eventually lets a Supplier or Customer portal filter "which parts / PDIRs
 * / APQP records can this signed-in organization see" down to just their
 * own, without new permission fields - it's just "is my organization the
 * Customer or one of the Suppliers on this part."
 *
 * ACCESS LEVELS (permission tier - separate from the free-text "role"/job-title
 * field on a Users record)
 * Every signed-in user resolves to one of ACCESS_LEVELS (super_admin, admin,
 * team_member, supplier, customer) via resolveAccessLevel() - either an
 * explicit accessLevel set on their Users record, or a sensible default from
 * their relationship (Supplier -> supplier, Customer -> customer, Dessimate
 * Team member -> team_member), with SUPER_ADMIN_LEGACY_FALLBACK bootstrapping
 * anyone who could already reach Users/Organizations before this field
 * existed (mirrors the old hardcoded frontend ADMIN_USERNAMES list). GET
 * /organizations and GET /parts deliberately stay on plain requireAuth (any
 * signed-in user) rather than requireRole, since the already-shipped
 * Supplier/Customer/Part dropdowns on the PDIR form, Parts page, and Users
 * page depend on every signed-in user being able to read them - only the
 * WRITE routes for Users and Organizations, and the admin user directory's
 * GET (personal contact info), are super_admin-only. Parts writes require
 * team_member or above.
 *
 * ROUTES
 *   GET    /health                    - no auth; quick "is this deployed" check
 *   POST   /login                     - { username, password } -> { token, username, expiresAt }
 *   GET    /users                     - no auth; -> { usernames: [...] }, active team-member
 *                                        logins only. Never salts/hashes. Kept for any page
 *                                        that just wants a plain "who can sign in" list.
 *   GET    /me                        - auth required; -> { username, accessLevel }. Lets the
 *                                        frontend decide what to show (e.g. the Admin button)
 *                                        from real resolved access, instead of a hardcoded list.
 *   GET    /admin/users               - super_admin required; full sanitized user directory
 *                                        (never salts/hashes), including not-yet-migrated
 *                                        legacy logins.
 *   POST   /admin/users               - super_admin required; create a directory entry.
 *   PUT    /admin/users/<id>          - super_admin required; update one (id may be a real
 *                                        file id, or "legacy:<username>" - editing one of
 *                                        those migrates it into the file automatically).
 *   DELETE /admin/users/<id>          - super_admin required; remove one (file ids only - a
 *                                        not-yet-migrated legacy id can't be deleted this way;
 *                                        edit it and turn off Active instead).
 *   POST   /admin/import-legacy       - super_admin required; pulls any STAFF_USERS-secret
 *                                        logins not already in the file into the file,
 *                                        unchanged otherwise, so they show up as editable rows.
 *   GET    /organizations             - auth required (any signed-in user); full organization
 *                                        directory.
 *   POST   /organizations             - super_admin required; create an organization.
 *   PUT    /organizations/<id>        - super_admin required; update one.
 *   DELETE /organizations/<id>        - super_admin required; remove one (its document files
 *                                        in the repo are left in place, same as PDIRs do when
 *                                        a document is replaced - nothing here deletes repo
 *                                        file content, only the directory record).
 *   GET    /parts                     - auth required (any signed-in user); full parts
 *                                        directory.
 *   POST   /parts                     - team_member or above required; create a part.
 *   PUT    /parts/<id>                - team_member or above required; update one.
 *   DELETE /parts/<id>                - team_member or above required; remove one (its
 *                                        drawing file in the repo is left in place, same as
 *                                        Organizations).
 *   GET    /apqp                       - auth required (any signed-in user); full APQP list (one
 *                                        record per Part on the APQP checklist, each with its
 *                                        nine deliverable items - files + a comment log per item).
 *   POST   /apqp                       - team_member or above required; add a Part to APQP
 *                                        ({ partNumber }) - rejects a Part already on the list.
 *   DELETE /apqp/<id>                  - team_member or above required; remove a Part from APQP
 *                                        (its uploaded files are left in place, same as
 *                                        Organizations/Parts).
 *   PUT    /apqp/<id>/items/<key>      - team_member or above required; replace one checklist
 *                                        item's file list ({ files: [...] }) - <key> is one of
 *                                        designRecord, controlPlan, dimResults, mpTests, ips,
 *                                        sampleProduct, masterSample, other, psw.
 *   POST   /apqp/<id>/items/<key>/comments
 *                                       - team_member or above required; append one comment
 *                                        ({ text }) to that item's log - author is the signed-in
 *                                        user, never client-supplied.
 *   GET    /customer-pos               - auth required (any signed-in user); full Customer PO list.
 *   POST   /customer-pos               - admin or above required; create a Customer PO.
 *   PUT    /customer-pos/<id>          - admin or above required; update one.
 *   DELETE /customer-pos/<id>          - admin or above required; remove one (its attached
 *                                        source PDF is left in place, same as Organizations/Parts).
 *   GET    /contents/<path...>        - proxies GET  .../repos/:owner/:repo/contents/<path>
 *                                        (blocked for anything under data/ - see above)
 *   PUT    /contents/<path...>        - proxies PUT  .../repos/:owner/:repo/contents/<path>
 *                                        (blocked for anything under data/ - see above)
 *   GET    /commits?path=<path>       - proxies GET  .../repos/:owner/:repo/commits?path=...
 *
 * SECRETS (set with `wrangler secret put <NAME>`)
 *   GITHUB_TOKEN   - a GitHub PAT with Contents: Read and write on the repo
 *   SESSION_SECRET - random string used to sign session tokens (see README)
 *   STAFF_USERS    - JSON array of {username, salt, hash} - the original login list.
 *                    Still consulted as a fallback for anyone not yet migrated into
 *                    the new file (see USER DIRECTORY above) - no need to touch this
 *                    again going forward, new/changed logins are managed from the
 *                    Users admin page instead.
 *
 * VARS (set in wrangler.toml, not secret)
 *   GITHUB_OWNER, GITHUB_REPO, ALLOWED_ORIGIN
 * ---------------------------------------------------------------------------
 */

// pdf-lib is vendored as a plain ESM file (worker/src/pdf-lib.esm.min.js,
// copied verbatim from `npm install pdf-lib`'s dist/pdf-lib.esm.min.js - zero
// Node built-ins, confirmed safe for the Worker's V8 isolate) so Dessimate PO
// PDFs are generated by one template that lives here on the backend, not
// hand-copied into the frontend. Wrangler's bundler inlines this import
// automatically on `wrangler deploy` - nothing else to install.
import { PDFDocument, StandardFonts, rgb } from './pdf-lib.esm.min.js';

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const USERS_FILE_PATH = 'data/users.json';
const ORGANIZATIONS_FILE_PATH = 'data/organizations.json';
const ORG_DOC_FOLDER = 'org_docs';
const RELATIONSHIPS = ['Dessimate Team member', 'Supplier', 'Customer'];
const ORG_RELATIONSHIPS = ['Supplier', 'Customer', 'Self'];

const PARTS_FILE_PATH = 'data/parts.json';
const PART_DOC_FOLDER = 'part_docs';
const PART_STATUSES = ['Active', 'Inactive', 'Obsolete'];

// PDIR (shipment inspection reports) predates structured backend storage -
// its records are still raw files in pdirs/pdir_drafts/pdir_docs, named and
// organized by the frontend alone, not a JSON-array-of-records file like
// every module above. This small index is the one piece of structured,
// backend-owned metadata PDIR has: which organization (Supplier) each title
// belongs to, so a Supplier login's PDIR list - and its /contents/ access to
// that PDIR's own files - can be scoped to their own shipments, the same way
// every other module now is. It does not replace or duplicate the PDIR
// record itself (still the PDF/draft/docs on GitHub) - just tags it.
const PDIR_INDEX_FILE_PATH = 'data/pdir_index.json';

const APQP_FILE_PATH = 'data/apqp.json';
const APQP_DOC_FOLDER = 'apqp_docs';
// Fixed checklist of nine APQP deliverables per part (per the product brief),
// each with its own files + a running comment log. Order matters - it's the
// order the Part's checklist is shown in.
const APQP_ITEM_KEYS = ['designRecord', 'controlPlan', 'dimResults', 'mpTests', 'ips', 'sampleProduct', 'masterSample', 'other', 'psw'];
const APQP_ITEM_LABELS = {
  designRecord: 'Design Record', controlPlan: 'Control Plan', dimResults: 'Dim Results',
  mpTests: 'M/P Tests', ips: 'IPS', sampleProduct: 'Sample Product',
  masterSample: 'Master Sample', other: 'Other', psw: 'PSW'
};

// ---- access levels (permission tier - separate from the free-text "role"/
// job-title field on a Users record) ----------------------------------------
// super_admin - Users + Organizations modules, plus everything below
// admin       - Customer PO + Dessimate Invoice (admin section), plus below
// team_member - Dessimate PO, Supplier Invoice, PDIR, Parts (read/write), APQP
// supplier    - read-only, own-organization records only: Parts, Dessimate
//               POs, Supplier Invoices, APQP, PDIRs (via data/pdir_index.json)
// customer    - read-only, own-organization records only: Parts, Customer
//               POs, Dessimate Invoices
const ACCESS_LEVELS = ['super_admin', 'admin', 'team_member', 'supplier', 'customer'];
// Accounts that predate the accessLevel field (or were migrated from the old
// STAFF_USERS secret before it existed) fall back to this bootstrap list so
// nobody who could reach Users/Organizations before this field existed loses
// that access silently. Mirrors the ADMIN_USERNAMES list the frontend used
// to hardcode - now enforced here instead, and still editable per-user from
// the Users page once an explicit accessLevel is set.
const SUPER_ADMIN_LEGACY_FALLBACK = ['roberto', 'amy'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = env.ALLOWED_ORIGIN || '*';

    if (request.method === 'OPTIONS') {
      return corsResponse(origin);
    }

    try {
      if (url.pathname === '/health') {
        return json({ ok: true, service: 'dessimate-forms-backend' }, 200, origin);
      }

      if (url.pathname === '/login' && request.method === 'POST') {
        return await handleLogin(request, env, origin);
      }

      if (url.pathname === '/users' && request.method === 'GET') {
        return await handleListUsers(env, origin);
      }

      if (url.pathname === '/me' && request.method === 'GET') {
        const auth = await requireAuth(request, env);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        const accessLevel = await resolveAccessLevel(env, auth.username);
        return json({ username: auth.username, accessLevel: accessLevel }, 200, origin);
      }

      // Users + Organizations write access (and the entire admin user
      // directory, since it exposes personal contact info) is restricted to
      // super_admin. GET /organizations and GET /parts stay on plain
      // requireAuth below - any signed-in user still needs those for the
      // Supplier/Customer/Part dropdowns already relied on across the app.
      if (url.pathname === '/admin/users') {
        const auth = await requireRole(request, env, ['super_admin']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        if (request.method === 'GET') return await handleAdminListUsers(env, origin);
        if (request.method === 'POST') return await handleAdminCreateUser(request, env, origin);
      }

      if (url.pathname.startsWith('/admin/users/')) {
        const auth = await requireRole(request, env, ['super_admin']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        const id = decodeURIComponent(url.pathname.slice('/admin/users/'.length));
        if (request.method === 'PUT') return await handleAdminUpdateUser(request, env, origin, id);
        if (request.method === 'DELETE') return await handleAdminDeleteUser(env, origin, id);
      }

      if (url.pathname === '/admin/import-legacy' && request.method === 'POST') {
        const auth = await requireRole(request, env, ['super_admin']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handleAdminImportLegacy(env, origin);
      }

      if (url.pathname === '/organizations') {
        if (request.method === 'GET') {
          const auth = await requireAuth(request, env);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleListOrganizations(env, origin);
        }
        if (request.method === 'POST') {
          const auth = await requireRole(request, env, ['super_admin']);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleCreateOrganization(request, env, origin);
        }
      }

      if (url.pathname.startsWith('/organizations/')) {
        const id = decodeURIComponent(url.pathname.slice('/organizations/'.length));
        const auth = await requireRole(request, env, ['super_admin']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        if (request.method === 'PUT') return await handleUpdateOrganization(request, env, origin, id);
        if (request.method === 'DELETE') return await handleDeleteOrganization(env, origin, id);
      }

      if (url.pathname === '/parts') {
        if (request.method === 'GET') {
          const auth = await requireAuthWithScope(request, env);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleListParts(env, origin, auth.accessLevel, auth.organization);
        }
        if (request.method === 'POST') {
          const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleCreatePart(request, env, origin);
        }
      }

      if (url.pathname.startsWith('/parts/')) {
        const id = decodeURIComponent(url.pathname.slice('/parts/'.length));
        const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        if (request.method === 'PUT') return await handleUpdatePart(request, env, origin, id);
        if (request.method === 'DELETE') return await handleDeletePart(env, origin, id);
      }

      if (url.pathname === '/apqp') {
        if (request.method === 'GET') {
          const auth = await requireAuthWithScope(request, env);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleListApqp(env, origin, auth.accessLevel, auth.organization);
        }
        if (request.method === 'POST') {
          const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleCreateApqp(request, env, origin, auth.username);
        }
      }

      // Both checked before the generic '/apqp/<id>' handler below - these
      // are nested under one checklist item, not the record itself.
      const apqpCommentsMatch = /^\/apqp\/([^/]+)\/items\/([^/]+)\/comments$/.exec(url.pathname);
      if (apqpCommentsMatch && request.method === 'POST') {
        const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handleAddApqpComment(request, env, origin, decodeURIComponent(apqpCommentsMatch[1]), decodeURIComponent(apqpCommentsMatch[2]), auth.username);
      }
      const apqpItemMatch = /^\/apqp\/([^/]+)\/items\/([^/]+)$/.exec(url.pathname);
      if (apqpItemMatch && request.method === 'PUT') {
        const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handleUpdateApqpItemFiles(request, env, origin, decodeURIComponent(apqpItemMatch[1]), decodeURIComponent(apqpItemMatch[2]));
      }

      if (url.pathname.startsWith('/apqp/')) {
        const id = decodeURIComponent(url.pathname.slice('/apqp/'.length));
        const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        if (request.method === 'DELETE') return await handleDeleteApqp(env, origin, id);
      }

      if (url.pathname === '/pdir-index') {
        if (request.method === 'GET') {
          const auth = await requireAuthWithScope(request, env);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleListPdirIndex(env, origin, auth.accessLevel, auth.organization);
        }
        if (request.method === 'POST') {
          const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleUpsertPdirIndexEntry(request, env, origin);
        }
      }

      if (url.pathname === '/customer-pos') {
        if (request.method === 'GET') {
          const auth = await requireAuthWithScope(request, env);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleListCustomerPos(env, origin, auth.accessLevel, auth.organization);
        }
        if (request.method === 'POST') {
          const auth = await requireRole(request, env, ['super_admin', 'admin']);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleCreateCustomerPo(request, env, origin);
        }
      }

      if (url.pathname.startsWith('/customer-pos/')) {
        const id = decodeURIComponent(url.pathname.slice('/customer-pos/'.length));
        const auth = await requireRole(request, env, ['super_admin', 'admin']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        if (request.method === 'PUT') return await handleUpdateCustomerPo(request, env, origin, id);
        if (request.method === 'DELETE') return await handleDeleteCustomerPo(env, origin, id);
      }

      if (url.pathname === '/dessimate-pos') {
        if (request.method === 'GET') {
          const auth = await requireAuthWithScope(request, env);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleListDessimatePos(env, origin, auth.accessLevel, auth.organization);
        }
        if (request.method === 'POST') {
          const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleCreateDessimatePo(request, env, origin);
        }
      }

      // Non-mutating preview of what "Use System Number" would assign, for
      // the Add-Dessimate-PO modal's voluntary/optional numbering (Rev2).
      // Checked before the generic '/dessimate-pos/' handler below, same
      // reason as the PDF route just below it.
      if (url.pathname === '/dessimate-pos/peek-numbers' && request.method === 'GET') {
        const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handlePeekDessimatePoNumbers(env, origin);
      }

      // Checked before the generic '/dessimate-pos/' handler below, which
      // only reacts to PUT/DELETE - this is a GET and would otherwise fall
      // through to a 404.
      if (/^\/dessimate-pos\/[^/]+\/pdf$/.test(url.pathname) && request.method === 'GET') {
        const id = decodeURIComponent(url.pathname.split('/')[2]);
        const auth = await requireAuthWithScope(request, env);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handleGenerateDessimatePoPdf(env, origin, id, auth.accessLevel, auth.organization);
      }

      if (url.pathname.startsWith('/dessimate-pos/')) {
        const id = decodeURIComponent(url.pathname.slice('/dessimate-pos/'.length));
        const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        if (request.method === 'PUT') return await handleUpdateDessimatePo(request, env, origin, id);
        if (request.method === 'DELETE') return await handleDeleteDessimatePo(env, origin, id);
      }

      if (url.pathname === '/supplier-invoices') {
        if (request.method === 'GET') {
          const auth = await requireAuthWithScope(request, env);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleListSupplierInvoices(env, origin, auth.accessLevel, auth.organization);
        }
        if (request.method === 'POST') {
          const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleCreateSupplierInvoice(request, env, origin);
        }
      }

      if (url.pathname.startsWith('/supplier-invoices/')) {
        const id = decodeURIComponent(url.pathname.slice('/supplier-invoices/'.length));
        const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        if (request.method === 'PUT') return await handleUpdateSupplierInvoice(request, env, origin, id);
        if (request.method === 'DELETE') return await handleDeleteSupplierInvoice(env, origin, id);
      }

      if (url.pathname === '/dessimate-invoices') {
        if (request.method === 'GET') {
          const auth = await requireAuthWithScope(request, env);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleListDessimateInvoices(env, origin, auth.accessLevel, auth.organization);
        }
        if (request.method === 'POST') {
          const auth = await requireRole(request, env, ['super_admin', 'admin']);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleCreateDessimateInvoice(request, env, origin);
        }
      }

      // Non-mutating preview of what "Use System Number" would assign, for
      // the Add-Dessimate-Invoice modal's voluntary/optional numbering (Rev2).
      if (url.pathname === '/dessimate-invoices/peek-number' && request.method === 'GET') {
        const auth = await requireRole(request, env, ['super_admin', 'admin']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handlePeekDessimateInvoiceNumber(env, origin);
      }

      // Checked before the generic '/dessimate-invoices/' handler below,
      // which only reacts to PUT/DELETE - this is a GET and would otherwise
      // fall through to a 404.
      if (/^\/dessimate-invoices\/[^/]+\/pdf$/.test(url.pathname) && request.method === 'GET') {
        const id = decodeURIComponent(url.pathname.split('/')[2]);
        const auth = await requireAuthWithScope(request, env);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handleGenerateDessimateInvoicePdf(env, origin, id, auth.accessLevel, auth.organization);
      }

      if (url.pathname.startsWith('/dessimate-invoices/')) {
        const id = decodeURIComponent(url.pathname.slice('/dessimate-invoices/'.length));
        const auth = await requireRole(request, env, ['super_admin', 'admin']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        if (request.method === 'PUT') return await handleUpdateDessimateInvoice(request, env, origin, id);
        if (request.method === 'DELETE') return await handleDeleteDessimateInvoice(env, origin, id);
      }

      if (url.pathname.startsWith('/contents/')) {
        const auth = await requireAuthWithScope(request, env);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        const ghPath = url.pathname.slice('/contents/'.length);
        if (ghPath.indexOf('data/') === 0) {
          return json({ message: 'Not accessible via this route.' }, 403, origin);
        }
        // This proxy has no access control of its own beyond "signed in" -
        // it will fetch or write whatever GitHub path it's given. That was
        // fine while only trusted Dessimate staff could sign in at all; now
        // that Supplier/Customer logins exist, a Supplier/Customer account
        // is restricted to read-only access, and only to the small set of
        // PDIR files their own organization is tagged as owning (see
        // isContentsPathAllowedForExternal) - never another organization's
        // PDIRs, drawings, invoices, or anything else in the repo.
        if (auth.accessLevel === 'supplier' || auth.accessLevel === 'customer') {
          if (request.method !== 'GET') {
            return json({ message: 'Your account has read-only access.' }, 403, origin);
          }
          const allowed = await isContentsPathAllowedForExternal(env, ghPath, auth.accessLevel, auth.organization);
          if (!allowed) return json({ message: 'Not accessible with your account.' }, 403, origin);
        }
        return await proxyContents(request, env, origin, ghPath);
      }

      if (url.pathname === '/commits') {
        const auth = await requireAuth(request, env);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await proxyCommits(request, env, origin, url.searchParams.get('path') || '');
      }

      return json({ message: 'Not found' }, 404, origin);
    } catch (err) {
      return json({ message: 'Server error: ' + (err && err.message ? err.message : String(err)) }, 500, origin);
    }
  }
};

// ---- auth routes -----------------------------------------------------------

async function handleLogin(request, env, origin) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const username = (body.username || '').toString().trim();
  const password = (body.password || '').toString();
  if (!username || !password) return json({ message: 'Username and password are required.' }, 400, origin);

  const badCreds = function () { return json({ message: 'Invalid username or password.' }, 401, origin); };

  // The new user file is authoritative for any username it contains. Only
  // when a username isn't in the file at all do we fall back to the old
  // STAFF_USERS secret, so nobody's access silently changes just because
  // other people have been migrated.
  const fileState = await readUsersFile(env);
  const fileMatch = fileState.users.find(function (u) {
    return (u.username || '').toLowerCase() === username.toLowerCase();
  });

  if (fileMatch) {
    // Any relationship (Dessimate Team member, Supplier, Customer) can have
    // a login now - the account just needs a username/hash on file. What
    // that person can then see is entirely down to resolveAccessLevel()
    // (and, for Supplier/Customer, their recorded organization) - not to
    // relationship gating here.
    if (!fileMatch.username || !fileMatch.hash) return badCreds();
    if (fileMatch.active === false) return json({ message: 'This account has been deactivated.' }, 401, origin);
    const computedHash = await pbkdf2Hex(password, fileMatch.salt);
    if (computedHash !== fileMatch.hash) return badCreds();
    return await issueSession(fileMatch.username, env, origin);
  }

  const legacy = readLegacyStaff(env);
  const legacyMatch = legacy.find(function (u) { return (u.username || '').toLowerCase() === username.toLowerCase(); });
  if (!legacyMatch) return badCreds();
  const legacyHash = await pbkdf2Hex(password, legacyMatch.salt);
  if (legacyHash !== legacyMatch.hash) return badCreds();
  return await issueSession(legacyMatch.username, env, origin);
}

async function issueSession(username, env, origin) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = await signToken({ u: username, exp: exp }, env.SESSION_SECRET);
  return json({ token: token, username: username, expiresAt: exp * 1000 }, 200, origin);
}

async function handleListUsers(env, origin) {
  const fileState = await readUsersFile(env);
  const legacy = readLegacyStaff(env);
  const fileUsernamesLower = fileState.users.map(function (u) { return (u.username || '').toLowerCase(); });

  // `people` (username + display name, no other PII) backs the Dessimate PO
  // Approver dropdown - kept separate from the full admin-only directory
  // (GET /admin/users) since any signed-in Team Member needs this list, not
  // just Admins/Super Admins.
  // stampImage rides along here (Rev2) so a Dessimate Team member's signature
  // stamp - already uploaded once on the Users admin page - can be looked up
  // by any signed-in user, e.g. to auto-stamp the PDIR Sign-Off section.
  const people = fileState.users
    .filter(function (u) { return u.username && u.relationship === 'Dessimate Team member' && u.active !== false; })
    .map(function (u) { return { username: u.username, name: u.name || '', stampImage: sanitizeOrgDoc(u.stampImage) }; });

  legacy.forEach(function (u) {
    if (u.username && fileUsernamesLower.indexOf(u.username.toLowerCase()) === -1) people.push({ username: u.username, name: '' });
  });

  people.sort(function (a, b) { return a.username.localeCompare(b.username); });
  const names = people.map(function (p) { return p.username; });
  return json({ usernames: names, people: people }, 200, origin);
}

// ---- admin: user directory --------------------------------------------------

function sanitizeFileUser(u) {
  return {
    id: u.id,
    name: u.name || '',
    username: u.username || null,
    hasLogin: !!(u.username && u.hash),
    organization: u.organization || '',
    relationship: u.relationship || 'Dessimate Team member',
    role: u.role || '',
    email: u.email || '',
    phone: u.phone || '',
    active: u.active !== false,
    accessLevel: u.accessLevel && ACCESS_LEVELS.indexOf(u.accessLevel) !== -1 ? u.accessLevel : null,
    isDemo: !!u.isDemo,
    stampImage: sanitizeOrgDoc(u.stampImage),
    migrated: true
  };
}
function legacyToRow(u) {
  return {
    id: 'legacy:' + u.username.toLowerCase(),
    name: '',
    username: u.username,
    hasLogin: true,
    organization: '',
    relationship: 'Dessimate Team member',
    role: '',
    email: '',
    phone: '',
    active: true,
    accessLevel: null,
    isDemo: false,
    stampImage: null,
    migrated: false
  };
}

async function handleAdminListUsers(env, origin) {
  const fileState = await readUsersFile(env);
  const legacy = readLegacyStaff(env);
  const fileUsernamesLower = fileState.users.map(function (u) { return (u.username || '').toLowerCase(); });
  const legacyOnly = legacy
    .filter(function (u) { return u.username && fileUsernamesLower.indexOf(u.username.toLowerCase()) === -1; })
    .map(legacyToRow);
  const rows = fileState.users.map(sanitizeFileUser).concat(legacyOnly);
  return json({ users: rows }, 200, origin);
}

async function handleAdminImportLegacy(env, origin) {
  const legacy = readLegacyStaff(env);
  const result = await mutateUsersFile(env, function (users) {
    const existingLower = users.map(function (u) { return (u.username || '').toLowerCase(); });
    let added = 0;
    legacy.forEach(function (u) {
      if (!u.username || existingLower.indexOf(u.username.toLowerCase()) !== -1) return;
      users.push({
        id: cryptoRandomId(),
        name: '', username: u.username, salt: u.salt, hash: u.hash,
        organization: '', relationship: 'Dessimate Team member', role: '', email: '', phone: '',
        active: true
      });
      existingLower.push(u.username.toLowerCase());
      added++;
    });
    return { users: users, meta: { added: added } };
  });
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json({ imported: result.meta.added, users: result.users.map(sanitizeFileUser) }, 200, origin);
}

function validateDirectoryFields(body, origin) {
  const relationship = (body.relationship || '').toString();
  if (RELATIONSHIPS.indexOf(relationship) === -1) {
    return { error: json({ message: 'Relationship must be one of: ' + RELATIONSHIPS.join(', ') + '.' }, 400, origin) };
  }
  const email = (body.email || '').toString().trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: json({ message: 'That email address doesn’t look valid.' }, 400, origin) };
  }
  let accessLevel = body.accessLevel !== undefined && body.accessLevel !== null && body.accessLevel !== ''
    ? (body.accessLevel || '').toString() : null;
  if (accessLevel && ACCESS_LEVELS.indexOf(accessLevel) === -1) {
    return { error: json({ message: 'Access level must be one of: ' + ACCESS_LEVELS.join(', ') + '.' }, 400, origin) };
  }
  // A relationship of Supplier/Customer can only carry the matching
  // read-only access level (or none, which resolveAccessLevel defaults the
  // same way) - it should never be handed super_admin/admin/team_member.
  if (relationship === 'Supplier' && accessLevel && accessLevel !== 'supplier') {
    return { error: json({ message: 'A Supplier contact’s access level must be "supplier".' }, 400, origin) };
  }
  if (relationship === 'Customer' && accessLevel && accessLevel !== 'customer') {
    return { error: json({ message: 'A Customer contact’s access level must be "customer".' }, 400, origin) };
  }
  if (relationship === 'Dessimate Team member' && accessLevel && (accessLevel === 'supplier' || accessLevel === 'customer')) {
    return { error: json({ message: 'A Dessimate Team member’s access level must be super_admin, admin, or team_member.' }, 400, origin) };
  }
  return {
    name: (body.name || '').toString().trim(),
    relationship: relationship,
    organization: (body.organization || '').toString().trim(),
    role: (body.role || '').toString().trim(),
    email: email,
    phone: (body.phone || '').toString().trim(),
    active: body.active !== false,
    accessLevel: accessLevel,
    isDemo: !!body.isDemo
  };
}

async function handleAdminCreateUser(request, env, origin) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }

  const fields = validateDirectoryFields(body, origin);
  if (fields.error) return fields.error;

  // A login can be granted to any relationship now (Dessimate Team member,
  // Supplier, or Customer) - what they see once signed in is controlled by
  // resolveAccessLevel()/organization-based filtering, not by who is allowed
  // to have a username at all.
  const wantsUsername = body.username && body.username.toString().trim();

  let username = null, salt = null, hash = null;
  if (wantsUsername) {
    username = body.username.toString().trim();
    const password = (body.password || '').toString();
    if (!password) return json({ message: 'Set a password to create a login for this person.' }, 400, origin);
    const conflict = await usernameTaken(env, username, null);
    if (conflict) return json({ message: 'That username is already in use.' }, 409, origin);
    salt = randomSaltHex();
    hash = await pbkdf2Hex(password, salt);
  }

  const newUser = {
    id: cryptoRandomId(), name: fields.name, username: username, salt: salt, hash: hash,
    organization: fields.organization, relationship: fields.relationship, role: fields.role,
    email: fields.email, phone: fields.phone, active: fields.active,
    accessLevel: fields.accessLevel, isDemo: fields.isDemo,
    stampImage: sanitizeOrgDoc(body.stampImage)
  };

  const result = await mutateUsersFile(env, function (users) {
    users.push(newUser);
    return { users: users };
  });
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeFileUser(newUser), 201, origin);
}

async function handleAdminUpdateUser(request, env, origin, id) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }

  const fields = validateDirectoryFields(body, origin);
  if (fields.error) return fields.error;

  const isLegacyId = id.indexOf('legacy:') === 0;

  let legacySeed = null;
  let existingUsername = null;
  let existingSalt = null, existingHash = null;

  if (isLegacyId) {
    legacySeed = readLegacyStaff(env).find(function (u) { return u.username && ('legacy:' + u.username.toLowerCase()) === id; });
    if (!legacySeed) return json({ message: 'Not found.' }, 404, origin);
    existingUsername = legacySeed.username; existingSalt = legacySeed.salt; existingHash = legacySeed.hash;
  } else {
    const state = await readUsersFile(env);
    const existing = state.users.find(function (u) { return u.id === id; });
    if (!existing) return json({ message: 'Not found.' }, 404, origin);
    existingUsername = existing.username; existingSalt = existing.salt; existingHash = existing.hash;
  }

  // Work out the username/password outcome up front - it needs async
  // hashing and a uniqueness check, which a synchronous mutate callback
  // (below) can't do. mutateUsersFile re-reads current state right before
  // writing, so this is only a factual snapshot, not the final write.
  // A login can belong to any relationship now (Dessimate Team member,
  // Supplier, or Customer) - see the matching note in handleAdminCreateUser.
  let newUsername = null, newSalt = null, newHash = null;
  const requestedUsername = body.username !== undefined ? (body.username || '').toString().trim() : (existingUsername || '');
  if (requestedUsername) {
    newUsername = requestedUsername;
    const usernameChanged = !existingUsername || existingUsername.toLowerCase() !== requestedUsername.toLowerCase();
    if (usernameChanged) {
      const taken = await usernameTaken(env, requestedUsername, isLegacyId ? null : id);
      if (taken) return json({ message: 'That username is already in use.' }, 409, origin);
    }
    const requestedPassword = (body.password || '').toString();
    if (requestedPassword) {
      newSalt = randomSaltHex();
      newHash = await pbkdf2Hex(requestedPassword, newSalt);
    } else if (!usernameChanged && existingHash) {
      newSalt = existingSalt; newHash = existingHash;
    } else {
      return json({ message: 'Set a password to create a login for this person.' }, 400, origin);
    }
  }

  let savedUser = null;
  const result = await mutateUsersFile(env, function (users) {
    let target;
    if (isLegacyId) {
      target = { id: cryptoRandomId() };
      users.push(target);
    } else {
      target = users.find(function (u) { return u.id === id; });
      if (!target) return null; // signals "not found" to caller below
    }
    target.name = fields.name;
    target.organization = fields.organization;
    target.relationship = fields.relationship;
    target.role = fields.role;
    target.email = fields.email;
    target.phone = fields.phone;
    target.active = fields.active;
    target.accessLevel = fields.accessLevel;
    target.isDemo = fields.isDemo;
    if (body.stampImage !== undefined) {
      target.stampImage = sanitizeOrgDoc(body.stampImage);
    }
    target.username = newUsername;
    target.salt = newSalt;
    target.hash = newHash;
    savedUser = target;
    return { users: users };
  }, { requireFound: true });

  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeFileUser(savedUser), 200, origin);
}

async function handleAdminDeleteUser(env, origin, id) {
  if (id.indexOf('legacy:') === 0) {
    return json({ message: 'This person hasn’t been added to the new list yet. Edit and save their details first (or turn off Active there to revoke access) before deleting.' }, 400, origin);
  }
  const result = await mutateUsersFile(env, function (users) {
    const idx = users.findIndex(function (u) { return u.id === id; });
    if (idx === -1) return null;
    users.splice(idx, 1);
    return { users: users };
  }, { requireFound: true });
  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json({ ok: true }, 200, origin);
}

async function usernameTaken(env, username, excludeId) {
  const lower = username.toLowerCase();
  const fileState = await readUsersFile(env);
  const inFile = fileState.users.some(function (u) {
    return u.username && u.username.toLowerCase() === lower && u.id !== excludeId;
  });
  if (inFile) return true;
  const legacy = readLegacyStaff(env);
  return legacy.some(function (u) { return u.username && u.username.toLowerCase() === lower; });
}

// ---- organization directory (Suppliers / Customers) ------------------------

function sanitizeOrg(o) {
  return {
    id: o.id,
    name: o.name || '',
    relationship: o.relationship || 'Supplier',
    address: o.address || '',
    phone: o.phone || '',
    website: o.website || '',
    logo: sanitizeOrgDoc(o.logo),
    // addresses/salesEmail/purchasingEmail are only meaningful for the
    // Self organization (Dessimate's own record - Delaware registered +
    // California office, one email for invoices, one for POs), but kept as
    // plain optional fields on every org rather than a special-cased shape.
    addresses: Array.isArray(o.addresses)
      ? o.addresses.map(sanitizeOrgAddress).filter(Boolean)
      : [],
    salesEmail: o.salesEmail || '',
    purchasingEmail: o.purchasingEmail || '',
    docs: {
      companyPresentation: sanitizeOrgDoc(o.docs && o.docs.companyPresentation),
      nda: sanitizeOrgDoc(o.docs && o.docs.nda),
      selfAssessment: sanitizeOrgDoc(o.docs && o.docs.selfAssessment)
    },
    genericDocs: Array.isArray(o.genericDocs) ? o.genericDocs.map(sanitizeOrgDoc).filter(Boolean) : []
  };
}
function sanitizeOrgAddress(a) {
  if (!a) return null;
  const label = (a.label || '').toString().trim();
  const address = (a.address || '').toString().trim();
  if (!label && !address) return null;
  return { label: label, address: address };
}
function sanitizeOrgDoc(d) {
  if (!d || !d.path) return null;
  return {
    id: d.id || null,
    path: d.path,
    filename: d.filename || '',
    mimeType: d.mimeType || 'application/octet-stream',
    size: typeof d.size === 'number' ? d.size : 0
  };
}

// Parts: up to 20 attachments per Part (Rev2 - was a single "Drawing" file).
// Each item is the same {path, filename, mimeType, size} shape as any other
// already-uploaded-file pointer in this system.
const PART_ATTACHMENTS_MAX = 20;
function sanitizeOrgDocList(list) {
  const arr = Array.isArray(list) ? list : [];
  return arr.map(sanitizeOrgDoc).filter(Boolean).slice(0, PART_ATTACHMENTS_MAX);
}

async function handleListOrganizations(env, origin) {
  const state = await readJsonArrayFile(env, ORGANIZATIONS_FILE_PATH);
  return json({ organizations: state.items.map(sanitizeOrg) }, 200, origin);
}

function validateOrgFields(body, origin) {
  const name = (body.name || '').toString().trim();
  if (!name) return { error: json({ message: 'Organization name is required.' }, 400, origin) };
  const relationship = (body.relationship || '').toString();
  if (ORG_RELATIONSHIPS.indexOf(relationship) === -1) {
    return { error: json({ message: 'Relationship must be one of: ' + ORG_RELATIONSHIPS.join(', ') + '.' }, 400, origin) };
  }
  const salesEmail = (body.salesEmail || '').toString().trim();
  const purchasingEmail = (body.purchasingEmail || '').toString().trim();
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (salesEmail && !emailPattern.test(salesEmail)) {
    return { error: json({ message: 'That sales email address doesn’t look valid.' }, 400, origin) };
  }
  if (purchasingEmail && !emailPattern.test(purchasingEmail)) {
    return { error: json({ message: 'That purchasing email address doesn’t look valid.' }, 400, origin) };
  }
  const addresses = Array.isArray(body.addresses) ? body.addresses.map(sanitizeOrgAddress).filter(Boolean) : [];
  return {
    name: name,
    relationship: relationship,
    address: (body.address || '').toString().trim(),
    phone: (body.phone || '').toString().trim(),
    website: (body.website || '').toString().trim(),
    addresses: addresses,
    salesEmail: salesEmail,
    purchasingEmail: purchasingEmail
  };
}

async function orgNameTaken(env, name, excludeId) {
  const lower = name.toLowerCase();
  const state = await readJsonArrayFile(env, ORGANIZATIONS_FILE_PATH);
  return state.items.some(function (o) { return o.name && o.name.toLowerCase() === lower && o.id !== excludeId; });
}

// Only one Self organization (Dessimate's own record) should ever exist.
async function selfOrgExists(env, excludeId) {
  const state = await readJsonArrayFile(env, ORGANIZATIONS_FILE_PATH);
  return state.items.some(function (o) { return o.relationship === 'Self' && o.id !== excludeId; });
}

// docs/genericDocs are accepted as-is from the client (already-uploaded file
// pointers - the client uploads bytes via the normal /contents route first,
// then sends back {path, filename, mimeType, size} here). sanitizeOrgDoc
// keeps this to a known, safe shape either way.
async function handleCreateOrganization(request, env, origin) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const fields = validateOrgFields(body, origin);
  if (fields.error) return fields.error;
  if (await orgNameTaken(env, fields.name, null)) return json({ message: 'An organization with that name already exists.' }, 409, origin);
  if (fields.relationship === 'Self' && await selfOrgExists(env, null)) {
    return json({ message: 'A Self organization already exists — edit it instead of creating another.' }, 409, origin);
  }

  const newOrg = {
    id: cryptoRandomId(), name: fields.name, relationship: fields.relationship,
    address: fields.address, phone: fields.phone, website: fields.website,
    logo: sanitizeOrgDoc(body.logo),
    addresses: fields.addresses, salesEmail: fields.salesEmail, purchasingEmail: fields.purchasingEmail,
    docs: {
      companyPresentation: sanitizeOrgDoc(body.docs && body.docs.companyPresentation),
      nda: sanitizeOrgDoc(body.docs && body.docs.nda),
      selfAssessment: sanitizeOrgDoc(body.docs && body.docs.selfAssessment)
    },
    genericDocs: Array.isArray(body.genericDocs) ? body.genericDocs.map(sanitizeOrgDoc).filter(Boolean) : []
  };

  const result = await mutateJsonArrayFile(env, ORGANIZATIONS_FILE_PATH, function (items) {
    items.push(newOrg);
    return { items: items };
  });
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeOrg(newOrg), 201, origin);
}

async function handleUpdateOrganization(request, env, origin, id) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const fields = validateOrgFields(body, origin);
  if (fields.error) return fields.error;

  if (await orgNameTaken(env, fields.name, id)) {
    return json({ message: 'An organization with that name already exists.' }, 409, origin);
  }
  if (fields.relationship === 'Self' && await selfOrgExists(env, id)) {
    return json({ message: 'A Self organization already exists — edit it instead of creating another.' }, 409, origin);
  }

  let saved = null;
  const result = await mutateJsonArrayFile(env, ORGANIZATIONS_FILE_PATH, function (items) {
    const target = items.find(function (o) { return o.id === id; });
    if (!target) return null;
    target.name = fields.name;
    target.relationship = fields.relationship;
    target.address = fields.address;
    target.phone = fields.phone;
    target.website = fields.website;
    target.addresses = fields.addresses;
    target.salesEmail = fields.salesEmail;
    target.purchasingEmail = fields.purchasingEmail;
    if (body.logo !== undefined) {
      target.logo = sanitizeOrgDoc(body.logo);
    }
    if (body.docs !== undefined) {
      target.docs = {
        companyPresentation: sanitizeOrgDoc(body.docs.companyPresentation),
        nda: sanitizeOrgDoc(body.docs.nda),
        selfAssessment: sanitizeOrgDoc(body.docs.selfAssessment)
      };
    }
    if (body.genericDocs !== undefined) {
      target.genericDocs = Array.isArray(body.genericDocs) ? body.genericDocs.map(sanitizeOrgDoc).filter(Boolean) : [];
    }
    saved = target;
    return { items: items };
  }, { requireFound: true });

  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeOrg(saved), 200, origin);
}

async function handleDeleteOrganization(env, origin, id) {
  const result = await mutateJsonArrayFile(env, ORGANIZATIONS_FILE_PATH, function (items) {
    const idx = items.findIndex(function (o) { return o.id === id; });
    if (idx === -1) return null;
    items.splice(idx, 1);
    return { items: items };
  }, { requireFound: true });
  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json({ ok: true }, 200, origin);
}

// ---- parts directory (Part master, linked to a Customer + Suppliers) ------

function sanitizePart(p) {
  // Backward compatibility: a Part saved before Rev2 has only a single
  // "drawing" file, never an "attachments" array. Rather than losing that
  // file the first time an older record is read, it's surfaced as the sole
  // entry of "attachments" so every client only ever needs to look at one
  // field. Once the record is saved again through the new UI it gets a real
  // "attachments" array and this fallback no longer applies to it.
  const attachments = Array.isArray(p.attachments)
    ? sanitizeOrgDocList(p.attachments)
    : (p.drawing ? sanitizeOrgDocList([p.drawing]) : []);
  return {
    id: p.id,
    partNumber: p.partNumber || '',
    customerPartNumber: p.customerPartNumber || '',
    name: p.name || '',
    revision: p.revision || '',
    status: p.status || 'Active',
    drawingNumber: p.drawingNumber || '',
    uom: p.uom || '',
    category: p.category || '',
    notes: p.notes || '',
    customer: p.customer || '',
    suppliers: Array.isArray(p.suppliers) ? p.suppliers.filter(Boolean) : [],
    attachments: attachments
  };
}

// accessLevel/organization scope a Supplier or Customer login down to only
// the Parts their own organization is involved with - a Supplier sees Parts
// they supply, a Customer sees Parts they buy. Any other accessLevel (or no
// scope passed at all, for internal callers) sees every Part, unchanged.
function scopeParts(parts, accessLevel, organization) {
  if (accessLevel === 'supplier') {
    return parts.filter(function (p) { return organization && p.suppliers.indexOf(organization) !== -1; });
  }
  if (accessLevel === 'customer') {
    return parts.filter(function (p) { return organization && p.customer === organization; });
  }
  return parts;
}

async function handleListParts(env, origin, accessLevel, organization) {
  const state = await readJsonArrayFile(env, PARTS_FILE_PATH);
  const parts = scopeParts(state.items.map(sanitizePart), accessLevel, organization);
  return json({ parts: parts }, 200, origin);
}

function validatePartFields(body, origin) {
  const partNumber = (body.partNumber || '').toString().trim();
  if (!partNumber) return { error: json({ message: 'Part Number is required.' }, 400, origin) };
  const status = (body.status || 'Active').toString();
  if (PART_STATUSES.indexOf(status) === -1) {
    return { error: json({ message: 'Status must be one of: ' + PART_STATUSES.join(', ') + '.' }, 400, origin) };
  }
  const suppliers = Array.isArray(body.suppliers)
    ? Array.from(new Set(body.suppliers.map(function (s) { return (s || '').toString().trim(); }).filter(Boolean)))
    : [];
  return {
    partNumber: partNumber,
    customerPartNumber: (body.customerPartNumber || '').toString().trim(),
    name: (body.name || '').toString().trim(),
    revision: (body.revision || '').toString().trim(),
    status: status,
    drawingNumber: (body.drawingNumber || '').toString().trim(),
    uom: (body.uom || '').toString().trim(),
    category: (body.category || '').toString().trim(),
    notes: (body.notes || '').toString().trim(),
    customer: (body.customer || '').toString().trim(),
    suppliers: suppliers
  };
}

async function partNumberTaken(env, partNumber, excludeId) {
  const lower = partNumber.toLowerCase();
  const state = await readJsonArrayFile(env, PARTS_FILE_PATH);
  return state.items.some(function (p) { return p.partNumber && p.partNumber.toLowerCase() === lower && p.id !== excludeId; });
}

// Attachments are accepted as-is from the client (already-uploaded file
// pointers - the client uploads bytes via the normal /contents route first,
// then sends back {path, filename, mimeType, size} for each here), same as
// organization docs. sanitizeOrgDocList keeps this to a known, safe shape
// and caps it at PART_ATTACHMENTS_MAX regardless of what the client sends.
async function handleCreatePart(request, env, origin) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const fields = validatePartFields(body, origin);
  if (fields.error) return fields.error;
  if (await partNumberTaken(env, fields.partNumber, null)) return json({ message: 'A part with that Part Number already exists.' }, 409, origin);

  const newPart = {
    id: cryptoRandomId(), partNumber: fields.partNumber, customerPartNumber: fields.customerPartNumber,
    name: fields.name, revision: fields.revision, status: fields.status, drawingNumber: fields.drawingNumber,
    uom: fields.uom, category: fields.category, notes: fields.notes, customer: fields.customer, suppliers: fields.suppliers,
    attachments: sanitizeOrgDocList(body.attachments)
  };

  const result = await mutateJsonArrayFile(env, PARTS_FILE_PATH, function (items) {
    items.push(newPart);
    return { items: items };
  });
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizePart(newPart), 201, origin);
}

async function handleUpdatePart(request, env, origin, id) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const fields = validatePartFields(body, origin);
  if (fields.error) return fields.error;

  if (await partNumberTaken(env, fields.partNumber, id)) {
    return json({ message: 'A part with that Part Number already exists.' }, 409, origin);
  }

  let saved = null;
  const result = await mutateJsonArrayFile(env, PARTS_FILE_PATH, function (items) {
    const target = items.find(function (p) { return p.id === id; });
    if (!target) return null;
    target.partNumber = fields.partNumber;
    target.customerPartNumber = fields.customerPartNumber;
    target.name = fields.name;
    target.revision = fields.revision;
    target.status = fields.status;
    target.drawingNumber = fields.drawingNumber;
    target.uom = fields.uom;
    target.category = fields.category;
    target.notes = fields.notes;
    target.customer = fields.customer;
    target.suppliers = fields.suppliers;
    if (body.attachments !== undefined) {
      target.attachments = sanitizeOrgDocList(body.attachments);
      // A record moving from the old single-"drawing" shape to the new
      // array now has both fields; "attachments" always wins in
      // sanitizePart, so the stale "drawing" is just dead weight. Drop it
      // so the record doesn't carry two conflicting sources of truth.
      delete target.drawing;
    }
    saved = target;
    return { items: items };
  }, { requireFound: true });

  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizePart(saved), 200, origin);
}

async function handleDeletePart(env, origin, id) {
  const result = await mutateJsonArrayFile(env, PARTS_FILE_PATH, function (items) {
    const idx = items.findIndex(function (p) { return p.id === id; });
    if (idx === -1) return null;
    items.splice(idx, 1);
    return { items: items };
  }, { requireFound: true });
  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json({ ok: true }, 200, origin);
}

// ---- APQP (per-Part checklist of 9 deliverables, each with files + a ------
// running comment log any Team Member can add to - Pre-Production section) -

function emptyApqpItems() {
  const items = {};
  APQP_ITEM_KEYS.forEach(function (key) { items[key] = { files: [], comments: [] }; });
  return items;
}
function sanitizeApqpDoc(d) {
  if (!d || !d.path) return null;
  return {
    id: d.id || null,
    path: d.path,
    filename: d.filename || '',
    mimeType: d.mimeType || 'application/octet-stream',
    size: typeof d.size === 'number' ? d.size : 0
  };
}
function sanitizeApqpComment(c) {
  if (!c) return null;
  return { id: c.id || null, author: c.author || '', text: c.text || '', at: c.at || null };
}
function sanitizeApqpItem(it) {
  const source = it || {};
  return {
    files: Array.isArray(source.files) ? source.files.map(sanitizeApqpDoc).filter(Boolean) : [],
    comments: Array.isArray(source.comments) ? source.comments.map(sanitizeApqpComment).filter(Boolean) : []
  };
}
function sanitizeApqpRecord(o) {
  const items = {};
  APQP_ITEM_KEYS.forEach(function (key) { items[key] = sanitizeApqpItem(o.items && o.items[key]); });
  return {
    id: o.id,
    partNumber: o.partNumber || '',
    partName: o.partName || '',
    createdAt: o.createdAt || null,
    createdBy: o.createdBy || '',
    items: items
  };
}

// APQP records don't carry a supplier/customer of their own - they're keyed
// only by Part Number - so scoping a Supplier/Customer login means first
// looking up which Part Numbers their organization is tied to in the Parts
// master list, then keeping only the APQP records for those parts.
async function handleListApqp(env, origin, accessLevel, organization) {
  const state = await readJsonArrayFile(env, APQP_FILE_PATH);
  let records = state.items.map(sanitizeApqpRecord);
  if (accessLevel === 'supplier' || accessLevel === 'customer') {
    const partsState = await readJsonArrayFile(env, PARTS_FILE_PATH);
    const visibleParts = scopeParts(partsState.items.map(sanitizePart), accessLevel, organization);
    const visiblePartNumbers = new Set(visibleParts.map(function (p) { return (p.partNumber || '').toLowerCase(); }));
    records = records.filter(function (r) { return visiblePartNumbers.has((r.partNumber || '').toLowerCase()); });
  }
  return json({ apqpRecords: records }, 200, origin);
}

async function handleCreateApqp(request, env, origin, username) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const partNumber = (body.partNumber || '').toString().trim();
  if (!partNumber) return json({ message: 'Select a Part.' }, 400, origin);

  const partsState = await readJsonArrayFile(env, PARTS_FILE_PATH);
  const part = partsState.items.find(function (p) { return (p.partNumber || '').toLowerCase() === partNumber.toLowerCase(); });

  const newRecord = {
    id: cryptoRandomId(),
    partNumber: partNumber,
    partName: (part && part.name) || '',
    createdAt: new Date().toISOString(),
    createdBy: username || '',
    items: emptyApqpItems()
  };

  const result = await mutateJsonArrayFile(env, APQP_FILE_PATH, function (items) {
    if (items.some(function (r) { return (r.partNumber || '').toLowerCase() === partNumber.toLowerCase(); })) {
      return { items: items, meta: { duplicate: true } };
    }
    items.push(newRecord);
    return { items: items, meta: { duplicate: false } };
  });
  if (!result.ok) return json({ message: result.message }, 500, origin);
  if (result.meta.duplicate) return json({ message: 'This Part is already on the APQP list.' }, 409, origin);
  return json(sanitizeApqpRecord(newRecord), 201, origin);
}

async function handleDeleteApqp(env, origin, id) {
  const result = await mutateJsonArrayFile(env, APQP_FILE_PATH, function (items) {
    const idx = items.findIndex(function (r) { return r.id === id; });
    if (idx === -1) return null;
    items.splice(idx, 1);
    return { items: items };
  }, { requireFound: true });
  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json({ ok: true }, 200, origin);
}

async function handleUpdateApqpItemFiles(request, env, origin, id, itemKey) {
  if (APQP_ITEM_KEYS.indexOf(itemKey) === -1) return json({ message: 'Unknown APQP item.' }, 400, origin);
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const cleanFiles = (Array.isArray(body.files) ? body.files : []).map(sanitizeApqpDoc).filter(Boolean);

  let savedRecord = null;
  const result = await mutateJsonArrayFile(env, APQP_FILE_PATH, function (items) {
    const target = items.find(function (r) { return r.id === id; });
    if (!target) return null;
    target.items = target.items || {};
    const existing = target.items[itemKey] || { files: [], comments: [] };
    target.items[itemKey] = { files: cleanFiles, comments: existing.comments || [] };
    savedRecord = target;
    return { items: items };
  }, { requireFound: true });
  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeApqpRecord(savedRecord), 200, origin);
}

async function handleAddApqpComment(request, env, origin, id, itemKey, username) {
  if (APQP_ITEM_KEYS.indexOf(itemKey) === -1) return json({ message: 'Unknown APQP item.' }, 400, origin);
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const text = (body.text || '').toString().trim();
  if (!text) return json({ message: 'Comment text is required.' }, 400, origin);

  let savedRecord = null;
  const result = await mutateJsonArrayFile(env, APQP_FILE_PATH, function (items) {
    const target = items.find(function (r) { return r.id === id; });
    if (!target) return null;
    target.items = target.items || {};
    const existing = target.items[itemKey] || { files: [], comments: [] };
    const comment = { id: cryptoRandomId(), author: username || '', text: text, at: new Date().toISOString() };
    target.items[itemKey] = { files: existing.files || [], comments: (existing.comments || []).concat([comment]) };
    savedRecord = target;
    return { items: items };
  }, { requireFound: true });
  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeApqpRecord(savedRecord), 201, origin);
}

// ---- PDIR index (per-record supplier tag for the pre-existing PDIR module,
// which otherwise has no structured metadata at all - see the comment on
// PDIR_INDEX_FILE_PATH above) -------------------------------------------

function sanitizePdirIndexEntry(e) {
  return {
    id: e.id,
    title: e.title || '',
    shipmentNumber: e.shipmentNumber || '',
    organization: e.organization || '',
    partNumber: e.partNumber || '',
    updatedAt: e.updatedAt || null
  };
}

// A Customer login has no relationship to PDIRs (Supplier shipment
// inspections) at all, so it never sees any entries here. A Supplier login
// sees only entries tagged with their own organization.
async function handleListPdirIndex(env, origin, accessLevel, organization) {
  const state = await readJsonArrayFile(env, PDIR_INDEX_FILE_PATH);
  let entries = state.items.map(sanitizePdirIndexEntry);
  if (accessLevel === 'supplier') {
    entries = entries.filter(function (e) { return organization && e.organization === organization; });
  } else if (accessLevel === 'customer') {
    entries = [];
  }
  return json({ pdirIndex: entries }, 200, origin);
}

// Upserts (by title, PDIR's one stable identifier) the tag for a single PDIR
// record. Called by the Form Filler right after it saves a draft or a
// finished PDF, so the index always reflects whatever's actually on GitHub
// without PDIR needing to become a full JSON-array-of-records module itself.
async function handleUpsertPdirIndexEntry(request, env, origin) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const title = (body.title || '').toString().trim();
  if (!title) return json({ message: 'A title is required.' }, 400, origin);
  const fields = {
    title: title,
    shipmentNumber: (body.shipmentNumber || '').toString().trim(),
    organization: (body.organization || '').toString().trim(),
    partNumber: (body.partNumber || '').toString().trim(),
    updatedAt: new Date().toISOString()
  };

  let saved = null;
  const result = await mutateJsonArrayFile(env, PDIR_INDEX_FILE_PATH, function (items) {
    const existing = items.find(function (e) { return (e.title || '').toLowerCase() === title.toLowerCase(); });
    if (existing) {
      Object.assign(existing, fields);
      saved = existing;
    } else {
      saved = Object.assign({ id: cryptoRandomId() }, fields);
      items.push(saved);
    }
    return { items: items };
  });
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizePdirIndexEntry(saved), 200, origin);
}

// Looks up which organization (if any) a PDIR title is tagged with. Used to
// gate a Supplier login's raw /contents/ access to that PDIR's own files
// (pdirs/pdir_drafts/pdir_docs) - see isContentsPathAllowedForExternal.
async function resolvePdirIndexOrganization(env, title) {
  const state = await readJsonArrayFile(env, PDIR_INDEX_FILE_PATH);
  const entry = state.items.find(function (e) { return (e.title || '').toLowerCase() === title.toLowerCase(); });
  return entry ? (entry.organization || '') : '';
}

// Gates the generic /contents/ proxy for a Supplier/Customer login (see the
// comment where this is called). Only the three PDIR file locations - the
// finished PDF, the resumable draft, and its supporting documents/photos -
// are ever reachable, and only for a title this Supplier's own organization
// is tagged as owning in the PDIR index. A Customer login has no PDIR
// relationship at all and never passes this. Everything else in the repo
// (other organizations' PDIRs, drawings, invoices, org/user documents...)
// is refused, even though this proxy has no path allowlist of its own.
async function isContentsPathAllowedForExternal(env, ghPath, accessLevel, organization) {
  if (accessLevel !== 'supplier' || !organization) return false;
  let decoded;
  try { decoded = ghPath.split('/').map(decodeURIComponent).join('/'); } catch (e) { return false; }
  const m = /^pdirs\/(.+)\.pdf$/.exec(decoded) ||
    /^pdir_drafts\/(.+)\.json$/.exec(decoded) ||
    /^pdir_docs\/([^/]+)\/.+$/.exec(decoded);
  if (!m) return false;
  const title = m[1];
  const org = await resolvePdirIndexOrganization(env, title);
  return !!org && org === organization;
}

// ---- customer POs (what a Customer ordered - admin section) ---------------
// Not a PDF generator - a structured header + repeating line-items table
// (the same Part Number legitimately repeats with different dates/
// quantities, per the real samples this was designed from), plus the
// customer's own original PO PDF attached for reference, same upload
// pattern as Organizations/Parts documents. GET is open to any signed-in
// Dessimate user (Team Member+) since the Dessimate PO module needs to look
// up which Customer PO line it's fulfilling; writes are Admin+ only, since
// this is where customer-facing commercial terms/pricing get entered.
const CUSTOMER_POS_FILE_PATH = 'data/customer_pos.json';
const CUSTOMER_PO_DOC_FOLDER = 'customer_po_docs';

function sanitizeCustomerPoLine(l) {
  const qty = Number(l && l.qtyOrdered) || 0;
  const price = Number(l && l.unitPrice) || 0;
  return {
    lineNo: (l && l.lineNo) || '',
    partNumber: (l && l.partNumber) || '',
    description: (l && l.description) || '',
    revision: (l && l.revision) || '',
    uom: (l && l.uom) || '',
    qtyOrdered: qty,
    unitPrice: price,
    extendedPrice: Math.round(qty * price * 100) / 100,
    promisedDeliveryDate: (l && l.promisedDeliveryDate) || ''
  };
}
function sanitizeCustomerPo(o) {
  const lines = Array.isArray(o.lines) ? o.lines.map(sanitizeCustomerPoLine) : [];
  return {
    id: o.id,
    poNumber: o.poNumber || '',
    poDate: o.poDate || '',
    customer: o.customer || '',
    buyerName: o.buyerName || '',
    buyerEmail: o.buyerEmail || '',
    shipTo: o.shipTo || '',
    currency: o.currency || '',
    paymentTerms: o.paymentTerms || '',
    incoterms: o.incoterms || '',
    lines: lines,
    poTotal: Math.round(lines.reduce(function (sum, l) { return sum + l.extendedPrice; }, 0) * 100) / 100,
    sourcePdf: sanitizeOrgDoc(o.sourcePdf),
    createdAt: o.createdAt || null
  };
}

async function handleListCustomerPos(env, origin, accessLevel, organization) {
  const state = await readJsonArrayFile(env, CUSTOMER_POS_FILE_PATH);
  let pos = state.items.map(sanitizeCustomerPo);
  // A Customer login sees only their own POs. A Customer PO is Dessimate's
  // commercial agreement with one specific customer - a Supplier login has
  // no business relationship to it at all, so it sees none of these.
  if (accessLevel === 'customer') {
    pos = pos.filter(function (o) { return organization && o.customer === organization; });
  } else if (accessLevel === 'supplier') {
    pos = [];
  }
  return json({ customerPos: pos }, 200, origin);
}

function validateCustomerPoFields(body, origin) {
  const poNumber = (body.poNumber || '').toString().trim();
  if (!poNumber) return { error: json({ message: 'PO Number is required.' }, 400, origin) };
  const customer = (body.customer || '').toString().trim();
  if (!customer) return { error: json({ message: 'Customer is required.' }, 400, origin) };
  const linesIn = Array.isArray(body.lines) ? body.lines : [];
  const lines = linesIn.map(sanitizeCustomerPoLine).filter(function (l) { return l.partNumber; });
  if (!lines.length) return { error: json({ message: 'Add at least one line item with a Part Number.' }, 400, origin) };
  return {
    poNumber: poNumber,
    poDate: (body.poDate || '').toString().trim(),
    customer: customer,
    buyerName: (body.buyerName || '').toString().trim(),
    buyerEmail: (body.buyerEmail || '').toString().trim(),
    shipTo: (body.shipTo || '').toString().trim(),
    currency: (body.currency || '').toString().trim(),
    paymentTerms: (body.paymentTerms || '').toString().trim(),
    incoterms: (body.incoterms || '').toString().trim(),
    lines: lines
  };
}

async function handleCreateCustomerPo(request, env, origin) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const fields = validateCustomerPoFields(body, origin);
  if (fields.error) return fields.error;

  const newPo = Object.assign({ id: cryptoRandomId(), createdAt: new Date().toISOString(), sourcePdf: sanitizeOrgDoc(body.sourcePdf) }, fields);

  const result = await mutateJsonArrayFile(env, CUSTOMER_POS_FILE_PATH, function (items) {
    items.push(newPo);
    return { items: items };
  });
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeCustomerPo(newPo), 201, origin);
}

async function handleUpdateCustomerPo(request, env, origin, id) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const fields = validateCustomerPoFields(body, origin);
  if (fields.error) return fields.error;

  let saved = null;
  const result = await mutateJsonArrayFile(env, CUSTOMER_POS_FILE_PATH, function (items) {
    const target = items.find(function (o) { return o.id === id; });
    if (!target) return null;
    Object.assign(target, fields);
    if (body.sourcePdf !== undefined) target.sourcePdf = sanitizeOrgDoc(body.sourcePdf);
    saved = target;
    return { items: items };
  }, { requireFound: true });

  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeCustomerPo(saved), 200, origin);
}

async function handleDeleteCustomerPo(env, origin, id) {
  const result = await mutateJsonArrayFile(env, CUSTOMER_POS_FILE_PATH, function (items) {
    const idx = items.findIndex(function (o) { return o.id === id; });
    if (idx === -1) return null;
    items.splice(idx, 1);
    return { items: items };
  }, { requireFound: true });
  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json({ ok: true }, 200, origin);
}

// ---- Dessimate POs (what Dessimate orders from a Supplier, tied to a
// Shipment - the actual PO PDF sent to the supplier, generated server-side
// with pdf-lib so the template lives in one place, never hand-copied into
// the frontend). PO Number and Shipment Number are auto-assigned from
// data/counters.json the moment a Dessimate PO is created - never
// client-supplied, so the sequence can't be skipped or collided (PO Numbers
// continue from 3013; Shipment Numbers use YY-### and roll over to ##-001
// each new calendar year). The Approver + their stamp image appear on this
// PDF only, never the Dessimate Invoice, per the real paper samples this was
// built from. This is a Production Module (not Admin-gated): GET is open to
// any signed-in Dessimate user, writes are Team Member+.
const DESSIMATE_POS_FILE_PATH = 'data/dessimate_pos.json';
const COUNTERS_FILE_PATH = 'data/counters.json';
const DEFAULT_COUNTERS = {
  nextDessimatePoNumber: 3013,
  nextDessimateInvoiceNumber: 3014, // reserved for the Dessimate Invoice module
  shipmentYear: 26,
  nextShipmentSeq: 10
};

function pad2(n) { return String(n).padStart(2, '0'); }
function pad3(n) { return String(n).padStart(3, '0'); }

// Assigns the next PO Number and Shipment Number together (one Dessimate PO
// = one shipment). Rolls the shipment sequence to ##-001 the first time it's
// called in a new calendar year.
async function assignDessimatePoNumbers(env) {
  return reserveDessimatePoNumbers(env, '', '');
}

// Rev2: PO Number and Shipment Number are voluntary/optional - a client can
// supply either or both (already checked for uniqueness by the caller), and
// whichever one is left blank still gets the usual system-assigned value.
// A manually-entered PO Number that's numeric, or a manually-entered
// Shipment Number that parses as "<this year>-<seq>", bumps the matching
// counter past it so the system never later hands out a number that
// collides with (or precedes) one someone typed in by hand.
async function reserveDessimatePoNumbers(env, clientPoNumber, clientShipmentNumber) {
  const nowYear = new Date().getUTCFullYear() % 100;
  const result = await mutateJsonObjectFile(env, COUNTERS_FILE_PATH, DEFAULT_COUNTERS, function (obj) {
    if (obj.shipmentYear !== nowYear) { obj.shipmentYear = nowYear; obj.nextShipmentSeq = 1; }

    let poNumber;
    if (clientPoNumber) {
      poNumber = /^\d+$/.test(clientPoNumber) ? Number(clientPoNumber) : clientPoNumber;
      if (typeof poNumber === 'number' && poNumber >= obj.nextDessimatePoNumber) obj.nextDessimatePoNumber = poNumber + 1;
    } else {
      poNumber = obj.nextDessimatePoNumber;
      obj.nextDessimatePoNumber = poNumber + 1;
    }

    let shipmentNumber;
    if (clientShipmentNumber) {
      shipmentNumber = clientShipmentNumber;
      const m = /^(\d{2})-(\d+)$/.exec(clientShipmentNumber);
      if (m && Number(m[1]) === obj.shipmentYear) {
        const seq = Number(m[2]);
        if (seq >= obj.nextShipmentSeq) obj.nextShipmentSeq = seq + 1;
      }
    } else {
      shipmentNumber = pad2(obj.shipmentYear) + '-' + pad3(obj.nextShipmentSeq);
      obj.nextShipmentSeq = obj.nextShipmentSeq + 1;
    }

    return { obj: obj, meta: { poNumber: poNumber, shipmentNumber: shipmentNumber } };
  });
  if (!result.ok) throw new Error(result.message);
  return result.meta;
}

// Non-mutating preview of what the "Use System Number" button would assign -
// reads data/counters.json but never writes it, so looking doesn't cost a
// number the way actually creating the PO would.
async function handlePeekDessimatePoNumbers(env, origin) {
  const nowYear = new Date().getUTCFullYear() % 100;
  const state = await readJsonObjectFile(env, COUNTERS_FILE_PATH, DEFAULT_COUNTERS);
  const obj = state.obj;
  const year = obj.shipmentYear === nowYear ? obj.shipmentYear : nowYear;
  const seq = obj.shipmentYear === nowYear ? obj.nextShipmentSeq : 1;
  return json({ poNumber: obj.nextDessimatePoNumber, shipmentNumber: pad2(year) + '-' + pad3(seq) }, 200, origin);
}

async function dessimatePoNumberTaken(env, poNumber, excludeId) {
  const state = await readJsonArrayFile(env, DESSIMATE_POS_FILE_PATH);
  const target = String(poNumber).toLowerCase();
  return state.items.some(function (o) { return o.id !== excludeId && String(o.poNumber).toLowerCase() === target; });
}
async function dessimateShipmentNumberTaken(env, shipmentNumber, excludeId) {
  const state = await readJsonArrayFile(env, DESSIMATE_POS_FILE_PATH);
  const target = String(shipmentNumber).toLowerCase();
  return state.items.some(function (o) { return o.id !== excludeId && String(o.shipmentNumber).toLowerCase() === target; });
}

function sanitizeDessimatePoLine(l) {
  const qty = Number(l && l.qtyOrdered) || 0;
  const price = Number(l && l.unitPrice) || 0;
  return {
    lineNo: (l && l.lineNo) || '',
    partNumber: (l && l.partNumber) || '',
    description: (l && l.description) || '',
    revision: (l && l.revision) || '',
    uom: (l && l.uom) || '',
    qtyOrdered: qty,
    unitPrice: price,
    extendedPrice: Math.round(qty * price * 100) / 100,
    requestedDeliveryDate: (l && l.requestedDeliveryDate) || ''
  };
}
function sanitizeDessimatePo(o) {
  const lines = Array.isArray(o.lines) ? o.lines.map(sanitizeDessimatePoLine) : [];
  return {
    id: o.id,
    poNumber: o.poNumber,
    shipmentNumber: o.shipmentNumber || '',
    poDate: o.poDate || '',
    supplier: o.supplier || '',
    customerPoRef: o.customerPoRef || '',
    shipTo: o.shipTo || '',
    currency: o.currency || '',
    paymentTerms: o.paymentTerms || '',
    incoterms: o.incoterms || '',
    lines: lines,
    poTotal: Math.round(lines.reduce(function (sum, l) { return sum + l.extendedPrice; }, 0) * 100) / 100,
    approverUsername: o.approverUsername || '',
    approverName: o.approverName || '',
    relatedPoIds: Array.isArray(o.relatedPoIds) ? o.relatedPoIds.filter(Boolean) : [],
    createdAt: o.createdAt || null
  };
}

// Keeps "related Dessimate PO" links symmetric: if A lists B as related, B
// must also list A, and if A drops B the reverse link is dropped too -
// otherwise the two sides could silently disagree about a relationship that
// only makes sense as mutual. Called with the full in-memory items array
// from inside a mutateJsonArrayFile callback (so the whole file is rewritten
// consistently in one commit), the id of the PO being saved, and the new
// list of ids it should relate to. Unknown ids, self-references and
// duplicates are dropped; the validated list is both applied to the target
// PO and returned.
function syncRelatedPoLinks(items, poId, requestedIds) {
  const poIdSet = new Set(items.map(function (o) { return o.id; }));
  const validNew = Array.from(new Set((requestedIds || [])
    .map(function (v) { return (v || '').toString(); })
    .filter(function (id) { return id && id !== poId && poIdSet.has(id); })));
  const validNewSet = new Set(validNew);
  items.forEach(function (o) {
    if (o.id === poId) return;
    const rel = Array.isArray(o.relatedPoIds) ? o.relatedPoIds.slice() : [];
    const has = rel.indexOf(poId) !== -1;
    const should = validNewSet.has(o.id);
    if (should && !has) rel.push(poId);
    if (!should && has) rel.splice(rel.indexOf(poId), 1);
    o.relatedPoIds = rel;
  });
  const target = items.find(function (o) { return o.id === poId; });
  if (target) target.relatedPoIds = validNew;
  return validNew;
}

// A Supplier login sees only Dessimate POs issued to their own organization,
// and never learns which Customer PO it's fulfilling (customerPoRef is
// Dessimate's own commercial relationship with its Customer - not the
// Supplier's business). A Customer login has no relationship to a Dessimate
// PO at all (that's Dessimate <-> Supplier, not Dessimate <-> Customer), so
// it sees none of these.
function scopeDessimatePos(pos, accessLevel, organization) {
  if (accessLevel === 'supplier') {
    const visible = pos.filter(function (o) { return organization && o.supplier === organization; });
    // A related PO could belong to a different Supplier that this login has
    // no visibility into at all - trimming relatedPoIds down to only what's
    // in this same visible set keeps a Supplier login from learning that
    // some other organization's PO even exists, the same way customerPoRef
    // is already stripped for this accessLevel just below.
    const visibleIds = new Set(visible.map(function (o) { return o.id; }));
    return visible.map(function (o) {
      const copy = Object.assign({}, o);
      delete copy.customerPoRef;
      copy.relatedPoIds = (Array.isArray(o.relatedPoIds) ? o.relatedPoIds : []).filter(function (id) { return visibleIds.has(id); });
      return copy;
    });
  }
  if (accessLevel === 'customer') return [];
  return pos;
}

async function handleListDessimatePos(env, origin, accessLevel, organization) {
  const state = await readJsonArrayFile(env, DESSIMATE_POS_FILE_PATH);
  const pos = scopeDessimatePos(state.items.map(sanitizeDessimatePo), accessLevel, organization);
  return json({ dessimatePos: pos }, 200, origin);
}

function validateDessimatePoFields(body, origin) {
  const supplier = (body.supplier || '').toString().trim();
  if (!supplier) return { error: json({ message: 'Supplier is required.' }, 400, origin) };
  const linesIn = Array.isArray(body.lines) ? body.lines : [];
  const lines = linesIn.map(sanitizeDessimatePoLine).filter(function (l) { return l.partNumber; });
  if (!lines.length) return { error: json({ message: 'Add at least one line item with a Part Number.' }, 400, origin) };
  return {
    poDate: (body.poDate || '').toString().trim(),
    supplier: supplier,
    customerPoRef: (body.customerPoRef || '').toString().trim(),
    shipTo: (body.shipTo || '').toString().trim(),
    currency: (body.currency || '').toString().trim(),
    paymentTerms: (body.paymentTerms || '').toString().trim(),
    incoterms: (body.incoterms || '').toString().trim(),
    lines: lines,
    approverUsername: (body.approverUsername || '').toString().trim(),
    approverName: (body.approverName || '').toString().trim(),
    relatedPoIds: Array.isArray(body.relatedPoIds)
      ? Array.from(new Set(body.relatedPoIds.map(function (v) { return (v || '').toString(); }).filter(Boolean)))
      : []
  };
}

async function handleCreateDessimatePo(request, env, origin) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const fields = validateDessimatePoFields(body, origin);
  if (fields.error) return fields.error;

  // PO Number and Shipment Number are voluntary (Rev2) - leave either blank
  // for the usual system-assigned value, or type one in. A typed-in value
  // still has to be unique; the counter itself is bumped past it inside
  // reserveDessimatePoNumbers so the system never later collides with it.
  const clientPoNumber = (body.poNumber !== undefined && body.poNumber !== null) ? String(body.poNumber).trim() : '';
  const clientShipmentNumber = (body.shipmentNumber !== undefined && body.shipmentNumber !== null) ? String(body.shipmentNumber).trim() : '';
  if (clientPoNumber && await dessimatePoNumberTaken(env, clientPoNumber, null)) {
    return json({ message: 'That PO Number is already in use.' }, 409, origin);
  }
  if (clientShipmentNumber && await dessimateShipmentNumberTaken(env, clientShipmentNumber, null)) {
    return json({ message: 'That Shipment Number is already in use.' }, 409, origin);
  }

  const numbers = await reserveDessimatePoNumbers(env, clientPoNumber, clientShipmentNumber);
  const newPo = Object.assign(
    { id: cryptoRandomId(), createdAt: new Date().toISOString(), poNumber: numbers.poNumber, shipmentNumber: numbers.shipmentNumber },
    fields
  );

  const result = await mutateJsonArrayFile(env, DESSIMATE_POS_FILE_PATH, function (items) {
    items.push(newPo);
    syncRelatedPoLinks(items, newPo.id, fields.relatedPoIds);
    return { items: items };
  });
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeDessimatePo(newPo), 201, origin);
}

async function handleUpdateDessimatePo(request, env, origin, id) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const fields = validateDessimatePoFields(body, origin);
  if (fields.error) return fields.error;

  let saved = null;
  const result = await mutateJsonArrayFile(env, DESSIMATE_POS_FILE_PATH, function (items) {
    const target = items.find(function (o) { return o.id === id; });
    if (!target) return null;
    Object.assign(target, fields); // poNumber/shipmentNumber are never in `fields` - immutable once assigned
    syncRelatedPoLinks(items, id, fields.relatedPoIds);
    saved = target;
    return { items: items };
  }, { requireFound: true });

  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeDessimatePo(saved), 200, origin);
}

async function handleDeleteDessimatePo(env, origin, id) {
  const result = await mutateJsonArrayFile(env, DESSIMATE_POS_FILE_PATH, function (items) {
    const idx = items.findIndex(function (o) { return o.id === id; });
    if (idx === -1) return null;
    items.splice(idx, 1);
    // A deleted PO can't stay "related" from the other side either.
    items.forEach(function (o) {
      if (!Array.isArray(o.relatedPoIds)) return;
      const i = o.relatedPoIds.indexOf(id);
      if (i !== -1) o.relatedPoIds.splice(i, 1);
    });
    return { items: items };
  }, { requireFound: true });
  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json({ ok: true }, 200, origin);
}

// ---- Dessimate PO PDF generation (backend template - pdf-lib) -------------

function money2(n) { const v = Number(n) || 0; return v.toFixed(2); }

async function buildDessimatePoPdf(po, selfOrg, stampBytes) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 612, pageHeight = 792; // US Letter
  const margin = 40;
  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  function ensureSpace(h) {
    if (y - h < margin + 40) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }
  }
  function text(str, x, size, opts) {
    opts = opts || {};
    page.drawText(str == null ? '' : String(str), { x: x, y: y, size: size, font: opts.bold ? fontBold : font, color: rgb(0.1, 0.1, 0.12) });
  }
  function textAt(str, x, yy, size, opts) {
    opts = opts || {};
    page.drawText(str == null ? '' : String(str), { x: x, y: yy, size: size, font: opts.bold ? fontBold : font, color: rgb(0.1, 0.1, 0.12) });
  }
  function hr() {
    page.drawLine({ start: { x: margin, y: y }, end: { x: pageWidth - margin, y: y }, thickness: 0.75, color: rgb(0.7, 0.7, 0.75) });
  }

  // ---- Header: Self org letterhead (left) + PO identity block (right) ----
  const headerTop = y;
  text((selfOrg && selfOrg.name) || 'Dessimate LLC', margin, 18, { bold: true });
  y -= 20;
  const selfAddr = (selfOrg && Array.isArray(selfOrg.addresses) && selfOrg.addresses[0]) ? selfOrg.addresses[0].address : '';
  if (selfAddr) { text(selfAddr, margin, 9); y -= 12; }
  if (selfOrg && selfOrg.purchasingEmail) { text('Purchasing: ' + selfOrg.purchasingEmail, margin, 9); y -= 12; }

  const rightX = pageWidth - margin - 190;
  let ry = headerTop;
  textAt('PURCHASE ORDER', rightX, ry, 14, { bold: true }); ry -= 18;
  textAt('PO Number: ' + po.poNumber, rightX, ry, 10, { bold: true }); ry -= 14;
  textAt('Shipment #: ' + po.shipmentNumber, rightX, ry, 10, { bold: true }); ry -= 14;
  textAt('PO Date: ' + (po.poDate || ''), rightX, ry, 10); ry -= 14;
  if (po.customerPoRef) { textAt('Customer PO Ref: ' + po.customerPoRef, rightX, ry, 9); ry -= 14; }

  y = Math.min(y, ry) - 10;
  hr(); y -= 18;

  // ---- Supplier / Ship To / Terms ----
  text('Supplier:', margin, 10, { bold: true }); text(po.supplier || '', margin + 70, 10); y -= 14;
  text('Ship To:', margin, 10, { bold: true }); text(po.shipTo || '', margin + 70, 10); y -= 14;
  text('Currency:', margin, 10, { bold: true }); text(po.currency || '', margin + 70, 10);
  textAt('Payment Terms:', margin + 220, y + 14, 10, { bold: true }); textAt(po.paymentTerms || '', margin + 320, y + 14, 10);
  y -= 14;
  text('Incoterms:', margin, 10, { bold: true }); text(po.incoterms || '', margin + 70, 10); y -= 20;
  hr(); y -= 16;

  // ---- Line items table ----
  const cols = [
    { key: 'partNumber', label: 'Part #', x: margin, w: 88 },
    { key: 'description', label: 'Description', x: margin + 90, w: 138 },
    { key: 'uom', label: 'UOM', x: margin + 232, w: 32 },
    { key: 'qtyOrdered', label: 'Qty', x: margin + 268, w: 40, right: true },
    { key: 'unitPrice', label: 'Unit Price', x: margin + 310, w: 58, right: true },
    { key: 'extendedPrice', label: 'Ext. Price', x: margin + 372, w: 58, right: true },
    { key: 'requestedDeliveryDate', label: 'Requested', x: margin + 434, w: 98 }
  ];
  cols.forEach(function (c) {
    const lx = c.right ? c.x + c.w - fontBold.widthOfTextAtSize(c.label, 9) : c.x;
    textAt(c.label, lx, y, 9, { bold: true });
  });
  y -= 6; hr(); y -= 14;

  po.lines.forEach(function (l) {
    ensureSpace(18);
    cols.forEach(function (c) {
      let v = l[c.key];
      if (c.key === 'unitPrice' || c.key === 'extendedPrice') v = money2(v);
      const s = v == null ? '' : String(v);
      const vx = c.right ? c.x + c.w - font.widthOfTextAtSize(s, 9) : c.x;
      textAt(s, vx, y, 9);
    });
    y -= 16;
  });
  y -= 4; hr(); y -= 20;

  textAt('PO Total: ' + (po.currency || '') + ' ' + money2(po.poTotal), pageWidth - margin - 200, y, 12, { bold: true });
  y -= 46;

  // ---- Approver + stamp (PO only - never the Dessimate Invoice) ----
  ensureSpace(90);
  text('Approved by:', margin, 10, { bold: true });
  text(po.approverName || po.approverUsername || '', margin + 90, 10);
  y -= 66;
  if (stampBytes) {
    try {
      let img;
      try { img = await pdfDoc.embedPng(stampBytes); } catch (e) { img = await pdfDoc.embedJpg(stampBytes); }
      const dims = img.scaleToFit(120, 60);
      page.drawImage(img, { x: margin, y: y, width: dims.width, height: dims.height });
    } catch (e) { /* stamp image unreadable/unsupported format - leave the PO unstamped rather than fail generation */ }
  }

  return pdfDoc.save();
}

async function handleGenerateDessimatePoPdf(env, origin, id, accessLevel, organization) {
  const state = await readJsonArrayFile(env, DESSIMATE_POS_FILE_PATH);
  const po = state.items.find(function (o) { return o.id === id; });
  if (!po) return json({ message: 'Not found.' }, 404, origin);
  let clean = sanitizeDessimatePo(po);
  // Same scoping as the list route - a Customer login has no relationship to
  // a Dessimate PO, and a Supplier can only pull the PDF for their own PO
  // (and never sees the Customer PO reference on it).
  const scoped = scopeDessimatePos([clean], accessLevel, organization);
  if (!scoped.length) return json({ message: 'Not found.' }, 404, origin);
  clean = scoped[0];

  const orgState = await readJsonArrayFile(env, ORGANIZATIONS_FILE_PATH);
  const selfOrg = orgState.items.map(sanitizeOrg).find(function (o) { return o.relationship === 'Self'; }) || null;

  let stampBytes = null;
  if (clean.approverUsername) {
    const usersState = await readUsersFile(env);
    const approver = usersState.users.find(function (u) { return u.username === clean.approverUsername; });
    if (approver && approver.stampImage && approver.stampImage.path) {
      try { stampBytes = await readGithubFileBytes(env, approver.stampImage.path); } catch (e) { stampBytes = null; }
    }
  }

  let pdfBytes;
  try {
    pdfBytes = await buildDessimatePoPdf(clean, selfOrg, stampBytes);
  } catch (e) {
    return json({ message: 'Could not generate PDF: ' + (e && e.message ? e.message : e) }, 500, origin);
  }
  return pdfResponse(pdfBytes, 'Dessimate PO ' + clean.poNumber + '.pdf', origin);
}

// ---- Supplier Invoices (what a Supplier bills Dessimate against a
// Dessimate PO) - a structured header + repeating line-items table, plus the
// supplier's own original invoice PDF attached for reference, same
// upload/attach pattern as Customer POs. Not a PDF generator - the supplier
// writes the real invoice, Dessimate just files it and tracks payment status.
// A Production Module like Dessimate PO: GET is open to any signed-in
// Dessimate user, writes are Team Member+.
const SUPPLIER_INVOICES_FILE_PATH = 'data/supplier_invoices.json';
const SUPPLIER_INVOICE_STATUSES = ['Unpaid', 'Paid'];

function sanitizeSupplierInvoiceLine(l) {
  const qty = Number(l && l.qtyInvoiced) || 0;
  const price = Number(l && l.unitPrice) || 0;
  return {
    lineNo: (l && l.lineNo) || '',
    partNumber: (l && l.partNumber) || '',
    description: (l && l.description) || '',
    uom: (l && l.uom) || '',
    qtyInvoiced: qty,
    unitPrice: price,
    extendedPrice: Math.round(qty * price * 100) / 100
  };
}
function sanitizeSupplierInvoice(o) {
  const lines = Array.isArray(o.lines) ? o.lines.map(sanitizeSupplierInvoiceLine) : [];
  return {
    id: o.id,
    invoiceNumber: o.invoiceNumber || '',
    invoiceDate: o.invoiceDate || '',
    dueDate: o.dueDate || '',
    supplier: o.supplier || '',
    dessimatePoRef: o.dessimatePoRef || '',
    currency: o.currency || '',
    paymentTerms: o.paymentTerms || '',
    status: SUPPLIER_INVOICE_STATUSES.indexOf(o.status) !== -1 ? o.status : 'Unpaid',
    lines: lines,
    invoiceTotal: Math.round(lines.reduce(function (sum, l) { return sum + l.extendedPrice; }, 0) * 100) / 100,
    sourcePdf: sanitizeOrgDoc(o.sourcePdf),
    createdAt: o.createdAt || null
  };
}

async function handleListSupplierInvoices(env, origin, accessLevel, organization) {
  const state = await readJsonArrayFile(env, SUPPLIER_INVOICES_FILE_PATH);
  let invoices = state.items.map(sanitizeSupplierInvoice);
  // A Supplier login sees only invoices they themselves submitted. What
  // Dessimate pays a Supplier has no bearing on a Customer login, so a
  // Customer sees none of these.
  if (accessLevel === 'supplier') {
    invoices = invoices.filter(function (o) { return organization && o.supplier === organization; });
  } else if (accessLevel === 'customer') {
    invoices = [];
  }
  return json({ supplierInvoices: invoices }, 200, origin);
}

function validateSupplierInvoiceFields(body, origin) {
  const invoiceNumber = (body.invoiceNumber || '').toString().trim();
  if (!invoiceNumber) return { error: json({ message: 'Invoice Number is required.' }, 400, origin) };
  const supplier = (body.supplier || '').toString().trim();
  if (!supplier) return { error: json({ message: 'Supplier is required.' }, 400, origin) };
  const linesIn = Array.isArray(body.lines) ? body.lines : [];
  const lines = linesIn.map(sanitizeSupplierInvoiceLine).filter(function (l) { return l.partNumber; });
  if (!lines.length) return { error: json({ message: 'Add at least one line item with a Part Number.' }, 400, origin) };
  const status = SUPPLIER_INVOICE_STATUSES.indexOf(body.status) !== -1 ? body.status : 'Unpaid';
  return {
    invoiceNumber: invoiceNumber,
    invoiceDate: (body.invoiceDate || '').toString().trim(),
    dueDate: (body.dueDate || '').toString().trim(),
    supplier: supplier,
    dessimatePoRef: (body.dessimatePoRef || '').toString().trim(),
    currency: (body.currency || '').toString().trim(),
    paymentTerms: (body.paymentTerms || '').toString().trim(),
    status: status,
    lines: lines
  };
}

async function handleCreateSupplierInvoice(request, env, origin) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const fields = validateSupplierInvoiceFields(body, origin);
  if (fields.error) return fields.error;

  const newInv = Object.assign({ id: cryptoRandomId(), createdAt: new Date().toISOString(), sourcePdf: sanitizeOrgDoc(body.sourcePdf) }, fields);

  const result = await mutateJsonArrayFile(env, SUPPLIER_INVOICES_FILE_PATH, function (items) {
    items.push(newInv);
    return { items: items };
  });
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeSupplierInvoice(newInv), 201, origin);
}

async function handleUpdateSupplierInvoice(request, env, origin, id) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const fields = validateSupplierInvoiceFields(body, origin);
  if (fields.error) return fields.error;

  let saved = null;
  const result = await mutateJsonArrayFile(env, SUPPLIER_INVOICES_FILE_PATH, function (items) {
    const target = items.find(function (o) { return o.id === id; });
    if (!target) return null;
    Object.assign(target, fields);
    if (body.sourcePdf !== undefined) target.sourcePdf = sanitizeOrgDoc(body.sourcePdf);
    saved = target;
    return { items: items };
  }, { requireFound: true });

  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeSupplierInvoice(saved), 200, origin);
}

async function handleDeleteSupplierInvoice(env, origin, id) {
  const result = await mutateJsonArrayFile(env, SUPPLIER_INVOICES_FILE_PATH, function (items) {
    const idx = items.findIndex(function (o) { return o.id === id; });
    if (idx === -1) return null;
    items.splice(idx, 1);
    return { items: items };
  }, { requireFound: true });
  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json({ ok: true }, 200, origin);
}

// ---- Dessimate Invoices (what Dessimate bills a Customer, generated
// server-side with pdf-lib - same backend-template approach as Dessimate
// POs). Invoice Number is auto-assigned from data/counters.json (continuing
// from 3014) - never client-supplied. Unlike the Dessimate PO, this PDF
// carries NO approver stamp (the user explicitly confirmed the stamp is
// PO-only) and uses the Self organization's Sales Email rather than
// Purchasing Email. Admin section: writes are Admin+ (matches Customer PO),
// GET is open to any signed-in Dessimate user. Delete is soft (status flag,
// not row removal) so the invoice number sequence stays intact for audit -
// a deleted invoice is simply hidden from the normal list.
const DESSIMATE_INVOICES_FILE_PATH = 'data/dessimate_invoices.json';
const DESSIMATE_INVOICE_STATUSES = ['Unpaid', 'Paid'];

async function assignDessimateInvoiceNumber(env) {
  return reserveDessimateInvoiceNumber(env, '');
}

// Rev2: Invoice Number is voluntary/optional, same pattern as the Dessimate
// PO's PO Number/Shipment Number - see reserveDessimatePoNumbers.
async function reserveDessimateInvoiceNumber(env, clientInvoiceNumber) {
  const result = await mutateJsonObjectFile(env, COUNTERS_FILE_PATH, DEFAULT_COUNTERS, function (obj) {
    let invoiceNumber;
    if (clientInvoiceNumber) {
      invoiceNumber = /^\d+$/.test(clientInvoiceNumber) ? Number(clientInvoiceNumber) : clientInvoiceNumber;
      if (typeof invoiceNumber === 'number' && invoiceNumber >= obj.nextDessimateInvoiceNumber) obj.nextDessimateInvoiceNumber = invoiceNumber + 1;
    } else {
      invoiceNumber = obj.nextDessimateInvoiceNumber;
      obj.nextDessimateInvoiceNumber = invoiceNumber + 1;
    }
    return { obj: obj, meta: { invoiceNumber: invoiceNumber } };
  });
  if (!result.ok) throw new Error(result.message);
  return result.meta.invoiceNumber;
}

// Non-mutating preview for the Add-Dessimate-Invoice modal's "Use System
// Number" button - see handlePeekDessimatePoNumbers.
async function handlePeekDessimateInvoiceNumber(env, origin) {
  const state = await readJsonObjectFile(env, COUNTERS_FILE_PATH, DEFAULT_COUNTERS);
  return json({ invoiceNumber: state.obj.nextDessimateInvoiceNumber }, 200, origin);
}

async function dessimateInvoiceNumberTaken(env, invoiceNumber, excludeId) {
  const state = await readJsonArrayFile(env, DESSIMATE_INVOICES_FILE_PATH);
  const target = String(invoiceNumber).toLowerCase();
  return state.items.some(function (o) { return o.id !== excludeId && String(o.invoiceNumber).toLowerCase() === target; });
}

function sanitizeDessimateInvoiceLine(l) {
  const qty = Number(l && l.qtyShipped) || 0;
  const price = Number(l && l.unitPrice) || 0;
  return {
    lineNo: (l && l.lineNo) || '',
    partNumber: (l && l.partNumber) || '',
    description: (l && l.description) || '',
    revision: (l && l.revision) || '',
    uom: (l && l.uom) || '',
    qtyShipped: qty,
    unitPrice: price,
    extendedPrice: Math.round(qty * price * 100) / 100
  };
}
function sanitizeDessimateInvoice(o) {
  const lines = Array.isArray(o.lines) ? o.lines.map(sanitizeDessimateInvoiceLine) : [];
  return {
    id: o.id,
    invoiceNumber: o.invoiceNumber,
    invoiceDate: o.invoiceDate || '',
    customer: o.customer || '',
    customerPoRef: o.customerPoRef || '',
    shipTo: o.shipTo || '',
    currency: o.currency || '',
    paymentTerms: o.paymentTerms || '',
    incoterms: o.incoterms || '',
    status: DESSIMATE_INVOICE_STATUSES.indexOf(o.status) !== -1 ? o.status : 'Unpaid',
    deleted: !!o.deleted,
    deletedAt: o.deletedAt || null,
    lines: lines,
    invoiceTotal: Math.round(lines.reduce(function (sum, l) { return sum + l.extendedPrice; }, 0) * 100) / 100,
    createdAt: o.createdAt || null
  };
}

function scopeDessimateInvoices(invoices, accessLevel, organization) {
  // A Customer login sees only invoices billed to their own organization.
  // A Dessimate Invoice bills a Customer, not a Supplier, so a Supplier
  // login has no relationship to it at all.
  if (accessLevel === 'customer') {
    return invoices.filter(function (o) { return organization && o.customer === organization; });
  }
  if (accessLevel === 'supplier') return [];
  return invoices;
}

async function handleListDessimateInvoices(env, origin, accessLevel, organization) {
  const state = await readJsonArrayFile(env, DESSIMATE_INVOICES_FILE_PATH);
  const visible = state.items.filter(function (o) { return !o.deleted; });
  const invoices = scopeDessimateInvoices(visible.map(sanitizeDessimateInvoice), accessLevel, organization);
  return json({ dessimateInvoices: invoices }, 200, origin);
}

function validateDessimateInvoiceFields(body, origin) {
  const customer = (body.customer || '').toString().trim();
  if (!customer) return { error: json({ message: 'Customer is required.' }, 400, origin) };
  const linesIn = Array.isArray(body.lines) ? body.lines : [];
  const lines = linesIn.map(sanitizeDessimateInvoiceLine).filter(function (l) { return l.partNumber; });
  if (!lines.length) return { error: json({ message: 'Add at least one line item with a Part Number.' }, 400, origin) };
  const status = DESSIMATE_INVOICE_STATUSES.indexOf(body.status) !== -1 ? body.status : 'Unpaid';
  return {
    invoiceDate: (body.invoiceDate || '').toString().trim(),
    customer: customer,
    customerPoRef: (body.customerPoRef || '').toString().trim(),
    shipTo: (body.shipTo || '').toString().trim(),
    currency: (body.currency || '').toString().trim(),
    paymentTerms: (body.paymentTerms || '').toString().trim(),
    incoterms: (body.incoterms || '').toString().trim(),
    status: status,
    lines: lines
  };
}

async function handleCreateDessimateInvoice(request, env, origin) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const fields = validateDessimateInvoiceFields(body, origin);
  if (fields.error) return fields.error;

  const clientInvoiceNumber = (body.invoiceNumber !== undefined && body.invoiceNumber !== null) ? String(body.invoiceNumber).trim() : '';
  if (clientInvoiceNumber && await dessimateInvoiceNumberTaken(env, clientInvoiceNumber, null)) {
    return json({ message: 'That Invoice Number is already in use.' }, 409, origin);
  }
  const invoiceNumber = await reserveDessimateInvoiceNumber(env, clientInvoiceNumber);
  const newInv = Object.assign(
    { id: cryptoRandomId(), createdAt: new Date().toISOString(), invoiceNumber: invoiceNumber, deleted: false, deletedAt: null },
    fields
  );

  const result = await mutateJsonArrayFile(env, DESSIMATE_INVOICES_FILE_PATH, function (items) {
    items.push(newInv);
    return { items: items };
  });
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeDessimateInvoice(newInv), 201, origin);
}

async function handleUpdateDessimateInvoice(request, env, origin, id) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const fields = validateDessimateInvoiceFields(body, origin);
  if (fields.error) return fields.error;

  let saved = null;
  const result = await mutateJsonArrayFile(env, DESSIMATE_INVOICES_FILE_PATH, function (items) {
    const target = items.find(function (o) { return o.id === id; });
    if (!target) return null;
    Object.assign(target, fields); // invoiceNumber is never in `fields` - immutable once assigned
    saved = target;
    return { items: items };
  }, { requireFound: true });

  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeDessimateInvoice(saved), 200, origin);
}

async function handleDeleteDessimateInvoice(env, origin, id) {
  let saved = null;
  const result = await mutateJsonArrayFile(env, DESSIMATE_INVOICES_FILE_PATH, function (items) {
    const target = items.find(function (o) { return o.id === id; });
    if (!target) return null;
    target.deleted = true;
    target.deletedAt = new Date().toISOString();
    saved = target;
    return { items: items };
  }, { requireFound: true });
  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json({ ok: true }, 200, origin);
}

async function buildDessimateInvoicePdf(inv, selfOrg) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 612, pageHeight = 792; // US Letter
  const margin = 40;
  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  function ensureSpace(h) {
    if (y - h < margin + 40) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }
  }
  function text(str, x, size, opts) {
    opts = opts || {};
    page.drawText(str == null ? '' : String(str), { x: x, y: y, size: size, font: opts.bold ? fontBold : font, color: rgb(0.1, 0.1, 0.12) });
  }
  function textAt(str, x, yy, size, opts) {
    opts = opts || {};
    page.drawText(str == null ? '' : String(str), { x: x, y: yy, size: size, font: opts.bold ? fontBold : font, color: rgb(0.1, 0.1, 0.12) });
  }
  function hr() {
    page.drawLine({ start: { x: margin, y: y }, end: { x: pageWidth - margin, y: y }, thickness: 0.75, color: rgb(0.7, 0.7, 0.75) });
  }

  // ---- Header: Self org letterhead (left) + Invoice identity block (right) ----
  const headerTop = y;
  text((selfOrg && selfOrg.name) || 'Dessimate LLC', margin, 18, { bold: true });
  y -= 20;
  const selfAddr = (selfOrg && Array.isArray(selfOrg.addresses) && selfOrg.addresses[0]) ? selfOrg.addresses[0].address : '';
  if (selfAddr) { text(selfAddr, margin, 9); y -= 12; }
  if (selfOrg && selfOrg.salesEmail) { text('Sales: ' + selfOrg.salesEmail, margin, 9); y -= 12; }

  const rightX = pageWidth - margin - 190;
  let ry = headerTop;
  textAt('INVOICE', rightX, ry, 14, { bold: true }); ry -= 18;
  textAt('Invoice Number: ' + inv.invoiceNumber, rightX, ry, 10, { bold: true }); ry -= 14;
  textAt('Invoice Date: ' + (inv.invoiceDate || ''), rightX, ry, 10); ry -= 14;
  if (inv.customerPoRef) { textAt('Customer PO Ref: ' + inv.customerPoRef, rightX, ry, 9); ry -= 14; }

  y = Math.min(y, ry) - 10;
  hr(); y -= 18;

  // ---- Customer / Ship To / Terms ----
  text('Bill To:', margin, 10, { bold: true }); text(inv.customer || '', margin + 70, 10); y -= 14;
  text('Ship To:', margin, 10, { bold: true }); text(inv.shipTo || '', margin + 70, 10); y -= 14;
  text('Currency:', margin, 10, { bold: true }); text(inv.currency || '', margin + 70, 10);
  textAt('Payment Terms:', margin + 220, y + 14, 10, { bold: true }); textAt(inv.paymentTerms || '', margin + 320, y + 14, 10);
  y -= 14;
  text('Incoterms:', margin, 10, { bold: true }); text(inv.incoterms || '', margin + 70, 10); y -= 20;
  hr(); y -= 16;

  // ---- Line items table ----
  const cols = [
    { key: 'partNumber', label: 'Part #', x: margin, w: 88 },
    { key: 'description', label: 'Description', x: margin + 90, w: 138 },
    { key: 'uom', label: 'UOM', x: margin + 232, w: 32 },
    { key: 'qtyShipped', label: 'Qty Shipped', x: margin + 268, w: 60, right: true },
    { key: 'unitPrice', label: 'Unit Price', x: margin + 336, w: 58, right: true },
    { key: 'extendedPrice', label: 'Ext. Price', x: margin + 398, w: 58, right: true }
  ];
  cols.forEach(function (c) {
    const lx = c.right ? c.x + c.w - fontBold.widthOfTextAtSize(c.label, 9) : c.x;
    textAt(c.label, lx, y, 9, { bold: true });
  });
  y -= 6; hr(); y -= 14;

  inv.lines.forEach(function (l) {
    ensureSpace(18);
    cols.forEach(function (c) {
      let v = l[c.key];
      if (c.key === 'unitPrice' || c.key === 'extendedPrice') v = money2(v);
      const s = v == null ? '' : String(v);
      const vx = c.right ? c.x + c.w - font.widthOfTextAtSize(s, 9) : c.x;
      textAt(s, vx, y, 9);
    });
    y -= 16;
  });
  y -= 4; hr(); y -= 20;

  textAt('Invoice Total: ' + (inv.currency || '') + ' ' + money2(inv.invoiceTotal), pageWidth - margin - 220, y, 12, { bold: true });

  return pdfDoc.save();
}

async function handleGenerateDessimateInvoicePdf(env, origin, id, accessLevel, organization) {
  const state = await readJsonArrayFile(env, DESSIMATE_INVOICES_FILE_PATH);
  const inv = state.items.find(function (o) { return o.id === id; });
  if (!inv) return json({ message: 'Not found.' }, 404, origin);
  const scoped = scopeDessimateInvoices([sanitizeDessimateInvoice(inv)], accessLevel, organization);
  if (!scoped.length) return json({ message: 'Not found.' }, 404, origin);
  const clean = scoped[0];

  const orgState = await readJsonArrayFile(env, ORGANIZATIONS_FILE_PATH);
  const selfOrg = orgState.items.map(sanitizeOrg).find(function (o) { return o.relationship === 'Self'; }) || null;

  let pdfBytes;
  try {
    pdfBytes = await buildDessimateInvoicePdf(clean, selfOrg);
  } catch (e) {
    return json({ message: 'Could not generate PDF: ' + (e && e.message ? e.message : e) }, 500, origin);
  }
  return pdfResponse(pdfBytes, 'Dessimate Invoice ' + clean.invoiceNumber + '.pdf', origin);
}

// ---- generic JSON-array-file read/write, with optimistic-concurrency retry -

function readLegacyStaff(env) {
  try { return JSON.parse(env.STAFF_USERS || '[]'); } catch (e) { return []; }
}

async function readJsonArrayFile(env, path) {
  const upstream = 'https://api.github.com/repos/' + env.GITHUB_OWNER + '/' + env.GITHUB_REPO + '/contents/' + path;
  const res = await fetch(upstream, { headers: githubHeaders(env) });
  if (res.status === 404) return { items: [], sha: null };
  if (!res.ok) throw new Error('Could not read ' + path + ' (HTTP ' + res.status + ').');
  const data = await res.json();
  let items = [];
  try { items = JSON.parse(base64ToUtf8(data.content || '')); if (!Array.isArray(items)) items = []; } catch (e) { items = []; }
  return { items: items, sha: data.sha };
}

async function writeJsonArrayFile(env, path, items, sha, commitMessage) {
  const upstream = 'https://api.github.com/repos/' + env.GITHUB_OWNER + '/' + env.GITHUB_REPO + '/contents/' + path;
  const body = { message: commitMessage || ('Update ' + path + ' via admin'), content: utf8ToBase64(JSON.stringify(items, null, 2)) };
  if (sha) body.sha = sha;
  return fetch(upstream, {
    method: 'PUT',
    headers: Object.assign({}, githubHeaders(env), { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  });
}

// mutateFn(items) -> { items, meta? } to write, or null/falsy to signal "not found".
// Retries once on a sha conflict (409), re-reading fresh state and re-applying mutateFn.
async function mutateJsonArrayFile(env, path, mutateFn, opts) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await readJsonArrayFile(env, path);
    const outcome = mutateFn(state.items.slice());
    if (!outcome) return (opts && opts.requireFound) ? 'not-found' : { ok: false, message: 'Not found.' };
    const res = await writeJsonArrayFile(env, path, outcome.items, state.sha);
    if (res.ok) return { ok: true, items: outcome.items, meta: outcome.meta };
    if (res.status === 409 && attempt === 0) continue; // someone else wrote in between - retry once
    const text = await res.text().catch(function () { return ''; });
    return { ok: false, message: 'Could not save (HTTP ' + res.status + '). ' + text };
  }
  return { ok: false, message: 'Could not save after a conflicting update - please try again.' };
}

// Thin wrappers so the user-directory code below reads naturally (users, not items).
async function readUsersFile(env) {
  const r = await readJsonArrayFile(env, USERS_FILE_PATH);
  return { users: r.items, sha: r.sha };
}
async function mutateUsersFile(env, mutateFn, opts) {
  const result = await mutateJsonArrayFile(env, USERS_FILE_PATH, function (items) {
    const outcome = mutateFn(items);
    return outcome ? { items: outcome.users, meta: outcome.meta } : null;
  }, opts);
  if (result === 'not-found') return result;
  return result.ok ? { ok: true, users: result.items, meta: result.meta } : result;
}

function githubHeaders(env) {
  return {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Authorization': 'Bearer ' + env.GITHUB_TOKEN,
    'User-Agent': 'dessimate-forms-backend'
  };
}

// ---- generic JSON-*object*-file read/write (data/counters.json) -----------
// Same optimistic-concurrency shape as the array-file helpers above, but for
// a single JSON object rather than a list - used for the Dessimate PO /
// Shipment / Dessimate Invoice numbering counters.
async function readJsonObjectFile(env, path, defaults) {
  const upstream = 'https://api.github.com/repos/' + env.GITHUB_OWNER + '/' + env.GITHUB_REPO + '/contents/' + path;
  const res = await fetch(upstream, { headers: githubHeaders(env) });
  if (res.status === 404) return { obj: Object.assign({}, defaults), sha: null };
  if (!res.ok) throw new Error('Could not read ' + path + ' (HTTP ' + res.status + ').');
  const data = await res.json();
  let obj = {};
  try {
    obj = JSON.parse(base64ToUtf8(data.content || ''));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = {};
  } catch (e) { obj = {}; }
  return { obj: Object.assign({}, defaults, obj), sha: data.sha };
}
async function writeJsonObjectFile(env, path, obj, sha, commitMessage) {
  const upstream = 'https://api.github.com/repos/' + env.GITHUB_OWNER + '/' + env.GITHUB_REPO + '/contents/' + path;
  const body = { message: commitMessage || ('Update ' + path), content: utf8ToBase64(JSON.stringify(obj, null, 2)) };
  if (sha) body.sha = sha;
  return fetch(upstream, {
    method: 'PUT',
    headers: Object.assign({}, githubHeaders(env), { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  });
}
// mutateFn(obj) -> { obj, meta? } to write. Retries once on a sha conflict.
async function mutateJsonObjectFile(env, path, defaults, mutateFn) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await readJsonObjectFile(env, path, defaults);
    const outcome = mutateFn(Object.assign({}, state.obj));
    const res = await writeJsonObjectFile(env, path, outcome.obj, state.sha);
    if (res.ok) return { ok: true, obj: outcome.obj, meta: outcome.meta };
    if (res.status === 409 && attempt === 0) continue; // someone else wrote in between - retry once
    const text = await res.text().catch(function () { return ''; });
    return { ok: false, message: 'Could not save (HTTP ' + res.status + '). ' + text };
  }
  return { ok: false, message: 'Could not save after a conflicting update - please try again.' };
}

// Raw-bytes read of an arbitrary repo file (images, PDFs) for server-side use
// (e.g. embedding an approver's stamp image into a generated PDF) - not
// routed to the browser, just used internally.
async function readGithubFileBytes(env, path) {
  const upstream = 'https://api.github.com/repos/' + env.GITHUB_OWNER + '/' + env.GITHUB_REPO + '/contents/' + path.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(upstream, { headers: githubHeaders(env) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Could not read ' + path + ' (HTTP ' + res.status + ').');
  const data = await res.json();
  return base64ToBytes(data.content || '');
}

// ---- proxy routes (PDIRs, drafts, docs) ------------------------------------

async function proxyContents(request, env, origin, ghPath) {
  const upstream = 'https://api.github.com/repos/' + env.GITHUB_OWNER + '/' + env.GITHUB_REPO + '/contents/' + ghPath;
  const headers = githubHeaders(env);

  if (request.method === 'PUT') {
    const res = await fetch(upstream, {
      method: 'PUT',
      headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }),
      body: await request.text()
    });
    const bodyText = await res.text();
    return new Response(bodyText, { status: res.status, headers: corsHeaders(origin, 'application/json') });
  }

  const res = await fetch(upstream, { headers: headers });
  if (!res.ok) {
    const bodyText = await res.text();
    return new Response(bodyText, { status: res.status, headers: corsHeaders(origin, 'application/json') });
  }

  let data;
  try { data = await res.json(); } catch (e) {
    return new Response('{}', { status: res.status, headers: corsHeaders(origin, 'application/json') });
  }

  // GitHub's Contents API only inlines base64 "content" for files up to
  // ~1MB; above that the request still succeeds, but "content" comes back
  // empty even though "sha"/"size" are still populated. That silently
  // produced 0-byte PDFs for anything over ~1MB. Fix: fall back to the Git
  // Blobs API (base64 content up to 100MB) using the sha we already have,
  // and splice its content back into this same response shape, so nothing
  // on the frontend needs to change.
  if (data && !Array.isArray(data) && data.type === 'file' && data.sha && !data.content) {
    const blobRes = await fetch(
      'https://api.github.com/repos/' + env.GITHUB_OWNER + '/' + env.GITHUB_REPO + '/git/blobs/' + data.sha,
      { headers: headers }
    );
    if (blobRes.ok) {
      const blob = await blobRes.json();
      data.content = blob.content;
      data.encoding = blob.encoding;
    }
  }

  return new Response(JSON.stringify(data), { status: res.status, headers: corsHeaders(origin, 'application/json') });
}

async function proxyCommits(request, env, origin, path) {
  const upstream = 'https://api.github.com/repos/' + env.GITHUB_OWNER + '/' + env.GITHUB_REPO +
    '/commits?path=' + encodeURIComponent(path) + '&per_page=1';
  const res = await fetch(upstream, { headers: githubHeaders(env) });
  const bodyText = await res.text();
  return new Response(bodyText, { status: res.status, headers: corsHeaders(origin, 'application/json') });
}

// ---- auth helpers -------------------------------------------------------

async function requireAuth(request, env) {
  const header = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/.exec(header);
  if (!m) return { ok: false, status: 401, message: 'Not logged in.' };
  const verified = await verifyToken(m[1], env.SESSION_SECRET);
  if (!verified) return { ok: false, status: 401, message: 'Your session has expired — please log in again.' };
  return { ok: true, username: verified.u };
}

// Resolves a signed-in username to their effective accessLevel. Checks the
// new Users file first (an explicit accessLevel field wins), then falls back
// to a sensible default from their relationship, then to the legacy
// STAFF_USERS secret (pre-dates this field entirely) using the same
// bootstrap list the frontend used to hardcode as ADMIN_USERNAMES.
async function resolveAccessLevel(env, username) {
  if (!username) return null;
  const lower = username.toLowerCase();
  const fileState = await readUsersFile(env);
  const fileUser = fileState.users.find(function (u) { return u.username && u.username.toLowerCase() === lower; });
  if (fileUser) {
    if (fileUser.accessLevel && ACCESS_LEVELS.indexOf(fileUser.accessLevel) !== -1) return fileUser.accessLevel;
    if (fileUser.relationship === 'Supplier') return 'supplier';
    if (fileUser.relationship === 'Customer') return 'customer';
    return SUPER_ADMIN_LEGACY_FALLBACK.indexOf(lower) !== -1 ? 'super_admin' : 'team_member';
  }
  // Not migrated into the Users file yet - only Dessimate Team member style
  // logins ever lived in STAFF_USERS, so the same bootstrap fallback applies.
  return SUPER_ADMIN_LEGACY_FALLBACK.indexOf(lower) !== -1 ? 'super_admin' : 'team_member';
}

// Resolves a signed-in username to the organization recorded on their Users
// record (only meaningful for Supplier/Customer contacts - a Dessimate Team
// member has no filtering-relevant organization). Used to scope a
// supplier/customer login's GET results down to their own records. Returns
// '' (never matches anything) if the user isn't found or has no org set.
async function resolveUserOrganization(env, username) {
  if (!username) return '';
  const lower = username.toLowerCase();
  const fileState = await readUsersFile(env);
  const fileUser = fileState.users.find(function (u) { return u.username && u.username.toLowerCase() === lower; });
  return (fileUser && fileUser.organization) ? fileUser.organization : '';
}

// Combines requireAuth + resolveAccessLevel + (for supplier/customer)
// resolveUserOrganization into the one bundle every org-filtered GET route
// needs. Any signed-in user of any access level is "ok" here - this isn't a
// permission check, just a lookup of who's asking so the handler can decide
// what to show them.
async function requireAuthWithScope(request, env) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return auth;
  const accessLevel = await resolveAccessLevel(env, auth.username);
  const organization = (accessLevel === 'supplier' || accessLevel === 'customer')
    ? await resolveUserOrganization(env, auth.username)
    : '';
  return { ok: true, username: auth.username, accessLevel: accessLevel, organization: organization };
}

// Wraps requireAuth with an accessLevel check. allowedLevels is an array of
// ACCESS_LEVELS values; the caller's resolved level must be one of them.
async function requireRole(request, env, allowedLevels) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return auth;
  const level = await resolveAccessLevel(env, auth.username);
  if (!level || allowedLevels.indexOf(level) === -1) {
    return { ok: false, status: 403, message: 'You don’t have access to this.' };
  }
  return { ok: true, username: auth.username, accessLevel: level };
}

// Session token shape: base64url(JSON payload) + "." + base64url(HMAC-SHA256 signature)
async function signToken(payload, secret) {
  const payloadB64 = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  return payloadB64 + '.' + b64urlEncode(new Uint8Array(sig));
}
async function verifyToken(token, secret) {
  var parts = token.split('.');
  if (parts.length !== 2) return null;
  var payloadB64 = parts[0], sigB64 = parts[1];
  var key = await hmacKey(secret);
  var ok = await crypto.subtle.verify('HMAC', key, b64urlDecode(sigB64), new TextEncoder().encode(payloadB64));
  if (!ok) return null;
  var payload;
  try { payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64))); } catch (e) { return null; }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
function hmacKey(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

// PBKDF2-SHA256, 100000 iterations, 256-bit output, hex-encoded. Must match
// password_hash_tool.html exactly since that's what generated the original
// STAFF_USERS entries (new logins from the admin page use this same function
// server-side now, so there's no separate hashing tool to keep in sync with).
async function pbkdf2Hex(password, saltHex) {
  var saltBytes = hexDecode(saltHex);
  var keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  var bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256);
  return hexEncode(new Uint8Array(bits));
}
function randomSaltHex() {
  var bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return hexEncode(bytes);
}
function cryptoRandomId() {
  return (crypto.randomUUID ? crypto.randomUUID() : (hexEncode(crypto.getRandomValues(new Uint8Array(16)))));
}

// ---- small utils ---------------------------------------------------------

function b64urlEncode(bytes) {
  var bin = '';
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  var bin = atob(str);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function hexEncode(bytes) {
  return Array.prototype.map.call(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}
function hexDecode(hex) {
  var bytes = new Uint8Array(hex.length / 2);
  for (var i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}
// Standard (not url-safe) base64, UTF-8 safe - used for the users.json file
// content field, which GitHub's Contents API always expects as base64.
function utf8ToBase64(str) {
  var bytes = new TextEncoder().encode(str);
  var bin = '';
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function base64ToUtf8(b64) {
  var bin = atob((b64 || '').replace(/\s+/g, ''));
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
// Same standard-base64 decode as above, but returns raw bytes instead of
// decoding as UTF-8 text - for binary files (images, PDFs) read server-side.
function base64ToBytes(b64) {
  var bin = atob((b64 || '').replace(/\s+/g, ''));
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function corsHeaders(origin, contentType) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Content-Type': contentType || 'text/plain'
  };
}
function corsResponse(origin) {
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}
function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: corsHeaders(origin, 'application/json') });
}
function pdfResponse(bytes, filename, origin) {
  const headers = Object.assign({}, corsHeaders(origin, 'application/pdf'), {
    'Content-Disposition': 'inline; filename="' + (filename || 'document.pdf').replace(/["\r\n]/g, '') + '"'
  });
  return new Response(bytes, { status: 200, headers: headers });
}
