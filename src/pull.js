// Signs in to ClassLink, opens Skyward > Gradebook, and reads every class's
// grade details. Takes a Playwright Browser (Cloudflare's, or a normal one for testing).

const GRADE_LINK = 'a[id="showGradeInfo"]';
// ClassLink's first screen asks how to sign in; pick "Network Login" (not Google).
const LOGIN_CHOICE = ['button:has-text("Network Login")', 'a:has-text("Network Login")',
  '[role="button"]:has-text("Network Login")', '[aria-label*="Network Login" i]',
  '[title*="Network Login" i]', 'text=/network login/i'];
const USER_FIELDS = ['#username', 'input[name="username"]', 'input[autocomplete="username"]',
  'input[type="email"]', 'input[name="loginfmt"]', 'input[name="identifier"]',
  'input[type="text"]:not([readonly])'];
const PASS_FIELDS = ['#password', 'input[type="password"]'];
const SUBMIT_BTNS = ['#signin', 'button[type="submit"]', 'input[type="submit"]',
  'button:has-text("Sign In")', 'button:has-text("Next")'];
const SKYWARD_TILE = ['[aria-label*="Skyward" i]', '[title*="Skyward" i]', 'img[alt*="Skyward" i]',
  'a:has-text("Skyward")', 'div:has-text("Skyward") >> nth=-1'];
const GRADEBOOK_NAV = ['[data-nav*="gradebook" i]', 'a[href$="/grading" i]', 'a[href*="/grading" i]',
  'a:has-text("Gradebook")', '[role="tab"]:has-text("Grading")', 'a:has-text("Grading")',
  'a:has-text("Student Grades")', '[role="menuitem"]:has-text("Student Grades")', 'text=Gradebook', 'text=Student Grades'];
const GRADES_PAGE_RE = /\/grading|gradebook/i;

async function skywardPage(context, timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const pages = context.pages().filter(p => p.url().startsWith('http') && !p.url().toLowerCase().includes('classlink'));
    if (pages.length) return pages[pages.length - 1];
    if (Date.now() > end) return null;
    await sleep(500);
  }
}

const SCORE_RE = /(-?\d+(?:\.\d+)?)\s*out of\s*(\d+(?:\.\d+)?)/i;
const SLASH_RE = /(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/;
const WEIGHT_RE = /^([\s\S]*?)\s*[(\-–:]?\s*weighted at\s*(\d+(?:\.\d+)?)\s*%/i;
const FULL_DATE_RE = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
const JUNK_RE = /^([A-F][+-]?|-?\d+(\.\d+)?%?|\d{1,2}\/\d{1,2}|\*|-|—|(due|assigned|score|points( earned)?|grade|assignment|category|missing|no count|absent)s?)$/i;
const HEADING_SKIP = /^(class grades?|grade info|gradebook|close|print)$/i;

import { readQGridInPage, pullQmlativ } from './qmlativ.js';
import { startCapture } from './capture.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 10);
const titleCase = s => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : s);

class PullError extends Error {}

async function findVisible(context, selectors, timeoutMs, skipIf) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const page of context.pages()) {
      try {
        for (const frame of page.frames()) {
          if (skipIf && (await frame.locator(skipIf).count()) > 0) return { page, frame, loc: null, skipped: true };
          for (const sel of selectors) {
            const loc = frame.locator(sel);
            const n = Math.min(await loc.count(), 5);
            for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible()) return { page, frame, loc: loc.nth(i) };
          }
        }
      } catch (e) { /* page navigating; try again */ }
    }
    await sleep(500);
  }
  return null;
}

async function clickFirst(page, frame, selectors) {
  for (const sel of selectors) {
    const loc = frame.locator(sel);
    const n = Math.min(await loc.count(), 5);
    for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible()) { await loc.nth(i).click(); return; }
  }
  await page.keyboard.press('Enter');
}

