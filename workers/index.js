/**
 * workers/index.js — Cloudflare Worker entry point
 *
 * Routes:
 *   POST /api/login
 *   GET  /api/predictions
 *   POST /api/predictions/groups
 *   POST /api/predictions/knockout
 *   GET  /api/scores
 *
 * Cron:
 *   Scheduled trigger → results-worker
 *
 * Environment bindings (wrangler.toml + secrets):
 *   WC2026_USERS   — KV namespace
 *   SESSION_SECRET — Worker secret
 *   GITHUB_TOKEN   — Worker secret
 *   GITHUB_REPO    — "amanahuja/worldcup2026-league"
 *   GITHUB_BRANCH  — "main"
 */

import { handleLogin, getSession } from './auth-worker.js';
import {
  handleGetPredictions,
  handlePostGroupPredictions,
  handlePostKnockoutPredictions,
} from './predictions-worker.js';
import { handleScheduled } from './results-worker.js';
import { handleGetScores } from './scores-worker.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function cors(response) {
  const r = new Response(response.body, response);
  for (const [k, v] of Object.entries(CORS_HEADERS)) r.headers.set(k, v);
  return r;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export default {
  // -------------------------------------------------------------------------
  // HTTP fetch handler
  // -------------------------------------------------------------------------
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname, method } = { pathname: url.pathname, method: request.method };

    // Preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // POST /api/login
      if (pathname === '/api/login' && method === 'POST') {
        return cors(await handleLogin(request, env));
      }

      // GET /api/scores — public, no auth required
      if (pathname === '/api/scores' && method === 'GET') {
        const session = await getSession(request, env); // null if not logged in — OK
        return cors(await handleGetScores(request, env, session));
      }

      // Authenticated routes
      if (pathname.startsWith('/api/predictions')) {
        const session = await getSession(request, env);
        if (!session) {
          return json({ error: 'Unauthorized' }, 401);
        }

        if (pathname === '/api/predictions' && method === 'GET') {
          return cors(await handleGetPredictions(request, env, session));
        }
        if (pathname === '/api/predictions/groups' && method === 'POST') {
          return cors(await handlePostGroupPredictions(request, env, session));
        }
        if (pathname === '/api/predictions/knockout' && method === 'POST') {
          return cors(await handlePostKnockoutPredictions(request, env, session));
        }
      }

      return json({ error: 'Not Found' }, 404);
    } catch (e) {
      console.error('Worker error:', e.message, e.stack);
      return json({ error: 'Internal Server Error' }, 500);
    }
  },

  // -------------------------------------------------------------------------
  // Cron scheduled handler
  // -------------------------------------------------------------------------
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
};
