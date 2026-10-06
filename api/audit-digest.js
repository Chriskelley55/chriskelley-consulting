/* Weekly Presence Audit digest.
   Compiles every queued audit lead into ONE email to chris@chriskelley.io,
   ranked by whether the person is actually reachable.

   Triggered by Vercel Cron (see vercel.json). Manual/testing:
     GET /api/audit-digest?token=<ADMIN_TOKEN>
     GET /api/audit-digest?token=<ADMIN_TOKEN>&dry=1   -> preview, sends nothing, clears nothing
*/
const { Resend } = require('resend');
const { kv } = require('@vercel/kv');
const { inspectEmail } = require('../lib/lead-quality');

const PENDING = 'audit:leads:pending';
const ARCHIVE = 'audit:leads:archive';
const TO = 'chris@chriskelley.io';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function authorized(req) {
  const hdr = req.headers['authorization'] || '';
  if (process.env.CRON_SECRET && hdr === `Bearer ${process.env.CRON_SECRET}`) return true;
  const token = (req.query && req.query.token) || '';
  if (process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN) return true;
  // Vercel cron requests are identified by this header when no secret is configured
  if (!process.env.CRON_SECRET && req.headers['x-vercel-cron']) return true;
  return false;
}

function chip(ok, label) {
  const bg = ok ? '#e8f7f0' : '#fdecec';
  const fg = ok ? '#1a7f5a' : '#b3261e';
  return `<span style="display:inline-block;background:${bg};color:${fg};border-radius:999px;padding:2px 9px;font-size:11px;font-weight:700;margin:0 4px 4px 0;">${esc(label)}</span>`;
}

function leadCard(l, accent) {
  const e = l.enriched || {};
  const chips = [
    chip(e.hasMx, e.hasMx ? 'deliverable' : 'no mail records'),
    chip(e.domainHasSite === true, e.domainHasSite === true ? 'email domain has a site' : 'no site on email domain'),
    chip(!e.isFree, e.isFree ? 'personal email' : 'business domain'),
  ];
  if (e.isDisposable) chips.push(chip(false, 'disposable'));
  if (e.isRole) chips.push(chip(false, 'role address'));
  return `
  <div style="border:1px solid #e6e8ec;border-left:4px solid ${accent};border-radius:10px;padding:14px 16px;margin-bottom:12px;">
    <div style="display:block;font-size:15px;font-weight:700;color:#1a1a2e;">${esc(l.business_name || 'Unknown business')}
      <span style="font-weight:600;color:#0E6BA8;font-size:13px;"> — ${esc(l.score)}/100</span></div>
    <div style="font-size:12px;color:#8a909c;margin:2px 0 8px;">${esc(l.url)} · ${esc(l.industry || '—')} · ${esc(l.location || '—')} · ${esc((l.ts || '').slice(0,10))}</div>
    <div style="font-size:13px;margin-bottom:8px;">
      <a href="mailto:${esc(l.email)}" style="color:#0E6BA8;font-weight:600;">${esc(l.email)}</a>
    </div>
    <div style="margin-bottom:8px;">${chips.join('')}</div>
    <div style="font-size:12px;color:#5a6070;margin-bottom:10px;">${esc((l.lead_reasons || []).join(' · '))}</div>
    <a href="mailto:${esc(l.email)}?subject=Your%20Presence%20Audit%20Results&body=Hey%2C%20I%20reviewed%20your%20audit%20results%20and%20wanted%20to%20follow%20up..."
       style="background:${accent};color:#fff;padding:8px 16px;border-radius:7px;text-decoration:none;font-weight:700;font-size:12px;display:inline-block;">Reply →</a>
  </div>`;
}

