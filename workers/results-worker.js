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
// ---------------------------------------------------------------------------
// Knockout match lookup: English team-name pair → bracket slot ID.
//
// Group stage matches are resolved via buildFixtureLookup() against groups.yaml
// (also team-name based). For knockout matches there is no fixture file, so we
// maintain this explicit map.
//
// Keys are "HomeTeam|AwayTeam" using English names (same as TEAM_NAME_MAP output).
// OpenLigaDB numeric matchIDs are intentionally NOT used — they have been observed
// to change between API updates (e.g. R32_76 was matchID 82100, then became 83124),
// making them an unreliable key. Team names are stable.
//
// HOW TO UPDATE before each new round:
//   1. After R16/QF/SF results are in, identify which teams play each next-round match.
//   2. Add an entry: 'HomeTeam|AwayTeam': 'BRACKET_ID'
//      Home/away order must match what OpenLigaDB returns — verify with:
//      curl https://api.openligadb.de/getmatchdata/wm26/2026/{groupOrderID}
//      and translate German names via TEAM_NAME_MAP (or check .agents/openligadb-match-id-map.md).
//   3. groupOrderID reference: 4=R32, 5=R16, 6=QF, 7=SF, 8=Final+3rd
//   4. After the next cron run, check results.yaml for any KO_* entries — these
//      indicate a team name is missing from this map or from TEAM_NAME_MAP.
// ---------------------------------------------------------------------------
const KO_TEAM_NAME_MAP = {
  // R32 — verified 2026-06-29
  'South Africa|Canada':           'R32_73',
  'Germany|Paraguay':              'R32_74',
  'Netherlands|Morocco':           'R32_75',
  'Brazil|Japan':                  'R32_76',
  'France|Sweden':                 'R32_77',
  'Ivory Coast|Norway':            'R32_78',
  'Mexico|Ecuador':                'R32_79',
  'England|DR Congo':              'R32_80',
  'USA|Bosnia & Herzegovina':      'R32_81',
  'Belgium|Senegal':               'R32_82',
  'Portugal|Croatia':              'R32_83',
  'Spain|Austria':                 'R32_84',
  'Switzerland|Algeria':           'R32_85',
  'Argentina|Cape Verde':          'R32_86',
  'Colombia|Ghana':                'R32_87',
  'Australia|Egypt':               'R32_88',
  // R16 — verified 2026-07-03
  'Canada|Morocco':                'R16_90',
  'Paraguay|France':               'R16_89',
  'Brazil|Norway':                 'R16_91',
  'Mexico|England':                'R16_92',
  'Portugal|Spain':                'R16_93',
  'USA|Belgium':                   'R16_94',
  'Argentina|Egypt':               'R16_95',
  'Switzerland|Colombia':          'R16_96',
  // QF — verified 2026-07-06/2026-07-13 (groupOrderID 6)
  'France|Morocco':            'QF_97',
  'Spain|Belgium':             'QF_98',
  'Norway|England':            'QF_99',
  'Argentina|Switzerland':     'QF_100',
  // SF — verified 2026-07-13 (groupOrderID 7)
  'France|Spain':              'SF_101',
  'England|Argentina':         'SF_102',
  // Final, 3rd — add entries once SF results are in (groupOrderID 8)
};

// Group stage ended 2026-06-28T04:00Z (2h buffer after last whistle).
// After this point, skip re-fetching groupOrderIDs 1–3 to prevent
// cron runs from overwriting manually-corrected group stage results.
const GROUP_STAGE_END = new Date('2026-06-28T04:00:00Z');

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
// GitHub helpers
// ---------------------------------------------------------------------------

