// Plain-request ("direct") version: signs in to ClassLink and Skyward with ordinary
// web requests, the same ones a browser makes, with no browser involved.
//
//   1. ClassLink → Network Login → district sign-in form (ADFS) → hand-off forms back to ClassLink
//   2. ClassLink's Skyward link → hand-off forms → Skyward home page
//   3. Skyward Student Grades → the grades table (GetBrowse)
//   4. Per class: the grade's details → the assignment list (GetBrowse)
//
// The Worker does as little processing as possible (Cloudflare's free plan allows 10 ms of
// CPU per call): it passes Skyward's tables back as-is and the page reads them.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
const SUBREQUEST_LIMIT = 48;   // Cloudflare free plan: 50 outgoing requests per call

// ClassLink address path → ClassLink tenant code, when they differ and the page doesn't say.
const TENANT_CODES = { pisd: 'plano' };
// District sign-in servers → the domain they put in front of the username.
const ADFS_DOMAINS = { 'dirsync.pisd.edu': 'ad.pisd.edu' };
// Known ClassLink launch links for Skyward, by tenant code (saves two requests).
const SKYWARD_LAUNCH = { plano: 'https://idp.classlink.com/sso/select/YW9adUh6V2NONEk9' };

export class DirectError extends Error {
  constructor(message, { auth = false, step = '' } = {}) { super(message); this.auth = auth; this.step = step; }
}

// ---------------------------------------------------------------- cookies
export class Jar {
  constructor(list = []) { this.list = list; }
  store(url, setCookies) {
    const host = new URL(url).hostname.toLowerCase();
    for (const sc of setCookies) {
      const parts = sc.split(';').map(s => s.trim());
      const eq = parts[0].indexOf('=');
      if (eq <= 0) continue;
      const name = parts[0].slice(0, eq).trim(), value = parts[0].slice(eq + 1).trim();
      let domain = host, hostOnly = true, path = '/', expired = false;
      for (const p of parts.slice(1)) {
        const [k, ...v] = p.split('='); const key = k.trim().toLowerCase(), val = v.join('=').trim();
        if (key === 'domain' && val) { domain = val.replace(/^\./, '').toLowerCase(); hostOnly = false; }
        else if (key === 'path' && val) path = val;
        else if (key === 'max-age' && Number(val) <= 0) expired = true;
        else if (key === 'expires' && Date.parse(val) < Date.now()) expired = true;
      }
      this.list = this.list.filter(c => !(c.name === name && c.domain === domain && c.path === path));
      if (!expired) this.list.push({ name, value, domain, hostOnly, path });
    }
  }
  header(url) {
    const u = new URL(url), host = u.hostname.toLowerCase(), path = u.pathname || '/';
    return this.list
      .filter(c => (c.hostOnly ? host === c.domain : host === c.domain || host.endsWith('.' + c.domain)) && path.startsWith(c.path))
      .sort((a, b) => b.path.length - a.path.length)
      .map(c => `${c.name}=${c.value}`).join('; ');
  }
  only(hostPart) { return new Jar(this.list.filter(c => c.domain.includes(hostPart))); }
}

function setCookiesOf(res) {
  const h = res.headers;
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  if (typeof h.getAll === 'function') { try { return h.getAll('Set-Cookie'); } catch (e) {} }
  const one = h.get('set-cookie');
  return one ? one.split(/,(?=\s*[^;,=\s]+=)/) : [];
}

