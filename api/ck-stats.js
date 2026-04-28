// /api/ck-stats.js
// Pulls Google Search Console data for chriskelley.io and returns
// admin-panel-friendly JSON. Caches in-memory for 6h per Vercel instance.
// Admin-only — requires X-Admin-Token header.
//
// Required env vars (set in Vercel project settings):
//   GSC_OAUTH_CLIENT_ID      — same OAuth 2.0 client used for Imperial Water
//   GSC_OAUTH_CLIENT_SECRET  — same OAuth 2.0 client secret
//   GSC_CK_REFRESH_TOKEN     — refresh token for chris@chriskelley.io
//   GSC_CK_SITE_URL          — e.g. "sc-domain:chriskelley.io" (default)
//
// If env vars are missing, returns demo data with `is_demo: true`.

const { OAuth2Client } = require('google-auth-library');

const cache = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours (more fresh than client stats)

function isAdmin(req) {
  const token = req.headers['x-admin-token'];
  return !!token && token === process.env.ADMIN_TOKEN;
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}
function startOfWeek(d) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() - x.getUTCDay());
  return x;
}

async function gscQuery(token, siteUrl, body) {
  const r = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`GSC ${r.status}: ${text.slice(0, 200)}`);
  }
  return r.json();
}

function demoPayload(siteUrl) {
  const today = new Date();
  const weekly = [];
  for (let w = 7; w >= 0; w--) {
    const wkStart = startOfWeek(new Date(today.getTime() - w * 7 * 86400e3));
    weekly.push({
      week: w === 0 ? 'This wk' : `${w}w ago`,
      label: wkStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      clicks: 0,
      impressions: 0,
    });
  }
  return {
    site: 'ck',
    domain: 'chriskelley.io',
    last_refreshed: new Date().toISOString(),
    from_cache: false,
    is_demo: true,
    demo_reason: 'GSC_CK_REFRESH_TOKEN not configured — run OAuth Playground for chris@chriskelley.io',
    summary: { clicks: 0, impressions: 0, ctr: 0, position: null },
    weekly,
    top_queries: [],
    top_pages: [],
  };
}

async function fetchLive(siteUrl) {
  const clientId = process.env.GSC_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GSC_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GSC_CK_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing env vars: GSC_OAUTH_CLIENT_ID / GSC_OAUTH_CLIENT_SECRET / GSC_CK_REFRESH_TOKEN');
  }

  const auth = new OAuth2Client(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  const tokenObj = await auth.getAccessToken();
  const token = tokenObj?.token || tokenObj;
  if (!token) throw new Error('GSC auth: no access token returned');

  const today = new Date();
  const end = new Date(today.getTime() - 2 * 86400e3);
  const start56 = new Date(end.getTime() - 56 * 86400e3);
  const start28 = new Date(end.getTime() - 28 * 86400e3);

  const [byDate, byQuery, byPage] = await Promise.all([
    gscQuery(token, siteUrl, { startDate: ymd(start56), endDate: ymd(end), dimensions: ['date'], rowLimit: 100 }),
    gscQuery(token, siteUrl, { startDate: ymd(start28), endDate: ymd(end), dimensions: ['query'], rowLimit: 10 }),
    gscQuery(token, siteUrl, { startDate: ymd(start28), endDate: ymd(end), dimensions: ['page'], rowLimit: 10 }),
  ]);

  // Weekly buckets (8 weeks)
  const weeklyMap = new Map();
  for (let w = 7; w >= 0; w--) {
    const wkStart = startOfWeek(new Date(end.getTime() - w * 7 * 86400e3));
    weeklyMap.set(ymd(wkStart), {
      week: w === 0 ? 'This wk' : `${w}w ago`,
      label: wkStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      clicks: 0,
      impressions: 0,
    });
  }
  for (const row of (byDate.rows || [])) {
    const wkKey = ymd(startOfWeek(new Date(row.keys[0] + 'T00:00:00Z')));
    if (weeklyMap.has(wkKey)) {
      const w = weeklyMap.get(wkKey);
      w.clicks += row.clicks || 0;
      w.impressions += row.impressions || 0;
    }
  }
  const weekly = Array.from(weeklyMap.values());

  // 28-day totals
  let totalClicks = 0, totalImpressions = 0, totalPositionWeighted = 0;
  for (const row of (byDate.rows || [])) {
    const date = new Date(row.keys[0] + 'T00:00:00Z');
    if (date >= start28) {
      totalClicks += row.clicks || 0;
      totalImpressions += row.impressions || 0;
      totalPositionWeighted += (row.position || 0) * (row.impressions || 0);
    }
  }
  const avgPosition = totalImpressions > 0 ? totalPositionWeighted / totalImpressions : null;
  const ctr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;

  const top_queries = (byQuery.rows || []).map(r => ({
    query: r.keys[0],
    clicks: r.clicks || 0,
    impressions: r.impressions || 0,
    position: r.position ? Math.round(r.position * 10) / 10 : null,
    ctr: r.ctr || 0,
  }));

  const maxPageClicks = Math.max(1, ...(byPage.rows || []).map(r => r.clicks || 0));
  const top_pages = (byPage.rows || []).slice(0, 8).map(r => {
    let path = r.keys[0];
    try { path = new URL(r.keys[0]).pathname; } catch {}
    return {
      path,
      clicks: r.clicks || 0,
      impressions: r.impressions || 0,
      pct: Math.round(((r.clicks || 0) / maxPageClicks) * 100),
    };
  });

  return {
    site: 'ck',
    domain: 'chriskelley.io',
    last_refreshed: new Date().toISOString(),
    window_days: 28,
    from_cache: false,
    is_demo: false,
    summary: {
      clicks: totalClicks,
      impressions: totalImpressions,
      ctr: Math.round(ctr * 10000) / 10000,
      position: avgPosition ? Math.round(avgPosition * 10) / 10 : null,
    },
    weekly,
    top_queries,
    top_pages,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });

  const siteUrl = process.env.GSC_CK_SITE_URL || 'sc-domain:chriskelley.io';
  const refresh = req.query?.refresh === 'true' || req.query?.refresh === '1';

  const cacheKey = `ck:${siteUrl}`;
  const cached = cache.get(cacheKey);
  if (!refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return res.status(200).json({ ...cached.payload, from_cache: true });
  }

  if (!process.env.GSC_CK_REFRESH_TOKEN) {
    return res.status(200).json(demoPayload(siteUrl));
  }

  try {
    const payload = await fetchLive(siteUrl);
    cache.set(cacheKey, { at: Date.now(), payload });
    return res.status(200).json(payload);
  } catch (err) {
    console.error('ck-stats error:', err);
    return res.status(200).json({
      ...demoPayload(siteUrl),
      is_demo: true,
      demo_reason: `Live fetch failed: ${err.message}`,
    });
  }
};
