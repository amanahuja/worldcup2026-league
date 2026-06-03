'use strict';

// ---------------------------------------------------------------------------
// Single-sided bracket, left → right, top → bottom
//
// Match ordering (top to bottom, mirrors Wikipedia bracket):
//   R32: 74,77, 73,75, 76,78, 79,80, 83,84, 81,82, 86,88, 85,87
//   R16: 89,90, 91,92, 93,94, 95,96
//   QF:  97,99, 98,100
//   SF:  101,102
//   Final + Third
//
// Each consecutive pair feeds one match in the next round.
// ---------------------------------------------------------------------------

const R32_ORDER = ['R32_74','R32_77','R32_73','R32_75','R32_76','R32_78','R32_79','R32_80',
                   'R32_83','R32_84','R32_81','R32_82','R32_86','R32_88','R32_85','R32_87'];
const R16_ORDER = ['R16_89','R16_90','R16_91','R16_92','R16_93','R16_94','R16_95','R16_96'];
const QF_ORDER  = ['QF_97','QF_99','QF_98','QF_100'];
const SF_ORDER  = ['SF_101','SF_102'];

// ---------------------------------------------------------------------------
// Abbreviations
// ---------------------------------------------------------------------------

const ABBR = {
  'Algeria':'ALG','Argentina':'ARG','Australia':'AUS','Austria':'AUT',
  'Belgium':'BEL','Bosnia & Herzegovina':'BIH','Bosnia and Herzegovina':'BIH',
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
    document.getElementById('bracket-loading').classList.add('hidden');
    renderBracket(data);
  } catch (e) {
    console.error('picks error:', e);
    showError('Something went wrong: ' + e.message);
  }
}

