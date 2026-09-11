# Dessimate Forms Backend — deploy guide

This is the small backend that makes staff logins possible. It holds your real
GitHub token (nobody else ever sees it) and gives each staff member their own
username/password instead of a GitHub account. Follow this once to get it
live — takes about 10–15 minutes.

## 0. What you'll need

- The free Cloudflare account you just created.
- Node.js installed on your computer (if you don't have it: https://nodejs.org — grab the LTS version, click through the installer).
- A GitHub Personal Access Token — same kind you were pasting into the app before, except now **only you** need to create it, once, for the backend itself.

## 1. Install the Cloudflare CLI (`wrangler`)

Open a terminal and run:

```
npm install -g wrangler
npx wrangler login
```

The second command opens your browser and asks you to approve access to your
Cloudflare account — click Allow.

**Note:** every command below uses `npx wrangler ...` rather than plain
`wrangler ...`. On some computers (Windows especially) the plain `wrangler`
command isn't found even after installing it, because npm's global install
location isn't on your PATH. `npx wrangler` sidesteps that — it works
regardless — so just always type the `npx` version and you won't hit it.

## 2. Get the worker files onto your computer

Download the `worker/` folder (the one this README is in) and open a
terminal inside it, e.g.:

```
cd path/to/worker
```

## 3. Create a GitHub token for the backend to use

1. Go to github.com → click your profile photo → **Settings**
2. Scroll down the left sidebar to **Developer settings**
3. **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
4. Give it a name like "Dessimate Forms Backend"
5. Under **Repository access**, choose "Only select repositories" and pick `RBS_Dessimate_Forms_Portal`
6. Under **Permissions → Repository permissions**, set **Contents** to **Read and write**
7. Generate it and copy the token (starts with `github_pat_...`) — you won't be able to see it again

## 4. Set the backend's secrets

Still in the `worker/` folder, run each of these. Wrangler will prompt you to
paste the value after you hit enter:

```
npx wrangler secret put GITHUB_TOKEN
```
Paste the GitHub token from step 3.

```
npx wrangler secret put SESSION_SECRET
```
Paste any long random string — this just signs staff login sessions, nobody
needs to remember it. If you're not sure what to use, run this in a second
terminal and paste its output:
```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```
npx wrangler secret put STAFF_USERS
```
Paste a JSON array of your staff logins — see **Adding staff** below for how
to generate each entry. For now, to get moving, you can start with just
yourself, e.g.:
```
[{"username":"roberto","salt":"<from the tool>","hash":"<from the tool>"}]
```

## 5. Deploy

```
npx wrangler deploy
```

This prints a URL that looks like:
```
https://dessimate-forms-backend.<your-subdomain>.workers.dev
```
That's your backend's address. Copy it.

Visit `<that URL>/health` in your browser — you should see
`{"ok":true,"service":"dessimate-forms-backend"}`. If you see that, it's live.

## 6. Point the Portal pages at it

Open every page listed below, find this line near the top of the `<script>`
section in each (search for `WORKER_BASE_URL`):

```js
var WORKER_BASE_URL = 'https://dessimate-forms-backend.YOUR-SUBDOMAIN.workers.dev';
```

Replace it with the real URL from step 5, in **every one** of these files,
then upload them to your repo (replacing the old versions) the same way you
have been:

`index.html`, `PDIR_Form_Filler.html`, `PDIR_Portal.html`, `PDIR_Users.html`,
`PDIR_Organizations.html`, `PDIR_Parts.html`, `PDIR_CustomerPOs.html`,
`PDIR_DessimatePOs.html`, `PDIR_SupplierInvoices.html`,
`PDIR_DessimateInvoices.html`, `APQP.html`, `Instructions.html`.

## 7. Try it

Open `index.html` — this is the dashboard and the front door to the whole
system (see "The dashboard" below). You should see a **Staff Sign-In** box
instead of a "Connect GitHub" button. Log in with the username/password you
set up in step 4 — you should see the sidebar build itself around what your
account is allowed to see.

## Rev2 changes (what's new since the first release)

A quick summary of everything added since the version this README originally
shipped with — each is covered in more detail in its own section below,
linked here for a fast overview if you're updating an existing deployment.

- **Supplier and Customer logins now actually work** (see "Access levels"
  and "Managing users" below) — a signed-in Supplier or Customer only ever
  sees their own organization's Parts, Dessimate POs, Supplier Invoices,
  Customer POs, Dessimate Invoices, and PDIRs, automatically, with no extra
  setup beyond giving that organization's contact a login the same way you
  would a Team member.
- **Cross-module links** — a Dessimate PO's row links to its Customer PO and
  its shipment's spot on the PDIR Portal; a Supplier Invoice links back to
  the Dessimate PO it's billed against. Following one highlights the
  matching row (or filters the Portal to that one shipment) so you land
  exactly where you were headed instead of having to search.
- **Parts: Attachments** (was a single "Drawing" file) — up to 20 files per
  part now. See "Managing parts" below.
- **Voluntary numbering** — PO Number, Shipment Number, and Invoice Number
  are still auto-assigned by default, but can now be typed in manually when
  you need to (e.g. matching a legacy sequence). See "Automatic numbering"
  below.
- **Related Dessimate POs** — link POs that belong together (e.g. a split
  shipment) and see the connection from either one's row. See "Automatic
  numbering" below (same section).
- **PDIR: Part Pictures relabeled** — the 9 photo slots are now grouped on
  screen and in the generated PDF as "Part 1 / Part 2 / Part 3", 3 photo
  angles each, instead of a flat "Photo 1–9" — purely a labeling change, so
  existing saved drafts and PDFs aren't affected.
- **PDIR: Sign-Off redesigned** — split into a **Supplier Sign-off** (with
  an optional stamp image upload) and a **Dessimate Sign-off**. The
  Dessimate side is now a dropdown of your Dessimate Team members instead of
  free-text — picking a name fills in the signature fields for you and, if
  that person already has an **Approver Stamp** on file (see "Managing
  users" below — the same stamp used on Dessimate PO PDFs), it's stamped
  onto the generated PDIR automatically, with no separate upload needed.

## Rev2.2 changes

- **App version stamp is now backend-owned** — the "DSCM vX.X · Built ..."
  text shown in the sidebar/footer of every page is fetched from
  `GET /app-config` (public, no login needed - it's cosmetic, not data)
  instead of being hand-typed into all 11 pages. Bump it with `PUT
  /app-config` (Super Admin only, body `{"version": "2.3", "builtLabel":
  "Built ..."}`) — the pages already deployed pick it up on their next
  load, no frontend redeploy required. Falls back to the hardcoded text
  baked into each page if the backend is unreachable.
- **Dessimate POs: Attachments** — up to 20 files per PO (packing lists,
  supplier drawings, anything relevant to the shipment), same
  upload/preview/View pattern as Parts and Organizations documents. Stored
  under `dessimate_po_docs/<id>/` in storage.
- **Parts: a 3D viewer for `.stp`/`.step` attachments** — clicking **View**
  on a STEP file now renders it in the same in-page viewer used for
  PDFs/images (drag to rotate, scroll to zoom, right-drag to pan) instead of
  falling back to Download-only. Runs entirely client-side: three.js and
  occt-import-js (a WASM build of OpenCascade's STEP reader) load from a CDN
  the first time a `.stp`/`.step` file is opened, and the file's bytes never
  leave the browser.
- **APQP: Feasibility Studies sub-items lettered a/b** — "0. Feasibility
  Studies" now renders as one grouped container holding **a. Feasibility
  Study Presentation** and **b. CFD Studies**, each still with its own
  independent files/comments, instead of two standalone rows that both
  showed a duplicate "0".
- **Sign-in lockout after 3 failed attempts** — any account except a Super
  Admin is locked after 3 wrong-password sign-ins in a row; the sign-in form
  then shows "This account has been locked after 3 unsuccessful sign-in
  attempts. Please contact your Dessimate contact to reset your password."
  instead of the usual "Invalid username or password", even if the correct
  password is entered afterward. Super Admin is deliberately exempt, so
  there's always at least one way in. The only way out is a **Super Admin
  resetting that person's password** from the Users page's Edit form — doing
  so clears the lockout automatically. A locked account shows a red
  **Locked** pill next to its Active/Inactive status on the Users page, so
  you know who actually needs that reset instead of having to be told the
  username.
- **Sign-in form: a note and an attempt counter** — the Staff Sign-In box on
  every page now shows a standing note ("Please check the username and
  password provided by your Dessimate contact. Your account will be locked
  after 3 unsuccessful login attempts.") and, after a wrong password, a
  running "Sign-in attempt N of 3" counter beneath the error message, so
  someone gets real-time warning before they lock themselves out.

## Rev2.3 changes

- **Dessimate Invoice PDF redesigned** — backend-only change (no frontend
  edits): `buildDessimateInvoicePdf` now renders a branded letterhead (logo,
  light-blue header/footer bands, dark-navy line-items table, a "Ways to
  Pay" footer, and the standard procurement disclaimer) matching the
  reference template supplied for this revision. The Dessimate logo is
  embedded as a base64 constant (`DESSIMATE_LOGO_JPG_BASE64`) so it always
  renders regardless of whether a logo happens to be uploaded through the
  Organizations page. The line-item columns are unchanged (Part #,
  Description, UOM, Qty Shipped, Unit Price, Total Price) — the reference
  image's Manufacturer/Manufacturer Part # columns aren't in the current
  data model and adding them would need a frontend change, which this
  revision deliberately avoided. "Bill To" pulls the matching Customer
  organization's address (if one exists); "Ship To" is the invoice's
  existing free-text field. The payment-method row uses plain text badges
  (Apple Pay/Visa/Mastercard/Discover/Bank/PayPal), not real card-network
  logos, since no licensed brand assets were available to embed. The
  Dessimate PO PDF template is untouched.

## Rev2.4 changes

- **Multiple addresses, any organization** — the "+ Add Address" editor
  (previously Self-org-only) is now on every organization's Edit form,
  entered on 2 lines (street, then city/state/zip — `{label, line1, line2}`
  per entry, replacing the old single-string `address` field on each
  addresses[] entry; a legacy single-line entry still reads fine, its whole
  value landing in `line1`). A org's saved addresses back the **Ship To**
  dropdown on the Dessimate Invoice form (Customer's addresses) and the
  **From** dropdown (Self org's addresses, defaulting to the first one,
  overridable) — both dropdowns fill a free-text field you can still hand-edit.
- **Payment Terms is now a managed list** — a new `paymentTerms` array field
  on Organizations (meaningful on the Self org), edited from the
  Organizations page. Every "Payment Terms" field system-wide (Customer PO
  still free-text - out of scope this round; Dessimate PO, Dessimate
  Invoice) is now a dropdown sourced from that list instead of freehand text.
- **Notes/Comments** — a plain editable textarea on the Dessimate PO and
  Dessimate Invoice forms (`notes` field). Printed on the generated Invoice
  PDF when present; not printed on the PO PDF (data-only there, matching how
  it wasn't requested to appear on that document).
- **Super Admin "Log in as" (impersonation)** — replaces the "second
  password per user" idea from the product brief with the standard-practice
  alternative: a Super Admin gets a real session as the target user, without
  ever seeing or handling that person's actual password, and every use is
  logged (`data/impersonation_log.json` - admin, target, timestamp). Not
  available for other Super Admin accounts or accounts without an active
  login. `POST /admin/users/<id>/impersonate` issues the session; the
  returned token carries who's impersonating (`ib` in the JWT payload, `GET
  /me`'s `impersonatedBy`). The Users page and the dashboard (`index.html`)
  show a "Viewing as X (impersonated)" banner with a **Return to my
  account** button while active (the admin's own session is stashed in
  `localStorage` under `dessimate_impersonator_session` until then) — other
  module pages don't show the banner, though the impersonated session works
  on all of them; navigate back to Users or the dashboard to switch back.
- **One Dessimate PO/Invoice can bill against multiple Customer POs** —
  `customerPoRef` (string) is now `customerPoRefs` (array) on both Dessimate
  POs and Dessimate Invoices, edited as a checklist instead of a single
  dropdown; a legacy record with only the old field still reads back as a
  one-item array, and `customerPoRef` is still returned (as the first entry)
  for any old client. Printed on both PDFs as a comma-joined list.
- **Related Dessimate POs: searchable** — the picker on the Dessimate PO
  form is a full checklist of every other PO in the system already; at scale
  that got unwieldy to scroll, so a search box now filters what's shown by
  PO number, supplier, or shipment number. The checked set survives
  filtering (it's tracked separately from what's currently visible), so
  searching never silently drops a pick.
- **Dessimate PO as a field on Dessimate Invoices** — a new `dessimatePoRef`
  field (dropdown of Dessimate POs) for tracing an invoice back to the
  internal procurement PO, separate from the Customer PO(s) above.
- **Generate Invoice / Generate Packing Slip buttons, in the Edit modal** —
  next to the invoice's other fields (only shown once the invoice has been
  saved once - PDFs are generated from saved data). Both open in the same
  in-page viewer the row-level "View PDF" button already uses.
- **Packing Slip** — a new PDF (`GET
  /dessimate-invoices/<id>/packing-slip`), same letterhead system as the
  Invoice but no pricing and no "Ways to Pay" footer, matching the supplied
  reference. Its Customer Part #/Manufacturer/Manufacturer Part # columns
  come from two new Parts fields (`manufacturer`, `manufacturerPartNumber`,
  alongside the existing `customerPartNumber`) looked up by Part Number at
  generation time - nothing new stored per invoice line.
- **Shipment Number on Dessimate Invoices** — a new `shipmentNumber` field,
  a dropdown sourced from the PDIR index (`GET /pdir-index`) rather than
  freehand text, and printed on the generated Invoice PDF.
- **Invoice Number is editable after creation** — previously immutable once
  assigned (like the Dessimate PO's PO Number/Shipment Number still are).
  Nothing else in the system references a Dessimate Invoice by its number
  (unlike PO Number, which Supplier Invoices and the PDIR Portal link
  against), so this was safe to change with no cross-references to update -
  still unique (unless renamed onto an existing invoice), and a numeric
  value still bumps `data/counters.json`'s counter past itself so a later
  auto-assigned number can't collide with it. The one thing this doesn't
  protect against is a customer who already has a copy of the invoice under
  the old number — that's a process risk, not a technical one, worth being
  deliberate about before renaming a sent invoice.
- **Deleted Invoices view** — `GET /dessimate-invoices/deleted` (Admin+)
  lists what's been soft-deleted; a new **Deleted Invoices** button opens
  them in a modal with a **Restore** action per row (`POST
  /dessimate-invoices/<id>/restore`).
- **Invoice line Part Number is now free-typed** — was a dropdown-only
  `<select>` (the data layer already accepted any string); now a text input
  with a Parts-master-backed `<datalist>` for suggestions, matching how
  Description already worked. Picking or typing an exact Parts match still
  auto-fills Description.
- **Duplicate** — a button per row on the Dessimate Invoices list opens the
  Add modal pre-filled from that invoice's data (a fresh Invoice Number,
  attachments not carried over since those are files that belong to the
  original record).

## Rev2.5 changes

- **Customer PO: Attachments** (was a single "Original PO" `sourcePdf`
  file) — up to 20 files, same upload/preview/View pattern as Parts,
  Dessimate POs, and Dessimate Invoices. A record saved before this still
  reads fine (its one `sourcePdf` shows up as the sole entry in
  `attachments`, the same migration Parts' old single "drawing" field got);
  `sourcePdf` is never written by new saves.
- **Customer PO: Notes/Comments** — a plain editable textarea (`notes`
  field), same as the Dessimate PO and Dessimate Invoice already have.
- **In-page document viewer enlarged, fixed 1.8:1 landscape aspect ratio**
  — Customer POs only, per the request. The visible area (`.viewerBody`)
  now keeps a 1.8 width:height ratio via CSS `aspect-ratio` instead of
  stretching to fill the overlay, and the panel itself is bigger (`width:
  min(96vw, 1700px)`, was capped at 980px). On a short viewport the ratio
  yields a little (a `max-height` safety cap takes over) rather than ever
  overflowing the screen. The other pages' viewers are unchanged.

## Rev2.6 changes

- **About DSCM** — a card on the dashboard's (`index.html`) welcome view,
  shown to everyone, with a short description of the system pulled from
  `/app-config`'s new `aboutText` field. A Super Admin sees an **Edit**
  button (hidden for everyone else, both in the UI and because `PUT
  /app-config` itself is still Super-Admin-gated server-side) opening a
  dialog with the About text plus **Current Version** and **Built Label**
  in their own small boxes — the same `version`/`builtLabel` fields every
  page's footer/sidebar stamp already reads, so saving here is now the
  normal way to bump the version (previously only possible via a direct
  API call - see the Rev2.2 entry above). No new field is exposed in
  GET /app-config's public response beyond `aboutText` alongside the
  existing two.

## The dashboard (`index.html`)

`index.html` is a persistent left sidebar with a content pane next to it —
every module page (Parts, the PO/Invoice pages, APQP, Users, Organizations,
the PDIR portal) loads inside that pane instead of you navigating to a
separate URL for each one. It's built once you sign in:

- The sidebar is grouped into **Production Modules**, **Pre-Production
  Modules**, **Admin Modules**, and **Resources**, and only shows the
  sections and links your signed-in access level can actually use — a Team
  Member never sees an Admin Modules section at all; an Admin sees it but
  not **Users** or **Organizations**, which stay Super Admin-only.
- Click a link and that module loads into the content pane; the page title
  above it updates, and an **Open in new tab** link is always there if you'd
  rather work in a full tab (bookmarking a module directly still works too —
  every page still functions perfectly on its own, opened standalone).
- Your last-open module is remembered for the rest of the browser tab's
  session, so refreshing `index.html` puts you back where you were.
- On a phone or narrow window, the sidebar becomes a slide-out drawer behind
  a hamburger button instead of a fixed column.

Nothing about the individual module pages changed to make this work — each
one still runs exactly as it did as a standalone page (their own README
sections above and below all still apply); the dashboard just wraps them.
Anyone who bookmarked or shared a link straight to, say,
`PDIR_DessimatePOs.html` doesn't need to change anything.

## Access levels (who can see Users & Organizations)

Every signed-in person resolves to one of five access levels, enforced by
the backend itself (not just hidden buttons):

- **Super Admin** — everything, including the **Users** and
  **Organizations** pages (personal contact info and login credentials).
- **Admin** — everything a Team Member can, plus the Customer PO and
  Dessimate Invoice modules.
- **Team Member** — Dessimate PO, Supplier Invoice, PDIR, Parts (read and
  write), APQP. This is the default for any Dessimate Team member who
  hasn't been given a different level.
- **Supplier** / **Customer** — read-only, and automatically scoped to that
  organization's own data (their own Parts, POs, Invoices, and PDIRs only —
  never anyone else's). See **Rev2 changes** below for how this scoping
  works and how to turn on a real login for one.

You set someone's level from their **Access Level** dropdown on the Users
page (only shown for Dessimate Team members — a Supplier or Customer
contact's level always matches their relationship, automatically). Anyone
who could reach Users/Organizations before this existed (originally just
Roberto and Amy) keeps that access automatically even without an explicit
level set, so nothing breaks on upgrade — set an explicit level from here on
for anyone new.

## Managing users (staff, suppliers, customers)

There's now a **Users** page in the Portal (linked from the home page and
from the PDIR Portal header) for this — you shouldn't need
`password_hash_tool.html` or `wrangler secret put STAFF_USERS` again after
you've deployed this version. Open the Users page, log in, and:

- **Add User** — for a staff member, tick "Give this person a login" and set
  a username/password; leave it unticked (or pick Supplier/Customer) to just
  keep their contact info on file with no Portal access.
- **Access Level** — for a Dessimate Team member, choose Team Member, Admin,
  or Super Admin (see above). Not shown for Supplier/Customer contacts.
- **Approver Stamp** — an optional image/PDF for anyone who approves
  Dessimate POs. Pick that person as the **Approver** on a Dessimate PO and
  their stamp is embedded on the generated PO PDF automatically. (The stamp
  is Dessimate PO only — Dessimate Invoices are never stamped.)
- **Demo account** — tick this for an account that only exists for team
  demos, so it's clearly labeled in the list (see "Demo accounts" below).
- **Edit** any row to change their Organization, Role, Email, Phone, or
  Active status, reset their password, or turn their login on/off.
- **Delete** removes an entry entirely. Turning off **Active** instead is the
  normal way to revoke someone's access while keeping their record — it
  blocks their login immediately.
- Rows marked **Not migrated** are logins that still only exist in the old
  `STAFF_USERS` secret (see below) — click **Edit** on one, fill in what you
  know, and **Save** to bring it into the new list. The **Import existing
  logins** button does this for all of them at once, with blank profile
  fields you can fill in afterward.

This is all stored in one file in your repo (`data/users.json`), read and
written only by the backend — nobody's password can be seen by browsing the
repo or by another staff member's session, even though the file lives
alongside your PDIRs.

### Demo accounts for team demos

You can create demo **Organizations** (a "Demo Supplier Co." and a "Demo
Customer Co." work well) and demo **Users** contacts linked to them — tick
**Demo account** on each so they're clearly marked in the Users list and
never mistaken for a real contact.

As of Rev2, a demo Organization can also be given a real Supplier/Customer
login (same "Give this person a login" pattern Team members use) — once
signed in, that account only ever sees its own organization's Parts, POs,
Invoices, and PDIRs (see **Rev2 changes** below), so it's now safe to hand a
demo account a real login for a walkthrough without it showing the whole
system.

## Managing organizations (suppliers & customers)

There's also an **Organizations** page (linked from the home page, the PDIR
Portal header, and the Users page) for keeping a directory of the suppliers
and customers Dessimate works with, separate from the Users directory of
people:

- **Add Organization** — set the name and whether it's a **Supplier**, a
  **Customer**, or **Self** (Dessimate's own record — see below), plus
  address/phone/website if you have them.
- **Logo** — an optional image/PDF, shown on that organization's login
  screen once the Supplier/Customer portals exist.
- **Self Organization Details** — only shown when Relationship is **Self**.
  There's exactly one Self organization (creating a second is blocked) — use
  it for Dessimate's own addresses (e.g. "Delaware (Registered)" and
  "California (Office)" — add as many as you need with **+ Add Address**)
  and the two emails that'll appear on generated documents: **Sales Email**
  on Dessimate Invoices, **Purchasing Email** on Dessimate POs.
- **Documents** — each organization has three dedicated slots (Company
  Presentation, NDA, Self-Assessment) plus an **Additional Documents**
  section for anything else — contracts, certificates, whatever you need on
  file. Click **View** to preview a PDF or image right in the page, or
  **Download** to save it. Files are chosen when you fill out the form but
  aren't uploaded until you click **Save**.
- **Edit** any organization to update its details or documents; **Delete**
  removes the organization's record only — files already uploaded for it
  stay in the repo (under `org_docs/<id>/`), just no longer linked to
  anything, in case you need them back.

This is stored in `data/organizations.json` in your repo, alongside
`data/users.json`, managed only through the backend the same way.

### Organization dropdowns in Users and the PDIR form

Once an organization exists here, it shows up automatically:

- On the **Users** page, when you set someone's relationship to Supplier or
  Customer, the Organization field becomes a dropdown of just that type of
  organization (a Supplier contact only sees Suppliers, a Customer contact
  only sees Customers) — instead of typing the name freehand. Dessimate Team
  members keep a free-text Organization field, since "Dessimate" itself
  isn't an entry in this list.
- On the **PDIR form**, a new **Supplier / Organization** dropdown (in
  Shipment & Part Information) lists your Suppliers, so each inspection
  report can record which supplier it's for. It's included on the generated
  PDF and saves with the draft like any other field.

If someone's stored organization was typed before this list existed (or the
organization was since renamed or removed), it's kept as-is with a "(not in
Organizations list)" note next to it in the dropdown — nothing is silently
lost, you can just repoint it at the real entry whenever it's convenient.

## Managing parts (the part master)

There's also a **Parts** page (linked from the home page's Admin panel, and
the header of every other admin page) — the master list of part numbers,
linked to a Customer and any number of Suppliers:

- **Add Part** — only **Part Number** is required. The rest (Customer Part
  Number, Description, Revision, Status, Drawing Number, UOM, Category,
  Notes) is optional.
- **Customer** — a single dropdown of your Customer organizations (a part is
  made for one customer program).
- **Suppliers** — a checklist of your Supplier organizations; check as many
  as actually make this part.
- **Attachments** (Rev2 — was a single "Drawing" file) — up to 20 files per
  part (drawings, specs, anything else relevant), same upload/preview/View
  pattern as Organizations' documents. A Part saved before Rev2 with a single
  Drawing on file still shows it here as its first attachment — nothing was
  lost in the upgrade. Stored under `part_docs/<id>/` in the repo.
- **Edit** any part to update it; **Delete** removes the part's record only
  — its attachments, if any, stay in the repo, just unlinked.

This is stored in `data/parts.json` in your repo, alongside
`data/users.json` and `data/organizations.json`, managed only through the
backend the same way. Part Numbers must be unique (case-insensitive).

### Part Number dropdown on the PDIR form

Once a part exists here, the PDIR form's **Part Number** field becomes a
dropdown sourced from this list (instead of free text) — selecting a part
auto-fills **Part Description** from its record, which you can still edit
by hand afterward. Same "(not in Parts list)" fallback behavior as the
Organization dropdown if a saved draft references a part number that's
since been renamed or removed.

This is also the foundation for future Supplier/Customer portals: since
Users, Organizations and now Parts are all linked by organization name,
"which parts/PDIRs/APQP records can this signed-in organization see" will
simply be "is my organization the Customer or one of the Suppliers on this
part" — no new permission system needed when that's built.

## APQP (pre-production sign-off, per Part)

The **APQP** page (Pre-Production Modules in the sidebar) tracks the
standard nine-item APQP/PPAP-style checklist against a Part — Design
Record, Control Plan, Dim Results, M/P Tests, IPS, Sample Product, Master
Sample, Other, and PSW — so everyone can see at a glance which deliverables
are in for a part that's about to go into production, and read the
back-and-forth on each one.

- **Adding a Part** — click **Add Part to APQP** and pick from a dropdown of
  Parts (from the Parts master, above) that aren't already tracked here. A
  Part can only be on the APQP list once; its name is captured from the
  Parts record at the moment you add it.
- **The checklist** — opening a Part shows all nine items, always in the
  same fixed order, each showing how many files and comments it has.
  Expanding an item reveals two independent things:
  - **Files** — upload as many as you need to that one item (its own
    upload/preview pattern, same as everywhere else in the app); each file
    can be removed individually. Files on one item never affect another.
  - **Comments** — a running, append-only log for that item. Anyone
    Team Member and up can post one; your username and a timestamp are
    attached automatically (never something you can type in yourself), and
    nothing can be edited or deleted once posted — it's a record of what was
    said and when, not a live-editable note.
  Both save immediately when you act (upload a file, post a comment) —
  there's no separate "Save" step for the checklist as a whole.
- **PSW** — the ninth item keeps a direct shortcut into the existing
  **PSW Form Filler** tool (`PSW_Form_Filler.html`) alongside its own
  files/comments, rather than duplicating that tool's functionality here.
- **Removing a Part from APQP** takes it off this list entirely (its Parts
  master record, and any files already uploaded to its checklist items,
  are untouched in the repo — only the APQP tracking record itself goes
  away).

This is stored in `data/apqp.json`, one record per Part, with uploaded
files living under `apqp_docs/<record id>/<item>/` in the repo — the same
storage pattern as every other module.

## Instructions (the built-in how-to guide)

The **Instructions** page (Resources in the sidebar) is a short, role-specific
walkthrough of the workflow — no data of its own, just numbered steps with a
link to the page each one happens on, so someone new doesn't have to piece
the system together from the module list.

- There are four guides — **Admin**, **Dessimate Team Member**, **Supplier**,
  **Customer** — each covering only the steps that role actually does, and
  each gated the same way the module it describes is gated:
  - A **Team Member** sees only their own guide (issuing the Dessimate PO,
    through recording the Supplier Invoice).
  - An **Admin** or **Super Admin** sees all four guides as tabs, defaulting
    to their own (the full order-to-cash workflow) — useful for training or
    supporting anyone else's part of it.
  - The **Supplier** and **Customer** guides describe what those roles will
    see once their portal logins are enabled (see "Demo accounts" above) —
    each is clearly marked as a preview until then.
- Every step links straight to the real page it's describing, so the guide
  stays accurate as long as the pages it links to do.

## Customer POs, Dessimate POs, Supplier Invoices & Dessimate Invoices

Four pages cover the full order-to-cash cycle, in the order paperwork
actually flows: a customer sends Dessimate a PO, Dessimate issues its own PO
to a supplier against it, the supplier ships and invoices Dessimate, and
Dessimate invoices the customer. Each is its own page (linked from every
other admin/production page's header) and its own file in the repo, but
they cross-reference each other by dropdown wherever it makes sense.

| Page | Who can add/edit | Stored in | Numbering |
|---|---|---|---|
| **Customer POs** | Admin, Super Admin | `data/customer_pos.json` | You type the customer's own PO number — it's theirs, not generated here. |
| **Dessimate POs** | Team Member and up | `data/dessimate_pos.json` | **PO Number** and **Shipment Number** are both assigned automatically when you click Save (see below) — neither can be typed or edited afterward. |
| **Supplier Invoices** | Team Member and up | `data/supplier_invoices.json` | You type the supplier's own invoice number — it's theirs, not generated here. |
| **Dessimate Invoices** | Admin, Super Admin | `data/dessimate_invoices.json` | **Invoice Number** is assigned automatically when you click Save, and can't be edited afterward. |

### Adding one

Each page's **Add** button opens the same kind of modal: header fields
(dates, the other party, terms), a line-items table you can add/remove rows
from (extended price and the document total are computed live as you type),
and — on Customer PO and Supplier Invoice — a place to attach the original
PDF you received. Dropdowns for Customer/Supplier, Part Number, and (where
relevant) the linked Dessimate PO are all sourced from the Organizations and
Parts directories, so add the organization or part there first if it's
missing. Choosing a Part Number auto-fills its Description, which you can
still edit by hand.

### Automatic numbering (Dessimate PO / Dessimate Invoice)

A single counters file, `data/counters.json`, tracks three sequences so
numbers are never reused or duplicated, even if two people save at the same
moment:

- **Dessimate PO Number** — a running number, continuing on from wherever
  your last system left off (currently starting at **3013**).
- **Shipment Number** — assigned together with the PO Number, one per
  Dessimate PO, in the form **YY-###** (e.g. `26-010`, `26-011`) — the
  two-digit year followed by a sequence that resets to `001` on January 1st
  each year.
- **Dessimate Invoice Number** — its own separate running number (currently
  starting at **3014**), independent of the PO/Shipment sequence.

You'll never need to touch this file directly — it's created automatically
with sensible starting values the first time it's needed, and every save
that assigns a number updates it as part of the same request.

**Voluntary numbering (Rev2)** — PO Number, Shipment Number, and Invoice
Number are still auto-assigned by default, but each now has an editable
field with a **Use System Number** button next to it. If you need to record
a number from elsewhere (e.g. matching a legacy sequence), type it in
instead — the backend rejects it with an error if that exact number is
already in use, and silently bumps its counter past whatever you typed, so
the next auto-assigned number never collides with it.

**Related Dessimate POs (Rev2)** — the Dessimate PO editor has a checklist
of every other Dessimate PO; check any that belong together (e.g. a
shipment split across multiple POs) and each linked PO shows a clickable
chip back to the other on the list page. The link is two-way automatically
— linking B to A also shows A linked to B, and unlinking either side
removes it from both.

### Generated PDFs ("View PDF")

Dessimate POs and Dessimate Invoices don't need a source file uploaded —
click **View PDF** on any row and the backend builds the document from that
row's data on the spot (letterhead, line-item table, totals) and shows it
right in the page, with a **Download** link. This is a real backend
template (not something hand-formatted in the browser), so the layout stays
consistent no matter who's viewing it, and it always reflects the latest
saved data. A Dessimate PO's PDF includes the **Approver's stamp** (see
above) when one is set; a Dessimate Invoice's PDF never does.

### Deleting

Customer PO, Dessimate PO, and Supplier Invoice deletes remove the row
outright (any attached source PDF stays in the repo, just unlinked, the same
as Organizations/Parts documents). **Dessimate Invoice delete is a soft
delete** — the row disappears from the list, but its Invoice Number is
never reused, so your invoice sequence stays gap-free and audit-clean even
after removing a mistaken entry.

### About the old STAFF_USERS secret

Nothing needs to change here for existing logins to keep working. The
backend still checks `STAFF_USERS` as a fallback for any username that
hasn't been touched in the new Users page yet — so Amy, Roberto, Komal, and
anyone else already set up keep signing in exactly as before, with no
action required. A login becomes fully "migrated" (and the secret stops
being consulted for it) the moment it's edited and saved once from the
Users page. You can leave the secret in place indefinitely; it's simply
ignored once every login in it has been migrated.

## About the GitHub repo's visibility

Now that every page and file is fetched through this backend (using your
GitHub token, held only on the server), the repo no longer needs to be
public for anything to work. If you'd like, you can switch it to **Private**
in the repo's Settings — nothing here will break, since staff never talk to
GitHub directly anymore.

## Costs

Cloudflare Workers' free tier covers 100,000 requests/day — a small internal
tool like this will use a tiny fraction of that. This should cost $0/month
unless your usage grows dramatically.
