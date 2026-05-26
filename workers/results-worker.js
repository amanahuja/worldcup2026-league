/**
 * results-worker.js
 *
 * Cloudflare Cron trigger — runs every hour.
 * Fetches match results from OpenLigaDB and writes normalized results.yaml to GitHub.
 *
 * Key findings from schema verification (2026-05-26):
 *   - /getmatchdata/wm26/2026 returns group stage (72 matches); groupOrderIDs 1–3
 *   - Knockout matches fetched by groupOrderID 4–8 once available
 *   - Team names are in German — mapped to English via TEAM_NAME_MAP below
 *   - matchDateTimeUTC field is available and correct
 *   - matchResults[resultTypeID=2] = full-time score (incl. extra time)
 *   - Penalty goals: goals[].isPenalty=true — shootout goals counted to identify penalty match
 *   - /getlastchangedate/wm26/2026 returns bare ISO string e.g. "2026-04-01T18:17:55.76"
 *
 * Bindings required:
 *   WC2026_USERS   — KV namespace (also stores RESULTS_LAST_CHANGED key)
 *   GITHUB_TOKEN   — Worker secret
 *   GITHUB_REPO    — e.g. "amanahuja/worldcup2026-league"
 *   GITHUB_BRANCH  — e.g. "main"
 */

const OPENLIGADB_BASE = 'https://api.openligadb.de';
const LEAGUE = 'wm26';
const SEASON = '2026';
const KV_LAST_CHANGED_KEY = 'RESULTS_LAST_CHANGED';

// groupOrderIDs: 1–3 = group stage matchdays, 4 = R32, 5 = R16, 6 = QF, 7 = SF, 8 = Final
// Note: OpenLigaDB doesn't expose a separate third-place groupOrderID; it may appear in groupOrderID 8
// or as a separate entry. Monitor during development.
const GROUP_ORDER_IDS = [1, 2, 3, 4, 5, 6, 7, 8];

// ---------------------------------------------------------------------------
// German → English team name mapping
// ---------------------------------------------------------------------------

const TEAM_NAME_MAP = {
  'Algerien':                    'Algeria',
  'Argentinien':                 'Argentina',
  'Australien':                  'Australia',
  'Belgien':                     'Belgium',
  'Bosnien und Herzegowina':     'Bosnia & Herzegovina',
  'Brasilien':                   'Brazil',
  'Curaçao':                     'Curaçao',
  'DR Kongo':                    'DR Congo',
  'Deutschland':                 'Germany',
  'Ecuador':                     'Ecuador',
  'Elfenbeinküste':              'Ivory Coast',
  'England':                     'England',
  'Frankreich':                  'France',
  'Ghana':                       'Ghana',
  'Haiti':                       'Haiti',
  'Irak':                        'Iraq',
  'Iran':                        'Iran',
  'Japan':                       'Japan',
  'Jordanien':                   'Jordan',
  'Kanada':                      'Canada',
  'Kap Verde':                   'Cape Verde',
  'Katar':                       'Qatar',
  'Kolumbien':                   'Colombia',
  'Kroatien':                    'Croatia',
  'Marokko':                     'Morocco',
  'Mexiko':                      'Mexico',
  'Neuseeland':                  'New Zealand',
  'Niederlande':                 'Netherlands',
  'Norwegen':                    'Norway',
  'Panama':                      'Panama',
  'Paraguay':                    'Paraguay',
  'Portugal':                    'Portugal',
  'Saudi Arabien':               'Saudi Arabia',
  'Schottland':                  'Scotland',
  'Schweden':                    'Sweden',
  'Schweiz':                     'Switzerland',
  'Senegal':                     'Senegal',
  'Spanien':                     'Spain',
  'Südafrika':                   'South Africa',
  'Südkorea':                    'South Korea',
  'Tschechien':                  'Czech Republic',
  'Tunesien':                    'Tunisia',
  'Türkei':                      'Turkey',
  'USA':                         'USA',
  'Uruguay':                     'Uruguay',
  'Usbekistan':                  'Uzbekistan',
  'Ägypten':                     'Egypt',
  'Österreich':                  'Austria',
};

function toEnglish(name) {
  return TEAM_NAME_MAP[name] || name;
}

// ---------------------------------------------------------------------------
// GitHub helpers (duplicated from predictions-worker for self-contained module)
// ---------------------------------------------------------------------------

function githubHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'worldcup2026-league-worker',
  };
}

