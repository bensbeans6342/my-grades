// One-time "capture" of the requests a sign-in makes, used to build the
// plain-request (no browser) version. Everything secret is removed before it
// leaves the Worker: your password and username, cookies, sign-in tokens and codes.

const SECRET_KEY = /pass|pwd|token|code|session|saml|ticket|auth|csrf|xsrf|secret|sig|nonce|state|key|cookie|jwt|bearer|otp|relay/i;
const SECRET_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization|x-csrf|csrf|x-xsrf|xsrf|x-auth|x-api-key|x-session)/i;
const STATIC = /\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|otf|eot|css|map|mp4|mp3)(\?|$)/i;
const MAX_BODY = 20000, MAX_TOTAL = 6_000_000, MAX_PAGE = 900_000;
// Pages/data saved in full (secrets removed): the district sign-in, ClassLink's hand-off, and Skyward.
const FULL_HOST = /skyward|adfs|dirsync|idp\.classlink\.com|tenant-management-service/i;
const JS_SECRET = /token|csrf|xsrf|sessionguidhash|password|secret|samlresponse|samlrequest/i;

// secrets: { password, username }
export function makeRedactor({ password, username }) {
  const pairs = [[password, '[PASSWORD]'], [username, '[LOGIN]']]
    .filter(([w]) => typeof w === 'string' && w.length >= 3)
    .sort((a, b) => b[0].length - a[0].length);
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const variants = w => [...new Set([w, encodeURIComponent(w), encodeURIComponent(w).replace(/%20/g, '+'), JSON.stringify(w).slice(1, -1)])];
  const res = pairs.flatMap(([w, label]) => variants(w).map(v => [new RegExp(esc(v), 'gi'), label]));
  const text = s => { let t = String(s); for (const [re, rep] of res) t = t.replace(re, rep); return t; };

  const redactValue = (k, v) => (SECRET_KEY.test(k) && v !== '' ? `[REDACTED ${String(v).length} chars]` : text(v));

  const url = u => {
    try {
      const x = new URL(u);
      for (const [k, v] of [...x.searchParams]) x.searchParams.set(k, redactValue(k, v));
      if (x.hash.length > 1) x.hash = SECRET_KEY.test(x.hash) ? '#[REDACTED]' : text(x.hash);
      return text(decodeURI(x.href));
    } catch { return text(u); }
  };

  const headers = h => {
    const out = {};
    for (const [k, v] of Object.entries(h || {})) {
      if (SECRET_HEADER.test(k)) {
        // keep cookie names (useful), drop their values
        out[k] = /cookie/i.test(k)
          ? String(v).split(/;\s*|\n/).filter(p => p.includes('=') && !/^(path|domain|expires|max-age|samesite)=/i.test(p.trim()))
              .map(p => p.split('=')[0].trim() + '=[REDACTED]').join('; ')
          : '[REDACTED]';
      } else if (k.toLowerCase() === 'location') out[k] = url(v);
      else if (/^(content-type|accept|origin|referer|x-requested-with|content-length)$/i.test(k)) out[k] = /referer/i.test(k) ? url(v) : text(v);
    }
    return out;
  };

  const json = (v, depth = 0, key = '', full = false) => {
    if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      if (full) return (/<[a-z]/i.test(v) ? fullHtml(v) : redactValue(key, v)).slice(0, MAX_PAGE);
      const r = redactValue(key, v); return r.length > 300 ? r.slice(0, 300) + '…' : r;
    }
    if (depth > 12) return '[…]';
    const cap = full ? 500 : 25;
    if (Array.isArray(v)) {
      const a = v.slice(0, cap).map(x => json(x, depth + 1, key, full));
      if (v.length > cap) a.push(`[…${v.length - cap} more]`);
      return a;
    }
    const o = {};
    for (const [k, x] of Object.entries(v)) o[text(k)] = json(x, depth + 1, k, full);
    return o;
  };

  // A whole HTML page with secrets removed: password/login, values of secret-looking
  // inputs and meta tags, secret-looking JavaScript values, and long sign-in blobs.
  const fullHtml = s => {
    let h = text(s);
    h = h.replace(/<(input|meta)\b[^>]*>/gi, tag => {
      const nm = (tag.match(/\b(?:name|id|type)\s*=\s*["']([^"']*)["']/gi) || []).join(' ');
      if (!SECRET_KEY.test(nm) && !/type\s*=\s*["']password/i.test(tag)) return tag;
      return tag.replace(/\b(value|content)\s*=\s*(["'])([^"']*)\2/gi, (m, a, q, v) => `${a}=${q}[REDACTED ${v.length} chars]${q}`);
    });
    h = h.replace(/(["']?)([\w.$-]*)\1\s*([:=])\s*(["'])([^"'\n]{6,})\4/g, (m, q, name, op, q2, v) =>
      (JS_SECRET.test(name) ? `${q}${name}${q}${op}${q2}[REDACTED ${v.length} chars]${q2}` : m));
    h = h.replace(/[A-Za-z0-9+/=_-]{160,}/g, m => `[REDACTED long ${m.length} chars]`);
    return h;
  };

  const form = body => {
    if (!body) return body;
    try { return json(JSON.parse(body)); } catch {}
    if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(body)) {
      const p = new URLSearchParams(body), o = {};
      for (const [k, v] of p) o[k] = redactValue(k, v);
      return { formFields: o };
    }
    return text(body).slice(0, MAX_BODY);
  };

  // Summarize an HTML page: title, forms (fields with values hidden), scripts, and visible text start.
  const html = s => {
    const pick = (re, src) => [...src.matchAll(re)].map(m => m[1]);
    const forms = [...s.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map(m => ({
      attrs: text((m[1].match(/\b(action|method|id|name)\s*=\s*["'][^"']*["']/gi) || []).join(' ')),
      inputs: [...m[2].matchAll(/<(input|select|textarea|button)\b([^>]*)>/gi)].map(i => {
        const a = i[2];
        const g = n => (a.match(new RegExp(`\\b${n}\\s*=\\s*["']([^"']*)["']`, 'i')) || [])[1];
        const name = g('name') || g('id') || '';
        const val = g('value');
        return { tag: i[1], type: g('type') || '', name, value: val == null ? undefined : redactValue(name + ' ' + (g('type') || ''), val).slice(0, 80) };
      }),
    }));
    return {
      title: text((s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim(),
      forms,
      scripts: pick(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi, s).map(url).slice(0, 40),
      inlineScriptHints: pick(/<script\b(?![^>]*\bsrc)[^>]*>([\s\S]*?)<\/script>/gi, s)
        .map(x => text(x).replace(/\s+/g, ' ').trim()).filter(Boolean)
        .map(x => (SECRET_KEY.test(x) ? x.replace(/(["'])[A-Za-z0-9+/=_\-.]{24,}\1/g, '"[REDACTED]"') : x).slice(0, 600)).slice(0, 15),
      length: s.length,
    };
  };

  return { text, url, headers, json, form, html, fullHtml };
}

export function startCapture(context, secrets) {
  const R = makeRedactor(secrets);
  const log = [];
  let total = 0, n = 0;
  const started = Date.now();
  const onResponse = async resp => {
    try {
      const req = resp.request();
      const u = req.url();
      if (!/^https?:/.test(u)) return;
      const entry = {
        n: ++n, t: Date.now() - started,
        type: req.resourceType(), method: req.method(), url: R.url(u),
        status: resp.status(),
        requestHeaders: R.headers(await req.allHeaders().catch(() => req.headers())),
        responseHeaders: R.headers(await resp.allHeaders().catch(() => resp.headers())),
      };
      const pd = req.postData();
      if (pd) entry.requestBody = R.form(pd);
      if (req.redirectedFrom()) entry.redirectedFrom = R.url(req.redirectedFrom().url());
      const ct = (entry.responseHeaders['content-type'] || '').toLowerCase();
      const isStatic = STATIC.test(u) || /^(image|font|stylesheet|media)$/.test(entry.type);
      const isScript = entry.type === 'script' || ct.includes('javascript');
      if (!isStatic && !isScript && resp.status() < 300 && total < MAX_TOTAL) {
        const body = await resp.text().catch(() => null);
        const full = FULL_HOST.test(u);
        if (body != null) {
          if (ct.includes('json') || /^\s*[[{]/.test(body)) {
            try { entry.responseJson = R.json(JSON.parse(body), 0, '', full); } catch { entry.responseText = R.text(body).slice(0, MAX_BODY); }
          } else if (ct.includes('html') || /^\s*</.test(body)) {
            entry.responseHtml = R.html(body);
            if (full) entry.responseHtmlFull = R.fullHtml(body).slice(0, MAX_PAGE);
          } else entry.responseText = R.text(body).slice(0, 2000);
        }
      }
      const size = JSON.stringify(entry).length;
      total += size;
      if (total < MAX_TOTAL) log.push(entry);
    } catch (e) { /* never let capture break the pull */ }
  };
  context.on('response', onResponse);

  // Pages that submit themselves right away (sign-in hand-offs) are gone before their
  // response can be read, so save them from inside the page just before they submit.
  const pages = [];
  const seen = new Set();
  const savePage = (url, why, html) => {
    try {
      if (!FULL_HOST.test(url) || total > MAX_TOTAL) return;
      const key = url + '|' + html.length;
      if (seen.has(key)) return;
      seen.add(key);
      const entry = { t: Date.now() - started, why, url: R.url(url), html: R.fullHtml(html).slice(0, MAX_PAGE) };
      total += entry.html.length;
      pages.push(entry);
    } catch (e) {}
  };
  const ready = (async () => {
    try {
      await context.exposeBinding('__mgCapturePage', (source, url, why, html) => savePage(String(url), String(why), String(html)));
      await context.addInitScript(() => {
        const send = why => { try { window.__mgCapturePage(location.href, why, document.documentElement.outerHTML); } catch (e) {} };
        const orig = HTMLFormElement.prototype.submit;
        HTMLFormElement.prototype.submit = function () { send('form submitted'); return orig.apply(this, arguments); };
        document.addEventListener('submit', () => send('form submitted'), true);
        document.addEventListener('DOMContentLoaded', () => send('page loaded'));
        window.addEventListener('load', () => setTimeout(() => send('page settled'), 1500));
      });
    } catch (e) { /* not supported: the network log still has most of it */ }
  })();

  return {
    ready,
    stop: async () => {
      context.off?.('response', onResponse);
      await new Promise(r => setTimeout(r, 300));
      // last safety pass: no raw password/username anywhere
      return JSON.parse(R.text(JSON.stringify({ capturedAt: new Date().toISOString(), version: 2, requests: log, pages })));
    },
  };
}