import { githubGet, githubPut } from './github.js';

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

  // Group stage: resolved by fixture lookup (team names from groups.yaml).
  // Knockout: resolved by KO_TEAM_NAME_MAP (English team-name pair).
  // Last resort KO_<matchID> means a team name is missing — add it to KO_TEAM_NAME_MAP.
  const koByName = KO_TEAM_NAME_MAP[`${homeEn}|${awayEn}`];
  let id;
  if (matchId) {
    id = matchId;
  } else if (koByName) {
    id = koByName;
  } else {
    id = `KO_${m.matchID}`;
    console.warn(`Unknown KO match: ${homeEn} vs ${awayEn} (matchID=${m.matchID}) — add to KO_TEAM_NAME_MAP in results-worker.js`);
  }

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

  // Detect penalty shootout: only relevant for knockout matches where scores
  // are level at full time. OpenLigaDB provides a dedicated resultTypeID=5
  // ("nach Elfmeterschießen") entry in matchResults with the shootout score.
  // Group stage never has shootouts — guard with groupOrderID check.
  let homePen = null;
  let awayPen = null;
  const isKnockout = m.group?.groupOrderID >= 4;
  if (isKnockout && m.matchIsFinished && homeScore !== null && homeScore === awayScore && m.matchResults?.length) {
    const shootout = m.matchResults.find(r => r.resultTypeID === 5);
    if (shootout) {
      homePen = shootout.pointsTeam1;
      awayPen = shootout.pointsTeam2;
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
// Parse existing results.yaml
// Returns Map<matchId → { status, homeScore, awayScore, homePen, awayPen, winner, winner_override }>
// winner_override is set when a `winner` field is explicitly present (used to
// preserve admin corrections). Full entry data is needed so that locked group
// stage entries can be carried forward into the serialized output unchanged.
// ---------------------------------------------------------------------------

function parseExistingResults(yaml) {
  const entries = new Map();
  let currentId = null;
  let current = null;

  const finalize = () => {
    if (currentId && current) {
      // winner_override mirrors winner — signals that an explicit winner is on file
      if (current.winner !== null) current.winner_override = current.winner;
      entries.set(currentId, current);
    }
  };

  for (const raw of yaml.split('\n')) {
    const line = raw.trim();
    const idMatch = line.match(/^([\w_]+):\s*$/);
    if (idMatch && idMatch[1] !== 'matches') {
      finalize();
      currentId = idMatch[1];
      current = { status: null, homeScore: null, awayScore: null, homePen: null, awayPen: null, winner: null, winner_override: null };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('status:'))     current.status    = line.replace('status:', '').trim();
    if (line.startsWith('home_score:')) { const v = line.replace('home_score:', '').trim(); current.homeScore = v === 'null' ? null : Number(v); }
    if (line.startsWith('away_score:')) { const v = line.replace('away_score:', '').trim(); current.awayScore = v === 'null' ? null : Number(v); }
    if (line.startsWith('home_pen:'))   { const v = line.replace('home_pen:', '').trim();   current.homePen   = v === 'null' ? null : Number(v); }
    if (line.startsWith('away_pen:'))   { const v = line.replace('away_pen:', '').trim();   current.awayPen   = v === 'null' ? null : Number(v); }
    if (line.startsWith('winner:'))     { current.winner = line.replace('winner:', '').trim(); }
  }
  finalize();
  return entries;
}

// ---------------------------------------------------------------------------
// Main cron handler
// ---------------------------------------------------------------------------

export async function handleScheduled(env) {
  // 1. Check last change date across all group order IDs (endpoint requires a groupOrderID).
  //    Take the most recent timestamp among all IDs for change detection.
  const timestamps = [];
  for (const groupOrderId of GROUP_ORDER_IDS) {
    try {
      const res = await fetch(
        `${OPENLIGADB_BASE}/getlastchangedate/${LEAGUE}/${SEASON}/${groupOrderId}`,
        { headers: { 'User-Agent': 'worldcup2026-league-worker' } },
      );
      if (!res.ok) continue;
      const ts = (await res.text()).replace(/"/g, '').trim();
      if (ts) timestamps.push(ts);
    } catch {
      // skip this group order
    }
  }

  if (!timestamps.length) {
    console.error('OpenLigaDB getlastchangedate returned no data — skipping');
    return;
  }

  // ISO strings sort lexicographically, so max() gives the most recent timestamp
  const lastChangedStr = timestamps.sort().at(-1);

  const prevChanged = await env.WC2026_USERS.get(KV_LAST_CHANGED_KEY);
  if (prevChanged === lastChangedStr) {
    console.log('No change since', lastChangedStr, '— skipping');
    return;
  }

  // 2. Fetch all matches (group stage + knockout as available)
  // Skip groupOrderIDs 1–3 after the group stage is complete to prevent
  // cron runs from overwriting manually-corrected results.
  const groupStageLocked = Date.now() >= GROUP_STAGE_END.getTime();
  const activeGroupOrderIds = groupStageLocked
    ? GROUP_ORDER_IDS.filter(id => id >= 4)
    : GROUP_ORDER_IDS;

  const allMatches = [];
  for (const groupOrderId of activeGroupOrderIds) {
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
  let normalized = new Map();
  for (const m of allMatches) {
    const entry = normalizeMatch(m, fixtureLookup);
    normalized.set(entry.id, entry);
  }

  // 5b. When the group stage is locked we only fetched knockout matches above.
  // Carry forward all G_* entries from the existing results.yaml so they are
  // not dropped from the serialized output. Build a reordered map so that G_*
  // entries appear first (preserving readability of results.yaml on each cron write).
  if (groupStageLocked) {
    const reordered = new Map();
    for (const [id, entry] of existingEntries) {
      if (id.startsWith('G_')) {
        reordered.set(id, {
          id,
          status:    entry.status,
          homeScore: entry.homeScore,
          awayScore: entry.awayScore,
          homePen:   entry.homePen,
          awayPen:   entry.awayPen,
          winner:    entry.winner,
        });
      }
    }
    for (const [id, entry] of normalized) {
      reordered.set(id, entry);
    }
    normalized = reordered;
  }

  // 6. Serialise and write to GitHub
  const nowUtc = new Date().toISOString();
  const yaml = serializeResultsYaml(nowUtc, normalized, existingEntries);

  try {
    await githubPut('data/results.yaml', yaml, existingSha, env, `wc2026[cron]: update results.yaml at ${nowUtc}`);
    await env.WC2026_USERS.put(KV_LAST_CHANGED_KEY, lastChangedStr);
    console.log('results.yaml updated at', nowUtc);
  } catch (e) {
    console.error('Failed to write results.yaml to GitHub:', e.message);
  }
}
