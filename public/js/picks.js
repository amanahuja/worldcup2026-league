'use strict';

// ---------------------------------------------------------------------------
// Bracket structure (mirrors scores-worker.js constants)
// Left half feeds SF_101, right half feeds SF_102
// ---------------------------------------------------------------------------

// Left half feeds SF_101 (via QF_97 + QF_98), right half feeds SF_102 (via QF_99 + QF_100).
// Left:  R32_74,77,73,75 → R16_89,90 → QF_97  \
//        R32_83,84,81,82 → R16_93,94 → QF_98  /  SF_101
// Right: R32_76,78,79,80 → R16_91,92 → QF_99  \
//        R32_86,88,85,87 → R16_95,96 → QF_100 /  SF_102

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
// Team name abbreviation (mirrors app.js abbr())
// ---------------------------------------------------------------------------

const ABBR = {
  'Afghanistan':'AFG','Albania':'ALB','Algeria':'ALG','Andorra':'AND','Angola':'ANG',
  'Argentina':'ARG','Armenia':'ARM','Australia':'AUS','Austria':'AUT','Azerbaijan':'AZE',
  'Bahrain':'BHR','Bangladesh':'BAN','Belarus':'BLR','Belgium':'BEL','Bolivia':'BOL',
  'Bosnia & Herzegovina':'BIH','Bosnia and Herzegovina':'BIH','Botswana':'BOT',
  'Brazil':'BRA','Bulgaria':'BUL','Burkina Faso':'BFA','Cameroon':'CMR','Canada':'CAN',
  'Chile':'CHI','China':'CHN','Colombia':'COL','Costa Rica':'CRC','Croatia':'CRO',
  'Cuba':'CUB','Czech Republic':'CZE','Denmark':'DEN','DR Congo':'COD',
  'Ecuador':'ECU','Egypt':'EGY','El Salvador':'SLV','England':'ENG','Estonia':'EST',
  'Ethiopia':'ETH','Finland':'FIN','France':'FRA','Gabon':'GAB','Georgia':'GEO',
  'Germany':'GER','Ghana':'GHA','Greece':'GRE','Guatemala':'GUA','Honduras':'HON',
  'Hungary':'HUN','Iceland':'ISL','India':'IND','Indonesia':'IDN','Iran':'IRN',
  'Iraq':'IRQ','Israel':'ISR','Italy':'ITA','Ivory Coast':'CIV','Jamaica':'JAM',
  'Japan':'JPN','Jordan':'JOR','Kazakhstan':'KAZ','Kenya':'KEN','Kosovo':'KOS',
  'Kuwait':'KUW','Kyrgyzstan':'KGZ','Latvia':'LAT','Lebanon':'LIB','Libya':'LBA',
  'Lithuania':'LTU','Luxembourg':'LUX','Mali':'MLI','Malta':'MLT','Mexico':'MEX',
  'Moldova':'MDA','Montenegro':'MNE','Morocco':'MAR','Mozambique':'MOZ',
  'Netherlands':'NED','New Zealand':'NZL','Nigeria':'NGA','North Korea':'PRK',
  'North Macedonia':'MKD','Norway':'NOR','Oman':'OMA','Panama':'PAN','Paraguay':'PAR',
  'Peru':'PER','Philippines':'PHI','Poland':'POL','Portugal':'POR','Qatar':'QAT',
  'Romania':'ROU','Russia':'RUS','Saudi Arabia':'KSA','Senegal':'SEN','Serbia':'SRB',
  'Slovakia':'SVK','Slovenia':'SVN','South Africa':'RSA','South Korea':'KOR',
  'Spain':'ESP','Sweden':'SWE','Switzerland':'SUI','Syria':'SYR','Tajikistan':'TJK',
  'Tanzania':'TAN','Thailand':'THA','Trinidad & Tobago':'TRI','Tunisia':'TUN',
  'Turkey':'TUR','Turkmenistan':'TKM','Uganda':'UGA','Ukraine':'UKR','Uruguay':'URU',
  'USA':'USA','United States':'USA','Uzbekistan':'UZB','Venezuela':'VEN',
  'Vietnam':'VIE','Wales':'WAL','Zambia':'ZAM','Zimbabwe':'ZIM',
  'Curaçao':'CUW','Côte d\'Ivoire':'CIV','DR Congo':'COD','Austria':'AUT',
};

