'use strict';

// ---------------------------------------------------------------------------
// Bracket column ordering (left → right, top → bottom)
// Consecutive pairs feed the next round.
//
//   R32: 74,77 | 73,75 | 76,78 | 79,80 | 83,84 | 81,82 | 86,88 | 85,87
//   R16: 89,90 | 91,92 | 93,94 | 95,96
//   QF:  97,99 | 98,100
//   SF:  101,102
//   Final + Third
// ---------------------------------------------------------------------------

const R32_ORDER = [
  'R32_74','R32_77','R32_73','R32_75',
  'R32_76','R32_78','R32_79','R32_80',
  'R32_83','R32_84','R32_81','R32_82',
  'R32_86','R32_88','R32_85','R32_87',
];
const R16_ORDER = ['R16_89','R16_90','R16_91','R16_92','R16_93','R16_94','R16_95','R16_96'];
const QF_ORDER  = ['QF_97','QF_99','QF_98','QF_100'];
const SF_ORDER  = ['SF_101','SF_102'];

// ---------------------------------------------------------------------------
// Country abbreviations
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
// Dummy data — static layout test, no API call.
//
// Each match: { home, away, predicted_team, actual_winner }
//   predicted_team: team name user picked to advance (null = no pick)
//   actual_winner:  team name that actually won (null = not played yet)
//
// "winner" / "loser" styling:
//   - If actual_winner is set: winner = correct pick, loser = wrong pick
//   - If actual_winner is null: predicted_team gets "pick" style (bold, outlined)
// ---------------------------------------------------------------------------

function makeDummy(home, away, pickHome, actualHome) {
  return {
    home,
    away,
    predicted_team: pickHome ? home : away,
    actual_winner:  actualHome === null ? null : actualHome ? home : away,
  };
}

const H = true, A = false, TBD = null;

const DUMMY = {
  // R32 — all played (actual_winner set), mix of correct and wrong picks
  bracket: {
    R32_74: makeDummy('Alien Alpha',   'Predator Alpha',  H, A),   // picked home, actual away → wrong
    R32_77: makeDummy('Alien Beta',    'Predator Beta',   H, H),   // picked home, actual home → correct
    R32_73: makeDummy('Alien Gamma',   'Predator Gamma',  A, A),   // picked away, actual away → correct
    R32_75: makeDummy('Alien Delta',   'Predator Delta',  H, H),   // picked home, actual home → correct
    R32_76: makeDummy('Alien Epsilon', 'Predator Epsilon',H, A),   // wrong
    R32_78: makeDummy('Alien Zeta',    'Predator Zeta',   A, A),   // correct
    R32_79: makeDummy('Alien Eta',     'Predator Eta',    H, H),   // correct
    R32_80: makeDummy('Alien Theta',   'Predator Theta',  A, H),   // wrong

    R32_83: makeDummy('Alien Iota',    'Predator Iota',   H, H),   // correct
    R32_84: makeDummy('Alien Kappa',   'Predator Kappa',  A, A),   // correct
    R32_81: makeDummy('Alien Lambda',  'Predator Lambda', H, A),   // wrong
    R32_82: makeDummy('Alien Mu',      'Predator Mu',     A, A),   // correct
    R32_86: makeDummy('Alien Nu',      'Predator Nu',     H, H),   // correct
    R32_88: makeDummy('Alien Xi',      'Predator Xi',     A, H),   // wrong
    R32_85: makeDummy('Alien Omicron', 'Predator Omicron',H, H),   // correct
    R32_87: makeDummy('Alien Pi',      'Predator Pi',     A, A),   // correct

    // R16 — some played, some not yet
    R16_89: makeDummy('Alien Beta',    'Alien Gamma',     H, H),   // correct, played
    R16_90: makeDummy('Predator Alpha','Alien Delta',     A, TBD), // not played, pick = Alien Delta
    R16_91: makeDummy('Alien Epsilon', 'Alien Zeta',      A, TBD), // not played
    R16_92: makeDummy('Alien Eta',     'Predator Theta',  H, TBD), // not played
    R16_93: makeDummy('Alien Iota',    'Alien Kappa',     H, H),   // correct, played
    R16_94: makeDummy('Predator Lambda','Alien Mu',       A, TBD), // not played
    R16_95: makeDummy('Alien Nu',      'Predator Xi',     H, TBD), // not played
    R16_96: makeDummy('Alien Omicron', 'Alien Pi',        H, TBD), // not played

    // QF — not played
    QF_97:  makeDummy('Alien Beta',    'Alien Delta',     H, TBD),
    QF_99:  makeDummy('Alien Zeta',    'Alien Eta',       A, TBD),
    QF_98:  makeDummy('Alien Iota',    'Alien Mu',        H, TBD),
    QF_100: makeDummy('Alien Nu',      'Alien Omicron',   A, TBD),

    // SF — not played
    SF_101: makeDummy('Alien Beta',    'Alien Mu',        A, TBD),
    SF_102: makeDummy('Alien Zeta',    'Alien Nu',        H, TBD),

    // Final + Third — not played
    FINAL:  makeDummy('Alien Mu',      'Alien Zeta',      H, TBD),
    THIRD:  makeDummy('Alien Beta',    'Alien Nu',        A, TBD),
  },
  username: 'alien',
  tiebreaker_goals: 5,
};

