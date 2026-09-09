/**
 * Dessimate Supply Chain Management System - backend ("roberto")
 * ---------------------------------------------------------------------------
 * An authenticated API backed entirely by Cloudflare's own storage - no
 * GitHub involved in storing any data or files.
 *
 * WHY THIS EXISTS
 * The Forms Portal pages (PDIR_Form_Filler.html, PDIR_Portal.html, and
 * the rest) are plain static files with no server of their own. Staff log in
 * with a username/password and get back a short-lived signed session token;
 * every route except /login and /health requires a valid session token.
 *
 * STORAGE (Cloudflare-native, migrated from GitHub - see worker/README.md
 * "Cloudflare-native storage migration" section for the full history)
 * - D1 (env.DB): one SQL table, `documents`, holding every JSON "database"
 *   record (users, organizations, parts, POs, invoices, counters, etc.) as
 *   one row per logical path (e.g. "data/users.json"). A `version` column
 *   replaces GitHub's blob "sha" for optimistic-concurrency checks - every
 *   write generates a fresh version token, and an update only succeeds if
 *   the caller's version still matches what's stored.
 * - R2 (env.FILES): every actual file - CAD drawings, PDFs, PDIR reports,
 *   stamps, logos, attachments - stored under the exact same relative paths
 *   the GitHub repo used to use (part_docs/<id>/..., customer_po_docs/<id>/
 *   source.pdf, etc.), so nothing about the app's own path conventions had
 *   to change. R2 is private by default - nothing here is publicly
 *   reachable the way the old public GitHub repo's files were.
 *
 * The response *shapes* for /contents and /commits still mirror GitHub's own
 * old Contents API (an object with base64 "content" for a file, an array of
 * {name,type,...} for a directory listing, etc.) purely so the existing
 * frontend code - which already treats "the API" as a configurable base URL
 * - needed no changes beyond pointing at this Worker's URL. Nothing behind
 * that shape actually talks to GitHub any more.
 *
 * USER DIRECTORY (Organization, Role, Email, Phone, Active, etc.)
 * The full user directory (everyone with a Portal login, plus Supplier /
 * Customer contact records with no login) lives in one JSON document in D1,
 * USERS_FILE_PATH below, read and written only through the /admin/users
 * routes â€” never through the generic /contents proxy, so a signed-in staff
 * member's own browser can never fetch anyone's password hash directly (see
 * the guard at the top of proxyContents).
 *
 * This replaces the original design, where logins lived only in a
 * STAFF_USERS Worker secret you edited by hand with `wrangler secret put`.
 * That secret still works and is never deleted by this code â€” if a
 * username isn't found in the new file, login falls back to checking it â€”
 * so nobody who was already able to log in loses access. A username becomes
 * "migrated" (and the STAFF_USERS secret stops being consulted for it) the
 * moment it's edited and saved once from the Users admin page, or pulled in
 * with the page's "Import" action. There's no cutover step required.
 *
 * ORGANIZATION DIRECTORY (Suppliers / Customers - address, docs, etc.)
 * A second directory file, ORGANIZATIONS_FILE_PATH below, holds Supplier and
 * Customer companies (not people - that's the user directory above). Its
 * documents (company presentation, NDA, self-assessment, and any number of
 * generic files) are ordinary files under ORG_DOC_FOLDER in R2,
 * uploaded/read through the normal /contents proxy - only the metadata
 * record (name, address, phone, website, which files exist) goes through
 * the dedicated /organizations routes. Unlike users.json there's no secret
 * data here (no passwords), so there's no legacy-secret fallback to worry
 * about and no need to keep this file's path out of the generic /contents
 * proxy â€” it's blocked anyway for consistency, since everything under data/
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
 *                                        in storage are left in place, same as PDIRs do when
 *                                        a document is replaced - nothing here deletes stored
 *                                        file content, only the directory record).
 *   GET    /parts                     - auth required (any signed-in user); full parts
 *                                        directory.
 *   POST   /parts                     - team_member or above required; create a part.
 *   PUT    /parts/<id>                - team_member or above required; update one.
 *   DELETE /parts/<id>                - team_member or above required; remove one (its
 *                                        drawing file in storage is left in place, same as
 *                                        Organizations).
 *   GET    /apqp                       - auth required (any signed-in user); full APQP list (one
 *                                        record per Part on the APQP checklist, each with its
 *                                        eleven deliverable items (0. Feasibility Studies covers two named deliverables, plus the numbered 1-9) - files + a comment log per item).
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
 *   GET    /contents/<path...>        - reads one file from R2 (blocked for anything
 *                                        under data/ - see above), or lists a "directory"
 *                                        prefix, in a shape mirroring GitHub's old API.
 *   PUT    /contents/<path...>        - writes one file to R2 (same data/ block as above).
 *   GET    /commits?path=<path>       - "last modified" info for a path (D1 row's
 *                                        updated_at, or an R2 object's upload time).
 *
 * SECRETS (set with `wrangler secret put <NAME>`)
 *   SESSION_SECRET - random string used to sign session tokens (see README)
 *   STAFF_USERS    - JSON array of {username, salt, hash} - the original login list.
 *                    Still consulted as a fallback for anyone not yet migrated into
 *                    the new file (see USER DIRECTORY above) - no need to touch this
 *                    again going forward, new/changed logins are managed from the
 *                    Users admin page instead.
 *
 * BINDINGS (set in wrangler.toml)
 *   DB (D1 database "dscm-db"), FILES (R2 bucket "dscm-files"), ALLOWED_ORIGIN (var)
 * ---------------------------------------------------------------------------
 */

// pdf-lib is vendored as a plain ESM file (worker/src/pdf-lib.esm.min.js,
// copied verbatim from `npm install pdf-lib`'s dist/pdf-lib.esm.min.js - zero
// Node built-ins, confirmed safe for the Worker's V8 isolate) so Dessimate PO
// PDFs are generated by one template that lives here on the backend, not
// hand-copied into the frontend. Wrangler's bundler inlines this import
// automatically on `wrangler deploy` - nothing else to install.
import { PDFDocument, StandardFonts, rgb } from './pdf-lib.esm.min.js';

// Rev2.3: the Dessimate Invoice PDF template's letterhead logo, embedded as a
// base64 JPEG constant so it's always available server-side without depending
// on whether the Self organization happens to have a logo uploaded through
// the Organizations page - see buildDessimateInvoicePdf below.
const DESSIMATE_LOGO_JPG_BASE64 = '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';

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
// record itself (still the PDF/draft/docs in R2) - just tags it.
const PDIR_INDEX_FILE_PATH = 'data/pdir_index.json';

