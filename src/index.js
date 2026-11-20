import { launch } from '@cloudflare/playwright';
import { pullGrades } from './pull.js';

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
      return json(await doPull(env, body));
    }
    return env.ASSETS.fetch(request);
  },
};

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
  if (gradesUrl === null || term === null) return { error: 'Bad request.' };
  return { cfg: { url: cl.href, username, password, gradesUrl: gradesUrl || null, term: term || null,
                  quick: b.quick === true && b.capture !== true, capture: b.capture === true } };
}

async function doPull(env, body) {
  const started = Date.now();
  const result = await pullOnce(env, body);
  result.elapsedMs = Date.now() - started;   // lets the page keep track of today's free browser time
  return result;
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
