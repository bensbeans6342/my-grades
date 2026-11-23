import { launch } from '@cloudflare/playwright';
import { pullGrades } from './pull.js';
import { signInAndOpenGrades, fetchDetails } from './direct.js';

// Serves your grade page (from /public) and does one thing on request:
// POST /api/pull with your ClassLink login -> signs in, reads Skyward, returns your grades.
// Nothing is stored here: no passwords, no grades, no logs of what you send.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/pull') {
      if (request.method !== 'POST') return json({ ok: false, error: 'Use POST.' }, 405);
      // Only accept requests from this Worker's own page, not from other websites.
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) return json({ ok: false, error: 'Not allowed.' }, 403);
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: 'Bad request.' }, 400); }
      return json(await doPull(env, withDefaults(env, body)));
    }
    if (url.pathname === '/api/details') {
      if (request.method !== 'POST') return json({ ok: false, error: 'Use POST.' }, 405);
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) return json({ ok: false, error: 'Not allowed.' }, 403);
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: 'Bad request.' }, 400); }
      return json(await doDetails(body));
    }
    if (url.pathname === '/api/defaults') return json(districtDefaults(env));
    return env.ASSETS.fetch(request);
  },
};

// Your district's sign-in settings, kept as Worker secrets in the Cloudflare dashboard (not in this
// public code): CLASSLINK_URL, SKYWARD_LINK, CLASSLINK_CODE, USERNAME_DOMAIN. All optional.
// They pre-fill the sign-in box and are used for any of those boxes left blank.
function districtDefaults(env) {
  const v = k => (typeof env[k] === 'string' ? env[k].trim() : '');
  const url = k => { const x = v(k); return x && !/^https?:\/\//i.test(x) ? 'https://' + x : x; };
  return { classlinkUrl: url('CLASSLINK_URL'), launchUrl: url('SKYWARD_LINK'), tenantCode: v('CLASSLINK_CODE'), userDomain: v('USERNAME_DOMAIN') };
}
function withDefaults(env, body) {
  if (!body || typeof body !== 'object') return body;
  const d = districtDefaults(env), out = { ...body };
  for (const k of Object.keys(d)) if (!out[k] && d[k]) out[k] = d[k];
  return out;
}

function checkInput(b) {
  const str = (v, max) => (typeof v === 'string' && v.length <= max ? v.trim() : null);
  const username = str(b?.username, 200), password = typeof b?.password === 'string' && b.password.length <= 200 ? b.password : null;
  const classlinkUrl = str(b?.classlinkUrl, 300), gradesUrl = str(b?.gradesUrl ?? '', 500), term = str(b?.term ?? '', 10);
  if (!username || !password) return { error: 'Enter your ClassLink username and password.' };
  let cl;
  try { cl = new URL(classlinkUrl); } catch { return { error: 'The ClassLink address isn\'t a valid web address.' }; }
  const host = cl.hostname.toLowerCase();
  if (cl.protocol !== 'https:' || !(host === 'classlink.com' || host.endsWith('.classlink.com'))) {
    return { error: 'The ClassLink address must be a classlink.com page, e.g. https://launchpad.classlink.com/yourdistrict' };
  }
  if (gradesUrl) {
    try { if (new URL(gradesUrl).protocol !== 'https:') throw 0; } catch { return { error: 'The grades page address must start with https://' }; }
  }
  const tenantCode = str(b?.tenantCode ?? '', 60), userDomain = str(b?.userDomain ?? '', 100), launchUrl = str(b?.launchUrl ?? '', 500);
  if (tenantCode === null || userDomain === null || launchUrl === null) return { error: 'Bad request.' };
  if (tenantCode && !/^[\w-]+$/.test(tenantCode)) return { error: 'The ClassLink code can only have letters, numbers, - and _.' };
  if (userDomain && !/^[\w.-]+$/.test(userDomain)) return { error: "The username domain can only have letters, numbers, dots and dashes." };
  if (launchUrl) {
    let lu; try { lu = new URL(launchUrl); } catch { return { error: 'The Skyward link isn\'t a valid web address.' }; }
    const lh = lu.hostname.toLowerCase();
    if (lu.protocol !== 'https:' || !(lh === 'classlink.com' || lh.endsWith('.classlink.com'))) return { error: 'The Skyward link must be a classlink.com link (https://...classlink.com/...).' };
  }
  if (gradesUrl === null || term === null) return { error: 'Bad request.' };
  return { cfg: { url: cl.href, username, password, gradesUrl: gradesUrl || null, term: term || null, tenantCode, userDomain, launchUrl,
                  quick: b.quick === true && b.capture !== true, capture: b.capture === true } };
}

async function doPull(env, body) {
  const started = Date.now();
  // The browser is only used for the one-time "Capture sign-in" troubleshooting tool.
  if (body?.capture === true) {
    const result = await pullOnce(env, body);
    result.mode = 'browser';
    result.elapsedMs = result.browserMs = Date.now() - started;
    return result;
  }
  const { cfg, error } = checkInput(body);
  if (error) return { ok: false, error, elapsedMs: 0, browserMs: 0 };
  const steps = [];
  try {
    const r = await signInAndOpenGrades({ url: cfg.url, username: cfg.username, password: cfg.password,
      tenantCode: cfg.tenantCode, userDomain: cfg.userDomain, launchUrl: cfg.launchUrl, log: m => steps.push(m) });
    return { ok: true, mode: 'direct', grids: r.grids, student: r.student, session: r.session, steps, quick: cfg.quick,
             pulledAt: new Date().toISOString(), elapsedMs: Date.now() - started, browserMs: 0 };
  } catch (e) {
    const msg = String(e?.message || e).split('\n')[0].slice(0, 300);
    return { ok: false, error: msg, steps, elapsedMs: Date.now() - started, browserMs: 0 };
  }
}

async function doDetails(body) {
  const cells = Array.isArray(body?.cells) ? body.cells.slice(0, 15) : [];
  const session = body?.session;
  if (!session || !session.sky || !Array.isArray(session.jar) || !/^https:\/\/[^/]*skyward[^/]*\//i.test(String(session.sky.base) + '/')) {
    return { ok: false, error: 'Bad request.' };
  }
  try {
    const r = await fetchDetails({ session, cells });
    return { ok: true, details: r.details, session: r.session };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 200) };
  }
}

