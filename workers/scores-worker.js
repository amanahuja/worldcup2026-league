/**
 * scores-worker.js
 *
 * Route: GET /api/scores
 *
 * Reads results.yaml + all prediction files from GitHub.
 * Derives group standings, bracket seeding, per-user scores, tiebreaker resolution.
 * Returns sorted leaderboard + match results.
 *
 * Bindings required:
 *   GITHUB_TOKEN  — Worker secret
 *   GITHUB_REPO   — e.g. "amanahuja/worldcup2026-league"
 *   GITHUB_BRANCH — e.g. "main"
 */

// ---------------------------------------------------------------------------
// Tournament dates
// ---------------------------------------------------------------------------
// Last group matches kick off 2026-06-28T02:00Z; 04:00Z gives ~2h buffer for final whistle + cron.
const KO_RESULTS_DATE = new Date('2026-06-28T04:00:00Z');

// ---------------------------------------------------------------------------
// Scoring table
// ---------------------------------------------------------------------------

const POINTS = {
  group:       1,
  R32:         2,
  R16:         3,
  QF:          4,
  SF:          5,
  third_place: 3,
  final:       10,
};

function matchRound(matchId) {
  if (matchId.startsWith('G_'))     return 'group';
  if (matchId.startsWith('R32_'))   return 'R32';
  if (matchId.startsWith('R16_'))   return 'R16';
  if (matchId.startsWith('QF_'))    return 'QF';
  if (matchId.startsWith('SF_'))    return 'SF';
  if (matchId === 'THIRD')          return 'third_place';
  if (matchId === 'FINAL')          return 'final';
  // Fallback for KO_ IDs from results-worker when bracket not yet fully mapped
  return null;
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

import { githubGet, githubPut, listDirectory } from './github.js';

// ---------------------------------------------------------------------------
// Minimal YAML parsers
// ---------------------------------------------------------------------------

export function parseResultsYaml(text) {
  // Returns: { last_updated, matches: Map<id → {status, home_score, away_score, home_pen, away_pen, winner}> }
  const matches = new Map();
  let current = null;
  let inMatches = false;

  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('matches:')) { inMatches = true; continue; }
    if (!inMatches) continue;

    const indent = line.match(/^(\s*)/)[1].length;
    if (indent === 2) {
      // match ID line: "  G_A1:"
      current = trimmed.replace(':', '');
      matches.set(current, {});
      continue;
    }
    if (indent === 4 && current) {
      const m = trimmed.match(/^([\w_]+):\s*(.*)$/);
      if (m) {
        const val = m[2] === 'null' ? null : isNaN(m[2]) ? m[2] : Number(m[2]);
        matches.get(current)[m[1]] = val;
      }
    }
  }
  const luMatch = text.match(/last_updated:\s*"([^"]+)"/);
  return { last_updated: luMatch?.[1] || null, matches };
}

export function parsePredictionYaml(text) {
  // Returns: { username, tiebreaker_goals, predictions: Map<matchId → predicted_winner> }
  const predictions = new Map();
  let username = null;
  let tiebreakerGoals = null;
  let inPreds = false;
  let currentMatchId = null;

  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;
    const indent = line.match(/^(\s*)/)[1].length;

    if (indent === 0) {
      if (trimmed.startsWith('username:')) {
        username = trimmed.replace('username:', '').trim();
      } else if (trimmed.startsWith('tiebreaker_goals:')) {
        const v = trimmed.replace('tiebreaker_goals:', '').trim();
        tiebreakerGoals = v === 'null' ? null : parseInt(v, 10);
      } else if (trimmed === 'predictions:') {
        inPreds = true;
      } else if (trimmed === 'defaults:') {
        inPreds = true;
      }
      continue;
    }
    if (!inPreds) continue;
    if (indent === 2) {
      currentMatchId = trimmed.replace(':', '');
    } else if (indent === 4 && currentMatchId && trimmed.startsWith('predicted_winner:')) {
      predictions.set(currentMatchId, trimmed.replace('predicted_winner:', '').trim());
    }
  }
  return { username, tiebreaker_goals: tiebreakerGoals, predictions };
}

