// One-time "capture" of the requests a sign-in makes, used to build the
// plain-request (no browser) version. Everything secret is removed before it
// leaves the Worker: your password and username, cookies, sign-in tokens and codes.

const SECRET_KEY = /pass|pwd|token|code|session|saml|ticket|auth|csrf|xsrf|secret|sig|nonce|state|key|cookie|jwt|bearer|otp|relay/i;
const SECRET_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization|x-csrf|csrf|x-xsrf|xsrf|x-auth|x-api-key|x-session)/i;
const STATIC = /\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|otf|eot|css|map|mp4|mp3)(\?|$)/i;
const MAX_BODY = 20000, MAX_TOTAL = 3_000_000;

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

  const json = (v, depth = 0, key = '') => {
    if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'string') { const r = redactValue(key, v); return r.length > 300 ? r.slice(0, 300) + '…' : r; }
    if (depth > 12) return '[…]';
    if (Array.isArray(v)) {
      const a = v.slice(0, 25).map(x => json(x, depth + 1, key));
      if (v.length > 25) a.push(`[…${v.length - 25} more]`);
      return a;
    }
    const o = {};
    for (const [k, x] of Object.entries(v)) o[text(k)] = json(x, depth + 1, k);
    return o;
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

  return { text, url, headers, json, form, html };
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
        if (body != null) {
          if (ct.includes('json') || /^\s*[[{]/.test(body)) {
            try { entry.responseJson = R.json(JSON.parse(body)); } catch { entry.responseText = R.text(body).slice(0, MAX_BODY); }
          } else if (ct.includes('html') || /^\s*</.test(body)) entry.responseHtml = R.html(body);
          else entry.responseText = R.text(body).slice(0, 2000);
        }
      }
      const size = JSON.stringify(entry).length;
      total += size;
      if (total < MAX_TOTAL) log.push(entry);
    } catch (e) { /* never let capture break the pull */ }
  };
  context.on('response', onResponse);
  return {
    stop: async () => {
      context.off?.('response', onResponse);
      await new Promise(r => setTimeout(r, 300));
      // last safety pass: no raw password/username anywhere
      return JSON.parse(R.text(JSON.stringify({ capturedAt: new Date().toISOString(), requests: log })));
    },
  };
}
