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
 *   PUT    /me/password               - auth required (any role, not impersonating); self-service
 *                                        password change - { currentPassword, newPassword } ->
 *                                        { ok: true }. Verifies currentPassword itself; never an
 *                                        Admin-privileged path, can only touch the caller's own
 *                                        account.
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
 *   GET    /rfqs                       - auth required (any signed-in user); full RFQ list, scoped
 *                                        (a Supplier login sees only RFQs shared with its own
 *                                        organization, and only its own submitted quote on each; a
 *                                        Customer login has no role in this module at all - Rev2.27
 *                                        split the Customer-facing half out to /customer-rfqs).
 *   POST   /rfqs                       - team_member or above required; create an RFQ.
 *   GET    /rfqs/peek-number           - team_member or above required; preview of the next
 *                                        auto-assigned RFQ Number (does not consume it).
 *   PUT    /rfqs/<id>                  - team_member or above required; update one (RFQ Number
 *                                        stays editable indefinitely, unlike Dessimate PO Number).
 *   DELETE /rfqs/<id>                  - team_member or above required; hard delete (attachments
 *                                        left in place, same as Dessimate PO/Customer PO).
 *   PUT    /rfqs/<id>/quote            - Supplier only, and only if that RFQ has been shared with
 *                                        their organization; submits/updates their own price/
 *                                        tooling-cost quote and quote attachments.
 *   POST   /rfqs/<id>/comments         - team_member or above, OR a Supplier on an RFQ shared with
 *                                        their organization; appends a note to the Notes/Comments
 *                                        thread (Rev2.29 - superseded the old single `notes` field).
 *   PUT    /rfqs/<id>/comments/<commentId>
 *                                       - team_member or above (any comment), OR the comment's own
 *                                        Supplier author (their own comment only, on an RFQ shared
 *                                        with their organization); edits its text in place.
 *   POST   /rfqs/clone-to-customer-rfqs
 *                                       - super_admin only; one-time snapshot clone of every RFQ
 *                                        into the Customer RFQ store (new 8000-series numbers,
 *                                        Supplier data dropped, attachment bytes physically copied
 *                                        to new R2 paths). Idempotent - already-cloned RFQs are
 *                                        skipped on a re-run.
 *   GET    /customer-rfqs              - auth required (any signed-in user); full Customer RFQ list,
 *                                        scoped (a Customer login sees only RFQs shared with its own
 *                                        organization, and the Dessimate Quote only once it's been
 *                                        submitted; there is no Supplier role in this module).
 *   POST   /customer-rfqs              - team_member or above required; create a Customer RFQ.
 *   GET    /customer-rfqs/peek-number  - team_member or above required; preview of the next
 *                                        auto-assigned Customer RFQ Number (8000-series, separate
 *                                        counter from /rfqs - does not consume it).
 *   POST   /customer-rfqs/renumber-to-8000-series
 *                                       - super_admin only; one-time admin fix (Rev2.28) - the
 *                                        series was originally 9500 (too close to the Dessimate
 *                                        RFQ module's own 9000-series and confusingly similar),
 *                                        changed to 8000 before real customer-facing use. Re-
 *                                        assigns every existing Customer RFQ's number sequentially
 *                                        starting at 8000 (stable order - sorted by current
 *                                        rfqNumber) and resets the counter to the next number
 *                                        after the last one assigned. Safe to re-run (always
 *                                        produces the same 8000..8000+N-1 sequence).
 *   PUT    /customer-rfqs/<id>         - team_member or above required; update one (RFQ Number
 *                                        stays editable indefinitely, same as /rfqs/<id>).
 *   DELETE /customer-rfqs/<id>         - team_member or above required; hard delete (attachments
 *                                        left in place, same as the other modules).
 *   PUT    /customer-rfqs/<id>/dessimate-quote
 *                                       - admin or above required; submits/updates the "Dessimate
 *                                        Quote" back to the Customer - invisible to that Customer
 *                                        login until called with submit:true.
 *   GET    /change-requests            - any signed-in user; scoped by role (team_member or above
 *                                        sees every CR; a Supplier login sees only CRs where it's
 *                                        the named supplierOrg, in either direction).
 *   POST   /change-requests            - team_member or above, OR supplier; creates a CR. A
 *                                        Supplier's supplierOrg is always forced to their own
 *                                        resolved organization server-side, and any Approval-section
 *                                        fields in the body are silently ignored (Team Member+ only).
 *   GET    /change-requests/peek-number - team_member or above required; preview of the next
 *                                        auto-assigned CR Number (does not consume it).
 *   GET    /change-requests/<id>/pdf   - same read access as the record itself; renders the
 *                                        Dessimate_Change_Request(CR).xlsx layout as a PDF.
 *   PUT    /change-requests/<id>       - team_member or above, OR the owning Supplier; same
 *                                        Approval-section stripping as POST. A Supplier can only
 *                                        edit a CR where they're already the supplierOrg.
 *   DELETE /change-requests/<id>       - team_member or above required (a Supplier can create/edit
 *                                        their own CR, but never delete one - see module comment).
 *   GET    /scrs                       - any signed-in user; scoped (team_member or above sees every
 *                                        SCR; a Customer login sees only SCRs explicitly shared with
 *                                        its org; a Supplier login sees none at all - zero access).
 *   POST   /scrs                       - team_member or above required (Dessimate-staff-only end to
 *                                        end, unlike the CR module - no Supplier write).
 *   GET    /scrs/peek-number           - team_member or above required; preview of the next
 *                                        auto-assigned SCR Number (does not consume it).
 *   PUT    /scrs/<id>                  - team_member or above required.
 *   DELETE /scrs/<id>                  - team_member or above required.
 *   GET    /dmrs                       - any signed-in user; scoped (team_member or above sees every
 *                                        DMR; a Supplier login sees only DMRs naming its org; a
 *                                        Customer login sees none - no role in this module).
 *   POST   /dmrs                       - team_member or above required (a Supplier never creates a
 *                                        DMR, only responds to one - see module comment).
 *   GET    /dmrs/peek-number           - team_member or above required; preview of the next
 *                                        auto-assigned DMR Number (does not consume it).
 *   GET    /dmrs/<id>/pdf              - same read access as the record itself.
 *   PUT    /dmrs/<id>                  - team_member or above (full edit), OR the owning Supplier
 *                                        (Section 7 "Supplier Response" fields only - everything
 *                                        else in the body is silently ignored).
 *   DELETE /dmrs/<id>                  - team_member or above required.
 *   GET    /customer-dmrs              - any signed-in user; scoped (team_member or above sees
 *                                        every Customer DMR; a Customer login sees only ones
 *                                        naming its own org; a Supplier login sees none).
 *   POST   /customer-dmrs              - team_member or above required (a Customer never
 *                                        creates one, only reviews/closes - see module comment).
 *   GET    /customer-dmrs/<id>/pdf     - same read access as the record itself.
 *   PUT    /customer-dmrs/<id>         - team_member or above (full edit), OR the owning
 *                                        Customer (Section 8 "Customer Review/Closure" fields
 *                                        only - everything else in the body is silently ignored).
 *   POST   /customer-dmrs/<id>/comments - team_member or above, OR the owning Customer; appends
 *                                        one authored/timestamped entry to Section 8's comment
 *                                        thread. No edit/delete route - by design.
 *   DELETE /customer-dmrs/<id>         - team_member or above required.
 *   GET    /customer-open-issues       - any signed-in user; scoped (team_member or above sees
 *                                        every open issue; a Customer login sees only ones
 *                                        naming its own org; a Supplier login sees none).
 *   POST   /customer-open-issues       - team_member or above required (a Customer never
 *                                        creates one, only views/comments - see module comment).
 *   GET    /customer-open-issues/peek-number - team_member or above required; preview of the
 *                                        next auto-assigned Issue Number (does not consume it).
 *   PUT    /customer-open-issues/<id>  - team_member or above required (a Customer never
 *                                        edits the record itself, only comments).
 *   POST   /customer-open-issues/<id>/comments - team_member or above, OR the owning
 *                                        Customer; appends one authored/timestamped entry to
 *                                        the Notes/Comments thread.
 *   PUT    /customer-open-issues/<id>/comments/<commentId> - team_member or above (any
 *                                        comment), OR the owning Customer (their own comment
 *                                        only); edits that entry's text. No delete route.
 *   DELETE /customer-open-issues/<id>  - team_member or above required.
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

// Used by isContentsPathAllowedForExternal to gate a Supplier/Customer's raw
// /contents/ access to a Part's attachments (drawings, .stp/.step files,
// etc.) - same ownership check scopeParts already uses for the list itself.
// Returns { customer, suppliers } or null if the Part doesn't exist.
async function resolvePartOwnership(env, partId) {
  const state = await readJsonArrayFile(env, PARTS_FILE_PATH);
  const part = state.items.find(function (o) { return o.id === partId; });
  if (!part) return null;
  return { customer: part.customer || '', suppliers: Array.isArray(part.suppliers) ? part.suppliers : [] };
}

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
// Rev2.6: aboutText backs the dashboard's "About DSCM" section - editable
// only by a Super Admin (see handleUpdateAppConfig), shown to everyone.
const DEFAULT_APP_CONFIG = { version: '2.2', builtLabel: 'Built September 2026', aboutText: '' };

const APQP_FILE_PATH = 'data/apqp.json';
const APQP_DOC_FOLDER = 'apqp_docs';

// Used by isContentsPathAllowedForExternal to gate a Supplier/Customer's raw
// /contents/ access to an APQP record's checklist-item files - returns the
// record's partNumber (APQP visibility is Part-based, same as PDIR - see
// handleListApqp), or null if the record doesn't exist.
async function resolveApqpRecordPartNumber(env, recordId) {
  const state = await readJsonArrayFile(env, APQP_FILE_PATH);
  const record = state.items.find(function (o) { return o.id === recordId; });
  return record ? (record.partNumber || '') : null;
}
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
        // Rev2.16: a Supplier/Customer's own organization name, so a page
        // like Change Requests can lock a "which org is this for" dropdown
        // to their own name without needing them to already own a record to
        // infer it from - same resolveUserOrganization used everywhere else
        // an org-scoped write needs to know who's asking.
        const organization = (accessLevel === 'supplier' || accessLevel === 'customer')
          ? await resolveUserOrganization(env, auth.username)
          : '';
        return json({ username: auth.username, accessLevel: accessLevel, organization: organization, impersonatedBy: auth.impersonatedBy || null }, 200, origin);
      }

      if (url.pathname === '/me/password' && request.method === 'PUT') {
        const auth = await requireAuth(request, env);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        // A Super Admin "Log in as" session shouldn't be able to quietly
        // change the impersonated person's password - that already has its
        // own explicit, logged path via the Users admin page.
        if (auth.impersonatedBy) return json({ message: "Can't change a password while impersonating another user — use the Users admin page instead." }, 403, origin);
        return await handleChangeOwnPassword(request, env, origin, auth.username);
      }

      // Rev2.4: Super Admin "Log in as" - see handleAdminImpersonate.
      if (/^\/admin\/users\/[^/]+\/impersonate$/.test(url.pathname) && request.method === 'POST') {
        const id = decodeURIComponent(url.pathname.split('/')[3]);
        const auth = await requireRole(request, env, ['super_admin']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handleAdminImpersonate(env, origin, id, auth.username);
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
          // Rev2.7: tightened from team_member+ to admin+, matching the
          // Customer PO and Dessimate Invoice write gates - a Dessimate PO is
          // just as commercially sensitive as those, and leaving it open to
          // Team Member was an inconsistency the product owner flagged
          // ("no access to create ... to any one other than Admin and Super
          // Admin"). PUT/DELETE and the peek-numbers preview below were
          // tightened the same way so there's no leftover route a Team
          // Member could still reach.
          const auth = await requireRole(request, env, ['super_admin', 'admin']);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleCreateDessimatePo(request, env, origin);
        }
      }

      // Non-mutating preview of what "Use System Number" would assign, for
      // the Add-Dessimate-PO modal's voluntary/optional numbering (Rev2).
      // Checked before the generic '/dessimate-pos/' handler below, same
      // reason as the PDF route just below it.
      if (url.pathname === '/dessimate-pos/peek-numbers' && request.method === 'GET') {
        const auth = await requireRole(request, env, ['super_admin', 'admin']);
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
        const auth = await requireRole(request, env, ['super_admin', 'admin']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        if (request.method === 'PUT') return await handleUpdateDessimatePo(request, env, origin, id);
        if (request.method === 'DELETE') return await handleDeleteDessimatePo(env, origin, id);
      }

      if (url.pathname === '/rfqs') {
        if (request.method === 'GET') {
          const auth = await requireAuthWithScope(request, env);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleListRfqs(env, origin, auth.accessLevel, auth.organization);
        }
        if (request.method === 'POST') {
          const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleCreateRfq(request, env, origin);
        }
      }

      // Non-mutating preview of what "Use System Number" would assign, for
      // the Add-RFQ modal's voluntary/optional numbering - same pattern as
      // /dessimate-pos/peek-numbers. Checked before the generic '/rfqs/'
      // handler below, same reason as that route.
      if (url.pathname === '/rfqs/peek-number' && request.method === 'GET') {
        const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handlePeekRfqNumber(env, origin);
      }

      // A Supplier submits their price/tooling-cost quote through this
      // narrow endpoint (never the generic record PUT below), so their
      // write can only ever touch their own supplierQuotes entry. Checked
      // before the generic '/rfqs/<id>' block, same "specific route before
      // generic prefix" ordering used throughout this file.
      if (/^\/rfqs\/[^/]+\/quote$/.test(url.pathname) && request.method === 'PUT') {
        const id = decodeURIComponent(url.pathname.split('/')[2]);
        const auth = await requireRole(request, env, ['supplier']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        const organization = await resolveUserOrganization(env, auth.username);
        return await handleSubmitRfqQuote(request, env, origin, id, organization, auth.username);
      }

      // Notes/Comments thread (Rev2.29) - its own routes, same pattern as
      // Customer Open Issues' comment thread. Checked before the generic
      // '/rfqs/' block below so they don't get swallowed by the id-only
      // match.
      if (/^\/rfqs\/[^/]+\/comments$/.test(url.pathname) && request.method === 'POST') {
        const id = decodeURIComponent(url.pathname.split('/')[2]);
        const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member', 'supplier']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handleAddRfqComment(request, env, origin, id, auth.accessLevel, auth.username);
      }
      if (/^\/rfqs\/[^/]+\/comments\/[^/]+$/.test(url.pathname) && request.method === 'PUT') {
        const parts = url.pathname.split('/');
        const id = decodeURIComponent(parts[2]);
        const commentId = decodeURIComponent(parts[4]);
        const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member', 'supplier']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handleEditRfqComment(request, env, origin, id, commentId, auth.accessLevel, auth.username);
      }

      // One-time snapshot clone of every RFQ into the new Customer RFQ
      // store (see handleCloneRfqsToCustomerRfqs) - Super Admin only, since
      // it's a one-shot data-migration operation, not routine record
      // management. Checked before the generic '/rfqs/' block below, same
      // ordering as every other specific-before-prefix route in this file.
      if (url.pathname === '/rfqs/clone-to-customer-rfqs' && request.method === 'POST') {
        const auth = await requireRole(request, env, ['super_admin']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handleCloneRfqsToCustomerRfqs(env, origin);
      }

      if (url.pathname.startsWith('/rfqs/')) {
        const id = decodeURIComponent(url.pathname.slice('/rfqs/'.length));
        const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        if (request.method === 'PUT') return await handleUpdateRfq(request, env, origin, id);
        if (request.method === 'DELETE') return await handleDeleteRfq(env, origin, id);
      }

      if (url.pathname === '/customer-rfqs') {
        if (request.method === 'GET') {
          const auth = await requireAuthWithScope(request, env);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleListCustomerRfqs(env, origin, auth.accessLevel, auth.organization);
        }
        if (request.method === 'POST') {
          const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleCreateCustomerRfq(request, env, origin);
        }
      }

      if (url.pathname === '/customer-rfqs/peek-number' && request.method === 'GET') {
        const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handlePeekCustomerRfqNumber(env, origin);
      }

      // One-time admin fix (Rev2.28) - see handleRenumberCustomerRfqsTo8000Series.
      // Super Admin only, same bar as the clone endpoint above (a one-shot
      // data-migration operation, not routine record management).
      if (url.pathname === '/customer-rfqs/renumber-to-8000-series' && request.method === 'POST') {
        const auth = await requireRole(request, env, ['super_admin']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handleRenumberCustomerRfqsTo8000Series(env, origin);
      }

      // The Dessimate Quote back to the Customer - Admin/Super Admin only,
      // same bar as the original RFQ module. Checked before the generic
      // '/customer-rfqs/<id>' block below.
      if (/^\/customer-rfqs\/[^/]+\/dessimate-quote$/.test(url.pathname) && request.method === 'PUT') {
        const id = decodeURIComponent(url.pathname.split('/')[2]);
        const auth = await requireRole(request, env, ['super_admin', 'admin']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handleUpdateCustomerRfqQuote(request, env, origin, id, auth.username);
      }

      if (url.pathname.startsWith('/customer-rfqs/')) {
        const id = decodeURIComponent(url.pathname.slice('/customer-rfqs/'.length));
        const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        if (request.method === 'PUT') return await handleUpdateCustomerRfq(request, env, origin, id);
        if (request.method === 'DELETE') return await handleDeleteCustomerRfq(env, origin, id);
      }

      if (url.pathname === '/change-requests') {
        if (request.method === 'GET') {
          const auth = await requireAuthWithScope(request, env);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleListChangeRequests(env, origin, auth.accessLevel, auth.organization);
        }
        if (request.method === 'POST') {
          // Unlike every other Production Module's create route, a
          // Supplier is allowed here too - see the module comment above
          // handleCreateChangeRequest for why.
          const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member', 'supplier']);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleCreateChangeRequest(request, env, origin, auth.accessLevel, auth.username);
        }
      }

      // Non-mutating preview of what "Use System Number" would assign -
      // Team Member+ only (a Supplier never sets/changes the CR Number).
      // Checked before the generic '/change-requests/' block below, same
      // "specific route before generic prefix" ordering used throughout.
      if (url.pathname === '/change-requests/peek-number' && request.method === 'GET') {
        const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handlePeekCrNumber(env, origin);
      }

      // PDF export - same read-access rule as the record itself (Team
      // Member+ always, a Supplier only for their own CR). Checked before
      // the generic '/change-requests/<id>' block, same ordering as the
      // peek-number route just above.
      if (/^\/change-requests\/[^/]+\/pdf$/.test(url.pathname) && request.method === 'GET') {
        const id = decodeURIComponent(url.pathname.split('/')[2]);
        const auth = await requireAuthWithScope(request, env);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handleGetChangeRequestPdf(env, origin, id, auth.accessLevel, auth.organization);
      }

      if (url.pathname.startsWith('/change-requests/')) {
        const id = decodeURIComponent(url.pathname.slice('/change-requests/'.length));
        if (request.method === 'PUT') {
          const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member', 'supplier']);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleUpdateChangeRequest(request, env, origin, id, auth.accessLevel, auth.username);
        }
        if (request.method === 'DELETE') {
          // Delete stays Team Member+ only - see the module comment above.
          const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleDeleteChangeRequest(env, origin, id);
        }
      }

      if (url.pathname === '/scrs') {
        if (request.method === 'GET') {
          // Any signed-in user is "ok" here - scopeScrs itself returns []
          // for a Supplier (zero access, confirmed) and for a Customer with
          // nothing shared to them yet, same non-gating GET pattern as
          // every other scoped list route.
          const auth = await requireAuthWithScope(request, env);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleListScrs(env, origin, auth.accessLevel, auth.organization);
        }
        if (request.method === 'POST') {
          // Dessimate-staff-only end to end - see the module comment above.
          const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleCreateScr(request, env, origin, auth.username);
        }
      }

      if (url.pathname === '/scrs/peek-number' && request.method === 'GET') {
        const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handlePeekScrNumber(env, origin);
      }

      if (url.pathname.startsWith('/scrs/')) {
        const id = decodeURIComponent(url.pathname.slice('/scrs/'.length));
        const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        if (request.method === 'PUT') return await handleUpdateScr(request, env, origin, id);
        if (request.method === 'DELETE') return await handleDeleteScr(env, origin, id);
      }

      if (url.pathname === '/dmrs') {
        if (request.method === 'GET') {
          // Any signed-in user is "ok" here - scopeDmrs itself narrows a
          // Supplier to their own org and a Customer to nothing.
          const auth = await requireAuthWithScope(request, env);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleListDmrs(env, origin, auth.accessLevel, auth.organization);
        }
        if (request.method === 'POST') {
          // Staff-only - a Supplier never creates a DMR, see the module
          // comment above.
          const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleCreateDmr(request, env, origin, auth.username);
        }
      }

      if (url.pathname === '/dmrs/peek-number' && request.method === 'GET') {
        const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handlePeekDmrNumber(env, origin);
      }

      // PDF export - same read-access rule as the record itself (Team
      // Member+ always, a Supplier only for their own DMR).
      if (/^\/dmrs\/[^/]+\/pdf$/.test(url.pathname) && request.method === 'GET') {
        const id = decodeURIComponent(url.pathname.split('/')[2]);
        const auth = await requireAuthWithScope(request, env);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handleGetDmrPdf(env, origin, id, auth.accessLevel, auth.organization);
      }

      if (url.pathname.startsWith('/dmrs/')) {
        const id = decodeURIComponent(url.pathname.slice('/dmrs/'.length));
        if (request.method === 'PUT') {
          // Team Member+ full edit, OR the owning Supplier (Section 7
          // only - handleUpdateDmr/validateDmrFields enforce this).
          const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member', 'supplier']);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleUpdateDmr(request, env, origin, id, auth.accessLevel, auth.username);
        }
        if (request.method === 'DELETE') {
          const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleDeleteDmr(env, origin, id);
        }
      }

      if (url.pathname === '/customer-dmrs') {
        if (request.method === 'GET') {
          // Any signed-in user is "ok" here - scopeCustomerDmrs itself
          // narrows a Customer to their own org and a Supplier to nothing.
          const auth = await requireAuthWithScope(request, env);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleListCustomerDmrs(env, origin, auth.accessLevel, auth.organization);
        }
        if (request.method === 'POST') {
          // Staff-only - a Customer never creates a Customer DMR, see the
          // module comment above.
          const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleCreateCustomerDmr(request, env, origin, auth.username);
        }
      }

      // Section 8 comment thread - append-only, its own route (see the
      // module comment above). Checked before the generic PUT/DELETE
      // block below so it doesn't get swallowed by the id-only match.
      if (/^\/customer-dmrs\/[^/]+\/comments$/.test(url.pathname) && request.method === 'POST') {
        const id = decodeURIComponent(url.pathname.split('/')[2]);
        const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member', 'customer']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handleAddCustomerDmrComment(request, env, origin, id, auth.accessLevel, auth.username);
      }

      // PDF export - same read-access rule as the record itself (Team
      // Member+ always, a Customer only for their own Customer DMR).
      if (/^\/customer-dmrs\/[^/]+\/pdf$/.test(url.pathname) && request.method === 'GET') {
        const id = decodeURIComponent(url.pathname.split('/')[2]);
        const auth = await requireAuthWithScope(request, env);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handleGetCustomerDmrPdf(env, origin, id, auth.accessLevel, auth.organization);
      }

      if (url.pathname.startsWith('/customer-dmrs/')) {
        const id = decodeURIComponent(url.pathname.slice('/customer-dmrs/'.length));
        if (request.method === 'PUT') {
          // Team Member+ full edit, OR the owning Customer (Section 8
          // only - handleUpdateCustomerDmr/validateCustomerDmrFields
          // enforce this).
          const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member', 'customer']);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleUpdateCustomerDmr(request, env, origin, id, auth.accessLevel, auth.username);
        }
        if (request.method === 'DELETE') {
          const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleDeleteCustomerDmr(env, origin, id);
        }
      }

      if (url.pathname === '/customer-open-issues') {
        if (request.method === 'GET') {
          // Any signed-in user is "ok" here - scopeCustomerOpenIssues
          // itself narrows a Customer to their own org and a Supplier to
          // nothing.
          const auth = await requireAuthWithScope(request, env);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleListCustomerOpenIssues(env, origin, auth.accessLevel, auth.organization);
        }
        if (request.method === 'POST') {
          // Staff-only - a Customer never creates an open issue, see the
          // module comment above.
          const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleCreateCustomerOpenIssue(request, env, origin, auth.username);
        }
      }

      if (url.pathname === '/customer-open-issues/peek-number' && request.method === 'GET') {
        const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handlePeekOpenIssueNumber(env, origin);
      }

      // Notes/Comments thread - its own routes (see the module comment
      // above). Checked before the generic PUT/DELETE block below so
      // they don't get swallowed by the id-only match.
      if (/^\/customer-open-issues\/[^/]+\/comments$/.test(url.pathname) && request.method === 'POST') {
        const id = decodeURIComponent(url.pathname.split('/')[2]);
        const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member', 'customer']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handleAddOpenIssueComment(request, env, origin, id, auth.accessLevel, auth.username);
      }
      if (/^\/customer-open-issues\/[^/]+\/comments\/[^/]+$/.test(url.pathname) && request.method === 'PUT') {
        const parts = url.pathname.split('/');
        const id = decodeURIComponent(parts[2]);
        const commentId = decodeURIComponent(parts[4]);
        const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member', 'customer']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handleEditOpenIssueComment(request, env, origin, id, commentId, auth.accessLevel, auth.username);
      }

      if (url.pathname.startsWith('/customer-open-issues/')) {
        const id = decodeURIComponent(url.pathname.slice('/customer-open-issues/'.length));
        if (request.method === 'PUT') {
          const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleUpdateCustomerOpenIssue(request, env, origin, id);
        }
        if (request.method === 'DELETE') {
          const auth = await requireRole(request, env, ['super_admin', 'admin', 'team_member']);
          if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
          return await handleDeleteCustomerOpenIssue(env, origin, id);
        }
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

      // Rev2.4: Deleted Invoices view + restore - checked before the generic
      // '/dessimate-invoices/' handler below (same reason as the /pdf route).
      if (url.pathname === '/dessimate-invoices/deleted' && request.method === 'GET') {
        const auth = await requireRole(request, env, ['super_admin', 'admin']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handleListDeletedDessimateInvoices(env, origin);
      }
      if (/^\/dessimate-invoices\/[^/]+\/restore$/.test(url.pathname) && request.method === 'POST') {
        const id = decodeURIComponent(url.pathname.split('/')[2]);
        const auth = await requireRole(request, env, ['super_admin', 'admin']);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handleRestoreDessimateInvoice(env, origin, id);
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

      // Rev2.4: the Packing Slip - a second PDF generated from the same
      // Dessimate Invoice record (Customer/Manufacturer part columns pulled
      // from the Parts master), same route shape as /pdf above.
      if (/^\/dessimate-invoices\/[^/]+\/packing-slip$/.test(url.pathname) && request.method === 'GET') {
        const id = decodeURIComponent(url.pathname.split('/')[2]);
        const auth = await requireAuthWithScope(request, env);
        if (!auth.ok) return json({ message: auth.message }, auth.status, origin);
        return await handleGenerateDessimatePackingSlipPdf(env, origin, id, auth.accessLevel, auth.organization);
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

async function issueSession(username, env, origin, impersonatedBy) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = { u: username, exp: exp };
  if (impersonatedBy) payload.ib = impersonatedBy;
  const token = await signToken(payload, env.SESSION_SECRET);
  const resp = { token: token, username: username, expiresAt: exp * 1000 };
  if (impersonatedBy) resp.impersonatedBy = impersonatedBy;
  return json(resp, 200, origin);
}

// PUT /me/password - self-service password change (Rev2.11), open to any
// signed-in role (Dessimate Team member, Supplier, Customer alike). Not an
// Admin-privileged action - it can only ever touch the caller's own record,
// verified by re-checking their current password the same way handleLogin
// does. Same {username, salt, hash} shape handleAdminUpdateUser writes,
// reused here so a password set either way looks identical on file.
async function handleChangeOwnPassword(request, env, origin, username) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const currentPassword = (body.currentPassword || '').toString();
  const newPassword = (body.newPassword || '').toString();
  if (!currentPassword || !newPassword) return json({ message: 'Enter your current password and a new password.' }, 400, origin);
  if (newPassword.length < 8) return json({ message: 'New password must be at least 8 characters.' }, 400, origin);

  const usernameLower = username.toLowerCase();
  const fileState = await readUsersFile(env);
  const fileMatch = fileState.users.find(function (u) { return (u.username || '').toLowerCase() === usernameLower; });

  if (fileMatch) {
    if (!fileMatch.hash) return json({ message: 'This account has no password set yet — contact an Admin.' }, 400, origin);
    const computedHash = await pbkdf2Hex(currentPassword, fileMatch.salt);
    if (computedHash !== fileMatch.hash) return json({ message: 'Current password is incorrect.' }, 401, origin);
    const newSalt = randomSaltHex();
    const newHash = await pbkdf2Hex(newPassword, newSalt);
    const result = await mutateUsersFile(env, function (users) {
      const target = users.find(function (u) { return u.id === fileMatch.id; });
      if (!target) return null;
      target.salt = newSalt;
      target.hash = newHash;
      return { users: users };
    }, { requireFound: true });
    if (result === 'not-found') return json({ message: 'Account not found.' }, 404, origin);
    if (!result.ok) return json({ message: result.message }, 500, origin);
    await clearFailedLogins(env, usernameLower);
    return json({ ok: true }, 200, origin);
  }

  // Legacy-only account (bootstrap STAFF_USERS secret, never migrated into
  // data/users.json - see handleLogin's own two-tier lookup). Verify against
  // the legacy hash, then promote into the file the same way an Admin
  // editing this account would (handleAdminUpdateUser's isLegacyId branch),
  // so it's a normal file-managed account from here on.
  const legacy = readLegacyStaff(env);
  const legacyMatch = legacy.find(function (u) { return (u.username || '').toLowerCase() === usernameLower; });
  if (!legacyMatch) return json({ message: 'Account not found.' }, 404, origin);
  const legacyHash = await pbkdf2Hex(currentPassword, legacyMatch.salt);
  if (legacyHash !== legacyMatch.hash) return json({ message: 'Current password is incorrect.' }, 401, origin);
  const promotedSalt = randomSaltHex();
  const promotedHash = await pbkdf2Hex(newPassword, promotedSalt);
  const promoteResult = await mutateUsersFile(env, function (users) {
    users.push({
      id: cryptoRandomId(), name: legacyMatch.username, username: legacyMatch.username,
      salt: promotedSalt, hash: promotedHash, organization: '', relationship: '', role: '',
      email: '', phone: '', active: true, accessLevel: null, isDemo: false
    });
    return { users: users };
  });
  if (!promoteResult.ok) return json({ message: promoteResult.message }, 500, origin);
  await clearFailedLogins(env, usernameLower);
  return json({ ok: true }, 200, origin);
}

// ---- Rev2.4: Super Admin impersonation ("Log in as") -----------------------
// Best-practice alternative to a second, admin-assigned password per user
// (see worker/README.md) - a Super Admin gets a real session as the target
// user, without ever seeing or handling that person's actual password, and
// every use is logged. The issued token carries "ib" (impersonated-by) so
// GET /me can tell the frontend to show a "Viewing as X — return to your
// account" banner.
const IMPERSONATION_LOG_PATH = 'data/impersonation_log.json';

async function handleAdminImpersonate(env, origin, id, adminUsername) {
  let targetUsername = null;
  if (id.indexOf('legacy:') === 0) {
    const legacy = readLegacyStaff(env);
    const match = legacy.find(function (u) { return u.username && ('legacy:' + u.username.toLowerCase()) === id; });
    if (match) targetUsername = match.username;
  } else {
    const state = await readUsersFile(env);
    const target = state.users.find(function (u) { return u.id === id; });
    if (target && target.username && target.hash) {
      if (target.active === false) return json({ message: 'This account has been deactivated.' }, 400, origin);
      targetUsername = target.username;
    }
  }
  if (!targetUsername) return json({ message: 'This person has no login to view.' }, 400, origin);
  if (targetUsername.toLowerCase() === adminUsername.toLowerCase()) {
    return json({ message: 'That’s already your own account.' }, 400, origin);
  }
  const targetLevel = await resolveAccessLevel(env, targetUsername);
  if (targetLevel === 'super_admin') {
    return json({ message: 'Super Admin accounts can’t be impersonated — sign in as that person directly if needed.' }, 400, origin);
  }

  await mutateJsonArrayFile(env, IMPERSONATION_LOG_PATH, function (items) {
    items.push({ id: cryptoRandomId(), admin: adminUsername, target: targetUsername, at: new Date().toISOString() });
    return { items: items };
  });

  return await issueSession(targetUsername, env, origin, adminUsername);
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
  // Rev2.4: any organization (not just Self) can carry multiple addresses -
  // a Customer/Supplier picks which one applies per PO/Invoice (Ship To
  // dropdown). A legacy org with only the old flat "address" string still
  // reads fine - it just shows as a single unlabeled address until someone
  // adds real entries through the new editor.
  const addresses = Array.isArray(o.addresses) ? o.addresses.map(sanitizeOrgAddress).filter(Boolean) : [];
  if (!addresses.length && o.address) {
    const legacy = sanitizeOrgAddress({ label: 'Address', address: o.address });
    if (legacy) addresses.push(legacy);
  }
  return {
    id: o.id,
    name: o.name || '',
    relationship: o.relationship || 'Supplier',
    address: o.address || '',
    phone: o.phone || '',
    website: o.website || '',
    logo: sanitizeOrgDoc(o.logo),
    addresses: addresses,
    salesEmail: o.salesEmail || '',
    purchasingEmail: o.purchasingEmail || '',
    // Self-org-managed list of Payment Terms options (Rev2.4) - every
    // "Terms" dropdown in the system (Customer PO, Dessimate PO, Dessimate
    // Invoice) reads from here rather than being freehand text, so the
    // choices stay consistent system-wide and are edited in one place.
    paymentTerms: Array.isArray(o.paymentTerms) ? o.paymentTerms.map(function (t) { return (t || '').toString().trim(); }).filter(Boolean) : [],
    // Rev2.20: a lightweight contact directory per organization (name,
    // email, phone, active/inactive) - every "Contact" dropdown on a
    // form (DMR/Customer DMR/CR/SCR today) reads from here instead of
    // freehand typing. Deliberately not a link to an actual user login -
    // that would require rolling out portal access to every org's contact,
    // which is a much longer-term effort; this just gives each form a
    // pick-and-autofill directory in the meantime.
    contacts: Array.isArray(o.contacts) ? o.contacts.map(sanitizeOrgContact).filter(Boolean) : [],
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
  return json({
    version: state.obj.version || DEFAULT_APP_CONFIG.version,
    builtLabel: state.obj.builtLabel || '',
    aboutText: state.obj.aboutText || ''
  }, 200, origin);
}

async function handleUpdateAppConfig(request, env, origin) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const version = (body.version || '').toString().trim();
  if (!version) return json({ message: 'Version is required.' }, 400, origin);
  const builtLabel = (body.builtLabel || '').toString().trim();
  const aboutText = (body.aboutText || '').toString().trim();

  const result = await mutateJsonObjectFile(env, APP_CONFIG_FILE_PATH, DEFAULT_APP_CONFIG, function (obj) {
    obj.version = version;
    obj.builtLabel = builtLabel;
    obj.aboutText = aboutText;
    return { obj: obj };
  });
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json({ version: result.obj.version, builtLabel: result.obj.builtLabel || '', aboutText: result.obj.aboutText || '' }, 200, origin);
}
// Rev2.4: addresses are entered on 2 lines (street, then city/state/zip) for
// cleaner PDF formatting. line1/line2 replace the old single "address"
// string - a legacy entry with only "address" set still reads back fine,
// its whole value landing in line1, until it's next saved through the new
// 2-line editor.
function sanitizeOrgAddress(a) {
  if (!a) return null;
  const label = (a.label || '').toString().trim();
  let line1 = (a.line1 || '').toString().trim();
  let line2 = (a.line2 || '').toString().trim();
  if (!line1 && !line2 && a.address) line1 = (a.address || '').toString().trim();
  if (!label && !line1 && !line2) return null;
  return { label: label, line1: line1, line2: line2 };
}
// One entry in an organization's contact directory (Rev2.20). `status`
// governs whether it's offered in a form's Contact dropdown - an inactive
// contact stays on file (and on anything already saved referencing them)
// but drops out of new selections.
function sanitizeOrgContact(c) {
  if (!c) return null;
  const name = (c.name || '').toString().trim();
  const email = (c.email || '').toString().trim();
  const phone = (c.phone || '').toString().trim();
  if (!name && !email && !phone) return null;
  return {
    id: c.id || cryptoRandomId(),
    name: name,
    email: email,
    phone: phone,
    status: c.status === 'inactive' ? 'inactive' : 'active'
  };
}
function sanitizeOrgDoc(d) {
  if (!d || !d.path) return null;
  return {
    id: d.id || null,
    path: d.path,
    filename: d.filename || '',
    mimeType: d.mimeType || 'application/octet-stream',
    size: typeof d.size === 'number' ? d.size : 0,
    // Rev2.14: who uploaded this file and when, client-stamped at the point
    // a file is actually saved (see each page's ghPutFile call sites) -
    // '' / null for any doc saved before this field existed, so nothing
    // already on file gets retroactively (and wrongly) attributed to anyone.
    uploadedBy: (d && d.uploadedBy) || '',
    uploadedAt: (d && d.uploadedAt) || null
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
  const paymentTerms = Array.isArray(body.paymentTerms)
    ? Array.from(new Set(body.paymentTerms.map(function (t) { return (t || '').toString().trim(); }).filter(Boolean)))
    : [];
  const contacts = Array.isArray(body.contacts) ? body.contacts.map(sanitizeOrgContact).filter(Boolean) : [];
  return {
    name: name,
    relationship: relationship,
    address: (body.address || '').toString().trim(),
    phone: (body.phone || '').toString().trim(),
    website: (body.website || '').toString().trim(),
    addresses: addresses,
    salesEmail: salesEmail,
    purchasingEmail: purchasingEmail,
    paymentTerms: paymentTerms,
    contacts: contacts
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
    paymentTerms: fields.paymentTerms, contacts: fields.contacts,
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
    target.paymentTerms = fields.paymentTerms;
    target.contacts = fields.contacts;
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
    // Rev2.4: for the Packing Slip PDF's Manufacturer/Manufacturer Part #
    // columns - looked up by Part Number at generation time rather than
    // duplicated onto every invoice line.
    manufacturer: p.manufacturer || '',
    manufacturerPartNumber: p.manufacturerPartNumber || '',
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
    manufacturer: (body.manufacturer || '').toString().trim(),
    manufacturerPartNumber: (body.manufacturerPartNumber || '').toString().trim(),
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
    manufacturer: fields.manufacturer, manufacturerPartNumber: fields.manufacturerPartNumber,
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
    target.manufacturer = fields.manufacturer;
    target.manufacturerPartNumber = fields.manufacturerPartNumber;
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
    size: typeof d.size === 'number' ? d.size : 0,
    // Rev2.14: see sanitizeOrgDoc's matching comment - client-stamped at
    // upload time, '' / null for anything saved before this field existed.
    uploadedBy: (d && d.uploadedBy) || '',
    uploadedAt: (d && d.uploadedAt) || null
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
  if (m) {
    const title = m[1];
    const entry = await resolvePdirIndexEntry(env, title);
    if (!entry) return false;
    if (accessLevel === 'supplier') return !!entry.organization && entry.organization === organization;
    const visiblePartNumbers = await resolveCustomerVisiblePartNumbers(env, organization);
    return visiblePartNumbers.has((entry.partNumber || '').toLowerCase());
  }

  // A Supplier/Customer can read the attachments (drawings, .stp/.step
  // files, etc.) on a Part their organization is actually involved with -
  // same ownership check scopeParts already uses for the Parts list itself
  // (a Supplier in the Part's `suppliers` array, a Customer matching the
  // Part's single `customer` field).
  const partDocsMatch = /^part_docs\/([^/]+)\/.+$/.exec(decoded);
  if (partDocsMatch) {
    const part = await resolvePartOwnership(env, partDocsMatch[1]);
    if (!part) return false;
    return accessLevel === 'supplier' ? part.suppliers.indexOf(organization) !== -1 : part.customer === organization;
  }

  // A Supplier/Customer can read the files attached to an APQP checklist
  // item for a Part their organization is involved with - APQP visibility is
  // Part-based (same mechanism as PDIR/Parts, see handleListApqp), so this
  // re-derives the same visible-part-numbers set scopeParts already
  // computes for the APQP list itself.
  const apqpDocsMatch = /^apqp_docs\/([^/]+)\/.+$/.exec(decoded);
  if (apqpDocsMatch) {
    const partNumber = await resolveApqpRecordPartNumber(env, apqpDocsMatch[1]);
    if (!partNumber) return false;
    const partsState = await readJsonArrayFile(env, PARTS_FILE_PATH);
    const visibleParts = scopeParts(partsState.items.map(sanitizePart), accessLevel, organization);
    return visibleParts.some(function (p) { return (p.partNumber || '').toLowerCase() === partNumber.toLowerCase(); });
  }

  // RFQ module - Rev2.27: Supplier-only now (the Customer-facing half moved
  // to its own Customer RFQ module/store below). A Supplier can read the
  // Dessimate-side attachments (rfq_docs) and its own previously-submitted
  // quote files (rfq_quote_docs) for any RFQ currently shared with its
  // organization, plus the one shared quote-format template.
  if (accessLevel === 'supplier') {
    const rfqDocsMatch = /^rfq_docs\/([^/]+)\/.+$/.exec(decoded);
    if (rfqDocsMatch) {
      const rfq = await resolveRfqRecord(env, rfqDocsMatch[1]);
      return !!rfq && rfq.sharedWithSuppliers.indexOf(organization) !== -1;
    }
    if (/^rfq_quote_template\/.+$/.test(decoded)) return true;
    const rfqQuoteDocsMatch = /^rfq_quote_docs\/([^/]+)\/([^/]+)\/.+$/.exec(decoded);
    if (rfqQuoteDocsMatch) {
      if (slugifyOrgName(organization) !== rfqQuoteDocsMatch[2]) return false;
      const rfq = await resolveRfqRecord(env, rfqQuoteDocsMatch[1]);
      return !!rfq && rfq.sharedWithSuppliers.indexOf(organization) !== -1;
    }
    // A Supplier can read the attachments on their own Dessimate PO
    // (dessimate_po_docs) - same ownership check scopeDessimatePos already
    // uses for the list itself.
    const poDocsMatch = /^dessimate_po_docs\/([^/]+)\/.+$/.exec(decoded);
    if (poDocsMatch) {
      const owner = await resolveDessimatePoOwner(env, poDocsMatch[1]);
      return owner !== null && owner === organization;
    }
    // A Supplier can read the attachments on their own submitted Supplier
    // Invoice (supplier_invoice_docs) - same ownership check
    // handleListSupplierInvoices already uses for the list itself.
    const supplierInvoiceDocsMatch = /^supplier_invoice_docs\/([^/]+)\/.+$/.exec(decoded);
    if (supplierInvoiceDocsMatch) {
      const owner = await resolveSupplierInvoiceOwner(env, supplierInvoiceDocsMatch[1]);
      return owner !== null && owner === organization;
    }
    // A Supplier can read the images/attachments on their own Change
    // Request (change_request_docs) - same ownership check
    // scopeChangeRequests already uses for the list itself.
    const crDocsMatch = /^change_request_docs\/([^/]+)\/.+$/.exec(decoded);
    if (crDocsMatch) {
      const cr = await resolveChangeRequestRecord(env, crDocsMatch[1]);
      return !!cr && cr.supplierOrg === organization;
    }
    // A Supplier can read the photos on their own Discrepant Material
    // Report (dmr_docs) - same ownership check scopeDmrs already uses.
    const dmrDocsMatch = /^dmr_docs\/([^/]+)\/.+$/.exec(decoded);
    if (dmrDocsMatch) {
      const dmr = await resolveDmrRecord(env, dmrDocsMatch[1]);
      return !!dmr && dmr.supplierOrg === organization;
    }
  }
  if (accessLevel === 'customer') {
    // Customer RFQ module (Rev2.27) - separate store from the Supplier-only
    // RFQ module above; this module has no Supplier role at all, so both the
    // Dessimate-side attachments and the Dessimate Quote's own attachments
    // are gated on Customer access only.
    const customerRfqDocsMatch = /^customer_rfq_docs\/([^/]+)\/.+$/.exec(decoded);
    if (customerRfqDocsMatch) {
      const rfq = await resolveCustomerRfqRecord(env, customerRfqDocsMatch[1]);
      return !!rfq && rfq.sharedWithCustomers.indexOf(organization) !== -1;
    }
    const customerRfqQuoteDocsMatch = /^customer_rfq_dessimate_quote_docs\/([^/]+)\/.+$/.exec(decoded);
    if (customerRfqQuoteDocsMatch) {
      const rfq = await resolveCustomerRfqRecord(env, customerRfqQuoteDocsMatch[1]);
      return !!rfq && rfq.sharedWithCustomers.indexOf(organization) !== -1 && !!rfq.dessimateQuote.submitted;
    }
    // A Customer can read the attachments/original PO on their own Customer
    // PO (customer_po_docs) and their own Dessimate Invoice
    // (dessimate_invoice_docs) - same ownership check handleListCustomerPos/
    // scopeDessimateInvoices already use for the list itself (o.customer ===
    // organization), just re-applied per file request since this proxy has
    // no path allowlist of its own otherwise. Covers both the legacy single
    // sourcePdf path and the newer multi-attachment path - both live under
    // the same "<folder>/<id>/..." prefix.
    const cpoDocsMatch = /^customer_po_docs\/([^/]+)\/.+$/.exec(decoded);
    if (cpoDocsMatch) {
      const owner = await resolveCustomerPoOwner(env, cpoDocsMatch[1]);
      return owner !== null && owner === organization;
    }
    const invDocsMatch = /^dessimate_invoice_docs\/([^/]+)\/.+$/.exec(decoded);
    if (invDocsMatch) {
      const owner = await resolveDessimateInvoiceOwner(env, invDocsMatch[1]);
      return owner !== null && owner === organization;
    }
    // A Customer can read the attachments on an SCR (scr_docs) only once
    // Dessimate has explicitly shared that record with their org - same
    // check scopeScrs itself uses for the list. A Supplier never reaches
    // this at all (scr_docs has no branch under any Supplier check above -
    // confirmed zero access to SCR, unlike every other module).
    const scrDocsMatch = /^scr_docs\/([^/]+)\/.+$/.exec(decoded);
    if (scrDocsMatch) {
      const scr = await resolveScrRecord(env, scrDocsMatch[1]);
      return !!scr && Array.isArray(scr.sharedWithCustomers) && scr.sharedWithCustomers.indexOf(organization) !== -1;
    }
    // A Customer can read the attachments/photos on their own Customer DMR
    // (customer_dmr_docs) - direct ownership via customerOrg, same check
    // scopeCustomerDmrs uses for the list itself (no opt-in share list
    // needed here, unlike SCR - the record names its Customer directly).
    const customerDmrDocsMatch = /^customer_dmr_docs\/([^/]+)\/.+$/.exec(decoded);
    if (customerDmrDocsMatch) {
      const dmr = await resolveCustomerDmrRecord(env, customerDmrDocsMatch[1]);
      return !!dmr && dmr.customerOrg === organization;
    }
    // A Customer can read the issue picture/attachments on their own
    // Customer Open Issue (customer_open_issue_docs) - same direct
    // customerOrg ownership check scopeCustomerOpenIssues uses for the
    // list itself.
    const customerOpenIssueDocsMatch = /^customer_open_issue_docs\/([^/]+)\/.+$/.exec(decoded);
    if (customerOpenIssueDocsMatch) {
      const issue = await resolveCustomerOpenIssueRecord(env, customerOpenIssueDocsMatch[1]);
      return !!issue && issue.customerOrg === organization;
    }
  }

  return false;
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

// Used by isContentsPathAllowedForExternal to gate a Customer's raw
// /contents/ access to their own Customer PO's attachments - returns the
// org name on file, or null if the PO doesn't exist (treated as "not
// allowed" by the caller).
async function resolveCustomerPoOwner(env, poId) {
  const state = await readJsonArrayFile(env, CUSTOMER_POS_FILE_PATH);
  const po = state.items.find(function (o) { return o.id === poId; });
  return po ? (po.customer || '') : null;
}

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
  // Rev2.5: up to 20 attachments (was a single "Original PO" sourcePdf file)
  // - same migration pattern as Parts' old single "drawing" field: a record
  // saved before this still has only sourcePdf, surfaced here as the sole
  // entry of "attachments" so every client only ever needs to look at one
  // field. sourcePdf itself is kept in the response for any old client still
  // reading it, but is never written to by new saves (see handleUpdateCustomerPo).
  const attachments = Array.isArray(o.attachments)
    ? sanitizeOrgDocList(o.attachments)
    : (o.sourcePdf ? sanitizeOrgDocList([o.sourcePdf]) : []);
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
    notes: o.notes || '',
    lines: lines,
    poTotal: Math.round(lines.reduce(function (sum, l) { return sum + l.extendedPrice; }, 0) * 100) / 100,
    sourcePdf: sanitizeOrgDoc(o.sourcePdf),
    attachments: attachments,
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
    notes: (body.notes || '').toString().trim(),
    lines: lines
  };
}

async function handleCreateCustomerPo(request, env, origin) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const fields = validateCustomerPoFields(body, origin);
  if (fields.error) return fields.error;

  const newPo = Object.assign({ id: cryptoRandomId(), createdAt: new Date().toISOString(), attachments: sanitizeOrgDocList(body.attachments) }, fields);

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
    if (body.attachments !== undefined) {
      target.attachments = sanitizeOrgDocList(body.attachments);
      // A record moving from the old single-sourcePdf shape to the new
      // array now has both fields; "attachments" always wins in
      // sanitizeCustomerPo, so the stale sourcePdf is just dead weight.
      // Drop it so the record doesn't carry two conflicting sources of truth.
      delete target.sourcePdf;
    }
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

// Used by isContentsPathAllowedForExternal to gate a Supplier's raw
// /contents/ access to their own Dessimate PO's attachments - same
// ownership check scopeDessimatePos already uses for the list itself
// (o.supplier === organization). Returns the org name on file, or null if
// the PO doesn't exist.
// Returns null (treated as "not allowed" by the caller) both when the PO
// doesn't exist and when it simply hasn't been released to its Supplier yet
// - same gate scopeDessimatePos applies to the list/PDF, kept in sync here
// so a Supplier can't reach an unreleased PO's attachments by path either.
async function resolveDessimatePoOwner(env, poId) {
  const state = await readJsonArrayFile(env, DESSIMATE_POS_FILE_PATH);
  const po = state.items.find(function (o) { return o.id === poId; });
  // released undefined (pre-Rev2.11 PO, raw storage) grandfathers in as
  // released - same rule sanitizeDessimatePo applies; only an explicit
  // false holds it back.
  if (!po || po.released === false) return null;
  return po.supplier || '';
}

const COUNTERS_FILE_PATH = 'data/counters.json';
const DEFAULT_COUNTERS = {
  nextDessimatePoNumber: 3013,
  nextDessimateInvoiceNumber: 3014, // reserved for the Dessimate Invoice module
  shipmentYear: 26,
  nextShipmentSeq: 10,
  nextRfqNumber: 9009, // RFQ module - client's 9000-series, latest used was 9008
  nextCrNumber: 1, // Change Request module - formatted "CR-###" (see reserveCrNumber)
  nextScrNumber: 1, // Customer SCR module - formatted "SCR-###" (see reserveScrNumber)
  nextDmrNumber: 1, // Discrepant Material Report module - formatted "DMR-####" (see reserveDmrNumber)
  nextOpenIssueNumber: 1, // Customer Open Issues List module - formatted "OI-####" (see reserveOpenIssueNumber)
  nextCustomerRfqNumber: 8000 // Customer RFQ module - its own series, separate from nextRfqNumber (see reserveCustomerRfqNumber). Was 9500 (Rev2.27); changed to 8000 (Rev2.28) - too close to the Dessimate RFQ module's own 9000-series, confusing side by side.
};

function pad2(n) { return String(n).padStart(2, '0'); }
function pad3(n) { return String(n).padStart(3, '0'); }
function pad4(n) { return String(n).padStart(4, '0'); }

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

// Dessimate PO's Attachments section - same shape as sanitizeOrgDoc, plus a
// short `comment` field (what the file is about) and `id` preserved
// through (needed intact: the "Generate PDF" button tags its own saved
// copy with a fixed id so re-generating replaces it in place instead of
// appending a duplicate - see PDIR_DessimatePOs.html's GENERATED_PDF_ID).
function sanitizeDessimatePoAttachment(d) {
  if (!d || !d.path) return null;
  return {
    id: d.id || null,
    path: d.path,
    filename: d.filename || '',
    mimeType: d.mimeType || 'application/octet-stream',
    size: typeof d.size === 'number' ? d.size : 0,
    comment: d.comment || '',
    uploadedBy: (d && d.uploadedBy) || '',
    uploadedAt: (d && d.uploadedAt) || null
  };
}
function sanitizeDessimatePoAttachments(list) {
  const arr = Array.isArray(list) ? list : [];
  return arr.map(sanitizeDessimatePoAttachment).filter(Boolean).slice(0, PART_ATTACHMENTS_MAX);
}

function sanitizeDessimatePo(o) {
  const lines = Array.isArray(o.lines) ? o.lines.map(sanitizeDessimatePoLine) : [];
  // Rev2.4: customerPoRefs (array) replaces the old single customerPoRef -
  // one Dessimate PO can now be linked to more than one Customer PO.
  const customerPoRefs = Array.isArray(o.customerPoRefs)
    ? Array.from(new Set(o.customerPoRefs.map(function (v) { return (v || '').toString().trim(); }).filter(Boolean)))
    : (o.customerPoRef ? [String(o.customerPoRef).trim()] : []);
  return {
    id: o.id,
    poNumber: o.poNumber,
    shipmentNumber: o.shipmentNumber || '',
    poDate: o.poDate || '',
    supplier: o.supplier || '',
    customerPoRef: customerPoRefs[0] || '', // kept for any old client still reading the singular field
    customerPoRefs: customerPoRefs,
    shipTo: o.shipTo || '',
    currency: o.currency || '',
    paymentTerms: o.paymentTerms || '',
    incoterms: o.incoterms || '',
    notes: o.notes || '',
    lines: lines,
    poTotal: Math.round(lines.reduce(function (sum, l) { return sum + l.extendedPrice; }, 0) * 100) / 100,
    approverUsername: o.approverUsername || '',
    approverName: o.approverName || '',
    // Rev2.11: undefined (any PO saved before this field existed) is treated
    // as already-released, so this doesn't retroactively hide every PO a
    // Supplier could already see - only a PO explicitly created/edited with
    // the checkbox left unchecked (stored as false, not undefined) is held
    // back. See scopeDessimatePos/resolveDessimatePoOwner, which apply the
    // exact same rule to raw storage reads that don't go through this
    // sanitizer.
    released: o.released !== false,
    relatedPoIds: Array.isArray(o.relatedPoIds) ? o.relatedPoIds.filter(Boolean) : [],
    attachments: sanitizeDessimatePoAttachments(o.attachments),
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
// it sees none of these. Rev2.11: a PO also stays completely invisible to
// its Supplier until explicitly released (the "release to Vendor" checkbox
// next to Approver) - before that, it's a draft Dessimate is still working
// on, not something to hand to the Supplier yet.
function scopeDessimatePos(pos, accessLevel, organization) {
  if (accessLevel === 'supplier') {
    const visible = pos.filter(function (o) { return organization && o.supplier === organization && o.released; });
    // A related PO could belong to a different Supplier that this login has
    // no visibility into at all - trimming relatedPoIds down to only what's
    // in this same visible set keeps a Supplier login from learning that
    // some other organization's PO even exists, the same way customerPoRef
    // is already stripped for this accessLevel just below.
    const visibleIds = new Set(visible.map(function (o) { return o.id; }));
    return visible.map(function (o) {
      const copy = Object.assign({}, o);
      delete copy.customerPoRef;
      delete copy.customerPoRefs;
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
  const customerPoRefs = Array.isArray(body.customerPoRefs)
    ? Array.from(new Set(body.customerPoRefs.map(function (v) { return (v || '').toString().trim(); }).filter(Boolean)))
    : [];
  return {
    poDate: (body.poDate || '').toString().trim(),
    supplier: supplier,
    customerPoRefs: customerPoRefs,
    shipTo: (body.shipTo || '').toString().trim(),
    currency: (body.currency || '').toString().trim(),
    paymentTerms: (body.paymentTerms || '').toString().trim(),
    incoterms: (body.incoterms || '').toString().trim(),
    notes: (body.notes || '').toString().trim(),
    lines: lines,
    approverUsername: (body.approverUsername || '').toString().trim(),
    approverName: (body.approverName || '').toString().trim(),
    // Rev2.11: a Dessimate PO stays invisible to the Supplier it's issued to
    // (list, PDF, and attachments alike - see scopeDessimatePos/
    // resolveDessimatePoOwner) until explicitly released, checked here next
    // to the Approver fields per the product brief ("a checkmark next to
    // approved signature to release PO to Vendor side").
    released: !!body.released,
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
    { id: cryptoRandomId(), createdAt: new Date().toISOString(), poNumber: numbers.poNumber, shipmentNumber: numbers.shipmentNumber, attachments: sanitizeDessimatePoAttachments(body.attachments) },
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
    if (body.attachments !== undefined) target.attachments = sanitizeDessimatePoAttachments(body.attachments);
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

// Rev2.5: redesigned to match the customer-supplied reference template -
// light-blue letterhead band (logo + "PURCHASE ORDER" title + PO identity
// block + Vendor/Bill To/Ship To three-up), a navy line-items table with
// zebra striping, and a footer band carrying Terms & Conditions, a Buyer
// bar, an Approver Signature box (the same stamp image the old layout drew)
// and a PO Total box - same color palette/typography as
// buildDessimateInvoicePdf/buildPackingSlipPdf so all three PDFs read as one
// family. supplierOrg is the Organization record for po.supplier (looked up
// by name/relationship in handleGenerateDessimatePoPdf) - its saved address
// fills the "Vendor" box the same way customerOrg fills the Invoice's "Ship
// To". The reference has a separate "Due Date" from "Terms" that this
// system has no field for; left blank, same precedent as the Invoice PDF's
// own blank "Due Date:" row.
async function buildDessimatePoPdf(po, selfOrg, supplierOrg, customerInfo, stampBytes) {
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
  const zebra = rgb(0.965, 0.97, 0.985);

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
  // A user-typed "\n" (e.g. Ship To's street/city-state-zip break) is always
  // honored as a forced line break; each resulting line is then word-wrapped
  // to maxWidth same as before.
  function wrapLines(str, maxWidth, size, useFont) {
    const f = useFont || font;
    const out = [];
    (str || '').split(/\r?\n/).forEach(function (raw) {
      const words = raw.split(/\s+/).filter(Boolean);
      if (!words.length) return;
      let cur = '';
      words.forEach(function (w) {
        const attempt = cur ? cur + ' ' + w : w;
        if (cur && f.widthOfTextAtSize(attempt, size) > maxWidth) { out.push(cur); cur = w; }
        else cur = attempt;
      });
      if (cur) out.push(cur);
    });
    return out;
  }
  function moneyCommas(n) {
    const parts = money2(n).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }
  // Letter-spaced caption, matching the reference title's tracked look.
  function spaced(str) { return String(str).split('').join(' '); }
  // ISO date input ("YYYY-MM-DD") -> MM/DD/YYYY for display, per the
  // reference; anything else (already-formatted, free text, blank) passes
  // through unchanged rather than risk mangling it.
  function fmtDateMDY(s) {
    const str = (s || '').toString().trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
    return m ? (m[2] + '/' + m[3] + '/' + m[1]) : str;
  }

  // Generous upper bound for the colored band - the line-items table's
  // actual start position is computed from real content height just below
  // (Math.min(y1, y2, y4)), so this only needs to stay large enough that the
  // Customer PO block (when present) never spills onto the white page below
  // the band.
  const headerHeight = 340;
  const footerHeight = 190;

  page.drawRectangle({ x: 0, y: pageHeight - headerHeight, width: pageWidth, height: headerHeight, color: bandBg });

  // ---- Logo (left) + "PURCHASE ORDER" title (right) -------------------------
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
  rightText(spaced('PURCHASE ORDER'), pageWidth - margin, hy - 16, 21, { bold: true, color: brandBlue });

  // ---- Self org name/address (left) + contact (center) + PO identity (right) ----
  let ly = logoBottom - 20;
  leftText((selfOrg && selfOrg.name) || 'Dessimate LLC', margin, ly, 10, { bold: true }); ly -= 13;
  const selfAddr0 = (selfOrg && Array.isArray(selfOrg.addresses) && selfOrg.addresses[0]) ? selfOrg.addresses[0] : null;
  [selfAddr0 && selfAddr0.line1, selfAddr0 && selfAddr0.line2].filter(Boolean).forEach(function (line) {
    leftText(line, margin, ly, 9); ly -= 12;
  });

  // Contact column shares Bill to's left edge (col2) further down, per
  // customer markup - computed early since Vendor/Bill to/Ship To below
  // reuse the same colW/col2/col3.
  const colW = (pageWidth - margin * 2) / 3;
  const col1 = margin, col2 = margin + colW, col3 = margin + colW * 2;
  const contactX = col2;
  let cy = logoBottom - 20;
  [selfOrg && selfOrg.purchasingEmail, selfOrg && selfOrg.phone, selfOrg && selfOrg.website].filter(Boolean).forEach(function (line) {
    leftText(line, contactX, cy, 9); cy -= 12;
  });

  // Purchase Order Number/Date/Terms/... starts level with the self-org
  // address and contact columns (all three "next to each other", per
  // customer feedback) rather than up near the title - so the label/value
  // gap has to stay narrow enough to clear the contact column's longest
  // real line (the purchasing email) at the same row. Payment Terms (and,
  // rarely, a long Customer PO Ref list) can still run past its narrow
  // value width - wraps onto extra lines under the label rather than
  // colliding with the row above it. Values are left-aligned (starting
  // right after the label) rather than right-flush against the page edge,
  // per customer markup - a straight left edge reads more like a normal
  // label/value form than a ragged-left, flush-right column of numbers.
  const idValueMaxWidth = 68;
  const idLabelEdge = pageWidth - margin - idValueMaxWidth - 10;
  const idValueX = idLabelEdge + 10;
  function idRow(label, value, size, bold) {
    rightText(label, idLabelEdge, ry, size, { bold: true });
    const valLines = wrapLines(String(value || ''), idValueMaxWidth, size);
    if (!valLines.length) valLines.push('');
    valLines.forEach(function (vl, i) { leftText(vl, idValueX, ry - i * (size + 2), size, { bold: !!bold }); });
    ry -= (size + 5) + Math.max(0, valLines.length - 1) * (size + 2);
  }
  let ry = logoBottom - 20;
  const poRefDisplay = (Array.isArray(po.customerPoRefs) && po.customerPoRefs.length) ? po.customerPoRefs.join(', ') : (po.customerPoRef || '');
  idRow('Purchase Order Number:', po.poNumber, 10);
  idRow('Date:', fmtDateMDY(po.poDate), 10);
  idRow('Terms:', po.paymentTerms || '', 10);
  idRow('Currency:', po.currency || '', 10);
  if (poRefDisplay) idRow('Customer PO Ref:', poRefDisplay, 9);

  // ---- Vendor / Bill to / Ship To (still inside the header band) -----------
  const addrTop = Math.min(ly, cy, ry) - 20;
  leftText('Vendor', col1, addrTop, 10, { bold: true });
  leftText('Bill to', col2, addrTop, 10, { bold: true });
  leftText('Ship To', col3, addrTop, 10, { bold: true });

  // Each address line is drawn on its own forced line (word-wrapped only if
  // that one line is itself too wide) - never merged into one comma-joined,
  // width-wrapped blob, so "street" and "city, state zip" reliably land on
  // separate lines the way they're entered (matching the self-org
  // letterhead block above, and per customer feedback for this row).
  function addrBlock(x, name, lines) {
    let yy = addrTop - 13;
    if (name) { leftText(name, x, yy, 9); yy -= 11; }
    (lines || []).forEach(function (raw) {
      wrapLines(raw, colW - 12, 9).forEach(function (line) { leftText(line, x, yy, 9); yy -= 11; });
    });
    return yy;
  }
  const supplierAddr0 = (supplierOrg && Array.isArray(supplierOrg.addresses) && supplierOrg.addresses[0]) ? supplierOrg.addresses[0] : null;
  const y1 = addrBlock(col1, po.supplier || '', supplierAddr0 ? [supplierAddr0.line1, supplierAddr0.line2].filter(Boolean) : []);
  const y2 = addrBlock(col2, (selfOrg && selfOrg.name) || 'Dessimate LLC', selfAddr0 ? [selfAddr0.line1, selfAddr0.line2].filter(Boolean) : []);
  // The "Ship To" heading stays, but per customer markup on the rendered
  // sample, its address value is dropped here - the Customer PO block right
  // below already carries the customer's address, so printing po.shipTo
  // too was a redundant duplicate of the same address.
  const y3 = addrTop - 13;

  // ---- Customer PO (under Ship To) ------------------------------------------
  // customerInfo is only passed in when this PO actually carries
  // customerPoRefs - already stripped for a Supplier login by
  // scopeDessimatePos (the ultimate customer's identity is commercially
  // sensitive from that side), so this block simply doesn't render there,
  // same protection as before with no extra check needed here.
  let y4 = y3;
  if (customerInfo) {
    if (customerInfo.name) { leftText(customerInfo.name, col3, y4, 9); y4 -= 11; }
    if (customerInfo.buyerName) { leftText('Attn: ' + customerInfo.buyerName, col3, y4, 9); y4 -= 11; }
    [customerInfo.addressLine1, customerInfo.addressLine2].filter(Boolean).forEach(function (line) {
      wrapLines(line, colW - 12, 9).forEach(function (l) { leftText(l, col3, y4, 9); y4 -= 11; });
    });
    if (customerInfo.poNumbers && customerInfo.poNumbers.length) {
      leftText('PO: ' + customerInfo.poNumbers.join(', '), col3, y4, 9, { bold: true }); y4 -= 11;
    }
  }

  // ---- Line items table -------------------------------------------------------
  let y = Math.min(y1, y2, y4) - 20;
  const cols = [
    { key: 'line', label: 'Line', x: margin, w: 24 },
    { key: 'combined', label: 'Part Number/Rev/Description', x: margin + 28, w: 196 },
    { key: 'requestedDeliveryDate', label: 'Promised Delivery Date', x: margin + 228, w: 78 },
    { key: 'qtyOrdered', label: 'Quantity', x: margin + 310, w: 44, right: true },
    { key: 'uom', label: 'UOM', x: margin + 358, w: 32 },
    { key: 'unitPrice', label: 'Unit', x: margin + 394, w: 52, right: true },
    { key: 'extendedPrice', label: 'Extended Price', x: margin + 450, w: 74, right: true }
  ];
  const tableRight = margin + 524;

  function ensureSpace(h) {
    if (y - h < footerHeight + 20) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      y = pageHeight - 40;
    }
  }

  const headerRowH = 28;
  page.drawRectangle({ x: margin, y: y - headerRowH + 6, width: tableRight - margin, height: headerRowH, color: navyDark });
  cols.forEach(function (c) {
    const headerLines = wrapLines(c.label, c.w, 7, fontBold);
    let hyy = y - 6;
    headerLines.forEach(function (hl) {
      const lx = c.right ? c.x + c.w - fontBold.widthOfTextAtSize(hl, 7) : c.x;
      page.drawText(hl, { x: lx, y: hyy, size: 7, font: fontBold, color: rgb(1, 1, 1) });
      hyy -= 8;
    });
  });
  y -= headerRowH + 6;

  po.lines.forEach(function (l, idx) {
    const descLines = l.description ? wrapLines(l.description, cols[1].w, 8) : [];
    const rowH = 12 + descLines.length * 10 + 6;
    ensureSpace(rowH);
    if (idx % 2 === 0) page.drawRectangle({ x: margin, y: y - rowH + 6, width: tableRight - margin, height: rowH, color: zebra });
    cols.forEach(function (c) {
      let s;
      if (c.key === 'line') s = String(idx + 1);
      else if (c.key === 'combined') s = [l.partNumber, l.revision ? 'Rev ' + l.revision : ''].filter(Boolean).join(' — ');
      else if (c.key === 'unitPrice' || c.key === 'extendedPrice') s = '$' + moneyCommas(l[c.key]);
      else if (c.key === 'requestedDeliveryDate') s = fmtDateMDY(l.requestedDeliveryDate) || '—';
      else s = l[c.key] == null || l[c.key] === '' ? '' : String(l[c.key]);
      const vx = c.right ? c.x + c.w - font.widthOfTextAtSize(s, 8.5) : c.x;
      page.drawText(s, { x: vx, y: y, size: 8.5, font: font, color: ink });
    });
    y -= 12;
    descLines.forEach(function (dl) {
      page.drawText(dl, { x: cols[1].x, y: y, size: 8, font: font, color: labelGray });
      y -= 10;
    });
    y -= 6;
  });
  page.drawLine({ start: { x: margin, y: y + 2 }, end: { x: tableRight, y: y + 2 }, thickness: 0.75, color: lineGray });

  // ---- Footer band: Terms & Conditions + Buyer/Approver + PO Total ---------
  if (y < footerHeight + 30) {
    page = pdfDoc.addPage([pageWidth, pageHeight]);
    y = pageHeight - 40;
  }
  page.drawRectangle({ x: 0, y: 0, width: pageWidth, height: footerHeight, color: bandBg });

  const leftColW = 300;
  let fy = footerHeight - 34;
  leftText('Terms & Conditions of Purchase', margin, fy, 15, { color: rgb(0.5, 0.58, 0.74) });
  fy -= 20;
  const tcText = 'Refer to https://dessimate.com/po-terms-and-conditions for all Terms and Conditions.' +
    (po.paymentTerms ? ' Payment terms ' + po.paymentTerms + '.' : '');
  wrapLines(tcText, leftColW, 9).forEach(function (line) { leftText(line, margin, fy, 9); fy -= 12; });

  fy -= 10;
  const buyerBarH = 20;
  page.drawRectangle({ x: margin, y: fy - buyerBarH, width: leftColW, height: buyerBarH, color: navyDark });
  leftText('Buyer', margin + 8, fy - 14, 9, { bold: true, color: rgb(1, 1, 1) });
  leftText((po.approverName || po.approverUsername || '—'), margin + 90, fy - 14, 9, { color: rgb(1, 1, 1) });
  fy -= buyerBarH + 8;

  const sigBoxH = 60;
  page.drawRectangle({ x: margin, y: fy - sigBoxH, width: leftColW, height: sigBoxH, color: rgb(1, 1, 1), borderColor: lineGray, borderWidth: 0.75 });
  // ---- Approver stamp (PO only - never the Dessimate Invoice) ---------------
  // "Approver Signature" (drawn below, after the stamp) is vertically
  // centered on the stamp image itself, not the box - falls back to the
  // box's own center when there's no stamp to align to.
  let stampCenterY = fy - sigBoxH / 2;
  if (stampBytes) {
    try {
      let img;
      try { img = await pdfDoc.embedPng(stampBytes); } catch (e) { img = await pdfDoc.embedJpg(stampBytes); }
      const dims = img.scaleToFit(120, 42);
      const stampY = fy - sigBoxH + 8;
      page.drawImage(img, { x: margin + 80, y: stampY, width: dims.width, height: dims.height });
      stampCenterY = stampY + dims.height / 2;
    } catch (e) { /* stamp image unreadable/unsupported format - leave the PO unstamped rather than fail generation */ }
  }
  leftText('Approver', margin + 8, stampCenterY + 6, 9, { bold: true, color: labelGray });
  leftText('Signature', margin + 8, stampCenterY - 5, 9, { bold: true, color: labelGray });

  const totalBoxX = margin + leftColW + 30;
  const totalBoxW = tableRight - totalBoxX;
  const totalBoxY = footerHeight - 110;
  const totalBoxH = 46;
  page.drawRectangle({ x: totalBoxX, y: totalBoxY, width: totalBoxW, height: totalBoxH, color: rgb(1, 1, 1), borderColor: lineGray, borderWidth: 0.75 });
  leftText('PO Total', totalBoxX + 14, totalBoxY + totalBoxH / 2 - 5, 12, { bold: true, color: brandBlue });
  rightText((po.currency || '') + ' $' + moneyCommas(po.poTotal), totalBoxX + totalBoxW - 14, totalBoxY + totalBoxH / 2 - 5, 14, { bold: true, color: brandBlue });

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
  const allOrgs = orgState.items.map(sanitizeOrg);
  const selfOrg = allOrgs.find(function (o) { return o.relationship === 'Self'; }) || null;
  const supplierOrg = allOrgs.find(function (o) { return o.relationship === 'Supplier' && o.name === clean.supplier; }) || null;

  // "Customer PO" block under Ship To - the customer company, a buyer
  // contact, their saved address, and the referenced Customer PO number(s).
  // clean.customerPoRefs is already stripped for a Supplier login by
  // scopeDessimatePos above, so customerInfo simply stays null for that
  // role and the block doesn't render - no separate access check needed
  // here.
  let customerInfo = null;
  if (Array.isArray(clean.customerPoRefs) && clean.customerPoRefs.length) {
    const cpoState = await readJsonArrayFile(env, CUSTOMER_POS_FILE_PATH);
    const cpos = cpoState.items.map(sanitizeCustomerPo);
    const refsLower = clean.customerPoRefs.map(function (r) { return String(r).toLowerCase(); });
    const primary = cpos.find(function (c) { return refsLower.indexOf(String(c.poNumber).toLowerCase()) !== -1; }) || null;
    if (primary) {
      const customerOrg = allOrgs.find(function (o) { return o.relationship === 'Customer' && o.name === primary.customer; }) || null;
      const customerAddr0 = (customerOrg && Array.isArray(customerOrg.addresses) && customerOrg.addresses[0]) ? customerOrg.addresses[0] : null;
      customerInfo = {
        name: primary.customer || '',
        buyerName: primary.buyerName || '',
        addressLine1: customerAddr0 ? customerAddr0.line1 : '',
        addressLine2: customerAddr0 ? customerAddr0.line2 : '',
        poNumbers: clean.customerPoRefs
      };
    }
  }

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
    pdfBytes = await buildDessimatePoPdf(clean, selfOrg, supplierOrg, customerInfo, stampBytes);
  } catch (e) {
    return json({ message: 'Could not generate PDF: ' + (e && e.message ? e.message : e) }, 500, origin);
  }
  return pdfResponse(pdfBytes, 'Dessimate PO ' + clean.poNumber + '.pdf', origin);
}

// ---- RFQ (Request for Quote) - Dessimate team members create a numbered
// RFQ package (9000-series, own counter - see DEFAULT_COUNTERS), attach
// drawings/3D files, and choose which Supplier organizations to share it
// with. A shared Supplier sees the RFQ in their own login, downloads the
// standard quote-format file, and submits back a price + tooling cost per
// line plus their own attachments - through the separate, narrowly-scoped
// PUT /rfqs/<id>/quote endpoint (never the generic record PUT), so a
// Supplier write can never touch anything Dessimate authored. Record writes
// (create/edit/delete) are Team Member+ (same gate as APQP, per the product
// brief's "Dessimate team member decide which supplier to share..."), while
// the shared quote-format template upload is Admin+ only (a system-wide
// file, higher blast radius than one record). RFQ Number is voluntary/
// optional and, unlike the Dessimate PO's PO Number, stays editable
// indefinitely after creation (same pattern as the Dessimate Invoice
// Number). Delete is a hard delete, same precedent as Dessimate PO (a
// running numbered record, not soft-deleted like Dessimate Invoice, which
// is soft-deleted specifically so its number sequence stays gap-free for
// billing audit - a rationale that doesn't apply here).
const RFQS_FILE_PATH = 'data/rfqs.json';
const RFQ_DOC_FOLDER = 'rfq_docs';                 // Dessimate-side attachments (drawings/3D files), via the generic /contents/ proxy
const RFQ_QUOTE_DOC_FOLDER = 'rfq_quote_docs';     // Supplier-side attachments, written directly by handleSubmitRfqQuote (never through the generic proxy)
const RFQ_QUOTE_TEMPLATE_PATH = 'rfq_quote_template/Dessimate_Quote_Format.xlsx'; // one shared file, Admin+ uploads/replaces via the existing generic /contents/ PUT

function slugifyOrgName(name) {
  return (name || '').toString().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'org';
}

// Same voluntary/custom-number pattern as reserveDessimateInvoiceNumber -
// leave blank for the next 9000-series number, or supply your own (already
// checked for uniqueness by the caller); a numeric custom value bumps the
// counter past itself so the system never later hands out a colliding one.
async function reserveRfqNumber(env, clientRfqNumber) {
  const result = await mutateJsonObjectFile(env, COUNTERS_FILE_PATH, DEFAULT_COUNTERS, function (obj) {
    let rfqNumber;
    if (clientRfqNumber) {
      rfqNumber = /^\d+$/.test(clientRfqNumber) ? Number(clientRfqNumber) : clientRfqNumber;
      if (typeof rfqNumber === 'number' && rfqNumber >= obj.nextRfqNumber) obj.nextRfqNumber = rfqNumber + 1;
    } else {
      rfqNumber = obj.nextRfqNumber;
      obj.nextRfqNumber = rfqNumber + 1;
    }
    return { obj: obj, meta: { rfqNumber: rfqNumber } };
  });
  if (!result.ok) throw new Error(result.message);
  return result.meta.rfqNumber;
}

// Non-mutating preview for the Add-RFQ modal's "Use System Number" button.
async function handlePeekRfqNumber(env, origin) {
  const state = await readJsonObjectFile(env, COUNTERS_FILE_PATH, DEFAULT_COUNTERS);
  return json({ rfqNumber: state.obj.nextRfqNumber }, 200, origin);
}

async function rfqNumberTaken(env, rfqNumber, excludeId) {
  const state = await readJsonArrayFile(env, RFQS_FILE_PATH);
  const target = String(rfqNumber).toLowerCase();
  return state.items.some(function (o) { return o.id !== excludeId && String(o.rfqNumber).toLowerCase() === target; });
}

// lineId is the stable join key between an RFQ's own lines and a supplier's
// quoted lines (matched in handleSubmitRfqQuote) - deliberately NOT the same
// as lineNo (the 1-based display position, recomputed by index on every
// read in sanitizeRfq). If Dessimate removes/reorders a line after a
// Supplier already quoted it, the quote stays attached to the right part
// instead of silently shifting onto whatever now occupies that position.
// lineId is assigned once, in validateRfqFields, the first time a line is
// saved without one - sanitizeRfq (the read path) never invents one, so a
// GET can't hand back a different id than what was actually persisted.
function sanitizeRfqLine(l) {
  return {
    lineId: (l && l.lineId) || '',
    lineNo: 0, // overwritten by index in sanitizeRfq
    partNumber: (l && l.partNumber) || '',
    partName: (l && l.partName) || '',
    // Rev2.13: Estimated Annual Volume - a Dessimate-set spec on the part
    // itself (like partNumber/partName), not something a Supplier submits
    // per-quote, so it lives here rather than on sanitizeRfqSupplierQuoteLine.
    // Kept as a free-text string (not Number) since Suppliers often expect
    // something like "5,000" or "10k/yr", not a strict numeric field.
    eau: (l && l.eau) || '',
    // Rev2.11: per-part attachments (drawings/3D/etc., separate from the
    // RFQ-level dessimateAttachments) - stored under
    // rfq_docs/<rfqId>/parts/<lineId>/..., already covered by the existing
    // rfq_docs/<rfqId>/.+ allowlist branch in
    // isContentsPathAllowedForExternal, no backend access-control change
    // needed for Supplier/Customer viewers to reach these.
    attachments: sanitizeOrgDocList(l && l.attachments)
  };
}
function sanitizeRfqSupplierQuoteLine(l) {
  return {
    lineId: (l && l.lineId) ? String(l.lineId) : '',
    price: Number(l && l.price) || 0,
    toolingCost: Number(l && l.toolingCost) || 0
  };
}
function sanitizeRfqSupplierQuote(q) {
  return {
    lines: Array.isArray(q && q.lines) ? q.lines.map(sanitizeRfqSupplierQuoteLine).filter(function (l) { return l.lineId; }) : [],
    attachments: sanitizeOrgDocList(q && q.attachments),
    submittedAt: (q && q.submittedAt) || null,
    submittedBy: (q && q.submittedBy) || ''
  };
}
// Notes/Comments thread (Rev2.29) - same shape/semantics as
// sanitizeOpenIssueComment: entries are appended by handleAddRfqComment and
// may later be edited (text only) by handleEditRfqComment, never by the
// generic PUT (see validateRfqFields, which no longer reads a `notes`
// field at all) - so nobody can silently rewrite the whole thread by
// resending a modified array. editedAt is set only once a comment has
// actually been edited, so the UI can show a "(edited)" marker.
function sanitizeRfqComment(c) {
  if (!c) return null;
  return {
    id: c.id || cryptoRandomId(),
    authorUsername: c.authorUsername || '',
    text: c.text || '',
    createdAt: c.createdAt || null,
    editedAt: c.editedAt || null
  };
}
function sanitizeRfqComments(list) {
  const arr = Array.isArray(list) ? list : [];
  return arr.map(sanitizeRfqComment).filter(Boolean);
}
function sanitizeRfq(o) {
  const lines = (Array.isArray(o.lines) ? o.lines : []).map(sanitizeRfqLine).map(function (l, idx) {
    l.lineNo = idx + 1;
    return l;
  });
  const sharedWithSuppliers = Array.isArray(o.sharedWithSuppliers)
    ? Array.from(new Set(o.sharedWithSuppliers.map(function (v) { return (v || '').toString().trim(); }).filter(Boolean)))
    : [];
  const supplierQuotesIn = (o.supplierQuotes && typeof o.supplierQuotes === 'object' && !Array.isArray(o.supplierQuotes)) ? o.supplierQuotes : {};
  const supplierQuotes = {};
  Object.keys(supplierQuotesIn).forEach(function (org) { supplierQuotes[org] = sanitizeRfqSupplierQuote(supplierQuotesIn[org]); });
  return {
    id: o.id,
    rfqNumber: o.rfqNumber,
    rfqDate: o.rfqDate || '',
    // Rev2.29: the old single free-text `notes` field is frozen/read-only
    // now (validateRfqFields no longer accepts it) - superseded by the
    // `comments` thread below, which both Dessimate staff and a Supplier
    // can post to, each entry stamped with who/when. Kept here only so
    // whatever was already written before this change isn't lost; the
    // frontend renders it as an unattributed legacy entry pinned above the
    // real thread.
    notes: o.notes || '',
    lines: lines,
    dessimateAttachments: sanitizeOrgDocList(o.dessimateAttachments),
    sharedWithSuppliers: sharedWithSuppliers,
    supplierQuotes: supplierQuotes,
    comments: sanitizeRfqComments(o.comments),
    createdAt: o.createdAt || null
  };
}

// A Supplier login sees only RFQs it's actually been shared with
// (sharedWithSuppliers, not an ownership field like Dessimate PO's
// `supplier`), and within a visible record, only its own submitted quote -
// another Supplier's price/tooling cost on the same RFQ is exactly the kind
// of competitively sensitive detail this system already keeps siloed
// elsewhere (e.g. a Supplier never sees a Dessimate PO's Customer PO ref).
// sharedWithSuppliers itself is also trimmed to just the caller's own org -
// no business seeing who else was invited to bid.
// Rev2.27: a Customer login has no role in this module at all any more -
// the Customer-facing half (sharedWithCustomers/dessimateQuote) moved to
// its own Customer RFQ module/store (see scopeCustomerRfqs below). This
// module's data never had a Supplier-facing field to hide from a Customer
// to begin with, so there's nothing left to scope for that role but an
// empty list.
function scopeRfqs(rfqs, accessLevel, organization) {
  if (accessLevel === 'customer') return [];
  if (accessLevel === 'supplier') {
    const visible = rfqs.filter(function (o) { return organization && o.sharedWithSuppliers.indexOf(organization) !== -1; });
    return visible.map(function (o) {
      const copy = Object.assign({}, o);
      copy.sharedWithSuppliers = [organization];
      copy.supplierQuotes = (o.supplierQuotes && o.supplierQuotes[organization]) ? { [organization]: o.supplierQuotes[organization] } : {};
      return copy;
    });
  }
  return rfqs;
}

async function handleListRfqs(env, origin, accessLevel, organization) {
  const state = await readJsonArrayFile(env, RFQS_FILE_PATH);
  const rfqs = scopeRfqs(state.items.map(sanitizeRfq), accessLevel, organization);
  return json({ rfqs: rfqs }, 200, origin);
}

// Nothing is required to save an RFQ - "there are no part numbers when RFQ
// number is created" (product brief). A line is kept if either of its two
// fields has content (not just Part Number), so a user filling the form out
// gradually never loses a half-typed row on save.
function validateRfqFields(body) {
  const linesIn = Array.isArray(body.lines) ? body.lines : [];
  const lines = linesIn
    .map(function (l) {
      return {
        lineId: (l && l.lineId ? String(l.lineId).trim() : '') || cryptoRandomId(),
        partNumber: ((l && l.partNumber) || '').toString().trim(),
        partName: ((l && l.partName) || '').toString().trim(),
        eau: ((l && l.eau) || '').toString().trim(),
        attachments: sanitizeOrgDocList(l && l.attachments)
      };
    })
    .filter(function (l) { return l.partNumber || l.partName; });
  const sharedWithSuppliers = Array.isArray(body.sharedWithSuppliers)
    ? Array.from(new Set(body.sharedWithSuppliers.map(function (v) { return (v || '').toString().trim(); }).filter(Boolean)))
    : [];
  return {
    rfqDate: (body.rfqDate || '').toString().trim(),
    lines: lines,
    sharedWithSuppliers: sharedWithSuppliers
  };
}

async function handleCreateRfq(request, env, origin) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const fields = validateRfqFields(body);

  const clientRfqNumber = (body.rfqNumber !== undefined && body.rfqNumber !== null) ? String(body.rfqNumber).trim() : '';
  if (clientRfqNumber && await rfqNumberTaken(env, clientRfqNumber, null)) {
    return json({ message: 'That RFQ Number is already in use.' }, 409, origin);
  }
  const rfqNumber = await reserveRfqNumber(env, clientRfqNumber);
  const newRfq = Object.assign(
    { id: cryptoRandomId(), createdAt: new Date().toISOString(), rfqNumber: rfqNumber, dessimateAttachments: sanitizeOrgDocList(body.dessimateAttachments), supplierQuotes: {} },
    fields
  );

  const result = await mutateJsonArrayFile(env, RFQS_FILE_PATH, function (items) {
    items.push(newRfq);
    return { items: items };
  });
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeRfq(newRfq), 201, origin);
}

async function handleUpdateRfq(request, env, origin, id) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const fields = validateRfqFields(body);

  // RFQ Number can be changed at any time ("allow them to change it once
  // they pull a RFQ number" - product brief) - same pattern as the
  // Dessimate Invoice Number: kept out of validateRfqFields since it needs
  // its own uniqueness check excluding this record, and the counter is
  // bumped in a separate mutation only after the record write succeeds.
  let newRfqNumber; // undefined = leave as-is
  if (body.rfqNumber !== undefined) {
    const requested = (body.rfqNumber === null ? '' : String(body.rfqNumber)).trim();
    if (!requested) return json({ message: 'RFQ Number is required.' }, 400, origin);
    if (await rfqNumberTaken(env, requested, id)) {
      return json({ message: 'That RFQ Number is already in use.' }, 409, origin);
    }
    newRfqNumber = /^\d+$/.test(requested) ? Number(requested) : requested;
  }

  let saved = null;
  const result = await mutateJsonArrayFile(env, RFQS_FILE_PATH, function (items) {
    const target = items.find(function (o) { return o.id === id; });
    if (!target) return null;
    Object.assign(target, fields); // supplierQuotes is never in `fields` - a team_member's edit never touches it
    if (newRfqNumber !== undefined) target.rfqNumber = newRfqNumber;
    if (body.dessimateAttachments !== undefined) target.dessimateAttachments = sanitizeOrgDocList(body.dessimateAttachments);
    saved = target;
    return { items: items };
  }, { requireFound: true });

  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  if (typeof newRfqNumber === 'number') {
    await mutateJsonObjectFile(env, COUNTERS_FILE_PATH, DEFAULT_COUNTERS, function (obj) {
      if (newRfqNumber >= obj.nextRfqNumber) obj.nextRfqNumber = newRfqNumber + 1;
      return { obj: obj };
    });
  }
  return json(sanitizeRfq(saved), 200, origin);
}

// Hard delete (array splice only) - see the module comment above for why
// this matches Dessimate PO's precedent rather than Dessimate Invoice's
// soft delete. dessimateAttachments and any supplierQuotes attachments are
// left orphaned in R2, same as every other module's delete in this codebase
// (Organizations/Parts/Dessimate PO documents are never cascade-deleted).
async function handleDeleteRfq(env, origin, id) {
  const result = await mutateJsonArrayFile(env, RFQS_FILE_PATH, function (items) {
    const idx = items.findIndex(function (o) { return o.id === id; });
    if (idx === -1) return null;
    items.splice(idx, 1);
    return { items: items };
  }, { requireFound: true });
  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json({ ok: true }, 200, origin);
}

// Used by isContentsPathAllowedForExternal to gate a Supplier's raw
// /contents/ file access to an RFQ's attachments - returns the sanitized
// record (guaranteeing sharedWithSuppliers is always a well-formed array,
// never missing) or null if the RFQ doesn't exist (treated as "not allowed"
// by the caller).
async function resolveRfqRecord(env, rfqId) {
  const state = await readJsonArrayFile(env, RFQS_FILE_PATH);
  const rfq = state.items.find(function (o) { return o.id === rfqId; });
  return rfq ? sanitizeRfq(rfq) : null;
}

// A Supplier's own quote submission - deliberately a separate endpoint from
// handleUpdateRfq so a Supplier write can only ever touch its own
// supplierQuotes[organization] entry, never lines/dessimateAttachments/
// sharedWithSuppliers/rfqNumber. Body: { lines: [{lineId, price,
// toolingCost}], newAttachments: [{filename, mimeType, contentBase64}],
// removeAttachmentIds: [id, ...] }. New attachment bytes are written
// directly to R2 here (env.FILES.put, the same primitive proxyContents
// itself uses) rather than through the generic /contents/ proxy, so that
// proxy's supplier/customer restriction to GET-only never has to be
// loosened.
async function handleSubmitRfqQuote(request, env, origin, id, organization, username) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }

  const state = await readJsonArrayFile(env, RFQS_FILE_PATH);
  const rfq = state.items.find(function (o) { return o.id === id; });
  if (!rfq) return json({ message: 'Not found.' }, 404, origin);
  const sharedWith = Array.isArray(rfq.sharedWithSuppliers) ? rfq.sharedWithSuppliers : [];
  if (!organization || sharedWith.indexOf(organization) === -1) {
    return json({ message: 'This RFQ hasn’t been shared with your organization.' }, 403, origin);
  }

  // Drop any submitted line whose lineId doesn't match a real current line
  // on this RFQ - defends against a stale client submitting against a line
  // that's since been removed.
  const validLineIds = new Set((Array.isArray(rfq.lines) ? rfq.lines : []).map(function (l) { return l.lineId; }));
  const linesIn = Array.isArray(body.lines) ? body.lines : [];
  const lines = linesIn
    .filter(function (l) { return l && validLineIds.has(l.lineId); })
    .map(function (l) { return { lineId: String(l.lineId), price: Number(l.price) || 0, toolingCost: Number(l.toolingCost) || 0 }; });

  const existingAttachments = (rfq.supplierQuotes && rfq.supplierQuotes[organization] && Array.isArray(rfq.supplierQuotes[organization].attachments))
    ? rfq.supplierQuotes[organization].attachments
    : [];
  const removeIds = Array.isArray(body.removeAttachmentIds) ? body.removeAttachmentIds.map(String) : [];
  let attachments = existingAttachments.filter(function (a) { return removeIds.indexOf(a.id) === -1; });

  const newAttachmentsIn = Array.isArray(body.newAttachments) ? body.newAttachments : [];
  for (let i = 0; i < newAttachmentsIn.length; i++) {
    const a = newAttachmentsIn[i];
    if (!a || !a.filename || !a.contentBase64) continue;
    let bytes;
    try { bytes = base64ToBytes(a.contentBase64); } catch (e) { continue; }
    const safeFilename = String(a.filename).replace(/[^A-Za-z0-9._-]/g, '_');
    const path = RFQ_QUOTE_DOC_FOLDER + '/' + id + '/' + slugifyOrgName(organization) + '/' + Date.now() + '-' + i + '-' + safeFilename;
    await env.FILES.put(path, bytes);
    // Stamped server-side (not trusting a client-sent uploadedBy) since this
    // handler already knows the authenticated username for certain - unlike
    // every other attachment flow in this app, which builds its doc pointer
    // entirely client-side and is stamped there instead (see ghPutFile call
    // sites across the other pages).
    attachments.push({ id: cryptoRandomId(), path: path, filename: a.filename, mimeType: a.mimeType || 'application/octet-stream', size: bytes.length, uploadedBy: username || '', uploadedAt: new Date().toISOString() });
  }
  attachments = attachments.slice(0, PART_ATTACHMENTS_MAX);

  const quote = { lines: lines, attachments: attachments, submittedAt: new Date().toISOString(), submittedBy: username || '' };

  const result = await mutateJsonArrayFile(env, RFQS_FILE_PATH, function (items) {
    const target = items.find(function (o) { return o.id === id; });
    if (!target) return null;
    if (!target.supplierQuotes || typeof target.supplierQuotes !== 'object') target.supplierQuotes = {};
    target.supplierQuotes[organization] = quote;
    return { items: items };
  }, { requireFound: true });
  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeRfqSupplierQuote(quote), 200, origin);
}

// Notes/Comments thread (Rev2.29) - appends a new entry (editing an
// existing one is handleEditRfqComment below; there is still no delete
// route), same pattern as Customer Open Issues' comment thread. Team
// Member+ can comment on any RFQ; a Supplier can comment only on one
// shared with their own organization. Returns the full updated record (the
// frontend reads `.comments` off it).
async function handleAddRfqComment(request, env, origin, id, accessLevel, username) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const text = (body.text || '').toString().trim();
  if (!text) return json({ message: 'Comment text is required.' }, 400, origin);

  const isSupplier = accessLevel === 'supplier';
  let callerOrg = '';
  if (isSupplier) {
    callerOrg = await resolveUserOrganization(env, username);
    if (!callerOrg) return json({ message: 'Your account isn’t linked to a Supplier organization.' }, 403, origin);
  }

  const comment = { id: cryptoRandomId(), authorUsername: username || '', text: text, createdAt: new Date().toISOString() };

  let saved = null;
  const result = await mutateJsonArrayFile(env, RFQS_FILE_PATH, function (items) {
    const target = items.find(function (o) { return o.id === id; });
    if (!target) return null;
    if (isSupplier && (!Array.isArray(target.sharedWithSuppliers) || target.sharedWithSuppliers.indexOf(callerOrg) === -1)) return null;
    target.comments = Array.isArray(target.comments) ? target.comments : [];
    target.comments.push(comment);
    saved = target;
    return { items: items };
  }, { requireFound: true });

  if (result === 'not-found' || !saved) return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeRfq(saved), 200, origin);
}

// Edits one existing comment's text in place. Team Member+ can edit any
// comment on any RFQ; a Supplier can edit only their OWN comment (matched
// by authorUsername), and only on an RFQ shared with their own
// organization - never someone else's note, even on an RFQ they can see.
// Stamps editedAt so the UI can show a "(edited)" marker; there is still no
// delete route.
async function handleEditRfqComment(request, env, origin, id, commentId, accessLevel, username) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const text = (body.text || '').toString().trim();
  if (!text) return json({ message: 'Comment text is required.' }, 400, origin);

  const isStaff = accessLevel === 'team_member' || accessLevel === 'admin' || accessLevel === 'super_admin';
  const isSupplier = accessLevel === 'supplier';
  let callerOrg = '';
  if (isSupplier) {
    callerOrg = await resolveUserOrganization(env, username);
    if (!callerOrg) return json({ message: 'Your account isn’t linked to a Supplier organization.' }, 403, origin);
  }

  let saved = null;
  let forbidden = false;
  const result = await mutateJsonArrayFile(env, RFQS_FILE_PATH, function (items) {
    const target = items.find(function (o) { return o.id === id; });
    if (!target) return null;
    if (isSupplier && (!Array.isArray(target.sharedWithSuppliers) || target.sharedWithSuppliers.indexOf(callerOrg) === -1)) return null;
    const comments = Array.isArray(target.comments) ? target.comments : [];
    const comment = comments.find(function (c) { return c.id === commentId; });
    if (!comment) return null;
    if (!isStaff && comment.authorUsername !== username) { forbidden = true; return null; }
    comment.text = text;
    comment.editedAt = new Date().toISOString();
    target.comments = comments;
    saved = target;
    return { items: items };
  }, { requireFound: true });

  if (forbidden) return json({ message: 'You can only edit your own comments.' }, 403, origin);
  if (result === 'not-found' || !saved) return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeRfq(saved), 200, origin);
}

// ---- Customer RFQ (Rev2.27) - split out of the RFQ module above. The
// original RFQ record bundled two directions into one: Dessimate sourcing
// quotes FROM Suppliers (sharedWithSuppliers/supplierQuotes) and Dessimate
// quoting BACK TO a Customer (sharedWithCustomers/dessimateQuote). This
// module is the Customer-facing half only, now a fully separate record
// type/data store/number series - there is no Supplier role here at all,
// so there's nothing to strip per-request the way scopeRfqs above has to;
// the shape itself just never has a Supplier-facing field to begin with.
// Existing RFQs were one-time cloned in here (see
// handleCloneRfqsToCustomerRfqs) when this module was introduced; after
// that clone the two stores are completely independent - editing one
// never touches the other.
const CUSTOMER_RFQS_FILE_PATH = 'data/customer_rfqs.json';
const CUSTOMER_RFQ_DOC_FOLDER = 'customer_rfq_docs';

// Same voluntary/custom-number pattern as reserveRfqNumber, its own
// separate 8000-series counter.
async function reserveCustomerRfqNumber(env, clientRfqNumber) {
  const result = await mutateJsonObjectFile(env, COUNTERS_FILE_PATH, DEFAULT_COUNTERS, function (obj) {
    let rfqNumber;
    if (clientRfqNumber) {
      rfqNumber = /^\d+$/.test(clientRfqNumber) ? Number(clientRfqNumber) : clientRfqNumber;
      if (typeof rfqNumber === 'number' && rfqNumber >= obj.nextCustomerRfqNumber) obj.nextCustomerRfqNumber = rfqNumber + 1;
    } else {
      rfqNumber = obj.nextCustomerRfqNumber;
      obj.nextCustomerRfqNumber = rfqNumber + 1;
    }
    return { obj: obj, meta: { rfqNumber: rfqNumber } };
  });
  if (!result.ok) throw new Error(result.message);
  return result.meta.rfqNumber;
}
async function handlePeekCustomerRfqNumber(env, origin) {
  const state = await readJsonObjectFile(env, COUNTERS_FILE_PATH, DEFAULT_COUNTERS);
  return json({ rfqNumber: state.obj.nextCustomerRfqNumber }, 200, origin);
}
async function customerRfqNumberTaken(env, rfqNumber, excludeId) {
  const state = await readJsonArrayFile(env, CUSTOMER_RFQS_FILE_PATH);
  const target = String(rfqNumber).toLowerCase();
  return state.items.some(function (o) { return o.id !== excludeId && String(o.rfqNumber).toLowerCase() === target; });
}

// Same lineId-as-stable-join-key reasoning as sanitizeRfqLine - the
// Dessimate Quote's own lines reference lineId, not display position.
function sanitizeCustomerRfqLine(l) {
  return {
    lineId: (l && l.lineId) || '',
    lineNo: 0, // overwritten by index in sanitizeCustomerRfq
    partNumber: (l && l.partNumber) || '',
    partName: (l && l.partName) || '',
    eau: (l && l.eau) || '',
    attachments: sanitizeOrgDocList(l && l.attachments)
  };
}
function sanitizeCustomerRfqQuoteLine(l) {
  return {
    lineId: (l && l.lineId) ? String(l.lineId) : '',
    price: Number(l && l.price) || 0,
    toolingCost: Number(l && l.toolingCost) || 0
  };
}
// The Dessimate Quote back to the Customer - same shape/semantics as
// sanitizeRfqDessimateQuote (submitted is the one-way-until-re-submitted
// gate scopeCustomerRfqs checks).
function sanitizeCustomerRfqQuote(q) {
  if (!q || typeof q !== 'object') return { lines: [], attachments: [], notes: '', submitted: false, submittedAt: null, submittedBy: '' };
  return {
    lines: Array.isArray(q.lines) ? q.lines.map(sanitizeCustomerRfqQuoteLine).filter(function (l) { return l.lineId; }) : [],
    attachments: sanitizeOrgDocList(q.attachments),
    notes: q.notes || '',
    submitted: !!q.submitted,
    submittedAt: q.submittedAt || null,
    submittedBy: q.submittedBy || ''
  };
}
function sanitizeCustomerRfq(o) {
  const lines = (Array.isArray(o.lines) ? o.lines : []).map(sanitizeCustomerRfqLine).map(function (l, idx) {
    l.lineNo = idx + 1;
    return l;
  });
  const sharedWithCustomers = Array.isArray(o.sharedWithCustomers)
    ? Array.from(new Set(o.sharedWithCustomers.map(function (v) { return (v || '').toString().trim(); }).filter(Boolean)))
    : [];
  return {
    id: o.id,
    rfqNumber: o.rfqNumber,
    rfqDate: o.rfqDate || '',
    notes: o.notes || '',
    lines: lines,
    dessimateAttachments: sanitizeOrgDocList(o.dessimateAttachments),
    sharedWithCustomers: sharedWithCustomers,
    dessimateQuote: sanitizeCustomerRfqQuote(o.dessimateQuote),
    createdAt: o.createdAt || null
  };
}

// A Customer login sees only RFQs it's actually been shared with, never
// the RFQ's own internal `notes` (staff-only), and only `dessimateQuote`
// once it's actually been submitted - before that a "no quote yet" shape,
// same structure either way so the frontend doesn't need a separate
// branch. A Supplier login has no role in this module at all.
function scopeCustomerRfqs(rfqs, accessLevel, organization) {
  if (accessLevel === 'customer') {
    const visible = rfqs.filter(function (o) { return organization && o.sharedWithCustomers.indexOf(organization) !== -1; });
    return visible.map(function (o) {
      const copy = Object.assign({}, o);
      copy.sharedWithCustomers = [organization];
      copy.notes = '';
      copy.dessimateQuote = (o.dessimateQuote && o.dessimateQuote.submitted)
        ? o.dessimateQuote
        : { lines: [], attachments: [], notes: '', submitted: false, submittedAt: null, submittedBy: '' };
      return copy;
    });
  }
  if (accessLevel === 'supplier') return [];
  return rfqs;
}

async function handleListCustomerRfqs(env, origin, accessLevel, organization) {
  const state = await readJsonArrayFile(env, CUSTOMER_RFQS_FILE_PATH);
  const rfqs = scopeCustomerRfqs(state.items.map(sanitizeCustomerRfq), accessLevel, organization);
  return json({ customerRfqs: rfqs }, 200, origin);
}

function validateCustomerRfqFields(body) {
  const linesIn = Array.isArray(body.lines) ? body.lines : [];
  const lines = linesIn
    .map(function (l) {
      return {
        lineId: (l && l.lineId ? String(l.lineId).trim() : '') || cryptoRandomId(),
        partNumber: ((l && l.partNumber) || '').toString().trim(),
        partName: ((l && l.partName) || '').toString().trim(),
        eau: ((l && l.eau) || '').toString().trim(),
        attachments: sanitizeOrgDocList(l && l.attachments)
      };
    })
    .filter(function (l) { return l.partNumber || l.partName; });
  const sharedWithCustomers = Array.isArray(body.sharedWithCustomers)
    ? Array.from(new Set(body.sharedWithCustomers.map(function (v) { return (v || '').toString().trim(); }).filter(Boolean)))
    : [];
  return {
    rfqDate: (body.rfqDate || '').toString().trim(),
    notes: (body.notes || '').toString().trim(),
    lines: lines,
    sharedWithCustomers: sharedWithCustomers
  };
}

async function handleCreateCustomerRfq(request, env, origin) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const fields = validateCustomerRfqFields(body);

  const clientRfqNumber = (body.rfqNumber !== undefined && body.rfqNumber !== null) ? String(body.rfqNumber).trim() : '';
  if (clientRfqNumber && await customerRfqNumberTaken(env, clientRfqNumber, null)) {
    return json({ message: 'That RFQ Number is already in use.' }, 409, origin);
  }
  const rfqNumber = await reserveCustomerRfqNumber(env, clientRfqNumber);
  const newRfq = Object.assign(
    { id: cryptoRandomId(), createdAt: new Date().toISOString(), rfqNumber: rfqNumber, dessimateAttachments: sanitizeOrgDocList(body.dessimateAttachments) },
    fields
  );

  const result = await mutateJsonArrayFile(env, CUSTOMER_RFQS_FILE_PATH, function (items) {
    items.push(newRfq);
    return { items: items };
  });
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeCustomerRfq(newRfq), 201, origin);
}

async function handleUpdateCustomerRfq(request, env, origin, id) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const fields = validateCustomerRfqFields(body);

  let newRfqNumber; // undefined = leave as-is
  if (body.rfqNumber !== undefined) {
    const requested = (body.rfqNumber === null ? '' : String(body.rfqNumber)).trim();
    if (!requested) return json({ message: 'RFQ Number is required.' }, 400, origin);
    if (await customerRfqNumberTaken(env, requested, id)) {
      return json({ message: 'That RFQ Number is already in use.' }, 409, origin);
    }
    newRfqNumber = /^\d+$/.test(requested) ? Number(requested) : requested;
  }

  let saved = null;
  const result = await mutateJsonArrayFile(env, CUSTOMER_RFQS_FILE_PATH, function (items) {
    const target = items.find(function (o) { return o.id === id; });
    if (!target) return null;
    Object.assign(target, fields); // dessimateQuote is never in `fields` - a team_member's edit never touches it
    if (newRfqNumber !== undefined) target.rfqNumber = newRfqNumber;
    if (body.dessimateAttachments !== undefined) target.dessimateAttachments = sanitizeOrgDocList(body.dessimateAttachments);
    saved = target;
    return { items: items };
  }, { requireFound: true });

  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  if (typeof newRfqNumber === 'number') {
    await mutateJsonObjectFile(env, COUNTERS_FILE_PATH, DEFAULT_COUNTERS, function (obj) {
      if (newRfqNumber >= obj.nextCustomerRfqNumber) obj.nextCustomerRfqNumber = newRfqNumber + 1;
      return { obj: obj };
    });
  }
  return json(sanitizeCustomerRfq(saved), 200, origin);
}

