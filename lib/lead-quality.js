/* Lead quality + email-domain reputation checks for the Presence Audit.
   Used by api/audit.js (to gate instant alerts) and api/audit-digest.js
   (to rank the weekly digest). */

const dns = require('node:dns').promises;

/* DNS can hang on dead/garbage domains. Every lookup is time-boxed so this can
   never stall the audit request (or the weekly cron). */
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
}

const FREE_PROVIDERS = new Set([
  'gmail.com','googlemail.com','yahoo.com','ymail.com','hotmail.com','outlook.com',
  'live.com','msn.com','aol.com','icloud.com','me.com','mac.com','proton.me',
  'protonmail.com','gmx.com','gmx.net','mail.com','zoho.com','yandex.com',
  'comcast.net','sbcglobal.net','att.net','verizon.net','bellsouth.net','cox.net',
  'charter.net','earthlink.net','roadrunner.com','rocketmail.com'
]);

const DISPOSABLE = new Set([
  'mailinator.com','guerrillamail.com','10minutemail.com','tempmail.com','temp-mail.org',
  'throwaway.email','yopmail.com','trashmail.com','sharklasers.com','getnada.com',
  'dispostable.com','maildrop.cc','fakeinbox.com','mintemail.com','spamgourmet.com',
  'tempr.email','moakt.com','emailondeck.com','mohmal.com','tempmailo.com'
]);

const ROLE_PREFIXES = new Set([
  'info','admin','support','sales','contact','hello','office','team','help',
  'noreply','no-reply','webmaster','postmaster','billing','service'
]);

function emailDomain(email) {
  const m = String(email || '').trim().toLowerCase().match(/@([^@\s]+)$/);
  return m ? m[1] : '';
}

function rootDomain(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
  const parts = h.split('.').filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join('.') : h;
}

function hostFromUrl(url) {
  try { return new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url).hostname; }
  catch { return ''; }
}

/* Looks-random heuristic: "kesmqiokg.com" style gibberish.
   Flags long consonant runs / no vowels / very low vowel ratio. */
function looksRandom(label) {
  const s = String(label || '').toLowerCase().replace(/[^a-z]/g, '');
  if (s.length < 6) return false;
  const vowels = (s.match(/[aeiouy]/g) || []).length;
  const ratio = vowels / s.length;
  const longConsonantRun = /[bcdfghjklmnpqrstvwxz]{5,}/.test(s);
  return ratio < 0.25 || longConsonantRun;
}

async function hasMx(domain, timeoutMs = 3000) {
  if (!domain) return false;
  const mx = await withTimeout(
    dns.resolveMx(domain).catch(() => null), timeoutMs, null);
  if (Array.isArray(mx) && mx.length > 0) return true;
  // Some domains accept mail on the A record; treat a resolvable A as weak-yes
  const a = await withTimeout(
    dns.resolve4(domain).catch(() => null), timeoutMs, null);
  return Array.isArray(a) && a.length > 0;
}

async function siteResponds(domain, timeoutMs = 4000) {
  if (!domain) return false;
  for (const scheme of ['https://', 'http://']) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), timeoutMs);
      const r = await fetch(scheme + domain, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PresenceAuditBot/1.0)' },
        signal: c.signal
      });
      clearTimeout(t);
      if (r.status < 500) return true;
    } catch { /* try next scheme */ }
  }
  return false;
}

/* Inspect the EMAIL's domain — the point is to catch real people who typed a
   junk URL (e.g. mauricio@primerem.com auditing kesmqiokg.com). */
async function inspectEmail(email, opts = {}) {
  const domain = emailDomain(email);
  const local = String(email || '').split('@')[0].toLowerCase();
  const out = {
    email, domain,
    isFree: FREE_PROVIDERS.has(domain),
    isDisposable: DISPOSABLE.has(domain),
    isRole: ROLE_PREFIXES.has(local),
    looksRandom: looksRandom(domain.split('.')[0]),
    hasMx: false,
    domainHasSite: null,   // only probed in the digest (slower)
    notes: []
  };
  if (!domain) { out.notes.push('malformed email'); return out; }
  out.hasMx = await hasMx(domain);
  if (opts.probeSite) out.domainHasSite = await siteResponds(domain);

  if (out.isDisposable) out.notes.push('disposable provider');
  if (!out.hasMx) out.notes.push('no mail records — likely undeliverable');
  if (out.looksRandom) out.notes.push('random-looking domain');
  if (out.isFree) out.notes.push('personal email (not a company domain)');
  if (out.isRole) out.notes.push('role address');
  if (out.domainHasSite === true && !out.isFree) out.notes.push('email domain has a live site');
  return out;
}

/* Three tiers:
   hot   — reachable site + deliverable email  => real business, real contact
   maybe — email looks real but the audited URL is dead (worth a human glance)
   junk  — nothing to work with                 => digest only, never an instant alert */
function classify({ siteStatus, audit, emailInfo }) {
  const reasons = [];
  const score = Number(audit?.total_score ?? 0);
  const name = String(audit?.business_name || '').trim().toLowerCase();
  const unknownBiz = !name || name === 'unknown';
  const siteOk = siteStatus === 'ok';
  const auditedHost = '';

  if (emailInfo.isDisposable) { reasons.push('disposable email'); return { tier: 'junk', reasons }; }
  if (!emailInfo.hasMx)       { reasons.push('email domain has no mail records'); return { tier: 'junk', reasons }; }

  if (!siteOk) reasons.push(`site ${siteStatus || 'unreachable'}`);
  if (score === 0) reasons.push('scored 0/100');
  if (unknownBiz) reasons.push('business not identified');

  if (siteOk) {
    reasons.unshift('site loads');
    if (!emailInfo.isFree) reasons.push('business-domain email');
    return { tier: 'hot', reasons };
  }

  // Dead URL, but the email domain itself looks legitimate -> worth a look
  if (!emailInfo.isFree && !emailInfo.looksRandom) {
    reasons.push('but email domain looks legitimate');
    return { tier: 'maybe', reasons };
  }
  if (emailInfo.isFree && !unknownBiz) {
    reasons.push('personal email but business was identified');
    return { tier: 'maybe', reasons };
  }
  return { tier: 'junk', reasons };
}

module.exports = {
  inspectEmail, classify, emailDomain, rootDomain, hostFromUrl,
  siteResponds, hasMx, looksRandom, FREE_PROVIDERS, DISPOSABLE
};