function parseGroupsYaml(text) {
  // Returns: { groups: Map<letter → { teams: [], matches: [{id, home, away, home_abbr, away_abbr, date, kickoff_utc}] }> }
  const groups = new Map();
  let currentGroup = null;
  let inMatches = false;
  let currentMatch = null;

  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;
    const indent = line.match(/^(\s*)/)[1].length;

    if (indent === 2 && trimmed.match(/^[A-L]:$/)) {
      currentGroup = trimmed.replace(':', '');
      groups.set(currentGroup, { teams: [], matches: [] });
      inMatches = false;
      continue;
    }
    if (!currentGroup) continue;

    if (indent === 4) {
      if (trimmed.startsWith('teams:')) {
        const teams = trimmed.replace('teams:', '').trim().replace(/[\[\]]/g, '').split(',').map(s => s.trim());
        groups.get(currentGroup).teams = teams;
      } else if (trimmed === 'matches:') {
        inMatches = true;
      }
      continue;
    }
    if (inMatches) {
      if (indent === 6 && trimmed.startsWith('- id:')) {
        currentMatch = { id: trimmed.replace('- id:', '').trim() };
        groups.get(currentGroup).matches.push(currentMatch);
      } else if (indent === 8 && currentMatch) {
        // field lines under the match list item (home:, away:, home_abbr:, etc.)
        const m = trimmed.match(/^([\w_]+):\s*"?([^"]*)"?\s*$/);
        if (m) currentMatch[m[1]] = m[2].trim();
      }
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Group standings calculation
// ---------------------------------------------------------------------------

/**
 * Calculate group standings from actual results only.
 * Unplayed matches are skipped entirely, so teams show their actual record.
 *
 * @param {object} groupData - { teams, matches }
 * @param {Map}    results   - actual match results from results.yaml
 */
function calcStandings(groupData, results) {
  const stats = {};
  for (const team of groupData.teams) {
    stats[team] = { team, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, pts: 0 };
  }

  for (const match of groupData.matches) {
    const result = results.get(match.id);
    if (!result || result.status !== 'completed') continue;

    const winner = result.winner || deriveWinner(result);
    const hs = result.home_score ?? 0;
    const as_ = result.away_score ?? 0;

    const home = stats[match.home];
    const away = stats[match.away];
    if (!home || !away) continue;

    home.played++;  away.played++;
    home.gf += hs;  home.ga += as_;
    away.gf += as_; away.ga += hs;

    if (winner === 'home') {
      home.won++; home.pts += 3; away.lost++;
    } else if (winner === 'away') {
      away.won++; away.pts += 3; home.lost++;
    } else {
      home.drawn++; home.pts++; away.drawn++; away.pts++;
    }
  }

  return Object.values(stats).sort((a, b) => {
    if (b.pts !== a.pts) return b.pts - a.pts;
    const gdA = a.gf - a.ga, gdB = b.gf - b.ga;
    if (gdB !== gdA) return gdB - gdA;
    if (b.gf !== a.gf) return b.gf - a.gf;
    if (b.won !== a.won) return b.won - a.won;
    return a.team.localeCompare(b.team);
  });
}

export function deriveWinner(result) {
  if (result.winner) return result.winner;
  if (result.home_score === null) return null;
  if (result.home_score > result.away_score) return 'home';
  if (result.away_score > result.home_score) return 'away';
  if (result.home_pen !== null) return result.home_pen > result.away_pen ? 'home' : 'away';
  return 'draw';
}

// ---------------------------------------------------------------------------
// FIFA 2026 R32 bracket seeding formula
// (https://en.wikipedia.org/wiki/2026_FIFA_World_Cup#Bracket)
//
// R32 matchup → [slot1, slot2]
// where slots are: "1A" = group A winner, "2B" = group B runner-up,
//                  "3ABCDF" = best 3rd from those groups (chosen by FIFA after group stage)
// ---------------------------------------------------------------------------

const R32_BRACKET = [
  // Match 73 (num=73 in openfootball data)
  { id: 'R32_73',  slots: ['2A', '2B'] },
  { id: 'R32_74',  slots: ['1E', '3ABCDF'] },
  { id: 'R32_75',  slots: ['1F', '2C'] },
  { id: 'R32_76',  slots: ['1C', '2F'] },
  { id: 'R32_77',  slots: ['1I', '3CDFGH'] },
  { id: 'R32_78',  slots: ['2E', '2I'] },
  { id: 'R32_79',  slots: ['1A', '3CEFHI'] },
  { id: 'R32_80',  slots: ['1L', '3EHIJK'] },
  { id: 'R32_81',  slots: ['1D', '3BEFIJ'] },
  { id: 'R32_82',  slots: ['1G', '3AEHIJ'] },
  { id: 'R32_83',  slots: ['2K', '2L'] },
  { id: 'R32_84',  slots: ['1H', '2J'] },
  { id: 'R32_85',  slots: ['1B', '3EFGIJ'] },
  { id: 'R32_86',  slots: ['1J', '2H'] },
  { id: 'R32_87',  slots: ['1K', '3DEIJL'] },
  { id: 'R32_88',  slots: ['2D', '2G'] },
];

// R16 pairings: match number → [R32 winner1, R32 winner2]
const R16_BRACKET = [
  { id: 'R16_89',  feeders: ['R32_74', 'R32_77'] },
  { id: 'R16_90',  feeders: ['R32_73', 'R32_75'] },
  { id: 'R16_91',  feeders: ['R32_76', 'R32_78'] },
  { id: 'R16_92',  feeders: ['R32_79', 'R32_80'] },
  { id: 'R16_93',  feeders: ['R32_83', 'R32_84'] },
  { id: 'R16_94',  feeders: ['R32_81', 'R32_82'] },
  { id: 'R16_95',  feeders: ['R32_86', 'R32_88'] },
  { id: 'R16_96',  feeders: ['R32_85', 'R32_87'] },
];

const QF_BRACKET = [
  { id: 'QF_97',  feeders: ['R16_89', 'R16_90'] },
  { id: 'QF_98',  feeders: ['R16_93', 'R16_94'] },
  { id: 'QF_99',  feeders: ['R16_91', 'R16_92'] },
  { id: 'QF_100', feeders: ['R16_95', 'R16_96'] },
];

const SF_BRACKET = [
  { id: 'SF_101', feeders: ['QF_97', 'QF_98'] },
  { id: 'SF_102', feeders: ['QF_99', 'QF_100'] },
];

// Final + 3rd place
const FINAL_BRACKET = { id: 'FINAL', feeders: ['SF_101', 'SF_102'], side: 'winner' };
const THIRD_BRACKET  = { id: 'THIRD', feeders: ['SF_101', 'SF_102'], side: 'loser' };

// ---------------------------------------------------------------------------
// Resolve bracket slots → team names
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WC2026 third-place slot assignments (hardcoded)
//
// Groups B, D, E, F, I, J, K, L had their third-place teams qualify.
// Per FIFA Annex C combination table this maps to:
//   1A(Mexico) vs 3E(Ecuador), 1B(Switzerland) vs 3J(Algeria),
//   1D(USA) vs 3B(Bosnia & Herzegovina), 1E(Germany) vs 3D(Paraguay),
//   1G(Belgium) vs 3I(Senegal), 1I(France) vs 3F(Sweden),
//   1K(Colombia) vs 3L(Ghana), 1L(England) vs 3K(DR Congo)
// ---------------------------------------------------------------------------
const THIRD_PLACE_SLOTS = {
  '3ABCDF': 'Paraguay',
  '3CDFGH': 'Sweden',
  '3CEFHI': 'Ecuador',
  '3EHIJK': 'DR Congo',
  '3BEFIJ': 'Bosnia & Herzegovina',
  '3AEHIJ': 'Senegal',
  '3EFGIJ': 'Algeria',
  '3DEIJL': 'Ghana',
};

/**
 * Resolve a slot label to a team name.
 * Slots like "1A" → winner of group A.
 * Slots like "2B" → runner-up of group B.
 * Slots like "3ABCDF" → hardcoded per FIFA combination table above.
 */
function resolveSlot(slot, groupStandings) {
  if (slot.startsWith('1')) {
    const g = slot.slice(1);
    return groupStandings.get(g)?.[0]?.team || null;
  }
  if (slot.startsWith('2')) {
    const g = slot.slice(1);
    return groupStandings.get(g)?.[1]?.team || null;
  }
  if (slot.startsWith('3')) {
    return THIRD_PLACE_SLOTS[slot] || null;
  }
  return null;
}

/**
 * Build the full bracket: resolve all team slots and derive round-by-round winners.
 * Returns a Map<matchId → { home, away, winner, status }>
 */
export function buildBracket(groupStandings, results) {
  const bracket = new Map();

  // Resolve group winners, runners-up, and third-place teams into R32 slots
  for (const m of R32_BRACKET) {
    const [s1, s2] = m.slots;
    const home = resolveSlot(s1, groupStandings);
    const away = resolveSlot(s2, groupStandings);

    const result = results.get(m.id);
    const winner = result?.status === 'completed' ? deriveWinner(result) : null;
    const winningTeam = winner === 'home' ? home : winner === 'away' ? away : null;
    bracket.set(m.id, { home, away, winner, winningTeam, status: result?.status || 'scheduled',
      home_score: result?.home_score ?? null, away_score: result?.away_score ?? null });
  }

  // Propagate through R16, QF, SF, Final, 3rd
  const propagate = (rounds) => {
    for (const m of rounds) {
      const [f1, f2] = m.feeders;
      const home = bracket.get(f1)?.winningTeam || null;
      const away = bracket.get(f2)?.winningTeam || null;
      const result = results.get(m.id);
      const winner = result?.status === 'completed' ? deriveWinner(result) : null;
      const winningTeam = winner === 'home' ? home : winner === 'away' ? away : null;
      bracket.set(m.id, { home, away, winner, winningTeam, status: result?.status || 'scheduled',
        home_score: result?.home_score ?? null, away_score: result?.away_score ?? null });
    }
  };

  propagate(R16_BRACKET);
  propagate(QF_BRACKET);
  propagate(SF_BRACKET);

  // Final
  const sf1 = bracket.get('SF_101');
  const sf2 = bracket.get('SF_102');
  const finalResult = results.get('FINAL');
  const finalWinner = finalResult?.status === 'completed' ? deriveWinner(finalResult) : null;
  bracket.set('FINAL', {
    home: sf1?.winningTeam || null,
    away: sf2?.winningTeam || null,
    winner: finalWinner,
    winningTeam: finalWinner === 'home' ? sf1?.winningTeam : finalWinner === 'away' ? sf2?.winningTeam : null,
    status: finalResult?.status || 'scheduled',
    home_score: finalResult?.home_score ?? null,
    away_score: finalResult?.away_score ?? null,
  });

  // Third-place: losers of both semis
  const sf1Loser = sf1 ? (sf1.winner === 'home' ? sf1.away : sf1.winner === 'away' ? sf1.home : null) : null;
  const sf2Loser = sf2 ? (sf2.winner === 'home' ? sf2.away : sf2.winner === 'away' ? sf2.home : null) : null;
  const thirdResult = results.get('THIRD');
  const thirdWinner = thirdResult?.status === 'completed' ? deriveWinner(thirdResult) : null;
  bracket.set('THIRD', {
    home: sf1Loser,
    away: sf2Loser,
    winner: thirdWinner,
    winningTeam: thirdWinner === 'home' ? sf1Loser : thirdWinner === 'away' ? sf2Loser : null,
    status: thirdResult?.status || 'scheduled',
    home_score: thirdResult?.home_score ?? null,
    away_score: thirdResult?.away_score ?? null,
  });

  return bracket;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

// Flat lookup: matchId → feeder match IDs [home-feeder, away-feeder]
// Built from the bracket constants defined above.
const KO_FEEDERS = new Map([
  ...R16_BRACKET.map(m => [m.id, m.feeders]),
  ...QF_BRACKET.map(m => [m.id, m.feeders]),
  ...SF_BRACKET.map(m => [m.id, m.feeders]),
  [FINAL_BRACKET.id, FINAL_BRACKET.feeders],
  // THIRD is intentionally omitted — no chain validation (users pick with full knowledge).
]);

/**
 * Returns true if the user's prediction chain is valid for the given match.
 *
 * For R32 matches: always valid (no prior round to check).
 * For THIRD: always valid (users pick after semis with full team knowledge).
 * For all other KO matches: the user must have correctly predicted the winner
 * of the feeder match that corresponds to their predicted side, and that
 * feeder prediction must itself be valid (recursive).
 *
 * @param {string} matchId
 * @param {string} prediction  - "home" or "away"
 * @param {Map}    knockoutPredictions - merged predictions map for this user
 * @param {Map}    bracket     - built bracket from buildBracket()
 */
function isPredictionValid(matchId, prediction, knockoutPredictions, bracket) {
  // R32 and THIRD: no chain to validate
  if (matchId.startsWith('R32_') || matchId === 'THIRD') return true;

  const feeders = KO_FEEDERS.get(matchId);
  if (!feeders) return true; // unknown match type, don't penalise

  // feeders[0] supplies the home team; feeders[1] supplies the away team.
  const feederMatchId = prediction === 'home' ? feeders[0] : feeders[1];

  const feederBracket = bracket.get(feederMatchId);
  if (!feederBracket || feederBracket.winner === null) return false; // feeder not complete

  const userFeederPick = knockoutPredictions.get(feederMatchId);
  if (!userFeederPick) return false; // no prediction for feeder

  // The user must have picked the winner of the feeder match
  if (userFeederPick !== feederBracket.winner) return false;

  // Recurse: validate the feeder pick too
  return isPredictionValid(feederMatchId, userFeederPick, knockoutPredictions, bracket);
}

function scoreUser(username, groupsPredictions, knockoutPredictions, results, bracket) {
  let total = 0;
  const breakdown = {};
  // KO matches where the user picked the right side but the bracket chain was
  // broken (eliminated team). These get 0 pts and a red ✗ in the UI.
  const koChainInvalid = [];

  // Group stage
  for (const [matchId, prediction] of groupsPredictions) {
    const result = results.get(matchId);
    if (!result || result.status !== 'completed') continue;
    const actual = deriveWinner(result);
    const correct = actual !== null && prediction === actual;
    const pts = correct ? POINTS.group : 0;
    total += pts;
    if (pts > 0) breakdown[matchId] = pts;
  }

  // Knockout
  for (const [matchId, prediction] of knockoutPredictions) {
    const result = results.get(matchId);
    if (!result || result.status !== 'completed') continue;
    const actual = deriveWinner(result);
    const round = matchRound(matchId);
    if (!round) continue;
    const sideCorrect = actual !== null && prediction === actual;
    const chainValid = !sideCorrect || isPredictionValid(matchId, prediction, knockoutPredictions, bracket);
    const correct = sideCorrect && chainValid;
    if (sideCorrect && !chainValid) koChainInvalid.push(matchId);
    const pts = correct ? (POINTS[round] || 0) : 0;
    total += pts;
    if (pts > 0) breakdown[matchId] = pts;
  }

  return { total, breakdown, koChainInvalid };
}

// ---------------------------------------------------------------------------
// Tiebreaker resolution
// ---------------------------------------------------------------------------

function sortLeaderboard(entries, finalResult) {
  const actualGoals = finalResult
    ? (finalResult.home_score ?? 0) + (finalResult.away_score ?? 0)
    : null;

  return entries.sort((a, b) => {
    // 1. Higher score
    if (b.score !== a.score) return b.score - a.score;
    // 2. Closest tiebreaker guess
    if (actualGoals !== null) {
      const aTb = a.tiebreaker_goals;
      const bTb = b.tiebreaker_goals;
      if (aTb !== null && bTb !== null) {
        const aDiff = Math.abs(aTb - actualGoals);
        const bDiff = Math.abs(bTb - actualGoals);
        if (aDiff !== bDiff) return aDiff - bDiff;
      } else if (aTb !== null) return -1;
      else if (bTb !== null) return 1;
    }
    // 3. Submitted any answer > none
    if (a.tiebreaker_goals !== null && b.tiebreaker_goals === null) return -1;
    if (b.tiebreaker_goals !== null && a.tiebreaker_goals === null) return 1;
    // 4. Alphabetical
    return a.username.localeCompare(b.username);
  });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleGetScores(request, env, session) {
  // Load groups.yaml, results.yaml, all prediction files
  const [groupsFile, resultsFile, predFiles] = await Promise.all([
    githubGet('data/groups.yaml', env),
    githubGet('data/results.yaml', env),
    listDirectory('data/predictions', env),
  ]);

  if (!groupsFile) {
    return new Response(JSON.stringify({ error: 'groups.yaml not found' }), { status: 500 });
  }

  const groupsData = parseGroupsYaml(groupsFile.content);
  const { last_updated, matches: results } = resultsFile
    ? parseResultsYaml(resultsFile.content)
    : { last_updated: null, matches: new Map() };

  // Calculate group standings from actual results only
  const groupStandings = new Map();
  for (const [letter, data] of groupsData) {
    groupStandings.set(letter, calcStandings(data, results));
  }

  // Use actual standings for bracket display only after group stage is fully complete.
  const hasActualResults = Date.now() >= KO_RESULTS_DATE.getTime();

  // For bracket display: use actual standings post-group-stage, otherwise use defaults
  let bracketStandings = groupStandings;
  if (!hasActualResults) {
    // Pre-tournament: derive bracket from default predictions
    const defaultsGroupFile = await githubGet('data/predictions/defaults-groups.yaml', env);
    const defaultGroupPreds = defaultsGroupFile
      ? parsePredictionYaml(defaultsGroupFile.content).predictions
      : new Map();
    
    // Calculate standings using defaults
    bracketStandings = new Map();
    for (const [letter, data] of groupsData) {
      // Create a fake results map with synthetic results based on defaults
      const syntheticResults = new Map();
      for (const match of data.matches) {
        const pred = defaultGroupPreds.get(match.id);
        if (pred) {
          syntheticResults.set(match.id, {
            status: 'completed',
            home_score: pred === 'home' ? 1 : pred === 'away' ? 0 : 0,
            away_score: pred === 'away' ? 1 : pred === 'home' ? 0 : 0,
            winner: pred,
          });
        }
      }
      bracketStandings.set(letter, calcStandings(data, syntheticResults));
    }
  }

  // Build bracket using actual or default standings
  const bracket = buildBracket(bracketStandings, results);

  // Load all user prediction files
  // Derive usernames from either -groups.yaml or -knockout.yaml so users who have
  // only saved one type of prediction still appear on the leaderboard.
  const userFiles = predFiles.filter(f => !f.startsWith('defaults-'));
  const groupsUsernames = [...new Set([
    ...userFiles.filter(f => f.endsWith('-groups.yaml')).map(f => f.replace('-groups.yaml', '')),
    ...userFiles.filter(f => f.endsWith('-knockout.yaml')).map(f => f.replace('-knockout.yaml', '')),
  ])];

  // Fetch defaults once (not once per user) to stay within the CF subrequest limit.
  // Total subrequests: 3 (initial) + 1 (defaults-groups, already fetched above if
  // !hasActualResults) + 1 (defaults-knockout) + 2×N (user files) = 4 + 2N.
  // Safe up to 23 users on the Free plan (limit 50); 4,998 on Paid (limit 10,000).
  const [dgFile, dkFile] = await Promise.all([
    githubGet('data/predictions/defaults-groups.yaml', env),
    githubGet('data/predictions/defaults-knockout.yaml', env),
  ]);
  const defaults_g = dgFile ? parsePredictionYaml(dgFile.content) : { predictions: new Map() };
  const defaults_k = dkFile ? parsePredictionYaml(dkFile.content) : { predictions: new Map() };

  // Fetch all user files in one parallel batch (2 requests per user).
  const userFilePairs = await Promise.all(
    groupsUsernames.flatMap(username => [
      githubGet(`data/predictions/${username}-groups.yaml`, env),
      githubGet(`data/predictions/${username}-knockout.yaml`, env),
    ])
  );

  const leaderboard = [];

  for (let i = 0; i < groupsUsernames.length; i++) {
    const username = groupsUsernames[i];
    const gFile = userFilePairs[i * 2];
    const kFile = userFilePairs[i * 2 + 1];

    const user_g = gFile ? parsePredictionYaml(gFile.content) : { predictions: new Map() };
    const user_k = kFile ? parsePredictionYaml(kFile.content) : { predictions: new Map(), tiebreaker_goals: null };

    // Merge: user picks override defaults
    const merged_g = new Map([...defaults_g.predictions, ...user_g.predictions]);
    const merged_k = new Map([...defaults_k.predictions, ...user_k.predictions]);

    const { total, breakdown, koChainInvalid } = scoreUser(username, merged_g, merged_k, results, bracket);

    leaderboard.push({
      username,
      score: total,
      tiebreaker_goals: user_k.tiebreaker_goals ?? null,
      ...(username === session?.username && { breakdown, ko_chain_invalid: koChainInvalid }),
    });
  }

  const finalResult = results.get('FINAL') || null;
  sortLeaderboard(leaderboard, finalResult);

  // Add rank
  leaderboard.forEach((e, i) => { e.rank = i + 1; });

  // Check if third-place match is locked (both SFs complete)
  const sf1Done = results.get('SF_101')?.status === 'completed';
  const sf2Done = results.get('SF_102')?.status === 'completed';
  const thirdLocked = sf1Done && sf2Done;

  // Build fixtures map: group letter → array of match objects (for UI rendering)
  const fixtures = {};
  for (const [letter, data] of groupsData) {
    fixtures[letter] = data.matches.map(m => ({
      id:         m.id,
      home:       m.home,
      away:       m.away,
      home_abbr:  m.home_abbr,
      away_abbr:  m.away_abbr,
      date:       m.date,
      kickoff_utc: m.kickoff_utc,
    }));
  }

  // Annotate standings with hasResults so the UI knows whether to show
  // qualification highlights (green = actual) vs not at all (pre-tournament)
  const standingsOut = {};
  for (const [g, s] of groupStandings.entries()) {
    const hasResults = s.some(t => t.played > 0);
    standingsOut[g] = { teams: s, hasResults };
  }

  // Serialize match results for client-side overlay (status + winner per match)
  const matchResults = {};
  for (const [id, r] of results.entries()) {
    matchResults[id] = {
      status:     r.status,
      home_score: r.home_score,
      away_score: r.away_score,
      winner:     r.winner || deriveWinner(r),
    };
  }

  return new Response(JSON.stringify({
    last_updated,
    leaderboard,
    standings: standingsOut,
    fixtures,
    match_results: matchResults,
    bracket: Object.fromEntries(
      [...bracket.entries()].map(([id, m]) => [id, m])
    ),
    locks: {
      third_place: thirdLocked,
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