// Hard delete, same precedent as the original RFQ module (see its own
// module comment for why).
async function handleDeleteCustomerRfq(env, origin, id) {
  const result = await mutateJsonArrayFile(env, CUSTOMER_RFQS_FILE_PATH, function (items) {
    const idx = items.findIndex(function (o) { return o.id === id; });
    if (idx === -1) return null;
    items.splice(idx, 1);
    return { items: items };
  }, { requireFound: true });
  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json({ ok: true }, 200, origin);
}

// Used by isContentsPathAllowedForExternal to gate a Customer's raw
// /contents/ file access to a Customer RFQ's attachments.
async function resolveCustomerRfqRecord(env, rfqId) {
  const state = await readJsonArrayFile(env, CUSTOMER_RFQS_FILE_PATH);
  const rfq = state.items.find(function (o) { return o.id === rfqId; });
  return rfq ? sanitizeCustomerRfq(rfq) : null;
}

// The Dessimate Quote back to the Customer - Admin/Super Admin only, same
// bar as the original RFQ module's handleUpdateRfqDessimateQuote (see its
// own comment for the full reasoning, unchanged here). Body:
// { lines: [{lineId,price,toolingCost}], attachments: [...], notes,
// submit: boolean }.
async function handleUpdateCustomerRfqQuote(request, env, origin, id, username) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const linesIn = Array.isArray(body.lines) ? body.lines : [];
  const attachments = sanitizeOrgDocList(body.attachments);
  const notes = (body.notes || '').toString().trim();
  const submitNow = !!body.submit;

  let saved = null;
  const result = await mutateJsonArrayFile(env, CUSTOMER_RFQS_FILE_PATH, function (items) {
    const target = items.find(function (o) { return o.id === id; });
    if (!target) return null;
    const validLineIds = new Set((Array.isArray(target.lines) ? target.lines : []).map(function (l) { return l.lineId; }));
    const lines = linesIn
      .filter(function (l) { return l && validLineIds.has(l.lineId); })
      .map(function (l) { return { lineId: String(l.lineId), price: Number(l.price) || 0, toolingCost: Number(l.toolingCost) || 0 }; });
    const prior = (target.dessimateQuote && typeof target.dessimateQuote === 'object') ? target.dessimateQuote : {};
    target.dessimateQuote = {
      lines: lines,
      attachments: attachments,
      notes: notes,
      submitted: submitNow || !!prior.submitted,
      submittedAt: submitNow ? new Date().toISOString() : (prior.submittedAt || null),
      submittedBy: submitNow ? (username || '') : (prior.submittedBy || '')
    };
    saved = target;
    return { items: items };
  }, { requireFound: true });
  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeCustomerRfqQuote(saved.dessimateQuote), 200, origin);
}

