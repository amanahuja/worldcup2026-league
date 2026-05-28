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

function parseResultsYaml(text) {
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

function parsePredictionYaml(text) {
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
 * Calculate group standings from actual results, falling back to predictions
 * for any match that has not yet been played.
 *
 * For unplayed matches, predicted_winner ('home'/'away'/'draw') is used as a
 * synthetic 1-0 win or 0-0 draw so the existing points/GD sort works correctly.
 * This ensures the bracket always shows the teams a user predicted to advance,
 * even before the tournament starts.
 *
 * @param {object} groupData   - { teams, matches }
 * @param {Map}    results     - actual match results from results.yaml
 * @param {Map}    predictions - default+user merged group predictions (matchId → 'home'|'away'|'draw')
 */
function calcStandings(groupData, results, predictions = new Map()) {
  const stats = {};
  for (const team of groupData.teams) {
    stats[team] = { team, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, pts: 0 };
  }

  for (const match of groupData.matches) {
    const result = results.get(match.id);
    const home = stats[match.home];
    const away = stats[match.away];
    if (!home || !away) continue;

    let winner, hs, as_;

    if (result && result.status === 'completed') {
      // Use actual result
      winner = result.winner || deriveWinner(result);
      hs  = result.home_score ?? 0;
      as_ = result.away_score ?? 0;
    } else {
      // Fall back to prediction; use synthetic 1-0 / 0-0 score for GD ordering
      const pred = predictions.get(match.id);
      if (!pred) continue; // no prediction either — skip
      winner = pred;
      hs  = pred === 'home' ? 1 : pred === 'away' ? 0 : 0;
      as_ = pred === 'away' ? 1 : pred === 'home' ? 0 : 0;
    }

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

function deriveWinner(result) {
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

/**
 * Best third-place teams selection:
 * After all groups finish, rank all 12 third-placed teams, take top 8.
 * Returns array of team names sorted best→worst.
 */
function selectBestThirds(groupStandings) {
  const thirds = [];
  for (const [group, standings] of groupStandings) {
    if (standings.length >= 3) {
      const t = standings[2];
      thirds.push({ ...t, group });
    }
  }
  thirds.sort((a, b) => {
    if (b.pts !== a.pts) return b.pts - a.pts;
    const gdA = a.gf - a.ga, gdB = b.gf - b.ga;
    if (gdB !== gdA) return gdB - gdA;
    if (b.gf !== a.gf) return b.gf - a.gf;
    return a.team.localeCompare(b.team);
  });
  return thirds.slice(0, 8).map(t => t.team);
}

/**
 * Resolve a slot label to a team name.
 * Slots like "1A" → winner of group A.
 * Slots like "3ABCDF" → best third from those groups (index 0 in sorted thirds).
 */
function resolveSlot(slot, groupStandings, bestThirds) {
  if (slot.startsWith('1')) {
    const g = slot.slice(1);
    return groupStandings.get(g)?.[0]?.team || null;
  }
  if (slot.startsWith('2')) {
    const g = slot.slice(1);
    return groupStandings.get(g)?.[1]?.team || null;
  }
  if (slot.startsWith('3')) {
    // The groups listed after "3" indicate which groups' third-place teams are eligible
    // for this slot. FIFA assigns the best third to specific slots based on which groups
    // they come from. For simplicity we assign them in ranked order to the R32 slots
    // that reference 3rd-placed teams, after the group stage is complete.
    // This is resolved in buildBracket below.
    return null; // placeholder — resolved in buildBracket
  }
  return null;
}

/**
 * Build the full bracket: resolve all team slots and derive round-by-round winners.
 * Returns a Map<matchId → { home, away, winner, status }>
 */
function buildBracket(groupStandings, results) {
  const bracket = new Map();

  // Resolve group winners and runners-up into R32 slots
  const bestThirds = selectBestThirds(groupStandings);
  let thirdIdx = 0;

  for (const m of R32_BRACKET) {
    const [s1, s2] = m.slots;
    let home, away;
    if (s1.startsWith('3')) { home = bestThirds[thirdIdx++] || null; }
    else { home = resolveSlot(s1, groupStandings, bestThirds); }
    if (s2.startsWith('3')) { away = bestThirds[thirdIdx++] || null; }
    else { away = resolveSlot(s2, groupStandings, bestThirds); }

    const result = results.get(m.id);
    const winner = result?.status === 'completed' ? deriveWinner(result) : null;
    const winningTeam = winner === 'home' ? home : winner === 'away' ? away : null;
    bracket.set(m.id, { home, away, winner, winningTeam, status: result?.status || 'scheduled' });
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
      bracket.set(m.id, { home, away, winner, winningTeam, status: result?.status || 'scheduled' });
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
  });

  return bracket;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scoreUser(username, groupsPredictions, knockoutPredictions, results, bracket) {
  let total = 0;
  const breakdown = {};

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
    const correct = actual !== null && prediction === actual;
    const round = matchRound(matchId);
    if (!round) continue;
    const pts = correct ? (POINTS[round] || 0) : 0;
    total += pts;
    if (pts > 0) breakdown[matchId] = pts;
  }

  return { total, breakdown };
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

  // Load default group predictions to use as fallback for unplayed matches
  const defaultsGroupFile = await githubGet('data/predictions/defaults-groups.yaml', env);
  const defaultGroupPreds = defaultsGroupFile
    ? parsePredictionYaml(defaultsGroupFile.content).predictions
    : new Map();

  // Calculate group standings, falling back to default predictions for unplayed matches
  const groupStandings = new Map();
  for (const [letter, data] of groupsData) {
    groupStandings.set(letter, calcStandings(data, results, defaultGroupPreds));
  }

  // Build bracket
  const bracket = buildBracket(groupStandings, results);

  // Load all user prediction files
  // Derive usernames from either -groups.yaml or -knockout.yaml so users who have
  // only saved one type of prediction still appear on the leaderboard.
  const userFiles = predFiles.filter(f => !f.startsWith('defaults-'));
  const groupsUsernames = [...new Set([
    ...userFiles.filter(f => f.endsWith('-groups.yaml')).map(f => f.replace('-groups.yaml', '')),
    ...userFiles.filter(f => f.endsWith('-knockout.yaml')).map(f => f.replace('-knockout.yaml', '')),
  ])];

  const leaderboard = [];

  for (const username of groupsUsernames) {
    const [gFile, kFile, dgFile, dkFile] = await Promise.all([
      githubGet(`data/predictions/${username}-groups.yaml`, env),
      githubGet(`data/predictions/${username}-knockout.yaml`, env),
      githubGet('data/predictions/defaults-groups.yaml', env),
      githubGet('data/predictions/defaults-knockout.yaml', env),
    ]);

    const defaults_g = dgFile ? parsePredictionYaml(dgFile.content) : { predictions: new Map() };
    const defaults_k = dkFile ? parsePredictionYaml(dkFile.content) : { predictions: new Map() };
    const user_g     = gFile  ? parsePredictionYaml(gFile.content)  : { predictions: new Map() };
    const user_k     = kFile  ? parsePredictionYaml(kFile.content)  : { predictions: new Map(), tiebreaker_goals: null };

    // Merge: user picks override defaults
    const merged_g = new Map([...defaults_g.predictions, ...user_g.predictions]);
    const merged_k = new Map([...defaults_k.predictions, ...user_k.predictions]);

    const { total } = scoreUser(username, merged_g, merged_k, results, bracket);

    leaderboard.push({
      username,
      score: total,
      tiebreaker_goals: user_k.tiebreaker_goals ?? null,
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
