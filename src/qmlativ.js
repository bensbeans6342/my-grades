// Reader for Skyward's newer "Student Grades" page (Skyward Qmlativ):
// a grid with a Class column, a Missing Assignments column and one column per
// term (NW1, NW2, SE1, S1, ... FIN). The current grading period's columns are
// highlighted. Clicking a grade opens that class's assignment details.
//
// The grid is read by position on screen rather than by exact HTML structure,
// so it works whether the grid is built from <table>s or <div>s.

const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 10);
const titleCase = s => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : s);

// ---------------------------------------------------------------- in-page: read the grid
export function readQGridInPage() {
  const T = e => (e.textContent || '').replace(/\s+/g, ' ').trim();
  const R = e => e.getBoundingClientRect();
  const visible = e => { const r = R(e); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const cy = r => r.top + r.height / 2, cx = r => r.left + r.width / 2;

  // "Leaf" elements: the innermost element holding a given short text.
  const leaves = [];
  for (const e of document.querySelectorAll('body *')) {
    if (/^(SCRIPT|STYLE|NOSCRIPT|SVG|PATH)$/i.test(e.tagName)) continue;
    const t = T(e);
    if (!t || t.length > 60) continue;
    if ([...e.children].some(c => T(c) === t)) continue;
    if (!visible(e)) continue;
    leaves.push(e);
  }
  // Grow a leaf to the whole cell that holds the same text.
  const cellOf = e => { let c = e; while (c.parentElement && T(c.parentElement) === T(e) && c.parentElement !== document.body) c = c.parentElement; return c; };
  const bgLum = e => {
    for (let c = e, i = 0; c && i < 6; c = c.parentElement, i++) {
      const m = getComputedStyle(c).backgroundColor.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
      if (m && (m[4] === undefined || +m[4] > 0.1)) return (0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3]) / 255;
    }
    return 1;
  };
  const TERM = /^(?:[A-Z]{1,4}\d{0,2}|FINAL)$/;
  const GRADE = /^(?:\d{1,3}(?:\.\d+)?%?|[A-F][+-]?|P|I|NG|EX)$/;
  const clickable = e => !!(e.closest('a,button,[role="link"],[role="button"],[onclick]') || getComputedStyle(e).cursor === 'pointer');

  for (const ch of leaves.filter(e => /^class(es)?$/i.test(T(e)))) {
    const cr = R(cellOf(ch)), hy = cy(cr);
    const hdrs = leaves.filter(e => e !== ch && TERM.test(T(e)) && !/^class/i.test(T(e)) && R(e).left > cr.left && Math.abs(cy(R(e)) - hy) < 30);
    const seen = new Set();
    const cols = hdrs.sort((a, b) => R(a).left - R(b).left).filter(h => !seen.has(T(h)) && seen.add(T(h)))
      .map(h => { const cell = cellOf(h); return { label: T(h), rect: R(cell), lum: bgLum(cell) }; });
    if (cols.length < 2) continue;
    const maxLum = Math.max(...cols.map(c => c.lum));
    const terms = cols.map(c => ({ label: c.label, hl: c.lum < maxLum - 0.15 }));
    const missingHdr = leaves.find(e => /^missing/i.test(T(e)) && Math.abs(cy(R(e)) - hy) < 40);
    const missRect = missingHdr ? R(cellOf(missingHdr)) : null;
    const headerBottom = Math.max(cr.bottom, ...cols.map(c => c.rect.bottom));
    const classRight = Math.min(cols[0].rect.left, missRect ? missRect.left : Infinity);
    const inClassCol = r => r.left >= cr.left - 25 && r.left < classRight - 5;

    // Class names: emphasized text (link, bold or underlined) in the Class column.
    const names = leaves.filter(e => {
      const r = R(e), t = T(e), st = getComputedStyle(e);
      if (r.top < headerBottom - 2 || !inClassCol(r) || !/[A-Za-z]/.test(t) || /^period\b/i.test(t)) return false;
      return !!e.closest('a,[role="link"]') || +st.fontWeight >= 600 || st.textDecorationLine.includes('underline');
    }).sort((a, b) => R(a).top - R(b).top);
    if (!names.length) continue;

    const rowOf = y => { let k = -1; for (let i = 0; i < names.length; i++) if (y >= R(names[i]).top - 8) k = i; return k; };
    const rows = names.map(n => ({ name: T(n), period: '', missing: null, grades: {} }));
    let id = 0;
    for (const e of leaves) {
      const r = R(e), t = T(e);
      if (r.top < headerBottom - 2) continue;
      const k = rowOf(cy(r));
      if (k < 0) continue;
      if (inClassCol(r) && /^period\b/i.test(t) && !rows[k].period) { rows[k].period = t; continue; }
      if (missRect && cx(r) >= missRect.left && cx(r) <= missRect.right && /^\d+$/.test(t)) { rows[k].missing = +t; continue; }
      if (!GRADE.test(t)) continue;
      const col = cols.find(c => cx(r) >= c.rect.left - 2 && cx(r) <= c.rect.right + 2);
      if (!col || rows[k].grades[col.label]) continue;
      const mark = 'g' + (id++);
      e.setAttribute('data-mg', mark);
      rows[k].grades[col.label] = { text: t, mark, clickable: clickable(e) };
    }
    const withGrades = rows.filter(r => Object.keys(r.grades).length);
    if (withGrades.length) return { terms, rows: withGrades };
  }
  return null;
}