// Rev2.2: the "DSCM vX.X" footer/sidebar stamp used to be hand-typed into
// every page's HTML - bumping it meant re-uploading all 11 pages just to
// change one string. Now it's one stored field the frontend fetches, so a
// version bump is a single PUT /app-config call (see handleUpdateAppConfig
// below, super_admin-gated), never a frontend edit.
const APP_CONFIG_FILE_PATH = 'data/app_config.json';
const DEFAULT_APP_CONFIG = { version: '2.2', builtLabel: 'Built September 2026' };

const APQP_FILE_PATH = 'data/apqp.json';
const APQP_DOC_FOLDER = 'apqp_docs';
// Fixed checklist of APQP deliverables per part (per the product brief), each
// with its own files + a running comment log. Order matters - it's the order
// the Part's checklist is shown in. "0. Feasibility Studies" (Rev2.1) is two
// named deliverables shown together under one "0" heading on the frontend -
// they're modeled here as two ordinary item keys (reusing the exact same
// files+comments shape/routes as every other item) rather than a nested
// sub-structure, so no route or sanitizer below needed to change.
const APQP_ITEM_KEYS = ['feasibilityPresentation', 'cfdStudies', 'designRecord', 'controlPlan', 'dimResults', 'mpTests', 'ips', 'sampleProduct', 'masterSample', 'other', 'psw'];
const APQP_ITEM_LABELS = {
  feasibilityPresentation: 'Feasibility Study Presentation', cfdStudies: 'CFD Studies',
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
//               POs, APQP, PDIRs (via data/pdir_index.json, scoped by Part
//               Number rather than organization - see resolveCustomerVisible-
//               PartNumbers). Rev2.1: no longer sees Dessimate Invoices.
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

      // Public (like /health) - the version stamp shows in the sidebar/footer
      // even on the sign-in screen, before any session exists.
      if (url.pathname === '/app-config') {
        if (request.method === 'GET') return await handleGetAppConfig(env, origin);
        if (request.method === 'PUT') {
          const auth = await requireRole(request, env, ['super_admin']);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleUpdateAppConfig(request, env, origin);
        }
      }

      if (url.pathname === '/admin/migrate-from-github' && request.method === 'POST') {
        return await handleMigrateFromGithub(request, env, origin);
      }

      if (url.pathname === '/login' && request.method === 'POST') {
        return await handleLogin(request, env, origin);
      }

      if (url.pathname === '/users' && request.method === 'GET') {
        return await handleListUsers(env, origin);
      }

      // Rev2.1: the PDIR Sign-Off's "Prepared By" dropdown (Supplier side) is
      // filtered by the shipment's Supplier/Organization - a lighter-weight,
      // staff-only lookup than GET /admin/users (which is super_admin-gated
      // and returns full PII for every relationship), scoped to just the
      // Supplier contacts of one named organization.
      if (url.pathname === '/org-contacts' && request.method === 'GET') {
        const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handleListOrgContacts(env, origin, url.searchParams.get('organization') || '');
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
        // url.pathname keeps percent-encoding as-is (e.g. a space or "#" in a
        // PDIR title comes through as %20/%23) - decode each segment back to
        // the real characters so this matches the actual R2 key/path, the
        // same way the frontend built the request (encodeURIComponent per
        // segment, not the whole path, so a literal "/" here still separates
        // folders correctly).
        const ghPath = url.pathname.slice('/contents/'.length).split('/').map(decodeURIComponent).join('/');
        if (ghPath.indexOf('data/') === 0) {
          return json({ message: 'Not accessible via this route.' }, 403, origin);
        }
        // This proxy has no access control of its own beyond "signed in" -
        // it will fetch or write whatever storage path it's given. That was
        // fine while only trusted Dessimate staff could sign in at all; now
        // that Supplier/Customer logins exist, a Supplier/Customer account
        // is restricted to read-only access, and only to the small set of
        // PDIR files their own organization is tagged as owning (see
        // isContentsPathAllowedForExternal) - never another organization's
        // PDIRs, drawings, invoices, or anything else in storage.
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

// Rev2.2: lock out any non-super_admin account after 3 failed sign-ins in a
// row, so a guessed/leaked password can't be brute-forced - Super Admin is
// deliberately exempt, so there's always at least one way into the system
// even if every other account gets itself locked. Tracked in one small JSON
// object (like data/counters.json) keyed by lowercased username, separate
// from data/users.json since it applies to legacy STAFF_USERS-secret logins
// too, which have no file record to carry the count on.
const LOGIN_LOCKOUTS_FILE_PATH = 'data/login_lockouts.json';
const LOGIN_LOCKOUT_THRESHOLD = 3;
const LOGIN_LOCKOUT_MESSAGE = 'This account has been locked after 3 unsuccessful sign-in attempts. Please contact your Dessimate contact to reset your password.';

async function isLoginLocked(env, usernameLower) {
  const state = await readJsonObjectFile(env, LOGIN_LOCKOUTS_FILE_PATH, {});
  const entry = state.obj[usernameLower];
  return !!(entry && entry.failCount >= LOGIN_LOCKOUT_THRESHOLD);
}
// Returns { failCount, justLocked } - justLocked is true if this failure is
// the one that crossed the threshold, so the triggering attempt itself can
// show the lockout message right away instead of the caller having to fail
// once more to find out they're locked. failCount lets the caller tell the
// person how many attempts they have left (see authAttempts on the sign-in
// form).
async function recordFailedLogin(env, usernameLower) {
  let failCount = 0, justLocked = false;
  await mutateJsonObjectFile(env, LOGIN_LOCKOUTS_FILE_PATH, {}, function (obj) {
    const entry = obj[usernameLower] || { failCount: 0 };
    entry.failCount = (entry.failCount || 0) + 1;
    failCount = entry.failCount;
    justLocked = entry.failCount === LOGIN_LOCKOUT_THRESHOLD;
    if (entry.failCount >= LOGIN_LOCKOUT_THRESHOLD) entry.lockedAt = new Date().toISOString();
    obj[usernameLower] = entry;
    return { obj: obj };
  });
  return { failCount: failCount, justLocked: justLocked };
}
// Called on a successful login (starts the count fresh) and by
// handleAdminUpdateUser whenever a Super Admin resets someone's password
// (the account's promised way out of a lockout - see LOGIN_LOCKOUT_MESSAGE).
async function clearFailedLogins(env, usernameLower) {
  const state = await readJsonObjectFile(env, LOGIN_LOCKOUTS_FILE_PATH, {});
  if (!state.obj[usernameLower]) return; // nothing on file - skip the write
  await mutateJsonObjectFile(env, LOGIN_LOCKOUTS_FILE_PATH, {}, function (obj) {
    delete obj[usernameLower];
    return { obj: obj };
  });
}

async function handleLogin(request, env, origin) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const username = (body.username || '').toString().trim();
  const password = (body.password || '').toString();
  if (!username || !password) return json({ message: 'Username and password are required.' }, 400, origin);
  const usernameLower = username.toLowerCase();

  const badCreds = function () { return json({ message: 'Invalid username or password.' }, 401, origin); };
  const lockedOut = function () { return json({ message: LOGIN_LOCKOUT_MESSAGE }, 401, origin); };
  // Included on a lockable account's failed attempt so the sign-in form can
  // show a running "N of 3 attempts used" counter, per the product brief.
  const badCredsWithAttempts = function (attemptsRemaining) {
    return json({ message: 'Invalid username or password.', attemptsRemaining: attemptsRemaining }, 401, origin);
  };

  // The new user file is authoritative for any username it contains. Only
  // when a username isn't in the file at all do we fall back to the old
  // STAFF_USERS secret, so nobody's access silently changes just because
  // other people have been migrated.
  const fileState = await readUsersFile(env);
  const fileMatch = fileState.users.find(function (u) {
    return (u.username || '').toLowerCase() === usernameLower;
  });

  if (fileMatch) {
    // Any relationship (Dessimate Team member, Supplier, Customer) can have
    // a login now - the account just needs a username/hash on file. What
    // that person can then see is entirely down to resolveAccessLevel()
    // (and, for Supplier/Customer, their recorded organization) - not to
    // relationship gating here.
    if (!fileMatch.username || !fileMatch.hash) return badCreds();
    if (fileMatch.active === false) return json({ message: 'This account has been deactivated.' }, 401, origin);
    const accessLevel = await resolveAccessLevel(env, fileMatch.username);
    const lockable = accessLevel !== 'super_admin';
    if (lockable && await isLoginLocked(env, usernameLower)) return lockedOut();
    const computedHash = await pbkdf2Hex(password, fileMatch.salt);
    if (computedHash !== fileMatch.hash) {
      if (lockable) {
        const attempt = await recordFailedLogin(env, usernameLower);
        if (attempt.justLocked) return lockedOut();
        return badCredsWithAttempts(LOGIN_LOCKOUT_THRESHOLD - attempt.failCount);
      }
      return badCreds();
    }
    if (lockable) await clearFailedLogins(env, usernameLower);
    return await issueSession(fileMatch.username, env, origin);
  }

  const legacy = readLegacyStaff(env);
  const legacyMatch = legacy.find(function (u) { return (u.username || '').toLowerCase() === usernameLower; });
  if (!legacyMatch) return badCreds();
  const legacyAccessLevel = await resolveAccessLevel(env, legacyMatch.username);
  const legacyLockable = legacyAccessLevel !== 'super_admin';
  if (legacyLockable && await isLoginLocked(env, usernameLower)) return lockedOut();
  const legacyHash = await pbkdf2Hex(password, legacyMatch.salt);
  if (legacyHash !== legacyMatch.hash) {
    if (legacyLockable) {
      const attempt = await recordFailedLogin(env, usernameLower);
      if (attempt.justLocked) return lockedOut();
      return badCredsWithAttempts(LOGIN_LOCKOUT_THRESHOLD - attempt.failCount);
    }
    return badCreds();
  }
  if (legacyLockable) await clearFailedLogins(env, usernameLower);
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

// Rev2.1: Supplier-side contacts for one named organization (username + name
// only, no other PII) - backs the PDIR Sign-Off's "Prepared By" dropdown,
// which needs to be filtered by whichever Supplier the shipment is for.
async function handleListOrgContacts(env, origin, organization) {
  const org = (organization || '').toString().trim();
  if (!org) return json({ contacts: [] }, 200, origin);
  const fileState = await readUsersFile(env);
  const contacts = fileState.users
    .filter(function (u) { return u.username && u.relationship === 'Supplier' && u.active !== false && (u.organization || '') === org; })
    .map(function (u) { return { username: u.username, name: u.name || '' }; })
    .sort(function (a, b) { return (a.name || a.username).localeCompare(b.name || b.username); });
  return json({ contacts: contacts }, 200, origin);
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
  // Surface who's currently locked out (see LOGIN_LOCKOUT_MESSAGE) so a
  // Super Admin knows who's actually asking for a password reset, rather
  // than having to be told which account name to look for.
  const lockoutState = await readJsonObjectFile(env, LOGIN_LOCKOUTS_FILE_PATH, {});
  rows.forEach(function (row) {
    const entry = row.username ? lockoutState.obj[row.username.toLowerCase()] : null;
    row.locked = !!(entry && entry.failCount >= LOGIN_LOCKOUT_THRESHOLD);
  });
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
    return { error: json({ message: 'That email address doesnâ€™t look valid.' }, 400, origin) };
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
    return { error: json({ message: 'A Supplier contactâ€™s access level must be "supplier".' }, 400, origin) };
  }
  if (relationship === 'Customer' && accessLevel && accessLevel !== 'customer') {
    return { error: json({ message: 'A Customer contactâ€™s access level must be "customer".' }, 400, origin) };
  }
  if (relationship === 'Dessimate Team member' && accessLevel && (accessLevel === 'supplier' || accessLevel === 'customer')) {
    return { error: json({ message: 'A Dessimate Team memberâ€™s access level must be super_admin, admin, or team_member.' }, 400, origin) };
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
  let newUsername = null, newSalt = null, newHash = null, passwordChanged = false;
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
      passwordChanged = true;
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
  // A Super Admin resetting the password is this account's promised way out
  // of a lockout (see LOGIN_LOCKOUT_MESSAGE) - clear the failed-attempt count
  // so the new password works immediately instead of still reading as locked.
  if (passwordChanged && newUsername) await clearFailedLogins(env, newUsername.toLowerCase());
  return json(sanitizeFileUser(savedUser), 200, origin);
}

async function handleAdminDeleteUser(env, origin, id) {
  if (id.indexOf('legacy:') === 0) {
    return json({ message: 'This person hasnâ€™t been added to the new list yet. Edit and save their details first (or turn off Active there to revoke access) before deleting.' }, 400, origin);
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

// ---- app config (the "DSCM vX.X" stamp) ------------------------------------

async function handleGetAppConfig(env, origin) {
  const state = await readJsonObjectFile(env, APP_CONFIG_FILE_PATH, DEFAULT_APP_CONFIG);
  return json({ version: state.obj.version || DEFAULT_APP_CONFIG.version, builtLabel: state.obj.builtLabel || '' }, 200, origin);
}

async function handleUpdateAppConfig(request, env, origin) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const version = (body.version || '').toString().trim();
  if (!version) return json({ message: 'Version is required.' }, 400, origin);
  const builtLabel = (body.builtLabel || '').toString().trim();

  const result = await mutateJsonObjectFile(env, APP_CONFIG_FILE_PATH, DEFAULT_APP_CONFIG, function (obj) {
    obj.version = version;
    obj.builtLabel = builtLabel;
    return { obj: obj };
  });
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json({ version: result.obj.version, builtLabel: result.obj.builtLabel || '' }, 200, origin);
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
    return { error: json({ message: 'That sales email address doesnâ€™t look valid.' }, 400, origin) };
  }
  if (purchasingEmail && !emailPattern.test(purchasingEmail)) {
    return { error: json({ message: 'That purchasing email address doesnâ€™t look valid.' }, 400, origin) };
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
    return json({ message: 'A Self organization already exists â€” edit it instead of creating another.' }, 409, origin);
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
    return json({ message: 'A Self organization already exists â€” edit it instead of creating another.' }, 409, origin);
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

// ---- APQP (per-Part checklist of deliverables, each with files + a -------
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
    // Rev2.1: Customer logins were granted read access to PDIR. A Customer
    // has no direct tie to a PDIR's Supplier organization, so it's scoped
    // instead through which Part Numbers their organization is the customer
    // of - the same lookup APQP customer-scoping already uses.
    const visiblePartNumbers = organization ? await resolveCustomerVisiblePartNumbers(env, organization) : new Set();
    entries = entries.filter(function (e) { return visiblePartNumbers.has((e.partNumber || '').toLowerCase()); });
  }
  return json({ pdirIndex: entries }, 200, origin);
}

// Upserts (by title, PDIR's one stable identifier) the tag for a single PDIR
// record. Called by the Form Filler right after it saves a draft or a
// finished PDF, so the index always reflects whatever's actually stored
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

// Looks up the PDIR index entry (organization + Part Number) a title is
// tagged with, if any. Used to gate a Supplier/Customer login's raw
// /contents/ access to that PDIR's own files (pdirs/pdir_drafts/pdir_docs) -
// see isContentsPathAllowedForExternal - and to scope the PDIR index list
// itself (handleListPdirIndex).
async function resolvePdirIndexEntry(env, title) {
  const state = await readJsonArrayFile(env, PDIR_INDEX_FILE_PATH);
  return state.items.find(function (e) { return (e.title || '').toLowerCase() === title.toLowerCase(); }) || null;
}
async function resolvePdirIndexOrganization(env, title) {
  const entry = await resolvePdirIndexEntry(env, title);
  return entry ? (entry.organization || '') : '';
}
// A Customer login has no direct tie to a PDIR's Supplier organization - it's
// scoped instead through the Part Number the PDIR is for, the same "which
// Parts is this organization the customer of" lookup APQP customer-scoping
// uses (scopeParts). Returns the set of Part Numbers (lowercased) a Customer
// organization is allowed to see PDIRs for.
async function resolveCustomerVisiblePartNumbers(env, organization) {
  const partsState = await readJsonArrayFile(env, PARTS_FILE_PATH);
  const visibleParts = scopeParts(partsState.items.map(sanitizePart), 'customer', organization);
  return new Set(visibleParts.map(function (p) { return (p.partNumber || '').toLowerCase(); }));
}

// Gates the generic /contents/ proxy for a Supplier/Customer login (see the
// comment where this is called). Only the three PDIR file locations - the
// finished PDF, the resumable draft, and its supporting documents/photos -
// are ever reachable: a Supplier only for a title its own organization is
// tagged as owning in the PDIR index, a Customer only for a title whose Part
// Number their organization is the customer of (Rev2.1). Everything else in
// storage (other organizations' PDIRs, drawings, invoices, org/user
// documents...) is refused, even though this proxy has no path allowlist of
// its own.
async function isContentsPathAllowedForExternal(env, ghPath, accessLevel, organization) {
  if ((accessLevel !== 'supplier' && accessLevel !== 'customer') || !organization) return false;
  let decoded;
  try { decoded = ghPath.split('/').map(decodeURIComponent).join('/'); } catch (e) { return false; }
  const m = /^pdirs\/(.+)\.pdf$/.exec(decoded) ||
    /^pdir_drafts\/(.+)\.json$/.exec(decoded) ||
    /^pdir_docs\/([^/]+)\/.+$/.exec(decoded);
  if (!m) return false;
  const title = m[1];
  const entry = await resolvePdirIndexEntry(env, title);
  if (!entry) return false;
  if (accessLevel === 'supplier') return !!entry.organization && entry.organization === organization;
  const visiblePartNumbers = await resolveCustomerVisiblePartNumbers(env, organization);
  return visiblePartNumbers.has((entry.partNumber || '').toLowerCase());
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
// Up to 20 attachments per Dessimate PO (packing lists, supplier drawings,
// anything relevant to the shipment) - same {path, filename, mimeType, size}
// pointer shape and PART_ATTACHMENTS_MAX cap as Parts attachments, reusing
// sanitizeOrgDocList below.
const DESSIMATE_PO_DOC_FOLDER = 'dessimate_po_docs';
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
    attachments: sanitizeOrgDocList(o.attachments),
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
    { id: cryptoRandomId(), createdAt: new Date().toISOString(), poNumber: numbers.poNumber, shipmentNumber: numbers.shipmentNumber, attachments: sanitizeOrgDocList(body.attachments) },
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
    if (body.attachments !== undefined) target.attachments = sanitizeOrgDocList(body.attachments);
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
    // Rev2.1: ability to attach files (e.g. invoices uploaded from a legacy
    // system) - same {path, filename, mimeType, size} shape/cap as Parts.
    attachments: sanitizeOrgDocList(o.attachments),
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
    lines: lines,
    attachments: sanitizeOrgDocList(body.attachments)
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

// Rev2.3: redesigned to match the reference letterhead template (product
// brief) - a light-blue header band (logo + Self org info + INVOICE identity
// block + Bill To/Ship To), a dark-navy line-items table header, and a
// matching footer band ("Ways to Pay" + the standard procurement disclaimer).
// customerOrg is the Customer organization record matching inv.customer (for
// its address, under Bill To) - null if not found/no match, same graceful
// fallback as everywhere else an org lookup can miss.
async function buildDessimateInvoicePdf(inv, selfOrg, customerOrg) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 612, pageHeight = 792; // US Letter
  const margin = 44;

  const bandBg = rgb(0.925, 0.941, 0.976);
  const brandBlue = rgb(0.106, 0.243, 0.706);
  const navyDark = rgb(0.098, 0.145, 0.298);
  const ink = rgb(0.1, 0.1, 0.12);
  const labelGray = rgb(0.42, 0.44, 0.49);
  const lineGray = rgb(0.85, 0.86, 0.89);

  let page = pdfDoc.addPage([pageWidth, pageHeight]);

  let logoImg = null;
  try { logoImg = await pdfDoc.embedJpg(base64ToBytes(DESSIMATE_LOGO_JPG_BASE64)); } catch (e) { logoImg = null; }

  function rightText(str, rightEdgeX, yy, size, opts) {
    opts = opts || {};
    const f = opts.bold ? fontBold : font;
    const s = str == null ? '' : String(str);
    page.drawText(s, { x: rightEdgeX - f.widthOfTextAtSize(s, size), y: yy, size: size, font: f, color: opts.color || ink });
  }
  function leftText(str, x, yy, size, opts) {
    opts = opts || {};
    page.drawText(str == null ? '' : String(str), { x: x, y: yy, size: size, font: opts.bold ? fontBold : font, color: opts.color || ink });
  }
  // Greedy word-wrap to a max pixel width at the given font size.
  function wrapLines(str, maxWidth, size) {
    const words = (str || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    words.forEach(function (w) {
      const attempt = cur ? cur + ' ' + w : w;
      if (cur && font.widthOfTextAtSize(attempt, size) > maxWidth) { lines.push(cur); cur = w; }
      else cur = attempt;
    });
    if (cur) lines.push(cur);
    return lines;
  }
  // Thousands-separated currency, matching the reference template - kept
  // local to this function rather than changing the shared money2() helper,
  // which the Dessimate PO PDF also uses and this request doesn't touch.
  function moneyCommas(n) {
    const parts = money2(n).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }

  const headerHeight = 246;
  const footerHeight = 168;
  const colGap = margin + 230;

  page.drawRectangle({ x: 0, y: pageHeight - headerHeight, width: pageWidth, height: headerHeight, color: bandBg });

  // ---- Logo (left) + INVOICE identity block (right) -------------------------
  const hy = pageHeight - 40;
  let logoBottom = hy;
  if (logoImg) {
    const dims = logoImg.scaleToFit(108, 60);
    page.drawImage(logoImg, { x: margin, y: hy - dims.height, width: dims.width, height: dims.height });
    logoBottom = hy - dims.height;
  } else {
    leftText((selfOrg && selfOrg.name) || 'Dessimate LLC', margin, hy - 14, 16, { bold: true, color: brandBlue });
    logoBottom = hy - 28;
  }

  let ry = hy;
  rightText('INVOICE', pageWidth - margin, ry, 26, { bold: true, color: brandBlue }); ry -= 30;
  [
    ['Invoice Number:', inv.invoiceNumber || ''],
    ['Purchase Order Number:', inv.customerPoRef || ''],
    ['Date:', inv.invoiceDate || ''],
    ['Terms:', inv.paymentTerms || ''],
    ['Due Date:', '']
  ].forEach(function (row) {
    rightText(row[0], pageWidth - margin - 100, ry, 10, { bold: true });
    rightText(row[1], pageWidth - margin, ry, 10);
    ry -= 15;
  });

  // ---- Self org name/address/contact (left column under the logo) ----------
  let ly = logoBottom - 16;
  leftText((selfOrg && selfOrg.name) || 'Dessimate LLC', margin, ly, 10, { bold: true }); ly -= 13;
  const selfAddr = (selfOrg && Array.isArray(selfOrg.addresses) && selfOrg.addresses[0]) ? selfOrg.addresses[0].address : '';
  wrapLines(selfAddr, colGap - margin - 10, 9).forEach(function (line) { leftText(line, margin, ly, 9); ly -= 12; });

  let cy = logoBottom - 16;
  [selfOrg && selfOrg.salesEmail, selfOrg && selfOrg.phone, selfOrg && selfOrg.website].filter(Boolean).forEach(function (line) {
    leftText(line, colGap, cy, 9); cy -= 12;
  });

  // ---- Bill To / Ship To (still inside the header band) --------------------
  const by = Math.min(ly, cy) - 18;
  leftText('Bill To:', margin, by, 10, { bold: true });
  leftText('Ship To:', colGap, by, 10, { bold: true });
  let by1 = by - 13;
  [inv.customer].concat(wrapLines((customerOrg && customerOrg.address) || '', colGap - margin - 10, 9))
    .filter(Boolean).forEach(function (line) { leftText(line, margin, by1, 9); by1 -= 12; });
  let by2 = by - 13;
  const shipLines = wrapLines(inv.shipTo || '', pageWidth - margin - colGap - 10, 9);
  (shipLines.length ? shipLines : ['—']).forEach(function (line) { leftText(line, colGap, by2, 9); by2 -= 12; });

  // ---- Line items table -------------------------------------------------------
  let y = pageHeight - headerHeight - 34;
  const cols = [
    { key: 'partNumber', label: 'Part #', x: margin, w: 86 },
    { key: 'description', label: 'Description', x: margin + 90, w: 150 },
    { key: 'uom', label: 'UOM', x: margin + 244, w: 36 },
    { key: 'qtyShipped', label: 'Qty Shipped', x: margin + 284, w: 64, right: true },
    { key: 'unitPrice', label: 'Unit Price', x: margin + 352, w: 64, right: true },
    { key: 'extendedPrice', label: 'Total Price', x: margin + 420, w: 100, right: true }
  ];
  const tableRight = margin + 520;

  function ensureSpace(h) {
    if (y - h < 40) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      y = pageHeight - 40;
    }
  }

  const headerRowH = 22;
  page.drawRectangle({ x: margin, y: y - headerRowH + 7, width: tableRight - margin, height: headerRowH, color: navyDark });
  cols.forEach(function (c) {
    const lx = c.right ? c.x + c.w - fontBold.widthOfTextAtSize(c.label, 8.5) : c.x;
    page.drawText(c.label, { x: lx, y: y - 7, size: 8.5, font: fontBold, color: rgb(1, 1, 1) });
  });
  y -= headerRowH + 6;

  inv.lines.forEach(function (l) {
    ensureSpace(20);
    cols.forEach(function (c) {
      let v = l[c.key];
      if (c.key === 'unitPrice' || c.key === 'extendedPrice') v = '$' + moneyCommas(v);
      const s = v == null || v === '' ? '—' : String(v);
      const vx = c.right ? c.x + c.w - font.widthOfTextAtSize(s, 9) : c.x;
      page.drawText(s, { x: vx, y: y, size: 9, font: font, color: ink });
    });
    y -= 8;
    page.drawLine({ start: { x: margin, y: y }, end: { x: tableRight, y: y }, thickness: 0.5, color: lineGray });
    y -= 14;
  });

  y -= 12;
  const totalStr = (inv.currency || '') + ' $' + moneyCommas(inv.invoiceTotal);
  const totalValueWidth = fontBold.widthOfTextAtSize(totalStr, 13);
  rightText('Total', tableRight - totalValueWidth - 14, y, 10, { bold: true, color: brandBlue });
  rightText(totalStr, tableRight, y, 13, { bold: true, color: brandBlue });

  // ---- Footer band: Ways to Pay + the standard procurement disclaimer -------
  // Guard against the footer band overlapping a long line-items table - push
  // to a fresh page if what's left above it is too tight.
  if (y < footerHeight + 30) {
    page = pdfDoc.addPage([pageWidth, pageHeight]);
    y = pageHeight - 40;
  }
  page.drawRectangle({ x: 0, y: 0, width: pageWidth, height: footerHeight, color: bandBg });
  let fy = footerHeight - 40;
  leftText('WAYS TO PAY', margin, fy, 13, { bold: true, color: brandBlue }); fy -= 24;

  // Simple text badges, not the real card-network marks (no licensed brand
  // assets to embed) - same "accepted payment methods" idea as the reference.
  let bx = margin;
  ['Apple Pay', 'Visa', 'Mastercard', 'Discover', 'Bank', 'PayPal'].forEach(function (label) {
    const w = fontBold.widthOfTextAtSize(label, 8) + 16;
    page.drawRectangle({ x: bx, y: fy - 14, width: w, height: 20, color: rgb(1, 1, 1), borderColor: lineGray, borderWidth: 0.75 });
    page.drawText(label, { x: bx + 8, y: fy - 8, size: 8, font: fontBold, color: navyDark });
    bx += w + 8;
  });
  fy -= 34;

  const disclaimer = 'Dessimate procured part for customer of this invoice. Dessimate did not make, assemble, or alter these parts in any way, shape, or form. 30 day replacement for all unused parts from date of this invoice.';
  wrapLines(disclaimer, pageWidth - margin * 2, 8).forEach(function (line) {
    leftText(line, margin, fy, 8, { color: labelGray }); fy -= 11;
  });

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
  const allOrgs = orgState.items.map(sanitizeOrg);
  const selfOrg = allOrgs.find(function (o) { return o.relationship === 'Self'; }) || null;
  const customerOrg = allOrgs.find(function (o) { return o.relationship === 'Customer' && o.name === clean.customer; }) || null;

  let pdfBytes;
  try {
    pdfBytes = await buildDessimateInvoicePdf(clean, selfOrg, customerOrg);
  } catch (e) {
    return json({ message: 'Could not generate PDF: ' + (e && e.message ? e.message : e) }, 500, origin);
  }
  return pdfResponse(pdfBytes, 'Dessimate Invoice ' + clean.invoiceNumber + '.pdf', origin);
}

// ---- generic JSON-array-file read/write, with optimistic-concurrency retry -

function readLegacyStaff(env) {
  try { return JSON.parse(env.STAFF_USERS || '[]'); } catch (e) { return []; }
}

// ---- D1-backed JSON document storage ---------------------------------------
// Every "database" file (data/users.json, data/parts.json, etc.) is one row
// in the `documents` table: { path, content, version, updated_at }. `version`
// is a fresh random token written on every update, replacing GitHub's blob
// "sha" for optimistic-concurrency checks - a write only succeeds if the
// caller's version still matches what's currently stored, and callers above
// this layer (readJsonArrayFile/writeJsonArrayFile/mutateJsonArrayFile, and
// the object-file equivalents below) keep the exact same shape and retry
// behavior they had when this was backed by GitHub, so nothing above this
// point in the file needed to change.

function newVersionToken() {
  return cryptoRandomId() + cryptoRandomId();
}

async function readJsonArrayFile(env, path) {
  const row = await env.DB.prepare('SELECT content, version FROM documents WHERE path = ?1').bind(path).first();
  if (!row) return { items: [], sha: null };
  let items = [];
  try { items = JSON.parse(row.content); if (!Array.isArray(items)) items = []; } catch (e) { items = []; }
  return { items: items, sha: row.version };
}

// Returns { ok: true } or { ok: false, conflict: true } - never throws for a
// normal conflict, mirroring the old fetch-based version's res.ok/409 shape
// closely enough for mutateJsonArrayFile below to behave identically.
async function writeDocumentRow(env, path, content, sha) {
  const version = newVersionToken();
  const now = new Date().toISOString();
  if (sha) {
    const res = await env.DB.prepare(
      'UPDATE documents SET content = ?1, version = ?2, updated_at = ?3 WHERE path = ?4 AND version = ?5'
    ).bind(content, version, now, path, sha).run();
    if (!res.meta || res.meta.changes === 0) return { ok: false, conflict: true };
    return { ok: true };
  }
  try {
    await env.DB.prepare(
      'INSERT INTO documents (path, content, version, updated_at) VALUES (?1, ?2, ?3, ?4)'
    ).bind(path, content, version, now).run();
    return { ok: true };
  } catch (e) {
    return { ok: false, conflict: true }; // path already exists - a race with another writer
  }
}

async function writeJsonArrayFile(env, path, items, sha) {
  return writeDocumentRow(env, path, JSON.stringify(items, null, 2), sha);
}

// mutateFn(items) -> { items, meta? } to write, or null/falsy to signal "not found".
// Retries once on a version conflict, re-reading fresh state and re-applying mutateFn.
async function mutateJsonArrayFile(env, path, mutateFn, opts) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await readJsonArrayFile(env, path);
    const outcome = mutateFn(state.items.slice());
    if (!outcome) return (opts && opts.requireFound) ? 'not-found' : { ok: false, message: 'Not found.' };
    const res = await writeJsonArrayFile(env, path, outcome.items, state.sha);
    if (res.ok) return { ok: true, items: outcome.items, meta: outcome.meta };
    if (res.conflict && attempt === 0) continue; // someone else wrote in between - retry once
    return { ok: false, message: 'Could not save after a conflicting update - please try again.' };
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

// ---- generic JSON-*object*-file read/write (data/counters.json) -----------
// Same optimistic-concurrency shape as the array-file helpers above, but for
// a single JSON object rather than a list - used for the Dessimate PO /
// Shipment / Dessimate Invoice numbering counters.
async function readJsonObjectFile(env, path, defaults) {
  const row = await env.DB.prepare('SELECT content, version FROM documents WHERE path = ?1').bind(path).first();
  if (!row) return { obj: Object.assign({}, defaults), sha: null };
  let obj = {};
  try {
    obj = JSON.parse(row.content);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = {};
  } catch (e) { obj = {}; }
  return { obj: Object.assign({}, defaults, obj), sha: row.version };
}
async function writeJsonObjectFile(env, path, obj, sha) {
  return writeDocumentRow(env, path, JSON.stringify(obj, null, 2), sha);
}
// mutateFn(obj) -> { obj, meta? } to write. Retries once on a version conflict.
async function mutateJsonObjectFile(env, path, defaults, mutateFn) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await readJsonObjectFile(env, path, defaults);
    const outcome = mutateFn(Object.assign({}, state.obj));
    const res = await writeJsonObjectFile(env, path, outcome.obj, state.sha);
    if (res.ok) return { ok: true, obj: outcome.obj, meta: outcome.meta };
    if (res.conflict && attempt === 0) continue; // someone else wrote in between - retry once
    return { ok: false, message: 'Could not save after a conflicting update - please try again.' };
  }
  return { ok: false, message: 'Could not save after a conflicting update - please try again.' };
}