// One-time snapshot clone of every existing RFQ into the new Customer RFQ
// store, for the RFQ-module split (Rev2.27) - after this runs the two
// stores are completely independent (per the confirmed brief: "one-time
// snapshot, fully independent after"), so this is meant to be triggered
// once by a Super Admin, not run on a schedule. Renumbers every cloned
// record into the new 8000-series (the brief: "create a separate number
// series" applies to clones too, not just new Customer RFQs going forward)
// rather than carrying over the old RFQ Number - originally 9500 (Rev2.27),
// moved to 8000 (Rev2.28) since it read as confusingly close to the
// Dessimate RFQ module's own 9000-series. Strips everything Supplier-side
// (sharedWithSuppliers,
// supplierQuotes) since they don't exist in sanitizeCustomerRfq's shape to
// begin with - only lines/dessimateAttachments/sharedWithCustomers/
// dessimateQuote/notes/rfqDate/createdAt survive the clone.
// Idempotent per source record: each cloned record is stamped with a
// (deliberately unsanitized, never returned by sanitizeCustomerRfq)
// `sourceRfqId`, and a source RFQ already represented by one is skipped on
// a re-run - so accidentally calling this twice does not double-clone.
// Attachment bytes are physically copied in R2 (env.FILES.get -> .put) to
// new paths under customer_rfq_docs/<newId>/... and
// customer_rfq_dessimate_quote_docs/<newId>/..., not just re-pointed at the
// old rfq_docs/<oldId>/... paths - the new store's own access-control
// branches in isContentsPathAllowedForExternal only ever allow
// customer_rfq_docs/customer_rfq_dessimate_quote_docs, so a re-pointed path
// would silently 403 for a Customer viewer.
async function cloneOrgDocToCustomerRfq(env, doc, oldPrefix, newPrefix) {
  if (!doc || !doc.path || doc.path.indexOf(oldPrefix) !== 0) return doc;
  const newPath = newPrefix + doc.path.slice(oldPrefix.length);
  const obj = await env.FILES.get(doc.path);
  if (obj) {
    const bytes = await obj.arrayBuffer();
    await env.FILES.put(newPath, bytes);
  }
  return Object.assign({}, doc, { path: newPath });
}

