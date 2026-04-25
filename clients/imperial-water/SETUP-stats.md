# Site Stats — Google Search Console wiring

The Site Stats page in the Imperial Water portal pulls live data from Google Search Console (clicks, impressions, top queries, top pages, position) via `/api/imperial-stats.js`.

If env vars aren't set, the endpoint returns a **demo payload** with `is_demo: true` so the portal renders a preview state instead of erroring.

## One-time setup

### 1. Create a Google Cloud service account

1. Go to [console.cloud.google.com](https://console.cloud.google.com), create or pick a project (e.g. `chriskelley-portal`).
2. Enable the **Google Search Console API** (APIs & Services → Library → search "Search Console API" → Enable).
3. APIs & Services → Credentials → Create Credentials → **Service Account**.
   - Name: `gsc-portal-reader`
   - Skip the optional "grant access" steps.
4. Open the new service account → Keys → Add Key → **Create new key** → JSON. A `.json` file downloads.

### 2. Grant the service account access to the GSC property

1. Go to [search.google.com/search-console](https://search.google.com/search-console).
2. Pick the `imperialwaterco.com` property.
3. Settings → **Users and permissions** → Add user.
4. Paste the service account email (looks like `gsc-portal-reader@chriskelley-portal.iam.gserviceaccount.com`).
5. Permission: **Restricted** (read-only is enough for this).

### 3. Set Vercel env vars

In the Vercel project (chriskelley.io) → Settings → Environment Variables, add:

| Name | Value |
|---|---|
| `GSC_SERVICE_ACCOUNT_JSON` | The full contents of the `.json` file from step 1.4, pasted as one line |
| `GSC_SITE_URL` | `sc-domain:imperialwaterco.com` (use `sc-domain:` prefix for domain properties; or `https://imperialwaterco.com/` for URL-prefix properties) |

Apply to: Production, Preview, Development.

### 4. Redeploy

Vercel → Deployments → Redeploy latest, or push a commit. The next page load on `chriskelley.io/clients/imperial-water#site-stats` should pull live data.

## How it behaves

- **First load per session**: lazy-loads when user opens the Site Stats tab.
- **Caching**: 24 hours per Vercel serverless instance. The "Refresh now" button bypasses cache (sends `?refresh=true`).
- **Data lag**: Search Console itself has a ~2 day lag. The endpoint always queries `today - 2 days` as the end date.
- **8-week chart**: Buckets daily data into ISO weeks (Sunday-start), 8 most-recent weeks shown.
- **Top queries / top pages**: 10 most-recent, sorted by clicks. Bars normalized to the top item.
- **Failure mode**: If GSC fetch fails (permissions, quota, etc.), the endpoint returns the demo payload with the error message in `demo_reason`, so the portal still renders.

## Future: adding GA4 and/or Vercel Analytics

The endpoint is structured to make adding more data sources easy. A few notes:

- **GA4 (Google Analytics)**: Same service account can be used. Grant Viewer access in GA4 admin → Property Access. Add `@google-analytics/data` package and call `runReport`. Useful for: visitor count, session duration, mobile %, traffic sources.
- **Vercel Web Analytics**: Use a Vercel API token + project ID. The REST API gives you pageviews and visitor counts but not query-level data — keep GSC as the keyword source.

For now, GSC alone gives the most interesting "what's growing" signal for a service business.