function showError(msg) {
  document.getElementById('bracket-loading').classList.add('hidden');
  const el = document.getElementById('picks-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Bracket table — rowspan tracker, single-sided left→right
//
// Column layout (9 columns, 0-indexed):
//   0: team+score (R32)   1: conn-left   2: conn-right   3: gap
//   4: team+score (R16)   5: conn-left   6: conn-right   7: gap
//   8: team+score (QF)    9: conn-left  10: conn-right  11: gap
//  12: team+score (SF)   13: gap
//  14: Final column (team+score, third place, champion, tiebreaker)
//
// "team+score" is actually two sub-columns: team (wide) + score (narrow).
// For simplicity we use a single td with border-right for the score edge.
//
// Actual columns: 0=R32team 1=R32conn-L 2=R32conn-R 3=gap
//                 4=R16team 5=R16conn-L 6=R16conn-R 7=gap
//                 8=QFteam  9=QFconn-L 10=QFconn-R 11=gap
//                12=SFteam 13=gap
//                14=Final
// Total: 15 columns
//
// Row geometry (96 rows total):
//   R32: 16 matches × 6 rows each.  Team rows at +1 and +4 within each 6-row block.
//   R16:  8 matches × 12 rows each. Team rows at +2 and +8.
//   QF:   4 matches × 24 rows each. Team rows at +5 and +17.
//   SF:   2 matches × 48 rows each. Team rows at +11 and +35.
//   Final: spans all 96 rows.
//
// Connector rowspans: always rows_per_match × 2 (spans the pair).
// Placed at the top team row of the even match in each pair.
// All safe from overflow: last pair in every round ends at row 95.
// ---------------------------------------------------------------------------

const TOTAL_ROWS = 96;
const NUM_COLS   = 15;

const COL = {
  R32_TEAM: 0, R32_CL: 1, R32_CR: 2, R32_GAP: 3,
  R16_TEAM: 4, R16_CL: 5, R16_CR: 6, R16_GAP: 7,
  QF_TEAM:  8, QF_CL:  9, QF_CR: 10, QF_GAP: 11,
  SF_TEAM: 12, SF_GAP: 13,
  FINAL:   14,
};

function renderBracket(data) {
  const b  = data.bracket;
  const tb = data.tiebreaker_goals;

  // ── Grid setup ───────────────────────────────────────────
  const grid = Array.from({ length: TOTAL_ROWS }, () => Array(NUM_COLS).fill(null));

  function place(row, col, cell) {
    grid[row][col] = cell;
    for (let r = row + 1; r < row + (cell.rowspan || 1); r++) {
      if (r < TOTAL_ROWS) grid[r][col] = 'occupied';
    }
  }

  function teamD(name, isWinner) {
    const cls = ['team-cell'];
    if (!name)              cls.push('tbd');
    else if (isWinner === true)  cls.push('winner');
    else if (isWinner === false) cls.push('loser');
    return { type: 'team', name: name || null, cls: cls.join(' '), rowspan: 1 };
  }

  function connD(side, rowspan) {
    return { type: 'conn', cls: side === 'left' ? 'conn-left' : 'conn-right', rowspan };
  }

  function gapD(rowspan) {
    return { type: 'gap', cls: 'gap', rowspan };
  }

  // ── Gap columns ──────────────────────────────────────────
  [COL.R32_GAP, COL.R16_GAP, COL.QF_GAP, COL.SF_GAP].forEach(col => {
    place(0, col, gapD(TOTAL_ROWS));
  });

  // ── Final column ─────────────────────────────────────────
  const finalM  = b['FINAL'] || {};
  const thirdM  = b['THIRD'] || {};
  const champion = finalM.predicted_team || null;
  place(0, COL.FINAL, {
    type: 'final-col',
    finalHome:  finalM.home  || null,
    finalAway:  finalM.away  || null,
    finalWinner: finalM.predicted_team || null,
    thirdHome:  thirdM.home  || null,
    thirdAway:  thirdM.away  || null,
    thirdWinner: thirdM.predicted_team || null,
    champion,
    tiebreaker: (typeof tb === 'number') ? tb : null,
    rowspan: TOTAL_ROWS,
    cls: 'final-col-cell',
  });

  // ── Helper: place one match pair ─────────────────────────
  // teamCol: column index for team cell
  // clCol, crCol: connector-left and connector-right columns
  // pairIdx: 0-based pair index within the round
  // rowsPerMatch: rows each match occupies
  // ids: [topMatchId, bottomMatchId]
  function placePair(teamCol, clCol, crCol, pairIdx, rowsPerMatch, ids) {
    const connRowspan = rowsPerMatch * 2;
    const [topId, botId] = ids;

    // Top match — team rows at +1 within the match block
    const topStart = pairIdx * connRowspan;
    const topTeam1Row = topStart + Math.floor(rowsPerMatch * 0.25);
    const topTeam2Row = topStart + Math.floor(rowsPerMatch * 0.75);

    const topM = b[topId] || {};
    const topHome = topM.home || null;
    const topAway = topM.away || null;
    const topPred = topM.predicted_team || null;
    const topHW = topPred !== null && topHome !== null && topPred === topHome;
    const topAW = topPred !== null && topAway !== null && topPred === topAway;

    place(topTeam1Row, teamCol, teamD(topHome, topHW ? true : topAW ? false : null));
    place(topTeam2Row, teamCol, teamD(topAway, topAW ? true : topHW ? false : null));

    // Bottom match
    const botStart = topStart + rowsPerMatch;
    const botTeam1Row = botStart + Math.floor(rowsPerMatch * 0.25);
    const botTeam2Row = botStart + Math.floor(rowsPerMatch * 0.75);

    const botM = b[botId] || {};
    const botHome = botM.home || null;
    const botAway = botM.away || null;
    const botPred = botM.predicted_team || null;
    const botHW = botPred !== null && botHome !== null && botPred === botHome;
    const botAW = botPred !== null && botAway !== null && botPred === botAway;

    place(botTeam1Row, teamCol, teamD(botHome, botHW ? true : botAW ? false : null));
    place(botTeam2Row, teamCol, teamD(botAway, botAW ? true : botHW ? false : null));

    // Connectors span the full pair
    if (clCol !== null) place(topTeam1Row, clCol, connD('left',  connRowspan - topTeam1Row + topStart));
    if (crCol !== null) place(topTeam1Row, crCol, connD('right', connRowspan - topTeam1Row + topStart));
  }

  // ── R32: 16 matches = 8 pairs, 6 rows/match ──────────────
  for (let p = 0; p < 8; p++) {
    placePair(COL.R32_TEAM, COL.R32_CL, COL.R32_CR, p, 6,
      [R32_ORDER[p*2], R32_ORDER[p*2+1]]);
  }

  // ── R16: 8 matches = 4 pairs, 12 rows/match ──────────────
  for (let p = 0; p < 4; p++) {
    placePair(COL.R16_TEAM, COL.R16_CL, COL.R16_CR, p, 12,
      [R16_ORDER[p*2], R16_ORDER[p*2+1]]);
  }

  // ── QF: 4 matches = 2 pairs, 24 rows/match ───────────────
  for (let p = 0; p < 2; p++) {
    placePair(COL.QF_TEAM, COL.QF_CL, COL.QF_CR, p, 24,
      [QF_ORDER[p*2], QF_ORDER[p*2+1]]);
  }

  // ── SF: 2 matches = 1 pair, 48 rows/match ────────────────
  // No connectors on SF — it feeds into Final column directly
  placePair(COL.SF_TEAM, null, null, 0, 48,
    [SF_ORDER[0], SF_ORDER[1]]);

  // ── Build DOM table row by row ───────────────────────────
  const table = document.createElement('table');
  table.className = 'bracket-table';

  // Header row
  const thead = table.createTHead();
  const hrow  = thead.insertRow();
  function addTh(text, colspan) {
    const td = document.createElement('td');
    td.colSpan = colspan || 1;
    if (text) { td.className = 'round-header'; td.textContent = text; }
    hrow.appendChild(td);
  }
  // R32: team+conn-L+conn-R = 3 cols, gap = 1
  addTh('Round of 32', 3); addTh('', 1);
  addTh('Round of 16', 3); addTh('', 1);
  addTh('Quarterfinals', 3); addTh('', 1);
  addTh('Semifinals', 2);
  addTh('Final', 1);

  // Body
  const tbody = table.createTBody();
  for (let r = 0; r < TOTAL_ROWS; r++) {
    const tr = tbody.insertRow();
    for (let c = 0; c < NUM_COLS; c++) {
      const cell = grid[r][c];
      if (cell === 'occupied') continue;

      const td = document.createElement('td');

      if (cell === null) {
        // empty cell
        tr.appendChild(td);
        continue;
      }

      td.className = cell.cls || '';
      if (cell.rowspan > 1) td.rowSpan = cell.rowspan;

      if (cell.type === 'team') {
        td.textContent = displayName(cell.name);
        if (cell.name) td.title = cell.name;

      } else if (cell.type === 'final-col') {
        // Final match
        const finalLabel = document.createElement('div');
        finalLabel.className = 'final-col__label';
        finalLabel.textContent = 'Final';
        td.appendChild(finalLabel);

        const finalHome = document.createElement('div');
        finalHome.className = 'final-col__team' + (cell.finalWinner === cell.finalHome && cell.finalHome ? ' winner' : '');
        finalHome.textContent = displayName(cell.finalHome);
        if (cell.finalHome) finalHome.title = cell.finalHome;
        td.appendChild(finalHome);

        const finalAway = document.createElement('div');
        finalAway.className = 'final-col__team' + (cell.finalWinner === cell.finalAway && cell.finalAway ? ' winner' : '');
        finalAway.textContent = displayName(cell.finalAway);
        if (cell.finalAway) finalAway.title = cell.finalAway;
        td.appendChild(finalAway);

        const tbRow = document.createElement('div');
        tbRow.className = 'final-col__tiebreaker';
        tbRow.textContent = 'Total goals: ' + (cell.tiebreaker !== null ? cell.tiebreaker : '—');
        td.appendChild(tbRow);

        // Divider
        const div1 = document.createElement('div');
        div1.className = 'final-col__divider';
        td.appendChild(div1);

        // Third place match
        const thirdLabel = document.createElement('div');
        thirdLabel.className = 'final-col__label';
        thirdLabel.textContent = 'Third place';
        td.appendChild(thirdLabel);

        const thirdHome = document.createElement('div');
        thirdHome.className = 'final-col__team' + (cell.thirdWinner === cell.thirdHome && cell.thirdHome ? ' winner' : '');
        thirdHome.textContent = displayName(cell.thirdHome);
        if (cell.thirdHome) thirdHome.title = cell.thirdHome;
        td.appendChild(thirdHome);

        const thirdAway = document.createElement('div');
        thirdAway.className = 'final-col__team' + (cell.thirdWinner === cell.thirdAway && cell.thirdAway ? ' winner' : '');
        thirdAway.textContent = displayName(cell.thirdAway);
        if (cell.thirdAway) thirdAway.title = cell.thirdAway;
        td.appendChild(thirdAway);

        // Champion callout — generous spacing above
        const div2 = document.createElement('div');
        div2.className = 'final-col__divider final-col__divider--tall';
        td.appendChild(div2);

        const champ = document.createElement('div');
        champ.className = 'champion-callout';
        champ.textContent = cell.champion ? `🏆 ${cell.champion}` : '🏆 TBD';
        td.appendChild(champ);
      }
      // conn, gap: no content

      tr.appendChild(td);
    }
  }

  document.getElementById('bracket-wrap').appendChild(table);
}

document.addEventListener('DOMContentLoaded', init);