async function handleCloneRfqsToCustomerRfqs(env, origin) {
  const rfqState = await readJsonArrayFile(env, RFQS_FILE_PATH);
  const customerState = await readJsonArrayFile(env, CUSTOMER_RFQS_FILE_PATH);
  const alreadyCloned = new Set(customerState.items.map(function (o) { return o.sourceRfqId; }).filter(Boolean));

  const sources = rfqState.items
    .filter(function (o) { return !alreadyCloned.has(o.id); })
    .slice()
    .sort(function (a, b) { return String(a.createdAt || '').localeCompare(String(b.createdAt || '')); });

  const cloned = [];
  for (let i = 0; i < sources.length; i++) {
    // Read straight off the raw stored record, not through sanitizeRfq -
    // sharedWithCustomers/dessimateQuote were stripped from that function's
    // output when the Dessimate RFQ module was trimmed down to Supplier-only
    // (Rev2.27), but they're still sitting in the raw JSON on disk for any
    // RFQ that had them before that cutover, which is exactly what this
    // clone needs to read. sanitizeCustomerRfqQuote below reuses the
    // Customer RFQ module's own sanitizer since the shape is identical.
    const raw = sources[i];
    const rawLines = Array.isArray(raw.lines) ? raw.lines : [];
    const dessimateQuoteIn = sanitizeCustomerRfqQuote(raw.dessimateQuote);
    const sharedWithCustomersIn = Array.isArray(raw.sharedWithCustomers)
      ? Array.from(new Set(raw.sharedWithCustomers.map(function (v) { return (v || '').toString().trim(); }).filter(Boolean)))
      : [];

    const newId = cryptoRandomId();
    const oldDocPrefix = RFQ_DOC_FOLDER + '/' + raw.id;
    const newDocPrefix = CUSTOMER_RFQ_DOC_FOLDER + '/' + newId;
    const oldQuoteDocPrefix = 'rfq_dessimate_quote_docs/' + raw.id;
    const newQuoteDocPrefix = 'customer_rfq_dessimate_quote_docs/' + newId;

    const dessimateAttachmentsIn = sanitizeOrgDocList(raw.dessimateAttachments);
    const dessimateAttachments = [];
    for (let j = 0; j < dessimateAttachmentsIn.length; j++) {
      dessimateAttachments.push(await cloneOrgDocToCustomerRfq(env, dessimateAttachmentsIn[j], oldDocPrefix, newDocPrefix));
    }
    const lines = [];
    for (let j = 0; j < rawLines.length; j++) {
      const l = sanitizeRfqLine(rawLines[j]);
      const lineAttachments = [];
      for (let k = 0; k < l.attachments.length; k++) {
        lineAttachments.push(await cloneOrgDocToCustomerRfq(env, l.attachments[k], oldDocPrefix, newDocPrefix));
      }
      lines.push({ lineId: l.lineId, partNumber: l.partNumber, partName: l.partName, eau: l.eau, attachments: lineAttachments });
    }
    const quoteAttachments = [];
    for (let j = 0; j < dessimateQuoteIn.attachments.length; j++) {
      quoteAttachments.push(await cloneOrgDocToCustomerRfq(env, dessimateQuoteIn.attachments[j], oldQuoteDocPrefix, newQuoteDocPrefix));
    }

    const rfqNumber = await reserveCustomerRfqNumber(env, '');
    cloned.push({
      id: newId,
      sourceRfqId: raw.id,
      rfqNumber: rfqNumber,
      rfqDate: raw.rfqDate || '',
      notes: raw.notes || '',
      lines: lines,
      dessimateAttachments: dessimateAttachments,
      sharedWithCustomers: sharedWithCustomersIn,
      dessimateQuote: {
        lines: dessimateQuoteIn.lines,
        attachments: quoteAttachments,
        notes: dessimateQuoteIn.notes,
        submitted: dessimateQuoteIn.submitted,
        submittedAt: dessimateQuoteIn.submittedAt,
        submittedBy: dessimateQuoteIn.submittedBy
      },
      createdAt: raw.createdAt || null
    });
  }

  if (cloned.length > 0) {
    const result = await mutateJsonArrayFile(env, CUSTOMER_RFQS_FILE_PATH, function (items) {
      return { items: items.concat(cloned) };
    });
    if (!result.ok) return json({ message: result.message }, 500, origin);
  }
  return json({ ok: true, clonedCount: cloned.length, skippedCount: rfqState.items.length - cloned.length }, 200, origin);
}

// One-time admin fix (Rev2.28): the Customer RFQ number series originally
// launched at 9500 (Rev2.27), which read as confusingly close to the
// Dessimate RFQ module's own 9000-series side by side. Re-assigns every
// existing Customer RFQ's number sequentially starting at 8000, in a
// stable order (sorted by current rfqNumber, so relative ordering is
// preserved), and resets nextCustomerRfqNumber to the next number after
// the last one assigned - so a fresh Customer RFQ created right after this
// runs continues the same unbroken 8000-series sequence. Safe to re-run:
// unlike the clone above (which skips already-cloned records to avoid
// duplicates), this always re-derives the same 8000..8000+N-1 assignment
// from current records, so calling it again just re-confirms the same
// numbers.
async function handleRenumberCustomerRfqsTo8000Series(env, origin) {
  const state = await readJsonArrayFile(env, CUSTOMER_RFQS_FILE_PATH);
  const ordered = state.items.slice().sort(function (a, b) {
    const an = typeof a.rfqNumber === 'number' ? a.rfqNumber : Number.MAX_SAFE_INTEGER;
    const bn = typeof b.rfqNumber === 'number' ? b.rfqNumber : Number.MAX_SAFE_INTEGER;
    if (an !== bn) return an - bn;
    return String(a.rfqNumber).localeCompare(String(b.rfqNumber));
  });
  const idToNewNumber = {};
  ordered.forEach(function (o, idx) { idToNewNumber[o.id] = 8000 + idx; });

  const result = await mutateJsonArrayFile(env, CUSTOMER_RFQS_FILE_PATH, function (items) {
    items.forEach(function (o) { if (idToNewNumber[o.id] !== undefined) o.rfqNumber = idToNewNumber[o.id]; });
    return { items: items };
  });
  if (!result.ok) return json({ message: result.message }, 500, origin);

  const nextNumber = 8000 + ordered.length;
  await mutateJsonObjectFile(env, COUNTERS_FILE_PATH, DEFAULT_COUNTERS, function (obj) {
    obj.nextCustomerRfqNumber = nextNumber;
    return { obj: obj };
  });
  return json({ ok: true, renumberedCount: ordered.length, nextNumber: nextNumber }, 200, origin);
}

// ---- Change Requests (Rev2.16) - "CR" module: a change either a Supplier
// is requesting of Dessimate, or Dessimate is requesting of a Supplier.
// Unlike every other Production Module (Dessimate PO/Invoice/Parts), a
// Supplier can create/edit their own CR directly - the product brief is
// explicit: "Each supplier should be able to see only their name in their
// dropdown when they initiate the change request." A Supplier's own write
// is still narrowly trusted: supplierOrg is always forced to their own
// resolved organization server-side (never taken from the client), and the
// Approval section (Team Member+ only - the internal review/sign-off) is
// silently stripped from a Supplier's payload even if present - same
// "never trust the client for a privileged field" pattern as RFQ's
// rfqNumber/supplierQuotes. Delete stays Team Member+ only (route-gated,
// not in this handler) - a Supplier managing their own CR shouldn't be
// able to erase one Dessimate raised against them.
const CHANGE_REQUESTS_FILE_PATH = 'data/change_requests.json';
const CR_DOC_FOLDER = 'change_request_docs';

// CR Number is formatted "CR-###" when system-assigned, but (like RFQ
// Number/PO Number/Shipment Number) a voluntary custom value is accepted
// and bumps the counter past it if it parses as "CR-<digits>", so the
// system never later hands out a colliding number.
async function reserveCrNumber(env, clientCrNumber) {
  const result = await mutateJsonObjectFile(env, COUNTERS_FILE_PATH, DEFAULT_COUNTERS, function (obj) {
    let crNumber;
    if (clientCrNumber) {
      crNumber = clientCrNumber;
      const m = /^CR-(\d+)$/i.exec(clientCrNumber);
      if (m) {
        const seq = Number(m[1]);
        if (seq >= obj.nextCrNumber) obj.nextCrNumber = seq + 1;
      }
    } else {
      crNumber = 'CR-' + pad3(obj.nextCrNumber);
      obj.nextCrNumber = obj.nextCrNumber + 1;
    }
    return { obj: obj, meta: { crNumber: crNumber } };
  });
  if (!result.ok) throw new Error(result.message);
  return result.meta.crNumber;
}

// Non-mutating preview for the Add-CR modal's "Use System Number" button.
async function handlePeekCrNumber(env, origin) {
  const state = await readJsonObjectFile(env, COUNTERS_FILE_PATH, DEFAULT_COUNTERS);
  return json({ crNumber: 'CR-' + pad3(state.obj.nextCrNumber) }, 200, origin);
}

async function crNumberTaken(env, crNumber, excludeId) {
  const state = await readJsonArrayFile(env, CHANGE_REQUESTS_FILE_PATH);
  const target = String(crNumber).toLowerCase();
  return state.items.some(function (o) { return o.id !== excludeId && String(o.crNumber).toLowerCase() === target; });
}

// CR's Attachments section - same shape as sanitizeOrgDoc, plus a short
// `comment` field (what the file is about) and `id` preserved through
// (needed intact: the "Generate PDF" button tags its own saved copy with a
// fixed id so re-generating replaces it in place instead of appending a
// duplicate - see PDIR_ChangeRequests.html's GENERATED_PDF_ID).
function sanitizeCrAttachment(d) {
  if (!d || !d.path) return null;
  return {
    id: d.id || null,
    path: d.path,
    filename: d.filename || '',
    mimeType: d.mimeType || 'application/octet-stream',
    size: typeof d.size === 'number' ? d.size : 0,
    comment: d.comment || '',
    uploadedBy: (d && d.uploadedBy) || '',
    uploadedAt: (d && d.uploadedAt) || null
  };
}
function sanitizeCrAttachments(list) {
  const arr = Array.isArray(list) ? list : [];
  return arr.map(sanitizeCrAttachment).filter(Boolean).slice(0, PART_ATTACHMENTS_MAX);
}

function sanitizeChangeRequest(o) {
  return {
    id: o.id,
    crNumber: o.crNumber || '',
    dateRaised: o.dateRaised || '',
    createdAt: o.createdAt || null,
    createdBy: o.createdBy || '',
    changeTitle: o.changeTitle || '',
    supplierOrg: o.supplierOrg || '',
    supplierContactName: o.supplierContactName || '',
    direction: o.direction === 'dessimate_to_supplier' ? 'dessimate_to_supplier' : 'supplier_to_dessimate',
    partNumbers: Array.isArray(o.partNumbers) ? o.partNumbers.slice(0, 5) : [],
    phase: (o.phase === 'pre_production' || o.phase === 'production') ? o.phase : '',
    changeType: (o.changeType === 'product' || o.changeType === 'process') ? o.changeType : '',
    currentConditionImage: sanitizeOrgDoc(o.currentConditionImage),
    newConditionImage: sanitizeOrgDoc(o.newConditionImage),
    detailsOfChange: o.detailsOfChange || '',
    purposeOfChange: o.purposeOfChange || '',
    attachments: sanitizeCrAttachments(o.attachments),
    requestedBySignature: o.requestedBySignature || '',
    requestedByCompany: o.requestedByCompany || '',
    requestedByDate: o.requestedByDate || '',
    approvalStatus: ['approved', 'conditional', 'rejected'].indexOf(o.approvalStatus) !== -1 ? o.approvalStatus : '',
    approvalComments: o.approvalComments || '',
    approvedBySignature: o.approvedBySignature || '',
    approvedByPrintName: o.approvedByPrintName || '',
    approvedByDate: o.approvedByDate || '',
    approvedByOrg: o.approvedByOrg || ''
  };
}

// Shared by create/update. `isSupplier` strips the Approval section
// entirely (Team Member+ only) regardless of what the client sent.
function validateChangeRequestFields(body, isSupplier) {
  const partNumbers = Array.isArray(body.partNumbers)
    ? body.partNumbers.map(function (v) { return (v || '').toString().trim(); }).filter(Boolean).slice(0, 5)
    : [];
  const fields = {
    dateRaised: (body.dateRaised || '').toString().trim(),
    changeTitle: (body.changeTitle || '').toString().trim(),
    supplierContactName: (body.supplierContactName || '').toString().trim(),
    direction: body.direction === 'dessimate_to_supplier' ? 'dessimate_to_supplier' : 'supplier_to_dessimate',
    partNumbers: partNumbers,
    phase: (body.phase === 'pre_production' || body.phase === 'production') ? body.phase : '',
    changeType: (body.changeType === 'product' || body.changeType === 'process') ? body.changeType : '',
    currentConditionImage: sanitizeOrgDoc(body.currentConditionImage),
    newConditionImage: sanitizeOrgDoc(body.newConditionImage),
    detailsOfChange: (body.detailsOfChange || '').toString().trim(),
    purposeOfChange: (body.purposeOfChange || '').toString().trim(),
    attachments: sanitizeCrAttachments(body.attachments),
    requestedBySignature: (body.requestedBySignature || '').toString().trim(),
    requestedByCompany: (body.requestedByCompany || '').toString().trim(),
    requestedByDate: (body.requestedByDate || '').toString().trim()
  };
  if (!isSupplier) {
    fields.approvalStatus = ['approved', 'conditional', 'rejected'].indexOf(body.approvalStatus) !== -1 ? body.approvalStatus : '';
    fields.approvalComments = (body.approvalComments || '').toString().trim();
    fields.approvedBySignature = (body.approvedBySignature || '').toString().trim();
    fields.approvedByPrintName = (body.approvedByPrintName || '').toString().trim();
    fields.approvedByDate = (body.approvedByDate || '').toString().trim();
    fields.approvedByOrg = (body.approvedByOrg || '').toString().trim();
  }
  return fields;
}

// Team Member+ sees every CR; a Supplier sees only ones where they're the
// named supplierOrg (regardless of direction - a Supplier can be either the
// requester or the target of a Dessimate-initiated CR, and needs to see
// either). A Customer login has no role in this module at all (never
// mentioned in the brief - "Dessimate team... all... Suppliers... only
// their related CRs") and sees nothing, same as RFQ's Supplier-side data.
function scopeChangeRequests(items, accessLevel, organization) {
  if (accessLevel === 'supplier') {
    return items.filter(function (o) { return organization && o.supplierOrg === organization; });
  }
  if (accessLevel === 'customer') return [];
  return items;
}

async function handleListChangeRequests(env, origin, accessLevel, organization) {
  const state = await readJsonArrayFile(env, CHANGE_REQUESTS_FILE_PATH);
  const items = scopeChangeRequests(state.items.map(sanitizeChangeRequest), accessLevel, organization);
  return json({ changeRequests: items }, 200, origin);
}

async function handleCreateChangeRequest(request, env, origin, accessLevel, username) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const isSupplier = accessLevel === 'supplier';
  const fields = validateChangeRequestFields(body, isSupplier);

  let supplierOrg;
  if (isSupplier) {
    supplierOrg = await resolveUserOrganization(env, username);
    if (!supplierOrg) return json({ message: 'Your account isn’t linked to a Supplier organization.' }, 403, origin);
  } else {
    supplierOrg = (body.supplierOrg || '').toString().trim();
    if (!supplierOrg) return json({ message: 'Supplier is required.' }, 400, origin);
  }

  const clientCrNumber = (body.crNumber !== undefined && body.crNumber !== null) ? String(body.crNumber).trim() : '';
  if (clientCrNumber && await crNumberTaken(env, clientCrNumber, null)) {
    return json({ message: 'That Change Request Number is already in use.' }, 409, origin);
  }
  const crNumber = await reserveCrNumber(env, clientCrNumber);

  const newCr = Object.assign(
    { id: cryptoRandomId(), createdAt: new Date().toISOString(), createdBy: username || '', crNumber: crNumber, supplierOrg: supplierOrg },
    fields
  );

  const result = await mutateJsonArrayFile(env, CHANGE_REQUESTS_FILE_PATH, function (items) {
    items.push(newCr);
    return { items: items };
  });
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeChangeRequest(newCr), 201, origin);
}

async function handleUpdateChangeRequest(request, env, origin, id, accessLevel, username) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const isSupplier = accessLevel === 'supplier';
  const fields = validateChangeRequestFields(body, isSupplier);

  let callerOrg = '';
  if (isSupplier) {
    callerOrg = await resolveUserOrganization(env, username);
    if (!callerOrg) return json({ message: 'Your account isn’t linked to a Supplier organization.' }, 403, origin);
  }

  let newCrNumber; // undefined = leave as-is
  if (body.crNumber !== undefined) {
    if (isSupplier) return json({ message: 'Only Dessimate staff can change the Change Request Number.' }, 403, origin);
    const requested = (body.crNumber === null ? '' : String(body.crNumber)).trim();
    if (!requested) return json({ message: 'Change Request Number is required.' }, 400, origin);
    if (await crNumberTaken(env, requested, id)) {
      return json({ message: 'That Change Request Number is already in use.' }, 409, origin);
    }
    newCrNumber = requested;
  }

  let saved = null;
  const result = await mutateJsonArrayFile(env, CHANGE_REQUESTS_FILE_PATH, function (items) {
    const target = items.find(function (o) { return o.id === id; });
    if (!target) return null;
    if (isSupplier && target.supplierOrg !== callerOrg) return null; // 404s below rather than 403 - don't reveal existence
    if (!isSupplier && body.supplierOrg !== undefined) {
      const requestedOrg = (body.supplierOrg || '').toString().trim();
      if (requestedOrg) target.supplierOrg = requestedOrg;
    }
    Object.assign(target, fields); // approvalStatus/approvedBy* are never in `fields` for a Supplier's edit
    if (newCrNumber !== undefined) target.crNumber = newCrNumber;
    saved = target;
    return { items: items };
  }, { requireFound: true });

  if (result === 'not-found' || !saved) return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeChangeRequest(saved), 200, origin);
}

async function handleDeleteChangeRequest(env, origin, id) {
  const result = await mutateJsonArrayFile(env, CHANGE_REQUESTS_FILE_PATH, function (items) {
    const idx = items.findIndex(function (o) { return o.id === id; });
    if (idx === -1) return null;
    items.splice(idx, 1);
    return { items: items };
  }, { requireFound: true });
  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json({ ok: true }, 200, origin);
}

