/**
 * DSCM shared MFA login step - one copy of the "2nd factor" flow every
 * module page's own login form defers to, instead of each page hand-rolling
 * its own copy (which is how index.html/PDIR_Security.html/PDIR_Users.html
 * originally did it, before this file existed).
 *
 * Usage, inside a page's own authForm submit handler, right after a
 * successful (but possibly mfaRequired) POST /login response:
 *
 *   if (data.mfaRequired) {
 *     DscmMfaLogin.start(data, { baseUrl: WORKER_BASE_URL, onSuccess: function (session) {
 *       setSession(session);      // or that page's own equivalent
 *       hideAuthOverlay();
 *       var fn = pendingAfterAuth; pendingAfterAuth = null;
 *       if (fn) fn();
 *     } });
 *     return;
 *   }
 *
 * `data` is the parsed mfaRequired body straight from POST /login
 * ({ mfaRequired, mode: 'challenge'|'enroll_required', availableMethods,
 * pendingToken }). `opts.baseUrl` is that page's own WORKER_BASE_URL
 * (page scripts are IIFE-wrapped, so this can't be read off a global) and
 * `opts.onSuccess(session)` fires once a real session is issued, with the
 * same {token, username, expiresAt} shape POST /login already returns for a
 * no-MFA account - the page finishes exactly like a normal login from there.
 *
 * No markup needs to exist on the host page beyond the login form's own
 * #authOverlay - this module builds its own .authCard the first time
 * start() is called and appends it as a hidden sibling inside #authOverlay,
 * reusing that page's own .authCard/.authSub/.authError CSS and
 * --brand/--label/--line variables (already defined identically, give or
 * take a shade, on every page with a login form) so it matches the host
 * page's look with zero page-specific styling of its own.
 */
