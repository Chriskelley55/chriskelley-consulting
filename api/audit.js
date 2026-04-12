const Anthropic = require('@anthropic-ai/sdk');
const { Resend } = require('resend');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url, email, subscribe } = req.body;
  if (!url || !email) return res.status(400).json({ error: 'URL and email are required.' });

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    // Fetch website content
    let siteContent = 'Website could not be fetched.';
    let siteStatus = 'unreachable';
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const siteRes = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PresenceAuditBot/1.0)' },
        signal: controller.signal
      });
      clearTimeout(timer);
      siteStatus = siteRes.ok ? 'ok' : `error-${siteRes.status}`;
      const html = await siteRes.text();
      siteContent = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 6000);
    } catch (e) {
      siteStatus = 'unreachable';
    }

    const auditPrompt = `You are an online presence auditor for small businesses and contractors.

Audit this business's web presence. URL: ${url} (status: ${siteStatus})

Website text content:
${siteContent}

Score each category and return ONLY a valid JSON object — no explanation, no markdown, no preamble.

Scoring guide:
- website (max 25): site loads +5, mobile-ready signals (viewport meta, responsive layout) +5, clear CTA or contact form +5, HTTPS +5, appears fast/clean (no obvious heavy bloat) +5
- gbp (max 25): phone number on site +5, address/location on site +5, local keywords in content +5, Google Maps embed or GBP link +5, schema markup for local business +5
- reviews (max 20): testimonials section on site +5, star rating displayed +5, review schema markup +5, third-party review widget (Google, Yelp, etc.) +5 (max 20)
- visibility (max 15): meta description present +5, title tag has local keywords +5, structured data present +5
- social (max 15): social media links present +5, multiple platforms linked +5, modern site design suggests active presence +5

Be honest. If content couldn't be fetched, score website near 0 and note it.

JSON format:
{
  "business_name": "",
  "location": "",
  "industry": "",
  "total_score": 0,
  "tier": "Invisible",
  "tier_description": "",
  "categories": {
    "website": { "score": 0, "max": 25, "grade": "F", "findings": ["finding 1", "finding 2", "finding 3"] },
    "gbp": { "score": 0, "max": 25, "grade": "F", "findings": ["finding 1", "finding 2"] },
    "reviews": { "score": 0, "max": 20, "grade": "F", "findings": ["finding 1", "finding 2"] },
    "visibility": { "score": 0, "max": 15, "grade": "F", "findings": ["finding 1", "finding 2"] },
    "social": { "score": 0, "max": 15, "grade": "F", "findings": ["finding 1", "finding 2"] }
  },
  "top_wins": ["Most impactful quick fix", "Second fix", "Third fix"]
}

Tier thresholds: 0-40 = Invisible, 41-65 = Findable but Leaking, 66-85 = Solid Foundation, 86-100 = Well-Positioned`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      messages: [{ role: 'user', content: auditPrompt }]
    });

    const responseText = message.content[0].text.trim();
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Could not parse audit response.');
    const audit = JSON.parse(jsonMatch[0]);

    // Send results email
    try {
      if (!process.env.RESEND_API_KEY) throw new Error('No Resend key');
      const resend = new Resend(process.env.RESEND_API_KEY);
      const emailResult = await resend.emails.send({
        from: 'Chris Kelley <onboarding@resend.dev>',
        to: email,
        subject: `Your Free Presence Audit — ${audit.business_name || new URL(url).hostname}`,
        html: buildEmailHtml(audit, url)
      });
      console.log('Email sent:', JSON.stringify(emailResult));
    } catch (emailErr) {
      console.error('Email error:', emailErr.message, JSON.stringify(emailErr));
    }

    // Add to Beehiiv newsletter if opted in
    if ((subscribe === true || subscribe === 'true') &&
        process.env.BEEHIIV_API_KEY && process.env.BEEHIIV_PUBLICATION_ID) {
      try {
        await fetch(`https://api.beehiiv.com/v2/publications/${process.env.BEEHIIV_PUBLICATION_ID}/subscriptions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.BEEHIIV_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ email, reactivate_existing: false, send_welcome_email: true })
        });
      } catch (bErr) {
        console.error('Beehiiv error:', bErr);
      }
    }

    return res.status(200).json({ success: true, audit });

  } catch (err) {
    console.error('Audit error:', err);
    return res.status(500).json({ error: 'Audit failed. Please try again.' });
  }
};

function buildEmailHtml(audit, url) {
  const tierColors = {
    'Invisible': '#dc2626',
    'Findable but Leaking': '#ea580c',
    'Solid Foundation': '#2563eb',
    'Well-Positioned': '#16a34a'
  };
  const color = tierColors[audit.tier] || '#0E6BA8';
  const labels = {
    website: '🌐 Website',
    gbp: '📍 Google Business Profile',
    reviews: '⭐ Reviews & Reputation',
    visibility: '🔍 Online Visibility',
    social: '📱 Social Presence'
  };

  const categoryRows = Object.entries(audit.categories).map(([key, cat]) => `
    <div style="background:#fff;border:1.5px solid #e4e8ef;border-radius:12px;padding:18px;margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <strong style="font-size:14px;color:#1a1a2e;">${labels[key] || key}</strong>
        <span style="font-weight:700;color:${color};font-size:15px;">${cat.score}/${cat.max}</span>
      </div>
      ${cat.findings.map(f => `<p style="margin:4px 0;font-size:13px;color:#5a6070;">• ${f}</p>`).join('')}
    </div>`).join('');

  const wins = audit.top_wins.map(w => `<p style="margin:6px 0;font-size:14px;color:#1a1a2e;">✓ ${w}</p>`).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f7f8fa;font-family:Arial,sans-serif;color:#1a1a2e;">
<div style="max-width:580px;margin:0 auto;padding:20px;">
  <div style="background:#0d2c47;border-radius:14px;padding:28px;text-align:center;margin-bottom:16px;">
    <p style="color:#28B485;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;margin:0 0 8px;">CK Consulting · Houston, TX</p>
    <h1 style="color:#fff;font-size:20px;margin:0 0 6px;">Your Free Presence Audit</h1>
    <p style="color:rgba(255,255,255,0.45);font-size:12px;margin:0;">${url}</p>
  </div>

  <div style="background:#fff;border-radius:14px;padding:24px;text-align:center;margin-bottom:16px;border:1.5px solid #e4e8ef;">
    <div style="font-size:64px;font-weight:800;color:${color};line-height:1;">${audit.total_score}</div>
    <div style="color:#5a6070;font-size:13px;margin:4px 0 10px;">out of 100</div>
    <div style="display:inline-block;background:${color};color:#fff;padding:5px 16px;border-radius:99px;font-weight:700;font-size:13px;">${audit.tier}</div>
    <p style="color:#5a6070;font-size:13px;margin:10px 0 0;line-height:1.6;">${audit.tier_description}</p>
  </div>

  ${categoryRows}

  <div style="background:#f0fdf7;border:1.5px solid #28B485;border-radius:12px;padding:18px;margin:14px 0;">
    <strong style="font-size:14px;display:block;margin-bottom:10px;">⚡ Your Top 3 Quick Wins</strong>
    ${wins}
  </div>

  <div style="text-align:center;padding:20px 0 8px;">
    <a href="https://calendar.app.google/JxvnN4JBC61zMBkM6" style="background:#28B485;color:#fff;padding:13px 26px;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block;">Book a Free Discovery Call →</a>
    <p style="color:#5a6070;font-size:11px;margin-top:14px;">Chris Kelley · AI Automation Consultant · <a href="https://chriskelley.io" style="color:#0E6BA8;">chriskelley.io</a></p>
  </div>
</div>
</body></html>`;
}