// Used by isContentsPathAllowedForExternal's change_request_docs branch and
// the PDF route's Supplier ownership check - same "resolve just the
// ownership field from raw storage" shape as resolveDessimatePoOwner.
async function resolveChangeRequestRecord(env, id) {
  const state = await readJsonArrayFile(env, CHANGE_REQUESTS_FILE_PATH);
  return state.items.find(function (o) { return o.id === id; }) || null;
}

// Single-page rendering of the Dessimate_Change_Request(CR).xlsx template -
// same drawn-from-scratch approach as buildDessimatePoPdf (this repo has no
// tooling to fill an actual .xlsx/.docx template, so every PDF-producing
// module recreates the reference layout with pdf-lib primitives instead).
// currentConditionDoc/newConditionDoc are the raw {bytes, mimeType} already
// read from R2 by the caller (or null) - embedded here via this function's
// own pdfDoc, same as buildDessimatePoPdf embeds the approver stamp.
async function buildCrPdf(cr, currentConditionDoc, newConditionDoc) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 612, pageHeight = 792; // US Letter
  const margin = 44;
  const contentW = pageWidth - margin * 2;

  async function embedImageDoc(doc) {
    if (!doc || !doc.bytes) return null;
    try {
      return (doc.mimeType === 'image/png') ? await pdfDoc.embedPng(doc.bytes) : await pdfDoc.embedJpg(doc.bytes);
    } catch (e) { return null; }
  }
  const currentConditionImg = await embedImageDoc(currentConditionDoc);
  const newConditionImg = await embedImageDoc(newConditionDoc);

  const brandBlue = rgb(0.106, 0.243, 0.706);
  const ink = rgb(0.1, 0.1, 0.12);
  const labelGray = rgb(0.42, 0.44, 0.49);
  const lineGray = rgb(0.85, 0.86, 0.89);
  const sectionBg = rgb(0.925, 0.941, 0.976);

  const page = pdfDoc.addPage([pageWidth, pageHeight]);

  let logoImg = null;
  try { logoImg = await pdfDoc.embedJpg(base64ToBytes(DESSIMATE_LOGO_JPG_BASE64)); } catch (e) { logoImg = null; }

  function leftText(str, x, yy, size, opts) {
    opts = opts || {};
    page.drawText(str == null ? '' : String(str), { x: x, y: yy, size: size, font: opts.bold ? fontBold : font, color: opts.color || ink });
  }
  function rightText(str, rightEdgeX, yy, size, opts) {
    opts = opts || {};
    const f = opts.bold ? fontBold : font;
    const s = str == null ? '' : String(str);
    page.drawText(s, { x: rightEdgeX - f.widthOfTextAtSize(s, size), y: yy, size: size, font: f, color: opts.color || ink });
  }
  function wrapLines(str, maxWidth, size, useFont) {
    const f = useFont || font;
    const out = [];
    (str || '').split(/\r?\n/).forEach(function (raw) {
      const words = raw.split(/\s+/).filter(Boolean);
      if (!words.length) { out.push(''); return; }
      let cur = '';
      words.forEach(function (w) {
        const attempt = cur ? cur + ' ' + w : w;
        if (cur && f.widthOfTextAtSize(attempt, size) > maxWidth) { out.push(cur); cur = w; }
        else cur = attempt;
      });
      if (cur) out.push(cur);
    });
    return out;
  }
  function fmtDateMDY(s) {
    const str = (s || '').toString().trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
    return m ? (m[2] + '/' + m[3] + '/' + m[1]) : str;
  }
  // A checkbox as drawn on the actual template - an outlined square, filled
  // solid when checked. `label` is drawn immediately to its right.
  function checkbox(x, yy, checked, label, opts) {
    opts = opts || {};
    const size = 9;
    page.drawRectangle({ x: x, y: yy, width: size, height: size, borderColor: ink, borderWidth: 1, color: checked ? ink : rgb(1, 1, 1) });
    leftText(label, x + size + 5, yy + 1, opts.size || 9.5, { bold: opts.bold });
  }
  function sectionHeader(label, x, yy, w) {
    page.drawRectangle({ x: x, y: yy - 14, width: w, height: 16, color: sectionBg });
    leftText(label, x + 6, yy - 10, 9.5, { bold: true, color: brandBlue });
  }

  // ---- Header: logo + title, CR Number / Date Raised ------------------------
  let hy = pageHeight - 40;
  if (logoImg) {
    const dims = logoImg.scaleToFit(108, 60);
    page.drawImage(logoImg, { x: margin, y: hy - dims.height, width: dims.width, height: dims.height });
  } else {
    leftText('Dessimate', margin, hy - 14, 16, { bold: true, color: brandBlue });
  }
  rightText('CHANGE REQUEST (CR)', pageWidth - margin, hy - 16, 18, { bold: true, color: brandBlue });
  rightText('CR #: ' + (cr.crNumber || ''), pageWidth - margin, hy - 34, 10, { bold: true });
  rightText('Date Raised: ' + fmtDateMDY(cr.dateRaised), pageWidth - margin, hy - 48, 10);

  let y = hy - 82;
  // Change Title - not part of the original .xlsx template, added per
  // request as a prominent "subject line" under the header so a reader
  // knows what the change is about before reading Section A.
  if (cr.changeTitle) {
    var titleLines = wrapLines(cr.changeTitle, contentW, 13, fontBold).slice(0, 2);
    titleLines.forEach(function (line) { leftText(line, margin, y, 13, { bold: true, color: ink }); y -= 16; });
    y -= 8;
  }

  // ---- Supplier Information --------------------------------------------------
  sectionHeader('SUPPLIER INFORMATION', margin, y, contentW);
  y -= 24;
  leftText('Supplier:', margin, y, 9, { bold: true, color: labelGray });
  leftText(cr.supplierOrg || '—', margin + 55, y, 10);
  rightText('Supplier Contact:', margin + contentW / 2 + 60, y, 9, { bold: true, color: labelGray });
  leftText(cr.supplierContactName || '—', margin + contentW / 2 + 65, y, 10);
  y -= 22;

  // ---- Change Requested By / To ----------------------------------------------
  // Stacked (not side-by-side) - an org name can run long enough to collide
  // with a fixed-column neighbor, and unlike the Supplier/Contact row above,
  // both values here can independently be a full org name.
  const byIsSupplier = cr.direction !== 'dessimate_to_supplier';
  const requestedBy = byIsSupplier ? (cr.supplierOrg || 'Supplier') : 'Dessimate';
  const requestedTo = byIsSupplier ? 'Dessimate' : (cr.supplierOrg || 'Supplier');
  leftText('Change Requested By:', margin, y, 9, { bold: true, color: labelGray });
  leftText(requestedBy, margin + 130, y, 10);
  y -= 16;
  leftText('Change Requested To:', margin, y, 9, { bold: true, color: labelGray });
  leftText(requestedTo, margin + 130, y, 10);
  y -= 26;

  // ---- Part Numbers Affected --------------------------------------------------
  sectionHeader('PART NUMBERS AFFECTED', margin, y, contentW);
  y -= 20;
  const partNumbers = Array.isArray(cr.partNumbers) ? cr.partNumbers : [];
  if (!partNumbers.length) {
    leftText('—', margin + 6, y, 9.5); y -= 14;
  } else {
    partNumbers.forEach(function (pn, i) { leftText((i + 1) + '. ' + pn, margin + 6, y, 9.5); y -= 13; });
  }
  y -= 6;

  // ---- Phase / Type -----------------------------------------------------------
  checkbox(margin, y, cr.phase === 'pre_production', 'Pre-Production', {});
  checkbox(margin + 130, y, cr.phase === 'production', 'Production', {});
  checkbox(margin + 260, y, cr.changeType === 'product', 'Product Related', {});
  checkbox(margin + 400, y, cr.changeType === 'process', 'Process Related', {});
  y -= 24;

  // ---- Reference Images: Current Condition / New Condition -------------------
  sectionHeader('REFERENCE IMAGE — MARKING LOCATION & TEXT', margin, y, contentW);
  y -= 16;
  const imgBoxH = 130;
  const imgBoxW = (contentW - 14) / 2;
  const imgBoxY = y - imgBoxH;
  [
    { label: 'Current Condition', x: margin, img: currentConditionImg },
    { label: 'New Condition', x: margin + imgBoxW + 14, img: newConditionImg }
  ].forEach(function (slot) {
    page.drawRectangle({ x: slot.x, y: imgBoxY, width: imgBoxW, height: imgBoxH, borderColor: lineGray, borderWidth: 1 });
    leftText(slot.label, slot.x + 6, imgBoxY + imgBoxH - 12, 8.5, { bold: true, color: labelGray });
    if (slot.img) {
      const pad = 6, maxW = imgBoxW - pad * 2, maxH = imgBoxH - 22;
      const dims = slot.img.scaleToFit(maxW, maxH);
      page.drawImage(slot.img, {
        x: slot.x + (imgBoxW - dims.width) / 2,
        y: imgBoxY + pad + (maxH - dims.height) / 2,
        width: dims.width, height: dims.height
      });
    } else {
      leftText('No image attached.', slot.x + 6, imgBoxY + imgBoxH / 2, 9, { color: labelGray });
    }
  });
  y = imgBoxY - 18;

  // ---- Details of Change / Purpose of Change ----------------------------------
  function textBlock(label, value, minLines) {
    sectionHeader(label, margin, y, contentW);
    y -= 20;
    const lines = wrapLines(value, contentW - 12, 9.5);
    const shown = lines.length ? lines : [''];
    const lineCount = Math.max(shown.length, minLines || 2);
    for (let i = 0; i < lineCount; i++) { leftText(shown[i] || '', margin + 6, y, 9.5); y -= 12; }
    y -= 8;
  }
  textBlock('DETAILS OF CHANGE (ADD ATTACHMENTS IF NECESSARY)', cr.detailsOfChange, 3);
  if (Array.isArray(cr.attachments) && cr.attachments.length) {
    leftText('Attachments: ' + cr.attachments.map(function (a) { return a.filename; }).join(', '), margin + 6, y, 8.5, { color: labelGray });
    y -= 16;
  }
  textBlock('PURPOSE OF CHANGE', cr.purposeOfChange, 2);
  leftText('Kindly review and provide your approval for implementation.', margin, y, 9, { color: labelGray });
  y -= 22;

  // ---- Requested By sign-off ---------------------------------------------------
  function signRow(cols) {
    const colW = contentW / cols.length;
    cols.forEach(function (c, i) {
      const x = margin + i * colW;
      leftText(c.label, x, y, 8, { bold: true, color: labelGray });
      page.drawLine({ start: { x: x, y: y - 14 }, end: { x: x + colW - 12, y: y - 14 }, thickness: 0.75, color: lineGray });
      leftText(c.value || '', x, y - 12, 9.5);
    });
    y -= 30;
  }
  signRow([
    { label: 'REQUESTED BY (SIGNATURE)', value: cr.requestedBySignature },
    { label: 'SUPPLIER / COMPANY', value: cr.requestedByCompany },
    { label: 'DATE', value: fmtDateMDY(cr.requestedByDate) }
  ]);

  // ---- Approval -----------------------------------------------------------------
  sectionHeader('APPROVAL', margin, y, contentW);
  y -= 20;
  checkbox(margin, y, cr.approvalStatus === 'approved', 'Approved', {});
  checkbox(margin + 140, y, cr.approvalStatus === 'conditional', 'Conditional Approval', {});
  checkbox(margin + 320, y, cr.approvalStatus === 'rejected', 'Rejected', {});
  y -= 20;
  leftText('Conditions / Comments:', margin, y, 8, { bold: true, color: labelGray });
  y -= 12;
  wrapLines(cr.approvalComments, contentW - 12, 9.5).slice(0, 3).forEach(function (l) { leftText(l, margin + 6, y, 9.5); y -= 12; });
  y -= 8;

  signRow([
    { label: 'APPROVED BY (SIGNATURE)', value: cr.approvedBySignature },
    { label: 'PRINT NAME', value: cr.approvedByPrintName },
    { label: 'DATE', value: fmtDateMDY(cr.approvedByDate) },
    { label: 'ORGANIZATION', value: cr.approvedByOrg }
  ]);

  // ---- Footer ---------------------------------------------------------------
  leftText('Dessimate – Change Request – Form QF-CR-01, Rev. A', margin, 30, 7.5, { color: labelGray });

  return pdfDoc.save();
}

async function handleGetChangeRequestPdf(env, origin, id, accessLevel, organization) {
  const raw = await resolveChangeRequestRecord(env, id);
  if (!raw) return json({ message: 'Not found.' }, 404, origin);
  let clean = sanitizeChangeRequest(raw);
  const scoped = scopeChangeRequests([clean], accessLevel, organization);
  if (!scoped.length) return json({ message: 'Not found.' }, 404, origin);
  clean = scoped[0];

  async function loadImageDoc(doc) {
    if (!doc || !doc.path) return null;
    try {
      const bytes = await readGithubFileBytes(env, doc.path);
      return bytes ? { bytes: bytes, mimeType: doc.mimeType } : null;
    } catch (e) { return null; }
  }

  let pdfBytes;
  try {
    const currentConditionDoc = await loadImageDoc(clean.currentConditionImage);
    const newConditionDoc = await loadImageDoc(clean.newConditionImage);
    pdfBytes = await buildCrPdf(clean, currentConditionDoc, newConditionDoc);
  } catch (e) {
    return json({ message: 'Could not generate PDF: ' + (e && e.message ? e.message : e) }, 500, origin);
  }
  return pdfResponse(pdfBytes, 'Change Request ' + clean.crNumber + '.pdf', origin);
}

// ---- Customer SCR (Rev2.17) - "Supplier Change Request", the formal
// document strictly between Dessimate and a Customer: same underlying
// change-management idea as the CR module above, but a completely separate
// record type modeled on the actual SCR00x templates (Sections A-E:
// Supplier Info, Part Info, Deviation Info, an internal Approval/
// Disapproval routing table across six Dessimate departments, and a
// Disposition section). Unlike CR, this is Dessimate-staff-only end to
// end - a Supplier has zero access (not even read), confirmed explicitly:
// "customer SCRs are between Dessimate and customer only." A Customer only
// ever sees a record once Dessimate has explicitly added their org to
// sharedWithCustomers ("only when Dessimate team completes the work and is
// ready to share with customer") - same RFQ-style opt-in share list, never
// automatic. The generated PDF is available in two brandings (Dessimate's
// own letterhead, or the specific shared Customer's own letterhead/logo)
// since the source templates are the same form under two different
// letterheads.
const SCRS_FILE_PATH = 'data/scrs.json';
const SCR_DOC_FOLDER = 'scr_docs';
const SCR_APPROVAL_DEPARTMENTS = ['supplyChainManagement', 'supplierQuality', 'engineering', 'manufacturing', 'approval', 'productManagement'];

// SCR Number is formatted "SCR-###" when system-assigned - same voluntary/
// custom-value pattern as reserveCrNumber.
async function reserveScrNumber(env, clientScrNumber) {
  const result = await mutateJsonObjectFile(env, COUNTERS_FILE_PATH, DEFAULT_COUNTERS, function (obj) {
    let scrNumber;
    if (clientScrNumber) {
      scrNumber = clientScrNumber;
      const m = /^SCR-(\d+)$/i.exec(clientScrNumber);
      if (m) {
        const seq = Number(m[1]);
        if (seq >= obj.nextScrNumber) obj.nextScrNumber = seq + 1;
      }
    } else {
      scrNumber = 'SCR-' + pad3(obj.nextScrNumber);
      obj.nextScrNumber = obj.nextScrNumber + 1;
    }
    return { obj: obj, meta: { scrNumber: scrNumber } };
  });
  if (!result.ok) throw new Error(result.message);
  return result.meta.scrNumber;
}

async function handlePeekScrNumber(env, origin) {
  const state = await readJsonObjectFile(env, COUNTERS_FILE_PATH, DEFAULT_COUNTERS);
  return json({ scrNumber: 'SCR-' + pad3(state.obj.nextScrNumber) }, 200, origin);
}

async function scrNumberTaken(env, scrNumber, excludeId) {
  const state = await readJsonArrayFile(env, SCRS_FILE_PATH);
  const target = String(scrNumber).toLowerCase();
  return state.items.some(function (o) { return o.id !== excludeId && String(o.scrNumber).toLowerCase() === target; });
}

// SCR's Attachments section - same shape as sanitizeOrgDoc, plus a short
// `comment` field (what the file is about) and `id` preserved through
// (needed intact: the "Generate Document" button tags its own saved copy
// with a fixed id so re-generating replaces it in place instead of
// appending a duplicate - see PDIR_SCR.html's GENERATED_DOC_ID).
function sanitizeScrAttachment(d) {
  if (!d || !d.path) return null;
  return {
    id: d.id || null,
    path: d.path,
    filename: d.filename || '',
    mimeType: d.mimeType || 'application/octet-stream',
    size: typeof d.size === 'number' ? d.size : 0,
    comment: d.comment || '',
    uploadedBy: (d && d.uploadedBy) || '',
    uploadedAt: (d && d.uploadedAt) || null
  };
}
function sanitizeScrAttachments(list) {
  const arr = Array.isArray(list) ? list : [];
  return arr.map(sanitizeScrAttachment).filter(Boolean).slice(0, PART_ATTACHMENTS_MAX);
}

// One row of Section D's approval routing table (Acknowledgement/
// Signature/Date/Approve-Disapprove/Comments per department).
function sanitizeScrApproval(a) {
  const source = a || {};
  return {
    acknowledged: !!source.acknowledged,
    signature: (source.signature || '').toString(),
    date: (source.date || '').toString(),
    decision: (source.decision === 'approve' || source.decision === 'disapprove') ? source.decision : '',
    comments: (source.comments || '').toString()
  };
}
function sanitizeScrApprovals(approvals) {
  const source = approvals || {};
  const out = {};
  SCR_APPROVAL_DEPARTMENTS.forEach(function (key) { out[key] = sanitizeScrApproval(source[key]); });
  return out;
}
function validateScrApprovals(body) {
  return sanitizeScrApprovals(body);
}

function sanitizeScr(o) {
  return {
    id: o.id,
    scrNumber: o.scrNumber || '',
    createdAt: o.createdAt || null,
    createdBy: o.createdBy || '',
    // Not part of the original SCR00x template - added as a prominent
    // "subject line" the same way CR's changeTitle was, so a reader knows
    // what the SCR is about before reading Section A.
    scrTitle: o.scrTitle || '',
    // A. Supplier Information
    supplierOrg: o.supplierOrg || '',
    supplierDate: o.supplierDate || '',
    supplierContactName: o.supplierContactName || '',
    supplierPhone: o.supplierPhone || '',
    supplierFax: o.supplierFax || '',
    // B. Part Information
    partNumber: o.partNumber || '',
    partDescription: o.partDescription || '',
    revisionLevel: o.revisionLevel || '',
    poNumber: o.poNumber || '',
    quantity: o.quantity || '',
    // C. Deviation Information
    productRelated: !!o.productRelated,
    processRelated: !!o.processRelated,
    firstTime: !!o.firstTime,
    repeat: !!o.repeat,
    permanent: !!o.permanent,
    temporary: !!o.temporary,
    temporaryDuration: o.temporaryDuration || '',
    supplierSubTier: !!o.supplierSubTier,
    supplierSubTierDetail: o.supplierSubTierDetail || '',
    currentRequirement: o.currentRequirement || '',
    proposedDeviation: o.proposedDeviation || '',
    reasonForDeviation: o.reasonForDeviation || '',
    effectNone: !!o.effectNone,
    effectNoneExplain: o.effectNoneExplain || '',
    effectCost: !!o.effectCost,
    effectDelivery: !!o.effectDelivery,
    effectSchedule: !!o.effectSchedule,
    effectReliability: !!o.effectReliability,
    effectPerformance: !!o.effectPerformance,
    effectOther: !!o.effectOther,
    supplierQualityEngineerComment: o.supplierQualityEngineerComment || '',
    plannedAffectivity: o.plannedAffectivity || '',
    attachments: sanitizeScrAttachments(o.attachments),
    // D. Approval/Disapproval
    approvals: sanitizeScrApprovals(o.approvals),
    // E. Disposition
    drawingChangeRequired: (o.drawingChangeRequired === 'yes' || o.drawingChangeRequired === 'no') ? o.drawingChangeRequired : '',
    drawingChangeCR: o.drawingChangeCR || '',
    carRequired: (o.carRequired === 'yes' || o.carRequired === 'no') ? o.carRequired : '',
    carNumber: o.carNumber || '',
    finalDisposition: o.finalDisposition || '',
    // Sharing - a Customer sees nothing here until their org is added
    sharedWithCustomers: Array.isArray(o.sharedWithCustomers) ? o.sharedWithCustomers.filter(Boolean) : []
  };
}

// Dessimate-staff-only end to end (create/update/delete), so there's no
// isSupplier-style field-stripping branch here the way validateChangeRequestFields
// has - every field is always accepted from a Team Member+ caller.
function validateScrFields(body) {
  return {
    scrTitle: (body.scrTitle || '').toString().trim(),
    supplierOrg: (body.supplierOrg || '').toString().trim(),
    supplierDate: (body.supplierDate || '').toString().trim(),
    supplierContactName: (body.supplierContactName || '').toString().trim(),
    supplierPhone: (body.supplierPhone || '').toString().trim(),
    supplierFax: (body.supplierFax || '').toString().trim(),
    partNumber: (body.partNumber || '').toString().trim(),
    partDescription: (body.partDescription || '').toString().trim(),
    revisionLevel: (body.revisionLevel || '').toString().trim(),
    poNumber: (body.poNumber || '').toString().trim(),
    quantity: (body.quantity || '').toString().trim(),
    productRelated: !!body.productRelated,
    processRelated: !!body.processRelated,
    firstTime: !!body.firstTime,
    repeat: !!body.repeat,
    permanent: !!body.permanent,
    temporary: !!body.temporary,
    temporaryDuration: (body.temporaryDuration || '').toString().trim(),
    supplierSubTier: !!body.supplierSubTier,
    supplierSubTierDetail: (body.supplierSubTierDetail || '').toString().trim(),
    currentRequirement: (body.currentRequirement || '').toString().trim(),
    proposedDeviation: (body.proposedDeviation || '').toString().trim(),
    reasonForDeviation: (body.reasonForDeviation || '').toString().trim(),
    effectNone: !!body.effectNone,
    effectNoneExplain: (body.effectNoneExplain || '').toString().trim(),
    effectCost: !!body.effectCost,
    effectDelivery: !!body.effectDelivery,
    effectSchedule: !!body.effectSchedule,
    effectReliability: !!body.effectReliability,
    effectPerformance: !!body.effectPerformance,
    effectOther: !!body.effectOther,
    supplierQualityEngineerComment: (body.supplierQualityEngineerComment || '').toString().trim(),
    plannedAffectivity: (body.plannedAffectivity || '').toString().trim(),
    attachments: sanitizeScrAttachments(body.attachments),
    approvals: validateScrApprovals(body.approvals),
    drawingChangeRequired: (body.drawingChangeRequired === 'yes' || body.drawingChangeRequired === 'no') ? body.drawingChangeRequired : '',
    drawingChangeCR: (body.drawingChangeCR || '').toString().trim(),
    carRequired: (body.carRequired === 'yes' || body.carRequired === 'no') ? body.carRequired : '',
    carNumber: (body.carNumber || '').toString().trim(),
    finalDisposition: (body.finalDisposition || '').toString().trim(),
    sharedWithCustomers: Array.isArray(body.sharedWithCustomers)
      ? Array.from(new Set(body.sharedWithCustomers.map(function (v) { return (v || '').toString().trim(); }).filter(Boolean)))
      : []
  };
}

// Team Member+ sees every SCR. A Customer sees only ones explicitly shared
// with their org, with sharedWithCustomers itself stripped down to just
// their own name (no business seeing who else a record was shared with).
// A Supplier sees nothing at all - confirmed explicitly, unlike CR.
function scopeScrs(items, accessLevel, organization) {
  if (accessLevel === 'customer') {
    const visible = items.filter(function (o) { return organization && o.sharedWithCustomers.indexOf(organization) !== -1; });
    return visible.map(function (o) { return Object.assign({}, o, { sharedWithCustomers: [organization] }); });
  }
  if (accessLevel === 'team_member' || accessLevel === 'admin' || accessLevel === 'super_admin') return items;
  return [];
}

async function handleListScrs(env, origin, accessLevel, organization) {
  const state = await readJsonArrayFile(env, SCRS_FILE_PATH);
  const items = scopeScrs(state.items.map(sanitizeScr), accessLevel, organization);
  return json({ scrs: items }, 200, origin);
}

async function handleCreateScr(request, env, origin, username) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const fields = validateScrFields(body);
  if (!fields.supplierOrg) return json({ message: 'Supplier is required.' }, 400, origin);

  const clientScrNumber = (body.scrNumber !== undefined && body.scrNumber !== null) ? String(body.scrNumber).trim() : '';
  if (clientScrNumber && await scrNumberTaken(env, clientScrNumber, null)) {
    return json({ message: 'That SCR Number is already in use.' }, 409, origin);
  }
  const scrNumber = await reserveScrNumber(env, clientScrNumber);

  const newScr = Object.assign(
    { id: cryptoRandomId(), createdAt: new Date().toISOString(), createdBy: username || '', scrNumber: scrNumber },
    fields
  );

  const result = await mutateJsonArrayFile(env, SCRS_FILE_PATH, function (items) {
    items.push(newScr);
    return { items: items };
  });
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeScr(newScr), 201, origin);
}

async function handleUpdateScr(request, env, origin, id) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const fields = validateScrFields(body);

  let newScrNumber; // undefined = leave as-is
  if (body.scrNumber !== undefined) {
    const requested = (body.scrNumber === null ? '' : String(body.scrNumber)).trim();
    if (!requested) return json({ message: 'SCR Number is required.' }, 400, origin);
    if (await scrNumberTaken(env, requested, id)) {
      return json({ message: 'That SCR Number is already in use.' }, 409, origin);
    }
    newScrNumber = requested;
  }

  let saved = null;
  const result = await mutateJsonArrayFile(env, SCRS_FILE_PATH, function (items) {
    const target = items.find(function (o) { return o.id === id; });
    if (!target) return null;
    Object.assign(target, fields);
    if (newScrNumber !== undefined) target.scrNumber = newScrNumber;
    saved = target;
    return { items: items };
  }, { requireFound: true });

  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeScr(saved), 200, origin);
}

async function handleDeleteScr(env, origin, id) {
  const result = await mutateJsonArrayFile(env, SCRS_FILE_PATH, function (items) {
    const idx = items.findIndex(function (o) { return o.id === id; });
    if (idx === -1) return null;
    items.splice(idx, 1);
    return { items: items };
  }, { requireFound: true });
  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json({ ok: true }, 200, origin);
}

// Used by isContentsPathAllowedForExternal's scr_docs branch. The generated
// SCR Word document (see PDIR_SCR.html) is built entirely client-side from
// the /scrs list response, so there's no server-side PDF/doc route here.
async function resolveScrRecord(env, id) {
  const state = await readJsonArrayFile(env, SCRS_FILE_PATH);
  return state.items.find(function (o) { return o.id === id; }) || null;
}

// ---- Discrepant Material Report (Rev2.18) - "DMR" module: Dessimate
// documents non-conforming material received from a Supplier (Sections 1-6
// and 8), the Supplier responds with root cause/corrective action (Section
// 7). Modeled on Dessimate_Discrepant_Material_Report.xlsx. Reached via its
// own "Discrepant Material Report" sidebar entry -> PDIR_DMRHub.html, which
// (like the Change Requests hub) has a tile per direction; only "Dessimate
// DMRs" (this module) is built so far - "Customer DMRs" is a future module,
// same two-step rollout CR had before SCR.
//
// Permission split is the SAME shape as the CR module (Team Member+ full
// control, a Supplier can touch their own record) but INVERTED which part
// belongs to whom: CR lets a Supplier fill everything except the internal
// Approval section; DMR lets a Supplier touch ONLY Section 7 (Supplier
// Response) - the template's own instruction ("to be completed by
// supplier") - while Team Member+ owns Sections 1-6 and 8. A Supplier can
// never create a DMR (Dessimate documents the discrepancy first), only
// respond to one naming their organization.
const DMRS_FILE_PATH = 'data/dmrs.json';
const DMR_DOC_FOLDER = 'dmr_docs';
const DMR_PHOTOS_MAX = 4;

// DMR Number is formatted "DMR-####" (4 digits, matching the template's
// "DMR-0000" placeholder) - same voluntary/custom-value auto-numbering as
// CR Number/SCR Number.
async function reserveDmrNumber(env, clientDmrNumber) {
  const result = await mutateJsonObjectFile(env, COUNTERS_FILE_PATH, DEFAULT_COUNTERS, function (obj) {
    let dmrNumber;
    if (clientDmrNumber) {
      dmrNumber = clientDmrNumber;
      const m = /^DMR-(\d+)$/i.exec(clientDmrNumber);
      if (m) {
        const seq = Number(m[1]);
        if (seq >= obj.nextDmrNumber) obj.nextDmrNumber = seq + 1;
      }
    } else {
      dmrNumber = 'DMR-' + pad4(obj.nextDmrNumber);
      obj.nextDmrNumber = obj.nextDmrNumber + 1;
    }
    return { obj: obj, meta: { dmrNumber: dmrNumber } };
  });
  if (!result.ok) throw new Error(result.message);
  return result.meta.dmrNumber;
}

async function handlePeekDmrNumber(env, origin) {
  const state = await readJsonObjectFile(env, COUNTERS_FILE_PATH, DEFAULT_COUNTERS);
  return json({ dmrNumber: 'DMR-' + pad4(state.obj.nextDmrNumber) }, 200, origin);
}

async function dmrNumberTaken(env, dmrNumber, excludeId) {
  const state = await readJsonArrayFile(env, DMRS_FILE_PATH);
  const target = String(dmrNumber).toLowerCase();
  return state.items.some(function (o) { return o.id !== excludeId && String(o.dmrNumber).toLowerCase() === target; });
}

// A Photographic Evidence slot - same shape as sanitizeOrgDoc plus a
// caption/location field the template's Section 5 asks for.
function sanitizeDmrPhoto(d) {
  if (!d || !d.path) return null;
  return {
    path: d.path,
    filename: d.filename || '',
    mimeType: d.mimeType || 'application/octet-stream',
    size: typeof d.size === 'number' ? d.size : 0,
    caption: d.caption || '',
    uploadedBy: (d && d.uploadedBy) || '',
    uploadedAt: (d && d.uploadedAt) || null
  };
}
function sanitizeDmrPhotos(list) {
  const arr = Array.isArray(list) ? list : [];
  return arr.map(sanitizeDmrPhoto).filter(Boolean).slice(0, DMR_PHOTOS_MAX);
}

// DMR's general Attachments section - same shape as sanitizeOrgDoc, plus a
// short `comment` field (what the file is about) and `id` preserved
// through (needed intact: the "Generate PDF" button tags its own saved
// copy with a fixed id so re-generating replaces it in place instead of
// appending a duplicate - see PDIR_DMR.html's GENERATED_PDF_ID).
function sanitizeDmrAttachment(d) {
  if (!d || !d.path) return null;
  return {
    id: d.id || null,
    path: d.path,
    filename: d.filename || '',
    mimeType: d.mimeType || 'application/octet-stream',
    size: typeof d.size === 'number' ? d.size : 0,
    comment: d.comment || '',
    uploadedBy: (d && d.uploadedBy) || '',
    uploadedAt: (d && d.uploadedAt) || null
  };
}
function sanitizeDmrAttachments(list) {
  const arr = Array.isArray(list) ? list : [];
  return arr.map(sanitizeDmrAttachment).filter(Boolean).slice(0, PART_ATTACHMENTS_MAX);
}

