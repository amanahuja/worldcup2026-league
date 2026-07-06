'use strict';

// ---------------------------------------------------------------------------
// Bracket round ordering — consecutive pairs feed the next round.
//
//   R32: 74,77 | 73,75 | 76,78 | 79,80 | 83,84 | 81,82 | 86,88 | 85,87
//   R16: 89,90 | 91,92 | 93,94 | 95,96
//   QF:  97,99 | 98,100
//   SF:  101,102
// ---------------------------------------------------------------------------

const ROUNDS = [
  {
    id: 'R32', label: 'Round of 32',
    matches: [
      'R32_74','R32_77','R32_73','R32_75',
      'R32_76','R32_78','R32_79','R32_80',
      'R32_83','R32_84','R32_81','R32_82',
      'R32_86','R32_88','R32_85','R32_87',
    ],
  },
  {
    id: 'R16', label: 'Round of 16',
    matches: ['R16_89','R16_90','R16_91','R16_92','R16_93','R16_94','R16_95','R16_96'],
  },
  {
    id: 'QF', label: 'Quarterfinals',
    matches: ['QF_97','QF_99','QF_98','QF_100'],
  },
  {
    id: 'SF', label: 'Semifinals',
    matches: ['SF_101','SF_102'],
  },
];

// Base match height in px. All other round heights are multiples.
// R32=1×, R16=2×, QF=4×, SF=8×
const BASE_H = 52;  // height of one R32 match slot

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
//   predicted_team — team name user picked to advance (null = no pick)
//   actual_winner  — team name that actually won     (null = not played)
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
  bracket: {
    // R32 — all played, mix of correct and wrong picks
    R32_74: makeDummy('Alien Alpha',    'Predator Alpha',   H, A),  // wrong
    R32_77: makeDummy('Alien Beta',     'Predator Beta',    H, H),  // correct
    R32_73: makeDummy('Alien Gamma',    'Predator Gamma',   A, A),  // correct
    R32_75: makeDummy('Alien Delta',    'Predator Delta',   H, H),  // correct
    R32_76: makeDummy('Alien Epsilon',  'Predator Epsilon', H, A),  // wrong
    R32_78: makeDummy('Alien Zeta',     'Predator Zeta',    A, A),  // correct
    R32_79: makeDummy('Alien Eta',      'Predator Eta',     H, H),  // correct
    R32_80: makeDummy('Alien Theta',    'Predator Theta',   A, H),  // wrong
    R32_83: makeDummy('Alien Iota',     'Predator Iota',    H, H),  // correct
    R32_84: makeDummy('Alien Kappa',    'Predator Kappa',   A, A),  // correct
    R32_81: makeDummy('Alien Lambda',   'Predator Lambda',  H, A),  // wrong
    R32_82: makeDummy('Alien Mu',       'Predator Mu',      A, A),  // correct
    R32_86: makeDummy('Alien Nu',       'Predator Nu',      H, H),  // correct
    R32_88: makeDummy('Alien Xi',       'Predator Xi',      A, H),  // wrong
    R32_85: makeDummy('Alien Omicron',  'Predator Omicron', H, H),  // correct
    R32_87: makeDummy('Alien Pi',       'Predator Pi',      A, A),  // correct

    // R16 — first two played, rest unplayed
    R16_89: makeDummy('Alien Beta',     'Alien Gamma',      H, H),  // correct, played
    R16_90: makeDummy('Predator Alpha', 'Alien Delta',      A, TBD),
    R16_91: makeDummy('Predator Epsilon','Alien Zeta',      A, TBD),
    R16_92: makeDummy('Alien Eta',      'Predator Theta',   H, TBD),
    R16_93: makeDummy('Alien Iota',     'Alien Kappa',      H, H),  // correct, played
    R16_94: makeDummy('Predator Lambda','Alien Mu',         A, TBD),
    R16_95: makeDummy('Alien Nu',       'Predator Xi',      H, TBD),
    R16_96: makeDummy('Alien Omicron',  'Alien Pi',         H, TBD),

    // QF — all unplayed
    QF_97:  makeDummy('Alien Beta',     'Alien Delta',      H, TBD),
    QF_99:  makeDummy('Alien Zeta',     'Alien Eta',        A, TBD),
    QF_98:  makeDummy('Alien Iota',     'Alien Mu',         H, TBD),
    QF_100: makeDummy('Alien Nu',       'Alien Omicron',    A, TBD),

    // SF — all unplayed
    SF_101: makeDummy('Alien Beta',     'Alien Mu',         A, TBD),
    SF_102: makeDummy('Alien Zeta',     'Alien Nu',         H, TBD),

    // Final + Third — all unplayed
    FINAL:  makeDummy('Alien Mu',       'Alien Zeta',       H, TBD),
    THIRD:  makeDummy('Alien Beta',     'Alien Nu',         A, TBD),
  },
  username: 'alien',
  tiebreaker_goals: 5,
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function init() {
  const params = new URLSearchParams(window.location.search);
  const user   = params.get('user');

  // No ?user= param — fall back to dummy data for local dev/testing
  if (!user) {
    document.getElementById('picks-username').textContent = DUMMY.username;
    document.getElementById('bracket-loading').classList.add('hidden');
    document.title = `${DUMMY.username} · WC2026 picks`;
    renderBracket(DUMMY);
    return;
  }

  document.getElementById('picks-username').textContent = user;
  document.title = `${user} · WC2026 picks`;

  try {
    const res = await fetch(`/api/picks/${encodeURIComponent(user)}`);
    if (res.status === 404) { showError(`User "${user}" not found.`); return; }
    if (!res.ok)            { showError('Failed to load picks. Please try again.'); return; }
    const data = await res.json();
    document.getElementById('picks-username').textContent = data.username;
    document.getElementById('bracket-loading').classList.add('hidden');
    renderBracket(data);
  } catch (e) {
    console.error('picks fetch error:', e);
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
// Team state classes — two independent axes:
//   picked:  stronger border + bold (user selected this team to advance)
//   result:  text color (green = won, red = lost, default = unplayed)
// ---------------------------------------------------------------------------

function teamClasses(match, side) {
  const team   = match[side];
  const picked = match.predicted_team === team;
  const actual = match.actual_winner;
  const cls    = ['team'];

  if (!team) { cls.push('tbd'); return cls.join(' '); }

  if (picked) cls.push('picked');
  if (actual !== null) {
    // A picked team is only "correct" if the chain leading to this match is also
    // valid (i.e. the user correctly predicted all feeder match results on this
    // side). chain_valid is false when a now-eliminated team was predicted to
    // reach this round — mirrors the scoring logic in scores-worker.js.
    const isCorrect = actual === team && match.chain_valid !== false;
    cls.push(isCorrect ? 'won' : 'lost');
  }

  return cls.join(' ');
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls)  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function makeTeamDiv(match, side, extraClass) {
  const name = match[side];
  const cls  = teamClasses(match, side);
  const div  = el('div', extraClass ? cls + ' ' + extraClass : cls);
  div.textContent = displayName(name);
  if (name) div.title = name;
  return div;
}

function makeMatchDiv(match, matchH) {
  const div = el('div', 'match');
  div.style.height = matchH + 'px';
  div.appendChild(makeTeamDiv(match, 'home'));
  div.appendChild(makeTeamDiv(match, 'away'));
  return div;
}

// ---------------------------------------------------------------------------
// Bracket renderer — flexbox columns
// ---------------------------------------------------------------------------

function renderBracket(data) {
  const b  = data.bracket;
  const tb = data.tiebreaker_goals;

  const wrap    = document.getElementById('bracket-wrap');
  const headers = document.getElementById('round-headers');
  wrap.innerHTML    = '';
  headers.innerHTML = '';

  // Total bracket height — determined by R32: 16 matches × BASE_H
  const totalH = ROUNDS[0].matches.length * BASE_H;  // 16 × 44 = 704px

  // ── Build each round column + connector ──────────────────
  ROUNDS.forEach((round, ri) => {
    const matchCount = round.matches.length;
    const matchH     = totalH / matchCount;   // each match's allocated height

    // Header label
    const hdr = el('div', 'round-header', round.label);
    headers.appendChild(hdr);

    // Round column
    const col = el('div', `round round-${round.id}`);
    col.style.height = totalH + 'px';

    for (const id of round.matches) {
      const match = b[id] || { home: null, away: null, predicted_team: null, actual_winner: null };
      col.appendChild(makeMatchDiv(match, matchH));
    }
    wrap.appendChild(col);

    // Connector column (not after the last round)
    if (ri < ROUNDS.length - 1) {
      const nextMatchH = totalH / (matchCount / 2);  // next round's match height
      const connCol = el('div', 'conn-col');
      connCol.style.height = totalH + 'px';

      // One connector per pair of matches → feeds one next-round match
      const pairCount = matchCount / 2;
      for (let p = 0; p < pairCount; p++) {
        const conn = el('div', 'connector');
        conn.style.height = nextMatchH + 'px';
        connCol.appendChild(conn);
      }
      wrap.appendChild(connCol);

      // Spacer header above connector col
      headers.appendChild(el('div', 'round-header-gap'));
    }
  });

  // ── Final panel ───────────────────────────────────────────
  // Header spacer
  headers.appendChild(el('div', 'round-header', 'Final'));

  const panel = el('div', 'final-panel');
  panel.style.height = totalH + 'px';
  panel.appendChild(makeFinalPanel(b, tb));
  wrap.appendChild(panel);
}

// ---------------------------------------------------------------------------
// Final panel content
// ---------------------------------------------------------------------------

function makeFinalPanel(b, tb) {
  const inner = el('div', 'final-panel__inner');

  function matchBlock(label, matchId, extraClass) {
    const match = b[matchId] || { home: null, away: null, predicted_team: null, actual_winner: null };
    const block = el('div', 'final-block' + (extraClass ? ' ' + extraClass : ''));
    block.appendChild(el('div', 'final-block__label', label));
    block.appendChild(makeTeamDiv(match, 'home', 'final-team'));
    block.appendChild(makeTeamDiv(match, 'away', 'final-team'));
    return block;
  }

  // Trophy callout — above the final block
  const finalM   = b['FINAL'] || {};
  const champion = finalM.actual_winner || finalM.predicted_team || null;
  const champ    = el('div', 'champion-callout',
    champion ? `\u{1F3C6} ${displayName(champion)}` : '\u{1F3C6} TBD');
  inner.appendChild(champ);

  // Final match block — centered vertically via CSS
  inner.appendChild(matchBlock('Final', 'FINAL', 'final-block--final'));

  // Tiebreaker — below the final block
  const tbDiv = el('div', 'final-tiebreaker',
    'Goals scored in the final: ' + (typeof tb === 'number' ? tb : '—'));
  inner.appendChild(tbDiv);

  // 3rd place — at the bottom
  inner.appendChild(matchBlock('3rd place', 'THIRD', 'final-block--third'));

  return inner;
}

document.addEventListener('DOMContentLoaded', init);