// ---------------------------------------------------------------------------
// Boot — in phase 1 use dummy data directly; phase 2 will fetch from API
// ---------------------------------------------------------------------------

function init() {
  renderBracket(DUMMY);
}

function showError(msg) {
  document.getElementById('bracket-loading').classList.add('hidden');
  const el = document.getElementById('picks-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Bracket table — rowspan tracker, single-sided left → right
//
// Column layout (15 columns total, 0-indexed):
//   0: R32 team   1: R32 conn-L   2: R32 conn-R   3: gap
//   4: R16 team   5: R16 conn-L   6: R16 conn-R   7: gap
//   8: QF team    9: QF conn-L   10: QF conn-R   11: gap
//  12: SF team   13: gap
//  14: Final column
//
// Row geometry (96 rows total):
//   R32: 16 matches × 6 rows each
//   R16:  8 matches × 12 rows each
//   QF:   4 matches × 24 rows each
//   SF:   2 matches × 48 rows each
//   Final column: spans all 96 rows
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
    if (row < 0 || row >= TOTAL_ROWS || col < 0 || col >= NUM_COLS) return;
    grid[row][col] = cell;
    for (let r = row + 1; r < row + (cell.rowspan || 1); r++) {
      if (r < TOTAL_ROWS) grid[r][col] = 'occupied';
    }
  }

  // Determine per-team CSS class given a match entry and which side (home/away)
  function teamClass(match, side) {
    const cls = ['team-cell'];
    const team = match[side];          // e.g. match.home or match.away
    const picked = match.predicted_team === team;
    const actual = match.actual_winner;

    if (!team) {
      cls.push('tbd');
    } else if (actual !== null) {
      // Match has been played — show correct/wrong
      if (actual === team && picked) cls.push('correct');
      else if (actual !== team && picked) cls.push('wrong');
      else if (actual === team) cls.push('actual-winner');
      else cls.push('loser');
    } else {
      // Not played — show pick
      if (picked) cls.push('pick');
      else cls.push('not-picked');
    }
    return cls.join(' ');
  }

  function teamD(match, side) {
    return { type: 'team', match, side, cls: teamClass(match, side), rowspan: 1 };
  }

  function connD(side, rowspan) {
    return { type: 'conn', cls: side === 'left' ? 'conn-left' : 'conn-right', rowspan };
  }

  function gapD(rowspan) {
    return { type: 'gap', cls: 'gap', rowspan };
  }

  // ── Gap + Final columns span all rows ────────────────────
  [COL.R32_GAP, COL.R16_GAP, COL.QF_GAP, COL.SF_GAP].forEach(col => {
    place(0, col, gapD(TOTAL_ROWS));
  });

  const finalM = b['FINAL'] || {};
  const thirdM = b['THIRD'] || {};

  place(0, COL.FINAL, {
    type: 'final-col',
    finalM,
    thirdM,
    tiebreaker: (typeof tb === 'number') ? tb : null,
    rowspan: TOTAL_ROWS,
    cls: 'final-col-cell',
  });

  // ── Place one pair of matches in a round column ──────────
  function placePair(teamCol, clCol, crCol, pairIdx, rowsPerMatch, ids) {
    const [topId, botId] = ids;
    const connRowspan = rowsPerMatch * 2;

    const topStart    = pairIdx * connRowspan;
    const topTeam1Row = topStart + Math.floor(rowsPerMatch * 0.25);
    const topTeam2Row = topStart + Math.floor(rowsPerMatch * 0.75);

    const topM = b[topId] || { home: null, away: null, predicted_team: null, actual_winner: null };
    place(topTeam1Row, teamCol, teamD(topM, 'home'));
    place(topTeam2Row, teamCol, teamD(topM, 'away'));

    const botStart    = topStart + rowsPerMatch;
    const botTeam1Row = botStart + Math.floor(rowsPerMatch * 0.25);
    const botTeam2Row = botStart + Math.floor(rowsPerMatch * 0.75);

    const botM = b[botId] || { home: null, away: null, predicted_team: null, actual_winner: null };
    place(botTeam1Row, teamCol, teamD(botM, 'home'));
    place(botTeam2Row, teamCol, teamD(botM, 'away'));

    // conn-right: closing bracket between the two matches
    if (crCol !== null) {
      const crRowspan = Math.max(1, botTeam1Row - topTeam2Row + 1);
      if (topTeam2Row + crRowspan <= TOTAL_ROWS) {
        place(topTeam2Row, crCol, connD('right', crRowspan));
      }
    }
    // conn-left: vertical spine spanning bottom match's two teams
    if (clCol !== null) {
      const clRowspan = Math.max(1, botTeam2Row - botTeam1Row + 1);
      place(botTeam1Row, clCol, connD('left', clRowspan));
    }
  }

  // ── Place all rounds ─────────────────────────────────────
  for (let p = 0; p < 8; p++) {
    placePair(COL.R32_TEAM, COL.R32_CL, COL.R32_CR, p, 6,
      [R32_ORDER[p*2], R32_ORDER[p*2+1]]);
  }
  for (let p = 0; p < 4; p++) {
    placePair(COL.R16_TEAM, COL.R16_CL, COL.R16_CR, p, 12,
      [R16_ORDER[p*2], R16_ORDER[p*2+1]]);
  }
  for (let p = 0; p < 2; p++) {
    placePair(COL.QF_TEAM, COL.QF_CL, COL.QF_CR, p, 24,
      [QF_ORDER[p*2], QF_ORDER[p*2+1]]);
  }
  // SF: single pair, no outbound connectors (feeds into Final column)
  placePair(COL.SF_TEAM, null, null, 0, 48,
    [SF_ORDER[0], SF_ORDER[1]]);

  // ── Render DOM ───────────────────────────────────────────
  const table = document.createElement('table');
  table.className = 'bracket-table';

  // Header row
  const thead = table.createTHead();
  const hrow  = thead.insertRow();
  function th(text, colspan) {
    const td = document.createElement('td');
    td.colSpan = colspan || 1;
    td.className = text ? 'round-header' : 'round-header-empty';
    if (text) td.textContent = text;
    hrow.appendChild(td);
  }
  th('Round of 32', 3); th('', 1);
  th('Round of 16', 3); th('', 1);
  th('Quarterfinals', 3); th('', 1);
  th('Semifinals', 2);
  th('Final', 1);

  // Body rows
  const tbody = table.createTBody();
  for (let r = 0; r < TOTAL_ROWS; r++) {
    const tr = tbody.insertRow();
    for (let c = 0; c < NUM_COLS; c++) {
      const cell = grid[r][c];
      if (cell === 'occupied') continue;

      const td = document.createElement('td');
      if (cell === null) { tr.appendChild(td); continue; }

      td.className = cell.cls || '';
      if (cell.rowspan > 1) td.rowSpan = cell.rowspan;

      if (cell.type === 'team') {
        const name = cell.match[cell.side];
        td.textContent = displayName(name);
        if (name) td.title = name;

      } else if (cell.type === 'final-col') {
        renderFinalCol(td, cell);
      }
      // conn, gap: no text content

      tr.appendChild(td);
    }
  }

  document.getElementById('bracket-wrap').appendChild(table);
}