module.exports = async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const dry = !!(req.query && (req.query.dry === '1' || req.query.dry === 'true'));

  let pending = [];
  try { pending = (await kv.get(PENDING)) || []; }
  catch (e) { return res.status(500).json({ error: 'KV read failed: ' + e.message }); }

  if (!pending.length) {
    return res.status(200).json({ ok: true, sent: false, reason: 'no leads queued this period' });
  }

  // Re-inspect each email domain now (includes a live-site probe) so the digest
  // can flag addresses that look real even when the audited URL was garbage.
  for (const l of pending) {
    try { l.enriched = await inspectEmail(l.email, { probeSite: true }); }
    catch { l.enriched = {}; }
    // Promote: dead URL but the email domain is clearly a real business
    if (l.lead_tier === 'junk' && l.enriched.hasMx && l.enriched.domainHasSite &&
        !l.enriched.isFree && !l.enriched.isDisposable) {
      l.lead_tier = 'maybe';
      l.lead_reasons = [...(l.lead_reasons || []), 'email domain has a live site'];
    }
  }

  const hot   = pending.filter(l => l.lead_tier === 'hot');
  const maybe = pending.filter(l => l.lead_tier === 'maybe');
  const junk  = pending.filter(l => l.lead_tier === 'junk');

  const junkRows = junk.map(l => `
    <tr>
      <td style="padding:6px 8px;font-size:12px;color:#5a6070;border-bottom:1px solid #f0f1f4;">${esc(l.url)}</td>
      <td style="padding:6px 8px;font-size:12px;border-bottom:1px solid #f0f1f4;">${esc(l.email)}</td>
      <td style="padding:6px 8px;font-size:11px;color:#8a909c;border-bottom:1px solid #f0f1f4;">${esc((l.lead_reasons || []).join(', '))}</td>
    </tr>`).join('');

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;padding:20px;color:#1a1a2e;">
    <div style="background:#0d2c47;border-radius:12px;padding:22px;margin-bottom:18px;text-align:center;">
      <p style="color:#28B485;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;margin:0 0 6px;">Weekly Audit Digest</p>
      <h2 style="color:#fff;margin:0;font-size:22px;">${pending.length} audit${pending.length === 1 ? '' : 's'} this week</h2>
      <p style="color:rgba(255,255,255,0.6);font-size:12px;margin:6px 0 0;">
        ${hot.length} worth replying · ${maybe.length} maybe real · ${junk.length} junk
      </p>
    </div>

    ${hot.length ? `<h3 style="font-size:14px;margin:0 0 10px;">🔥 Worth replying (${hot.length})</h3>
      ${hot.map(l => leadCard(l, '#28B485')).join('')}` : ''}

    ${maybe.length ? `<h3 style="font-size:14px;margin:18px 0 6px;">👀 Possibly real — bad URL, but the email checks out (${maybe.length})</h3>
      <p style="font-size:12px;color:#8a909c;margin:0 0 10px;">Their website was down or fake, but their email domain resolves and in some cases hosts a live site.</p>
      ${maybe.map(l => leadCard(l, '#E8A33D')).join('')}` : ''}

    ${junk.length ? `<h3 style="font-size:14px;margin:18px 0 6px;">🗑️ Junk — no action needed (${junk.length})</h3>
      <p style="font-size:12px;color:#8a909c;margin:0 0 8px;">Dead URL and an undeliverable or disposable email. Listed only so nothing is silently dropped.</p>
      <table style="width:100%;border-collapse:collapse;">${junkRows}</table>` : ''}

    <p style="font-size:11px;color:#9ca3af;margin-top:24px;border-top:1px solid #eee;padding-top:12px;">
      Instant alerts now fire only for 🔥 leads. Everything else waits for this digest.<br>
      Chris Kelley Consulting · automated weekly summary
    </p>
  </div>`;

  if (dry) {
    return res.status(200).json({
      ok: true, dry: true, sent: false,
      counts: { total: pending.length, hot: hot.length, maybe: maybe.length, junk: junk.length },
      leads: pending.map(l => ({ email: l.email, url: l.url, tier: l.lead_tier, reasons: l.lead_reasons,
        hasMx: l.enriched?.hasMx, domainHasSite: l.enriched?.domainHasSite, isFree: l.enriched?.isFree }))
    });
  }

  try {
    if (!process.env.RESEND_API_KEY) throw new Error('No Resend key');
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: 'Audit Digest <chris@chriskelley.io>',
      to: TO,
      subject: `📋 Weekly audit digest — ${pending.length} lead${pending.length === 1 ? '' : 's'} (${hot.length} worth replying)`,
      html
    });
  } catch (e) {
    return res.status(500).json({ error: 'Send failed: ' + e.message });
  }

  // Archive and clear the queue (keep the last 500 for reference)
  try {
    const archive = (await kv.get(ARCHIVE)) || [];
    const merged = [...archive, ...pending.map(({ enriched, ...rest }) => rest)].slice(-500);
    await kv.set(ARCHIVE, merged);
    await kv.set(PENDING, []);
  } catch (e) {
    console.error('Archive error:', e.message);
  }

  return res.status(200).json({
    ok: true, sent: true,
    counts: { total: pending.length, hot: hot.length, maybe: maybe.length, junk: junk.length }
  });
};
