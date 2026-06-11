/**
 * predictions-worker.js
 *
 * Routes:
 *   GET  /api/predictions           — returns merged predictions for the logged-in user
 *   POST /api/predictions/groups    — saves group stage picks
 *   POST /api/predictions/knockout  — saves knockout picks + tiebreaker
 *
 * All routes require a valid session cookie.
 *
 * Bindings required:
 *   WC2026_USERS   — KV namespace
 *   SESSION_SECRET — Worker secret
 *   GITHUB_TOKEN   — Worker secret (fine-grained PAT, contents:write on repo)
 *
 * Environment variables (set in wrangler.toml or via secrets):
 *   GITHUB_REPO    — e.g. "amanahuja/worldcup2026-league"
 *   GITHUB_BRANCH  — e.g. "main"
 */

import { getSession } from './auth-worker.js';

// ---------------------------------------------------------------------------
// Lock dates (UTC)
// ---------------------------------------------------------------------------

const LOCK_DATES = {
  groups:   new Date('2026-06-12T00:00:00Z'), // deadline extended to Jun 12 midnight UTC
  knockout: new Date('2026-06-29T00:00:00Z'), // first R32 kickoff (approx)
  // third-place lock is dynamic — checked against results.yaml SF completion
};

function isLocked(window) {
  if (window === 'groups')   return Date.now() >= LOCK_DATES.groups.getTime();
  if (window === 'knockout') return Date.now() >= LOCK_DATES.knockout.getTime();
  return false; // third-place handled separately
}

// ---------------------------------------------------------------------------
// GitHub Contents API helpers
// ---------------------------------------------------------------------------

import { githubGet, githubPut } from './github.js';

// ---------------------------------------------------------------------------
// Minimal YAML serialiser for prediction files
// (Cloudflare Workers has no built-in YAML parser; we use a tiny inline one)
// ---------------------------------------------------------------------------

/**
 * Very small YAML parser — handles only the flat key: value structure used in
 * prediction files. Sufficient for our schema; not a general-purpose parser.
 */
function parseSimpleYaml(text) {
  const result = {};
  let currentKey = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd(); // strip comments
    if (!line.trim()) continue;

    const indent = line.match(/^(\s*)/)[1].length;
    const trimmed = line.trim();

    if (indent === 0) {
      // top-level key (e.g. "username:", "predictions:", "tiebreaker_goals:")
      const m = trimmed.match(/^(\w[\w_]*):\s*(.*)$/);
      if (m) {
        const [, key, val] = m;
        if (val === '' || val === null) {
          result[key] = {};
          currentKey = key;
        } else {
          result[key] = val === 'null' ? null : isNaN(val) ? val : Number(val);
          currentKey = null;
        }
      }
    } else if (indent === 2 && currentKey) {
      // second-level key under predictions / defaults
      const m = trimmed.match(/^([\w_]+):\s*(.*)$/);
      if (m) {
        const [, key, val] = m;
        if (typeof result[currentKey] !== 'object') result[currentKey] = {};
        result[currentKey][key] = {};
        result[currentKey][`_cur`] = key;
      }
    } else if (indent === 4 && currentKey) {
      // third-level key (e.g. predicted_winner)
      const matchId = result[currentKey]?._cur;
      if (matchId) {
        const m = trimmed.match(/^([\w_]+):\s*(.*)$/);
        if (m) {
          const [, key, val] = m;
          result[currentKey][matchId][key] = val === 'null' ? null : val;
        }
      }
    }
  }
  // Clean up internal cursor keys
  for (const k of Object.keys(result)) {
    if (result[k] && typeof result[k] === 'object') {
      delete result[k]._cur;
    }
  }
  return result;
}

function serializeGroupPredictions(username, predictions) {
  let yaml = `username: ${username}\npredictions:\n`;
  for (const [matchId, pick] of Object.entries(predictions)) {
    yaml += `  ${matchId}:\n    predicted_winner: ${pick.predicted_winner}\n`;
  }
  return yaml;
}

function serializeKnockoutPredictions(username, predictions, tiebreakerGoals) {
  const tb = tiebreakerGoals === null || tiebreakerGoals === undefined ? 'null' : tiebreakerGoals;
  let yaml = `username: ${username}\ntiebreaker_goals: ${tb}\npredictions:\n`;
  for (const [matchId, pick] of Object.entries(predictions)) {
    yaml += `  ${matchId}:\n    predicted_winner: ${pick.predicted_winner}\n`;
  }
  return yaml;
}

