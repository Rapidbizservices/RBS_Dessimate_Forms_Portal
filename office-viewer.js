// office-viewer.js — shared inline viewer for .docx/.xlsx/.pptx attachments.
// Included by every page that embeds the standard doc-viewer overlay
// (docViewerOverlay / docViewerFrame / docViewerImg / docViewerOffice).
// Everything renders entirely client-side (no backend conversion step,
// files never leave this browser tab) — each library is lazy-loaded from a
// CDN the first time that file type is actually opened, not on page load.
(function () {
  'use strict';

  function loadScriptOnce(src) {
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-src="' + src + '"]');
      if (existing) {
        if (existing.getAttribute('data-loaded')) { resolve(); return; }
        existing.addEventListener('load', resolve);
        existing.addEventListener('error', function () { reject(new Error('Could not load ' + src + '.')); });
        return;
      }
      var s = document.createElement('script');
      s.src = src; s.setAttribute('data-src', src);
      s.onload = function () { s.setAttribute('data-loaded', '1'); resolve(); };
      s.onerror = function () { reject(new Error('Could not load ' + src + '.')); };
      document.head.appendChild(s);
    });
  }
  function loadCssOnce(href) {
    if (document.querySelector('link[data-href="' + href + '"]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = href; l.setAttribute('data-href', href);
    document.head.appendChild(l);
  }

  var EXT_KIND = { '.docx': 'docx', '.xlsx': 'xlsx', '.pptx': 'pptx' };
  var MIME_KIND = {
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'
  };
  function isOfficeExt(filename, mimeType) {
    if (mimeType && MIME_KIND[mimeType]) return MIME_KIND[mimeType];
    var m = /\.[a-z0-9]+$/i.exec((filename || '').toLowerCase());
    return (m && EXT_KIND[m[0]]) || null;
  }

  // ---- .docx (docx-preview, backed by JSZip v3) ------------------------------
  var DOCX_JSZIP_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
  var DOCX_PREVIEW_URL = 'https://cdn.jsdelivr.net/npm/docx-preview@0.4.0/dist/docx-preview.min.js';
  var docxLibsPromise = null;
  function loadDocxLibs() {
    if (!docxLibsPromise) {
      docxLibsPromise = (async function () {
        // docx-preview reads window.JSZip once, at the moment its own script
        // executes, and keeps that reference forever after - so it doesn't
        // matter if the pptx viewer (below) later repoints window.JSZip at
        // its own older bundled copy for its own use.
        await loadScriptOnce(DOCX_JSZIP_URL);
        await loadScriptOnce(DOCX_PREVIEW_URL);
      })().catch(function (err) { docxLibsPromise = null; throw err; });
    }
    return docxLibsPromise;
  }
  async function renderDocx(container, bytes) {
    await loadDocxLibs();
    container.innerHTML = '';
    await window.docx.renderAsync(bytes, container, container, { inWrapper: true, ignoreWidth: false, ignoreHeight: false });
  }

  // ---- .xlsx (SheetJS) --------------------------------------------------------
  var XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  var xlsxLibPromise = null;
  function loadXlsxLib() {
    if (!xlsxLibPromise) xlsxLibPromise = loadScriptOnce(XLSX_URL).catch(function (err) { xlsxLibPromise = null; throw err; });
    return xlsxLibPromise;
  }
  async function renderXlsx(container, bytes) {
    await loadXlsxLib();
    var wb = window.XLSX.read(bytes, { type: 'array' });
    if (!wb.SheetNames.length) throw new Error('This workbook has no sheets.');
    container.innerHTML = '';
    var tabBar = document.createElement('div');
    tabBar.className = 'officeXlsxTabs';
    var tableWrap = document.createElement('div');
    tableWrap.className = 'officeXlsxTableWrap';
    container.appendChild(tabBar);
    container.appendChild(tableWrap);
    function showSheet(name) {
      tableWrap.innerHTML = window.XLSX.utils.sheet_to_html(wb.Sheets[name]);
      Array.prototype.forEach.call(tabBar.children, function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-sheet') === name);
      });
    }
    wb.SheetNames.forEach(function (name) {
      var btn = document.createElement('button');
      btn.type = 'button'; btn.textContent = name; btn.className = 'officeXlsxTab';
      btn.setAttribute('data-sheet', name);
      btn.addEventListener('click', function () { showSheet(name); });
      tabBar.appendChild(btn);
    });
    if (wb.SheetNames.length <= 1) tabBar.style.display = 'none';
    showSheet(wb.SheetNames[0]);
  }

  // ---- .pptx (PPTXjs) — best-effort ------------------------------------------
  // PPTXjs is an older, purely client-side jQuery plugin (no backend/third-
  // party service involved). It renders most decks well but, unlike the
  // docx/xlsx viewers above, isn't guaranteed to render every slide layout
  // perfectly - a deliberate trade-off over sending confidential files out
  // to a third-party viewer (Microsoft/Google Office Online) for higher
  // fidelity.
  var PPTX_BASE = 'https://cdn.jsdelivr.net/gh/meshesha/PPTXjs@v1.21.1/';
  var PPTX_JQUERY_URL = PPTX_BASE + 'js/jquery-1.11.3.min.js';
  var PPTX_JSZIP_URL = PPTX_BASE + 'js/jszip.min.js';
  var PPTX_FILEREADER_URL = PPTX_BASE + 'js/filereader.js';
  var PPTX_D3_URL = PPTX_BASE + 'js/d3.min.js';
  var PPTX_NVD3_URL = PPTX_BASE + 'js/nv.d3.min.js';
  var PPTX_PPTXJS_URL = PPTX_BASE + 'js/pptxjs.js';
  var PPTX_CSS_URL = PPTX_BASE + 'css/pptxjs.css';
  var PPTX_NVD3_CSS_URL = PPTX_BASE + 'css/nv.d3.min.css';
  var pptxLibsPromise = null;
  function loadPptxLibs() {
    if (!pptxLibsPromise) {
      pptxLibsPromise = (async function () {
        await loadScriptOnce(PPTX_JQUERY_URL);
        // PPTXjs reads a bare global `JSZip` at call time (not load time),
        // so unlike docx-preview above it has to be repointed at its own
        // bundled copy immediately before every render - see renderPptx.
        await loadScriptOnce(PPTX_JSZIP_URL);
        window.__pptxJSZipCtor = window.JSZip;
        await loadScriptOnce(PPTX_FILEREADER_URL);
        await loadScriptOnce(PPTX_D3_URL);
        await loadScriptOnce(PPTX_NVD3_URL);
        await loadScriptOnce(PPTX_PPTXJS_URL);
        loadCssOnce(PPTX_CSS_URL);
        loadCssOnce(PPTX_NVD3_CSS_URL);
      })().catch(function (err) { pptxLibsPromise = null; throw err; });
    }
    return pptxLibsPromise;
  }
  async function renderPptx(container, bytes) {
    await loadPptxLibs();
    if (window.__pptxJSZipCtor) window.JSZip = window.__pptxJSZipCtor;
    container.innerHTML = '';
    var blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
    var blobUrl = URL.createObjectURL(blob);
    try {
      window.jQuery(container).pptxToHtml({
        pptxFileUrl: blobUrl,
        slideMode: false,
        keyBoardShortCut: false,
        mediaProcess: true
      });
      // pptxToHtml has no completion callback/promise - poll for its own
      // "loading" placeholder to be removed and at least one slide to exist.
      await new Promise(function (resolve, reject) {
        var waited = 0;
        var iv = setInterval(function () {
          waited += 200;
          var loadingMsg = container.querySelector('.slides-loadnig-msg');
          var hasSlide = !!container.querySelector('.slide');
          if (!loadingMsg && hasSlide) { clearInterval(iv); resolve(); return; }
          if (waited >= 20000) {
            clearInterval(iv);
            if (hasSlide) resolve(); else reject(new Error('This presentation could not be rendered.'));
          }
        }, 200);
      });
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  async function render(kind, container, bytes) {
    if (kind === 'docx') return renderDocx(container, bytes);
    if (kind === 'xlsx') return renderXlsx(container, bytes);
    if (kind === 'pptx') return renderPptx(container, bytes);
    throw new Error('Unsupported office document kind: ' + kind);
  }

  window.OfficeViewer = { isOfficeExt: isOfficeExt, render: render };
})();