function sanitizeDmr(o) {
  return {
    id: o.id,
    dmrNumber: o.dmrNumber || '',
    createdAt: o.createdAt || null,
    createdBy: o.createdBy || '',
    // Not part of the original template - added as a short subject line
    // the same way CR's changeTitle/SCR's scrTitle were, staff-only like
    // every other field outside Section 7.
    dmrTitle: o.dmrTitle || '',
    dateIssued: o.dateIssued || '',
    // 1. Supplier Information
    supplierOrg: o.supplierOrg || '',
    supplierContactName: o.supplierContactName || '',
    supplierContactEmail: o.supplierContactEmail || '',
    supplierContactPhone: o.supplierContactPhone || '',
    // 2. Part / Material Information
    partNumber: o.partNumber || '',
    partDescription: o.partDescription || '',
    poNumber: o.poNumber || '',
    lotDateCodes: o.lotDateCodes || '',
    quantityReceived: o.quantityReceived || '',
    quantityDiscrepant: o.quantityDiscrepant || '',
    dateReceived: o.dateReceived || '',
    inspectedBy: o.inspectedBy || '',
    // 3. Discrepancy Type
    discNotCleaned: !!o.discNotCleaned,
    discWrongPart: !!o.discWrongPart,
    discBurrs: !!o.discBurrs,
    discPackaging: !!o.discPackaging,
    discDimensional: !!o.discDimensional,
    discMissingDocs: !!o.discMissingDocs,
    discSurfaceFinish: !!o.discSurfaceFinish,
    discQuantity: !!o.discQuantity,
    discOther: !!o.discOther,
    discOtherDetail: o.discOtherDetail || '',
    // 4. Description of Discrepancy
    descriptionOfDiscrepancy: o.descriptionOfDiscrepancy || '',
    // Supporting documents (not a numbered template section - same
    // standard multi-file attachment pattern as CR/SCR, up to
    // PART_ATTACHMENTS_MAX with uploadedBy/uploadedAt stamping, plus a
    // per-file `comment` - see sanitizeDmrAttachment).
    attachments: sanitizeDmrAttachments(o.attachments),
    // 5. Photographic Evidence
    photos: sanitizeDmrPhotos(o.photos),
    // 6. Disposition Requested
    dispReturnToSupplier: !!o.dispReturnToSupplier,
    dispRework: !!o.dispRework,
    dispUseAsIs: !!o.dispUseAsIs,
    dispScrap: !!o.dispScrap,
    dispSortInspect: !!o.dispSortInspect,
    containmentActionRequired: o.containmentActionRequired || '',
    supplierResponseDueDate: o.supplierResponseDueDate || '',
    // 7. Supplier Response - the only section a Supplier login can write
    rootCause: o.rootCause || '',
    correctiveAction: o.correctiveAction || '',
    supplierSignature: o.supplierSignature || '',
    supplierResponseDate: o.supplierResponseDate || '',
    // 8. Dessimate Review / Closure
    reviewedBy: o.reviewedBy || '',
    status: ['open', 'closed_accepted', 'closed_rejected'].indexOf(o.status) !== -1 ? o.status : '',
    comments: o.comments || ''
  };
}

// Shared by create/update. `isSupplier` keeps ONLY the Section 7 fields
// (Supplier Response) - everything else is silently stripped even if
// present in the request, the inverse of CR's isSupplier strip (which
// keeps everything except Approval).
function validateDmrFields(body, isSupplier) {
  const section7 = {
    rootCause: (body.rootCause || '').toString().trim(),
    correctiveAction: (body.correctiveAction || '').toString().trim(),
    supplierSignature: (body.supplierSignature || '').toString().trim(),
    supplierResponseDate: (body.supplierResponseDate || '').toString().trim()
  };
  if (isSupplier) return section7;
  return Object.assign(section7, {
    dmrTitle: (body.dmrTitle || '').toString().trim(),
    dateIssued: (body.dateIssued || '').toString().trim(),
    supplierContactName: (body.supplierContactName || '').toString().trim(),
    supplierContactEmail: (body.supplierContactEmail || '').toString().trim(),
    supplierContactPhone: (body.supplierContactPhone || '').toString().trim(),
    partNumber: (body.partNumber || '').toString().trim(),
    partDescription: (body.partDescription || '').toString().trim(),
    poNumber: (body.poNumber || '').toString().trim(),
    lotDateCodes: (body.lotDateCodes || '').toString().trim(),
    quantityReceived: (body.quantityReceived || '').toString().trim(),
    quantityDiscrepant: (body.quantityDiscrepant || '').toString().trim(),
    dateReceived: (body.dateReceived || '').toString().trim(),
    inspectedBy: (body.inspectedBy || '').toString().trim(),
    discNotCleaned: !!body.discNotCleaned,
    discWrongPart: !!body.discWrongPart,
    discBurrs: !!body.discBurrs,
    discPackaging: !!body.discPackaging,
    discDimensional: !!body.discDimensional,
    discMissingDocs: !!body.discMissingDocs,
    discSurfaceFinish: !!body.discSurfaceFinish,
    discQuantity: !!body.discQuantity,
    discOther: !!body.discOther,
    discOtherDetail: (body.discOtherDetail || '').toString().trim(),
    descriptionOfDiscrepancy: (body.descriptionOfDiscrepancy || '').toString().trim(),
    attachments: sanitizeDmrAttachments(body.attachments),
    photos: sanitizeDmrPhotos(body.photos),
    dispReturnToSupplier: !!body.dispReturnToSupplier,
    dispRework: !!body.dispRework,
    dispUseAsIs: !!body.dispUseAsIs,
    dispScrap: !!body.dispScrap,
    dispSortInspect: !!body.dispSortInspect,
    containmentActionRequired: (body.containmentActionRequired || '').toString().trim(),
    supplierResponseDueDate: (body.supplierResponseDueDate || '').toString().trim(),
    reviewedBy: (body.reviewedBy || '').toString().trim(),
    status: ['open', 'closed_accepted', 'closed_rejected'].indexOf(body.status) !== -1 ? body.status : '',
    comments: (body.comments || '').toString().trim()
  });
}

// Team Member+ sees every DMR; a Supplier sees only ones naming their own
// organization (same shape as scopeChangeRequests). A Customer login has no
// role in this module.
function scopeDmrs(items, accessLevel, organization) {
  if (accessLevel === 'supplier') {
    return items.filter(function (o) { return organization && o.supplierOrg === organization; });
  }
  if (accessLevel === 'customer') return [];
  return items;
}

async function handleListDmrs(env, origin, accessLevel, organization) {
  const state = await readJsonArrayFile(env, DMRS_FILE_PATH);
  const items = scopeDmrs(state.items.map(sanitizeDmr), accessLevel, organization);
  return json({ dmrs: items }, 200, origin);
}

// Staff-only - a Supplier never creates a DMR, only responds to one (see
// the module comment above).
async function handleCreateDmr(request, env, origin, username) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const fields = validateDmrFields(body, false);

  const supplierOrg = (body.supplierOrg || '').toString().trim();
  if (!supplierOrg) return json({ message: 'Supplier is required.' }, 400, origin);

  const clientDmrNumber = (body.dmrNumber !== undefined && body.dmrNumber !== null) ? String(body.dmrNumber).trim() : '';
  if (clientDmrNumber && await dmrNumberTaken(env, clientDmrNumber, null)) {
    return json({ message: 'That DMR Number is already in use.' }, 409, origin);
  }
  const dmrNumber = await reserveDmrNumber(env, clientDmrNumber);

  const newDmr = Object.assign(
    { id: cryptoRandomId(), createdAt: new Date().toISOString(), createdBy: username || '', dmrNumber: dmrNumber, supplierOrg: supplierOrg },
    fields
  );

  const result = await mutateJsonArrayFile(env, DMRS_FILE_PATH, function (items) {
    items.push(newDmr);
    return { items: items };
  });
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeDmr(newDmr), 201, origin);
}

async function handleUpdateDmr(request, env, origin, id, accessLevel, username) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const isSupplier = accessLevel === 'supplier';
  const fields = validateDmrFields(body, isSupplier);

  let callerOrg = '';
  if (isSupplier) {
    callerOrg = await resolveUserOrganization(env, username);
    if (!callerOrg) return json({ message: 'Your account isn’t linked to a Supplier organization.' }, 403, origin);
  }

  let newDmrNumber; // undefined = leave as-is
  if (body.dmrNumber !== undefined) {
    if (isSupplier) return json({ message: 'Only Dessimate staff can change the DMR Number.' }, 403, origin);
    const requested = (body.dmrNumber === null ? '' : String(body.dmrNumber)).trim();
    if (!requested) return json({ message: 'DMR Number is required.' }, 400, origin);
    if (await dmrNumberTaken(env, requested, id)) {
      return json({ message: 'That DMR Number is already in use.' }, 409, origin);
    }
    newDmrNumber = requested;
  }

  let saved = null;
  const result = await mutateJsonArrayFile(env, DMRS_FILE_PATH, function (items) {
    const target = items.find(function (o) { return o.id === id; });
    if (!target) return null;
    if (isSupplier && target.supplierOrg !== callerOrg) return null; // 404s below rather than 403 - don't reveal existence
    if (!isSupplier && body.supplierOrg !== undefined) {
      const requestedOrg = (body.supplierOrg || '').toString().trim();
      if (requestedOrg) target.supplierOrg = requestedOrg;
    }
    Object.assign(target, fields); // a Supplier's `fields` only ever has the Section 7 keys
    if (newDmrNumber !== undefined) target.dmrNumber = newDmrNumber;
    saved = target;
    return { items: items };
  }, { requireFound: true });

  if (result === 'not-found' || !saved) return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeDmr(saved), 200, origin);
}

async function handleDeleteDmr(env, origin, id) {
  const result = await mutateJsonArrayFile(env, DMRS_FILE_PATH, function (items) {
    const idx = items.findIndex(function (o) { return o.id === id; });
    if (idx === -1) return null;
    items.splice(idx, 1);
    return { items: items };
  }, { requireFound: true });
  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json({ ok: true }, 200, origin);
}

// Used by isContentsPathAllowedForExternal's dmr_docs branch and the PDF
// route's Supplier ownership check - same shape as resolveChangeRequestRecord.
async function resolveDmrRecord(env, id) {
  const state = await readJsonArrayFile(env, DMRS_FILE_PATH);
  return state.items.find(function (o) { return o.id === id; }) || null;
}

// Single-page rendering of the Dessimate_Discrepant_Material_Report.xlsx
// layout - same drawn-from-scratch pdf-lib approach as buildCrPdf (this repo
// has no tooling to fill an actual .xlsx template). `photoDocs` is an array
// of raw {bytes, mimeType} (or null), parallel to dmr.photos, already read
// from R2 by the caller but NOT YET embedded - embedding has to happen
// against this function's own pdfDoc, same as buildCrPdf's
// currentConditionDoc/newConditionDoc. When any photo is present, a second
// page is appended as a 2x2 photo-evidence grid with captions; otherwise
// the DMR is one page.
async function buildDmrPdf(dmr, photoDocs) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  async function embedImageDoc(doc) {
    if (!doc || !doc.bytes) return null;
    try {
      return (doc.mimeType === 'image/png') ? await pdfDoc.embedPng(doc.bytes) : await pdfDoc.embedJpg(doc.bytes);
    } catch (e) { return null; }
  }
  const photoImages = [];
  for (let pi = 0; pi < 4; pi++) photoImages.push(await embedImageDoc(photoDocs && photoDocs[pi]));

  const pageWidth = 612, pageHeight = 792; // US Letter
  const margin = 44;
  const contentW = pageWidth - margin * 2;

  const brandBlue = rgb(0.106, 0.243, 0.706);
  const ink = rgb(0.1, 0.1, 0.12);
  const labelGray = rgb(0.42, 0.44, 0.49);
  const lineGray = rgb(0.85, 0.86, 0.89);
  const sectionBg = rgb(0.925, 0.941, 0.976);

  const page = pdfDoc.addPage([pageWidth, pageHeight]);

  let logoImg = null;
  try { logoImg = await pdfDoc.embedJpg(base64ToBytes(DESSIMATE_LOGO_JPG_BASE64)); } catch (e) { logoImg = null; }

  function leftText(str, x, yy, size, opts) {
    opts = opts || {};
    page.drawText(str == null ? '' : String(str), { x: x, y: yy, size: size, font: opts.bold ? fontBold : font, color: opts.color || ink });
  }
  function rightText(str, rightEdgeX, yy, size, opts) {
    opts = opts || {};
    const f = opts.bold ? fontBold : font;
    const s = str == null ? '' : String(str);
    page.drawText(s, { x: rightEdgeX - f.widthOfTextAtSize(s, size), y: yy, size: size, font: f, color: opts.color || ink });
  }
  function wrapLines(str, maxWidth, size, useFont) {
    const f = useFont || font;
    const out = [];
    (str || '').split(/\r?\n/).forEach(function (raw) {
      const words = raw.split(/\s+/).filter(Boolean);
      if (!words.length) { out.push(''); return; }
      let cur = '';
      words.forEach(function (w) {
        const attempt = cur ? cur + ' ' + w : w;
        if (cur && f.widthOfTextAtSize(attempt, size) > maxWidth) { out.push(cur); cur = w; }
        else cur = attempt;
      });
      if (cur) out.push(cur);
    });
    return out;
  }
  function fmtDateMDY(s) {
    const str = (s || '').toString().trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
    return m ? (m[2] + '/' + m[3] + '/' + m[1]) : str;
  }
  function checkbox(x, yy, checked, label, opts) {
    opts = opts || {};
    const size = 9;
    page.drawRectangle({ x: x, y: yy, width: size, height: size, borderColor: ink, borderWidth: 1, color: checked ? ink : rgb(1, 1, 1) });
    leftText(label, x + size + 5, yy + 1, opts.size || 9, { bold: opts.bold });
  }
  function sectionHeader(label, x, yy, w) {
    page.drawRectangle({ x: x, y: yy - 14, width: w, height: 16, color: sectionBg });
    leftText(label, x + 6, yy - 10, 9.5, { bold: true, color: brandBlue });
  }

  // ---- Header: logo + title, DMR Number / Date Issued ------------------------
  let hy = pageHeight - 40;
  if (logoImg) {
    const dims = logoImg.scaleToFit(108, 60);
    page.drawImage(logoImg, { x: margin, y: hy - dims.height, width: dims.width, height: dims.height });
  } else {
    leftText('Dessimate', margin, hy - 14, 16, { bold: true, color: brandBlue });
  }
  rightText('DISCREPANT MATERIAL REPORT (DMR)', pageWidth - margin, hy - 16, 15, { bold: true, color: brandBlue });
  rightText('DMR #: ' + (dmr.dmrNumber || ''), pageWidth - margin, hy - 34, 10.5, { bold: true });
  rightText('Date Issued: ' + fmtDateMDY(dmr.dateIssued), pageWidth - margin, hy - 48, 10);

  let y = hy - 78;

  // DMR Title - not part of the original .xlsx template, added per request
  // as a prominent "subject line" the same way CR's changeTitle was.
  if (dmr.dmrTitle) {
    const titleLines = wrapLines(dmr.dmrTitle, contentW, 13, fontBold).slice(0, 2);
    titleLines.forEach(function (line) { leftText(line, margin, y, 13, { bold: true, color: ink }); y -= 16; });
    y -= 8;
  }

  // ---- 1. Supplier Information -------------------------------------------------
  const colW = contentW / 2 - 6;
  const col2x = margin + contentW / 2 + 6;
  sectionHeader('1. SUPPLIER INFORMATION', margin, y, contentW);
  y -= 20;
  leftText('Supplier Name:', margin, y, 8.5, { bold: true, color: labelGray });
  leftText(dmr.supplierOrg || '—', margin + 90, y, 9.5);
  leftText('Contact:', col2x, y, 8.5, { bold: true, color: labelGray });
  leftText(dmr.supplierContactName || '—', col2x + 50, y, 9.5);
  y -= 16;
  leftText('Contact Email:', margin, y, 8.5, { bold: true, color: labelGray });
  leftText(dmr.supplierContactEmail || '—', margin + 90, y, 9.5);
  leftText('Contact Phone:', col2x, y, 8.5, { bold: true, color: labelGray });
  leftText(dmr.supplierContactPhone || '—', col2x + 78, y, 9.5);
  y -= 22;

  // ---- 2. Part / Material Information --------------------------------------------
  sectionHeader('2. PART / MATERIAL INFORMATION', margin, y, contentW);
  y -= 20;
  function fieldPair(labelA, valueA, labelB, valueB) {
    leftText(labelA, margin, y, 8.5, { bold: true, color: labelGray });
    leftText(valueA || '—', margin + 92, y, 9.5);
    leftText(labelB, col2x, y, 8.5, { bold: true, color: labelGray });
    leftText(valueB || '—', col2x + 92, y, 9.5);
    y -= 16;
  }
  fieldPair('Part Number:', dmr.partNumber, 'Part Description:', dmr.partDescription);
  fieldPair('Purchase Order #:', dmr.poNumber, 'Lot / Date Code(s):', dmr.lotDateCodes);
  fieldPair('Quantity Received:', dmr.quantityReceived, 'Quantity Discrepant:', dmr.quantityDiscrepant);
  fieldPair('Date Received:', fmtDateMDY(dmr.dateReceived), 'Inspected By:', dmr.inspectedBy);
  y -= 6;

  // ---- 3. Discrepancy Type ---------------------------------------------------------
  sectionHeader('3. DISCREPANCY TYPE (check all that apply)', margin, y, contentW);
  y -= 20;
  const discColW = contentW / 4;
  const discTypes = [
    ['Not Cleaned / Contamination', dmr.discNotCleaned], ['Wrong Part / Mismatch', dmr.discWrongPart],
    ['Burrs / Sharp Edges', dmr.discBurrs], ['Packaging Damage', dmr.discPackaging],
    ['Dimensional Out of Spec', dmr.discDimensional], ['Missing / Incorrect Documentation', dmr.discMissingDocs],
    ['Surface Finish / Scratches', dmr.discSurfaceFinish], ['Quantity Shortage / Overage', dmr.discQuantity]
  ];
  for (let i = 0; i < discTypes.length; i += 2) {
    checkbox(margin, y, discTypes[i][1], discTypes[i][0], { size: 8 });
    if (discTypes[i + 1]) checkbox(margin + discColW * 2, y, discTypes[i + 1][1], discTypes[i + 1][0], { size: 8 });
    y -= 15;
  }
  checkbox(margin, y, dmr.discOther, 'Other: ' + (dmr.discOther && dmr.discOtherDetail ? dmr.discOtherDetail : ''), { size: 8 });
  y -= 22;

  // ---- 4. Description of Discrepancy -----------------------------------------------
  sectionHeader('4. DESCRIPTION OF DISCREPANCY', margin, y, contentW);
  y -= 18;
  const descLines = wrapLines(dmr.descriptionOfDiscrepancy, contentW - 12, 9.5);
  const descShown = (descLines.length ? descLines : ['']).slice(0, 3);
  descShown.forEach(function (l) { leftText(l, margin + 6, y, 9.5); y -= 12; });
  y -= 4;
  if (dmr.attachments && dmr.attachments.length) {
    const attLine = 'Attachments: ' + dmr.attachments.map(function (a) { return a.filename; }).join(', ');
    wrapLines(attLine, contentW, 8).slice(0, 2).forEach(function (l) { leftText(l, margin, y, 8, { color: labelGray }); y -= 11; });
  }
  if (dmr.photos && dmr.photos.length) {
    leftText('Photographic evidence: ' + dmr.photos.length + ' photo' + (dmr.photos.length === 1 ? '' : 's') + ' attached (see page 2).', margin, y, 8, { color: labelGray });
    y -= 16;
  } else {
    y -= 4;
  }

  // ---- 6. Disposition Requested -----------------------------------------------------
  sectionHeader('6. DISPOSITION REQUESTED', margin, y, contentW);
  y -= 20;
  checkbox(margin, y, dmr.dispReturnToSupplier, 'Return to Supplier', { size: 8.5 });
  checkbox(margin + 150, y, dmr.dispRework, 'Rework at Supplier', { size: 8.5 });
  checkbox(margin + 300, y, dmr.dispScrap, 'Scrap', { size: 8.5 });
  y -= 15;
  checkbox(margin, y, dmr.dispUseAsIs, 'Use As-Is (Dessimate Approval Required)', { size: 8.5 });
  checkbox(margin + 300, y, dmr.dispSortInspect, 'Sort & 100% Inspect at Dessimate', { size: 8.5 });
  y -= 18;
  leftText('Interim Corrective Action (ICA):', margin, y, 8.5, { bold: true, color: labelGray });
  y -= 12;
  wrapLines(dmr.containmentActionRequired, contentW - 6, 9.5).slice(0, 2).forEach(function (l) { leftText(l, margin + 6, y, 9.5); y -= 12; });
  leftText('Supplier Response Due:', margin, y, 8.5, { bold: true, color: labelGray });
  leftText(fmtDateMDY(dmr.supplierResponseDueDate) || '—', margin + 135, y, 9.5);
  y -= 22;

  // ---- 7. Supplier Response ----------------------------------------------------------
  sectionHeader('7. SUPPLIER RESPONSE (to be completed by supplier)', margin, y, contentW);
  y -= 18;
  leftText('Root Cause:', margin, y, 8.5, { bold: true, color: labelGray });
  y -= 11;
  wrapLines(dmr.rootCause, contentW - 12, 9.5).slice(0, 2).forEach(function (l) { leftText(l, margin + 6, y, 9.5); y -= 12; });
  y -= 4;
  leftText('Permanent Corrective Action (PCA):', margin, y, 8.5, { bold: true, color: labelGray });
  y -= 11;
  wrapLines(dmr.correctiveAction, contentW - 12, 9.5).slice(0, 2).forEach(function (l) { leftText(l, margin + 6, y, 9.5); y -= 12; });
  y -= 6;
  leftText('Supplier Signature / Print Name:', margin, y, 8, { bold: true, color: labelGray });
  page.drawLine({ start: { x: margin, y: y - 14 }, end: { x: margin + 260, y: y - 14 }, thickness: 0.75, color: lineGray });
  leftText(dmr.supplierSignature || '', margin, y - 12, 9.5);
  leftText('Date:', margin + 300, y, 8, { bold: true, color: labelGray });
  page.drawLine({ start: { x: margin + 300, y: y - 14 }, end: { x: margin + 420, y: y - 14 }, thickness: 0.75, color: lineGray });
  leftText(fmtDateMDY(dmr.supplierResponseDate) || '', margin + 300, y - 12, 9.5);
  y -= 32;

  // ---- 8. Dessimate Review / Closure --------------------------------------------------
  sectionHeader('8. DESSIMATE REVIEW / CLOSURE', margin, y, contentW);
  y -= 20;
  leftText('Reviewed By:', margin, y, 8.5, { bold: true, color: labelGray });
  leftText(dmr.reviewedBy || '—', margin + 80, y, 9.5);
  checkbox(col2x, y - 1, dmr.status === 'open', 'Open', { size: 8.5 });
  checkbox(col2x + 60, y - 1, dmr.status === 'closed_accepted', 'Closed - Accepted', { size: 8.5 });
  checkbox(col2x + 190, y - 1, dmr.status === 'closed_rejected', 'Closed - Rejected', { size: 8.5 });
  y -= 18;
  leftText('Comments:', margin, y, 8.5, { bold: true, color: labelGray });
  y -= 11;
  wrapLines(dmr.comments, contentW - 12, 9.5).slice(0, 3).forEach(function (l) { leftText(l, margin + 6, y, 9.5); y -= 12; });

  // ---- Footer -------------------------------------------------------------------
  leftText('Dessimate – Discrepant Material Report – Form QF-DMR-01, Rev. A', margin, 26, 7.5, { color: labelGray });

  // ---- Page 2: Photographic Evidence (only when at least one photo exists) -----
  const photos = Array.isArray(dmr.photos) ? dmr.photos : [];
  if (photos.length) {
    const page2 = pdfDoc.addPage([pageWidth, pageHeight]);
    function leftText2(str, x, yy, size, opts) {
      opts = opts || {};
      page2.drawText(str == null ? '' : String(str), { x: x, y: yy, size: size, font: opts.bold ? fontBold : font, color: opts.color || ink });
    }
    page2.drawRectangle({ x: margin, y: pageHeight - 40 - 16, width: contentW, height: 16, color: sectionBg });
    leftText2('5. PHOTOGRAPHIC EVIDENCE — DMR ' + (dmr.dmrNumber || ''), margin + 6, pageHeight - 40 - 12, 9.5, { bold: true, color: brandBlue });
    const gridTop = pageHeight - 40 - 34;
    const gap = 16;
    const boxW = (contentW - gap) / 2;
    const boxH = 300;
    for (let i = 0; i < 4; i++) {
      const col = i % 2, row = Math.floor(i / 2);
      const bx = margin + col * (boxW + gap);
      const by = gridTop - boxH - row * (boxH + 34) - row * gap;
      page2.drawRectangle({ x: bx, y: by, width: boxW, height: boxH, borderColor: lineGray, borderWidth: 1 });
      const photo = photos[i];
      const img = photoImages && photoImages[i];
      leftText2('Photo ' + (i + 1), bx + 6, by + boxH - 14, 8.5, { bold: true, color: labelGray });
      if (img) {
        const pad = 8, maxW = boxW - pad * 2, maxH = boxH - 26;
        const dims = img.scaleToFit(maxW, maxH);
        page2.drawImage(img, { x: bx + (boxW - dims.width) / 2, y: by + 18 + (maxH - dims.height) / 2, width: dims.width, height: dims.height });
      } else {
        leftText2('No photo attached.', bx + 6, by + boxH / 2, 9, { color: labelGray });
      }
      if (photo && photo.caption) {
        leftText2(photo.caption, bx + 6, by - 12, 8, { color: labelGray });
      }
    }
  }

  return pdfDoc.save();
}

async function handleGetDmrPdf(env, origin, id, accessLevel, organization) {
  const raw = await resolveDmrRecord(env, id);
  if (!raw) return json({ message: 'Not found.' }, 404, origin);
  let clean = sanitizeDmr(raw);
  const scoped = scopeDmrs([clean], accessLevel, organization);
  if (!scoped.length) return json({ message: 'Not found.' }, 404, origin);
  clean = scoped[0];

  async function loadImageDoc(doc) {
    if (!doc || !doc.path) return null;
    try {
      const bytes = await readGithubFileBytes(env, doc.path);
      return bytes ? { bytes: bytes, mimeType: doc.mimeType } : null;
    } catch (e) { return null; }
  }

  let pdfBytes;
  try {
    const photoDocs = [];
    for (let i = 0; i < clean.photos.length; i++) photoDocs.push(await loadImageDoc(clean.photos[i]));
    pdfBytes = await buildDmrPdf(clean, photoDocs);
  } catch (e) {
    return json({ message: 'Could not generate PDF: ' + (e && e.message ? e.message : e) }, 500, origin);
  }
  return pdfResponse(pdfBytes, 'DMR ' + clean.dmrNumber + '.pdf', origin);
}

// ---- Customer DMR (Rev2.19) - the mirror image of the DMR module above:
// a Customer reports non-conforming material back to Dessimate, so
// Dessimate is the "Supplier" here (Section 1 is always Dessimate's own
// identity) and a Customer organization is the one the record is scoped
// to. Sections 1-7 (including Section 7 "Supplier Response," since
// Dessimate is the supplier) are Team Member+ only, same asymmetric
// ownership shape as DMR's Supplier/Section-7 carve-out - just Section 8
// ("Customer Review/Closure" here, vs. "Dessimate Review/Closure" in DMR)
// is the one section a Customer login can touch, and even there Team
// Member+ retains full access too (never exclusive - see
// validateCustomerDmrFields). No auto-numbering: the Customer supplies
// their own DMR Number from their own system, so it's a required,
// uniqueness-checked field instead of a counter-assigned one. The
// Section 8 comment thread ("capture who wrote what comment when") is
// managed entirely through its own POST .../comments route, never the
// generic PUT, so neither party can edit or delete another's past entry
// by resending a modified array.
const CUSTOMER_DMRS_FILE_PATH = 'data/customer_dmrs.json';
const CUSTOMER_DMR_DOC_FOLDER = 'customer_dmr_docs';
const CUSTOMER_DMR_PHOTOS_MAX = 4;

async function customerDmrNumberTaken(env, dmrNumber, excludeId) {
  const state = await readJsonArrayFile(env, CUSTOMER_DMRS_FILE_PATH);
  const target = String(dmrNumber).toLowerCase();
  return state.items.some(function (o) { return o.id !== excludeId && String(o.dmrNumber).toLowerCase() === target; });
}

function sanitizeCustomerDmrPhoto(d) {
  if (!d || !d.path) return null;
  return {
    path: d.path,
    filename: d.filename || '',
    mimeType: d.mimeType || 'application/octet-stream',
    size: typeof d.size === 'number' ? d.size : 0,
    caption: d.caption || '',
    uploadedBy: (d && d.uploadedBy) || '',
    uploadedAt: (d && d.uploadedAt) || null
  };
}
function sanitizeCustomerDmrPhotos(list) {
  const arr = Array.isArray(list) ? list : [];
  return arr.map(sanitizeCustomerDmrPhoto).filter(Boolean).slice(0, CUSTOMER_DMR_PHOTOS_MAX);
}

function sanitizeCustomerDmrAttachment(d) {
  if (!d || !d.path) return null;
  return {
    id: d.id || null,
    path: d.path,
    filename: d.filename || '',
    mimeType: d.mimeType || 'application/octet-stream',
    size: typeof d.size === 'number' ? d.size : 0,
    comment: d.comment || '',
    uploadedBy: (d && d.uploadedBy) || '',
    uploadedAt: (d && d.uploadedAt) || null
  };
}
function sanitizeCustomerDmrAttachments(list) {
  const arr = Array.isArray(list) ? list : [];
  return arr.map(sanitizeCustomerDmrAttachment).filter(Boolean).slice(0, PART_ATTACHMENTS_MAX);
}

// One entry in Section 8's comment thread - append-only, written only by
// appendCustomerDmrComment below, never by the generic PUT.
function sanitizeCustomerDmrComment(c) {
  if (!c) return null;
  return {
    id: c.id || cryptoRandomId(),
    authorUsername: c.authorUsername || '',
    text: c.text || '',
    createdAt: c.createdAt || null
  };
}
function sanitizeCustomerDmrComments(list) {
  const arr = Array.isArray(list) ? list : [];
  return arr.map(sanitizeCustomerDmrComment).filter(Boolean);
}

function sanitizeCustomerDmr(o) {
  return {
    id: o.id,
    dmrNumber: o.dmrNumber || '',
    createdAt: o.createdAt || null,
    createdBy: o.createdBy || '',
    dmrTitle: o.dmrTitle || '',
    dateIssued: o.dateIssued || '',
    // Which Customer organization reported this - staff-set only (never
    // touched by a Customer's own save), used for scoping/ownership.
    customerOrg: o.customerOrg || '',
    // 1. Supplier Information - always Dessimate itself, coerced
    // server-side regardless of what's submitted (never trust the client
    // for a fixed identity field, same principle as SCR's locked Supplier
    // dropdown).
    supplierOrg: 'Dessimate',
    supplierContactName: o.supplierContactName || '',
    supplierContactEmail: o.supplierContactEmail || '',
    supplierContactPhone: o.supplierContactPhone || '',
    // 2. Part / Material Information
    partNumber: o.partNumber || '',
    partDescription: o.partDescription || '',
    poNumber: o.poNumber || '',
    lotDateCodes: o.lotDateCodes || '',
    quantityReceived: o.quantityReceived || '',
    quantityDiscrepant: o.quantityDiscrepant || '',
    dateReceived: o.dateReceived || '',
    inspectedBy: o.inspectedBy || '',
    // 3. Discrepancy Type
    discNotCleaned: !!o.discNotCleaned,
    discWrongPart: !!o.discWrongPart,
    discBurrs: !!o.discBurrs,
    discPackaging: !!o.discPackaging,
    discDimensional: !!o.discDimensional,
    discMissingDocs: !!o.discMissingDocs,
    discSurfaceFinish: !!o.discSurfaceFinish,
    discQuantity: !!o.discQuantity,
    discOther: !!o.discOther,
    discOtherDetail: o.discOtherDetail || '',
    // 4. Description of Discrepancy
    descriptionOfDiscrepancy: o.descriptionOfDiscrepancy || '',
    attachments: sanitizeCustomerDmrAttachments(o.attachments),
    // 5. Photographic Evidence
    photos: sanitizeCustomerDmrPhotos(o.photos),
    // 6. Disposition Requested
    dispReturnToSupplier: !!o.dispReturnToSupplier,
    dispRework: !!o.dispRework,
    dispUseAsIs: !!o.dispUseAsIs,
    dispScrap: !!o.dispScrap,
    dispSortInspect: !!o.dispSortInspect,
    containmentActionRequired: o.containmentActionRequired || '',
    supplierResponseDueDate: o.supplierResponseDueDate || '',
    // 7. Supplier Response - Dessimate staff fills this in (Dessimate is
    // the supplier being responded on behalf of), Team Member+ only.
    rootCause: o.rootCause || '',
    correctiveAction: o.correctiveAction || '',
    supplierSignature: o.supplierSignature || '',
    supplierResponseDate: o.supplierResponseDate || '',
    // 8. Customer Review / Closure - the only section a Customer login can
    // write (reviewedBy/status); Team Member+ can write it too, never
    // exclusive. reviewComments is append-only - see appendCustomerDmrComment.
    reviewedBy: o.reviewedBy || '',
    status: ['open', 'closed_accepted', 'closed_rejected'].indexOf(o.status) !== -1 ? o.status : '',
    reviewComments: sanitizeCustomerDmrComments(o.reviewComments)
  };
}

