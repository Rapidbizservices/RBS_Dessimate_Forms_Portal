// sortable-table.js — click-to-sort table column headers (ascending/
// descending, with a Windows-Explorer-style ▲/▼ indicator), shared by every
// list view. A page wires this once per table: mark each sortable <th> with
// data-sort-key="<field>", keep one { key, dir } sort-state object, call
// makeSortableHeaders() on init, then inside the existing render function
// call sortItems() on the full dataset before mapping rows and
// updateSortIndicators() to refresh the arrows.
(function () {
  'use strict';

  // Natural/alphanumeric compare (numeric runs compare numerically, e.g.
  // "3010" < "3010-B" < "3011", not lexicographically) - matches the ordering
  // Windows Explorer uses, which is what this was modeled on. Actual JS
  // numbers (e.g. a money total) compare directly; everything else goes
  // through this as a string. Empty/null/undefined always sorts last,
  // regardless of direction, so an ascending sort doesn't bury real values
  // under a pile of blanks first.
  function compareValues(a, b) {
    var aEmpty = (a === null || a === undefined || a === '');
    var bEmpty = (b === null || b === undefined || b === '');
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }

  // headerRoot: the element containing the sortable <th>s (a <thead> or
  // <tr>). sortState: a plain { key: null, dir: 1 } object the caller owns
  // and passes to sortItems()/updateSortIndicators() too. onChange(): called
  // after a header click updates sortState - re-render from here.
  function makeSortableHeaders(headerRoot, sortState, onChange) {
    if (!headerRoot) return;
    headerRoot.querySelectorAll('[data-sort-key]').forEach(function (th) {
      th.classList.add('sortableCol');
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-sort-key');
        if (sortState.key === key) sortState.dir = -sortState.dir;
        else { sortState.key = key; sortState.dir = 1; }
        onChange();
      });
    });
  }

  // Returns a sorted copy of items (original array/order untouched) per
  // sortState; if no column is active yet, returns items as-is.
  // getValue(item, key) extracts the field to compare - usually just
  // `item[key]`, but callers can compute a derived value (e.g. a money
  // field stored as a string).
  function sortItems(items, sortState, getValue) {
    if (!sortState || !sortState.key) return items;
    var copy = items.slice();
    copy.sort(function (a, b) {
      return sortState.dir * compareValues(getValue(a, sortState.key), getValue(b, sortState.key));
    });
    return copy;
  }

  function updateSortIndicators(headerRoot, sortState) {
    if (!headerRoot) return;
    headerRoot.querySelectorAll('[data-sort-key]').forEach(function (th) {
      var key = th.getAttribute('data-sort-key');
      var indicator = th.querySelector('.sortArrow');
      if (!indicator) {
        indicator = document.createElement('span');
        indicator.className = 'sortArrow';
        th.appendChild(indicator);
      }
      indicator.textContent = (sortState && sortState.key === key) ? (sortState.dir === 1 ? ' ▲' : ' ▼') : '';
    });
  }

  window.SortableTable = {
    compareValues: compareValues,
    makeSortableHeaders: makeSortableHeaders,
    sortItems: sortItems,
    updateSortIndicators: updateSortIndicators
  };
})();
