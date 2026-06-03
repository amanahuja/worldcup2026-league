'use strict';

// ---------------------------------------------------------------------------
// Bracket structure
// Left half feeds SF_101 (via QF_97 + QF_98)
// Right half feeds SF_102 (via QF_99 + QF_100)
//
// Left:  R32_74,77,73,75 → R16_89,90 → QF_97  \
//        R32_83,84,81,82 → R16_93,94 → QF_98  /  SF_101
// Right: R32_76,78,79,80 → R16_91,92 → QF_99  \
//        R32_86,88,85,87 → R16_95,96 → QF_100 /  SF_102
// ---------------------------------------------------------------------------

const HALF = {
  left: {
    r32: ['R32_74','R32_77', 'R32_73','R32_75', 'R32_83','R32_84', 'R32_81','R32_82'],
    r16: ['R16_89','R16_90','R16_93','R16_94'],
    qf:  ['QF_97','QF_98'],
    sf:  'SF_101',
  },
  right: {
    r32: ['R32_76','R32_78', 'R32_79','R32_80', 'R32_86','R32_88', 'R32_85','R32_87'],
    r16: ['R16_91','R16_92','R16_95','R16_96'],
    qf:  ['QF_99','QF_100'],
    sf:  'SF_102',
  },
};

// ---------------------------------------------------------------------------
// Abbreviations
// ---------------------------------------------------------------------------

const ABBR = {
  'Algeria':'ALG','Argentina':'ARG','Australia':'AUS','Austria':'AUT',
  'Belgium':'BEL','Bolivia':'BOL','Bosnia & Herzegovina':'BIH','Bosnia and Herzegovina':'BIH',
  'Brazil':'BRA','Burkina Faso':'BFA','Cameroon':'CMR','Canada':'CAN',
  'Chile':'CHI','China':'CHN','Colombia':'COL','Costa Rica':'CRC','Croatia':'CRO',
  'Czech Republic':'CZE','Denmark':'DEN','DR Congo':'COD','Ecuador':'ECU',
  'Egypt':'EGY','England':'ENG','France':'FRA','Georgia':'GEO','Germany':'GER',
  'Ghana':'GHA','Greece':'GRE','Honduras':'HON','Hungary':'HUN','Iceland':'ISL',
  'India':'IND','Indonesia':'IDN','Iran':'IRN','Iraq':'IRQ','Israel':'ISR',
  'Italy':'ITA','Ivory Coast':'CIV','Jamaica':'JAM','Japan':'JPN','Jordan':'JOR',
  'Kazakhstan':'KAZ','Kenya':'KEN','Kosovo':'KOS','Kuwait':'KUW','Latvia':'LAT',
  'Mexico':'MEX','Moldova':'MDA','Montenegro':'MNE','Morocco':'MAR',
  'Netherlands':'NED','New Zealand':'NZL','Nigeria':'NGA','North Korea':'PRK',
  'North Macedonia':'MKD','Norway':'NOR','Panama':'PAN','Paraguay':'PAR',
  'Peru':'PER','Poland':'POL','Portugal':'POR','Qatar':'QAT','Romania':'ROU',
  'Russia':'RUS','Saudi Arabia':'KSA','Senegal':'SEN','Serbia':'SRB',
  'Slovakia':'SVK','Slovenia':'SVN','South Africa':'RSA','South Korea':'KOR',
  'Spain':'ESP','Sweden':'SWE','Switzerland':'SUI','Syria':'SYR',
  'Trinidad & Tobago':'TRI','Tunisia':'TUN','Turkey':'TUR','Ukraine':'UKR',
  'Uruguay':'URU','USA':'USA','United States':'USA','Uzbekistan':'UZB',
  'Venezuela':'VEN','Wales':'WAL','Zambia':'ZAM','Zimbabwe':'ZIM',
  'Curaçao':'CUW',"Côte d'Ivoire":'CIV',
};