async function signIn(context, username, password, log, gradesUrl) {
  const first = await findVisible(context, [...LOGIN_CHOICE, ...USER_FIELDS], 40000, GRADE_LINK);
  if (first && !first.skipped) {
    const choice = await findVisible(context, LOGIN_CHOICE, 400);
    if (choice) { await choice.loc.click(); log('Chose Network Login'); }
  }
  const u = await findVisible(context, USER_FIELDS, 30000, GRADE_LINK);
  if (!u) throw new PullError("Couldn't find the ClassLink login form. Check the CLASSLINK_URL secret.");
  if (u.skipped) return;
  await u.loc.fill(username);
  let p = await findVisible(context, PASS_FIELDS, 2000);
  if (!p) {
    await clickFirst(u.page, u.frame, SUBMIT_BTNS);
    p = await findVisible(context, PASS_FIELDS, 15000);
  }
  if (!p) throw new PullError("Couldn't find the password box after entering the username.");
  await p.loc.fill(password);
  await clickFirst(p.page, p.frame, SUBMIT_BTNS);
  log('Submitted login');

  const nav = await findVisible(context, GRADEBOOK_NAV, 8000, GRADE_LINK);
  if (!nav) {
    const still = await findVisible(context, PASS_FIELDS, 1000);
    const tile = await findVisible(context, SKYWARD_TILE, 40000, GRADE_LINK);
    if (!tile) {
      throw new PullError(still
        ? 'Still on the login page after signing in. The username or password may be wrong.'
        : "Signed in, but couldn't find the Skyward tile on the ClassLink page.");
    }
    if (!tile.skipped) { await tile.loc.click(); log('Opened Skyward'); }
  }
  if (gradesUrl) {
    const sky = await skywardPage(context, 30000);
    if (!sky) throw new PullError("Couldn't find the Skyward tab after opening it.");
    await sky.waitForLoadState();
    // Only follow the grades address on the same site Skyward opened on.
    const want = new URL(gradesUrl), have = new URL(sky.url());
    if (want.host.toLowerCase() !== have.host.toLowerCase()) {
      throw new PullError(`The grades page address must be on the same site as Skyward (${have.host}).`);
    }
    pullGrades.lastPage = sky;
    await sky.goto(gradesUrl);
    log('Went to ' + gradesUrl);
    return;
  }
  const gb = await findVisible(context, GRADEBOOK_NAV, 30000, GRADE_LINK);
  if (gb && !gb.skipped) { await gb.loc.click(); log('Opened the grades page'); return; }
  if (gb) return;
  const sky = await skywardPage(context, 5000);
  if (!sky) throw new PullError("Opened Skyward, but couldn't find the Gradebook or Grading page.");
  const target = new URL('/grading', sky.url()).href;
  log('No grades link on the Skyward home page; went to ' + target);
  pullGrades.lastPage = sky;
  await sky.goto(target);
}

async function waitForGradebook(context, timeoutMs, gradesUrl, onUnknownLayout) {
  const gu = (gradesUrl || '').split('#')[0].replace(/\/+$/, '').toLowerCase();
  const isGradesPage = u => GRADES_PAGE_RE.test(u || '') || (gu && (u || '').toLowerCase().startsWith(gu));
  const end = Date.now() + timeoutMs;
  let since = null;
  while (Date.now() < end) {
    for (const page of context.pages()) {
      try {
        for (const frame of page.frames()) {
          if ((await frame.locator(GRADE_LINK).count()) > 0) { await sleep(1500); return { page, frame, kind: 'classic' }; }
          const q = await frame.evaluate(readQGridInPage).catch(() => null);
          if (q && q.rows.length) { await sleep(1500); pullGrades.lastPage = page; return { page, frame, kind: 'qmlativ' }; }
        }
      } catch (e) {}
    }
    const gp = context.pages().find(p => isGradesPage(p.url()));
    if (gp) {
      pullGrades.lastPage = gp;
      since = since || Date.now();
      if (Date.now() - since > 20000) {
        try { if (onUnknownLayout) await onUnknownLayout(await gp.content()); } catch (e) {}
        throw new PullError(`Reached ${gp.url()} but couldn't find a grades table on it that this can read. Download the copy of the page below and share it (with your name removed) so the reader can be adapted.`);
      }
    }
    await sleep(1000);
  }
  throw new PullError("The Gradebook page didn't show any grades.");
}

async function chooseLinks(frame, term) {
  const links = frame.locator(GRADE_LINK);
  const n = await links.count();
  const rows = new Map();
  for (let i = 0; i < n; i++) {
    const el = links.nth(i);
    const info = await el.evaluate(e => {
      const o = {};
      for (const a of e.attributes) o[a.name] = a.value;
      const tr = e.closest('tr');
      o.__row = tr ? (tr.parentNode.parentNode.id || 't') + ':' + [...tr.parentNode.children].indexOf(tr) : '';
      const c = tr && tr.querySelector('.classDesc, td.classDesc, [class*="classDesc"]');
      o.__name = c ? c.innerText.trim().split('\n')[0] : '';
      return o;
    });
    const text = (await el.innerText()).trim();
    if (!text) continue;
    info.__idx = i; info.__text = text;
    const key = info.__row || `link${i}`;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(info);
  }
  const chosen = [];
  for (const list of rows.values()) {
    if (term) {
      const pick = list.filter(l => (l['data-lit'] || '').toLowerCase() === term.toLowerCase());
      if (pick.length) chosen.push(pick[pick.length - 1]);
    } else chosen.push(list[list.length - 1]);
  }
  return chosen;
}