// ---------------------------------------------------------------- HTTP with manual redirects
export class Session {
  constructor({ jar = new Jar(), limit = SUBREQUEST_LIMIT, log = () => {}, fetchImpl = fetch } = {}) {
    this.jar = jar; this.count = 0; this.limit = limit; this.log = log;
    // Wrap fetch so it isn't called with `this` = Session (Workers throw "Illegal invocation").
    this.fetch = (url, init) => fetchImpl(url, init);
  }
  async go(method, url, opts = {}) {
    let body = opts.form ? new URLSearchParams(opts.form).toString() : opts.body ?? null;
    let referer = opts.referer || null;
    for (let hops = 0; hops < 20; hops++) {
      if (++this.count > this.limit) throw new DirectError('Needed more requests than one call allows.', { step: 'limit' });
      const headers = { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', accept: opts.accept || HTML_ACCEPT, ...(opts.headers || {}) };
      const cookie = this.jar.header(url);
      if (cookie) headers.cookie = cookie;
      if (referer) headers.referer = referer;
      if (body != null) {
        headers['content-type'] = opts.contentType || 'application/x-www-form-urlencoded';
        headers.origin = new URL(referer || url).origin;
      }
      const res = await this.fetch(url, { method, headers, body, redirect: 'manual' });
      this.jar.store(url, setCookiesOf(res));
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        const next = new URL(loc, url).href;
        try { await res.body?.cancel?.(); } catch (e) {}
        if (opts.stopAt && opts.stopAt(next)) return { url: next, status: res.status, stopped: true, text: '' };
        if (res.status !== 307 && res.status !== 308) { method = 'GET'; body = null; }
        referer = url; url = next;
        continue;
      }
      return { url, status: res.status, text: await res.text(), referer };
    }
    throw new DirectError('Too many redirects.', { step: 'redirects' });
  }
  // Submit a page's self-submitting form (sign-in hand-offs).
  async submitForm(page, pick) {
    const f = parseForms(page.text, page.url).find(pick || (x => true));
    if (!f) return null;
    return this.go(f.method, f.action, { form: f.fields, referer: page.url });
  }
}

const decodeEntities = s => String(s)
  .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/gi, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i')); return m ? decodeEntities(m[2]) : null; };

export function parseForms(html, baseUrl) {
  const forms = [];
  const re = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[1], inner = m[2];
    const fields = {};
    const inp = /<input\b([^>]*)>/gi;
    let i;
    while ((i = inp.exec(inner))) {
      const name = attr(i[1], 'name'), type = (attr(i[1], 'type') || 'text').toLowerCase();
      if (!name || type === 'submit' || type === 'button' || type === 'checkbox' || type === 'radio') continue;
      fields[name] = attr(i[1], 'value') ?? '';
    }
    const action = attr(tag, 'action');
    forms.push({
      id: attr(tag, 'id') || '', name: attr(tag, 'name') || '',
      method: (attr(tag, 'method') || 'GET').toUpperCase(),
      action: new URL(action || baseUrl, baseUrl).href, fields,
    });
  }
  return forms;
}

// Pull one JavaScript object literal (balanced braces) that follows `key:` in a script.
function objectAfter(s, key, from = 0) {
  const k = s.indexOf(key + ':', from);
  if (k < 0) return null;
  let i = k + key.length + 1;
  while (s[i] === ' ') i++;
  if (s[i] !== '{') return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '"' || c === "'") { const q = c; j++; while (j < s.length && s[j] !== q) { if (s[j] === '\\') j++; j++; } continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return s.slice(i, j + 1);
  }
  return null;
}
const scalarAfter = (s, key) => { const m = s.match(new RegExp(`[{,\\s]${key}:\\s*(?:"([^"]*)"|'([^']*)'|(true|false|null|undefined|-?\\d+))`)); return m ? (m[1] ?? m[2] ?? m[3]) : undefined; };

// Read a `skyward.browse.browseList['<id>'] = { ... }` setup block.
export function browseConfigs(html, idPrefix) {
  const out = [];
  const re = new RegExp(`skyward\\.browse\\.browseList\\[['"](${idPrefix}[^'"]*)['"]\\]\\s*=\\s*\\{`, 'g');
  let m;
  while ((m = re.exec(html))) {
    const end = html.indexOf('};', m.index);
    const block = html.slice(m.index, end > 0 ? end + 1 : m.index + 20000);
    const dataStr = objectAfter(block, 'data');
    const qpdStr = objectAfter(block, 'queryParameterData');
    const cfg = { id: m[1], data: dataStr ? JSON.parse(dataStr) : {}, queryParameterData: qpdStr ? JSON.parse(qpdStr) : undefined };
    for (const k of ['browseName', 'pageModule', 'pageObject', 'pageScreen', 'pageTab', 'routeModule', 'routeObject', 'dataModule', 'dataObject',
      'displayName', 'headerNumber', 'dynamicHeight', 'hideBrowseControl', 'hideSelectListTotals', 'renderSearchBox', 'getBrowseSearchMode',
      'hasCollapseExpandButton', 'disableRowHighlighting', 'preventColumnResize', 'preventColumnSort', 'renderLeftControls', 'renderViewButton',
      'renderFilterButton', 'renderLiveTileAddButton', 'renderChartTileAddButton', 'renderRowsPerPageOption', 'hideReportsFromRelatedScreen',
      'renderDesignReportButton', 'hideMoreMenuArea', 'renderSortableHeader', 'renderHeaderSettings', 'detailsPanelType', 'renderQuickFilter',
      'isRelatedBrowse', 'forceSingleThread', 'hidePreviewDetailsButton', 'browseType', 'hideIfEmpty', 'selectMode',
      'queryParameterDataHash', 'requestDataHash']) {
      const v = scalarAfter(block, k);
      if (v !== undefined) cfg[k] = v;
    }
    out.push(cfg);
  }
  return out;
}