async function githubGet(path, env) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}?ref=${env.GITHUB_BRANCH}`;
  const res = await fetch(url, { headers: githubHeaders(env.GITHUB_TOKEN) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status}`);
  const json = await res.json();
  return { content: atob(json.content.replace(/\n/g, '')), sha: json.sha };
}

async function githubPut(path, content, sha, env) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`;
  const body = {
    message: `chore: update ${path} [cron]`,
    content: btoa(unescape(encodeURIComponent(content))),
    branch: env.GITHUB_BRANCH,
    ...(sha ? { sha } : {}),
  };
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...githubHeaders(env.GITHUB_TOKEN), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub PUT ${path} failed: ${res.status}`);
}

// ---------------------------------------------------------------------------
// Build match ID → fixture lookup from groups.yaml
// ---------------------------------------------------------------------------

/**
 * Minimal groups.yaml parser to extract home/away team pairs → match ID mapping.
 * Returns: Map<`${homeEnglish}|${awayEnglish}` → matchId>
 */
function buildFixtureLookup(groupsYaml) {
  const lookup = new Map();
  let currentMatchId = null;
  let homeTeam = null;

  for (const raw of groupsYaml.split('\n')) {
    const line = raw.trim();
    const idMatch = line.match(/^-\s+id:\s+([\w_]+)/);
    if (idMatch) { currentMatchId = idMatch[1]; homeTeam = null; continue; }

    const homeMatch = line.match(/^home:\s+(.+)$/);
    if (homeMatch && currentMatchId) { homeTeam = homeMatch[1].trim(); continue; }

    const awayMatch = line.match(/^away:\s+(.+)$/);
    if (awayMatch && currentMatchId && homeTeam) {
      const awayTeam = awayMatch[1].trim();
      lookup.set(`${homeTeam}|${awayTeam}`, currentMatchId);
      homeTeam = null;
    }
  }
  return lookup;
}

// ---------------------------------------------------------------------------
// Normalise a single OpenLigaDB match object → results.yaml entry
// ---------------------------------------------------------------------------

function normalizeMatch(m, fixtureLookup) {
  const homeEn = toEnglish(m.team1.teamName);
  const awayEn = toEnglish(m.team2.teamName);
  const matchId = fixtureLookup.get(`${homeEn}|${awayEn}`);

  // For knockout matches the fixture lookup won't have the ID yet — use a generated ID
  const id = matchId || `KO_${m.matchID}`;

  const status = m.matchIsFinished ? 'completed' : 'scheduled';

  let homeScore = null;
  let awayScore = null;
  if (m.matchIsFinished && m.matchResults?.length) {
    const ft = m.matchResults.find(r => r.resultTypeID === 2);
    if (ft) {
      homeScore = ft.pointsTeam1;
      awayScore = ft.pointsTeam2;
    }
  }

  // Detect penalty shootout: any goal with isPenalty=true scored after the match is finished
  // and scores are equal at full time (extra time result).
  // Penalty shootout goals appear as isPenalty:true in the goals array.
  let homePen = null;
  let awayPen = null;
  if (m.matchIsFinished && m.goals?.length) {
    const penGoals = m.goals.filter(g => g.isPenalty);
    if (penGoals.length > 0) {
      // Last penalty goal gives final shootout score
      const last = penGoals[penGoals.length - 1];
      homePen = last.scoreTeam1;
      awayPen = last.scoreTeam2;
    }
  }

  // Derive winner (may be overridden by admin via `winner` field in existing results.yaml)
  let winner = null;
  if (status === 'completed' && homeScore !== null) {
    if (homeScore > awayScore) winner = 'home';
    else if (awayScore > homeScore) winner = 'away';
    else if (homePen !== null) winner = homePen > awayPen ? 'home' : 'away';
    else winner = 'draw';
  }

  return { id, status, homeScore, awayScore, homePen, awayPen, winner };
}

// ---------------------------------------------------------------------------
// Serialise results to YAML
// ---------------------------------------------------------------------------

function serializeResultsYaml(lastUpdated, matches, existingEntries) {
  // existingEntries: Map<matchId → existing entry> — preserves admin `winner` overrides
  let yaml = `last_updated: "${lastUpdated}"\nmatches:\n`;

  for (const [id, m] of matches) {
    const existing = existingEntries?.get(id);
    // If admin has set a `winner` override, preserve it
    const winner = existing?.winner_override || m.winner;
    yaml += `  ${id}:\n`;
    yaml += `    status: ${m.status}\n`;
    yaml += `    home_score: ${m.homeScore === null ? 'null' : m.homeScore}\n`;
    yaml += `    away_score: ${m.awayScore === null ? 'null' : m.awayScore}\n`;
    yaml += `    home_pen: ${m.homePen === null ? 'null' : m.homePen}\n`;
    yaml += `    away_pen: ${m.awayPen === null ? 'null' : m.awayPen}\n`;
    if (winner !== null) {
      yaml += `    winner: ${winner}\n`;
    }
  }
  return yaml;
}