// ---------------------------------------------------------------------------
// Merge predictions: user picks override defaults match-by-match
// ---------------------------------------------------------------------------

function mergePredictions(defaults, userPicks) {
  const merged = {};
  const defaultPreds = defaults?.defaults || defaults?.predictions || {};
  const userPreds = userPicks?.predictions || {};
  const allIds = new Set([...Object.keys(defaultPreds), ...Object.keys(userPreds)]);
  for (const id of allIds) {
    merged[id] = userPreds[id] || defaultPreds[id] || null;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export async function handleGetPredictions(request, env, session) {
  const [defaultsGroups, userGroups, defaultsKnockout, userKnockout] = await Promise.all([
    githubGet('data/predictions/defaults-groups.yaml', env),
    githubGet(`data/predictions/${session.username}-groups.yaml`, env),
    githubGet('data/predictions/defaults-knockout.yaml', env),
    githubGet(`data/predictions/${session.username}-knockout.yaml`, env),
  ]);

  const dg = defaultsGroups ? parseSimpleYaml(defaultsGroups.content) : {};
  const ug = userGroups    ? parseSimpleYaml(userGroups.content)    : {};
  const dk = defaultsKnockout ? parseSimpleYaml(defaultsKnockout.content) : {};
  const uk = userKnockout     ? parseSimpleYaml(userKnockout.content)     : {};

  return new Response(JSON.stringify({
    username: session.username,
    groups: {
      predictions: mergePredictions(dg, ug),
      locked: isLocked('groups'),
    },
    knockout: {
      predictions: mergePredictions(dk, uk),
      tiebreaker_goals: uk.tiebreaker_goals ?? null,
      locked: isLocked('knockout'),
    },
    locks: {
      groups:   LOCK_DATES.groups.toISOString(),
      knockout: LOCK_DATES.knockout.toISOString(),
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handlePostGroupPredictions(request, env, session) {
  if (isLocked('groups')) {
    return new Response(JSON.stringify({ error: 'Group stage predictions are locked' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = await request.json();
  // body: { match_id: "G_A1", predicted_winner: "home"|"away"|"draw" }
  const { match_id, predicted_winner } = body;
  if (!match_id || !['home', 'away', 'draw'].includes(predicted_winner)) {
    return new Response(JSON.stringify({ error: 'Invalid payload' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const path = `data/predictions/${session.username}-groups.yaml`;
  const existing = await githubGet(path, env);
  let current = existing ? parseSimpleYaml(existing.content) : { username: session.username, predictions: {} };
  if (!current.predictions) current.predictions = {};
  current.predictions[match_id] = { predicted_winner };

  const newContent = serializeGroupPredictions(session.username, current.predictions);
  const msg = `wc2026[app]: ${session.username} picks ${match_id} → ${predicted_winner}`;
  await githubPut(path, newContent, existing?.sha || null, env, msg);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handlePostKnockoutPredictions(request, env, session) {
  if (isLocked('knockout')) {
    return new Response(JSON.stringify({ error: 'Knockout predictions are locked' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = await request.json();
  // body may contain: match_id + predicted_winner, or tiebreaker_goals
  const { match_id, predicted_winner, tiebreaker_goals } = body;

  const path = `data/predictions/${session.username}-knockout.yaml`;
  const existing = await githubGet(path, env);
  let current = existing
    ? parseSimpleYaml(existing.content)
    : { username: session.username, tiebreaker_goals: null, predictions: {} };
  if (!current.predictions) current.predictions = {};

  if (tiebreaker_goals !== undefined) {
    const tb = parseInt(tiebreaker_goals, 10);
    current.tiebreaker_goals = isNaN(tb) || tb < 0 ? null : tb;
  }

  if (match_id && predicted_winner) {
    if (!['home', 'away'].includes(predicted_winner)) {
      return new Response(JSON.stringify({ error: 'Invalid predicted_winner value for knockout match' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    current.predictions[match_id] = { predicted_winner };
  }

  const newContent = serializeKnockoutPredictions(
    session.username,
    current.predictions,
    current.tiebreaker_goals,
  );
  const msg = match_id
    ? `wc2026[app]: ${session.username} picks ${match_id} → ${predicted_winner}`
    : `wc2026[app]: ${session.username} tiebreaker → ${current.tiebreaker_goals}`;
  await githubPut(path, newContent, existing?.sha || null, env, msg);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