// ---------------------------------------------------------------- in-page: read a details view
export function readQDetailsInPage(prevSig) {
  const T = e => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const sels = ['[role="dialog"]', '[aria-modal="true"]', '.modal', '[class*="dialog" i]', '[class*="flyout" i]', '[class*="popup" i]', '[class*="Modal"]'];
  let box = null;
  for (const s of sels) for (const e of document.querySelectorAll(s)) {
    if (visible(e) && T(e).length > 20 && (!box || box.contains(e) || !e.contains(box))) box = e;
  }
  // If several nested matches, use the outermost one that is still visible.
  while (box && box.parentElement && sels.some(s => box.parentElement.matches(s)) && visible(box.parentElement)) box = box.parentElement;
  const root = box || document.body;
  const sig = T(root).slice(0, 4000);
  if (prevSig && sig === prevSig) return { sig, unchanged: true };
  const heads = [...root.querySelectorAll('h1,h2,h3,h4,caption,[role="heading"]')].map(T).filter(Boolean).slice(0, 10);
  const rows = [];
  for (const tr of root.querySelectorAll('tr,[role="row"]')) {
    if (tr.querySelector('tr,[role="row"]') || !visible(tr)) continue;
    const cells = [...tr.querySelectorAll(':scope > th, :scope > td, :scope > [role="gridcell"], :scope > [role="columnheader"], :scope > [role="cell"], :scope > [role="rowheader"]')];
    if (!cells.length) continue;
    const header = !!tr.closest('thead') || cells.every(c => c.tagName === 'TH' || c.getAttribute('role') === 'columnheader');
    rows.push({ header, cells: cells.map(T) });
  }
  // Category headings that sit outside the table rows (e.g. "Major (Weight: 60%)").
  const notes = [...root.querySelectorAll('*')].filter(e => e.children.length === 0 && /weight/i.test(T(e)) && T(e).length < 80).map(T);
  return { sig, inDialog: !!box, heads, rows, notes, html: root.outerHTML.slice(0, 1500000) };
}

export function closeQDetailsInPage() {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const sels = ['[aria-label*="close" i]', '[title*="close" i]', 'button.close', '.close', '[class*="close" i]', '[data-dismiss]'];
  for (const s of sels) for (const b of document.querySelectorAll(s)) if (visible(b)) { b.click(); return true; }
  for (const b of document.querySelectorAll('button,a,[role="button"]')) {
    if (visible(b) && /^(close|done|ok|back|cancel|×|x)$/i.test((b.textContent || '').trim())) { b.click(); return true; }
  }
  return false;
}

// ---------------------------------------------------------------- choosing the term
const AGGREGATE = /^(FIN|FINAL|S\d|SE\d|SEM\d?|EX\d?|E\d|Y|YR|AVG)$/i;
export function pickTerm(terms, grades, pref) {
  if (pref) {
    const t = terms.find(x => x.label.toLowerCase() === pref.toLowerCase());
    return t && grades[t.label] ? t.label : null;
  }
  const has = t => !!grades[t.label];
  const current = terms.filter(t => t.hl && has(t) && !AGGREGATE.test(t.label));
  if (current.length) return current[current.length - 1].label;
  const periods = terms.filter(t => has(t) && !AGGREGATE.test(t.label));
  if (periods.length) return periods[periods.length - 1].label;
  const any = terms.filter(has);
  return any.length ? any[any.length - 1].label : null;
}