const str = (v, d = '') => (v === undefined || v === null || v === 'null' || v === 'undefined' ? d : String(v));

// The form a browser sends to GetBrowse, built from a browseList setup block.
export function getBrowseForm(cfg, { repeated = false, defaultHeader = '3' } = {}) {
  const f = {
    pageModule: str(cfg.pageModule), pageObject: str(cfg.pageObject), pageScreen: str(cfg.pageScreen), pageTab: str(cfg.pageTab),
    routeModule: str(cfg.routeModule), routeObject: str(cfg.routeObject), dataModule: str(cfg.dataModule), dataObject: str(cfg.dataObject),
    browseName: str(cfg.browseName), hideIfEmpty: str(cfg.hideIfEmpty, 'false'), selectMode: str(cfg.selectMode, 'false'),
    browseId: cfg.id, isCodeEel: 'false',
  };
  if (cfg.queryParameterData !== undefined) f.queryParameterData = JSON.stringify(cfg.queryParameterData);
  Object.assign(f, {
    queryParameterDataHash: str(cfg.queryParameterDataHash), timestamp: String(Date.now()), displayName: str(cfg.displayName),
    dynamicHeight: str(cfg.dynamicHeight, 'false'), readNoLock: 'false', hideBrowseControl: str(cfg.hideBrowseControl, 'false'),
    hideSelectListTotals: str(cfg.hideSelectListTotals, 'false'), rowsPerPageCap: '', renderSearchBox: str(cfg.renderSearchBox, 'false'),
    performSearch: 'true', getBrowseSearchMode: str(cfg.getBrowseSearchMode, 'Always'), hasCollapseExpandButton: str(cfg.hasCollapseExpandButton, 'false'),
    requestDataHash: str(cfg.requestDataHash), disableRowHighlighting: str(cfg.disableRowHighlighting, 'false'),
    preventColumnResize: str(cfg.preventColumnResize, 'false'), preventColumnSort: str(cfg.preventColumnSort, 'false'),
    renderLeftControls: str(cfg.renderLeftControls, 'true'), renderViewButton: str(cfg.renderViewButton, 'false'),
    renderFilterButton: str(cfg.renderFilterButton, 'false'), renderLiveTileAddButton: str(cfg.renderLiveTileAddButton, 'true'),
    renderChartTileAddButton: str(cfg.renderChartTileAddButton, 'true'), renderRowsPerPageOption: str(cfg.renderRowsPerPageOption, 'false'),
    hideReportsFromRelatedScreen: str(cfg.hideReportsFromRelatedScreen, 'false'), renderDesignReportButton: str(cfg.renderDesignReportButton, 'true'),
    hideMoreMenuArea: str(cfg.hideMoreMenuArea, 'false'), renderSortableHeader: str(cfg.renderSortableHeader, 'false'),
    renderHeaderSettings: str(cfg.renderHeaderSettings, 'false'), detailsPanelType: str(cfg.detailsPanelType, 'Row'),
    identifyingFieldsAndValues: '', identityFieldValuesOfTopRecord: '', seekText: '', renderQuickFilter: str(cfg.renderQuickFilter, 'false'),
    headerNumber: str(cfg.headerNumber, defaultHeader), forceSingleThread: str(cfg.forceSingleThread, 'false'),
    isRelatedBrowse: str(cfg.isRelatedBrowse, 'false'), dynamicFilterValues: '{}', dynamicFilterHashes: '{}',
    postData: JSON.stringify(cfg.data || {}), returnSearchCondition: 'false', hidePreviewDetailsButton: 'true',
    browseType: str(cfg.browseType, 'Default'),
  });
  if (repeated) f.isRepeatedBrowse = 'true';
  return f;
}