(function () {
  'use strict';

  // ---- QR code rendering (davidshimjs/qrcodejs - a genuine standalone
  // browser build, unlike the `qrcode` npm package's published files, which
  // are CommonJS-only and throw if loaded as a plain <script>) -------------
  var QRCODE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
  var qrCodeLoadPromise = null;
  function ensureQrCodeLib() {
    if (window.QRCode) return Promise.resolve();
    if (qrCodeLoadPromise) return qrCodeLoadPromise;
    qrCodeLoadPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = QRCODE_CDN;
      s.onload = function () { resolve(); };
      s.onerror = function () { qrCodeLoadPromise = null; reject(new Error('Could not load the QR code library — check your connection.')); };
      document.head.appendChild(s);
    });
    return qrCodeLoadPromise;
  }
  function renderQrCode(containerEl, text) {
    return ensureQrCodeLib().then(function () {
      containerEl.innerHTML = '';
      new window.QRCode(containerEl, { text: text, width: 178, height: 178, correctLevel: window.QRCode.CorrectLevel.M });
    });
  }
  function renderCodeList(containerEl, codes) {
    containerEl.innerHTML = '';
    codes.forEach(function (c) {
      var div = document.createElement('div');
      div.textContent = c;
      containerEl.appendChild(div);
    });
  }

  // ---- Lazy DOM construction ------------------------------------------------
  var CARD_ID = 'dscmMfaCard';
  var built = false;
  var els = {};
  var state = { pendingToken: null, mode: null, method: 'totp', baseUrl: '', onSuccess: null, passwordCard: null };

  function findPasswordCard(overlay) {
    var cards = overlay.querySelectorAll('.authCard');
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].id !== CARD_ID) return cards[i];
    }
    return null;
  }

  function buildCard() {
    if (built) return;
    var overlay = document.getElementById('authOverlay');
    if (!overlay) throw new Error('DscmMfaLogin: this page has no #authOverlay to attach to.');
    state.passwordCard = findPasswordCard(overlay);

    var card = document.createElement('div');
    card.className = 'authCard';
    card.id = CARD_ID;
    card.style.display = 'none';
    card.innerHTML =
      '<h2 id="dscmMfaTitle">Verification Required</h2>' +
      '<p class="authSub" id="dscmMfaSub">Enter the 6-digit code from your authenticator app.</p>' +
      '<form id="dscmMfaForm">' +
        '<div id="dscmMfaEnrollBlock" style="display:none;">' +
          '<div style="text-align:center; margin-bottom:10px;">' +
            '<div id="dscmMfaQr" style="width:180px; height:180px; border:1px solid var(--line); border-radius:8px; display:inline-block; overflow:hidden;"></div>' +
          '</div>' +
          '<p style="font-size:11.5px; color:var(--label); word-break:break-all; text-align:center; margin:0 0 12px;">' +
            'Can&rsquo;t scan? Enter this key manually: <strong id="dscmMfaSecretText"></strong>' +
          '</p>' +
        '</div>' +
        '<label>Code' +
          '<input type="text" id="dscmMfaCode" inputmode="numeric" autocomplete="one-time-code" maxlength="12">' +
        '</label>' +
        '<button type="submit" id="dscmMfaSubmitBtn">Verify</button>' +
        '<div style="display:flex; gap:8px; margin-top:8px;">' +
          '<button type="button" id="dscmMfaUseEmailBtn" style="background:#5b5f66; font-size:12px; padding:8px; display:none;">Use email code instead</button>' +
          '<button type="button" id="dscmMfaUseBackupBtn" style="background:#5b5f66; font-size:12px; padding:8px; display:none;">Use a backup code</button>' +
        '</div>' +
        '<div class="authError" id="dscmMfaError"></div>' +
      '</form>' +
      '<div id="dscmMfaBackupCodesBlock" style="display:none;">' +
        '<p class="authSub">Save these backup codes somewhere safe &mdash; each works once if you lose your device. They won&rsquo;t be shown again.</p>' +
        '<div id="dscmMfaBackupCodesList" style="font-family:monospace; font-size:13px; line-height:1.8; background:#f7f8fb; border:1px solid var(--line); border-radius:6px; padding:10px 14px; margin-bottom:12px;"></div>' +
        '<button type="button" id="dscmMfaBackupCodesDoneBtn">I&rsquo;ve saved these codes &mdash; Continue</button>' +
      '</div>';
    overlay.appendChild(card);

    els.card = card;
    els.title = card.querySelector('#dscmMfaTitle');
    els.sub = card.querySelector('#dscmMfaSub');
    els.form = card.querySelector('#dscmMfaForm');
    els.enrollBlock = card.querySelector('#dscmMfaEnrollBlock');
    els.qr = card.querySelector('#dscmMfaQr');
    els.secretText = card.querySelector('#dscmMfaSecretText');
    els.code = card.querySelector('#dscmMfaCode');
    els.submitBtn = card.querySelector('#dscmMfaSubmitBtn');
    els.useEmailBtn = card.querySelector('#dscmMfaUseEmailBtn');
    els.useBackupBtn = card.querySelector('#dscmMfaUseBackupBtn');
    els.error = card.querySelector('#dscmMfaError');
    els.backupBlock = card.querySelector('#dscmMfaBackupCodesBlock');
    els.backupList = card.querySelector('#dscmMfaBackupCodesList');
    els.backupDoneBtn = card.querySelector('#dscmMfaBackupCodesDoneBtn');

    built = true;
    wireHandlers();
  }

  function showMfaStep() {
    if (state.passwordCard) state.passwordCard.style.display = 'none';
    els.card.style.display = '';
  }
  function showPasswordStep() {
    els.card.style.display = 'none';
    if (state.passwordCard) state.passwordCard.style.display = '';
  }

  function finish(sessionPayload) {
    var cb = state.onSuccess;
    showPasswordStep();
    state.pendingToken = null;
    if (cb) cb(sessionPayload);
  }

  async function beginEnroll() {
    els.enrollBlock.style.display = '';
    els.useEmailBtn.style.display = 'none';
    els.useBackupBtn.style.display = 'none';
    els.title.textContent = 'Set Up Your Authenticator App';
    els.sub.textContent = 'Your account requires an extra sign-in step. Scan this with an authenticator app (Microsoft Authenticator, Google Authenticator, Authy), then enter the 6-digit code it shows.';
    els.error.textContent = 'Loading your QR code…';
    try {
      var res = await fetch(state.baseUrl + '/login/mfa/enroll', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingToken: state.pendingToken, step: 'start' })
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Could not start enrollment.');
      els.secretText.textContent = data.secret;
      await renderQrCode(els.qr, data.otpauthUri);
      els.error.textContent = '';
    } catch (err) {
      els.error.textContent = err && err.message ? err.message : 'Could not load QR code.';
    }
  }

  function beginChallenge(availableMethods) {
    els.enrollBlock.style.display = 'none';
    els.title.textContent = 'Verification Required';
    els.sub.textContent = 'Enter the 6-digit code from your authenticator app.';
    els.useEmailBtn.style.display = availableMethods.indexOf('email') !== -1 ? '' : 'none';
    els.useBackupBtn.style.display = availableMethods.indexOf('backup') !== -1 ? '' : 'none';
  }

  // Attached exactly once (buildCard's own `built` guard ensures this only
  // ever runs the first time start() is called on a given page).
  function wireHandlers() {
    els.form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var code = els.code.value.trim();
      els.error.textContent = '';
      if (!code) { els.error.textContent = 'Enter the code.'; return; }
      els.submitBtn.disabled = true; els.submitBtn.textContent = 'Verifying…';
      try {
        var url, payload;
        if (state.mode === 'enroll_required') {
          url = state.baseUrl + '/login/mfa/enroll';
          payload = { pendingToken: state.pendingToken, step: 'confirm', code: code };
        } else {
          url = state.baseUrl + '/login/mfa/verify';
          payload = { pendingToken: state.pendingToken, method: state.method, code: code };
        }
        var res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        var data = await res.json();
        if (!res.ok) throw new Error(data.message || ('HTTP ' + res.status));
        if (data.backupCodes && data.backupCodes.length) {
          els.form.style.display = 'none';
          renderCodeList(els.backupList, data.backupCodes);
          els.backupBlock.style.display = '';
          els.backupDoneBtn.onclick = function () { finish(data); };
          return;
        }
        finish(data);
      } catch (err) {
        els.error.textContent = err && err.message ? err.message : 'Incorrect code — please try again.';
      } finally {
        els.submitBtn.disabled = false; els.submitBtn.textContent = 'Verify';
      }
    });

    els.useEmailBtn.addEventListener('click', async function () {
      state.method = 'email';
      els.error.textContent = 'Sending code…';
      try {
        var res = await fetch(state.baseUrl + '/login/mfa/email/send', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pendingToken: state.pendingToken })
        });
        var data = await res.json();
        if (!res.ok) throw new Error(data.message + (data.retryAfterSeconds ? ' Try again in ' + data.retryAfterSeconds + 's.' : ''));
        els.error.textContent = '';
        els.sub.textContent = 'Enter the 6-digit code we just emailed you.';
        els.code.value = '';
        els.code.focus();
      } catch (err) {
        els.error.textContent = err && err.message ? err.message : 'Could not send code.';
      }
    });
    els.useBackupBtn.addEventListener('click', function () {
      state.method = 'backup';
      els.sub.textContent = 'Enter one of your backup codes.';
      els.error.textContent = '';
      els.code.value = '';
      els.code.focus();
    });
  }

  function start(data, opts) {
    buildCard();
    state.baseUrl = (opts && opts.baseUrl) || '';
    state.onSuccess = opts && opts.onSuccess;
    state.pendingToken = data.pendingToken;
    state.mode = data.mode;
    state.method = 'totp';

    els.form.style.display = '';
    els.backupBlock.style.display = 'none';
    els.enrollBlock.style.display = 'none';
    els.code.value = '';
    els.error.textContent = '';

    showMfaStep();

    if (data.mode === 'enroll_required') beginEnroll();
    else beginChallenge(data.availableMethods || []);
  }

  window.DscmMfaLogin = { start: start };
})();