function displayName(name) {
  if (!name) return 'TBD';
  if (name.length <= 13) return name;
  return ABBR[name] || name.slice(0, 3).toUpperCase();
}

// ---------------------------------------------------------------------------
// Fetch + boot
// ---------------------------------------------------------------------------

async function init() {
  const params = new URLSearchParams(window.location.search);
  const user = params.get('user');
  if (!user) { showError('No user specified. Use ?user=username in the URL.'); return; }

  document.getElementById('picks-username').textContent = user;
  document.title = `${user} · WC2026 bracket picks`;

  try {
    const res = await fetch(`/api/picks/${encodeURIComponent(user)}`);
    if (res.status === 404) { showError(`User "${user}" not found.`); return; }
    if (!res.ok) { showError('Failed to load picks. Please try again.'); return; }
    const data = await res.json();
    document.getElementById('picks-username').textContent = data.username;
    renderBracket(data);
  } catch (e) {
    showError('Network error. Please try again.');
  }
}

function showError(msg) {
  document.getElementById('bracket-loading').classList.add('hidden');
  const el = document.getElementById('picks-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Bracket table — row-by-row builder with rowspan tracker
//
// Column layout (33 columns, 0-indexed):
//
//  LEFT SIDE (cols 0–15):
//   0: R32 team   1: R32 score   2: R32 conn   3: gap
//   4: R16 team   5: R16 score   6: R16 conn   7: gap
//   8: QF  team   9: QF  score  10: QF  conn  11: gap
//  12: SF  team  13: SF  score  14: SF  conn  15: gap
//
//  CENTER (col 16): Final / champion / tiebreaker
//
//  RIGHT SIDE (cols 17–32, mirror):
//  17: gap  18: SF  conn  19: SF  score  20: SF  team
//  21: gap  22: QF  conn  23: QF  score  24: QF  team
//  25: gap  26: R16 conn  27: R16 score  28: R16 team
//  29: gap  30: R32 conn  31: R32 score  32: R32 team
//
// Total rows: 96  (8 R32 matches × 12 rows each)
// Row geometry per round on each half:
//   R32: 8 matches × 12 rows  — team rows at offsets +2 and +8 within each match block
//   R16: 4 matches × 24 rows  — team rows at offsets +5 and +17
//   QF:  2 matches × 48 rows  — team rows at offsets +11 and +35
//   SF:  1 match  × 96 rows  — team rows at rows 23 and 71
// ---------------------------------------------------------------------------

const TOTAL_ROWS = 96;

// Column indices
const COL = {
  // Left
  L_R32_TEAM: 0, L_R32_SCORE: 1, L_R32_CONN: 2, L_GAP1: 3,
  L_R16_TEAM: 4, L_R16_SCORE: 5, L_R16_CONN: 6, L_GAP2: 7,
  L_QF_TEAM:  8, L_QF_SCORE:  9, L_QF_CONN: 10, L_GAP3: 11,
  L_SF_TEAM: 12, L_SF_SCORE: 13, L_SF_CONN: 14, L_GAP4: 15,
  // Center
  CENTER: 16,
  // Right (mirror)
  R_GAP4: 17, R_SF_CONN: 18, R_SF_SCORE: 19, R_SF_TEAM: 20,
  R_GAP3: 21, R_QF_CONN: 22, R_QF_SCORE: 23, R_QF_TEAM: 24,
  R_GAP2: 25, R_R16_CONN: 26, R_R16_SCORE: 27, R_R16_TEAM: 28,
  R_GAP1: 29, R_R32_CONN: 30, R_R32_SCORE: 31, R_R32_TEAM: 32,
};
const NUM_COLS = 33;

function renderBracket(data) {
  const b = data.bracket;
  const tb = data.tiebreaker_goals;

  // ── Build cell grid ──────────────────────────────────────
  // grid[row][col] = { content, rowspan, cls } | null (occupied by rowspan above)
  const grid = Array.from({ length: TOTAL_ROWS }, () => Array(NUM_COLS).fill(null));

  // Helper: place a cell, marking subsequent rows as occupied
  function place(row, col, cell) {
    grid[row][col] = cell;
    for (let r = row + 1; r < row + (cell.rowspan || 1); r++) {
      grid[r][col] = 'occupied';
    }
  }

  // Helper: team cell descriptor
  function teamCellD(name, isWinner) {
    const cls = ['team-cell'];
    if (!name) cls.push('tbd');
    else if (isWinner === true)  cls.push('winner');
    else if (isWinner === false) cls.push('loser');
    return { type: 'team', name: name || null, cls: cls.join(' '), rowspan: 1 };
  }

  // Helper: score cell (thin border continuation of team cell)
  function scoreCellD(isWinner) {
    return { type: 'score', cls: isWinner ? 'score-cell winner' : 'score-cell', rowspan: 1 };
  }

  // Helper: connector cell
  function connD(side, rowspan) {
    return { type: 'conn', cls: side === 'left' ? 'conn-left' : 'conn-right', rowspan };
  }

  // Helper: gap cell
  function gapD(rowspan) {
    return { type: 'gap', cls: 'gap', rowspan };
  }

  // ── Place gap columns (full height) ─────────────────────
  [COL.L_GAP1, COL.L_GAP2, COL.L_GAP3, COL.L_GAP4,
   COL.R_GAP1, COL.R_GAP2, COL.R_GAP3, COL.R_GAP4].forEach(col => {
    place(0, col, gapD(TOTAL_ROWS));
  });

  // ── Place center cell (full height) ─────────────────────
  const finalMatch = b['FINAL'] || {};
  const champion = finalMatch.predicted_team || null;
  place(0, COL.CENTER, {
    type: 'center',
    champion,
    tiebreaker: (typeof tb === 'number') ? tb : null,
    rowspan: TOTAL_ROWS,
    cls: 'center-cell',
  });

  // ── Left half ────────────────────────────────────────────

  // R32 left — 8 matches, 12 rows each, paired into 4 groups of 2
  HALF.left.r32.forEach((id, i) => {
    const start = i * 12;
    const m = b[id] || {};
    const home = m.home || null;
    const away = m.away || null;
    const pred = m.predicted_team || null;
    const homeWin = pred !== null && home !== null && pred === home;
    const awayWin = pred !== null && away !== null && pred === away;

    place(start + 2, COL.L_R32_TEAM,  teamCellD(home, homeWin ? true : awayWin ? false : null));
    place(start + 2, COL.L_R32_SCORE, scoreCellD(homeWin));
    place(start + 8, COL.L_R32_TEAM,  teamCellD(away, awayWin ? true : homeWin ? false : null));
    place(start + 8, COL.L_R32_SCORE, scoreCellD(awayWin));

    // Connector: top match of each pair spans 24 rows (covers both matches)
    if (i % 2 === 0) place(start + 2, COL.L_R32_CONN, connD('left', 24));
  });

  // R16 left — 4 matches, 24 rows each
  HALF.left.r16.forEach((id, i) => {
    const start = i * 24;
    const m = b[id] || {};
    const home = m.home || null;
    const away = m.away || null;
    const pred = m.predicted_team || null;
    const homeWin = pred !== null && home !== null && pred === home;
    const awayWin = pred !== null && away !== null && pred === away;

    place(start + 5,  COL.L_R16_TEAM,  teamCellD(home, homeWin ? true : awayWin ? false : null));
    place(start + 5,  COL.L_R16_SCORE, scoreCellD(homeWin));
    place(start + 17, COL.L_R16_TEAM,  teamCellD(away, awayWin ? true : homeWin ? false : null));
    place(start + 17, COL.L_R16_SCORE, scoreCellD(awayWin));

    if (i % 2 === 0) place(start + 5, COL.L_R16_CONN, connD('left', 48));
  });

  // QF left — 2 matches, 48 rows each
  HALF.left.qf.forEach((id, i) => {
    const start = i * 48;
    const m = b[id] || {};
    const home = m.home || null;
    const away = m.away || null;
    const pred = m.predicted_team || null;
    const homeWin = pred !== null && home !== null && pred === home;
    const awayWin = pred !== null && away !== null && pred === away;

    place(start + 11, COL.L_QF_TEAM,  teamCellD(home, homeWin ? true : awayWin ? false : null));
    place(start + 11, COL.L_QF_SCORE, scoreCellD(homeWin));
    place(start + 35, COL.L_QF_TEAM,  teamCellD(away, awayWin ? true : homeWin ? false : null));
    place(start + 35, COL.L_QF_SCORE, scoreCellD(awayWin));

    if (i % 2 === 0) place(start + 11, COL.L_QF_CONN, connD('left', TOTAL_ROWS));
  });

  // SF left — 1 match, team rows at 23 and 71
  {
    const m = b[HALF.left.sf] || {};
    const home = m.home || null;
    const away = m.away || null;
    const pred = m.predicted_team || null;
    const homeWin = pred !== null && home !== null && pred === home;
    const awayWin = pred !== null && away !== null && pred === away;

    place(23, COL.L_SF_TEAM,  teamCellD(home, homeWin ? true : awayWin ? false : null));
    place(23, COL.L_SF_SCORE, scoreCellD(homeWin));
    place(71, COL.L_SF_TEAM,  teamCellD(away, awayWin ? true : homeWin ? false : null));
    place(71, COL.L_SF_SCORE, scoreCellD(awayWin));
    place(23, COL.L_SF_CONN,  connD('left', TOTAL_ROWS));
  }

  // ── Right half (mirror — connectors on right side of cells) ─

  // SF right
  {
    const m = b[HALF.right.sf] || {};
    const home = m.home || null;
    const away = m.away || null;
    const pred = m.predicted_team || null;
    const homeWin = pred !== null && home !== null && pred === home;
    const awayWin = pred !== null && away !== null && pred === away;

    place(23, COL.R_SF_CONN,  connD('right', TOTAL_ROWS));
    place(23, COL.R_SF_SCORE, scoreCellD(homeWin));
    place(23, COL.R_SF_TEAM,  teamCellD(home, homeWin ? true : awayWin ? false : null));
    place(71, COL.R_SF_SCORE, scoreCellD(awayWin));
    place(71, COL.R_SF_TEAM,  teamCellD(away, awayWin ? true : homeWin ? false : null));
  }

  // QF right — 2 matches, 48 rows each
  HALF.right.qf.forEach((id, i) => {
    const start = i * 48;
    const m = b[id] || {};
    const home = m.home || null;
    const away = m.away || null;
    const pred = m.predicted_team || null;
    const homeWin = pred !== null && home !== null && pred === home;
    const awayWin = pred !== null && away !== null && pred === away;

    if (i % 2 === 0) place(start + 11, COL.R_QF_CONN, connD('right', TOTAL_ROWS));
    place(start + 11, COL.R_QF_SCORE, scoreCellD(homeWin));
    place(start + 11, COL.R_QF_TEAM,  teamCellD(home, homeWin ? true : awayWin ? false : null));
    place(start + 35, COL.R_QF_SCORE, scoreCellD(awayWin));
    place(start + 35, COL.R_QF_TEAM,  teamCellD(away, awayWin ? true : homeWin ? false : null));
  });

  // R16 right — 4 matches, 24 rows each
  HALF.right.r16.forEach((id, i) => {
    const start = i * 24;
    const m = b[id] || {};
    const home = m.home || null;
    const away = m.away || null;
    const pred = m.predicted_team || null;
    const homeWin = pred !== null && home !== null && pred === home;
    const awayWin = pred !== null && away !== null && pred === away;

    if (i % 2 === 0) place(start + 5, COL.R_R16_CONN, connD('right', 48));
    place(start + 5,  COL.R_R16_SCORE, scoreCellD(homeWin));
    place(start + 5,  COL.R_R16_TEAM,  teamCellD(home, homeWin ? true : awayWin ? false : null));
    place(start + 17, COL.R_R16_SCORE, scoreCellD(awayWin));
    place(start + 17, COL.R_R16_TEAM,  teamCellD(away, awayWin ? true : homeWin ? false : null));
  });

  // R32 right — 8 matches, 12 rows each
  HALF.right.r32.forEach((id, i) => {
    const start = i * 12;
    const m = b[id] || {};
    const home = m.home || null;
    const away = m.away || null;
    const pred = m.predicted_team || null;
    const homeWin = pred !== null && home !== null && pred === home;
    const awayWin = pred !== null && away !== null && pred === away;

    if (i % 2 === 0) place(start + 2, COL.R_R32_CONN, connD('right', 24));
    place(start + 2, COL.R_R32_SCORE, scoreCellD(homeWin));
    place(start + 2, COL.R_R32_TEAM,  teamCellD(home, homeWin ? true : awayWin ? false : null));
    place(start + 8, COL.R_R32_SCORE, scoreCellD(awayWin));
    place(start + 8, COL.R_R32_TEAM,  teamCellD(away, awayWin ? true : homeWin ? false : null));
  });

  // ── Build the DOM table row by row ───────────────────────
  const table = document.createElement('table');
  table.className = 'bracket-table';

  // Header
  const thead = table.createTHead();
  const hrow = thead.insertRow();
  function addTh(text, colspan) {
    const td = document.createElement('td');
    if (text) { td.className = 'round-header'; td.textContent = text; }
    td.colSpan = colspan;
    hrow.appendChild(td);
  }
  addTh('Round of 32', 3); addTh('', 1);
  addTh('Round of 16', 3); addTh('', 1);
  addTh('Quarterfinals', 3); addTh('', 1);
  addTh('Semifinals', 3); addTh('', 1);
  addTh('Final', 1);
  addTh('', 1); addTh('Semifinals', 3);
  addTh('', 1); addTh('Quarterfinals', 3);
  addTh('', 1); addTh('Round of 16', 3);
  addTh('', 1); addTh('Round of 32', 3);

  // Body
  const tbody = table.createTBody();
  for (let r = 0; r < TOTAL_ROWS; r++) {
    const tr = tbody.insertRow();
    for (let c = 0; c < NUM_COLS; c++) {
      const cell = grid[r][c];
      if (cell === null) {
        // Empty cell (no content, no rowspan needed)
        tr.appendChild(document.createElement('td'));
      } else if (cell === 'occupied') {
        // Covered by a rowspan from above — skip
        continue;
      } else {
        // Real cell
        const td = document.createElement('td');
        td.className = cell.cls || '';
        if (cell.rowspan && cell.rowspan > 1) td.rowSpan = cell.rowspan;

        if (cell.type === 'team') {
          td.textContent = displayName(cell.name);
          if (cell.name) td.title = cell.name;
        } else if (cell.type === 'center') {
          const ch = document.createElement('div');
          ch.className = 'champion-callout';
          ch.textContent = cell.champion ? `🏆 ${cell.champion}` : '🏆 TBD';
          td.appendChild(ch);

          const lbl = document.createElement('div');
          lbl.className = 'tiebreaker-label';
          lbl.textContent = 'Total goals scored in the final game';
          td.appendChild(lbl);

          const val = document.createElement('div');
          val.className = 'tiebreaker-value';
          val.textContent = cell.tiebreaker !== null ? cell.tiebreaker : '—';
          td.appendChild(val);
        }
        // conn, score, gap cells: no text content

        tr.appendChild(td);
      }
    }
  }

  document.getElementById('bracket-loading').classList.add('hidden');
  document.getElementById('bracket-wrap').appendChild(table);
}

document.addEventListener('DOMContentLoaded', init);
