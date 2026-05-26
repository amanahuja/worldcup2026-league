/**
 * app.js — WC 2026 Fantasy client-side application
 *
 * Handles:
 *  - Results page (index.html): leaderboard, match results, login modal
 *  - Predictions page (predictions.html): group stage picks, knockout picks, tiebreaker
 */

'use strict';

const App = (() => {

  // ── Config ───────────────────────────────────────────────
  const API = '';  // same origin — workers serve /api/* routes

  // ── State ────────────────────────────────────────────────
  let _session      = null;   // { username } or null
  let _scores       = null;   // GET /api/scores response
  let _predictions  = null;   // GET /api/predictions response
  let _currentTab   = 'groups';
  let _currentKoRound = 'R32';
  let _currentResultsStage = 'groups';
  let _saveTimer    = null;

  // ── Helpers ──────────────────────────────────────────────

  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
    return m ? m[1] : null;
  }

  function getSessionUsername() {
    // Decode the base64 payload from the session cookie (first segment before '.')
    const token = getCookie('wc2026_session');
    if (!token) return null;
    try {
      const payload = JSON.parse(atob(token.split('.')[0]));
      if (payload.exp && Date.now() / 1000 > payload.exp) return null;
      return payload.username;
    } catch { return null; }
  }

  function initials(name) {
    return (name || '?').slice(0, 2).toUpperCase();
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  function fmtTs(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
      timeZoneName: 'short',
    });
  }

  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts,
    });
    return res;
  }

  function showSaved() {
    const el = document.getElementById('save-indicator');
    if (!el) return;
    el.classList.add('visible');
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => el.classList.remove('visible'), 1500);
  }

  // ── Login modal ──────────────────────────────────────────

  function showLoginModal() {
    document.getElementById('login-modal')?.classList.remove('hidden');
    document.getElementById('login-username')?.focus();
  }

  function hideLoginModal() {
    document.getElementById('login-modal')?.classList.add('hidden');
  }

  async function submitLogin(e) {
    e.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const passphrase = document.getElementById('login-passphrase').value;
    const errEl = document.getElementById('login-error');
    const btnEl = document.getElementById('login-submit-btn');
    errEl.textContent = '';
    btnEl.disabled = true;
    btnEl.textContent = 'Signing in…';

    try {
      const res = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username, passphrase }),
      });
      const data = await res.json();
      if (res.ok) {
        window.location.href = '/predictions.html';
      } else {
        errEl.textContent = data.error || 'Sign in failed';
      }
    } catch {
      errEl.textContent = 'Network error — please try again';
    } finally {
      btnEl.disabled = false;
      btnEl.textContent = 'Sign in';
    }
  }

  function ctaClick() {
    if (_session) {
      window.location.href = '/predictions.html';
    } else {
      showLoginModal();
    }
  }

  // ── Results page ─────────────────────────────────────────

  async function initResults() {
    _session = { username: getSessionUsername() };
    updateCtaBtn();

    // Check if redirected here with ?login=1
    if (new URLSearchParams(location.search).get('login') === '1') {
      showLoginModal();
    }

    await loadScores();
    renderLeaderboard();
    renderResultsGroups();

    document.getElementById('results-stage-tabs')
      ?.querySelectorAll('[data-stage]')
      .forEach(t => t.classList.toggle('tab--active', t.dataset.stage === _currentResultsStage));
  }

  function updateCtaBtn() {
    const btn = document.getElementById('cta-btn');
    if (!btn) return;
    if (_session?.username) {
      btn.textContent = 'Edit predictions';
    } else {
      btn.textContent = 'Make predictions';
    }
  }

  async function loadScores() {
    try {
      const res = await api('/api/scores');
      _scores = await res.json();
      const luEl = document.getElementById('last-updated');
      if (_scores.last_updated && luEl) {
        luEl.textContent = `Updated ${fmtTs(_scores.last_updated)}`;
        luEl.classList.remove('hidden');
      }
    } catch {
      _scores = { leaderboard: [], standings: {}, bracket: {} };
    }
  }

  function renderLeaderboard() {
    if (!_scores) return;
    const lb = _scores.leaderboard || [];
    const me = _session?.username;

    // Podium (top 3)
    const order = [2, 1, 3]; // left=2nd, centre=1st, right=3rd
    for (const pos of order) {
      const entry = lb[pos - 1];
      const avatar = document.getElementById(`pod-${pos}-avatar`);
      const name   = document.getElementById(`pod-${pos}-name`);
      const score  = document.getElementById(`pod-${pos}-score`);
      if (entry) {
        if (avatar) avatar.textContent = initials(entry.username);
        if (name)   name.textContent   = entry.username;
        if (score)  score.textContent  = `${entry.score} pts`;
        const slot = document.getElementById(`pod-${pos}`);
        if (slot && me && entry.username === me) slot.style.outline = '2px solid var(--c-blue)';
      }
    }

    // Full list
    const tbody = document.getElementById('lb-body');
    if (!tbody) return;
    if (!lb.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="text-muted" style="padding:20px;text-align:center">No data yet</td></tr>';
      return;
    }
    tbody.innerHTML = lb.map(e => `
      <tr class="${me && e.username === me ? 'lb-row--me' : ''}">
        <td class="lb-rank">${e.rank}</td>
        <td>
          <span class="lb-avatar">${initials(e.username)}</span>
          ${e.username}
        </td>
        <td>${e.score}</td>
      </tr>
    `).join('');
  }

  // ── Results — group cards ─────────────────────────────────

  function renderResultsGroups() {
    const grid = document.getElementById('results-groups-grid');
    if (!grid || !_scores) return;
    const standings = _scores.standings || {};
    const groups = Object.keys(standings).sort();
    if (!groups.length) {
      grid.innerHTML = '<div class="text-muted" style="grid-column:1/-1;padding:20px;text-align:center">Fixtures load June 11</div>';
      return;
    }
    grid.innerHTML = groups.map(g => renderResultsGroupCard(g, standings[g])).join('');
  }

  function renderResultsGroupCard(letter, standings) {
    const results = _scores?.bracket || {};
    const me = _session?.username;
    // User predictions (if loaded on results page we'd need to fetch — skip for now, show scores only)
    const topTwo = standings.slice(0, 2).map(s => s.team);

    const standingsRows = standings.map((s, i) => `
      <tr class="${i < 2 ? 'qualified-actual' : ''}">
        <td class="standings-team">
          <span class="team-name" title="${s.team}">${s.team}</span>
        </td>
        <td>${s.played}</td>
        <td>${s.won}</td>
        <td>${s.drawn}</td>
        <td>${s.lost}</td>
        <td class="pts">${s.pts}</td>
      </tr>
    `).join('');

    return `
      <div class="group-card">
        <div class="group-card__header">Group ${letter}</div>
        <table class="standings">
          <thead>
            <tr>
              <th style="text-align:left;font-size:0.6rem;color:var(--c-muted);padding:3px 6px">Team</th>
              <th>P</th><th>W</th><th>D</th><th>L</th><th>Pts</th>
            </tr>
          </thead>
          <tbody>${standingsRows}</tbody>
        </table>
        <div class="fixtures-divider">Fixtures</div>
        <div id="results-fixtures-${letter}"></div>
      </div>
    `;
  }

  function setResultsStage(stage) {
    _currentResultsStage = stage;
    document.getElementById('results-groups').classList.toggle('hidden', stage !== 'groups');
    document.getElementById('results-knockout').classList.toggle('hidden', stage !== 'knockout');
    document.querySelectorAll('#results-stage-tabs [data-stage]').forEach(t => {
      t.classList.toggle('tab--active', t.dataset.stage === stage);
    });
    if (stage === 'knockout') renderResultsKnockout();
  }

  function renderResultsKnockout() {
    // Read-only bracket view — reuse bracket render from predictions page, picks disabled
    const container = document.getElementById('results-ko-view');
    if (!container) return;
    container.innerHTML = '<div class="text-muted" style="padding:20px;text-align:center">Knockout bracket loads June 28</div>';
  }

  // ── Predictions page ─────────────────────────────────────

  async function initPredictions() {
    _session = { username: getSessionUsername() };
    if (!_session.username) {
      window.location.href = '/?login=1';
      return;
    }

    const sub = document.getElementById('topbar-username');
    if (sub) sub.textContent = _session.username;

    await Promise.all([loadPredictions(), loadScores()]);
    renderGroupsTab();
    renderKnockoutTab();
    renderThirdTab();
    setTab('groups');
  }

  async function loadPredictions() {
    try {
      const res = await api('/api/predictions');
      if (res.status === 401) { window.location.href = '/?login=1'; return; }
      _predictions = await res.json();
    } catch {
      _predictions = { groups: { predictions: {}, locked: false }, knockout: { predictions: {}, locked: false, tiebreaker_goals: null } };
    }
  }

  function setTab(tab) {
    _currentTab = tab;
    ['groups', 'knockout', 'third'].forEach(t => {
      document.getElementById(`tab-${t}`)?.classList.toggle('hidden', t !== tab);
      document.querySelector(`[data-tab="${t}"]`)?.classList.toggle('tab--active', t === tab);
    });
  }

  // ── Group Stage tab ───────────────────────────────────────

  function renderGroupsTab() {
    if (!_scores || !_predictions) return;
    const groupsYaml = _scores.standings || {};
    const groups = Object.keys(groupsYaml).sort();
    const locked = _predictions.groups?.locked;
    const picks = _predictions.groups?.predictions || {};
    const results = {}; // actual results from _scores

    const banner = document.getElementById('groups-banner');
    if (banner) {
      if (locked) {
        banner.textContent = 'Group stage predictions are locked.';
        banner.classList.remove('hidden');
        banner.classList.add('lock-banner--locked');
      } else {
        banner.textContent = 'Group stage predictions lock Jun 11';
        banner.classList.remove('hidden');
      }
    }

    const grid = document.getElementById('groups-grid');
    if (!grid) return;
    grid.innerHTML = groups.map(g => renderGroupCard(g, groupsYaml[g], picks, locked)).join('');
  }

  function getGroupFixtures(groupLetter) {
    // Derive fixture list from standings data + groups.yaml embedded in scores response
    // For the predictions page we rely on match IDs encoded as G_A1..G_L6
    const fixtures = [];
    for (let i = 1; i <= 6; i++) {
      fixtures.push({ id: `G_${groupLetter}${i}` });
    }
    return fixtures;
  }

  /**
   * Derives predicted standings from current picks + defaults for a group.
   * standings param comes from /api/scores if available (actual), else derived from picks.
   */
  function derivePickedStandings(groupLetter, groupTeams, picks) {
    const stats = {};
    for (const team of groupTeams) {
      stats[team] = { team, played: 0, won: 0, drawn: 0, lost: 0, pts: 0 };
    }

    // We don't have the fixture home/away from standings alone — use known fixture pattern
    // from groups.yaml. For simplicity encode fixture home/away in the ID's expected pick.
    // The actual home/away is loaded via _scores.bracket or derived from groups.yaml.
    // Since scores-worker doesn't expose per-group fixtures explicitly in GET /api/scores,
    // we'll derive standings from actual results if available, or show predictions-based.
    // This is an approximation — full implementation reads groups.yaml structure.
    return Object.values(stats).sort((a, b) => b.pts - a.pts || b.won - a.won || a.team.localeCompare(b.team));
  }

  function renderGroupCard(letter, standingsData, picks, locked) {
    const teams = standingsData?.map(s => s.team) || [];
    const isLive = standingsData?.some(s => s.played > 0);

    // Build standings rows
    const standingsRows = (standingsData || []).map((s, i) => `
      <tr class="${i < 2 ? (isLive ? 'qualified-actual' : 'qualified') : ''}">
        <td>
          <span style="font-size:0.7rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;max-width:72px" title="${s.team}">${s.team}</span>
        </td>
        <td>${s.played}</td>
        <td>${s.won}</td>
        <td>${s.drawn}</td>
        <td>${s.lost}</td>
        <td class="pts">${s.pts}</td>
      </tr>
    `).join('');

    // Build fixture rows (match IDs G_X1..G_X6)
    const fixtureRows = [1,2,3,4,5,6].map(i => {
      const matchId = `G_${letter}${i}`;
      const pick = picks[matchId];
      const winner = pick?.predicted_winner;
      const isDefault = pick?._default;
      return renderFixtureRow(matchId, null, null, null, winner, isDefault, locked, 'groups');
    }).join('');

    return `
      <div class="group-card">
        <div class="group-card__header">Group ${letter}</div>
        <table class="standings">
          <thead>
            <tr>
              <th style="text-align:left;font-size:0.6rem;color:var(--c-muted);padding:3px 6px">Team</th>
              <th>P</th><th>W</th><th>D</th><th>L</th><th>Pts</th>
            </tr>
          </thead>
          <tbody>${standingsRows || '<tr><td colspan="6" style="padding:6px;color:var(--c-muted);font-size:0.7rem;text-align:center">—</td></tr>'}</tbody>
        </table>
        <div class="fixtures-divider">Fixtures</div>
        ${fixtureRows}
      </div>
    `;
  }

  /**
   * Renders a single fixture row.
   * homeAbbr/awayAbbr: 3-letter codes for pick buttons.
   * score: e.g. "2 – 1" or date string.
   * winner: "home" | "away" | "draw" — current pick.
   * isDefault: boolean.
   * locked: boolean.
   * window: "groups" | "knockout".
   */
  function renderFixtureRow(matchId, homeAbbr, awayAbbr, score, winner, isDefault, locked, window) {
    const hl = homeAbbr || 'H';
    const al = awayAbbr || 'A';
    const sc = score || '—';

    function btnClass(side) {
      if (winner === side) return isDefault ? 'pick-btn pick-btn--default' : 'pick-btn pick-btn--selected';
      return 'pick-btn';
    }
    const drawBtn = window === 'groups'
      ? `<button class="pick-btn pick-btn--draw ${winner === 'draw' ? (isDefault ? 'pick-btn--default' : 'pick-btn--selected') : ''}"
           ${locked ? 'disabled' : ''}
           onclick="App.pick('${matchId}', 'draw', '${window}')">Draw</button>`
      : '';

    return `
      <div class="fixture" id="fixture-${matchId}">
        <div class="fixture__header">
          <span class="fixture__team">${hl}</span>
          <span class="fixture__score">${sc}</span>
          <span class="fixture__team fixture__team--away">${al}</span>
        </div>
        <div class="fixture__buttons">
          <button class="pick-btn ${btnClass('home')}"
            ${locked ? 'disabled' : ''}
            onclick="App.pick('${matchId}', 'home', '${window}')">${hl}</button>
          ${drawBtn}
          <button class="pick-btn ${btnClass('away')}"
            ${locked ? 'disabled' : ''}
            onclick="App.pick('${matchId}', 'away', '${window}')">${al}</button>
        </div>
      </div>
    `;
  }

  // ── Pick handler ─────────────────────────────────────────

  async function pick(matchId, value, window) {
    if (!_predictions) return;
    const section = window === 'groups' ? _predictions.groups : _predictions.knockout;
    if (section.locked) return;

    // Optimistic update
    if (!section.predictions) section.predictions = {};
    section.predictions[matchId] = { predicted_winner: value, _default: false };

    // Re-render the fixture row
    updateFixtureRow(matchId, value, false, section.locked, window);

    // Save to API
    const endpoint = window === 'groups' ? '/api/predictions/groups' : '/api/predictions/knockout';
    try {
      const res = await api(endpoint, {
        method: 'POST',
        body: JSON.stringify({ match_id: matchId, predicted_winner: value }),
      });
      if (res.ok) {
        showSaved();
      }
    } catch {
      // Silently fail — pick is still shown optimistically
    }
  }

  function updateFixtureRow(matchId, winner, isDefault, locked, window) {
    const el = document.getElementById(`fixture-${matchId}`);
    if (!el) return;
    const btns = el.querySelectorAll('.pick-btn');
    const sides = ['home', 'draw', 'away'];
    btns.forEach((btn, i) => {
      const side = sides[i];
      btn.className = 'pick-btn' + (side === 'draw' ? ' pick-btn--draw' : '');
      if (winner === side) {
        btn.classList.add(isDefault ? 'pick-btn--default' : 'pick-btn--selected');
      }
    });
  }

  // ── Knockout tab ─────────────────────────────────────────

  const KO_ROUNDS = {
    R32:   ['R32_73','R32_74','R32_75','R32_76','R32_77','R32_78','R32_79','R32_80',
            'R32_81','R32_82','R32_83','R32_84','R32_85','R32_86','R32_87','R32_88'],
    R16:   ['R16_89','R16_90','R16_91','R16_92','R16_93','R16_94','R16_95','R16_96'],
    QF:    ['QF_97','QF_98','QF_99','QF_100'],
    SF:    ['SF_101','SF_102'],
    Final: ['FINAL'],
  };

  const NEXT_ROUND = { R32: 'R16', R16: 'QF', QF: 'SF', SF: 'Final', Final: null };

  function renderKnockoutTab() {
    if (!_predictions) return;
    const locked = _predictions.knockout?.locked;
    const banner = document.getElementById('knockout-banner');
    if (banner) {
      if (locked) {
        banner.textContent = 'Knockout predictions are locked.';
        banner.classList.remove('hidden');
        banner.classList.add('lock-banner--locked');
      } else {
        banner.textContent = 'Knockout predictions lock Jun 29';
        banner.classList.remove('hidden');
      }
    }
    setKoRound(_currentKoRound);
  }

  function setKoRound(round) {
    _currentKoRound = round;
    document.querySelectorAll('#ko-round-tabs .round-tab').forEach(t => {
      t.classList.toggle('round-tab--active', t.dataset.round === round);
    });
    renderKoBracketView(round);
  }

  function renderKoBracketView(round) {
    const container = document.getElementById('ko-bracket-view');
    if (!container) return;
    const locked = _predictions?.knockout?.locked;
    const picks   = _predictions?.knockout?.predictions || {};
    const bracket = _scores?.bracket || {};
    const matchIds = KO_ROUNDS[round] || [];
    const nextRound = NEXT_ROUND[round];
    const nextIds = nextRound ? KO_ROUNDS[nextRound] : [];

    if (!matchIds.length) { container.innerHTML = ''; return; }

    // Build left column (current round)
    const leftCards = matchIds.map((id, idx) => {
      const bm = bracket[id] || {};
      const home = bm.home || '?';
      const away = bm.away || '?';
      const winner = picks[id]?.predicted_winner;
      const isDefault = picks[id]?._default;
      const result = _scores?.bracket?.[id];
      const status = result?.status || 'scheduled';
      const score = status === 'completed'
        ? `${result.home_score ?? 0} – ${result.away_score ?? 0}`
        : (bm.date ? fmtDate(bm.date) : '—');

      // Abbreviate long team names
      const ha = abbr(home);
      const aa = abbr(away);

      function btnClass(side) {
        if (winner === side) return isDefault ? 'pick-btn pick-btn--default' : 'pick-btn pick-btn--selected';
        return 'pick-btn';
      }

      return `
        <div class="ko-card" id="ko-${id}" data-idx="${idx}">
          <div class="ko-card__matchup">
            <span class="ko-card__team" title="${home}">${home}</span>
            <span class="ko-card__score${status === 'live' ? ' ko-card__score--live' : ''}">${score}</span>
            <span class="ko-card__team ko-card__team--away" title="${away}">${away}</span>
          </div>
          <div class="ko-card__buttons">
            <button class="pick-btn ${btnClass('home')}" ${locked ? 'disabled' : ''}
              onclick="App.pick('${id}', 'home', 'knockout')">${ha}</button>
            <button class="pick-btn ${btnClass('away')}" ${locked ? 'disabled' : ''}
              onclick="App.pick('${id}', 'away', 'knockout')">${aa}</button>
          </div>
        </div>
      `;
    }).join('');

    // Build right column (next round — dimmed)
    let rightCards = '';
    if (nextIds.length) {
      rightCards = nextIds.map(id => {
        const bm = bracket[id] || {};
        return `
          <div class="ko-card ko-card--dim">
            <div class="ko-card__matchup">
              <span class="ko-card__team ko-card__placeholder">${bm.home || 'TBD'}</span>
              <span class="ko-card__score">—</span>
              <span class="ko-card__team ko-card__team--away ko-card__placeholder">${bm.away || 'TBD'}</span>
            </div>
          </div>
        `;
      }).join('');
    }

    // Tiebreaker (Final tab only)
    let tiebreakerHtml = '';
    if (round === 'Final') {
      const tb = _predictions?.knockout?.tiebreaker_goals;
      const tbLocked = locked;
      tiebreakerHtml = `
        <div class="tiebreaker">
          <div class="tiebreaker__label">How many total goals will be scored in the Final?</div>
          <div class="tiebreaker__input-row">
            <input class="tiebreaker__input" type="number" min="0" step="1"
              id="tiebreaker-input"
              value="${tb !== null && tb !== undefined ? tb : ''}"
              placeholder="—"
              ${tbLocked ? 'disabled' : ''}
              oninput="App.saveTiebreaker(this.value)">
            <span class="tiebreaker__hint">whole goals only</span>
          </div>
        </div>
      `;
    }

    // SVG connector lines — drawn via JS after render
    const connectorHtml = nextIds.length
      ? `<div class="bracket-connector" id="ko-connector"></div>`
      : '';

    if (nextIds.length) {
      container.innerHTML = `
        <div style="display:flex;gap:0;align-items:flex-start">
          <div style="flex:0 0 62%;display:flex;flex-direction:column;gap:12px">${leftCards}</div>
          ${connectorHtml}
          <div style="flex:0 0 34%;opacity:0.4;display:flex;flex-direction:column;gap:12px">${rightCards}</div>
        </div>
        ${tiebreakerHtml}
      `;
      requestAnimationFrame(() => drawConnectors(matchIds.length, nextIds.length));
    } else {
      container.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:12px">${leftCards}</div>
        ${tiebreakerHtml}
      `;
    }
  }

  function abbr(name) {
    // Return a short abbreviation for display in buttons
    if (!name || name === '?') return '?';
    const known = {
      'Mexico':'MEX','South Africa':'RSA','South Korea':'KOR','Czech Republic':'CZE',
      'Canada':'CAN','Bosnia & Herzegovina':'BIH','Qatar':'QAT','Switzerland':'SUI',
      'Brazil':'BRA','Morocco':'MAR','Haiti':'HAI','Scotland':'SCO',
      'USA':'USA','Paraguay':'PAR','Australia':'AUS','Turkey':'TUR',
      'Germany':'GER','Curaçao':'CUW','Ivory Coast':'CIV','Ecuador':'ECU',
      'Netherlands':'NED','Japan':'JPN','Sweden':'SWE','Tunisia':'TUN',
      'Belgium':'BEL','Egypt':'EGY','Iran':'IRN','New Zealand':'NZL',
      'Spain':'ESP','Cape Verde':'CPV','Saudi Arabia':'KSA','Uruguay':'URU',
      'France':'FRA','Senegal':'SEN','Iraq':'IRQ','Norway':'NOR',
      'Argentina':'ARG','Algeria':'ALG','Austria':'AUT','Jordan':'JOR',
      'Portugal':'POR','DR Congo':'COD','Uzbekistan':'UZB','Colombia':'COL',
      'England':'ENG','Croatia':'CRO','Ghana':'GHA','Panama':'PAN',
    };
    return known[name] || name.slice(0, 3).toUpperCase();
  }

  // ── SVG connector lines ───────────────────────────────────

  function drawConnectors(leftCount, rightCount) {
    const container = document.getElementById('ko-connector');
    if (!container) return;
    const leftCards = document.querySelectorAll('[id^="ko-R"], [id^="ko-Q"], [id^="ko-S"], [id^="ko-F"]');
    if (!leftCards.length) return;

    const containerRect = container.getBoundingClientRect();
    const h = containerRect.height || 400;
    const w = 20;

    // Build SVG paths connecting pairs
    let paths = '';
    for (let i = 0; i < leftCount - 1; i += 2) {
      const c1 = leftCards[i];
      const c2 = leftCards[i + 1];
      if (!c1 || !c2) continue;
      const r1 = c1.getBoundingClientRect();
      const r2 = c2.getBoundingClientRect();
      const y1 = r1.top + r1.height / 2 - containerRect.top;
      const y2 = r2.top + r2.height / 2 - containerRect.top;
      const ym = (y1 + y2) / 2;
      paths += `<polyline points="0,${y1} ${w/2},${y1} ${w/2},${ym} ${w},${ym}" fill="none" stroke="var(--c-border)" stroke-width="1"/>`;
      paths += `<polyline points="0,${y2} ${w/2},${y2} ${w/2},${ym}" fill="none" stroke="var(--c-border)" stroke-width="1"/>`;
    }

    container.innerHTML = `<svg width="${w}" height="${h}" style="position:absolute;top:0;left:0">${paths}</svg>`;
    container.style.position = 'relative';
    container.style.height = `${h}px`;
  }

  // ── Third-place tab ───────────────────────────────────────

  function renderThirdTab() {
    if (!_predictions) return;
    const locked = _scores?.locks?.third_place || false;
    const picks  = _predictions.knockout?.predictions || {};
    const bracket = _scores?.bracket || {};
    const bm = bracket['THIRD'] || {};
    const winner = picks['THIRD']?.predicted_winner;
    const isDefault = picks['THIRD']?._default;

    const banner = document.getElementById('third-banner');
    if (banner) {
      if (locked) {
        banner.textContent = 'Third-place predictions are locked.';
        banner.classList.remove('hidden');
        banner.classList.add('lock-banner--locked');
      } else {
        banner.textContent = '3rd place predictions lock ~Jul 16 (when both semi-finals confirm)';
        banner.classList.remove('hidden');
      }
    }

    const container = document.getElementById('third-match-container');
    if (!container) return;

    const home = bm.home || 'TBD';
    const away = bm.away || 'TBD';
    const ha = abbr(home), aa = abbr(away);

    function btnClass(side) {
      if (winner === side) return isDefault ? 'pick-btn pick-btn--default' : 'pick-btn pick-btn--selected';
      return 'pick-btn';
    }

    container.innerHTML = `
      <div class="ko-card">
        <div class="ko-card__meta">3rd Place · Jul 18 · Miami</div>
        <div class="ko-card__matchup">
          <span class="ko-card__team" title="${home}">${home}</span>
          <span class="ko-card__score">—</span>
          <span class="ko-card__team ko-card__team--away" title="${away}">${away}</span>
        </div>
        <div class="ko-card__buttons">
          <button class="pick-btn ${btnClass('home')}" ${locked ? 'disabled' : ''}
            onclick="App.pick('THIRD', 'home', 'knockout')">${ha}</button>
          <button class="pick-btn ${btnClass('away')}" ${locked ? 'disabled' : ''}
            onclick="App.pick('THIRD', 'away', 'knockout')">${aa}</button>
        </div>
      </div>
    `;
  }

  // ── Tiebreaker save ───────────────────────────────────────

  let _tbTimer = null;
  function saveTiebreaker(value) {
    clearTimeout(_tbTimer);
    _tbTimer = setTimeout(async () => {
      try {
        const res = await api('/api/predictions/knockout', {
          method: 'POST',
          body: JSON.stringify({ tiebreaker_goals: value === '' ? null : parseInt(value, 10) }),
        });
        if (res.ok) showSaved();
      } catch { /* silent */ }
    }, 600);
  }

  // ── Public API ───────────────────────────────────────────

  return {
    initResults,
    initPredictions,
    ctaClick,
    submitLogin,
    setTab,
    setKoRound,
    setResultsStage,
    pick,
    saveTiebreaker,
  };

})();
