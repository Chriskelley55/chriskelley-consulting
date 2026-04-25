// /api/imperial-stats.js
// Pulls Google Search Console data for Imperial Water and returns
// portal-friendly JSON. Caches in-memory for 24h per Vercel instance.
//
// Required env vars (set in Vercel project settings):
//   GSC_SERVICE_ACCOUNT_JSON  — full service account JSON (stringified)
//   GSC_SITE_URL              — e.g. "sc-domain:imperialwaterco.com"
//                                 OR "https://imperialwaterco.com/"
//
// If env vars are missing, returns demo data with `is_demo: true` so the
// portal still renders something instead of erroring.

const { JWT } = require('google-auth-library');

// Module-level cache (per serverless instance — survives warm invocations)
const cache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function ymd(d) {
  return d.toISOString().slice(0, 10);
}
function startOfWeek(d) {
  const x = new Date(d);
  const day = x.getUTCDay(); // 0 = Sun
  x.setUTCDate(x.getUTCDate() - day);
  return x;
}

async function gscQuery(token, siteUrl, body) {
  const encodedSite = encodeURIComponent(siteUrl);
  const r = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodedSite}/searchAnalytics/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
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
  // Realistic-looking placeholder so the UI has something to render while
  // GSC is still building data (Search Console takes ~2 days to populate).
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
    site: 'imperial-water',
    domain: siteUrl || 'imperialwaterco.com',
    last_refreshed: new Date().toISOString(),
    from_cache: false,
    is_demo: true,
    demo_reason: 'GSC env vars not configured yet — see /clients/imperial-water/SETUP-stats.md',
    summary: {
      clicks: 0,
      impressions: 0,
      ctr: 0,
      position: null,
      pages_indexed: 6,
    },
    weekly,
    top_queries: [],
    top_pages: [
      { path: '/', clicks: 0, impressions: 0, pct: 0 },
      { path: '/services', clicks: 0, impressions: 0, pct: 0 },
      { path: '/water-report', clicks: 0, impressions: 0, pct: 0 },
      { path: '/why-water', clicks: 0, impressions: 0, pct: 0 },
      { path: '/maintenance', clicks: 0, impressions: 0, pct: 0 },
    ],
  };
}

async function fetchLive(siteUrl) {
  const credsRaw = process.env.GSC_SERVICE_ACCOUNT_JSON;
  if (!credsRaw) throw new Error('Missing GSC_SERVICE_ACCOUNT_JSON env var');

  let creds;
  try {
    creds = JSON.parse(credsRaw);
  } catch (e) {
    throw new Error('GSC_SERVICE_ACCOUNT_JSON is not valid JSON');
  }

  const auth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
  const tokenObj = await auth.getAccessToken();
  const token = tokenObj?.token || tokenObj;
  if (!token) throw new Error('GSC auth: no access token returned');

  const today = new Date();
  const end = new Date(today.getTime() - 2 * 86400e3); // GSC has ~2-day lag
  const start56 = new Date(end.getTime() - 56 * 86400e3);
  const start28 = new Date(end.getTime() - 28 * 86400e3);

  const [byDate, byQuery, byPage] = await Promise.all([
    gscQuery(token, siteUrl, {
      startDate: ymd(start56),
      endDate: ymd(end),
      dimensions: ['date'],
      rowLimit: 100,
    }),
    gscQuery(token, siteUrl, {
      startDate: ymd(start28),
      endDate: ymd(end),
      dimensions: ['query'],
      rowLimit: 10,
    }),
    gscQuery(token, siteUrl, {
      startDate: ymd(start28),
      endDate: ymd(end),
      dimensions: ['page'],
      rowLimit: 10,
    }),
  ]);

  // Bucket the date series into 8 weeks
  const weeklyMap = new Map(); // weekStart ISO -> { clicks, impressions }
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
    const date = new Date(row.keys[0] + 'T00:00:00Z');
    const wkKey = ymd(startOfWeek(date));
    if (weeklyMap.has(wkKey)) {
      const w = weeklyMap.get(wkKey);
      w.clicks += row.clicks || 0;
      w.impressions += row.impressions || 0;
    }
  }
  const weekly = Array.from(weeklyMap.values());

  // Aggregate 28-day totals from byDate (only last 28 days)
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
  const top_pages = (byPage.rows || []).slice(0, 6).map(r => {
    const url = r.keys[0];
    let path = url;
    try {
      path = new URL(url).pathname;
    } catch {}
    return {
      path,
      clicks: r.clicks || 0,
      impressions: r.impressions || 0,
      pct: Math.round(((r.clicks || 0) / maxPageClicks) * 100),
    };
  });

  return {
    site: 'imperial-water',
    domain: 'imperialwaterco.com',
    last_refreshed: new Date().toISOString(),
    window_days: 28,
    from_cache: false,
    is_demo: false,
    summary: {
      clicks: totalClicks,
      impressions: totalImpressions,
      ctr: Math.round(ctr * 10000) / 10000,
      position: avgPosition ? Math.round(avgPosition * 10) / 10 : null,
      pages_indexed: 6,
    },
    weekly,
    top_queries,
    top_pages,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const siteUrl = process.env.GSC_SITE_URL || 'sc-domain:imperialwaterco.com';
  const refresh = req.query?.refresh === 'true' || req.query?.refresh === '1';

  // Cache check
  const cacheKey = `imperial:${siteUrl}`;
  const cached = cache.get(cacheKey);
  if (!refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return res.status(200).json({ ...cached.payload, from_cache: true });
  }

  // No env vars → return demo payload, don't crash
  if (!process.env.GSC_SERVICE_ACCOUNT_JSON) {
    return res.status(200).json(demoPayload(siteUrl));
  }

  try {
    const payload = await fetchLive(siteUrl);
    cache.set(cacheKey, { at: Date.now(), payload });
    return res.status(200).json(payload);
  } catch (err) {
    console.error('imperial-stats error:', err);
    // Soft-fail: return demo payload + the error message so the portal still renders
    return res.status(200).json({
      ...demoPayload(siteUrl),
      is_demo: true,
      demo_reason: `Live fetch failed: ${err.message}`,
    });
  }
};
