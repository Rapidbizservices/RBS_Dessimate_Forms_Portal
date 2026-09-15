// confirm-dialog.js — a themed replacement for the browser's native
// confirm(), used everywhere a destructive action ("Remove"/"Delete") needs
// the user to confirm first. Native confirm() can't be restyled and always
// shows "An embedded page at <domain> says" browser chrome, which doesn't
// read as part of this system - this renders an in-page modal matching the
// site's own look instead. Usage: `if (!(await confirmDialog('Remove X?'))) return;`
// inside an async function (the enclosing click handler needs to be async
// too, same as any other await).
(function () {
  'use strict';

  var overlay = null, messageEl = null, okBtn = null, cancelBtn = null;

  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = 'confirmDialogOverlay';
    overlay.className = 'confirmDialogOverlay';
    overlay.innerHTML =
      '<div class="confirmDialogCard">' +
        '<div class="confirmDialogMessage" id="confirmDialogMessage"></div>' +
        '<div class="confirmDialogBtns">' +
          '<button type="button" class="confirmDialogCancel" id="confirmDialogCancel">Cancel</button>' +
          '<button type="button" class="confirmDialogOk" id="confirmDialogOk">OK</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    messageEl = document.getElementById('confirmDialogMessage');
    okBtn = document.getElementById('confirmDialogOk');
    cancelBtn = document.getElementById('confirmDialogCancel');
  }

  // opts.okLabel/cancelLabel override the button text (default OK/Cancel);
  // opts.danger paints the OK button red for an especially destructive action.
  function confirmDialog(message, opts) {
    opts = opts || {};
    ensureOverlay();
    messageEl.textContent = message == null ? '' : String(message);
    okBtn.textContent = opts.okLabel || 'OK';
    cancelBtn.textContent = opts.cancelLabel || 'Cancel';
    okBtn.className = 'confirmDialogOk' + (opts.danger ? ' danger' : '');

    return new Promise(function (resolve) {
      function cleanup(result) {
        overlay.classList.remove('open');
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        overlay.removeEventListener('click', onOverlayClick);
        document.removeEventListener('keydown', onKeydown);
        resolve(result);
      }
      function onOk() { cleanup(true); }
      function onCancel() { cleanup(false); }
      function onOverlayClick(e) { if (e.target === overlay) cleanup(false); }
      function onKeydown(e) {
        if (e.key === 'Escape') cleanup(false);
        else if (e.key === 'Enter') cleanup(true);
      }
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      overlay.addEventListener('click', onOverlayClick);
      document.addEventListener('keydown', onKeydown);
      overlay.classList.add('open');
      okBtn.focus();
    });
  }

  window.confirmDialog = confirmDialog;
})();
