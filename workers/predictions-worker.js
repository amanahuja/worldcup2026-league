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
import { parseResultsYaml, parsePredictionYaml, deriveWinner } from './scores-worker.js';

// ---------------------------------------------------------------------------
// Lock dates (UTC)
// ---------------------------------------------------------------------------

const LOCK_DATES = {
  groups:   new Date('2026-06-14T07:00:00Z'), // deadline extended to end of Jun 12 midnight PT (UTC-7)
  knockout: new Date('2026-06-29T18:00:00Z'), // extended to 1pm CT (CDT = UTC-5)
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

// ---------------------------------------------------------------------------
// Public picks handler — GET /api/picks/:username (no auth required)
// ---------------------------------------------------------------------------

// Hardcoded R32 team matchups — verified from KO_TEAM_NAME_MAP in results-worker.js
// (2026-06-29). These are stable; team names don't change after the draw.
const R32_TEAMS = {
  R32_73: { home: 'South Africa',        away: 'Canada'               },
  R32_74: { home: 'Germany',             away: 'Paraguay'             },
  R32_75: { home: 'Netherlands',         away: 'Morocco'              },
  R32_76: { home: 'Brazil',              away: 'Japan'                },
  R32_77: { home: 'France',              away: 'Sweden'               },
  R32_78: { home: 'Ivory Coast',         away: 'Norway'               },
  R32_79: { home: 'Mexico',              away: 'Ecuador'              },
  R32_80: { home: 'England',             away: 'DR Congo'             },
  R32_81: { home: 'USA',                 away: 'Bosnia & Herzegovina' },
  R32_82: { home: 'Belgium',             away: 'Senegal'              },
  R32_83: { home: 'Portugal',            away: 'Croatia'              },
  R32_84: { home: 'Spain',               away: 'Austria'              },
  R32_85: { home: 'Switzerland',         away: 'Algeria'              },
  R32_86: { home: 'Argentina',           away: 'Cape Verde'           },
  R32_87: { home: 'Colombia',            away: 'Ghana'                },
  R32_88: { home: 'Australia',           away: 'Egypt'                },
};

// R16/QF/SF feeders — mirrors scores-worker.js bracket constants
const R16_FEEDERS = {
  R16_89: ['R32_74', 'R32_77'],
  R16_90: ['R32_73', 'R32_75'],
  R16_91: ['R32_76', 'R32_78'],
  R16_92: ['R32_79', 'R32_80'],
  R16_93: ['R32_83', 'R32_84'],
  R16_94: ['R32_81', 'R32_82'],
  R16_95: ['R32_86', 'R32_88'],
  R16_96: ['R32_85', 'R32_87'],
};
const QF_FEEDERS = {
  QF_97:  ['R16_89', 'R16_90'],
  QF_98:  ['R16_93', 'R16_94'],
  QF_99:  ['R16_91', 'R16_92'],
  QF_100: ['R16_95', 'R16_96'],
};
const SF_FEEDERS = {
  SF_101: ['QF_97', 'QF_98'],
  SF_102: ['QF_99', 'QF_100'],
};

export async function handleGetPublicPicks(username, env) {
  // Validate user exists in KV
  const stored = await env.WC2026_USERS.get(username.toLowerCase());
  if (!stored) {
    return new Response(JSON.stringify({ error: 'User not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const lc = username.toLowerCase();

  // Fetch everything needed in parallel (3 GitHub subrequests)
  const [resultsFile, defaultsKoFile, userKoFile] = await Promise.all([
    githubGet('data/results.yaml', env),
    githubGet('data/predictions/defaults-knockout.yaml', env),
    githubGet(`data/predictions/${lc}-knockout.yaml`, env),
  ]);

  const { matches: results } = resultsFile
    ? parseResultsYaml(resultsFile.content)
    : { matches: new Map() };

  // Parse knockout predictions (user overrides defaults)
  const defaultsK = defaultsKoFile
    ? parsePredictionYaml(defaultsKoFile.content)
    : { predictions: new Map(), tiebreaker_goals: null };
  const userK = userKoFile
    ? parsePredictionYaml(userKoFile.content)
    : { predictions: new Map(), tiebreaker_goals: null };

  const mergedPicks = new Map([...defaultsK.predictions, ...userK.predictions]);

  // Build bracket: seed R32 from hardcoded team names, propagate winners round by round.
  const bracket = {};

  // R32 — team names from R32_TEAMS, actual winner from results
  for (const [id, teams] of Object.entries(R32_TEAMS)) {
    const result = results.get(id);
    const actualSide = result?.status === 'completed' ? deriveWinner(result) : null;
    const actualWinner = actualSide === 'home' ? teams.home
                       : actualSide === 'away' ? teams.away
                       : null;
    bracket[id] = { home: teams.home, away: teams.away, actual_winner: actualWinner };
  }

  // Resolve the team the user predicted would advance out of a slot.
  // Always uses the user's pick (merged with defaults) — never actual results.
  // actual_winner is stored separately on each match entry for the overlay only.
  function resolveTeam(slotId) {
    const e = bracket[slotId];
    if (!e) return null;
    const pick = mergedPicks.get(slotId);
    return pick === 'home' ? e.home : pick === 'away' ? e.away : null;
  }

  // R16, QF, SF — home/away come from the winning team of each feeder match
  function propagate(feedersMap) {
    for (const [id, [f1, f2]] of Object.entries(feedersMap)) {
      const home = resolveTeam(f1);
      const away = resolveTeam(f2);
      const result = results.get(id);
      const actualSide = result?.status === 'completed' ? deriveWinner(result) : null;
      const actualWinner = actualSide === 'home' ? home
                         : actualSide === 'away' ? away
                         : null;
      bracket[id] = { home, away, actual_winner: actualWinner };
    }
  }

  propagate(R16_FEEDERS);
  propagate(QF_FEEDERS);
  propagate(SF_FEEDERS);

  // Final
  const finalHome = resolveTeam('SF_101');
  const finalAway = resolveTeam('SF_102');
  const finalResult = results.get('FINAL');
  const finalSide = finalResult?.status === 'completed' ? deriveWinner(finalResult) : null;
  bracket['FINAL'] = {
    home: finalHome,
    away: finalAway,
    actual_winner: finalSide === 'home' ? finalHome
                 : finalSide === 'away' ? finalAway
                 : null,
  };

  // Third place — losers of each SF, derived from user's picks (not actual results)
  const sf1 = bracket['SF_101'];
  const sf2 = bracket['SF_102'];
  const sf1Pick = mergedPicks.get('SF_101');
  const sf2Pick = mergedPicks.get('SF_102');
  const sf1Loser = sf1Pick === 'home' ? sf1?.away
                 : sf1Pick === 'away' ? sf1?.home
                 : null;
  const sf2Loser = sf2Pick === 'home' ? sf2?.away
                 : sf2Pick === 'away' ? sf2?.home
                 : null;
  const thirdResult = results.get('THIRD');
  const thirdSide = thirdResult?.status === 'completed' ? deriveWinner(thirdResult) : null;
  bracket['THIRD'] = {
    home: sf1Loser,
    away: sf2Loser,
    actual_winner: thirdSide === 'home' ? sf1Loser
                 : thirdSide === 'away' ? sf2Loser
                 : null,
  };

  // Overlay user picks: translate 'home'/'away' to team name
  for (const [id, entry] of Object.entries(bracket)) {
    const pick = mergedPicks.get(id);
    entry.predicted_team = pick === 'home' ? entry.home
                         : pick === 'away' ? entry.away
                         : null;
  }

  // Chain validation — mirrors isPredictionValid() in scores-worker.js.
  // For each KO match (R16+), check that the user correctly predicted the winner
  // of the feeder match on their picked side, recursively back to R32.
  // R32 and THIRD are always valid (no prior round to validate).
  // Attaches chain_valid: boolean to each bracket entry.
  const ALL_KO_FEEDERS = {
    ...R16_FEEDERS,
    ...QF_FEEDERS,
    ...SF_FEEDERS,
    FINAL: ['SF_101', 'SF_102'],
  };

  function isPickChainValid(matchId, prediction) {
    if (matchId.startsWith('R32_') || matchId === 'THIRD') return true;
    const feeders = ALL_KO_FEEDERS[matchId];
    if (!feeders) return true;

    // feeders[0] supplies home; feeders[1] supplies away
    const feederMatchId = prediction === 'home' ? feeders[0] : feeders[1];

    const feederResult = results.get(feederMatchId);
    if (!feederResult || feederResult.status !== 'completed') return false;

    const feederActualSide = deriveWinner(feederResult); // 'home'|'away'|null
    if (!feederActualSide) return false;

    const userFeederPick = mergedPicks.get(feederMatchId);
    if (!userFeederPick) return false;

    // User must have predicted the side that actually won the feeder
    if (userFeederPick !== feederActualSide) return false;

    // Recurse: validate the feeder pick itself
    return isPickChainValid(feederMatchId, userFeederPick);
  }

  for (const [id, entry] of Object.entries(bracket)) {
    if (id.startsWith('R32_') || id === 'THIRD') {
      entry.chain_valid = true;
    } else {
      const pick = mergedPicks.get(id);
      entry.chain_valid = pick ? isPickChainValid(id, pick) : true;
    }
  }

  return new Response(JSON.stringify({
    username:         lc,
    bracket,
    tiebreaker_goals: userK.tiebreaker_goals ?? defaultsK.tiebreaker_goals ?? null,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