// ---------------------------------------------------------------- Skyward XHR helper (tries token sources)
async function skywardXhr(s, sky, url, form, { accept = 'application/json, text/javascript, */*; q=0.01', referer } = {}) {
  const candidates = sky.csrf ? [sky.csrf] : [sky.sessionGuidHash, sky.windowGuid, null].filter((v, i, a) => v !== undefined && a.indexOf(v) === i);
  let last;
  for (const token of candidates) {
    const headers = { 'x-requested-with': 'XMLHttpRequest' };
    if (token) headers['x-csrf-token'] = token;
    const r = await s.go('POST', url, { form, accept, headers, referer: referer || sky.gradesUrl, contentType: 'application/x-www-form-urlencoded; charset=UTF-8' });
    last = r;
    const ok = r.status === 200 && (accept.includes('json') ? /^\s*\{/.test(r.text) : !/<title>\s*(error|login|sign in)/i.test(r.text));
    if (ok) { sky.csrf = token; return r; }
  }
  throw new DirectError(`Skyward refused the request (status ${last?.status}).`, { step: 'skyward-request' });
}

// ---------------------------------------------------------------- 1 + 2: sign in, open Skyward
export async function signInAndOpenGrades({ url, username, password, log = () => {}, fetchImpl }) {
  const s = new Session({ log, fetchImpl });
  const lp = new URL(url);
  const pathCode = lp.pathname.split('/').filter(Boolean)[0] || '';

  // ClassLink login page (sets ClassLink cookies)
  const lpPage = await s.go('GET', lp.href);
  const codeMatch = lpPage.text.match(/authenticate\?code=([\w-]+)/) || lpPage.text.match(/["'](?:tenantCode|loginCode|customCode)["']\s*:\s*["']([\w-]+)["']/);
  const code = (codeMatch && codeMatch[1]) || TENANT_CODES[pathCode.toLowerCase()] || pathCode;
  log('Opened ClassLink');

  // Network Login → district sign-in page
  const adfs = await s.go('GET', `https://tenant-management-service.classlink.io/login/v3.0/authenticate?code=${encodeURIComponent(code)}&loginWith=saml`, { referer: 'https://launchpad.classlink.com/' });
  const loginForm = parseForms(adfs.text, adfs.url).find(f => 'Password' in f.fields || 'password' in f.fields);
  if (!loginForm) throw new DirectError("Couldn't find the district sign-in form after choosing Network Login.", { step: 'network-login' });
  log('Chose Network Login');

  // Submit username + password. The district's sign-in page adds its domain (DOMAIN\user).
  const domain = ADFS_DOMAINS[new URL(adfs.url).hostname.toLowerCase()] || '';
  const user = /[\\@]/.test(username) || !domain ? username : `${domain}\\${username}`;
  const fields = { ...loginForm.fields };
  fields[('UserName' in fields) ? 'UserName' : 'username'] = user;
  fields[('Password' in fields) ? 'Password' : 'password'] = password;
  if ('AuthMethod' in fields && !fields.AuthMethod) fields.AuthMethod = 'FormsAuthentication';
  const after = await s.go('POST', loginForm.action, { form: fields, referer: adfs.url });
  const handoff = parseForms(after.text, after.url).find(f => 'SAMLResponse' in f.fields);
  if (!handoff) {
    if (/Password/.test(after.text) && /loginForm/.test(after.text)) {
      throw new DirectError('The district sign-in didn\'t accept that username and password.', { auth: true, step: 'password' });
    }
    throw new DirectError("Signed in, but the district sign-in didn't hand back to ClassLink.", { step: 'adfs-handoff' });
  }
  log('Submitted login');

  // Hand-off back to ClassLink; stop once ClassLink sends us to its app page
  await s.go(handoff.method, handoff.action, { form: handoff.fields, referer: after.url, stopAt: u => /myapps\.classlink\.com/.test(u) });

  // Open Skyward through ClassLink
  const launch = SKYWARD_LAUNCH[code.toLowerCase()];
  if (!launch) throw new DirectError('Fast sign-in doesn\'t know this district\'s Skyward link yet.', { step: 'launch' });
  let page = await s.go('GET', launch, { referer: 'https://myapps.classlink.com/' });
  for (let i = 0; i < 4; i++) {   // ClassLink → Skyward hand-off, then Skyward's own same-site re-post
    const f = parseForms(page.text, page.url).find(x => 'SAMLResponse' in x.fields);
    if (!f) break;
    page = await s.go(f.method, f.action, { form: f.fields, referer: page.url });
  }
  const hash = page.text.match(/sessionGuidHash\s*=\s*['"]([^'"]+)['"]/);
  const win = page.text.match(/windowGuid\s*=\s*['"]([^'"]+)['"]/);
  if (!hash || !/skyward/i.test(page.url)) {
    if (/login|sign\s*in/i.test(page.text.slice(0, 3000))) throw new DirectError('ClassLink didn\'t accept the sign-in.', { auth: true, step: 'classlink' });
    throw new DirectError("Opened Skyward, but couldn't read its home page.", { step: 'skyward-home' });
  }
  const homeUrl = new URL(page.url);
  const base = homeUrl.origin + homeUrl.pathname.replace(/\/Home\/.*$/i, '');
  const sky = { base, w: homeUrl.searchParams.get('w'), p: homeUrl.searchParams.get('p'), sessionGuidHash: hash[1], windowGuid: win && win[1], csrf: null };
  log('Opened Skyward');

  // Student Grades page
  const grades = await s.go('POST', `${base}/Grading/StudentSection/StudentAccess?w=${sky.w}&p=${sky.p}`, { form: { sgh: sky.sessionGuidHash }, referer: page.url });
  const gu = new URL(grades.url);
  sky.p = gu.searchParams.get('p') || sky.p; sky.w = gu.searchParams.get('w') || sky.w; sky.gradesUrl = grades.url;
  const configs = browseConfigs(grades.text, 'StudentGrades-');
  if (!configs.length) throw new DirectError("Opened Student Grades, but couldn't find its grades table.", { step: 'grades-page' });
  log('Opened the grades page');

  // The grades table(s)
  const grids = [];
  for (let i = 0; i < configs.length; i++) {
    const r = await skywardXhr(s, sky, `${base}/Grading/StudentSection/GetBrowse?w=${sky.w}&p=${sky.p}`, getBrowseForm(configs[i], { repeated: i > 0 }));
    const j = JSON.parse(r.text);
    if (j.html) grids.push(j.html);
  }
  log(`Read the grades table (${grids.length} list${grids.length === 1 ? '' : 's'})`);
  return { grids, session: { jar: s.jar.only('skyward').list, sky }, requests: s.count };
}

// ---------------------------------------------------------------- 4: assignments for some classes
// cells: [{ key, postdata: {...fields from the grade cell...} }]
export async function fetchDetails({ session, cells, log = () => {}, fetchImpl }) {
  const s = new Session({ jar: new Jar(session.jar), log, fetchImpl });
  const sky = session.sky;
  const out = [];
  for (const cell of cells) {
    if (s.count + 3 > s.limit) break;
    try {
      const pk = cell.postdata.primaryKey || cell.postdata['student-grade-bucket-id'];
      const ts = Date.now();
      const detUrl = `${sky.base}/Gradebook/ProgressReport/GradeBucketBreakdownStudentAccess/${encodeURIComponent(pk)}?renderType=contentOnly&blah=${ts}&renderInDetailsPane`;
      const form = {};
      for (const [k, v] of Object.entries(cell.postdata)) form[k] = typeof v === 'string' ? v : JSON.stringify(v);
      const det = await skywardXhr(s, sky, detUrl, form, { accept: 'text/plain' });
      const cfg = browseConfigs(det.text, 'detailsPanel_SegmentedGradeBucketAssignments')[0];
      if (!cfg) { out.push({ key: cell.key, error: 'no assignment list' }); continue; }
      const r = await skywardXhr(s, sky, `${sky.base}/Gradebook/Assignment/GetBrowse?w=${sky.w}&p=${sky.p}`, getBrowseForm(cfg, { defaultHeader: '2' }));
      const j = JSON.parse(r.text);
      out.push({ key: cell.key, html: j.html || '' });
    } catch (e) {
      out.push({ key: cell.key, error: String(e.message || e).slice(0, 200) });
      if (e instanceof DirectError && e.step === 'limit') break;
    }
  }
  log(`Read assignments for ${out.filter(o => o.html).length} of ${cells.length} classes`);
  return { details: out, session: { jar: s.jar.list, sky } };
}
