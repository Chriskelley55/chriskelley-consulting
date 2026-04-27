// /api/requests.js
// Client change-request system.
//
// Required env vars (set in Vercel project settings):
//   KV_REST_API_URL    — auto-populated when Vercel KV is connected
//   KV_REST_API_TOKEN  — auto-populated when Vercel KV is connected
//   ADMIN_TOKEN        — admin password (used to authenticate admin actions)
//
// Endpoints:
//   GET  ?client=imperial-water        → active requests for a client
//   GET  ?view=all                     → all requests across all clients (admin)
//   POST { clientId, clientName, description } → create a new request
//   PATCH { id, clientId, status }     → update request status (admin)
//
// Status lifecycle: pending → in_progress → complete
//                   pending → denied
//
// ADMIN_TOKEN is validated via the X-Admin-Token request header.

const { kv } = require('@vercel/kv');

// Keep this list updated as clients are onboarded
const CLIENT_IDS = ['imperial-water'];

function makeId() {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function isAdmin(req) {
  const token = req.headers['x-admin-token'];
  return !!token && token === process.env.ADMIN_TOKEN;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET ──────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { client, view } = req.query || {};

    // Admin view: all requests across every client, newest first
    if (view === 'all') {
      if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
      const all = [];
      for (const cid of CLIENT_IDS) {
        const rows = (await kv.get(`requests:${cid}`)) || [];
        all.push(...rows);
      }
      all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return res.status(200).json({ requests: all });
    }

    // Client view: only their active (non-archived) requests
    if (client) {
      const rows = (await kv.get(`requests:${client}`)) || [];
      // Show everything except denied requests that are older than 7 days
      const cutoff = Date.now() - 7 * 86400e3;
      const visible = rows.filter(r => {
        if (r.status === 'denied' && new Date(r.updatedAt).getTime() < cutoff) return false;
        return true;
      });
      return res.status(200).json({ requests: visible });
    }

    return res.status(400).json({ error: 'Provide ?client= or ?view=all' });
  }

  // ── POST (create) ────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { clientId, clientName, description } = req.body || {};
    if (!clientId || !description?.trim()) {
      return res.status(400).json({ error: 'clientId and description are required' });
    }
    if (!CLIENT_IDS.includes(clientId)) {
      return res.status(400).json({ error: 'Unknown clientId' });
    }

    const request = {
      id: makeId(),
      clientId,
      clientName: clientName || clientId,
      description: description.trim().slice(0, 2000), // safety cap
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const existing = (await kv.get(`requests:${clientId}`)) || [];
    existing.unshift(request);
    await kv.set(`requests:${clientId}`, existing);

    return res.status(201).json({ request });
  }

  // ── PATCH (update status) ────────────────────────────────────────────
  if (req.method === 'PATCH') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });

    const { id, clientId, status } = req.body || {};
    if (!id || !clientId || !status) {
      return res.status(400).json({ error: 'id, clientId, and status are required' });
    }

    const valid = ['pending', 'in_progress', 'complete', 'denied'];
    if (!valid.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` });
    }

    const rows = (await kv.get(`requests:${clientId}`)) || [];
    const idx = rows.findIndex(r => r.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Request not found' });

    rows[idx] = { ...rows[idx], status, updatedAt: new Date().toISOString() };
    await kv.set(`requests:${clientId}`, rows);

    return res.status(200).json({ request: rows[idx] });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
