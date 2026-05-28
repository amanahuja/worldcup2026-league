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
    // Cookie is HttpOnly so JS can't read it — use sessionStorage instead.
    // sessionStorage is populated on successful login and cleared on 401.
    return sessionStorage.getItem('wc2026_user') || null;
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
        sessionStorage.setItem('wc2026_user', data.username);
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

  // Prediction window closes at first kickoff: Jun 11 2026 19:00 UTC
  const LOCK_DATE_GROUPS = new Date('2026-06-11T19:00:00Z');

  function initCountdown() {
    const banner = document.getElementById('countdown-banner');
    const textEl = document.getElementById('countdown-text');
    if (!banner || !textEl) return;

    // Hide entirely after Jun 11
    if (Date.now() >= LOCK_DATE_GROUPS.getTime()) return;

    banner.classList.remove('hidden');

    // Show join button only when not logged in
    const joinBtn = document.getElementById('countdown-join');
    if (joinBtn && !_session?.username) joinBtn.classList.remove('hidden');

    function tick() {
      const now = Date.now();
      const diff = LOCK_DATE_GROUPS.getTime() - now;
      if (diff <= 0) {
        banner.classList.add('hidden');
        return;
      }
      const days  = Math.floor(diff / 86400000);
      const hours = Math.floor((diff % 86400000) / 3600000);
      const mins  = Math.floor((diff % 3600000)  / 60000);
      textEl.innerHTML =
        `<span>${days}d ${hours}h ${mins}m</span> left to enter group stage predictions`;
    }

    tick();
    setInterval(tick, 30000); // update every 30s
  }

  // Returns the active stage + knockout round based on today's date
  function getActiveStage() {
    const now = Date.now();
    const d = (y, m, day) => new Date(`2026-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}T00:00:00Z`).getTime();
    if (now < d(2026,6,28))  return { stage: 'groups',   round: null };
    if (now < d(2026,7,4))   return { stage: 'knockout', round: 'R32' };
    if (now < d(2026,7,9))   return { stage: 'knockout', round: 'R16' };
    if (now < d(2026,7,13))  return { stage: 'knockout', round: 'QF' };
    if (now < d(2026,7,17))  return { stage: 'knockout', round: 'SF' };
    return                          { stage: 'knockout', round: 'Final' };
  }

  async function initResults() {
    _session = { username: getSessionUsername() };
    updateCtaBtn();
    initCountdown();

    // Check if redirected here with ?login=1
    if (new URLSearchParams(location.search).get('login') === '1') {
      showLoginModal();
    }

    // Load scores always; load predictions only if logged in (for overlay), no redirect on 401
    await Promise.all([
      loadScores(),
      _session.username ? loadPredictions(false) : Promise.resolve(),
    ]);

    renderLeaderboard();

    // Auto-navigate to the active stage
    const { stage, round } = getActiveStage();
    _currentResultsStage = stage;
    if (round) _currentKoRound = round;

    setResultsStage(stage);
  }

  function updateCtaBtn() {
    const btn = document.getElementById('cta-btn');
    if (!btn) return;
    if (_session?.username) {
      btn.textContent = 'Edit Predictions';
      // Show username in topbar sub-line (results page only)
      const sub = document.getElementById('topbar-username');
      if (sub) sub.textContent = _session.username;
    } else {
      btn.textContent = 'Enter Predictions';
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
      _scores = { leaderboard: [], standings: {}, fixtures: {}, bracket: {} };
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
        // No podium highlight — only the leaderboard table row is highlighted
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

  function renderResultsGroupCard(letter, standingsObj) {
    // standingsObj is now { teams: [...], hasResults: bool }
    const teams      = standingsObj?.teams || standingsObj || [];
    const hasResults = standingsObj?.hasResults || false;
    const fixtures   = (_scores?.fixtures || {})[letter] || [];

    const standingsRows = teams.map((s, i) => `
      <tr class="${i < 2 && hasResults ? 'qualified-actual' : ''}">
        <td><span style="font-size:0.7rem;font-weight:600;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${s.team}">${s.team}</span></td>
        <td>${s.played}</td>
        <td>${s.won}</td>
        <td>${s.drawn}</td>
        <td>${s.lost}</td>
        <td class="pts">${s.pts}</td>
      </tr>
    `).join('');

    const userPicks = _predictions?.groups?.predictions || {};
    const matchResults = _scores?.match_results || {};

    const fixtureRows = fixtures.map(m => {
      const result = matchResults[m.id] || {};
      const status = result.status || 'scheduled';
      let scoreStr, scoreClass;

      if (status === 'completed') {
        scoreStr = `${result.home_score ?? 0} – ${result.away_score ?? 0}`;
        // Overlay: compare user's pick to actual winner
        const pick = userPicks[m.id]?.predicted_winner;
        if (pick && _session?.username) {
          scoreClass = pick === result.winner
            ? 'fixture__score--correct'
            : 'fixture__score--wrong';
        }
      } else if (status === 'live') {
        scoreStr  = `${result.home_score ?? 0} – ${result.away_score ?? 0}`;
        scoreClass = 'fixture__score--live';
      } else {
        scoreStr = fmtDate(m.kickoff_utc);
      }

      return `
        <div class="fixture">
          <div class="fixture__header">
            <span class="fixture__team">${m.home}</span>
            <span class="fixture__score ${scoreClass || ''}">${scoreStr}</span>
            <span class="fixture__team fixture__team--away">${m.away}</span>
          </div>
        </div>
      `;
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
        ${fixtureRows || '<div style="padding:6px 10px;font-size:0.7rem;color:var(--c-muted)">—</div>'}
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
    if (stage === 'groups') renderResultsGroups();
    if (stage === 'knockout') renderResultsKnockout();
  }

  function renderResultsKnockout() {
    // Render round tabs into #results-ko-tabs
    const tabsEl = document.getElementById('results-ko-tabs');
    if (tabsEl) {
      tabsEl.innerHTML = ['R32','R16','QF','SF','Final'].map(r => `
        <button class="round-tab ${r === _currentKoRound ? 'round-tab--active' : ''}"
          onclick="App.setResultsKoRound('${r}')">${r}</button>
      `).join('');
    }

    // Render bracket into #results-ko-view (read-only)
    renderKoBracketView(_currentKoRound, 'results-ko-view', true);
  }

  function setResultsKoRound(round) {
    _currentKoRound = round;
    document.querySelectorAll('#results-ko-tabs .round-tab').forEach(t => {
      t.classList.toggle('round-tab--active', t.textContent === round);
    });
    renderKoBracketView(round, 'results-ko-view', true);
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

    await Promise.all([loadPredictions(true), loadScores()]);
    renderGroupsTab();
    renderKnockoutTab();
    renderThirdTab();
    setTab('groups');
  }

  async function loadPredictions(redirectOn401 = false) {
    try {
      const res = await api('/api/predictions');
      if (res.status === 401) {
        sessionStorage.removeItem('wc2026_user');
        if (redirectOn401) window.location.href = '/?login=1';
        return;
      }
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
    const standingsMap = _scores.standings || {};
    const groups = Object.keys(standingsMap).sort();
    const locked = _predictions.groups?.locked;
    const picks  = _predictions.groups?.predictions || {};

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
    grid.innerHTML = groups.map(g => renderGroupCard(g, standingsMap[g], picks, locked)).join('');
  }

  function renderGroupCard(letter, standingsObj, picks, locked) {
    // standingsObj is { teams: [...], hasResults: bool }
    const teams      = standingsObj?.teams || standingsObj || [];
    const hasResults = standingsObj?.hasResults || false;
    const fixtures   = (_scores?.fixtures || {})[letter] || [];

    // Standings rows — only show qualification highlight if games have been played
    const standingsRows = teams.map((s, i) => `
      <tr class="${i < 2 && hasResults ? 'qualified-actual' : ''}">
        <td>
          <span style="font-size:0.7rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block" title="${s.team}">${s.team}</span>
        </td>
        <td>${s.played}</td>
        <td>${s.won}</td>
        <td>${s.drawn}</td>
        <td>${s.lost}</td>
        <td class="pts">${s.pts}</td>
      </tr>
    `).join('');

    // Fixture rows — use real home/away/abbr/date from fixtures data
    const fixtureRows = fixtures.map(m => {
      const pick      = picks[m.id];
      const winner    = pick?.predicted_winner;
      const isDefault = pick?._default;
      const score     = fmtDate(m.kickoff_utc); // pre-tournament: show date
      return renderFixtureRow(m.id, m.home_abbr, m.away_abbr, score, winner, isDefault, locked, 'groups');
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
        ${fixtureRows || '<div style="padding:6px 10px;font-size:0.7rem;color:var(--c-muted)">—</div>'}
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

    // Re-render the relevant card
    if (window === 'groups') {
      updateFixtureRow(matchId, value, false, section.locked);
    } else {
      updateKoCard(matchId, value, false);
      // Re-render the current bracket view to propagate the pick to next round
      renderKoBracketView(_currentKoRound);
    }

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

  function updateFixtureRow(matchId, winner, isDefault, locked) {
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

  function updateKoCard(matchId, winner, isDefault) {
    const el = document.getElementById(`ko-${matchId}`);
    if (!el) return;
    el.querySelectorAll('.pick-btn').forEach(btn => {
      const side = btn.dataset.side;
      btn.className = 'pick-btn';
      if (winner === side) {
        btn.classList.add(isDefault ? 'pick-btn--default' : 'pick-btn--selected');
      }
    });
  }

  // ── Knockout tab ─────────────────────────────────────────

  // R32 ordered so that each consecutive pair feeds into the same R16 match.
  // R16 ordered so that each consecutive pair feeds into the same QF match, etc.
  const KO_ROUNDS = {
    R32: [
      'R32_74','R32_77',  // → R16_89
      'R32_73','R32_75',  // → R16_90
      'R32_76','R32_78',  // → R16_91
      'R32_79','R32_80',  // → R16_92
      'R32_83','R32_84',  // → R16_93
      'R32_81','R32_82',  // → R16_94
      'R32_86','R32_88',  // → R16_95
      'R32_85','R32_87',  // → R16_96
    ],
    R16: [
      'R16_89','R16_90',  // → QF_97
      'R16_93','R16_94',  // → QF_98
      'R16_91','R16_92',  // → QF_99
      'R16_95','R16_96',  // → QF_100
    ],
    QF: [
      'QF_97','QF_98',    // → SF_101
      'QF_99','QF_100',   // → SF_102
    ],
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

  // Pre-tournament R32 seedings derived from default group predictions.
  // Used when server bracket slots are null (before June 28 group stage results).
  // Revert knockout gate date to 2026-06-28 before go-live.
  const PRE_TOURNAMENT_R32 = {
    // Group winners
    '1A':'Mexico',      '1B':'Switzerland', '1C':'Brazil',    '1D':'USA',
    '1E':'Germany',     '1F':'Netherlands', '1G':'Belgium',   '1H':'Spain',
    '1I':'France',      '1J':'Argentina',   '1K':'Colombia',  '1L':'England',
    // Runners-up
    '2A':'South Korea', '2B':'Canada',      '2C':'Morocco',   '2D':'Australia',
    '2E':'Ecuador',     '2F':'Japan',       '2G':'Iran',      '2H':'Uruguay',
    '2I':'Senegal',     '2J':'Algeria',     '2K':'Portugal',  '2L':'Croatia',
    // Best 8 third-place teams (constraint-solved assignment to slots)
    '3ABCDF':'Turkey',        '3CDFGH':'Egypt',
    '3CEFHI':'Saudi Arabia',  '3EHIJK':'DR Congo',
    '3BEFIJ':'Austria',       '3AEHIJ':'Czech Republic',
    '3EFGIJ':'Ivory Coast',   '3DEIJL':'Norway',
  };

  // Slot labels (home/away seeding) per R32 match ID
  const R32_SLOTS = {
    R32_74: { home:'1E',  away:'3ABCDF' }, R32_77: { home:'1I',  away:'3CDFGH' },
    R32_73: { home:'2A',  away:'2B'     }, R32_75: { home:'1F',  away:'2C'     },
    R32_76: { home:'1C',  away:'2F'     }, R32_78: { home:'2E',  away:'2I'     },
    R32_79: { home:'1A',  away:'3CEFHI' }, R32_80: { home:'1L',  away:'3EHIJK' },
    R32_83: { home:'2K',  away:'2L'     }, R32_84: { home:'1H',  away:'2J'     },
    R32_81: { home:'1D',  away:'3BEFIJ' }, R32_82: { home:'1G',  away:'3AEHIJ' },
    R32_86: { home:'1J',  away:'2H'     }, R32_88: { home:'2D',  away:'2G'     },
    R32_85: { home:'1B',  away:'3EFGIJ' }, R32_87: { home:'1K',  away:'3DEIJL' },
  };

  /**
   * Derive predicted bracket from user's current knockout picks.
   * Mirrors the server-side bracket logic but client-side, using picks not results.
   * Returns Map<matchId → { home, away }> with team names where known.
   */
  function derivePredictedBracket(picks) {
    const bracket = _scores?.bracket || {};
    const predicted = {};

    // R32: use server bracket teams if available (post-group-stage),
    // otherwise fall back to pre-tournament seedings
    for (const id of KO_ROUNDS.R32) {
      const bm    = bracket[id] || {};
      const slots = R32_SLOTS[id] || {};
      predicted[id] = {
        home: bm.home || (slots.home ? PRE_TOURNAMENT_R32[slots.home] : null) || null,
        away: bm.away || (slots.away ? PRE_TOURNAMENT_R32[slots.away] : null) || null,
      };
    }

    // For each subsequent round, derive home/away from the previous round's picks
    const FEEDERS = {
      R16_89:  ['R32_74','R32_77'], R16_90:  ['R32_73','R32_75'],
      R16_91:  ['R32_76','R32_78'], R16_92:  ['R32_79','R32_80'],
      R16_93:  ['R32_83','R32_84'], R16_94:  ['R32_81','R32_82'],
      R16_95:  ['R32_86','R32_88'], R16_96:  ['R32_85','R32_87'],
      QF_97:   ['R16_89','R16_90'], QF_98:   ['R16_93','R16_94'],
      QF_99:   ['R16_91','R16_92'], QF_100:  ['R16_95','R16_96'],
      SF_101:  ['QF_97','QF_98'],   SF_102:  ['QF_99','QF_100'],
      FINAL:   ['SF_101','SF_102'], THIRD:   ['SF_101','SF_102'],
    };

    function winnerOf(matchId) {
      // Use actual result if completed, otherwise user's pick
      const serverResult = bracket[matchId];
      if (serverResult?.status === 'completed' && serverResult.winner) {
        const pm = predicted[matchId] || {};
        return serverResult.winner === 'home' ? pm.home : pm.away;
      }
      const pick = picks[matchId]?.predicted_winner;
      if (!pick) return null;
      const pm = predicted[matchId] || {};
      return pick === 'home' ? pm.home : pm.away;
    }

    for (const rounds of [KO_ROUNDS.R16, KO_ROUNDS.QF, KO_ROUNDS.SF, ['FINAL']]) {
      for (const id of rounds) {
        const [f1, f2] = FEEDERS[id] || [];
        predicted[id] = {
          home: f1 ? winnerOf(f1) : null,
          away: f2 ? winnerOf(f2) : null,
        };
      }
    }

    // THIRD: losers of SF
    const sf1Pick = picks['SF_101']?.predicted_winner;
    const sf2Pick = picks['SF_102']?.predicted_winner;
    const sf1 = predicted['SF_101'] || {};
    const sf2 = predicted['SF_102'] || {};
    predicted['THIRD'] = {
      home: sf1Pick ? (sf1Pick === 'home' ? sf1.away : sf1.home) : null,
      away: sf2Pick ? (sf2Pick === 'home' ? sf2.away : sf2.home) : null,
    };

    return predicted;
  }

   function renderKoBracketView(round, containerId = 'ko-bracket-view', readOnly = false) {
     const container = document.getElementById(containerId);
     if (!container) return;
     const locked   = readOnly || _predictions?.knockout?.locked;
     const picks    = _predictions?.knockout?.predictions || {};
     const matchIds = KO_ROUNDS[round] || [];
     const nextRound = NEXT_ROUND[round];
     const nextIds  = nextRound ? KO_ROUNDS[nextRound] : [];

     if (!matchIds.length) { container.innerHTML = ''; return; }

     // Use server bracket data (actual results or defaults), not predicted bracket
     const serverBracket = _scores?.bracket || {};
     const matchResultsMap = _scores?.match_results || {};

     // Returns the CSS class for a team abbreviation button based on prediction correctness
     function teamBtnClass(id, side, status) {
       if (status !== 'completed' || !_session?.username) return '';
       const pick = picks[id];
       if (!pick?.predicted_winner) return '';
       const actual = matchResultsMap[id]?.winner;
       if (!actual) return '';
       const predicted = pick.predicted_winner;
       // Check if user's pick matches the team that advanced
       const teamMatch = (side === 'home' && predicted === 'home') || (side === 'away' && predicted === 'away');
       if (!teamMatch) return '';
       return actual === predicted ? 'ko-card__score--correct' : 'ko-card__score--wrong';
     }

     // Returns the CSS class for the score span based on prediction vs result
     function koScoreClass(id, pickWinner, status) {
       if (status !== 'completed' || !pickWinner || !_session?.username) return '';
       const actual = matchResultsMap[id]?.winner;
       if (!actual) return '';
       return pickWinner === actual ? 'ko-card__score--correct' : 'ko-card__score--wrong';
     }

     // Helper to build a single ko card (used in both leftCards and leftPair)
     function buildKoCard(id) {
       const bm        = serverBracket[id] || {};
       const home      = bm.home || 'TBD';
       const away      = bm.away || 'TBD';
       const pick      = picks[id];
       const winner    = pick?.predicted_winner;
       const isDefault = pick?._default;
       const status    = bm.status || 'scheduled';
       const scoreStr  = status === 'completed'
         ? `${bm.home_score ?? 0} – ${bm.away_score ?? 0}`
         : '—';
       const scoreClass = status === 'live'
         ? 'ko-card__score--live'
         : koScoreClass(id, winner, status);
       const ha = abbr(home), aa = abbr(away);
       const homeTeamClass = teamBtnClass(id, 'home', status);
       const awayTeamClass = teamBtnClass(id, 'away', status);

       function btnClass(side) {
         if (winner === side) return isDefault ? 'pick-btn pick-btn--default' : 'pick-btn pick-btn--selected';
         return 'pick-btn';
       }

       return `
         <div class="ko-card" id="ko-${id}">
           <div class="ko-card__matchup">
             <span class="ko-card__team" title="${home}">${home}</span>
             <span class="ko-card__score ${scoreClass}">${scoreStr}</span>
             <span class="ko-card__team ko-card__team--away" title="${away}">${away}</span>
           </div>
           <div class="ko-card__buttons">
             <button class="pick-btn ${btnClass('home')} ${homeTeamClass}" data-side="home" ${locked ? 'disabled' : ''}
               onclick="App.pick('${id}', 'home', 'knockout')">${ha}</button>
             <button class="pick-btn ${btnClass('away')} ${awayTeamClass}" data-side="away" ${locked ? 'disabled' : ''}
               onclick="App.pick('${id}', 'away', 'knockout')">${aa}</button>
           </div>
         </div>
       `;
     }

     // Build left column (current round)
     const leftCards = matchIds.map(id => buildKoCard(id)).join('');

     // Build right column — each next-round card paired with two left-column cards.
     // Wrap in a flex container per pair so each right card vertically centres
     // between its two feeders without needing JS measurements.
     let pairedHtml = '';
     if (nextIds.length) {
       // Group left cards into pairs, each pair beside one right card
       for (let i = 0; i < matchIds.length; i += 2) {
         const leftId1 = matchIds[i];
         const leftId2 = matchIds[i + 1];
         const rightId = nextIds[i / 2];
         const rbm = serverBracket[rightId] || {};
         const rHome = rbm.home || 'TBD';
         const rAway = rbm.away || 'TBD';

        // Left pair cards — reuse shared builder
        const leftPair = [leftId1, leftId2].filter(Boolean).map(id => buildKoCard(id)).join('');

        const rightCard = rightId ? `
          <div class="ko-card ko-card--dim" style="width:100%">
            <div class="ko-card__matchup">
              <span class="ko-card__team ko-card__placeholder" title="${rHome}">${abbr(rHome)}</span>
              <span class="ko-card__score">—</span>
              <span class="ko-card__team ko-card__team--away ko-card__placeholder" title="${rAway}">${abbr(rAway)}</span>
            </div>
          </div>
        ` : '';

        pairedHtml += `
          <div style="display:flex;gap:8px;align-items:stretch;margin-bottom:12px">
            <div style="flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:8px">${leftPair}</div>
            <div style="flex:0 0 12px;display:flex;align-items:center;justify-content:center">
              <div style="width:1px;height:60%;background:var(--c-border)"></div>
            </div>
            <div style="flex:0 0 38%;min-width:120px;display:flex;align-items:center">${rightCard}</div>
          </div>
        `;
      }
    }

    // Tiebreaker (Final tab only)
    let tiebreakerHtml = '';
    if (round === 'Final') {
      const tb = _predictions?.knockout?.tiebreaker_goals;
      tiebreakerHtml = `
        <div class="tiebreaker">
          <div class="tiebreaker__label">How many total goals will be scored in the Final?</div>
          <div class="tiebreaker__input-row">
            <input class="tiebreaker__input" type="number" min="0" step="1"
              id="tiebreaker-input"
              value="${tb !== null && tb !== undefined ? tb : ''}"
              placeholder="—"
              ${locked ? 'disabled' : ''}
              oninput="App.saveTiebreaker(this.value)">
            <span class="tiebreaker__hint">whole goals only</span>
          </div>
        </div>
      `;
    }

    if (nextIds.length) {
      container.innerHTML = `
        <div style="display:flex;flex-direction:column;width:100%">${pairedHtml}</div>
        ${tiebreakerHtml}
      `;
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

  // (SVG connector lines removed — layout handled via paired flex containers)

  // ── Third-place tab ───────────────────────────────────────

  function renderThirdTab() {
    if (!_predictions) return;
    const locked = _scores?.locks?.third_place || false;
    const picks  = _predictions.knockout?.predictions || {};
    const predicted = derivePredictedBracket(picks);
    const bm = predicted['THIRD'] || {};
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
    setResultsKoRound,
    pick,
    saveTiebreaker,
  };

})();