function abbr(name) {
  if (!name) return '?';
  return ABBR[name] || name.slice(0, 3).toUpperCase();
}

function displayName(name) {
  if (!name) return 'TBD';
  // Use full name if ≤13 chars, otherwise abbreviation
  return name.length <= 13 ? name : abbr(name);
}

// ---------------------------------------------------------------------------
// Fetch and render
// ---------------------------------------------------------------------------

async function init() {
  const params = new URLSearchParams(window.location.search);
  const user = params.get('user');
  if (!user) {
    showError('No user specified. Use ?user=username in the URL.');
    return;
  }

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
// Bracket table builder
// ---------------------------------------------------------------------------

function renderBracket(data) {
  const b = data.bracket;
  const tb = data.tiebreaker_goals;

  // Helper: build a team cell element
  function teamCell(name, isWinner) {
    const td = document.createElement('td');
    td.className = 'team-cell';
    if (!name || name === 'TBD') {
      td.classList.add('tbd');
      td.textContent = 'TBD';
    } else {
      td.textContent = displayName(name);
      td.title = name; // full name on hover
      if (isWinner === true)  td.classList.add('winner');
      if (isWinner === false) td.classList.add('loser');
    }
    return td;
  }

  // Helper: empty score cell (right border of team row)
  function scoreCell(isWinner) {
    const td = document.createElement('td');
    td.className = 'score-cell';
    if (isWinner) td.classList.add('winner');
    return td;
  }

  // Helper: empty spacer cell
  function gapCell(rowspan) {
    const td = document.createElement('td');
    td.className = 'gap';
    if (rowspan > 1) td.rowSpan = rowspan;
    return td;
  }

  // Build one half of the bracket as a column descriptor array.
  // Returns an array of round columns, each being an array of match descriptors.
  // Each match descriptor: { id, rowspan, connRowspan }
  //
  // Row geometry (96 total rows, same as Wikipedia):
  //   R32:  8 matches × 6 rows each (2 team rows + 1 gap + 1 gap + connector)
  //   R16:  4 matches × 12 rows each
  //   QF:   2 matches × 24 rows each
  //   SF:   1 match   × 48 rows each
  //
  // Each match occupies: [gap][team1][gap][team2][gap] rows in a 6-row block,
  // scaled by round multiplier.
  //
  // Simplified: use 4 rows per R32 match slot pair (2 per team + spacing).
  // Total rows = 8 matches × 12 rows = 96 rows.

  const TOTAL_ROWS = 96;
  // Rows per match per round:
  const ROWS = { r32: 12, r16: 24, qf: 48, sf: 96 };

  // Build the table
  const table = document.createElement('table');
  table.className = 'bracket-table';

  // ── Header row ──────────────────────────────────────────
  const thead = table.createTHead();
  const headerRow = thead.insertRow();

  function th(text, colspan) {
    const td = document.createElement('td');
    td.className = 'round-header';
    td.colSpan = colspan || 1;
    td.textContent = text;
    return td;
  }
  function thEmpty(colspan) {
    const td = document.createElement('td');
    td.colSpan = colspan || 1;
    return td;
  }

  // Column layout (left → right):
  // [R32 name][R32 score][conn][gap][R16 name][R16 score][conn][gap][QF name][QF score][conn][gap][SF name][SF score][conn][gap] | FINAL | [gap][conn][SF name][SF score][gap][conn][QF name][QF score][gap][conn][R16 name][R16 score][gap][conn][R32 name][R32 score]
  // Each round: 2 cols (name+score) + 1 conn + 1 gap = 4 cols. 4 rounds × 4 = 16 per side. Center = 1 col.
  // Total = 16 + 1 + 16 = 33 cols.

  headerRow.appendChild(th('Round of 32', 3));
  headerRow.appendChild(thEmpty(1)); // gap
  headerRow.appendChild(th('Round of 16', 3));
  headerRow.appendChild(thEmpty(1));
  headerRow.appendChild(th('Quarterfinals', 3));
  headerRow.appendChild(thEmpty(1));
  headerRow.appendChild(th('Semifinals', 3));
  headerRow.appendChild(thEmpty(1));
  headerRow.appendChild(th('Final', 1));
  headerRow.appendChild(thEmpty(1));
  headerRow.appendChild(th('Semifinals', 3));
  headerRow.appendChild(thEmpty(1));
  headerRow.appendChild(th('Quarterfinals', 3));
  headerRow.appendChild(thEmpty(1));
  headerRow.appendChild(th('Round of 16', 3));
  headerRow.appendChild(thEmpty(1));
  headerRow.appendChild(th('Round of 32', 3));

  // ── Body rows ────────────────────────────────────────────
  const tbody = table.createTBody();

  // Pre-build all 96 rows
  const rows = [];
  for (let i = 0; i < TOTAL_ROWS; i++) {
    rows.push(tbody.insertRow());
  }

  // ── LEFT HALF ────────────────────────────────────────────

  // R32 left — 8 matches, 12 rows each
  HALF.left.r32.forEach((id, i) => {
    const rowsPerMatch = ROWS.r32;
    const startRow = i * rowsPerMatch;
    const m = b[id] || {};
    const home = m.home || null;
    const away = m.away || null;
    const pred = m.predicted_team || null;
    const homeWin = pred !== null && pred === home;
    const awayWin = pred !== null && pred === away;

    const t1r = startRow + 2;
    const t2r = startRow + 8;

    // Team cells
    rows[t1r].appendChild(teamCell(home, home ? homeWin : null));
    rows[t1r].appendChild(scoreCell(homeWin));
    rows[t2r].appendChild(teamCell(away, away ? awayWin : null));
    rows[t2r].appendChild(scoreCell(awayWin));

    // Connector: left vertical bar spanning both teams
    if (i % 2 === 0) {
      // Top match of a pair: connector spans down through bottom match
      const connTd = document.createElement('td');
      connTd.className = 'conn-left';
      connTd.rowSpan = rowsPerMatch * 2; // spans both matches in the pair
      rows[t1r].appendChild(connTd);
    }
  });

  // Gap column after R32 left connectors (spans all rows)
  const gapAfterR32L = document.createElement('td');
  gapAfterR32L.className = 'gap';
  gapAfterR32L.rowSpan = TOTAL_ROWS;
  rows[0].appendChild(gapAfterR32L);

  // R16 left — 4 matches, 24 rows each
  HALF.left.r16.forEach((id, i) => {
    const rowsPerMatch = ROWS.r16;
    const startRow = i * rowsPerMatch;
    const m = b[id] || {};
    const home = m.home || null;
    const away = m.away || null;
    const pred = m.predicted_team || null;
    const homeWin = pred !== null && pred === home;
    const awayWin = pred !== null && pred === away;

    const t1r = startRow + 5;
    const t2r = startRow + 17;

    rows[t1r].appendChild(teamCell(home, home ? homeWin : null));
    rows[t1r].appendChild(scoreCell(homeWin));
    rows[t2r].appendChild(teamCell(away, away ? awayWin : null));
    rows[t2r].appendChild(scoreCell(awayWin));

    if (i % 2 === 0) {
      const connTd = document.createElement('td');
      connTd.className = 'conn-left';
      connTd.rowSpan = rowsPerMatch * 2;
      rows[t1r].appendChild(connTd);
    }
  });

  const gapAfterR16L = document.createElement('td');
  gapAfterR16L.className = 'gap';
  gapAfterR16L.rowSpan = TOTAL_ROWS;
  rows[0].appendChild(gapAfterR16L);

  // QF left — 2 matches, 48 rows each
  HALF.left.qf.forEach((id, i) => {
    const rowsPerMatch = ROWS.qf;
    const startRow = i * rowsPerMatch;
    const m = b[id] || {};
    const home = m.home || null;
    const away = m.away || null;
    const pred = m.predicted_team || null;
    const homeWin = pred !== null && pred === home;
    const awayWin = pred !== null && pred === away;

    const t1r = startRow + 11;
    const t2r = startRow + 35;

    rows[t1r].appendChild(teamCell(home, home ? homeWin : null));
    rows[t1r].appendChild(scoreCell(homeWin));
    rows[t2r].appendChild(teamCell(away, away ? awayWin : null));
    rows[t2r].appendChild(scoreCell(awayWin));

    if (i % 2 === 0) {
      const connTd = document.createElement('td');
      connTd.className = 'conn-left';
      connTd.rowSpan = TOTAL_ROWS;
      rows[t1r].appendChild(connTd);
    }
  });

  const gapAfterQFL = document.createElement('td');
  gapAfterQFL.className = 'gap';
  gapAfterQFL.rowSpan = TOTAL_ROWS;
  rows[0].appendChild(gapAfterQFL);

  // SF left — 1 match, 96 rows
  {
    const id = HALF.left.sf;
    const m = b[id] || {};
    const home = m.home || null;
    const away = m.away || null;
    const pred = m.predicted_team || null;
    const homeWin = pred !== null && pred === home;
    const awayWin = pred !== null && pred === away;

    rows[23].appendChild(teamCell(home, home ? homeWin : null));
    rows[23].appendChild(scoreCell(homeWin));
    rows[71].appendChild(teamCell(away, away ? awayWin : null));
    rows[71].appendChild(scoreCell(awayWin));

    const connTd = document.createElement('td');
    connTd.className = 'conn-left';
    connTd.rowSpan = TOTAL_ROWS;
    rows[23].appendChild(connTd);
  }

  const gapAfterSFL = document.createElement('td');
  gapAfterSFL.className = 'gap';
  gapAfterSFL.rowSpan = TOTAL_ROWS;
  rows[0].appendChild(gapAfterSFL);

  // ── CENTER: FINAL ────────────────────────────────────────
  {
    const m = b['FINAL'] || {};
    const pred = m.predicted_team || null;
    const tb_goals = (typeof tb === 'number') ? tb : null;

    const centerTd = document.createElement('td');
    centerTd.className = 'center-cell';
    centerTd.rowSpan = TOTAL_ROWS;

    const champion = document.createElement('div');
    champion.className = 'champion-callout';
    champion.textContent = pred ? `🏆 ${pred}` : '🏆 TBD';
    centerTd.appendChild(champion);

    const tbLabel = document.createElement('div');
    tbLabel.className = 'tiebreaker-label';
    tbLabel.textContent = 'Total goals scored in the final game';
    centerTd.appendChild(tbLabel);

    const tbValue = document.createElement('div');
    tbValue.className = 'tiebreaker-value';
    tbValue.textContent = tb_goals !== null ? tb_goals : '—';
    centerTd.appendChild(tbValue);

    rows[0].appendChild(centerTd);
  }

  // ── RIGHT HALF (mirror of left) ──────────────────────────

  // Gap before SF right
  const gapBeforeSFR = document.createElement('td');
  gapBeforeSFR.className = 'gap';
  gapBeforeSFR.rowSpan = TOTAL_ROWS;
  rows[0].appendChild(gapBeforeSFR);

  // SF right
  {
    const id = HALF.right.sf;
    const m = b[id] || {};
    const home = m.home || null;
    const away = m.away || null;
    const pred = m.predicted_team || null;
    const homeWin = pred !== null && pred === home;
    const awayWin = pred !== null && pred === away;

    // Connector on the left of the right-side SF (faces center)
    const connTd = document.createElement('td');
    connTd.className = 'conn-right';
    connTd.rowSpan = TOTAL_ROWS;
    rows[23].appendChild(connTd);

    rows[23].appendChild(scoreCell(homeWin));
    rows[23].appendChild(teamCell(home, home ? homeWin : null));
    rows[71].appendChild(scoreCell(awayWin));
    rows[71].appendChild(teamCell(away, away ? awayWin : null));
  }

  const gapAfterSFR = document.createElement('td');
  gapAfterSFR.className = 'gap';
  gapAfterSFR.rowSpan = TOTAL_ROWS;
  rows[0].appendChild(gapAfterSFR);

  // QF right — 2 matches, 48 rows each
  HALF.right.qf.forEach((id, i) => {
    const rowsPerMatch = ROWS.qf;
    const startRow = i * rowsPerMatch;
    const m = b[id] || {};
    const home = m.home || null;
    const away = m.away || null;
    const pred = m.predicted_team || null;
    const homeWin = pred !== null && pred === home;
    const awayWin = pred !== null && pred === away;

    const t1r = startRow + 11;
    const t2r = startRow + 35;

    if (i % 2 === 0) {
      const connTd = document.createElement('td');
      connTd.className = 'conn-right';
      connTd.rowSpan = TOTAL_ROWS;
      rows[t1r].appendChild(connTd);
    }
    rows[t1r].appendChild(scoreCell(homeWin));
    rows[t1r].appendChild(teamCell(home, home ? homeWin : null));
    rows[t2r].appendChild(scoreCell(awayWin));
    rows[t2r].appendChild(teamCell(away, away ? awayWin : null));
  });

  const gapAfterQFR = document.createElement('td');
  gapAfterQFR.className = 'gap';
  gapAfterQFR.rowSpan = TOTAL_ROWS;
  rows[0].appendChild(gapAfterQFR);

  // R16 right — 4 matches, 24 rows each
  HALF.right.r16.forEach((id, i) => {
    const rowsPerMatch = ROWS.r16;
    const startRow = i * rowsPerMatch;
    const m = b[id] || {};
    const home = m.home || null;
    const away = m.away || null;
    const pred = m.predicted_team || null;
    const homeWin = pred !== null && pred === home;
    const awayWin = pred !== null && pred === away;

    const t1r = startRow + 5;
    const t2r = startRow + 17;

    if (i % 2 === 0) {
      const connTd = document.createElement('td');
      connTd.className = 'conn-right';
      connTd.rowSpan = rowsPerMatch * 2;
      rows[t1r].appendChild(connTd);
    }
    rows[t1r].appendChild(scoreCell(homeWin));
    rows[t1r].appendChild(teamCell(home, home ? homeWin : null));
    rows[t2r].appendChild(scoreCell(awayWin));
    rows[t2r].appendChild(teamCell(away, away ? awayWin : null));
  });

  const gapAfterR16R = document.createElement('td');
  gapAfterR16R.className = 'gap';
  gapAfterR16R.rowSpan = TOTAL_ROWS;
  rows[0].appendChild(gapAfterR16R);

  // R32 right — 8 matches, 12 rows each
  HALF.right.r32.forEach((id, i) => {
    const rowsPerMatch = ROWS.r32;
    const startRow = i * rowsPerMatch;
    const m = b[id] || {};
    const home = m.home || null;
    const away = m.away || null;
    const pred = m.predicted_team || null;
    const homeWin = pred !== null && pred === home;
    const awayWin = pred !== null && pred === away;

    const t1r = startRow + 2;
    const t2r = startRow + 8;

    if (i % 2 === 0) {
      const connTd = document.createElement('td');
      connTd.className = 'conn-right';
      connTd.rowSpan = rowsPerMatch * 2;
      rows[t1r].appendChild(connTd);
    }
    rows[t1r].appendChild(scoreCell(homeWin));
    rows[t1r].appendChild(teamCell(home, home ? homeWin : null));
    rows[t2r].appendChild(scoreCell(awayWin));
    rows[t2r].appendChild(teamCell(away, away ? awayWin : null));
  });

  // Done — inject table
  document.getElementById('bracket-loading').classList.add('hidden');
  const wrap = document.getElementById('bracket-wrap');
  wrap.appendChild(table);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', init);