// Shared by create/update. `isCustomer` keeps ONLY Section 8's
// reviewedBy/status - everything else is silently stripped even if
// present, same inverted-strip pattern as DMR's validateDmrFields.
// reviewComments is never accepted here at all (see the module comment
// above) - it only ever changes via appendCustomerDmrComment.
function validateCustomerDmrFields(body, isCustomer) {
  const section8 = {
    reviewedBy: (body.reviewedBy || '').toString().trim(),
    status: ['open', 'closed_accepted', 'closed_rejected'].indexOf(body.status) !== -1 ? body.status : ''
  };
  if (isCustomer) return section8;
  return Object.assign(section8, {
    dmrTitle: (body.dmrTitle || '').toString().trim(),
    dateIssued: (body.dateIssued || '').toString().trim(),
    customerOrg: (body.customerOrg || '').toString().trim(),
    supplierContactName: (body.supplierContactName || '').toString().trim(),
    supplierContactEmail: (body.supplierContactEmail || '').toString().trim(),
    supplierContactPhone: (body.supplierContactPhone || '').toString().trim(),
    partNumber: (body.partNumber || '').toString().trim(),
    partDescription: (body.partDescription || '').toString().trim(),
    poNumber: (body.poNumber || '').toString().trim(),
    lotDateCodes: (body.lotDateCodes || '').toString().trim(),
    quantityReceived: (body.quantityReceived || '').toString().trim(),
    quantityDiscrepant: (body.quantityDiscrepant || '').toString().trim(),
    dateReceived: (body.dateReceived || '').toString().trim(),
    inspectedBy: (body.inspectedBy || '').toString().trim(),
    discNotCleaned: !!body.discNotCleaned,
    discWrongPart: !!body.discWrongPart,
    discBurrs: !!body.discBurrs,
    discPackaging: !!body.discPackaging,
    discDimensional: !!body.discDimensional,
    discMissingDocs: !!body.discMissingDocs,
    discSurfaceFinish: !!body.discSurfaceFinish,
    discQuantity: !!body.discQuantity,
    discOther: !!body.discOther,
    discOtherDetail: (body.discOtherDetail || '').toString().trim(),
    descriptionOfDiscrepancy: (body.descriptionOfDiscrepancy || '').toString().trim(),
    attachments: sanitizeCustomerDmrAttachments(body.attachments),
    photos: sanitizeCustomerDmrPhotos(body.photos),
    dispReturnToSupplier: !!body.dispReturnToSupplier,
    dispRework: !!body.dispRework,
    dispUseAsIs: !!body.dispUseAsIs,
    dispScrap: !!body.dispScrap,
    dispSortInspect: !!body.dispSortInspect,
    containmentActionRequired: (body.containmentActionRequired || '').toString().trim(),
    supplierResponseDueDate: (body.supplierResponseDueDate || '').toString().trim(),
    rootCause: (body.rootCause || '').toString().trim(),
    correctiveAction: (body.correctiveAction || '').toString().trim(),
    supplierSignature: (body.supplierSignature || '').toString().trim(),
    supplierResponseDate: (body.supplierResponseDate || '').toString().trim()
  });
}

// Team Member+ sees every Customer DMR; a Customer sees only ones naming
// their own organization. A Supplier login has no role in this module.
function scopeCustomerDmrs(items, accessLevel, organization) {
  if (accessLevel === 'customer') {
    return items.filter(function (o) { return organization && o.customerOrg === organization; });
  }
  if (accessLevel === 'supplier') return [];
  return items;
}

async function handleListCustomerDmrs(env, origin, accessLevel, organization) {
  const state = await readJsonArrayFile(env, CUSTOMER_DMRS_FILE_PATH);
  const items = scopeCustomerDmrs(state.items.map(sanitizeCustomerDmr), accessLevel, organization);
  return json({ customerDmrs: items }, 200, origin);
}

// Staff-only - a Customer never creates a Customer DMR, only reviews/closes
// one (see the module comment above).
async function handleCreateCustomerDmr(request, env, origin, username) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const fields = validateCustomerDmrFields(body, false);
  if (!fields.customerOrg) return json({ message: 'Customer Organization is required.' }, 400, origin);

  const dmrNumber = (body.dmrNumber || '').toString().trim();
  if (!dmrNumber) return json({ message: 'DMR Number is required.' }, 400, origin);
  if (await customerDmrNumberTaken(env, dmrNumber, null)) {
    return json({ message: 'That DMR Number is already in use.' }, 409, origin);
  }

  const newDmr = Object.assign(
    { id: cryptoRandomId(), createdAt: new Date().toISOString(), createdBy: username || '', dmrNumber: dmrNumber, reviewComments: [] },
    fields
  );

  const result = await mutateJsonArrayFile(env, CUSTOMER_DMRS_FILE_PATH, function (items) {
    items.push(newDmr);
    return { items: items };
  });
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeCustomerDmr(newDmr), 201, origin);
}

async function handleUpdateCustomerDmr(request, env, origin, id, accessLevel, username) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const isCustomer = accessLevel === 'customer';
  const fields = validateCustomerDmrFields(body, isCustomer);

  let callerOrg = '';
  if (isCustomer) {
    callerOrg = await resolveUserOrganization(env, username);
    if (!callerOrg) return json({ message: 'Your account isn’t linked to a Customer organization.' }, 403, origin);
  }

  let newDmrNumber; // undefined = leave as-is
  if (body.dmrNumber !== undefined) {
    if (isCustomer) return json({ message: 'Only Dessimate staff can change the DMR Number.' }, 403, origin);
    const requested = (body.dmrNumber === null ? '' : String(body.dmrNumber)).trim();
    if (!requested) return json({ message: 'DMR Number is required.' }, 400, origin);
    if (await customerDmrNumberTaken(env, requested, id)) {
      return json({ message: 'That DMR Number is already in use.' }, 409, origin);
    }
    newDmrNumber = requested;
  }

  let saved = null;
  const result = await mutateJsonArrayFile(env, CUSTOMER_DMRS_FILE_PATH, function (items) {
    const target = items.find(function (o) { return o.id === id; });
    if (!target) return null;
    if (isCustomer && target.customerOrg !== callerOrg) return null; // 404s below rather than 403 - don't reveal existence
    Object.assign(target, fields); // a Customer's `fields` only ever has reviewedBy/status
    if (newDmrNumber !== undefined) target.dmrNumber = newDmrNumber;
    saved = target;
    return { items: items };
  }, { requireFound: true });

  if (result === 'not-found' || !saved) return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeCustomerDmr(saved), 200, origin);
}

async function handleDeleteCustomerDmr(env, origin, id) {
  const result = await mutateJsonArrayFile(env, CUSTOMER_DMRS_FILE_PATH, function (items) {
    const idx = items.findIndex(function (o) { return o.id === id; });
    if (idx === -1) return null;
    items.splice(idx, 1);
    return { items: items };
  }, { requireFound: true });
  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json({ ok: true }, 200, origin);
}

// Section 8's comment thread - the only way reviewComments ever changes.
// Team Member+ can comment on any Customer DMR; a Customer can comment
// only on one naming their own organization. Appends and returns the full
// updated record; there is no edit/delete route, by design (see the
// module comment above).
async function handleAddCustomerDmrComment(request, env, origin, id, accessLevel, username) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const text = (body.text || '').toString().trim();
  if (!text) return json({ message: 'Comment text is required.' }, 400, origin);

  const isCustomer = accessLevel === 'customer';
  let callerOrg = '';
  if (isCustomer) {
    callerOrg = await resolveUserOrganization(env, username);
    if (!callerOrg) return json({ message: 'Your account isn’t linked to a Customer organization.' }, 403, origin);
  }

  const comment = { id: cryptoRandomId(), authorUsername: username || '', text: text, createdAt: new Date().toISOString() };

  let saved = null;
  const result = await mutateJsonArrayFile(env, CUSTOMER_DMRS_FILE_PATH, function (items) {
    const target = items.find(function (o) { return o.id === id; });
    if (!target) return null;
    if (isCustomer && target.customerOrg !== callerOrg) return null;
    target.reviewComments = Array.isArray(target.reviewComments) ? target.reviewComments : [];
    target.reviewComments.push(comment);
    saved = target;
    return { items: items };
  }, { requireFound: true });

  if (result === 'not-found' || !saved) return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeCustomerDmr(saved), 200, origin);
}

async function resolveCustomerDmrRecord(env, id) {
  const state = await readJsonArrayFile(env, CUSTOMER_DMRS_FILE_PATH);
  return state.items.find(function (o) { return o.id === id; }) || null;
}

// Single-page rendering of the same layout as buildDmrPdf, with Section 1
// always showing Dessimate's own identity and Section 8 relabeled/rendered
// as a comment thread instead of one free-text block. See that function
// for the shared helper definitions (kept in sync deliberately - this repo
// has no shared-partial mechanism for pdf-lib layouts, same as every other
// PDF builder here).
async function buildCustomerDmrPdf(dmr, photoDocs) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  async function embedImageDoc(doc) {
    if (!doc || !doc.bytes) return null;
    try {
      return (doc.mimeType === 'image/png') ? await pdfDoc.embedPng(doc.bytes) : await pdfDoc.embedJpg(doc.bytes);
    } catch (e) { return null; }
  }
  const photoImages = [];
  for (let pi = 0; pi < CUSTOMER_DMR_PHOTOS_MAX; pi++) photoImages.push(await embedImageDoc(photoDocs && photoDocs[pi]));

  const pageWidth = 612, pageHeight = 792; // US Letter
  const margin = 44;
  const contentW = pageWidth - margin * 2;

  const brandBlue = rgb(0.106, 0.243, 0.706);
  const ink = rgb(0.1, 0.1, 0.12);
  const labelGray = rgb(0.42, 0.44, 0.49);
  const lineGray = rgb(0.85, 0.86, 0.89);
  const sectionBg = rgb(0.925, 0.941, 0.976);

  const page = pdfDoc.addPage([pageWidth, pageHeight]);

  let logoImg = null;
  try { logoImg = await pdfDoc.embedJpg(base64ToBytes(DESSIMATE_LOGO_JPG_BASE64)); } catch (e) { logoImg = null; }

  function leftText(str, x, yy, size, opts) {
    opts = opts || {};
    page.drawText(str == null ? '' : String(str), { x: x, y: yy, size: size, font: opts.bold ? fontBold : font, color: opts.color || ink });
  }
  function rightText(str, rightEdgeX, yy, size, opts) {
    opts = opts || {};
    const f = opts.bold ? fontBold : font;
    const s = str == null ? '' : String(str);
    page.drawText(s, { x: rightEdgeX - f.widthOfTextAtSize(s, size), y: yy, size: size, font: f, color: opts.color || ink });
  }
  function wrapLines(str, maxWidth, size, useFont) {
    const f = useFont || font;
    const out = [];
    (str || '').split(/\r?\n/).forEach(function (raw) {
      const words = raw.split(/\s+/).filter(Boolean);
      if (!words.length) { out.push(''); return; }
      let cur = '';
      words.forEach(function (w) {
        const attempt = cur ? cur + ' ' + w : w;
        if (cur && f.widthOfTextAtSize(attempt, size) > maxWidth) { out.push(cur); cur = w; }
        else cur = attempt;
      });
      if (cur) out.push(cur);
    });
    return out;
  }
  function fmtDateMDY(s) {
    const str = (s || '').toString().trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
    return m ? (m[2] + '/' + m[3] + '/' + m[1]) : str;
  }
  function checkbox(x, yy, checked, label, opts) {
    opts = opts || {};
    const size = 8.5;
    page.drawRectangle({ x: x, y: yy, width: size, height: size, borderColor: ink, borderWidth: 1, color: checked ? ink : rgb(1, 1, 1) });
    leftText(label, x + size + 4, yy + 0.5, opts.size || 9, { bold: opts.bold });
  }
  function sectionHeader(label, x, yy, w) {
    page.drawRectangle({ x: x, y: yy - 14, width: w, height: 17, color: sectionBg });
    leftText(label, x + 6, yy - 10, 9.5, { bold: true, color: brandBlue });
  }

  // ---- Header ---------------------------------------------------------------
  let hy = pageHeight - 40;
  if (logoImg) {
    const dims = logoImg.scaleToFit(108, 60);
    page.drawImage(logoImg, { x: margin, y: hy - dims.height, width: dims.width, height: dims.height });
  } else {
    leftText('Dessimate', margin, hy - 14, 16, { bold: true, color: brandBlue });
  }
  rightText('DISCREPANT MATERIAL REPORT (DMR)', pageWidth - margin, hy - 16, 15, { bold: true, color: brandBlue });
  rightText('DMR #: ' + (dmr.dmrNumber || ''), pageWidth - margin, hy - 34, 10.5, { bold: true });
  rightText('Date Issued: ' + fmtDateMDY(dmr.dateIssued), pageWidth - margin, hy - 48, 10);

  let y = hy - 78;

  if (dmr.dmrTitle) {
    const titleLines = wrapLines(dmr.dmrTitle, contentW, 13, fontBold).slice(0, 2);
    titleLines.forEach(function (line) { leftText(line, margin, y, 13, { bold: true, color: ink }); y -= 16; });
    y -= 8;
  }

  // ---- 1. Supplier Information -----------------------------------------------
  const colW = contentW / 2 - 6;
  const col2x = margin + contentW / 2 + 6;
  sectionHeader('1. SUPPLIER INFORMATION', margin, y, colW);
  sectionHeader('CUSTOMER', col2x, y, colW);
  y -= 20;
  leftText('Supplier Name:', margin, y, 8.5, { bold: true, color: labelGray });
  leftText('Dessimate', margin + 90, y, 9.5);
  leftText('Customer Org:', col2x, y, 8.5, { bold: true, color: labelGray });
  leftText(dmr.customerOrg || '—', col2x + 90, y, 9.5);
  y -= 16;
  leftText('Contact:', margin, y, 8.5, { bold: true, color: labelGray });
  leftText(dmr.supplierContactName || '—', margin + 90, y, 9.5);
  y -= 16;
  leftText('Contact Email:', margin, y, 8.5, { bold: true, color: labelGray });
  leftText(dmr.supplierContactEmail || '—', margin + 90, y, 9.5);
  leftText('Contact Phone:', col2x, y, 8.5, { bold: true, color: labelGray });
  leftText(dmr.supplierContactPhone || '—', col2x + 90, y, 9.5);
  y -= 16;

  // ---- 2. Part / Material Information --------------------------------------
  sectionHeader('2. PART / MATERIAL INFORMATION', margin, y, contentW);
  y -= 20;
  function fieldPair(labelA, valueA, labelB, valueB) {
    leftText(labelA, margin, y, 8.5, { bold: true, color: labelGray });
    leftText(valueA || '—', margin + 92, y, 9.5);
    leftText(labelB, col2x, y, 8.5, { bold: true, color: labelGray });
    leftText(valueB || '—', col2x + 92, y, 9.5);
    y -= 16;
  }
  fieldPair('Part Number:', dmr.partNumber, 'Part Description:', dmr.partDescription);
  fieldPair('Purchase Order #:', dmr.poNumber, 'Lot / Date Code(s):', dmr.lotDateCodes);
  fieldPair('Quantity Received:', dmr.quantityReceived, 'Quantity Discrepant:', dmr.quantityDiscrepant);
  fieldPair('Date Received:', fmtDateMDY(dmr.dateReceived), 'Inspected By:', dmr.inspectedBy);
  y -= 6;

  // ---- 3. Discrepancy Type -----------------------------------------------------
  sectionHeader('3. DISCREPANCY TYPE (check all that apply)', margin, y, contentW);
  y -= 20;
  const discColW = contentW / 4;
  const discTypes = [
    ['Not Cleaned / Contamination', dmr.discNotCleaned], ['Wrong Part / Mismatch', dmr.discWrongPart],
    ['Burrs / Sharp Edges', dmr.discBurrs], ['Packaging Damage', dmr.discPackaging],
    ['Dimensional Out of Spec', dmr.discDimensional], ['Missing / Incorrect Documentation', dmr.discMissingDocs],
    ['Surface Finish / Scratches', dmr.discSurfaceFinish], ['Quantity Shortage / Overage', dmr.discQuantity]
  ];
  for (let i = 0; i < discTypes.length; i += 2) {
    checkbox(margin, y, discTypes[i][1], discTypes[i][0], { size: 8 });
    if (discTypes[i + 1]) checkbox(margin + discColW * 2, y, discTypes[i + 1][1], discTypes[i + 1][0], { size: 8 });
    y -= 15;
  }
  checkbox(margin, y, dmr.discOther, 'Other: ' + (dmr.discOther && dmr.discOtherDetail ? dmr.discOtherDetail : ''), { size: 8 });
  y -= 16;

  // ---- 4. Description of Discrepancy -------------------------------------------
  sectionHeader('4. DESCRIPTION OF DISCREPANCY', margin, y, contentW);
  y -= 18;
  const descLines = wrapLines(dmr.descriptionOfDiscrepancy, contentW - 12, 9.5);
  const descShown = (descLines.length ? descLines : ['']).slice(0, 3);
  descShown.forEach(function (l) { leftText(l, margin + 6, y, 9.5); y -= 12; });
  y -= 4;
  if (dmr.attachments && dmr.attachments.length) {
    const attLine = 'Attachments: ' + dmr.attachments.map(function (a) { return a.filename; }).join(', ');
    wrapLines(attLine, contentW, 8).slice(0, 2).forEach(function (l) { leftText(l, margin, y, 8, { color: labelGray }); y -= 11; });
  }
  if (dmr.photos && dmr.photos.length) {
    leftText('Photographic evidence: ' + dmr.photos.length + ' photo' + (dmr.photos.length === 1 ? '' : 's') + ' attached (see page 2).', margin, y, 8, { color: labelGray });
    y -= 16;
  } else {
    y -= 4;
  }

  // ---- 6. Disposition Requested -------------------------------------------------
  sectionHeader('6. DISPOSITION REQUESTED', margin, y, contentW);
  y -= 20;
  checkbox(margin, y, dmr.dispReturnToSupplier, 'Return to Supplier', { size: 8.5 });
  checkbox(margin + 150, y, dmr.dispRework, 'Rework at Supplier', { size: 8.5 });
  checkbox(margin + 300, y, dmr.dispScrap, 'Scrap', { size: 8.5 });
  y -= 15;
  checkbox(margin, y, dmr.dispUseAsIs, 'Use As-Is (Dessimate Approval Required)', { size: 8.5 });
  checkbox(margin + 300, y, dmr.dispSortInspect, 'Sort & 100% Inspect at Dessimate', { size: 8.5 });
  y -= 18;
  leftText('Interim Corrective Action (ICA):', margin, y, 8.5, { bold: true, color: labelGray });
  y -= 12;
  wrapLines(dmr.containmentActionRequired, contentW - 6, 9.5).slice(0, 2).forEach(function (l) { leftText(l, margin + 6, y, 9.5); y -= 12; });
  leftText('Supplier Response Due:', margin, y, 8.5, { bold: true, color: labelGray });
  leftText(fmtDateMDY(dmr.supplierResponseDueDate) || '—', margin + 135, y, 9.5);
  y -= 16;

  // ---- 7. Supplier Response ------------------------------------------------------
  sectionHeader('7. SUPPLIER RESPONSE (Dessimate)', margin, y, contentW);
  y -= 18;
  leftText('Root Cause:', margin, y, 8.5, { bold: true, color: labelGray });
  y -= 11;
  wrapLines(dmr.rootCause, contentW - 12, 9.5).slice(0, 2).forEach(function (l) { leftText(l, margin + 6, y, 9.5); y -= 12; });
  y -= 4;
  leftText('Permanent Corrective Action (PCA):', margin, y, 8.5, { bold: true, color: labelGray });
  y -= 11;
  wrapLines(dmr.correctiveAction, contentW - 12, 9.5).slice(0, 2).forEach(function (l) { leftText(l, margin + 6, y, 9.5); y -= 12; });
  y -= 6;
  leftText('Supplier Signature / Print Name:', margin, y, 8, { bold: true, color: labelGray });
  page.drawLine({ start: { x: margin, y: y - 14 }, end: { x: margin + 260, y: y - 14 }, thickness: 0.75, color: lineGray });
  leftText(dmr.supplierSignature || '', margin, y - 12, 9.5);
  leftText('Date:', margin + 300, y, 8, { bold: true, color: labelGray });
  page.drawLine({ start: { x: margin + 300, y: y - 14 }, end: { x: margin + 420, y: y - 14 }, thickness: 0.75, color: lineGray });
  leftText(fmtDateMDY(dmr.supplierResponseDate) || '', margin + 300, y - 12, 9.5);
  y -= 24;

  // ---- 8. Customer Review / Closure ----------------------------------------------
  sectionHeader('8. CUSTOMER REVIEW / CLOSURE', margin, y, contentW);
  y -= 20;
  leftText('Reviewed By:', margin, y, 8.5, { bold: true, color: labelGray });
  leftText(dmr.reviewedBy || '—', margin + 80, y, 9.5);
  checkbox(col2x, y - 1, dmr.status === 'open', 'Open', { size: 8.5 });
  checkbox(col2x + 60, y - 1, dmr.status === 'closed_accepted', 'Closed - Accepted', { size: 8.5 });
  checkbox(col2x + 190, y - 1, dmr.status === 'closed_rejected', 'Closed - Rejected', { size: 8.5 });
  y -= 18;
  leftText('Comments:', margin, y, 8.5, { bold: true, color: labelGray });
  y -= 12;
  const comments = Array.isArray(dmr.reviewComments) ? dmr.reviewComments : [];
  const footerFloor = 40; // stay clear of the footer line drawn at y=22
  if (!comments.length) {
    leftText('No comments yet.', margin + 6, y, 8.5, { color: labelGray });
    y -= 12;
  } else {
    // One truncated line per entry (newest first) so the thread stays a
    // compact snapshot - the full untruncated thread is always visible in
    // the app itself. Stops (with a "+N more" note) before running into
    // the footer rather than overflowing off the page.
    const ordered = comments.slice().reverse();
    const commentLineHeight = 11;
    function truncateToWidth(str, maxWidth) {
      if (font.widthOfTextAtSize(str, 8) <= maxWidth) return str;
      let s = str;
      while (s.length > 0 && font.widthOfTextAtSize(s + '…', 8) > maxWidth) s = s.slice(0, -1);
      return s + '…';
    }
    let shown = 0;
    for (let ci = 0; ci < ordered.length; ci++) {
      if (y - commentLineHeight < footerFloor) break;
      const c = ordered[ci];
      const prefix = fmtDateMDY((c.createdAt || '').slice(0, 10)) + '  ' + (c.authorUsername || 'Unknown') + ':  ';
      const prefixWidth = fontBold.widthOfTextAtSize(prefix, 8);
      const body = truncateToWidth((c.text || '').replace(/\s+/g, ' ').trim(), Math.max(20, contentW - 12 - prefixWidth));
      leftText(prefix, margin + 6, y, 8, { bold: true, color: labelGray });
      leftText(body, margin + 6 + prefixWidth, y, 8);
      y -= commentLineHeight;
      shown++;
    }
    const remaining = ordered.length - shown;
    if (remaining > 0 && y - commentLineHeight >= footerFloor) {
      leftText('+' + remaining + ' more comment' + (remaining === 1 ? '' : 's') + ' — see full thread in the system.', margin + 6, y, 8, { color: labelGray });
      y -= commentLineHeight;
    }
  }

  // ---- Footer -----------------------------------------------------------------
  leftText('Dessimate – Discrepant Material Report (Customer) – Form QF-DMR-02, Rev. A', margin, 22, 7.5, { color: labelGray });

  // ---- Page 2: Photographic Evidence (only when at least one photo exists) -----
  const photos = Array.isArray(dmr.photos) ? dmr.photos : [];
  if (photos.length) {
    const page2 = pdfDoc.addPage([pageWidth, pageHeight]);
    function leftText2(str, x, yy, size, opts) {
      opts = opts || {};
      page2.drawText(str == null ? '' : String(str), { x: x, y: yy, size: size, font: opts.bold ? fontBold : font, color: opts.color || ink });
    }
    page2.drawRectangle({ x: margin, y: pageHeight - 40 - 16, width: contentW, height: 16, color: sectionBg });
    leftText2('5. PHOTOGRAPHIC EVIDENCE — DMR ' + (dmr.dmrNumber || ''), margin + 6, pageHeight - 40 - 12, 9.5, { bold: true, color: brandBlue });
    const gridTop = pageHeight - 40 - 34;
    const gap = 16;
    const boxW = (contentW - gap) / 2;
    const boxH = 300;
    for (let i = 0; i < 4; i++) {
      const col = i % 2, row = Math.floor(i / 2);
      const bx = margin + col * (boxW + gap);
      const by = gridTop - boxH - row * (boxH + 34) - row * gap;
      page2.drawRectangle({ x: bx, y: by, width: boxW, height: boxH, borderColor: lineGray, borderWidth: 1 });
      const photo = photos[i];
      const img = photoImages && photoImages[i];
      leftText2('Photo ' + (i + 1), bx + 6, by + boxH - 14, 8.5, { bold: true, color: labelGray });
      if (img) {
        const pad = 8, maxW = boxW - pad * 2, maxH = boxH - 26;
        const dims = img.scaleToFit(maxW, maxH);
        page2.drawImage(img, { x: bx + (boxW - dims.width) / 2, y: by + 18 + (maxH - dims.height) / 2, width: dims.width, height: dims.height });
      } else {
        leftText2('No photo attached.', bx + 6, by + boxH / 2, 9, { color: labelGray });
      }
      if (photo && photo.caption) {
        leftText2(photo.caption, bx + 6, by - 12, 8, { color: labelGray });
      }
    }
  }

  return pdfDoc.save();
}

async function handleGetCustomerDmrPdf(env, origin, id, accessLevel, organization) {
  const raw = await resolveCustomerDmrRecord(env, id);
  if (!raw) return json({ message: 'Not found.' }, 404, origin);
  let clean = sanitizeCustomerDmr(raw);
  const scoped = scopeCustomerDmrs([clean], accessLevel, organization);
  if (!scoped.length) return json({ message: 'Not found.' }, 404, origin);
  clean = scoped[0];

  async function loadImageDoc(doc) {
    if (!doc || !doc.path) return null;
    try {
      const bytes = await readGithubFileBytes(env, doc.path);
      return bytes ? { bytes: bytes, mimeType: doc.mimeType } : null;
    } catch (e) { return null; }
  }

  let pdfBytes;
  try {
    const photoDocs = [];
    for (let i = 0; i < clean.photos.length; i++) photoDocs.push(await loadImageDoc(clean.photos[i]));
    pdfBytes = await buildCustomerDmrPdf(clean, photoDocs);
  } catch (e) {
    return json({ message: 'Could not generate PDF: ' + (e && e.message ? e.message : e) }, 500, origin);
  }
  return pdfResponse(pdfBytes, 'Customer DMR ' + clean.dmrNumber + '.pdf', origin);
}

// ---- Customer Open Issues List (Rev2.22) - a running log of open
// production/quality issues tied to a Customer's parts, tracked entirely
// by Dessimate staff (a Customer never creates or edits one - only views
// their own org's issues and adds to the comment thread). A future
// "Dessimate Open Issues List" sibling module (internal-only issues, no
// Customer org) is planned but not built yet - see the prompt this was
// built from. No PDF generation - not requested for this module.
const CUSTOMER_OPEN_ISSUES_FILE_PATH = 'data/customer_open_issues.json';
const CUSTOMER_OPEN_ISSUE_DOC_FOLDER = 'customer_open_issue_docs';
const OPEN_ISSUE_PART_NUMBERS_MAX = 5;
// Rev2.26 replaced the original plain Open/Closed with a 5-value PDCA
// cycle (Plan/Do/Check/Act) plus Closed. Rev2.31 suppresses that back down
// to just Open/Closed per the client ("we will come back to this when
// needed") - 'open' is added as the new default/only non-closed choice,
// but plan/do/check/act stay valid here (not deleted) so a record already
// carrying one of those from before Rev2.31 still passes validation and
// keeps working; only the frontend stops offering them as a new pick
// (see OPEN_ISSUE_STATUS_LABELS in PDIR_CustomerOpenIssues.html, which
// normalizes any of them to "Open" for display).
const OPEN_ISSUE_STATUSES = ['open', 'plan', 'do', 'check', 'act', 'closed'];
const OPEN_ISSUE_DEFAULT_STATUS = 'open';

// Open Issue # is formatted "OI-####" (4 digits), same voluntary/custom-
// value auto-numbering as CR/SCR/DMR Number.
async function reserveOpenIssueNumber(env, clientIssueNumber) {
  const result = await mutateJsonObjectFile(env, COUNTERS_FILE_PATH, DEFAULT_COUNTERS, function (obj) {
    let issueNumber;
    if (clientIssueNumber) {
      issueNumber = clientIssueNumber;
      const m = /^OI-(\d+)$/i.exec(clientIssueNumber);
      if (m) {
        const seq = Number(m[1]);
        if (seq >= obj.nextOpenIssueNumber) obj.nextOpenIssueNumber = seq + 1;
      }
    } else {
      issueNumber = 'OI-' + pad4(obj.nextOpenIssueNumber);
      obj.nextOpenIssueNumber = obj.nextOpenIssueNumber + 1;
    }
    return { obj: obj, meta: { issueNumber: issueNumber } };
  });
  if (!result.ok) throw new Error(result.message);
  return result.meta.issueNumber;
}
async function handlePeekOpenIssueNumber(env, origin) {
  const state = await readJsonObjectFile(env, COUNTERS_FILE_PATH, DEFAULT_COUNTERS);
  return json({ issueNumber: 'OI-' + pad4(state.obj.nextOpenIssueNumber) }, 200, origin);
}
async function openIssueNumberTaken(env, issueNumber, excludeId) {
  const state = await readJsonArrayFile(env, CUSTOMER_OPEN_ISSUES_FILE_PATH);
  const target = String(issueNumber).toLowerCase();
  return state.items.some(function (o) { return o.id !== excludeId && String(o.issueNumber).toLowerCase() === target; });
}

function sanitizeOpenIssuePicture(d) {
  if (!d || !d.path) return null;
  return {
    path: d.path,
    filename: d.filename || '',
    mimeType: d.mimeType || 'application/octet-stream',
    size: typeof d.size === 'number' ? d.size : 0,
    uploadedBy: (d && d.uploadedBy) || '',
    uploadedAt: (d && d.uploadedAt) || null
  };
}
function sanitizeOpenIssueAttachment(d) {
  if (!d || !d.path) return null;
  return {
    id: d.id || null,
    path: d.path,
    filename: d.filename || '',
    mimeType: d.mimeType || 'application/octet-stream',
    size: typeof d.size === 'number' ? d.size : 0,
    comment: d.comment || '',
    uploadedBy: (d && d.uploadedBy) || '',
    uploadedAt: (d && d.uploadedAt) || null
  };
}
function sanitizeOpenIssueAttachments(list) {
  const arr = Array.isArray(list) ? list : [];
  return arr.map(sanitizeOpenIssueAttachment).filter(Boolean).slice(0, PART_ATTACHMENTS_MAX);
}

// Notes/Comments thread - entries are appended by handleAddOpenIssueComment
// and may later be edited (text only) by handleEditOpenIssueComment, never
// by the generic PUT (so nobody can silently rewrite the whole thread by
// resending a modified array). editedAt is set only once a comment has
// actually been edited, so the UI can show a "(edited)" marker.
function sanitizeOpenIssueComment(c) {
  if (!c) return null;
  return {
    id: c.id || cryptoRandomId(),
    authorUsername: c.authorUsername || '',
    text: c.text || '',
    createdAt: c.createdAt || null,
    editedAt: c.editedAt || null
  };
}
function sanitizeOpenIssueComments(list) {
  const arr = Array.isArray(list) ? list : [];
  return arr.map(sanitizeOpenIssueComment).filter(Boolean);
}

function sanitizeCustomerOpenIssue(o) {
  return {
    id: o.id,
    issueNumber: o.issueNumber || '',
    createdAt: o.createdAt || null,
    createdBy: o.createdBy || '',
    customerOrg: o.customerOrg || '',
    partNumbers: Array.isArray(o.partNumbers)
      ? o.partNumbers.map(function (p) { return (p || '').toString().trim(); }).filter(Boolean).slice(0, OPEN_ISSUE_PART_NUMBERS_MAX)
      : [],
    // Rev2.25: a short title shown in the list view (Issue Description is
    // still the full write-up, shown in the modal/export only) - matches
    // the DMR/CR/SCR Title pattern already used elsewhere in this app.
    issueTitle: o.issueTitle || '',
    issueDescription: o.issueDescription || '',
    issuePicture: sanitizeOpenIssuePicture(o.issuePicture),
    rootCause: o.rootCause || '',
    interimCM: o.interimCM || '',
    permCM: o.permCM || '',
    nextAction: o.nextAction || '',
    championResponsible: o.championResponsible || '',
    // A legacy "open" value (from before the PDCA statuses) isn't in the
    // new list, so it falls through to the default ("plan") below -
    // "closed" is unaffected, it's still valid as-is.
    status: OPEN_ISSUE_STATUSES.indexOf(o.status) !== -1 ? o.status : OPEN_ISSUE_DEFAULT_STATUS,
    attachments: sanitizeOpenIssueAttachments(o.attachments),
    comments: sanitizeOpenIssueComments(o.comments)
  };
}

