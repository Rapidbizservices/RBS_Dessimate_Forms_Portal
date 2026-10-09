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
  // A generated sheet's declared !ref is sometimes far wider than its real
  // content, so cap what reaches the DOM rather than hanging the tab building
  // a million empty cells.
  var XLSX_MAX_ROWS = 2000;
  var XLSX_MAX_COLS = 150;
  // Ceilings on the evaluation pass below, so one pathological workbook can't
  // cost us the tab: total cells evaluated, and how deep a chain of formulas
  // referring to other formulas may go before we give up.
  var XLSX_EVAL_BUDGET = 200000;
  var XLSX_EVAL_MAX_DEPTH = 64;

  // ---- .xlsx formula evaluation ----------------------------------------------
  // An .xlsx stores each formula next to the value Excel cached when it last
  // saved. SheetJS has no calculation engine, so it can only show that cached
  // value - and a workbook written by a generator (openpyxl, xlsxwriter, a
  // script emitting raw XML) carries no cached value at all, because the
  // generator can't compute one. Excel recalculates on open, so those files
  // look correct in Excel and used to render here as silently empty cells.
  // This pass evaluates only the cells that have no cached value; anything
  // Excel already calculated is shown as-saved, untouched.
  //
  // Deliberately minimal: a read-only viewer needs one pass at load, not live
  // recalculation, editing or undo. So there's no dependency graph and no
  // third-party engine - the usual one, HyperFormula, is GPLv3-or-commercial
  // and would put licensing obligations on this project. Anything unrecognised
  // (an unsupported function, a cross-sheet reference, a circular chain) raises
  // Unsupported and the cell falls back to printing its own formula text. A
  // visible "=SUM(B2:B9)" is honest; a confidently wrong number on a supplier
  // document is not.
  function Unsupported(reason) { this.reason = reason; }

  // Excel error values travel as ordinary values rather than exceptions, so
  // they propagate through operators the way they do in Excel (and IFERROR can
  // still catch them).
  function formulaError(code) { return { err: code }; }
  function isFormulaError(v) { return !!v && typeof v === 'object' && typeof v.err === 'string'; }
  function isRange(v) { return !!v && typeof v === 'object' && Object.prototype.toString.call(v.range) === '[object Array]'; }

  var XLSX_REF_RE = /^\$?[A-Za-z]{1,3}\$?[0-9]{1,7}$/;

  function tokenizeFormula(src) {
    var tokens = [];
    var i = 0;
    while (i < src.length) {
      var ch = src.charAt(i);
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue; }
      if (ch === '"') {
        var text = '';
        i++;
        for (;;) {
          if (i >= src.length) throw new Unsupported('unterminated text literal');
          if (src.charAt(i) === '"') {
            if (src.charAt(i + 1) === '"') { text += '"'; i += 2; continue; }
            i++; break;
          }
          text += src.charAt(i); i++;
        }
        tokens.push({ t: 'val', v: text });
        continue;
      }
      if ((ch >= '0' && ch <= '9') || (ch === '.' && /[0-9]/.test(src.charAt(i + 1)))) {
        var num = /^[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/.exec(src.slice(i));
        if (!num) throw new Unsupported('malformed number');
        tokens.push({ t: 'val', v: parseFloat(num[0]) });
        i += num[0].length;
        continue;
      }
      var pair = src.substr(i, 2);
      if (pair === '<=' || pair === '>=' || pair === '<>') { tokens.push({ t: 'op', v: pair }); i += 2; continue; }
      if ('+-*/^&%(),:=<>'.indexOf(ch) >= 0) { tokens.push({ t: 'op', v: ch }); i++; continue; }
      var word = /^[A-Za-z_$][A-Za-z0-9_$.]*/.exec(src.slice(i));
      if (word) {
        var raw = word[0];
        i += raw.length;
        if (src.charAt(i) === '(') { tokens.push({ t: 'func', v: raw.toUpperCase() }); continue; }
        // Sheet2!A1 - we only ever hold one sheet's cells in context.
        if (src.charAt(i) === '!') throw new Unsupported('cross-sheet reference');
        var upper = raw.toUpperCase();
        if (upper === 'TRUE') { tokens.push({ t: 'val', v: true }); continue; }
        if (upper === 'FALSE') { tokens.push({ t: 'val', v: false }); continue; }
        if (XLSX_REF_RE.test(raw)) { tokens.push({ t: 'ref', v: raw.replace(/\$/g, '').toUpperCase() }); continue; }
        throw new Unsupported('unrecognised name "' + raw + '"');
      }
      // Quoted sheet names, [external.xlsx] links and #REF!-style literals all
      // land here.
      throw new Unsupported('unexpected character "' + ch + '"');
    }
    return tokens;
  }

  function xlsxCoerceNumber(v) {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    throw new Unsupported('text where a number was expected');
  }
  function xlsxCoerceText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return String(v);
  }
  function xlsxTruthy(v) {
    if (v === null || v === undefined || v === '') return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    throw new Unsupported('text where a condition was expected');
  }
  function xlsxScalar(v) {
    if (isRange(v)) {
      if (v.range.length === 1) return v.range[0];
      throw new Unsupported('a range where a single value was expected');
    }
    return v;
  }
  function xlsxScalars(args) {
    var out = [];
    args.forEach(function (a) {
      if (isRange(a)) { a.range.forEach(function (v) { out.push(v); }); return; }
      out.push(a);
    });
    return out;
  }
  function xlsxNumbers(args) {
    var out = [];
    args.forEach(function (a) {
      if (isRange(a)) {
        // Excel's SUM/AVERAGE ignore text and empty cells found inside a range
        // - a label sitting in the middle of a column is perfectly normal - so
        // skip them. Bailing here instead would push most real sheets into the
        // formula-text fallback for no good reason.
        a.range.forEach(function (v) { if (typeof v === 'number') out.push(v); });
        return;
      }
      if (a === null || a === undefined || a === '') return;
      out.push(xlsxCoerceNumber(a));
    });
    return out;
  }

  function xlsxSum(values) { return values.reduce(function (a, b) { return a + b; }, 0); }

  // Only the functions our documents actually lean on. Adding one is cheap;
  // guessing at one is not, so everything absent falls back to formula text.
  var XLSX_FUNCS = {
    SUM: function (args) { return xlsxSum(xlsxNumbers(args)); },
    PRODUCT: function (args) { var n = xlsxNumbers(args); return n.length ? n.reduce(function (a, b) { return a * b; }, 1) : 0; },
    AVERAGE: function (args) {
      var n = xlsxNumbers(args);
      return n.length ? xlsxSum(n) / n.length : formulaError('#DIV/0!');
    },
    MIN: function (args) { var n = xlsxNumbers(args); return n.length ? Math.min.apply(null, n) : 0; },
    MAX: function (args) { var n = xlsxNumbers(args); return n.length ? Math.max.apply(null, n) : 0; },
    COUNT: function (args) {
      var n = 0;
      xlsxScalars(args).forEach(function (v) { if (typeof v === 'number') n++; });
      return n;
    },
    COUNTA: function (args) {
      var n = 0;
      xlsxScalars(args).forEach(function (v) { if (v !== null && v !== undefined && v !== '') n++; });
      return n;
    },
    ABS: function (args) { return Math.abs(xlsxCoerceNumber(xlsxScalar(args[0]))); },
    SQRT: function (args) {
      var n = xlsxCoerceNumber(xlsxScalar(args[0]));
      return n < 0 ? formulaError('#NUM!') : Math.sqrt(n);
    },
    POWER: function (args) { return Math.pow(xlsxCoerceNumber(xlsxScalar(args[0])), xlsxCoerceNumber(xlsxScalar(args[1]))); },
    ROUND: function (args) {
      var n = xlsxCoerceNumber(xlsxScalar(args[0]));
      var digits = args.length > 1 ? xlsxCoerceNumber(xlsxScalar(args[1])) : 0;
      var factor = Math.pow(10, digits);
      // Excel rounds half away from zero; Math.round rounds half up, which
      // disagrees on negatives.
      return (n < 0 ? -1 : 1) * Math.round(Math.abs(n) * factor) / factor;
    },
    IF: function (args) {
      if (args.length < 2) throw new Unsupported('IF needs at least two arguments');
      return xlsxScalar(xlsxTruthy(xlsxScalar(args[0])) ? args[1] : (args.length > 2 ? args[2] : false));
    },
    IFERROR: function (args) {
      if (args.length < 2) throw new Unsupported('IFERROR needs two arguments');
      var v = xlsxScalar(args[0]);
      return isFormulaError(v) ? xlsxScalar(args[1]) : v;
    },
    CONCATENATE: function (args) { return xlsxScalars(args).map(xlsxCoerceText).join(''); }
  };

  function xlsxNormalizeValue(v) {
    if (v === undefined || v === null) return null;
    var type = typeof v;
    if (type === 'number' || type === 'string' || type === 'boolean') return v;
    // We read without cellDates, so dates arrive as numeric serials. Anything
    // reaching here is a type this evaluator doesn't model.
    throw new Unsupported('unsupported cell value type');
  }

  // A formula cell saved without a value comes back from SheetJS as a stub
  // (t 'z') carrying a placeholder v of 0 - trusting that v would print a
  // confident 0 instead of the real result, so the stub type is the signal.
  function xlsxHasCachedValue(cell) {
    return cell.t !== 'z' && cell.v !== undefined && cell.v !== null;
  }

  // Resolves one cell, computing it first if it is itself an uncached formula.
  function xlsxCellValue(ctx, addr) {
    var cell = ctx.sheet[addr];
    if (!cell) return null;
    if (cell.f === undefined || cell.f === null || cell.f === '') return cell.t === 'z' ? null : xlsxNormalizeValue(cell.v);
    if (xlsxHasCachedValue(cell)) return xlsxNormalizeValue(cell.v);
    if (ctx.visiting[addr]) throw new Unsupported('circular reference at ' + addr);
    if (Object.prototype.hasOwnProperty.call(ctx.computed, addr)) return ctx.computed[addr];
    if (ctx.depth >= XLSX_EVAL_MAX_DEPTH) throw new Unsupported('formulas nested too deeply');
    ctx.visiting[addr] = true;
    ctx.depth++;
    try {
      var value = xlsxEvalFormula(ctx, cell.f);
      ctx.computed[addr] = value;
      return value;
    } finally {
      delete ctx.visiting[addr];
      ctx.depth--;
    }
  }

  function xlsxRangeValues(ctx, startRef, endRef) {
    var u = window.XLSX.utils;
    var a = u.decode_cell(startRef);
    var b = u.decode_cell(endRef);
    var r0 = Math.min(a.r, b.r), r1 = Math.max(a.r, b.r);
    var c0 = Math.min(a.c, b.c), c1 = Math.max(a.c, b.c);
    if ((r1 - r0 + 1) * (c1 - c0 + 1) > 65536) throw new Unsupported('range too large to evaluate');
    var values = [];
    for (var r = r0; r <= r1; r++) {
      for (var c = c0; c <= c1; c++) values.push(xlsxCellValue(ctx, u.encode_cell({ r: r, c: c })));
    }
    return { range: values };
  }

  function xlsxEvalFormula(ctx, formula) {
    if (ctx.budget-- <= 0) throw new Unsupported('too many formulas to evaluate');
    var tokens = tokenizeFormula(String(formula));
    var pos = 0;

    function atOp(v) { var t = tokens[pos]; return !!t && t.t === 'op' && t.v === v; }
    function atCompare() {
      var t = tokens[pos];
      if (!t || t.t !== 'op') return false;
      return t.v === '=' || t.v === '<>' || t.v === '<' || t.v === '>' || t.v === '<=' || t.v === '>=';
    }

    function arith(op, a, b) {
      if (isFormulaError(a)) return a;
      if (isFormulaError(b)) return b;
      var x = xlsxCoerceNumber(xlsxScalar(a));
      var y = xlsxCoerceNumber(xlsxScalar(b));
      if (op === '+') return x + y;
      if (op === '-') return x - y;
      if (op === '*') return x * y;
      if (op === '/') return y === 0 ? formulaError('#DIV/0!') : x / y;
      if (op === '^') return Math.pow(x, y);
      throw new Unsupported('operator ' + op);
    }

    function compare(op, a, b) {
      if (isFormulaError(a)) return a;
      if (isFormulaError(b)) return b;
      var x = xlsxScalar(a), y = xlsxScalar(b);
      if (typeof x !== 'number' || typeof y !== 'number') {
        x = xlsxCoerceText(x).toUpperCase();
        y = xlsxCoerceText(y).toUpperCase();
      }
      if (op === '=') return x === y;
      if (op === '<>') return x !== y;
      if (op === '<') return x < y;
      if (op === '>') return x > y;
      if (op === '<=') return x <= y;
      if (op === '>=') return x >= y;
      throw new Unsupported('operator ' + op);
    }

    function primary() {
      var tok = tokens[pos++];
      if (!tok) throw new Unsupported('formula ended unexpectedly');
      if (tok.t === 'val') return tok.v;
      if (tok.t === 'op' && tok.v === '(') {
        var inner = expression();
        if (!atOp(')')) throw new Unsupported('missing closing bracket');
        pos++;
        return inner;
      }
      if (tok.t === 'func') {
        if (!atOp('(')) throw new Unsupported('malformed call to ' + tok.v);
        pos++;
        var args = [];
        if (!atOp(')')) {
          for (;;) {
            args.push(expression());
            if (atOp(',')) { pos++; continue; }
            break;
          }
        }
        if (!atOp(')')) throw new Unsupported('missing closing bracket after ' + tok.v);
        pos++;
        var fn = XLSX_FUNCS[tok.v];
        if (!fn) throw new Unsupported('unsupported function ' + tok.v + '()');
        // IFERROR exists precisely to inspect an error argument, so it is the
        // one function we don't short-circuit.
        if (tok.v !== 'IFERROR') {
          for (var k = 0; k < args.length; k++) if (isFormulaError(args[k])) return args[k];
        }
        return fn(args);
      }
      if (tok.t === 'ref') {
        if (atOp(':')) {
          pos++;
          var end = tokens[pos++];
          if (!end || end.t !== 'ref') throw new Unsupported('malformed range');
          return xlsxRangeValues(ctx, tok.v, end.v);
        }
        return xlsxCellValue(ctx, tok.v);
      }
      throw new Unsupported('unexpected "' + tok.v + '"');
    }

    function postfix() {
      var value = primary();
      while (atOp('%')) {
        pos++;
        if (isFormulaError(value)) return value;
        value = xlsxCoerceNumber(xlsxScalar(value)) / 100;
      }
      return value;
    }
    function unary() {
      if (atOp('-')) { pos++; var neg = unary(); return isFormulaError(neg) ? neg : -xlsxCoerceNumber(xlsxScalar(neg)); }
      if (atOp('+')) { pos++; return unary(); }
      return postfix();
    }
    function power() {
      var left = unary();
      while (atOp('^')) { pos++; left = arith('^', left, unary()); }
      return left;
    }
    function multiplicative() {
      var left = power();
      while (atOp('*') || atOp('/')) { var op = tokens[pos++].v; left = arith(op, left, power()); }
      return left;
    }
    function additive() {
      var left = multiplicative();
      while (atOp('+') || atOp('-')) { var op = tokens[pos++].v; left = arith(op, left, multiplicative()); }
      return left;
    }
    function concat() {
      var left = additive();
      while (atOp('&')) {
        pos++;
        var right = additive();
        if (isFormulaError(left)) return left;
        if (isFormulaError(right)) return right;
        left = xlsxCoerceText(xlsxScalar(left)) + xlsxCoerceText(xlsxScalar(right));
      }
      return left;
    }
    function expression() {
      var left = concat();
      while (atCompare()) { var op = tokens[pos++].v; left = compare(op, left, concat()); }
      return left;
    }

    var result = expression();
    if (pos < tokens.length) throw new Unsupported('unexpected trailing input');
    return result;
  }

  // ---- .xlsx rendering --------------------------------------------------------
  // Hand-rolled rather than XLSX.utils.sheet_to_html: that helper emits a bare
  // table, dropping column widths, merges and number formats, and gives us no
  // per-cell hook for the formula fallback above.

  function xlsxFormatComputed(v, numFmt) {
    if (isFormulaError(v)) return v.err;
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'number') {
      // Honour the workbook's own number format where it has one, so a figure
      // we calculated still reads as currency/percent alongside the cells
      // Excel formatted itself.
      if (numFmt && window.XLSX.SSF) {
        try { return window.XLSX.SSF.format(numFmt, v); } catch (e) { /* fall through to plain */ }
      }
      if (!isFinite(v)) return String(v);
      // Binary floating point leaves artefacts like 0.30000000000000004 on
      // sums we add up ourselves; Excel would never show those.
      return String(Math.round(v * 1e10) / 1e10);
    }
    return String(v);
  }

  function xlsxCellDisplay(ctx, cell, addr) {
    if (!cell) return null;
    var hasFormula = cell.f !== undefined && cell.f !== null && cell.f !== '';
    var hasCachedValue = xlsxHasCachedValue(cell);
    if (hasFormula && !hasCachedValue) {
      try {
        var value = xlsxCellValue(ctx, addr);
        if (isFormulaError(value)) return { text: value.err, cls: 'officeXlsxErr', title: '=' + cell.f };
        return {
          text: xlsxFormatComputed(value, cell.z),
          cls: 'officeXlsxComputed',
          numeric: typeof value === 'number',
          title: '=' + cell.f + '\n\nCalculated by the viewer: this workbook was saved without a value for this cell.'
        };
      } catch (err) {
        if (err instanceof Unsupported) {
          return {
            text: '=' + cell.f,
            cls: 'officeXlsxFormula',
            title: 'The viewer could not calculate this cell (' + err.reason + '), so its formula is shown instead. Download the file to see the result.'
          };
        }
        throw err;
      }
    }
    // A text formula saved without a value reads back as an empty string,
    // which is indistinguishable from one that genuinely evaluated to "". So
    // try to calculate it, but fall back to the blank rather than formula text
    // - for a real "" result, blank is what Excel would show.
    if (hasFormula && cell.t === 's' && cell.v === '') {
      try {
        var textValue = xlsxEvalFormula(ctx, cell.f);
        if (!isFormulaError(textValue) && textValue !== '' && textValue !== null) {
          return {
            text: xlsxFormatComputed(textValue, cell.z),
            cls: 'officeXlsxComputed',
            numeric: typeof textValue === 'number',
            title: '=' + cell.f + '\n\nCalculated by the viewer: this workbook was saved without a value for this cell.'
          };
        }
      } catch (err) {
        if (!(err instanceof Unsupported)) throw err;
      }
      return { text: '', cls: '', numeric: false, title: '=' + cell.f };
    }
    if (!hasCachedValue) return { text: '', cls: '', numeric: false, title: '' };
    return {
      text: cell.w !== undefined && cell.w !== null ? cell.w : String(cell.v),
      cls: '',
      numeric: cell.t === 'n',
      title: hasFormula ? '=' + cell.f : ''
    };
  }

  function xlsxColWidthPx(cols, idx) {
    var col = cols && cols[idx];
    if (!col) return 0;
    if (typeof col.wpx === 'number') return col.wpx;
    // wch is a character count; Excel's own approximation is ~7px per
    // character plus the cell padding.
    if (typeof col.wch === 'number') return Math.round(col.wch * 7 + 5);
    if (typeof col.width === 'number') return Math.round(col.width * 7 + 5);
    return 0;
  }

  // ---- .xlsx cell fills -------------------------------------------------------
  // Fill colour carries meaning in our documents (timing plans shade planned vs
  // actual), so it is rendered. The free SheetJS build parses fills when read
  // with cellStyles, but not fonts or borders - those still don't show.

  // Excel's tint: a signed fraction that moves a theme colour's luminance
  // toward black (negative) or white (positive), applied in HSL.
  function xlsxApplyTint(hex, tint) {
    if (!tint) return hex;
    var r = parseInt(hex.slice(0, 2), 16) / 255, g = parseInt(hex.slice(2, 4), 16) / 255, b = parseInt(hex.slice(4, 6), 16) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
    function hue(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    var out;
    if (s === 0) out = [l, l, l];
    else {
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
      out = [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)];
    }
    return out.map(function (v) {
      var n = Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16);
      return n.length === 1 ? '0' + n : n;
    }).join('').toUpperCase();
  }

  // Returns the cell's fill as a 6-digit hex string, or '' for no fill.
  function xlsxFillHex(cell, themeColors) {
    var fill = cell && cell.s;
    if (!fill || !fill.patternType || fill.patternType === 'none') return '';
    // A solid fill's colour is its foreground; for the rarer hatch patterns the
    // foreground is still the closest single colour we can paint.
    var color = fill.fgColor || fill.bgColor;
    if (!color) return '';
    var hex = color.rgb;
    // SheetJS resolves theme colours to rgb itself, but skips theme 0 (it tests
    // the index for truthiness) - and theme 0 with a tint is Excel's stock
    // "White, darker 15%" grey, one of the most common fills there is.
    if (!hex && typeof color.theme === 'number' && themeColors && themeColors[color.theme]) {
      hex = xlsxApplyTint(themeColors[color.theme], color.tint || 0);
    }
    return /^[0-9A-Fa-f]{6}$/.test(hex || '') ? hex.toUpperCase() : '';
  }

  // Font colour isn't available to us, so on a dark fill switch to white text
  // rather than leaving black on navy unreadable.
  function xlsxIsDark(hex) {
    var r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) < 128;
  }

  // ---- .xlsx frozen panes -----------------------------------------------------
  // SheetJS parses <sheetView> but skips its <pane>, which is where Excel keeps
  // Freeze Panes, so read it straight out of each sheet's XML. Returns
  // { [sheetName]: { rowStart, rowEnd, colStart, colEnd } } (0-based,
  // inclusive; an end below its start means nothing frozen on that axis).
  // Freeze panes are a reading aid, not content: any failure here just
  // renders the sheet unfrozen.
  function xlsxDecodeXmlText(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  }
  function xlsxXmlAttr(tag, name) {
    var m = new RegExp('\\s' + name + '="([^"]*)"').exec(tag);
    return m ? xlsxDecodeXmlText(m[1]) : null;
  }
  function xlsxU16(u8, i) { return u8[i] | (u8[i + 1] << 8); }
  function xlsxU32(u8, i) { return (u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16) | (u8[i + 3] << 24)) >>> 0; }

  // An .xlsx is a zip, not an OLE compound file. SheetJS's CFB reader is the
  // OLE one, so the earlier CFB.read path silently produced no panes on every
  // real workbook. This reads just the few XML parts Freeze Panes live in.
  function xlsxZipFindEocd(u8) {
    var start = Math.max(0, u8.length - 65557);
    for (var i = u8.length - 22; i >= start; i--) {
      if (xlsxU32(u8, i) === 0x06054b50) return i;
    }
    return -1;
  }
  async function xlsxZipInflateRaw(comp) {
    if (typeof DecompressionStream === 'undefined') return null;
    var stream = new Blob([comp]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function xlsxZipReadText(bytes, path, maxBytes) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var eocd = xlsxZipFindEocd(u8);
    if (eocd < 0) return null;
    var cdOff = xlsxU32(u8, eocd + 16), cdEnd = cdOff + xlsxU32(u8, eocd + 12), p = cdOff;
    while (p + 46 <= cdEnd && p + 46 <= u8.length) {
      if (xlsxU32(u8, p) !== 0x02014b50) break;
      var method = xlsxU16(u8, p + 10), compSize = xlsxU32(u8, p + 20);
      var nameLen = xlsxU16(u8, p + 28), extraLen = xlsxU16(u8, p + 30), commentLen = xlsxU16(u8, p + 32);
      var localOff = xlsxU32(u8, p + 42);
      var name = '';
      for (var n = 0; n < nameLen; n++) name += String.fromCharCode(u8[p + 46 + n]);
      if (name === path) {
        if (xlsxU32(u8, localOff) !== 0x04034b50) return null;
        var dataOff = localOff + 30 + xlsxU16(u8, localOff + 26) + xlsxU16(u8, localOff + 28);
        var comp = u8.subarray(dataOff, dataOff + compSize);
        var inflated = method === 0 ? comp : (method === 8 ? await xlsxZipInflateRaw(comp) : null);
        if (!inflated) return null;
        var slice = maxBytes && inflated.length > maxBytes ? inflated.subarray(0, maxBytes) : inflated;
        return new TextDecoder('utf-8').decode(slice);
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return null;
  }

  async function xlsxReadFrozenPanes(bytes) {
    var panes = {};
    try {
      if (typeof TextDecoder === 'undefined') return panes;
      var workbookXml = await xlsxZipReadText(bytes, 'xl/workbook.xml');
      var relsXml = await xlsxZipReadText(bytes, 'xl/_rels/workbook.xml.rels');
      if (!workbookXml || !relsXml) return panes;

      var targets = {};
      (relsXml.match(/<(?:\w+:)?Relationship\b[^>]*>/g) || []).forEach(function (tag) {
        var id = xlsxXmlAttr(tag, 'Id'), target = xlsxXmlAttr(tag, 'Target');
        if (id && target) targets[id] = target.charAt(0) === '/' ? target.replace(/^\//, '') : 'xl/' + target;
      });

      var u = window.XLSX.utils;
      var sheets = workbookXml.match(/<(?:\w+:)?sheet\b[^>]*>/g) || [];
      for (var s = 0; s < sheets.length; s++) {
        var tag = sheets[s];
        var name = xlsxXmlAttr(tag, 'name');
        var rid = /\s(?:\w+:)?id="([^"]*)"/i.exec(tag);
        var path = rid && targets[rid[1]];
        if (!name || !path) continue;
        // <sheetViews> sits ahead of <sheetData>, so the opening bytes are
        // enough - no need to inflate a large sheet's entire XML for this.
        var head = await xlsxZipReadText(bytes, path, 65536);
        if (!head) continue;
        var pane = /<(?:\w+:)?pane\b[^>]*>/.exec(head);
        if (!pane) continue;
        var state = xlsxXmlAttr(pane[0], 'state');
        // A plain (unfrozen) split is two independently scrolling views -
        // there's no faithful way to show that in a single grid, so skip it.
        if (state !== 'frozen' && state !== 'frozenSplit') continue;
        var rows = Math.floor(+xlsxXmlAttr(pane[0], 'ySplit') || 0);
        var colsFrozen = Math.floor(+xlsxXmlAttr(pane[0], 'xSplit') || 0);
        if (rows <= 0 && colsFrozen <= 0) continue;
        // pane.topLeftCell is the first UNFROZEN cell. The frozen block is
        // the ySplit rows / xSplit columns immediately above and left of it,
        // which is what Excel froze even if the sheet was saved scrolled.
        var origin = u.decode_cell(xlsxXmlAttr(pane[0], 'topLeftCell') || 'A1');
        panes[name] = {
          rowStart: origin.r - rows, rowEnd: origin.r - 1,
          colStart: origin.c - colsFrozen, colEnd: origin.c - 1
        };
      }
    } catch (e) { /* unreadable panes - render unfrozen */ }
    return panes;
  }

  // Excel always keeps its row numbers and column letters on screen, and on
  // top of that whatever the workbook froze. Done after the table is in the
  // document because each sticky offset is the summed size of everything
  // already stuck above or left of it, and wrapped rows only have a height
  // once laid out.
  function xlsxStick(el, top, left, z) {
    el.style.position = 'sticky';
    if (top !== null) el.style.top = top + 'px';
    if (left !== null) el.style.left = left + 'px';
    el.style.zIndex = String(z);
  }
  function xlsxPinPanes(pin) {
    var table = pin.table;
    var headRow = table.tHead && table.tHead.rows[0];
    // Laid out invisibly (display:none somewhere above): every size reads 0
    // and the offsets would stack everything at the top, so leave it unpinned.
    if (!headRow || !headRow.offsetHeight) return;
    var top = pin.nameBar ? pin.nameBar.offsetHeight : 0;
    var headCells = headRow.cells;
    var frozen = pin.frozen;

    var lefts = {};
    var x = headCells[0].offsetWidth;
    for (var i = 1; i < headCells.length; i++) {
      var col = pin.firstCol + i - 1;
      if (frozen && col >= frozen.colStart && col <= frozen.colEnd) {
        lefts[col] = x;
        x += headCells[i].offsetWidth;
      }
    }
    var isFrozenCol = function (c) { return Object.prototype.hasOwnProperty.call(lefts, c); };

    // Layering, lowest first: frozen column, frozen row, their intersection,
    // row numbers, column letters, the corner - so nothing that scrolls ever
    // paints over something that is pinned.
    xlsxStick(headCells[0], top, 0, 8);
    for (var h = 1; h < headCells.length; h++) {
      var hcol = pin.firstCol + h - 1;
      xlsxStick(headCells[h], top, isFrozenCol(hcol) ? lefts[hcol] : null, isFrozenCol(hcol) ? 7 : 6);
    }

    var rowTop = top + headRow.offsetHeight;
    var bodyRows = table.tBodies[0].rows;
    for (var r = 0; r < bodyRows.length; r++) {
      var tr = bodyRows[r];
      var sheetRow = pin.firstRow + r;
      var rowFrozen = !!frozen && sheetRow >= frozen.rowStart && sheetRow <= frozen.rowEnd;
      var cells = tr.cells;
      xlsxStick(cells[0], rowFrozen ? rowTop : null, 0, rowFrozen ? 5 : 4);
      for (var k = 1; k < cells.length; k++) {
        var cell = cells[k];
        var colFrozen = isFrozenCol(cell._xlsxCol);
        if (!rowFrozen && !colFrozen) continue;
        xlsxStick(cell, rowFrozen ? rowTop : null, colFrozen ? lefts[cell._xlsxCol] : null,
          rowFrozen && colFrozen ? 3 : (rowFrozen ? 2 : 1));
        // A pinned cell slides over the ones scrolling beneath it, so it
        // needs a solid background even when the workbook gave it none.
        if (!cell.style.backgroundColor) cell.style.backgroundColor = '#fff';
      }
      if (rowFrozen) rowTop += tr.offsetHeight;
    }
  }

  function xlsxHeaderCell(text) {
    var th = document.createElement('th');
    th.className = 'officeXlsxHdr';
    th.textContent = text;
    return th;
  }
  function xlsxNote(text) {
    var note = document.createElement('div');
    note.className = 'officeXlsxNote';
    note.textContent = text;
    return note;
  }

  function buildXlsxSheet(ws, name, showName, themeColors, frozen) {
    var u = window.XLSX.utils;
    var section = document.createElement('section');
    section.className = 'officeXlsxSheet';
    var heading = null;
    if (showName) {
      heading = document.createElement('div');
      heading.className = 'officeXlsxSheetName';
      var headingText = document.createElement('span');
      headingText.textContent = name;
      heading.appendChild(headingText);
      section.appendChild(heading);
    }
    var wrap = document.createElement('div');
    wrap.className = 'officeXlsxTableWrap';
    section.appendChild(wrap);

    var ref = ws && ws['!ref'];
    if (!ref) { wrap.appendChild(xlsxNote('This sheet is empty.')); return section; }

    var range = u.decode_range(ref);
    var lastRow = Math.min(range.e.r, range.s.r + XLSX_MAX_ROWS - 1);
    var lastCol = Math.min(range.e.c, range.s.c + XLSX_MAX_COLS - 1);
    var truncated = lastRow < range.e.r || lastCol < range.e.c;

    var spans = {}, covered = {};
    (ws['!merges'] || []).forEach(function (m) {
      // Skip a merge whose anchor sits outside the window we're rendering -
      // without its spanning cell present, marking the rest covered would
      // leave the row short and knock the whole grid out of alignment.
      if (m.s.r < range.s.r || m.s.c < range.s.c || m.s.r > lastRow || m.s.c > lastCol) return;
      var endRow = Math.min(m.e.r, lastRow), endCol = Math.min(m.e.c, lastCol);
      for (var r = m.s.r; r <= endRow; r++) {
        for (var c = m.s.c; c <= endCol; c++) {
          if (r === m.s.r && c === m.s.c) spans[r + ':' + c] = { rows: endRow - r + 1, cols: endCol - c + 1 };
          else covered[r + ':' + c] = true;
        }
      }
    });

    var ctx = { sheet: ws, computed: {}, visiting: {}, depth: 0, budget: XLSX_EVAL_BUDGET };
    var cols = ws['!cols'];
    var table = document.createElement('table');

    var colgroup = document.createElement('colgroup');
    colgroup.appendChild(document.createElement('col')); // the row-number gutter
    for (var wc = range.s.c; wc <= lastCol; wc++) {
      var colEl = document.createElement('col');
      var px = xlsxColWidthPx(cols, wc);
      if (px) colEl.style.width = px + 'px';
      colgroup.appendChild(colEl);
    }
    table.appendChild(colgroup);

    // Column letters and row numbers: once a cell can print "=SUM(B2:B9)" as
    // its own text, the reader needs the A1 grid to make sense of it.
    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    headRow.appendChild(xlsxHeaderCell(''));
    for (var hc = range.s.c; hc <= lastCol; hc++) headRow.appendChild(xlsxHeaderCell(u.encode_col(hc)));
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    for (var r2 = range.s.r; r2 <= lastRow; r2++) {
      var tr = document.createElement('tr');
      tr.appendChild(xlsxHeaderCell(String(r2 + 1)));
      for (var c2 = range.s.c; c2 <= lastCol; c2++) {
        var key = r2 + ':' + c2;
        if (covered[key]) continue;
        var td = document.createElement('td');
        // Merges make a row's cells stop lining up with sheet columns, so the
        // pane pinning needs each cell's real column carried on it.
        td._xlsxCol = c2;
        var span = spans[key];
        if (span) {
          if (span.rows > 1) td.rowSpan = span.rows;
          if (span.cols > 1) td.colSpan = span.cols;
        }
        var addr = u.encode_cell({ r: r2, c: c2 });
        var fillHex = xlsxFillHex(ws[addr], themeColors);
        if (fillHex) {
          td.style.backgroundColor = '#' + fillHex;
          if (xlsxIsDark(fillHex)) td.style.color = '#fff';
        }
        var display = xlsxCellDisplay(ctx, ws[addr], addr);
        if (display) {
          if (display.cls) {
            var marked = document.createElement('span');
            marked.className = display.cls;
            marked.textContent = display.text;
            td.appendChild(marked);
          } else {
            td.textContent = display.text;
          }
          if (display.numeric) td.className = 'officeXlsxNum';
          if (display.title) td.title = display.title;
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);

    if (truncated) {
      wrap.appendChild(xlsxNote('Showing the first ' + (lastRow - range.s.r + 1) + ' rows and ' +
        (lastCol - range.s.c + 1) + ' columns of this sheet. Download the file to see all of it.'));
    }
    section._xlsxPin = { table: table, nameBar: heading, firstRow: range.s.r, firstCol: range.s.c, frozen: frozen || null };
    return section;
  }

  async function renderXlsx(container, bytes) {
    await loadXlsxLib();
    // sheetStubs is the one that matters most: without it SheetJS silently
    // drops any formula cell saved with no value, so there'd be nothing left to
    // evaluate - that's exactly how these cells used to render blank.
    // cellFormula keeps each cell's .f; cellNF keeps .z so a value we calculate
    // ourselves is still formatted the way the workbook asked; cellStyles fills
    // in !cols widths. cellDates is deliberately left off - dates then stay
    // numeric serials the evaluator can do arithmetic on, while .w still
    // carries the formatted text we display.
    var wb = window.XLSX.read(bytes, { type: 'array', sheetStubs: true, cellFormula: true, cellNF: true, cellStyles: true });
    if (!wb.SheetNames.length) throw new Error('This workbook has no sheets.');
    container.innerHTML = '';
    // Every sheet renders inline, one after another, rather than behind tabs:
    // a workbook's later sheets were far too easy to miss entirely.
    var showNames = wb.SheetNames.length > 1;
    var scheme = wb.Themes && wb.Themes.themeElements && wb.Themes.themeElements.clrScheme;
    var themeColors = scheme ? scheme.map(function (c) { return c && c.rgb; }) : null;
    var panes = await xlsxReadFrozenPanes(bytes);
    var frag = document.createDocumentFragment();
    var sections = [];
    wb.SheetNames.forEach(function (name) {
      var section = buildXlsxSheet(wb.Sheets[name], name, showNames, themeColors, panes[name]);
      sections.push(section);
      frag.appendChild(section);
    });
    container.appendChild(frag);
    sections.forEach(function (section) { if (section._xlsxPin) xlsxPinPanes(section._xlsxPin); });
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

  // ---- Full screen for the attachment viewer ------------------------------
  // office-viewer.css already makes the viewer fill the browser window; this
  // adds a "Full screen" button that also hides the browser's own tabs and
  // address bar. Lives here because every page with #docViewerOverlay loads
  // this file, so no page needs its own copy. Browsers that can't put an
  // element full screen (e.g. iPhone Safari) simply don't get the button.
  function setupViewerFullscreen() {
    var overlay = document.getElementById('docViewerOverlay');
    if (!overlay) return;
    var panel = overlay.querySelector('.viewerPanel');
    var btns = overlay.querySelector('.viewerBtns');
    if (!panel || !btns || !(document.fullscreenEnabled || document.webkitFullscreenEnabled)) return;

    function current() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
    function exit() {
      if (!current()) return;
      var p = (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      if (p && p.catch) p.catch(function () {});
    }

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'docViewerFullscreen';
    btn.textContent = 'Full screen';
    btns.insertBefore(btn, btns.firstChild);
    btn.addEventListener('click', function () {
      if (current()) { exit(); return; }
      var request = panel.requestFullscreen || panel.webkitRequestFullscreen;
      try {
        var p = request.call(panel);
        if (p && p.catch) p.catch(function () {});
      } catch (e) {}
    });

    function sync() { btn.textContent = current() ? 'Exit full screen' : 'Full screen'; }
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);

    // Each page closes the viewer by removing .open; leave full screen then
    // too, so closing never strands the user on a blank full-screen panel.
    new MutationObserver(function () {
      if (!overlay.classList.contains('open')) exit();
    }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupViewerFullscreen);
  } else {
    setupViewerFullscreen();
  }
})();