// ---------------------------------------------------------------- parsing assignment details
const SCORE_RE = /(-?\d+(?:\.\d+)?)\s*(?:out of|\/)\s*(\d+(?:\.\d+)?)/i;
const WEIGHT_RE = /^(.*?)\s*[(\-–:,]?\s*(?:weight(?:ed)?(?:\s*at)?|wt\.?)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*%\)?/i;
const WEIGHT_RE2 = /^(.*?)\s*\(\s*(\d+(?:\.\d+)?)\s*%\s*(?:weight)?\s*\)/i;
const DATE_RE = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g;
const JUNK = /^([A-F][+-]?|-?\d+(\.\d+)?%?|\*|-|—|missing|late|exempt|excused|due|score|points?|grade|assignment|category)$/i;
const num = s => { const m = String(s ?? '').replace(/,/g, '').match(/^-?\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : null; };

function mapHeader(cells) {
  const find = (re, skip = []) => cells.findIndex((c, i) => re.test(c) && !skip.includes(i));
  const h = {};
  h.total = find(/total|possible|out of|max|worth|available/i);
  h.score = find(/^(score|points? earned|earned|pts\.? earned|your score|mark)$/i, [h.total]);
  if (h.score < 0) h.score = find(/score|earned/i, [h.total]);
  if (h.score < 0) h.score = find(/^points?$/i, [h.total]);
  h.percent = find(/^(%|percent|percentage|grade)$/i, [h.total, h.score]);
  h.name = find(/assignment|description|name|title|task/i, [h.total, h.score]);
  h.cat = find(/category|type|group/i, [h.total, h.score, h.name]);
  return h.score >= 0 || h.percent >= 0 ? h : null;
}

function weightFrom(text) {
  const m = text.match(WEIGHT_RE) || text.match(WEIGHT_RE2);
  if (!m) return null;
  const name = titleCase((m[1] || '').replace(/[\s:(\-–,]+$/, '').trim());
  return name ? { name, weight: parseFloat(m[2]) } : null;
}

export function parseQDetails(d) {
  const categories = [], assignments = [];
  const catByName = (name, weight = null) => {
    if (!name) return null;
    let k = categories.find(c => c.name.toLowerCase() === name.toLowerCase());
    if (!k) { k = { id: uid(), name, weight }; categories.push(k); }
    else if (weight != null && k.weight == null) k.weight = weight;
    return k;
  };
  for (const n of d.notes || []) { const w = weightFrom(n); if (w) catByName(w.name, w.weight); }

  let hdr = null, current = null;
  for (const { header, cells } of d.rows || []) {
    const filled = cells.filter(Boolean);
    if (!filled.length) continue;
    if (header) { hdr = mapHeader(cells) || hdr; continue; }
    const line = filled.join(' ');
    const w = filled.length <= 3 ? weightFrom(line) : null;
    if (w) { current = catByName(w.name, w.weight); continue; }
    // A row that looks like a header but isn't marked as one
    if (!hdr && filled.length >= 3 && mapHeader(cells) && !cells.some(c => SCORE_RE.test(c) || num(c) != null)) { hdr = mapHeader(cells); continue; }

    let score = null, max = null, nameIdx = -1, catText = null;
    if (hdr) {
      const s = cells[hdr.score] ?? '', t = hdr.total >= 0 ? cells[hdr.total] ?? '' : '';
      const m = s.match(SCORE_RE);
      if (m) { score = +m[1]; max = +m[2]; }
      else if (num(s) != null && num(t) != null) { score = num(s); max = num(t); }
      else if (num(s) != null && hdr.total < 0) { score = num(s); max = 100; }
      else if (hdr.percent >= 0 && num(cells[hdr.percent]) != null) { score = num(cells[hdr.percent]); max = 100; }
      nameIdx = hdr.name;
      if (hdr.cat >= 0) catText = cells[hdr.cat];
    }
    if (score == null) {
      const i = cells.findIndex(c => SCORE_RE.test(c.replace(DATE_RE, ' ')));
      if (i >= 0) { const m = cells[i].replace(DATE_RE, ' ').match(SCORE_RE); score = +m[1]; max = +m[2]; }
    }
    if (score == null || !(max > 0)) {
      // A category heading row without a weight (e.g. "Major Grades")
      if (filled.length === 1 && /[A-Za-z]/.test(filled[0]) && filled[0].length < 40) current = catByName(titleCase(filled[0]));
      continue;
    }
    let name = nameIdx >= 0 ? (cells[nameIdx] || '').trim() : '';
    if (!name) {
      const cand = cells.map(c => c.replace(DATE_RE, '').trim()).filter(c => c && !JUNK.test(c) && !SCORE_RE.test(c) && !categories.some(k => k.name.toLowerCase() === c.toLowerCase()));
      name = cand.length ? cand.reduce((a, b) => (b.length > a.length ? b : a)) : 'Assignment';
    }
    const cat = catText ? catByName(titleCase(catText.trim())) : current;
    assignments.push({ id: uid(), name, score, max, cat: cat ? cat.id : null });
  }
  const weighted = categories.length > 0 && categories.every(k => k.weight != null && k.weight > 0);
  return { categories, assignments, mode: weighted ? 'weighted' : 'points' };
}

// ---------------------------------------------------------------- the whole pull for this layout
export async function pullQmlativ({ context, page, frame, term, quick, log, PullError }) {
  let grid = await frame.evaluate(readQGridInPage);
  if (!grid || !grid.rows.length) throw new PullError('Found the Student Grades page but no class grades on it.');
  log(`Found ${grid.rows.length} classes (Student Grades page)`);
  if (term && !grid.terms.some(t => t.label.toLowerCase() === term.toLowerCase())) {
    throw new PullError(`There's no "${term}" column. The columns are: ${grid.terms.map(t => t.label).join(', ')}.`);
  }
  const homeUrl = page.url();
  const classes = [];
  let prevSig = null, firstUnreadDetails = null, detailsRead = 0, nothingOpened = 0;

  for (let n = 0; n < grid.rows.length; n++) {
    const row0 = grid.rows[n];
    const label = pickTerm(grid.terms, row0.grades, term);
    const termGrades = grid.terms.filter(t => row0.grades[t.label]).map(t => ({ label: t.label, grade: row0.grades[t.label].text, current: t.hl }));
    const cls = {
      id: uid(), name: row0.name, period: row0.period || '', missing: row0.missing,
      mode: 'points', categories: [], assignments: [],
      skywardGrade: label ? row0.grades[label].text : '', term: label || '', termGrades,
    };
    classes.push(cls);
    const g = label && row0.grades[label];
    if (quick || !g || !g.clickable || nothingOpened >= 2) continue;

    // Open this class's details
    const pagesBefore = context.pages().length;
    try {
      await frame.locator(`[data-mg="${g.mark}"]`).first().click({ timeout: 10000 });
    } catch (e) { continue; }
    let d = null, where = frame, newTab = null, navigated = false;
    const end = Date.now() + 15000, appearBy = Date.now() + 8000;
    let lastSig = null, stableSince = 0, opened = false;
    while (Date.now() < end) {
      await sleep(500);
      if (context.pages().length > pagesBefore) { newTab = context.pages()[context.pages().length - 1]; where = newTab.mainFrame(); }
      else if (page.url() !== homeUrl) { navigated = true; where = page.mainFrame(); }
      try { d = await where.evaluate(readQDetailsInPage, prevSig); } catch (e) { d = null; continue; }
      if (!d || d.unchanged) continue;
      if (!d.inDialog && !navigated && !newTab) {   // nothing opened yet
        if (Date.now() > appearBy) break;
        continue;
      }
      opened = true;
      if (d.sig !== lastSig) { lastSig = d.sig; stableSince = Date.now(); continue; }
      if (Date.now() - stableSince > 900 && (d.rows.length > 1 || Date.now() > end - 10000)) break;
    }
    if (!opened) {
      nothingOpened++;
      if (!firstUnreadDetails) firstUnreadDetails = await frame.evaluate(() => document.body.outerHTML.slice(0, 1500000)).catch(() => null);
      continue;
    }
    nothingOpened = 0;
    if (d && !d.unchanged) {
      prevSig = d.sig;
      const parsed = parseQDetails(d);
      if (parsed.assignments.length) {
        Object.assign(cls, parsed);
        detailsRead++;
      } else if (!firstUnreadDetails) firstUnreadDetails = d.html;
    }

    // Go back to the grid
    try {
      if (newTab) await newTab.close();
      else if (navigated) {
        await page.goBack().catch(() => {});
        if (page.url() !== homeUrl) await page.goto(homeUrl);
        await page.waitForLoadState().catch(() => {});
      } else {
        await frame.evaluate(closeQDetailsInPage).catch(() => {});
        await page.keyboard.press('Escape').catch(() => {});
      }
      await sleep(800);
    } catch (e) {}

    // Re-read the grid (needed after navigating; cheap otherwise) and keep marks in sync.
    for (let tries = 0; tries < 20; tries++) {
      const fresh = await frame.evaluate(readQGridInPage).catch(() => null);
      if (fresh && fresh.rows.length) { grid = fresh; break; }
      await sleep(500);
    }
  }
  if (quick) { log('Quick check: read the grades table only'); return { classes, notes: [], detailsHtml: null }; }
  log(`Read assignments for ${detailsRead} of ${classes.length} classes`);
  if (!detailsRead && !firstUnreadDetails) firstUnreadDetails = await frame.evaluate(() => document.body.outerHTML.slice(0, 1500000)).catch(() => null);
  const notes = [];
  if (detailsRead < classes.filter(c => c.skywardGrade).length) {
    notes.push(detailsRead
      ? "Some classes' assignments couldn't be read. Their Skyward grades are shown."
      : "Got your class grades, but couldn't read the assignment details yet. Download the details page below and share it (with names removed) so it can be adapted.");
  }
  return { classes, notes, detailsHtml: firstUnreadDetails };
}