// ---------------------------------------------------------------------------
// Final column DOM builder
// ---------------------------------------------------------------------------

function renderFinalCol(td, cell) {
  const { finalM, thirdM, tiebreaker } = cell;

  function matchBlock(label, match) {
    const wrap = document.createElement('div');
    wrap.className = 'final-col__block';

    const lbl = document.createElement('div');
    lbl.className = 'final-col__label';
    lbl.textContent = label;
    wrap.appendChild(lbl);

    for (const side of ['home', 'away']) {
      const team = match[side];
      const row  = document.createElement('div');
      const picked = match.predicted_team === team;
      const actual = match.actual_winner;
      let cls = 'final-col__team';
      if (!team) {
        cls += ' tbd';
      } else if (actual !== null) {
        if (actual === team && picked) cls += ' correct';
        else if (actual !== team && picked) cls += ' wrong';
        else if (actual === team) cls += ' actual-winner';
        else cls += ' loser';
      } else {
        if (picked) cls += ' pick';
        else cls += ' not-picked';
      }
      row.className = cls;
      row.textContent = displayName(team);
      if (team) row.title = team;
      wrap.appendChild(row);
    }
    return wrap;
  }

  td.appendChild(matchBlock('Final', finalM));

  const tbRow = document.createElement('div');
  tbRow.className = 'final-col__tiebreaker';
  tbRow.textContent = 'Total goals: ' + (tiebreaker !== null ? tiebreaker : '—');
  td.appendChild(tbRow);

  const div = document.createElement('div');
  div.className = 'final-col__divider';
  td.appendChild(div);

  td.appendChild(matchBlock('3rd place', thirdM));

  // Champion callout
  const champWinner = finalM.actual_winner || finalM.predicted_team;
  const div2 = document.createElement('div');
  div2.className = 'final-col__divider final-col__divider--tall';
  td.appendChild(div2);

  const champ = document.createElement('div');
  champ.className = 'champion-callout';
  champ.textContent = champWinner ? `\u{1F3C6} ${champWinner}` : '\u{1F3C6} TBD';
  td.appendChild(champ);
}

document.addEventListener('DOMContentLoaded', init);