// Staff-only end to end (a Customer never creates/edits, only comments -
// see the module comment above), so there's no isCustomer split here the
// way DMR/Customer DMR need.
function validateCustomerOpenIssueFields(body) {
  return {
    customerOrg: (body.customerOrg || '').toString().trim(),
    partNumbers: Array.isArray(body.partNumbers)
      ? body.partNumbers.map(function (p) { return (p || '').toString().trim(); }).filter(Boolean).slice(0, OPEN_ISSUE_PART_NUMBERS_MAX)
      : [],
    issueTitle: (body.issueTitle || '').toString().trim(),
    issueDescription: (body.issueDescription || '').toString().trim(),
    issuePicture: sanitizeOpenIssuePicture(body.issuePicture),
    rootCause: (body.rootCause || '').toString().trim(),
    interimCM: (body.interimCM || '').toString().trim(),
    permCM: (body.permCM || '').toString().trim(),
    nextAction: (body.nextAction || '').toString().trim(),
    championResponsible: (body.championResponsible || '').toString().trim(),
    status: OPEN_ISSUE_STATUSES.indexOf(body.status) !== -1 ? body.status : OPEN_ISSUE_DEFAULT_STATUS,
    attachments: sanitizeOpenIssueAttachments(body.attachments)
  };
}

// Team Member+ sees every issue; a Customer sees only ones naming their
// own organization. A Supplier login has no role in this module.
function scopeCustomerOpenIssues(items, accessLevel, organization) {
  if (accessLevel === 'customer') {
    return items.filter(function (o) { return organization && o.customerOrg === organization; });
  }
  if (accessLevel === 'supplier') return [];
  return items;
}

async function handleListCustomerOpenIssues(env, origin, accessLevel, organization) {
  const state = await readJsonArrayFile(env, CUSTOMER_OPEN_ISSUES_FILE_PATH);
  const items = scopeCustomerOpenIssues(state.items.map(sanitizeCustomerOpenIssue), accessLevel, organization);
  return json({ openIssues: items }, 200, origin);
}

async function handleCreateCustomerOpenIssue(request, env, origin, username) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const fields = validateCustomerOpenIssueFields(body);
  if (!fields.customerOrg) return json({ message: 'Customer Organization is required.' }, 400, origin);

  const clientIssueNumber = (body.issueNumber || '').toString().trim();
  if (clientIssueNumber && await openIssueNumberTaken(env, clientIssueNumber, null)) {
    return json({ message: 'That Issue Number is already in use.' }, 409, origin);
  }
  const issueNumber = await reserveOpenIssueNumber(env, clientIssueNumber);

  const newIssue = Object.assign(
    { id: cryptoRandomId(), createdAt: new Date().toISOString(), createdBy: username || '', issueNumber: issueNumber, comments: [] },
    fields
  );

  const result = await mutateJsonArrayFile(env, CUSTOMER_OPEN_ISSUES_FILE_PATH, function (items) {
    items.push(newIssue);
    return { items: items };
  });
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeCustomerOpenIssue(newIssue), 201, origin);
}

async function handleUpdateCustomerOpenIssue(request, env, origin, id) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const fields = validateCustomerOpenIssueFields(body);

  let newIssueNumber; // undefined = leave as-is
  if (body.issueNumber !== undefined) {
    const requested = (body.issueNumber === null ? '' : String(body.issueNumber)).trim();
    if (!requested) return json({ message: 'Issue Number is required.' }, 400, origin);
    if (await openIssueNumberTaken(env, requested, id)) {
      return json({ message: 'That Issue Number is already in use.' }, 409, origin);
    }
    newIssueNumber = requested;
  }

  let saved = null;
  const result = await mutateJsonArrayFile(env, CUSTOMER_OPEN_ISSUES_FILE_PATH, function (items) {
    const target = items.find(function (o) { return o.id === id; });
    if (!target) return null;
    Object.assign(target, fields);
    if (newIssueNumber !== undefined) target.issueNumber = newIssueNumber;
    saved = target;
    return { items: items };
  }, { requireFound: true });

  if (result === 'not-found' || !saved) return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeCustomerOpenIssue(saved), 200, origin);
}

async function handleDeleteCustomerOpenIssue(env, origin, id) {
  const result = await mutateJsonArrayFile(env, CUSTOMER_OPEN_ISSUES_FILE_PATH, function (items) {
    const idx = items.findIndex(function (o) { return o.id === id; });
    if (idx === -1) return null;
    items.splice(idx, 1);
    return { items: items };
  }, { requireFound: true });
  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json({ ok: true }, 200, origin);
}

// Notes/Comments thread - appends a new entry (editing an existing one is
// handleEditOpenIssueComment below; there is still no delete route).
// Team Member+ can comment on any issue; a Customer can comment only on
// one naming their own organization. Returns the full updated record.
async function handleAddOpenIssueComment(request, env, origin, id, accessLevel, username) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const text = (body.text || '').toString().trim();
  if (!text) return json({ message: 'Comment text is required.' }, 400, origin);

  const isCustomer = accessLevel === 'customer';
  let callerOrg = '';
  if (isCustomer) {
    callerOrg = await resolveUserOrganization(env, username);
    if (!callerOrg) return json({ message: 'Your account isn’t linked to a Customer organization.' }, 403, origin);
  }

  const comment = { id: cryptoRandomId(), authorUsername: username || '', text: text, createdAt: new Date().toISOString() };

  let saved = null;
  const result = await mutateJsonArrayFile(env, CUSTOMER_OPEN_ISSUES_FILE_PATH, function (items) {
    const target = items.find(function (o) { return o.id === id; });
    if (!target) return null;
    if (isCustomer && target.customerOrg !== callerOrg) return null;
    target.comments = Array.isArray(target.comments) ? target.comments : [];
    target.comments.push(comment);
    saved = target;
    return { items: items };
  }, { requireFound: true });

  if (result === 'not-found' || !saved) return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeCustomerOpenIssue(saved), 200, origin);
}

// Edits one existing comment's text in place. Team Member+ can edit any
// comment on any issue; a Customer can edit only their OWN comment
// (matched by authorUsername), and only on an issue naming their own
// organization - never someone else's note, even on their own org's
// issue. Stamps editedAt so the UI can show a "(edited)" marker; there is
// still no delete route.
async function handleEditOpenIssueComment(request, env, origin, id, commentId, accessLevel, username) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Invalid request body.' }, 400, origin); }
  const text = (body.text || '').toString().trim();
  if (!text) return json({ message: 'Comment text is required.' }, 400, origin);

  const isStaff = accessLevel === 'team_member' || accessLevel === 'admin' || accessLevel === 'super_admin';
  const isCustomer = accessLevel === 'customer';
  let callerOrg = '';
  if (isCustomer) {
    callerOrg = await resolveUserOrganization(env, username);
    if (!callerOrg) return json({ message: 'Your account isn’t linked to a Customer organization.' }, 403, origin);
  }

  let saved = null;
  let forbidden = false;
  const result = await mutateJsonArrayFile(env, CUSTOMER_OPEN_ISSUES_FILE_PATH, function (items) {
    const target = items.find(function (o) { return o.id === id; });
    if (!target) return null;
    if (isCustomer && target.customerOrg !== callerOrg) return null;
    const comments = Array.isArray(target.comments) ? target.comments : [];
    const comment = comments.find(function (c) { return c.id === commentId; });
    if (!comment) return null;
    if (!isStaff && comment.authorUsername !== username) { forbidden = true; return null; }
    comment.text = text;
    comment.editedAt = new Date().toISOString();
    target.comments = comments;
    saved = target;
    return { items: items };
  }, { requireFound: true });

  if (forbidden) return json({ message: 'You can only edit your own comments.' }, 403, origin);
  if (result === 'not-found' || !saved) return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeCustomerOpenIssue(saved), 200, origin);
}

async function resolveCustomerOpenIssueRecord(env, id) {
  const state = await readJsonArrayFile(env, CUSTOMER_OPEN_ISSUES_FILE_PATH);
  return state.items.find(function (o) { return o.id === id; }) || null;
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

// Used by isContentsPathAllowedForExternal to gate a Supplier's raw
// /contents/ access to their own submitted invoice's attached PDF - same
// ownership check handleListSupplierInvoices already uses for the list
// itself. Returns the org name on file, or null if the invoice doesn't
// exist.
async function resolveSupplierInvoiceOwner(env, invoiceId) {
  const state = await readJsonArrayFile(env, SUPPLIER_INVOICES_FILE_PATH);
  const inv = state.items.find(function (o) { return o.id === invoiceId; });
  return inv ? (inv.supplier || '') : null;
}

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
// Rev2.21: a 4-stage workflow status (was just Unpaid/Paid) - each value
// tracks how far the invoice has moved from an internal draft through to
// being paid. Defaults to the first stage for a brand-new invoice.
const DESSIMATE_INVOICE_STATUSES = ['Started / Placeholder', 'Internal Completed', 'Submitted to Customer', 'Paid'];
const DESSIMATE_INVOICE_DEFAULT_STATUS = 'Started / Placeholder';

// Used by isContentsPathAllowedForExternal to gate a Customer's raw
// /contents/ access to their own Dessimate Invoice's attachments (path
// folder is 'dessimate_invoice_docs', built client-side in
// PDIR_DessimateInvoices.html - no backend constant for it since the
// generic /contents/ proxy never constructs paths itself). Returns the org
// name on file, or null if the invoice doesn't exist.
// Only ever consulted for a Customer login (see
// isContentsPathAllowedForExternal) - returns null (deny) if the invoice
// isn't at a Customer-visible status yet, same gate scopeDessimateInvoices
// applies to the list/record/PDF routes, so a Customer can't reach an
// early-stage invoice's attachments by guessing its file path either.
async function resolveDessimateInvoiceOwner(env, invoiceId) {
  const state = await readJsonArrayFile(env, DESSIMATE_INVOICES_FILE_PATH);
  const inv = state.items.find(function (o) { return o.id === invoiceId; });
  if (!inv) return null;
  if (DESSIMATE_INVOICE_CUSTOMER_VISIBLE_STATUSES.indexOf(inv.status) === -1) return null;
  return inv.customer || '';
}

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

// Rev2.11: a deleted invoice's number no longer stays permanently reserved -
// only an active (non-deleted) invoice counts as "taken", per customer
// feedback ("we care more for the invoice number... want to be able to
// reuse the numbers"). This reversed the original Rev2.4 design (see the
// comment on handleListDeletedDessimateInvoices below, now stale) which
// deliberately never reused a deleted invoice's number.
async function dessimateInvoiceNumberTaken(env, invoiceNumber, excludeId) {
  const state = await readJsonArrayFile(env, DESSIMATE_INVOICES_FILE_PATH);
  const target = String(invoiceNumber).toLowerCase();
  return state.items.some(function (o) { return !o.deleted && o.id !== excludeId && String(o.invoiceNumber).toLowerCase() === target; });
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

// Dessimate Invoice's Attachments section - same shape as sanitizeOrgDoc,
// plus a short `comment` field (what the file is about) and `id`
// preserved through (needed intact: the "Generate Invoice"/"Generate
// Packing Slip" buttons tag their own saved copies with fixed ids so
// re-generating replaces them in place instead of appending duplicates -
// see PDIR_DessimateInvoices.html's GENERATED_PDF_ID/GENERATED_PACKING_SLIP_ID).
function sanitizeDessimateInvoiceAttachment(d) {
  if (!d || !d.path) return null;
  return {
    id: d.id || null,
    path: d.path,
    filename: d.filename || '',
    mimeType: d.mimeType || 'application/octet-stream',
    size: typeof d.size === 'number' ? d.size : 0,
    comment: d.comment || '',
    uploadedBy: (d && d.uploadedBy) || '',
    uploadedAt: (d && d.uploadedAt) || null
  };
}
function sanitizeDessimateInvoiceAttachments(list) {
  const arr = Array.isArray(list) ? list : [];
  return arr.map(sanitizeDessimateInvoiceAttachment).filter(Boolean).slice(0, PART_ATTACHMENTS_MAX);
}

function sanitizeDessimateInvoice(o) {
  const lines = Array.isArray(o.lines) ? o.lines.map(sanitizeDessimateInvoiceLine) : [];
  // Rev2.4: customerPoRefs (array) replaces the old single customerPoRef -
  // one Dessimate Invoice can now bill against more than one Customer PO. A
  // legacy record with only the old string field still reads back as a
  // one-item array.
  const customerPoRefs = Array.isArray(o.customerPoRefs)
    ? Array.from(new Set(o.customerPoRefs.map(function (v) { return (v || '').toString().trim(); }).filter(Boolean)))
    : (o.customerPoRef ? [String(o.customerPoRef).trim()] : []);
  return {
    id: o.id,
    invoiceNumber: o.invoiceNumber,
    invoiceDate: o.invoiceDate || '',
    customer: o.customer || '',
    customerPoRef: customerPoRefs[0] || '', // kept for any old client still reading the singular field
    customerPoRefs: customerPoRefs,
    dessimatePoRef: o.dessimatePoRef || '',
    shipmentNumber: o.shipmentNumber || '',
    shipTo: o.shipTo || '',
    fromAddress: o.fromAddress || '',
    currency: o.currency || '',
    paymentTerms: o.paymentTerms || '',
    incoterms: o.incoterms || '',
    notes: o.notes || '',
    shipVia: o.shipVia || '',
    shipDate: o.shipDate || '',
    // Rev2.21 replaced the old 2-value Unpaid/Paid status with the 4-stage
    // workflow above - deliberately no auto-migration from the old value
    // (an existing "Unpaid" invoice could just as easily have been a
    // never-finished placeholder as an already-submitted one, and guessing
    // wrong either way is worse than asking). A record still carrying the
    // old value reads as the new default until someone opens it and picks
    // the real status by hand.
    status: DESSIMATE_INVOICE_STATUSES.indexOf(o.status) !== -1 ? o.status : DESSIMATE_INVOICE_DEFAULT_STATUS,
    deleted: !!o.deleted,
    deletedAt: o.deletedAt || null,
    lines: lines,
    invoiceTotal: Math.round(lines.reduce(function (sum, l) { return sum + l.extendedPrice; }, 0) * 100) / 100,
    // Rev2.1: ability to attach files (e.g. invoices uploaded from a legacy
    // system) - same {path, filename, mimeType, size} shape/cap as Parts.
    attachments: sanitizeDessimateInvoiceAttachments(o.attachments),
    createdAt: o.createdAt || null
  };
}

// Rev2.21: a Customer only sees an invoice once it's actually gone out the
// door - "Started / Placeholder" and "Internal Completed" are internal
// drafting stages, not something to expose to the org being billed just
// because it's saved against their name.
const DESSIMATE_INVOICE_CUSTOMER_VISIBLE_STATUSES = ['Submitted to Customer', 'Paid'];
function scopeDessimateInvoices(invoices, accessLevel, organization) {
  // A Customer login sees only invoices billed to their own organization,
  // and only once staff have actually submitted it to them.
  // A Dessimate Invoice bills a Customer, not a Supplier, so a Supplier
  // login has no relationship to it at all.
  if (accessLevel === 'customer') {
    return invoices.filter(function (o) {
      return organization && o.customer === organization && DESSIMATE_INVOICE_CUSTOMER_VISIBLE_STATUSES.indexOf(o.status) !== -1;
    });
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
  const status = DESSIMATE_INVOICE_STATUSES.indexOf(body.status) !== -1 ? body.status : DESSIMATE_INVOICE_DEFAULT_STATUS;
  const customerPoRefs = Array.isArray(body.customerPoRefs)
    ? Array.from(new Set(body.customerPoRefs.map(function (v) { return (v || '').toString().trim(); }).filter(Boolean)))
    : [];
  return {
    invoiceDate: (body.invoiceDate || '').toString().trim(),
    customer: customer,
    customerPoRefs: customerPoRefs,
    dessimatePoRef: (body.dessimatePoRef || '').toString().trim(),
    shipmentNumber: (body.shipmentNumber || '').toString().trim(),
    shipTo: (body.shipTo || '').toString().trim(),
    fromAddress: (body.fromAddress || '').toString().trim(),
    currency: (body.currency || '').toString().trim(),
    paymentTerms: (body.paymentTerms || '').toString().trim(),
    incoterms: (body.incoterms || '').toString().trim(),
    notes: (body.notes || '').toString().trim(),
    shipVia: (body.shipVia || '').toString().trim(),
    shipDate: (body.shipDate || '').toString().trim(),
    status: status,
    lines: lines,
    attachments: sanitizeDessimateInvoiceAttachments(body.attachments)
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

  // Rev2.4: the Invoice Number can now be changed after creation (product
  // brief) - still unique, and a numeric value still bumps the counter past
  // itself so a later auto-assigned number never collides with it, the same
  // way a voluntary number does at create time (reserveDessimateInvoiceNumber).
  // Left out of validateDessimateInvoiceFields since it needs its own
  // uniqueness check (excluding this invoice).
  let newInvoiceNumber; // undefined = "leave it as-is"
  if (body.invoiceNumber !== undefined) {
    const requested = (body.invoiceNumber === null ? '' : String(body.invoiceNumber)).trim();
    if (!requested) return json({ message: 'Invoice Number is required.' }, 400, origin);
    if (await dessimateInvoiceNumberTaken(env, requested, id)) {
      return json({ message: 'That Invoice Number is already in use.' }, 409, origin);
    }
    newInvoiceNumber = /^\d+$/.test(requested) ? Number(requested) : requested;
  }

  let saved = null;
  const result = await mutateJsonArrayFile(env, DESSIMATE_INVOICES_FILE_PATH, function (items) {
    const target = items.find(function (o) { return o.id === id; });
    if (!target) return null;
    Object.assign(target, fields);
    if (newInvoiceNumber !== undefined) target.invoiceNumber = newInvoiceNumber;
    saved = target;
    return { items: items };
  }, { requireFound: true });

  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  if (typeof newInvoiceNumber === 'number') {
    await mutateJsonObjectFile(env, COUNTERS_FILE_PATH, DEFAULT_COUNTERS, function (obj) {
      if (newInvoiceNumber >= obj.nextDessimateInvoiceNumber) obj.nextDessimateInvoiceNumber = newInvoiceNumber + 1;
      return { obj: obj };
    });
  }
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

// Rev2.4: Dessimate Invoice delete has always been a soft delete, so a
// deleted invoice can still be reviewed/restored here. Admin+ only, same
// access floor as the Dessimate Invoice module's writes - a deleted invoice
// is billing history, not routine data. (Rev2.11: its Invoice Number is no
// longer permanently reserved once deleted - see dessimateInvoiceNumberTaken -
// so by the time someone comes back to restore one, that number may already
// have been reused by a newer invoice; handleRestoreDessimateInvoice below
// checks for that and blocks the restore rather than creating a duplicate.)
async function handleListDeletedDessimateInvoices(env, origin) {
  const state = await readJsonArrayFile(env, DESSIMATE_INVOICES_FILE_PATH);
  const deleted = state.items.filter(function (o) { return o.deleted; }).map(sanitizeDessimateInvoice);
  return json({ dessimateInvoices: deleted }, 200, origin);
}

async function handleRestoreDessimateInvoice(env, origin, id) {
  const state = await readJsonArrayFile(env, DESSIMATE_INVOICES_FILE_PATH);
  const existing = state.items.find(function (o) { return o.id === id; });
  if (!existing) return json({ message: 'Not found.' }, 404, origin);
  if (await dessimateInvoiceNumberTaken(env, existing.invoiceNumber, id)) {
    return json({ message: 'Can\'t restore — Invoice Number ' + existing.invoiceNumber + ' is now in use by another invoice. Change that invoice\'s number first, or give this one a different number after restoring.' }, 409, origin);
  }
  let saved = null;
  const result = await mutateJsonArrayFile(env, DESSIMATE_INVOICES_FILE_PATH, function (items) {
    const target = items.find(function (o) { return o.id === id; });
    if (!target) return null;
    target.deleted = false;
    target.deletedAt = null;
    saved = target;
    return { items: items };
  }, { requireFound: true });
  if (result === 'not-found') return json({ message: 'Not found.' }, 404, origin);
  if (!result.ok) return json({ message: result.message }, 500, origin);
  return json(sanitizeDessimateInvoice(saved), 200, origin);
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
  // A user-typed "\n" (e.g. From/Ship To's street/city-state-zip break) is
  // always honored as a forced line break; each resulting line is then
  // greedy word-wrapped to maxWidth same as before - matching the Dessimate
  // PO PDF's wrapLines fix for the same issue.
  function wrapLines(str, maxWidth, size) {
    const lines = [];
    (str || '').split(/\r?\n/).forEach(function (raw) {
      const words = raw.split(/\s+/).filter(Boolean);
      if (!words.length) return;
      let cur = '';
      words.forEach(function (w) {
        const attempt = cur ? cur + ' ' + w : w;
        if (cur && font.widthOfTextAtSize(attempt, size) > maxWidth) { lines.push(cur); cur = w; }
        else cur = attempt;
      });
      if (cur) lines.push(cur);
    });
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
  // ISO date input ("YYYY-MM-DD") -> MM/DD/YYYY for display, matching the
  // Dessimate PO PDF's fmtDateMDY; anything else (already-formatted, free
  // text, blank) passes through unchanged rather than risk mangling it.
  function fmtDateMDY(s) {
    const str = (s || '').toString().trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
    return m ? (m[2] + '/' + m[3] + '/' + m[1]) : str;
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
  // Values are left-aligned starting right after the label (not right-flush
  // against the page edge), and the whole block sits a bit further right
  // than before - both per customer markup, matching the Dessimate PO PDF's
  // identity-block fix.
  const idValueMaxWidth = 68;
  const idLabelEdge = pageWidth - margin - idValueMaxWidth - 10;
  const idValueX = idLabelEdge + 10;
  function idRow(label, value, size) {
    rightText(label, idLabelEdge, ry, size, { bold: true });
    const valLines = wrapLines(String(value || ''), idValueMaxWidth, size);
    if (!valLines.length) valLines.push('');
    valLines.forEach(function (vl, i) { leftText(vl, idValueX, ry - i * (size + 2), size); });
    ry -= (size + 5) + Math.max(0, valLines.length - 1) * (size + 2);
  }
  const poRefDisplay = (Array.isArray(inv.customerPoRefs) && inv.customerPoRefs.length) ? inv.customerPoRefs.join(', ') : (inv.customerPoRef || '');
  idRow('Invoice Number:', inv.invoiceNumber || '', 10);
  idRow('Purchase Order Number:', poRefDisplay, 10);
  idRow('Date:', fmtDateMDY(inv.invoiceDate), 10);
  idRow('Terms:', inv.paymentTerms || '', 10);
  idRow('Due Date:', '', 10);
  idRow('Shipment #:', inv.shipmentNumber || '', 10);

  // ---- Self org name/address/contact (left column under the logo) ----------
  // Rev2.4: inv.fromAddress overrides the Self org's default (first) address
  // - set via a dropdown of the org's saved addresses on the invoice form,
  // left blank to keep following whatever that default address currently is.
  let ly = logoBottom - 16;
  leftText((selfOrg && selfOrg.name) || 'Dessimate LLC', margin, ly, 10, { bold: true }); ly -= 13;
  let selfAddrText = inv.fromAddress;
  if (!selfAddrText) {
    const a0 = (selfOrg && Array.isArray(selfOrg.addresses) && selfOrg.addresses[0]) ? selfOrg.addresses[0] : null;
    selfAddrText = a0 ? [a0.line1, a0.line2].filter(Boolean).join('\n') : '';
  }
  wrapLines(selfAddrText, colGap - margin - 10, 9).forEach(function (line) { leftText(line, margin, ly, 9); ly -= 12; });

  let cy = logoBottom - 16;
  [selfOrg && selfOrg.salesEmail, selfOrg && selfOrg.phone, selfOrg && selfOrg.website].filter(Boolean).forEach(function (line) {
    leftText(line, colGap, cy, 9); cy -= 12;
  });

  // ---- Bill To / Ship To (still inside the header band) --------------------
  // Rev2.4: Ship To is now populated from a dropdown of the customer
  // organization's saved addresses (still free-text underneath, so it can be
  // hand-edited/overridden) rather than typed from scratch every time.
  // Street and city/state/zip print on separate forced lines (not
  // comma-joined) per customer markup, matching the Dessimate PO PDF fix.
  const by = Math.min(ly, cy) - 18;
  leftText('Bill To:', margin, by, 10, { bold: true });
  leftText('Ship To:', colGap, by, 10, { bold: true });
  let by1 = by - 13;
  const billAddr0 = (customerOrg && Array.isArray(customerOrg.addresses) && customerOrg.addresses[0]) ? customerOrg.addresses[0] : null;
  const billAddrText = billAddr0 ? [billAddr0.line1, billAddr0.line2].filter(Boolean).join('\n') : '';
  [inv.customer].concat(wrapLines(billAddrText, colGap - margin - 10, 9))
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

  // ---- Notes (Rev2.4) --------------------------------------------------------
  if (inv.notes) {
    y -= 30;
    ensureSpace(24);
    leftText('Notes:', margin, y, 10, { bold: true, color: labelGray }); y -= 13;
    wrapLines(inv.notes, pageWidth - margin * 2, 9).forEach(function (line) {
      ensureSpace(12);
      leftText(line, margin, y, 9); y -= 12;
    });
  }

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

// Rev2.4: the Packing Slip - same letterhead system as the Invoice (logo,
// light-blue header band) but no pricing and no "Ways to Pay" footer, per
// the reference template. partsByNumber (lowercased Part Number -> sanitized
// Part) supplies the Customer Part #/Manufacturer/Manufacturer Part #
// columns, since that data lives on the Parts master, not the invoice line.
async function buildPackingSlipPdf(inv, selfOrg, customerOrg, partsByNumber) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 612, pageHeight = 792;
  const margin = 44;

  const bandBg = rgb(0.925, 0.941, 0.976);
  const brandBlue = rgb(0.106, 0.243, 0.706);
  const navyDark = rgb(0.098, 0.145, 0.298);
  const ink = rgb(0.1, 0.1, 0.12);
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
  // ISO date input ("YYYY-MM-DD") -> MM/DD/YYYY for display, matching the
  // Dessimate PO PDF's fmtDateMDY; anything else (already-formatted, free
  // text, blank) passes through unchanged rather than risk mangling it.
  function fmtDateMDY(s) {
    const str = (s || '').toString().trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
    return m ? (m[2] + '/' + m[3] + '/' + m[1]) : str;
  }

  const headerHeight = 240;
  const colGap = margin + 230;

  page.drawRectangle({ x: 0, y: pageHeight - headerHeight, width: pageWidth, height: headerHeight, color: bandBg });

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
  rightText('PACKING SLIP', pageWidth - margin, ry, 22, { bold: true, color: brandBlue }); ry -= 26;
  [
    ['Invoice Number:', inv.invoiceNumber || ''],
    ['Purchase Order Number:', (Array.isArray(inv.customerPoRefs) && inv.customerPoRefs.length) ? inv.customerPoRefs.join(', ') : (inv.customerPoRef || '')],
    ['Date:', fmtDateMDY(inv.invoiceDate)],
    ['Ship Via:', inv.shipVia || ''],
    ['Ship Date:', fmtDateMDY(inv.shipDate)]
  ].forEach(function (row) {
    rightText(row[0], pageWidth - margin - 100, ry, 10, { bold: true });
    rightText(row[1], pageWidth - margin, ry, 10);
    ry -= 15;
  });

  let ly = logoBottom - 16;
  leftText((selfOrg && selfOrg.name) || 'Dessimate LLC', margin, ly, 10, { bold: true }); ly -= 13;
  let selfAddrText = inv.fromAddress;
  if (!selfAddrText) {
    const a0 = (selfOrg && Array.isArray(selfOrg.addresses) && selfOrg.addresses[0]) ? selfOrg.addresses[0] : null;
    selfAddrText = a0 ? [a0.line1, a0.line2].filter(Boolean).join(', ') : '';
  }
  wrapLines(selfAddrText, colGap - margin - 10, 9).forEach(function (line) { leftText(line, margin, ly, 9); ly -= 12; });

  let cy = logoBottom - 16;
  [selfOrg && selfOrg.salesEmail, selfOrg && selfOrg.phone, selfOrg && selfOrg.website].filter(Boolean).forEach(function (line) {
    leftText(line, colGap, cy, 9); cy -= 12;
  });

  const by = Math.min(ly, cy) - 18;
  leftText('Bill To:', margin, by, 10, { bold: true });
  leftText('Ship To:', colGap, by, 10, { bold: true });
  let by1 = by - 13;
  const billAddr0 = (customerOrg && Array.isArray(customerOrg.addresses) && customerOrg.addresses[0]) ? customerOrg.addresses[0] : null;
  const billAddrText = billAddr0 ? [billAddr0.line1, billAddr0.line2].filter(Boolean).join(', ') : '';
  [inv.customer].concat(wrapLines(billAddrText, colGap - margin - 10, 9))
    .filter(Boolean).forEach(function (line) { leftText(line, margin, by1, 9); by1 -= 12; });
  let by2 = by - 13;
  const shipLines = wrapLines(inv.shipTo || '', pageWidth - margin - colGap - 10, 9);
  (shipLines.length ? shipLines : ['—']).forEach(function (line) { leftText(line, colGap, by2, 9); by2 -= 12; });

  // ---- Line items table (no pricing - Customer/Manufacturer part info from
  // the Parts master) -----------------------------------------------------
  let y = pageHeight - headerHeight - 34;
  const cols = [
    { key: 'customerPart', label: 'Customer Part #', x: margin, w: 116 },
    { key: 'mfgPart', label: 'Manufacturer Part #', x: margin + 120, w: 116 },
    { key: 'customerName', label: 'Customer Part Name', x: margin + 240, w: 150 },
    { key: 'manufacturer', label: 'Manufacturer', x: margin + 394, w: 90 },
    { key: 'qty', label: 'Quantity', x: margin + 488, w: 52, right: true }
  ];
  const tableRight = margin + 540;

  function ensureSpace(h) {
    if (y - h < 40) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      y = pageHeight - 40;
    }
  }

  const headerRowH = 22;
  page.drawRectangle({ x: margin, y: y - headerRowH + 7, width: tableRight - margin, height: headerRowH, color: navyDark });
  cols.forEach(function (c) {
    const lx = c.right ? c.x + c.w - fontBold.widthOfTextAtSize(c.label, 8) : c.x;
    page.drawText(c.label, { x: lx, y: y - 7, size: 8, font: fontBold, color: rgb(1, 1, 1) });
  });
  y -= headerRowH + 6;

  inv.lines.forEach(function (l) {
    ensureSpace(20);
    const part = partsByNumber[(l.partNumber || '').toLowerCase()] || null;
    const row = {
      customerPart: (part && part.customerPartNumber) || l.partNumber || '',
      mfgPart: (part && part.manufacturerPartNumber) || '',
      customerName: l.description || '',
      manufacturer: (part && part.manufacturer) || '',
      qty: l.qtyShipped
    };
    cols.forEach(function (c) {
      const s = row[c.key] == null || row[c.key] === '' ? '—' : String(row[c.key]);
      const vx = c.right ? c.x + c.w - font.widthOfTextAtSize(s, 9) : c.x;
      page.drawText(s, { x: vx, y: y, size: 9, font: font, color: ink });
    });
    y -= 8;
    page.drawLine({ start: { x: margin, y: y }, end: { x: tableRight, y: y }, thickness: 0.5, color: lineGray });
    y -= 14;
  });

  return pdfDoc.save();
}

async function handleGenerateDessimatePackingSlipPdf(env, origin, id, accessLevel, organization) {
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

  const partsState = await readJsonArrayFile(env, PARTS_FILE_PATH);
  const partsByNumber = {};
  partsState.items.map(sanitizePart).forEach(function (p) {
    if (p.partNumber) partsByNumber[p.partNumber.toLowerCase()] = p;
  });

  let pdfBytes;
  try {
    pdfBytes = await buildPackingSlipPdf(clean, selfOrg, customerOrg, partsByNumber);
  } catch (e) {
    return json({ message: 'Could not generate PDF: ' + (e && e.message ? e.message : e) }, 500, origin);
  }
  return pdfResponse(pdfBytes, 'Dessimate Invoice ' + clean.invoiceNumber + ' Packing Slip.pdf', origin);
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
  return { ok: true, username: verified.u, impersonatedBy: verified.ib || null };
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