// ---------------------------------------------------------------------------
// Parse existing results.yaml to extract admin winner overrides
// ---------------------------------------------------------------------------

function parseExistingResults(yaml) {
  const entries = new Map();
  let currentId = null;
  let winnerOverride = null;
  let hasExplicitWinner = false;

  for (const raw of yaml.split('\n')) {
    const line = raw.trim();
    const idMatch = line.match(/^([\w_]+):\s*$/);
    if (idMatch && idMatch[1] !== 'matches') {
      if (currentId && hasExplicitWinner) {
        entries.set(currentId, { winner_override: winnerOverride });
      }
      currentId = idMatch[1];
      winnerOverride = null;
      hasExplicitWinner = false;
      continue;
    }
    if (currentId && line.startsWith('winner:')) {
      winnerOverride = line.replace('winner:', '').trim();
      hasExplicitWinner = true;
    }
  }
  if (currentId && hasExplicitWinner) {
    entries.set(currentId, { winner_override: winnerOverride });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Main cron handler
// ---------------------------------------------------------------------------

export async function handleScheduled(env) {
  // 1. Check last change date
  let lastChangedStr;
  try {
    const res = await fetch(
      `${OPENLIGADB_BASE}/getlastchangedate/${LEAGUE}/${SEASON}`,
      { headers: { 'User-Agent': 'worldcup2026-league-worker' } },
    );
    if (!res.ok) throw new Error(`getlastchangedate HTTP ${res.status}`);
    lastChangedStr = (await res.text()).replace(/"/g, '').trim();
  } catch (e) {
    console.error('OpenLigaDB getlastchangedate failed:', e.message);
    return; // silent failure — retain last good results.yaml
  }

  const prevChanged = await env.WC2026_USERS.get(KV_LAST_CHANGED_KEY);
  if (prevChanged === lastChangedStr) {
    console.log('No change since', lastChangedStr, '— skipping');
    return;
  }

  // 2. Fetch all matches (group stage + knockout as available)
  const allMatches = [];
  for (const groupOrderId of GROUP_ORDER_IDS) {
    try {
      const res = await fetch(
        `${OPENLIGADB_BASE}/getmatchdata/${LEAGUE}/${SEASON}/${groupOrderId}`,
        { headers: { 'User-Agent': 'worldcup2026-league-worker' } },
      );
      if (!res.ok) continue;
      const batch = await res.json();
      allMatches.push(...batch);
    } catch {
      // skip this group order on error
    }
  }

  if (!allMatches.length) {
    console.error('No matches returned from OpenLigaDB — skipping write');
    return;
  }

  // 3. Load fixture lookup from groups.yaml
  let fixtureLookup = new Map();
  try {
    const groupsFile = await githubGet('data/groups.yaml', env);
    if (groupsFile) fixtureLookup = buildFixtureLookup(groupsFile.content);
  } catch (e) {
    console.error('Failed to load groups.yaml:', e.message);
  }

  // 4. Load existing results.yaml to preserve admin winner overrides
  let existingEntries = new Map();
  let existingSha = null;
  try {
    const existing = await githubGet('data/results.yaml', env);
    if (existing) {
      existingSha = existing.sha;
      existingEntries = parseExistingResults(existing.content);
    }
  } catch {
    // file may not exist yet on first run
  }

  // 5. Normalize matches
  const normalized = new Map();
  for (const m of allMatches) {
    const entry = normalizeMatch(m, fixtureLookup);
    normalized.set(entry.id, entry);
  }

  // 6. Serialise and write to GitHub
  const nowUtc = new Date().toISOString();
  const yaml = serializeResultsYaml(nowUtc, normalized, existingEntries);

  try {
    await githubPut('data/results.yaml', yaml, existingSha, env);
    await env.WC2026_USERS.put(KV_LAST_CHANGED_KEY, lastChangedStr);
    console.log('results.yaml updated at', nowUtc);
  } catch (e) {
    console.error('Failed to write results.yaml to GitHub:', e.message);
  }
}