// Runs inside the page: find the visible grade-details dialog and pull out its rows.
function readDialogInPage() {
  const sels = ['#gradeInfoDialog', '.sf_DialogWrap', '.ui-dialog', '[role="dialog"]'];
  const vis = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  let best = null;
  for (const s of sels) for (const e of document.querySelectorAll(s)) if (vis(e)) best = e;
  if (!best) return null;
  const heads = [...best.querySelectorAll('h1,h2,h3,caption,.gb_heading,.sf_DialogHead,a[id*="Class"]')]
    .map(e => e.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const rows = [...best.querySelectorAll('tr')].filter(tr => !tr.querySelector('tr'))
    .map(tr => [...tr.querySelectorAll('td,th')].map(c => c.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean))
    .filter(r => r.length);
  return { sig: best.innerText.slice(0, 4000), heads, rows };
}

function closeDialogInPage() {
  const sels = ['.sf_DialogClose', 'a[id$="Close"]', '.ui-dialog-titlebar-close', 'button[aria-label="Close"]'];
  for (const s of sels) for (const b of document.querySelectorAll(s)) if (b.getClientRects().length) { b.click(); return true; }
  return false;
}

async function readDialog(page, frame, idx, previousSig) {
  const link = frame.locator(GRADE_LINK).nth(idx);
  await link.scrollIntoViewIfNeeded();
  await link.click();
  let d = null, lastSig = null, stableSince = 0;
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    await sleep(400);
    d = await frame.evaluate(readDialogInPage);
    if (!d || d.sig === previousSig) continue;
    if (d.sig !== lastSig) { lastSig = d.sig; stableSince = Date.now(); }
    else if (Date.now() - stableSince > 800) {
      const low = d.sig.toLowerCase();
      if (low.includes('out of') || low.includes('weighted') || Date.now() > end - 12000) break;
    }
  }
  try { await frame.evaluate(closeDialogInPage); await page.keyboard.press('Escape'); await sleep(600); } catch (e) {}
  return d;
}

export function parseDialog(d) {
  const name = (d.heads || []).find(t => t.length > 2 && !HEADING_SKIP.test(t)) || null;
  const categories = [], assignments = [];
  let current = null;
  for (const cells of d.rows || []) {
    const line = cells.join('\t');
    const w = line.match(WEIGHT_RE);
    if (w) {
      const cname = titleCase(w[1].split('\t')[0].trim() || 'Category');
      current = categories.find(k => k.name.toLowerCase() === cname.toLowerCase());
      if (!current) { current = { id: uid(), name: cname, weight: parseFloat(w[2]) }; categories.push(current); }
      continue;
    }
    let idx = -1, m = null;
    for (let i = 0; i < cells.length; i++) {
      const c2 = cells[i].replace(FULL_DATE_RE, ' ');
      m = c2.match(SCORE_RE) || c2.match(SLASH_RE);
      if (m) { idx = i; break; }
    }
    if (!m) continue;
    const score = parseFloat(m[1]), max = parseFloat(m[2]);
    if (!(max > 0)) continue;
    const catNames = new Set(categories.map(k => k.name.toLowerCase()));
    const before = cells.slice(0, idx).map(c => c.replace(FULL_DATE_RE, '').trim())
      .filter(c => c && !JUNK_RE.test(c) && !catNames.has(c.toLowerCase()));
    const aname = before.length ? before.reduce((a, b) => (b.length > a.length ? b : a)) : 'Assignment';
    assignments.push({ id: uid(), name: aname, score, max, cat: current ? current.id : null });
  }
  return { name, categories, assignments };
}

/**
 * @param browser  Playwright Browser
 * @param cfg      { url, username, password, term?, gradesUrl?, log?, onUnknownLayout? }
 * @returns        { classes, page } (page is returned for screenshots on error)
 */
export async function pullGrades(browser, cfg) {
  const log = cfg.log || (() => {});
  if (!cfg.url || !cfg.username || !cfg.password) {
    throw new PullError('Enter your ClassLink address, username and password.');
  }
  const page = await browser.newPage();
  const context = page.context();
  pullGrades.lastContext = context;
  pullGrades.lastPage = null;
  pullGrades.capture = cfg.capture ? startCapture(context, { password: cfg.password, username: cfg.username }) : null;
  await page.goto(cfg.url.includes('://') ? cfg.url : 'https://' + cfg.url);
  log('Opened ClassLink');
  await signIn(context, cfg.username, cfg.password, log, cfg.gradesUrl);
  const { page: gbPage, frame, kind } = await waitForGradebook(context, 90000, cfg.gradesUrl, cfg.onUnknownLayout);
  if (kind === 'qmlativ') return pullQmlativ({ context, page: gbPage, frame, term: cfg.term, quick: !!cfg.quick, log, PullError });
  const links = await chooseLinks(frame, cfg.term);
  if (!links.length) throw new PullError(`No grades found${cfg.term ? ' for term ' + cfg.term : ''} in Gradebook.`);
  log(`Found ${links.length} classes`);
  const classes = [];
  let prev = null;
  for (let n = 0; n < links.length; n++) {
    const info = links[n];
    const d = await readDialog(gbPage, frame, info.__idx, prev);
    prev = d ? d.sig : prev;
    const parsed = d ? parseDialog(d) : { name: null, categories: [], assignments: [] };
    classes.push({
      id: uid(),
      name: info.__name || parsed.name || `Class ${n + 1}`,
      mode: parsed.categories.length ? 'weighted' : 'points',
      categories: parsed.categories,
      assignments: parsed.assignments,
      skywardGrade: info.__text,
      term: info['data-lit'] || '',
    });
  }
  return { classes, notes: [], detailsHtml: null };
}

export { PullError };