async function pullOnce(env, body) {
  const { cfg, error: inputError } = checkInput(body);
  if (inputError) return { ok: false, error: inputError };
  const steps = [];
  let pageHtml = null, browser;
  try {
    browser = await launch(env.BROWSER);
    const { classes, notes, detailsHtml } = await pullGrades(browser, {
      ...cfg, log: m => steps.push(m), onUnknownLayout: html => { pageHtml = html; },
    });
    const capture = await stopCapture();
    return { ok: true, quick: cfg.quick, data: { server: true, pulledAt: new Date().toISOString(), classes }, notes, detailsHtml, steps, capture };
  } catch (e) {
    let screenshot = null;
    try {
      const pages = pullGrades.lastContext?.pages() || [];
      const lp = pullGrades.lastPage;
      const last = lp && !lp.isClosed() ? lp : pages[pages.length - 1];
      if (last) screenshot = 'data:image/png;base64,' + Buffer.from(await last.screenshot()).toString('base64');
    } catch (_) {}
    const capture = await stopCapture();
    return { ok: false, error: friendly(e), steps, screenshot, pageHtml: pageHtml ? pageHtml.slice(0, 2_000_000) : null, capture };
  } finally {
    try { await browser?.close(); } catch (_) {}
  }
}

async function stopCapture() {
  const c = pullGrades.capture;
  pullGrades.capture = null;
  if (!c) return undefined;
  try { return await c.stop(); } catch { return null; }
}

function friendly(e) {
  const msg = String(e?.message || e);
  if (/429|time limit exceeded|rate limit/i.test(msg)) return 'Cloudflare\'s free browser time for today is used up. It resets at 6 PM Central (midnight UTC).';
  return msg.split('\n')[0].slice(0, 300);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