// ---- R2-backed raw file storage --------------------------------------------

// Chunked to avoid blowing the call stack on large files (same technique the
// frontend already uses for the same job).
function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Raw-bytes read of an arbitrary stored file (images, PDFs) for server-side
// use (e.g. embedding an approver's stamp image into a generated PDF) - not
// routed to the browser, just used internally.
async function readGithubFileBytes(env, path) {
  const obj = await env.FILES.get(path);
  if (!obj) return null;
  return new Uint8Array(await obj.arrayBuffer());
}

// ---- proxy routes (PDIRs, drafts, docs) ------------------------------------
// Response shapes here deliberately still mirror GitHub's old Contents API
// (base64 "content" + "sha" for a file, an array for a directory listing) so
// the existing frontend code needs no changes - see the file header.

async function proxyContents(request, env, origin, ghPath) {
  if (request.method === 'PUT') {
    let body;
    try { body = JSON.parse(await request.text()); } catch (e) {
      return json({ message: 'Invalid request body.' }, 400, origin);
    }
    let bytes;
    try { bytes = base64ToBytes(body.content || ''); } catch (e) {
      return json({ message: 'Invalid file content.' }, 400, origin);
    }
    if (body.sha) {
      const current = await env.FILES.head(ghPath);
      if (!current || current.etag !== body.sha) {
        return json({ message: 'sha does not match current file - refresh and retry.' }, 409, origin);
      }
    }
    const put = await env.FILES.put(ghPath, bytes);
    const head = put || (await env.FILES.head(ghPath));
    const name = ghPath.split('/').pop();
    return json({ content: { sha: head.etag, path: ghPath, name: name, size: bytes.length }, sha: head.etag }, 200, origin);
  }

  const obj = await env.FILES.get(ghPath);
  if (!obj) {
    // Not an exact file - see if it's a "directory" of files instead (a
    // handful of pages list a folder's contents this way).
    const prefix = ghPath.endsWith('/') ? ghPath : ghPath + '/';
    const listing = await env.FILES.list({ prefix: prefix });
    if (listing.objects.length > 0) {
      const seen = {};
      const entries = [];
      listing.objects.forEach(function (o) {
        const rest = o.key.slice(prefix.length);
        const name = rest.split('/')[0];
        if (seen[name]) return;
        seen[name] = true;
        entries.push({ name: name, path: prefix + name, type: rest.indexOf('/') === -1 ? 'file' : 'dir', sha: o.etag, size: o.size });
      });
      return json(entries, 200, origin);
    }
    return json({ message: 'Not Found' }, 404, origin);
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const name = ghPath.split('/').pop();
  return json({
    sha: obj.etag, content: bytesToBase64(bytes), encoding: 'base64',
    name: name, path: ghPath, type: 'file', size: bytes.length
  }, 200, origin);
}

async function proxyCommits(request, env, origin, path) {
  // "Last modified" info for a path - an R2 file's upload time, or a D1
  // document row's updated_at - wrapped in the same array-of-commits shape
  // the old GitHub-backed version returned, so any caller reading
  // result[0].commit.author.date keeps working unchanged.
  const head = await env.FILES.head(path);
  if (head) {
    const iso = head.uploaded.toISOString();
    return json([{ sha: head.etag, commit: { author: { date: iso }, committer: { date: iso }, message: 'Updated' } }], 200, origin);
  }
  const row = await env.DB.prepare('SELECT version, updated_at FROM documents WHERE path = ?1').bind(path).first();
  if (row) {
    return json([{ sha: row.version, commit: { author: { date: row.updated_at }, committer: { date: row.updated_at }, message: 'Updated' } }], 200, origin);
  }
  return json([], 200, origin);
}

// ---- auth helpers -------------------------------------------------------

// ---- one-time GitHub -> D1/R2 data migration -------------------------------
// Bootstrap-only route: copies every "database" JSON file and every stored
// document/drawing/PDF out of the old public GitHub repo and into this
// Worker's own D1 (documents table) and R2 (FILES bucket). It never writes
// back to GitHub or deletes anything there - safe to point at the live repo
// while it's still in use, and safe to re-run (already-migrated paths are
// skipped, tracked in a small manifest document at "_migration/manifest.json"
// so a re-run costs almost nothing and a partial run just picks up where it
// left off). Reads GitHub's public API/raw endpoints unauthenticated - no
// GitHub token is needed for this, since the repo being migrated away from
// is the public one.
//
// Protected by env.MIGRATION_KEY (a Worker secret, not a session token) since
// it must be runnable before any user account exists in the new D1 users
// document. Once the migration is verified complete, remove this route (or
// just `wrangler secret delete MIGRATION_KEY`) - it isn't needed again.
//
// Usage: POST /admin/migrate-from-github?key=<MIGRATION_KEY>&limit=20
// Call it repeatedly (e.g. from a browser bookmarklet or curl) until the
// response says "done": true.

const MIGRATION_SOURCE_OWNER = 'Rapidbizservices';
const MIGRATION_SOURCE_REPO = 'RBS_Dessimate_Forms_Portal';
const MIGRATION_SOURCE_BRANCH = 'main';
const MIGRATION_MANIFEST_PATH = '_migration/manifest.json';
// Only paths under these folders are ever copied - matches the folders the
// app actually uses in the source repo (see worker/src/index.js's *_FILE_PATH
// and *_DOC_FOLDER constants, plus the folders the frontend writes drawings/
// PDFs/drafts into directly). Anything else in the repo (the HTML pages,
// worker/, .github/) is source code, not data, and is deliberately never
// touched by this route.
const MIGRATION_FOLDERS = [
  'data/', 'org_docs/', 'part_docs/', 'apqp_docs/', 'customer_po_docs/',
  'pdir_docs/', 'pdir_drafts/', 'pdir_meta/', 'pdirs/', 'supplier_invoice_docs/',
  'dessimate_po_docs/'
];

async function handleMigrateFromGithub(request, env, origin) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';
  if (!env.MIGRATION_KEY || key !== env.MIGRATION_KEY) {
    return json({ message: 'Not found.' }, 404, origin); // deliberately vague - don't confirm this route exists
  }
  const limit = Math.max(1, Math.min(30, parseInt(url.searchParams.get('limit') || '20', 10) || 20));

  // 1. Full file listing from the source repo (one call - the whole repo is
  //    small enough that GitHub never truncates this).
  const treeUrl = 'https://api.github.com/repos/' + MIGRATION_SOURCE_OWNER + '/' + MIGRATION_SOURCE_REPO +
    '/git/trees/' + MIGRATION_SOURCE_BRANCH + '?recursive=1';
  const treeRes = await fetch(treeUrl, { headers: { 'User-Agent': 'dscm-migration-worker', 'Accept': 'application/vnd.github+json' } });
  if (!treeRes.ok) {
    return json({ message: 'Could not list source repo (' + treeRes.status + ').' }, 502, origin);
  }
  const tree = await treeRes.json();
  if (tree.truncated) {
    return json({ message: 'Repo tree listing was truncated - migration script needs updating for a repo this large.' }, 500, origin);
  }
  const allPaths = (tree.tree || [])
    .filter(function (entry) { return entry.type === 'blob'; })
    .map(function (entry) { return entry.path; })
    .filter(function (path) { return MIGRATION_FOLDERS.some(function (folder) { return path.indexOf(folder) === 0; }); });

  // 2. What's already been migrated (persisted so re-runs are cheap and a
  //    partial run resumes correctly).
  const manifestState = await readJsonObjectFile(env, MIGRATION_MANIFEST_PATH, { done: [] });
  const doneSet = {};
  (manifestState.obj.done || []).forEach(function (p) { doneSet[p] = true; });

  const remaining = allPaths.filter(function (p) { return !doneSet[p]; });
  const batch = remaining.slice(0, limit);
  const migratedThisRun = [];
  const errors = [];

  for (const path of batch) {
    try {
      const rawUrl = 'https://raw.githubusercontent.com/' + MIGRATION_SOURCE_OWNER + '/' + MIGRATION_SOURCE_REPO +
        '/' + MIGRATION_SOURCE_BRANCH + '/' + path.split('/').map(encodeURIComponent).join('/');
      const fileRes = await fetch(rawUrl, { headers: { 'User-Agent': 'dscm-migration-worker' } });
      if (!fileRes.ok) {
        errors.push({ path: path, error: 'fetch failed (' + fileRes.status + ')' });
        continue;
      }
      if (path.indexOf('data/') === 0) {
        const text = await fileRes.text();
        const version = newVersionToken();
        const now = new Date().toISOString();
        await env.DB.prepare(
          'INSERT INTO documents (path, content, version, updated_at) VALUES (?1, ?2, ?3, ?4) ' +
          'ON CONFLICT(path) DO UPDATE SET content = excluded.content, version = excluded.version, updated_at = excluded.updated_at'
        ).bind(path, text, version, now).run();
      } else {
        const bytes = await fileRes.arrayBuffer();
        await env.FILES.put(path, bytes);
      }
      migratedThisRun.push(path);
      doneSet[path] = true;
    } catch (e) {
      errors.push({ path: path, error: String(e && e.message || e) });
    }
  }

  // 3. Persist progress - even if a later path in this batch failed, keep
  //    everything that succeeded so it's never re-copied.
  const newManifest = { done: Object.keys(doneSet), lastRunAt: new Date().toISOString() };
  await writeJsonObjectFile(env, MIGRATION_MANIFEST_PATH, newManifest, manifestState.sha);

  const stillRemaining = allPaths.length - Object.keys(doneSet).length;
  return json({
    totalPathsInSourceRepo: allPaths.length,
    alreadyMigratedBeforeThisRun: Object.keys(doneSet).length - migratedThisRun.length,
    migratedThisRun: migratedThisRun,
    errors: errors,
    remaining: Math.max(0, stillRemaining),
    done: stillRemaining <= 0 && errors.length === 0
  }, 200, origin);
}

async function requireAuth(request, env) {
  const header = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/.exec(header);
  if (!m) return { ok: false, status: 401, message: 'Not logged in.' };
  const verified = await verifyToken(m[1], env.SESSION_SECRET);
  if (!verified) return { ok: false, status: 401, message: 'Your session has expired â€” please log in again.' };
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
    return { ok: false, status: 403, message: 'You donâ€™t have access to this.' };
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
