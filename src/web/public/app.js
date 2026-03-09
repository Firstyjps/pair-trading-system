/* ═══ PAIRS TRADING TERMINAL — Dashboard v3.0 ═══ */

// ─── Selectors ───
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── State ───
const state = {
  currentPage: 'scanner',
  scannerPairs: [],
  scannerFilter: { minCorr: 0.5, maxPvalue: 1, instruction: '' },
  timers: {},
  charts: {
    portEquity: null,
    btEquity: null,
    spreadModal: null,
  },
  portEquityRange: 'all', // '7' | '30' | 'all'
};

// ─── Formatting Helpers ───
function fmtUsd(v) {
  if (v == null || isNaN(v)) return '$0.00';
  const sign = v < 0 ? '-' : '';
  return sign + '$' + Math.abs(v).toFixed(2);
}
function fmtPct(v) { return ((v ?? 0) * 100).toFixed(1) + '%'; }
function fmtNum(v, d = 4) { return v != null ? Number(v).toFixed(d) : '—'; }
function valClass(v) { return v >= 0 ? 'val-positive' : 'val-negative'; }

// ─── API Helper ───
async function api(path, opts) {
  try {
    const res = await fetch(`/api${path}`, opts);
    return await res.json();
  } catch (e) {
    console.error('API error:', path, e);
    return null;
  }
}

// ─── Chart.js Terminal Theme ───
const C = {
  cyan: '#00d4ff',
  green: '#00ff88',
  red: '#ff4444',
  yellow: '#ffcc00',
  line: '#00d4ff',
  lineFill: 'rgba(0,212,255,.06)',
  greenFill: 'rgba(0,255,136,.06)',
  grid: 'rgba(30,42,58,.6)',
  text: '#5a6577',
  textBright: '#b0b8c8',
};

const baseChartOpts = {
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 300 },
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: '#141920',
      titleColor: '#e8edf5',
      bodyColor: '#b0b8c8',
      borderColor: '#1e2a3a',
      borderWidth: 1,
      titleFont: { family: "'JetBrains Mono', monospace", size: 11 },
      bodyFont: { family: "'JetBrains Mono', monospace", size: 10 },
      padding: 8,
    },
  },
  scales: {
    x: {
      grid: { color: C.grid, drawBorder: false },
      ticks: { color: C.text, maxTicksLimit: 10, font: { family: "'JetBrains Mono'", size: 9 } },
    },
    y: {
      grid: { color: C.grid, drawBorder: false },
      ticks: { color: C.text, font: { family: "'JetBrains Mono'", size: 9 } },
    },
  },
};

// ═══════════════════════════════════════════════
//  NAVIGATION — Colored Badge Tabs
// ═══════════════════════════════════════════════

function switchPage(page) {
  state.currentPage = page;
  // Clear all timers
  Object.values(state.timers).forEach(t => clearInterval(t));
  state.timers = {};

  // Update nav badges
  $$('.nav-badge').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  // Show/hide pages
  $$('.page').forEach(p => p.classList.toggle('active', p.id === `page-${page}`));

  // Load page data
  if (page === 'scanner') { loadScannerAll(); }
  if (page === 'portfolio') { loadPortfolio(); }
  if (page === 'backtest') { /* manual only */ }
  if (page === 'settings') { loadSettings(); }
  if (page === 'auto') { loadAutoPage(); }
  if (page === 'logs') { loadLogsPage(); }
  if (page === 'orders') { loadOrdersPage(); }
}

// Portfolio chart range buttons
document.addEventListener('DOMContentLoaded', () => {
  $$('.chart-range-btn').forEach(btn => {
    btn.addEventListener('click', () => setPortfolioChartRange(btn.dataset.range));
  });
});

// Nav badge clicks
$$('.nav-badge').forEach(btn => {
  btn.addEventListener('click', () => switchPage(btn.dataset.page));
});

// Portfolio sub-tabs
function switchSubTab(tab) {
  $$('#page-portfolio .sub-tab').forEach(b => b.classList.toggle('active', b.dataset.subtab === tab));
  $$('#page-portfolio .subtab-content').forEach(c => c.classList.toggle('active', c.id === `subtab-${tab}`));
}

// Scanner trade-history sub-tabs
function switchScannerSubTab(tab) {
  $$('#scanner-subtabs .sub-tab').forEach(b => b.classList.toggle('active', b.dataset.subtab === tab));
  // Toggle scanner subtab content
  ['scan-signals', 'scan-positions', 'scan-logs'].forEach(id => {
    const el = $(`#subtab-${id}`);
    if (el) el.classList.toggle('active', id === tab);
  });
}

// ═══════════════════════════════════════════════
//  STATUS BAR & CLOCK
// ═══════════════════════════════════════════════

function startClock() {
  function tick() {
    const now = new Date();
    $('#clock').textContent = now.toLocaleTimeString('en-US', { hour12: false });
  }
  tick();
  setInterval(tick, 1000);
}

function setStatusIndicator(status, text) {
  const el = $('#status-indicator');
  el.className = `status-badge status-${status}`;
  el.innerHTML = `<span class="status-dot"></span> STATUS: ${text}`;
}

async function updateStatusBar() {
  const scanStatus = await api('/scanner/status');
  if (scanStatus) {
    $('#pairs-count').textContent = `PAIRS: ${scanStatus.symbolCount}`;
    const autoOn = scanStatus.autoTradingEnabled !== false;
    const badge = $('#auto-trading-badge');
    if (badge) {
      badge.textContent = autoOn ? 'AUTO: ON' : 'AUTO: OFF';
      badge.className = 'status-badge ' + (autoOn ? 'badge-connected' : 'badge-disconnected');
    }
  }
  const overview = await api('/overview');
  if (overview) {
    $('#trades-count').textContent = `TRADES: ${overview.totalTrades}`;
  }
  const acct = await api('/account');
  if (acct && acct.connected) {
    $('#okx-badge').textContent = 'OKX CONNECTED';
    $('#okx-badge').className = 'status-badge badge-connected';
  } else {
    $('#okx-badge').textContent = 'OKX OFFLINE';
    $('#okx-badge').className = 'status-badge badge-disconnected';
  }
}

async function updateScannerScheduleInfo() {
  const scanStatus = await api('/scanner/status');
  const el = $('#auto-sched-info');
  if (!el) return;
  if (!scanStatus) {
    el.textContent = 'LAST: — | EVERY: —';
    return;
  }
  const last = scanStatus.lastScanAt
    ? new Date(scanStatus.lastScanAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '—';
  const intervalMin = scanStatus.scanIntervalMs
    ? Math.round(scanStatus.scanIntervalMs / 60000)
    : '—';
  el.textContent = `LAST: ${last} | EVERY: ${intervalMin}m`;
}

// ═══════════════════════════════════════════════
//  TICKER TAPE
// ═══════════════════════════════════════════════

async function updateTickerTape() {
  const data = await api('/ticker/tape');
  if (!data || !data.tickers || data.tickers.length === 0) return;

  const html = data.tickers.map(t => {
    const chgClass = t.change24h >= 0 ? 'pos' : 'neg';
    const chgSign = t.change24h >= 0 ? '+' : '';
    const price = t.last >= 1 ? t.last.toFixed(2) : t.last.toFixed(6);
    return `<span class="ticker-item">
      <span class="symbol">${t.symbol}</span>
      <span class="price">$${price}</span>
      <span class="change ${chgClass}">${chgSign}${t.change24h.toFixed(2)}%</span>
    </span>`;
  }).join('');

  $('#ticker-group-1').innerHTML = html;
  $('#ticker-group-2').innerHTML = html;
}

function startTickerTape() {
  updateTickerTape();
  state.timers.ticker = setInterval(updateTickerTape, 30000);
}

// ═══════════════════════════════════════════════
//  SCANNER PAGE
// ═══════════════════════════════════════════════

async function loadScannerAll() {
  loadScannerMetrics();
  loadScannerPairs();
  loadScannerTradeHistory();
  loadScannerOkxSummary();
  updateStatusBar();
  updateScannerScheduleInfo();
  state.timers.scannerMetrics = setInterval(loadScannerMetrics, 15000);
  state.timers.scannerPairs = setInterval(loadScannerPairs, 15000);
  state.timers.scannerOkx = setInterval(loadScannerOkxSummary, 15000);
  state.timers.scannerSched = setInterval(updateScannerScheduleInfo, 60000);
}

async function loadScannerMetrics() {
  const stats = await api('/account/stats');
  if (!stats) return;

  setText('#met-pnl', fmtUsd(stats.realizedPnl), valClass(stats.realizedPnl));
  setText('#met-winrate', fmtPct(stats.winRate));
  setText('#met-active', stats.openPositions);
  setText('#met-maxdd', fmtUsd(-stats.maxDrawdown), 'val-negative');
  setText('#met-sharpe', fmtNum(stats.sharpeRatio, 2));
  setText('#met-pf', stats.profitFactor === Infinity ? '∞' : fmtNum(stats.profitFactor, 2));
}

function setText(sel, text, colorClass) {
  const el = $(sel);
  if (!el) return;
  el.textContent = text;
  if (colorClass) {
    el.classList.remove('val-positive', 'val-negative', 'val-cyan');
    el.classList.add(colorClass);
  }
}

// ─── Scanner Pairs (Full-width watchlist with ORDER INSTRUCTION) ───
function applyScannerFilter() {
  state.scannerFilter = {
    minCorr: parseFloat($('#filter-min-corr').value) || 0.5,
    maxPvalue: parseFloat($('#filter-max-pvalue').value) ?? 1,
    instruction: ($('#filter-instruction').value || '').trim(),
  };
  renderScannerPairsTable();
}

function renderScannerPairsTable() {
  const tbody = $('#pairs-tbody');
  const raw = state.scannerPairs || [];
  let list = raw;
  if (state.scannerFilter) {
    const f = state.scannerFilter;
    list = raw.filter(p => {
      if (p.correlation < f.minCorr) return false;
      if (p.cointegrationPValue > f.maxPvalue) return false;
      if (f.instruction && (p.orderInstruction || '') !== f.instruction) return false;
      return true;
    });
  }

  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-msg">No pairs match filter. Run a scan or loosen filters.</td></tr>';
    return;
  }

  tbody.innerHTML = list.map(p => {
    const signalHtml = getSignalBadge(p.zScore);
    const zBar = renderZScoreBar(p.zScore);
    const orderHtml = renderOrderInstruction(p);
    const highlight = p.orderInstruction === 'OPEN_PAIR' ? ' row-highlight-open' : (p.hasActivePosition ? ' row-highlight' : '');
    const encPair = encodeURIComponent(p.pair);
    return `<tr class="${highlight}">
      <td style="font-weight:600;color:var(--text-bright)">${p.pair}</td>
      <td>${fmtNum(p.correlation)}</td>
      <td style="color:${p.cointegrationPValue < 0.05 ? 'var(--neon-green)' : p.cointegrationPValue < 0.1 ? 'var(--neon-yellow)' : 'var(--text-dim)'}">${fmtNum(p.cointegrationPValue)}</td>
      <td class="z-cell">${zBar}</td>
      <td>${fmtNum(p.halfLife, 1)}</td>
      <td>${signalHtml}</td>
      <td class="order-cell">${orderHtml}</td>
      <td><button class="btn-terminal btn-sm" onclick="openSpreadDetail('${encPair.replace(/'/g, "\\'")}')">DETAIL</button></td>
    </tr>`;
  }).join('');
}

async function loadScannerPairs() {
  const data = await api('/scanner/pairs?minCorr=0.5');
  if (!data) return;

  state.scannerPairs = data.pairs || [];
  $('#crypto-count').textContent = state.scannerPairs.length;

  renderScannerPairsTable();
  populatePairDatalist();

  if (data.heatmap && data.heatmap.symbols.length > 0) {
    renderHeatmap(data.heatmap);
  }
}

function openSpreadDetail(pairEnc) {
  const pair = decodeURIComponent(pairEnc);
  const modal = $('#spread-modal');
  const title = $('#spread-modal-title');
  if (title) title.textContent = 'SPREAD — ' + pair;
  if (modal) modal.classList.add('open');

  api('/spread/' + encodeURIComponent(pair) + '?limit=50').then(data => {
    const ctx = document.getElementById('spread-modal-chart');
    if (!ctx) return;
    if (state.charts.spreadModal) state.charts.spreadModal.destroy();
    if (!data || !data.history || data.history.length === 0) {
      document.getElementById('spread-modal-hint').textContent = 'No Z-Score history for this pair yet.';
      return;
    }
    const history = data.history.slice(-50);
    state.charts.spreadModal = new Chart(ctx, {
      type: 'line',
      data: {
        labels: history.map((_, i) => i),
        datasets: [{
          label: 'Z-Score',
          data: history.map(h => h.z_score),
          borderColor: C.cyan,
          backgroundColor: C.lineFill,
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2,
        }],
      },
      options: {
        ...baseChartOpts,
        scales: {
          ...baseChartOpts.scales,
          y: { ...baseChartOpts.scales.y, title: { display: true, text: 'Z-Score', color: C.text } },
        },
      },
    });
    document.getElementById('spread-modal-hint').textContent = 'Z-Score history (last ' + history.length + ' points)';
  });
}

function closeSpreadModal() {
  $('#spread-modal').classList.remove('open');
  if (state.charts.spreadModal) {
    state.charts.spreadModal.destroy();
    state.charts.spreadModal = null;
  }
}

function getSignalBadge(z) {
  const entryZ = 3.3;
  if (z > entryZ) return '<span class="badge-signal badge-short">SHORT ▼</span>';
  if (z < -entryZ) return '<span class="badge-signal badge-long">LONG ▲</span>';
  return '<span class="badge-none">—</span>';
}

function renderZScoreBar(z) {
  const absZ = Math.abs(z);
  const pct = Math.min(absZ / 4.0, 1) * 100;
  let color;
  if (absZ < 1.5) color = 'var(--neon-green)';
  else if (absZ < 2.5) color = 'var(--neon-yellow)';
  else color = 'var(--neon-red)';

  return `<div class="z-bar-wrap">
    <div class="z-bar-container"><div class="z-bar" style="width:${pct}%;background:${color}"></div></div>
    <span class="z-value" style="color:${color}">${fmtNum(z, 2)}</span>
  </div>`;
}

function renderOrderInstruction(p) {
  const instr = p.orderInstruction || 'MONITORING';
  const legA = p.legAAction || '';
  const legB = p.legBAction || '';

  let badgeClass, label;
  switch (instr) {
    case 'OPEN_PAIR':
      badgeClass = 'order-open';
      label = 'OPEN PAIR';
      break;
    case 'CLOSE_SL':
      badgeClass = 'order-close-sl';
      label = 'CLOSE SL';
      break;
    case 'CLOSE_TP':
      badgeClass = 'order-close-tp';
      label = 'CLOSE TP';
      break;
    case 'SIGNAL_ONLY':
      badgeClass = 'order-signal';
      label = 'SIGNAL ONLY';
      break;
    case 'HOLD':
      badgeClass = 'order-hold';
      label = 'HOLD';
      break;
    default:
      return '<span class="order-monitor">MONITORING</span>';
  }

  let html = `<span class="order-badge ${badgeClass}">${label}</span>`;
  if (legA && legB) {
    html += `<div class="leg-detail"><span class="leg-a">A: ${legA}</span> &nbsp; <span class="leg-b">B: ${legB}</span></div>`;
  } else if (instr === 'CLOSE_SL') {
    html += `<div class="leg-detail" style="color:var(--neon-red)">SL TRIGGERED</div>`;
  } else if (instr === 'CLOSE_TP') {
    html += `<div class="leg-detail" style="color:var(--neon-cyan)">TP REACHED</div>`;
  }
  return html;
}

// ─── Scanner Trade History ───
async function loadScannerTradeHistory() {
  // SIGNALS tab
  const sigData = await api('/signals');
  const sigTbody = $('#scan-signals-tbody');
  if (sigData && sigData.signals && sigData.signals.length > 0) {
    sigTbody.innerHTML = sigData.signals.slice(0, 20).map(s => {
      const time = new Date(s.timestamp || s.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const dirClass = s.direction === 'LONG_SPREAD' ? 'badge-long' : 'badge-short';
      const dirLabel = s.direction === 'LONG_SPREAD' ? 'LONG' : 'SHORT';
      return `<tr>
        <td style="color:var(--text-dim)">${time}</td>
        <td style="font-weight:600;color:var(--text-bright)">${s.pair}</td>
        <td><span class="badge-signal ${dirClass}">${dirLabel}</span></td>
        <td>${fmtNum(s.z_score, 2)}</td>
        <td style="color:var(--text-dim)">${s.status || 'GENERATED'}</td>
      </tr>`;
    }).join('');
  } else {
    sigTbody.innerHTML = '<tr><td colspan="5" class="empty-msg">No recent signals</td></tr>';
  }

  // POSITIONS tab
  const posData = await api('/positions');
  const posTbody = $('#scan-positions-tbody');
  if (posData && posData.positions && posData.positions.length > 0) {
    posTbody.innerHTML = posData.positions.map(p => {
      const dirClass = p.direction === 'LONG_SPREAD' ? 'badge-long' : 'badge-short';
      const dirLabel = p.direction === 'LONG_SPREAD' ? 'LONG' : 'SHORT';
      const upl = p.pnl ?? 0;
      return `<tr>
        <td style="font-weight:600;color:var(--text-bright)">${p.pair}</td>
        <td><span class="badge-signal ${dirClass}">${dirLabel}</span></td>
        <td>${fmtNum(p.entry_z_score, 2)}</td>
        <td style="color:${Math.abs(p.current_z_score ?? 0) < 1.5 ? 'var(--neon-green)' : Math.abs(p.current_z_score ?? 0) < 2.5 ? 'var(--neon-yellow)' : 'var(--neon-red)'}">${fmtNum(p.current_z_score, 2)}</td>
        <td class="${valClass(upl)}">${fmtUsd(upl)}</td>
        <td>${p.durationFormatted || '—'}</td>
      </tr>`;
    }).join('');
  } else {
    posTbody.innerHTML = '<tr><td colspan="6" class="empty-msg">No open positions</td></tr>';
  }
}

// ─── Scanner OKX Account Summary ───
async function loadScannerOkxSummary() {
  const acct = await api('/account');
  if (!acct || !acct.connected) {
    setText('#okx-sum-equity', 'OFFLINE');
    setText('#okx-sum-margin-pct', '—');
    setText('#okx-sum-upl', '—');
    setText('#okx-sum-poscount', '—');
    const fill = $('#okx-margin-fill');
    if (fill) fill.style.width = '0%';
    return;
  }

  setText('#okx-sum-equity', fmtUsd(acct.totalEquity));
  const marginPct = ((acct.marginRatio ?? 0) * 100).toFixed(1);
  setText('#okx-sum-margin-pct', marginPct + '%');
  const fill = $('#okx-margin-fill');
  if (fill) fill.style.width = marginPct + '%';
  setText('#okx-sum-upl', fmtUsd(acct.unrealizedPnl), valClass(acct.unrealizedPnl));

  // Count positions
  const posData = await api('/positions');
  const posCount = posData && posData.positions ? posData.positions.length : 0;
  setText('#okx-sum-poscount', posCount);
}

// Scanner actions
async function runScan() {
  const btn = $('#btn-scan');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'SCANNING...';
  setStatusIndicator('active', 'SCANNING');

  try {
    const result = await api('/scanner/run', { method: 'POST' });
    if (result && result.status === 'done') {
      btn.textContent = `DONE! ${result.fetched}/${result.total}`;
      setTimeout(() => { btn.textContent = 'SCAN'; }, 3000);
    } else if (result && result.status === 'running') {
      btn.textContent = 'IN PROGRESS...';
      setTimeout(() => { btn.textContent = 'SCAN'; }, 5000);
    }
    await loadScannerPairs();
    await loadScannerMetrics();
  } catch (e) {
    console.error('Scan error:', e);
  }
  btn.disabled = false;
  setStatusIndicator('idle', 'IDLE');
}

function refreshScanner() {
  loadScannerPairs();
  loadScannerMetrics();
  loadScannerOkxSummary();
  loadScannerTradeHistory();
}

// ═══════════════════════════════════════════════
//  HEATMAP
// ═══════════════════════════════════════════════

function renderHeatmap(hm) {
  const canvas = $('#heatmap-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const n = hm.symbols.length;
  const cellSize = Math.min(Math.floor(550 / n), 42);
  const pad = 65;
  canvas.width = n * cellSize + pad + 10;
  canvas.height = n * cellSize + pad + 10;

  // Background
  ctx.fillStyle = '#0a0e17';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw cells
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const v = hm.matrix[i][j];
      ctx.fillStyle = corrColor(v);
      ctx.fillRect(pad + j * cellSize, pad + i * cellSize, cellSize - 1, cellSize - 1);

      if (cellSize > 22) {
        ctx.fillStyle = Math.abs(v) > 0.5 ? '#e8edf5' : '#5a6577';
        ctx.font = `${Math.min(9, cellSize / 3.5)}px 'JetBrains Mono', monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(v.toFixed(2), pad + j * cellSize + cellSize / 2, pad + i * cellSize + cellSize / 2);
      }
    }
  }

  // Labels
  ctx.fillStyle = '#5a6577';
  ctx.font = "9px 'JetBrains Mono', monospace";
  for (let i = 0; i < n; i++) {
    ctx.save();
    ctx.translate(pad + i * cellSize + cellSize / 2, pad - 5);
    ctx.rotate(-Math.PI / 4);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(hm.symbols[i], 0, 0);
    ctx.restore();

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(hm.symbols[i], pad - 5, pad + i * cellSize + cellSize / 2);
  }
}

function corrColor(v) {
  if (v >= 0.8) return 'rgba(0,255,136,.55)';
  if (v >= 0.6) return 'rgba(0,255,136,.3)';
  if (v >= 0.3) return 'rgba(0,212,255,.15)';
  if (v >= 0) return 'rgba(30,42,58,.5)';
  if (v >= -0.3) return 'rgba(255,68,68,.15)';
  return 'rgba(255,68,68,.4)';
}

// ═══════════════════════════════════════════════
//  PORTFOLIO PAGE
// ═══════════════════════════════════════════════

async function loadPortfolio() {
  await Promise.all([
    loadAccountData(),
    loadAccountStats(),
    loadPortfolioPositions(),
    loadPortfolioHistory(),
    loadExchangePositions(),
  ]);
}

async function loadAccountData() {
  const data = await api('/account');
  if (!data) return;

  const portBadge = $('#port-okx-badge');
  if (data.connected) {
    portBadge.textContent = 'OKX CONNECTED';
    portBadge.className = 'status-badge badge-connected';
    $('#port-uid').textContent = `UID: ${data.uid || '---'}`;

    setText('#port-equity', fmtUsd(data.totalEquity), valClass(data.totalEquity));
    setText('#port-available', fmtUsd(data.availableBalance));
    setText('#port-upnl', fmtUsd(data.unrealizedPnl), valClass(data.unrealizedPnl));
    setText('#port-frozen', fmtUsd(data.frozenBalance));

    const acctTypes = { '1': 'Simple', '2': 'Single-CCY Margin', '3': 'Multi-CCY Margin', '4': 'Portfolio Margin' };
    setText('#port-accttype', acctTypes[data.accountType] || data.accountType);

    const posModes = { 'long_short_mode': 'Hedge', 'net_mode': 'One-Way' };
    setText('#port-posmode', posModes[data.positionMode] || data.positionMode);
  } else {
    portBadge.textContent = 'NOT CONNECTED';
    portBadge.className = 'status-badge badge-disconnected';
    $('#port-uid').textContent = 'UID: ---';
    const overview = await api('/overview');
    if (overview) {
      setText('#port-equity', fmtUsd(overview.totalEquity));
      setText('#port-available', fmtUsd(overview.availableMargin));
      setText('#port-upnl', fmtUsd(overview.unrealizedPnl), valClass(overview.unrealizedPnl));
      setText('#port-frozen', '$0.00');
      setText('#port-accttype', '—');
      setText('#port-posmode', '—');
    }
  }
}

async function loadAccountStats() {
  const data = await api('/account/stats');
  if (!data) return;

  setText('#ps-rpnl', fmtUsd(data.realizedPnl), valClass(data.realizedPnl));
  setText('#ps-fees', fmtUsd(data.totalFees));
  setText('#ps-trades', data.totalTrades);
  setText('#ps-open', data.openPositions);
  setText('#ps-wr', fmtPct(data.winRate));
  setText('#ps-avgwin', fmtUsd(data.avgWin), 'val-positive');
  setText('#ps-avgloss', fmtUsd(data.avgLoss), 'val-negative');
  setText('#ps-pf', data.profitFactor === Infinity ? '∞' : fmtNum(data.profitFactor, 2));
  setText('#ps-best', fmtUsd(data.bestTrade), 'val-positive');
  setText('#ps-worst', fmtUsd(data.worstTrade), 'val-negative');

  renderPortfolioEquityChart();
}

async function renderPortfolioEquityChart() {
  const overview = await api('/overview');
  if (!overview || !overview.equityCurve || overview.equityCurve.length === 0) return;

  const ctx = $('#port-equity-chart');
  if (!ctx) return;
  if (state.charts.portEquity) state.charts.portEquity.destroy();

  let curve = overview.equityCurve;
  const range = state.portEquityRange || 'all';
  if (range === '7' || range === '30') {
    const days = range === '7' ? 7 : 30;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    curve = curve.filter(p => new Date(p.time).getTime() >= cutoff);
  }
  const labels = curve.map(p => new Date(p.time).toLocaleDateString());
  const values = curve.map(p => p.equity);

  state.charts.portEquity = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: C.cyan,
        backgroundColor: C.lineFill,
        fill: true,
        tension: 0.3,
        pointRadius: values.length > 50 ? 0 : 3,
        borderWidth: 2,
      }],
    },
    options: {
      ...baseChartOpts,
      scales: {
        ...baseChartOpts.scales,
        y: {
          ...baseChartOpts.scales.y,
          ticks: { ...baseChartOpts.scales.y.ticks, callback: v => '$' + v.toFixed(2) },
        },
      },
    },
  });
}

function setPortfolioChartRange(range) {
  state.portEquityRange = range;
  $$('.chart-range-btn').forEach(b => b.classList.toggle('active', b.dataset.range === range));
  renderPortfolioEquityChart();
}
function setEquityRange(range) { setPortfolioChartRange(range); }

async function loadPortfolioPositions() {
  const data = await api('/positions');
  if (!data) return;

  const tbody = $('#port-pos-tbody');
  if (!data.positions || data.positions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-msg">No open positions</td></tr>';
    return;
  }

  tbody.innerHTML = data.positions.map(p => {
    const dirClass = p.direction === 'LONG_SPREAD' ? 'badge-long' : 'badge-short';
    const dirLabel = p.direction === 'LONG_SPREAD' ? 'LONG' : 'SHORT';
    const upl = p.pnl ?? 0;
    return `<tr>
      <td style="font-weight:600;color:var(--text-bright)">${p.pair}</td>
      <td><span class="badge-signal ${dirClass}">${dirLabel}</span></td>
      <td>${fmtNum(p.entry_z_score, 2)}</td>
      <td style="color:${Math.abs(p.current_z_score ?? 0) < 1.5 ? 'var(--neon-green)' : Math.abs(p.current_z_score ?? 0) < 2.5 ? 'var(--neon-yellow)' : 'var(--neon-red)'}">${fmtNum(p.current_z_score, 2)}</td>
      <td class="${valClass(upl)}">${fmtUsd(upl)}</td>
      <td>${p.durationFormatted}</td>
      <td>${fmtUsd(p.margin_per_leg * 2)}</td>
    </tr>`;
  }).join('');
}

async function loadPortfolioHistory() {
  const data = await api('/positions/closed?limit=50');
  if (!data) return;

  const tbody = $('#port-hist-tbody');
  if (!data.positions || data.positions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-msg">No trade history</td></tr>';
    return;
  }

  tbody.innerHTML = data.positions.map(p => {
    const dirClass = p.direction === 'LONG_SPREAD' ? 'badge-long' : 'badge-short';
    const dirLabel = p.direction === 'LONG_SPREAD' ? 'LONG' : 'SHORT';
    const pnl = p.pnl ?? 0;
    return `<tr>
      <td style="font-weight:600;color:var(--text-bright)">${p.pair}</td>
      <td><span class="badge-signal ${dirClass}">${dirLabel}</span></td>
      <td class="${valClass(pnl)}">${fmtUsd(pnl)}</td>
      <td>${p.close_reason ?? '—'}</td>
      <td style="color:var(--text-dim)">${p.opened_at ? new Date(p.opened_at).toLocaleDateString() : '—'}</td>
      <td style="color:var(--text-dim)">${p.closed_at ? new Date(p.closed_at).toLocaleDateString() : '—'}</td>
    </tr>`;
  }).join('');
}

// ─── Exchange Positions (OKX raw positions) ───
async function loadExchangePositions() {
  const data = await api('/positions/exchange');
  const tbody = $('#exchange-pos-tbody');
  if (!tbody) return;

  if (!data || !data.connected) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-msg">OKX not connected</td></tr>';
    return;
  }

  if (!data.positions || data.positions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-msg">No open exchange positions</td></tr>';
    return;
  }

  tbody.innerHTML = data.positions.map(p => {
    const sideClass = (p.side || '').toLowerCase() === 'long' ? 'badge-long' : 'badge-short';
    const sideLabel = (p.side || '').toUpperCase();
    const upl = p.upl ?? 0;
    const uplPct = p.uplPercent ?? 0;
    return `<tr>
      <td style="font-weight:600;color:var(--text-bright)">${p.symbol}</td>
      <td><span class="badge-signal ${sideClass}">${sideLabel}</span></td>
      <td>${fmtNum(p.size, 4)}</td>
      <td>${fmtNum(p.entryPrice, 6)}</td>
      <td>${fmtNum(p.markPrice, 6)}</td>
      <td class="${valClass(upl)}">${fmtUsd(upl)}</td>
      <td class="${valClass(uplPct)}">${uplPct.toFixed(2)}%</td>
    </tr>`;
  }).join('');
}

// ═══════════════════════════════════════════════
//  BACKTEST PAGE
// ═══════════════════════════════════════════════

async function runBacktest() {
  const pair = $('#bt-pair').value.trim();
  if (!pair) return alert('Enter a pair (e.g., PEPE/SHIB)');

  const btn = document.querySelector('#page-backtest .btn-primary');
  btn.disabled = true;
  btn.textContent = 'FETCHING DATA & RUNNING...';

  const diagBox = document.getElementById('bt-diagnostics');
  if (diagBox) { diagBox.style.display = 'block'; diagBox.innerHTML = '<span style="color:var(--neon-cyan)">⏳ Fetching historical data from OKX (first run may take ~10s)...</span>'; }

  const params = new URLSearchParams({
    pair,
    entryZ: $('#bt-entryz').value,
    exitZ: $('#bt-exitz').value,
    stopLossZ: $('#bt-slz').value,
    lookback: $('#bt-lookback').value,
    corrThreshold: $('#bt-corr').value,
  });

  const data = await api(`/backtest/run?${params}`);
  btn.disabled = false;
  btn.textContent = 'RUN BACKTEST';

  if (!data || data.error) {
    if (diagBox) { diagBox.style.display = 'block'; diagBox.innerHTML = `<span style="color:var(--neon-red)">❌ ${data?.error || 'Backtest failed'}</span>`; }
    else alert(data?.error || 'Backtest failed');
    return;
  }

  $('#bt-results').style.display = 'block';
  $('#grid-results').style.display = 'none';
  const applyBar = document.getElementById('bt-apply-bar');
  if (applyBar) applyBar.style.display = 'block';

  const diag = data.diagnostics;
  if (diagBox && diag) {
    const parts = [
      `📊 Data: ${diag.candlesA} × ${diag.candlesB} candles`,
      `📈 Trading bars: ${diag.tradingBars}`,
      `📉 Z-Score range: [${diag.zScoreRange?.min ?? '?'}, ${diag.zScoreRange?.max ?? '?'}]`,
    ];
    if (diag.hint) parts.push(`💡 ${diag.hint}`);
    diagBox.style.display = 'block';
    diagBox.innerHTML = parts.map(p => `<span style="color:var(--text-dim);font-size:0.82rem">${p}</span>`).join('<br>');
  }

  const r = data.report;
  const metricsRow = $('#bt-metrics');
  metricsRow.innerHTML = [
    { label: 'TRADES', value: r.totalTrades },
    { label: 'WIN RATE', value: fmtPct(r.winRate), cls: r.winRate >= 0.5 ? 'val-positive' : 'val-negative' },
    { label: 'TOTAL P&L', value: fmtUsd(r.totalPnl), cls: valClass(r.totalPnl) },
    { label: 'SHARPE', value: fmtNum(r.sharpeRatio, 3) },
    { label: 'MAX DD', value: fmtUsd(r.maxDrawdown), cls: 'val-negative' },
    { label: 'PROFIT FACTOR', value: r.profitFactor === null || r.profitFactor === Infinity ? '∞' : fmtNum(r.profitFactor, 2) },
  ].map(m => `<div class="metric-card sm"><div class="metric-value ${m.cls || ''}">${m.value}</div><div class="metric-label">${m.label}</div></div>`).join('');

  // Equity chart
  const ctx = $('#bt-equity-chart');
  if (state.charts.btEquity) state.charts.btEquity.destroy();
  const eq = data.equityCurve || [];
  if (eq.length > 0) {
    state.charts.btEquity = new Chart(ctx, {
      type: 'line',
      data: {
        labels: eq.map(e => e.bar),
        datasets: [{
          data: eq.map(e => e.equity),
          borderColor: C.cyan,
          backgroundColor: C.lineFill,
          fill: true,
          tension: 0.3,
          pointRadius: eq.length > 50 ? 0 : 3,
          borderWidth: 2,
        }],
      },
      options: {
        ...baseChartOpts,
        scales: {
          ...baseChartOpts.scales,
          x: { ...baseChartOpts.scales.x, title: { display: true, text: 'Bar', color: C.text, font: { family: "'JetBrains Mono'" } } },
          y: { ...baseChartOpts.scales.y, ticks: { ...baseChartOpts.scales.y.ticks, callback: v => '$' + v.toFixed(0) } },
        },
      },
    });
  }

  // Trade log
  const tradesTbody = $('#bt-trades-tbody');
  if (!data.trades || data.trades.length === 0) {
    tradesTbody.innerHTML = '<tr><td colspan="8" class="empty-msg" style="text-align:center;color:var(--text-dim);padding:1.5rem">No trades generated. Try lowering Entry Z, increasing Lookback, or picking a different pair.</td></tr>';
  } else {
    tradesTbody.innerHTML = data.trades.map((t, i) => `<tr>
      <td>${i + 1}</td>
      <td><span class="badge-signal ${t.direction === 'LONG_SPREAD' ? 'badge-long' : 'badge-short'}">${t.direction === 'LONG_SPREAD' ? 'LONG' : 'SHORT'}</span></td>
      <td>${t.entryBar}</td>
      <td>${t.exitBar}</td>
      <td class="${valClass(t.pnl)}">${fmtUsd(t.pnl)}</td>
      <td>${fmtNum(t.entryZ, 2)}</td>
      <td>${fmtNum(t.exitZ, 2)}</td>
      <td>${t.closeReason || t.exitReason || '—'}</td>
    </tr>`).join('');
  }
}

async function runGridSearch() {
  const pair = $('#bt-pair').value.trim();
  if (!pair) return alert('Enter a pair');

  const btns = document.querySelectorAll('#page-backtest .btn-terminal');
  const gridBtn = btns[btns.length - 1];
  gridBtn.disabled = true;
  gridBtn.textContent = 'SEARCHING...';

  const data = await api(`/backtest/grid?pair=${encodeURIComponent(pair)}`);
  gridBtn.disabled = false;
  gridBtn.textContent = 'GRID SEARCH';

  if (!data || data.error) {
    alert(data?.error || 'Grid search failed');
    return;
  }

  $('#grid-results').style.display = 'block';
  const tbody = $('#grid-tbody');
  tbody.innerHTML = (data.topResults || []).map(r => `<tr>
    <td style="color:var(--neon-cyan)">${r.rank}</td>
    <td>${fmtNum(r.entryZ, 1)}</td>
    <td>${fmtNum(r.exitZ, 1)}</td>
    <td>${fmtNum(r.stopLossZ, 1)}</td>
    <td>${r.totalTrades}</td>
    <td class="${r.winRate >= 0.5 ? 'val-positive' : 'val-negative'}">${fmtPct(r.winRate)}</td>
    <td class="${valClass(r.totalPnl)}">${fmtUsd(r.totalPnl)}</td>
    <td>${fmtNum(r.sharpeRatio, 3)}</td>
    <td>${fmtUsd(r.maxDrawdown)}</td>
    <td>${r.profitFactor === Infinity ? '∞' : fmtNum(r.profitFactor, 2)}</td>
  </tr>`).join('');
}

// ─── Backtest helpers: prefill and apply ───

async function prefillFromConfig() {
  const data = await api('/config');
  if (!data || !data.config) return showToast('Could not load config', 'error');
  const c = data.config;
  if (c.entryZScore != null) $('#bt-entryz').value = c.entryZScore;
  if (c.exitZScore != null) $('#bt-exitz').value = c.exitZScore;
  if (c.stopLossZScore != null) $('#bt-slz').value = c.stopLossZScore;
  if (c.lookbackPeriods != null) $('#bt-lookback').value = c.lookbackPeriods;
  if (c.correlationThreshold != null) $('#bt-corr').value = c.correlationThreshold;
  showToast('Fields pre-filled from live config', 'success');
}

async function applyBacktestToConfig() {
  const updates = {
    entryZScore: parseFloat($('#bt-entryz').value),
    exitZScore: parseFloat($('#bt-exitz').value),
    stopLossZScore: parseFloat($('#bt-slz').value),
    lookbackPeriods: parseInt($('#bt-lookback').value),
    correlationThreshold: parseFloat($('#bt-corr').value),
  };
  const res = await api('/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (res && res.config) {
    showToast('Backtest params applied as live config!', 'success');
  } else {
    showToast(`Error: ${res?.error || 'Unknown'}`, 'error');
  }
}

function populatePairDatalist() {
  const datalist = document.getElementById('bt-pair-list');
  if (!datalist) return;
  const seen = new Set();
  (state.scannerPairs || []).forEach(p => {
    if (!seen.has(p.pair)) {
      seen.add(p.pair);
      const opt = document.createElement('option');
      opt.value = p.pair;
      datalist.appendChild(opt);
    }
  });
}

// ═══════════════════════════════════════════════
//  SETTINGS PAGE
// ═══════════════════════════════════════════════

const CONFIG_META = {
  correlationThreshold:   { label: 'Correlation Threshold', group: 'Signal', tip: 'Minimum Pearson correlation to consider a pair' },
  cointegrationPValue:    { label: 'Cointegration p-value', group: 'Signal', tip: 'Max ADF p-value for cointegration test' },
  lookbackPeriods:        { label: 'Lookback Periods',      group: 'Signal', tip: 'Window size for Z-Score calculation (bars)' },
  entryZScore:            { label: 'Entry Z-Score',         group: 'Signal', tip: '|Z| must exceed this to open a trade' },
  exitZScore:             { label: 'Exit Z-Score',          group: 'Signal', tip: '|Z| must drop below this to take profit' },
  stopLossZScore:         { label: 'Stop Loss Z-Score',     group: 'Signal', tip: '|Z| above this triggers stop-loss' },
  safeZoneBuffer:         { label: 'Safe Zone Buffer',      group: 'Signal', tip: 'Gap between entry and SL zones' },
  autoTradingEnabled:     { label: 'Auto Trading',          group: 'Risk',   tip: 'Master switch for automated order execution' },
  maxLeverage:            { label: 'Max Leverage',          group: 'Risk',   tip: 'Maximum leverage per leg (1-20x)' },
  maxCapitalPerPair:      { label: 'Max Capital/Pair ($)',   group: 'Risk',   tip: 'Dollar amount allocated per pair' },
  maxOpenPairs:           { label: 'Max Open Pairs',        group: 'Risk',   tip: 'Maximum concurrent open positions' },
  cooldownMs:             { label: 'Cooldown (ms)',         group: 'Timing', tip: 'Minimum wait between trades on same pair' },
  gracePeriodMs:          { label: 'Grace Period (ms)',     group: 'Timing', tip: 'Delay before SL can trigger after entry' },
  reconciliationIntervalMs:{ label: 'Reconciliation (ms)', group: 'Timing', tip: 'How often DB ↔ exchange positions are synced' },
  scanIntervalMs:         { label: 'Scan Interval (ms)',    group: 'Timing', tip: 'Auto-scan frequency' },
  signalDedup:            { label: 'Signal Dedup',          group: 'System', tip: 'Deduplication method for signals' },
  notificationTTL:        { label: 'Notification TTL (ms)', group: 'System', tip: 'How long notifications stay dedup-cached' },
  sizingMethod:           { label: 'Sizing Method',         group: 'Sizing', tip: 'Position sizing strategy' },
  fixedFractionPercent:   { label: 'Fixed Fraction %',      group: 'Sizing', tip: 'Used when sizingMethod = fixed-fraction' },
  primaryTimeframe:       { label: 'Primary Timeframe',     group: 'System', tip: 'Candle timeframe for analysis' },
  targetPairs:            { label: 'Target Pairs',          group: 'System', tip: 'Explicit pair list to monitor' },
};

const GROUP_ORDER = ['Signal', 'Risk', 'Timing', 'Sizing', 'System'];

async function loadSettings() {
  const data = await api('/config');
  if (!data) return;

  // Config source info
  const srcLabel = $('#cfg-source-label');
  const lastMod = $('#cfg-last-mod');
  if (srcLabel) srcLabel.textContent = data.source || 'config.json';
  if (lastMod) lastMod.textContent = data.appliedAt ? `Last applied: ${new Date(data.appliedAt).toLocaleString()}` : '';

  const container = document.getElementById('settings-grouped');
  if (!container) return;
  container.innerHTML = '';

  const grouped = {};
  for (const [key, value] of Object.entries(data.config)) {
    const meta = CONFIG_META[key] || { label: key, group: 'Other', tip: '' };
    if (!grouped[meta.group]) grouped[meta.group] = [];
    grouped[meta.group].push({ key, value, meta });
  }

  const orderedGroups = [...GROUP_ORDER, ...Object.keys(grouped).filter(g => !GROUP_ORDER.includes(g))];
  for (const group of orderedGroups) {
    const items = grouped[group];
    if (!items || items.length === 0) continue;

    const section = document.createElement('div');
    section.className = 'settings-group';
    section.innerHTML = `<div class="settings-group-title">${group}</div>`;
    const grid = document.createElement('div');
    grid.className = 'settings-grid';

    for (const { key, value, meta } of items) {
      const div = document.createElement('div');
      div.className = 'setting-item';

      let inputHtml;
      if (typeof value === 'boolean') {
        inputHtml = `<select data-key="${key}"><option value="true" ${value ? 'selected' : ''}>true</option><option value="false" ${!value ? 'selected' : ''}>false</option></select>`;
      } else if (key === 'sizingMethod') {
        const opts = ['dollar-neutral', 'kelly', 'fixed-fraction', 'volatility-scaled', 'equal-weight'];
        inputHtml = `<select data-key="${key}">${opts.map(o => `<option ${o === value ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
      } else if (key === 'primaryTimeframe') {
        inputHtml = `<select data-key="${key}"><option ${value === '1h' ? 'selected' : ''}>1h</option><option ${value === '4h' ? 'selected' : ''}>4h</option></select>`;
      } else if (Array.isArray(value)) {
        inputHtml = `<input type="text" data-key="${key}" value="${value.join(', ')}" data-array="true">`;
      } else {
        inputHtml = `<input type="${typeof value === 'number' ? 'number' : 'text'}" data-key="${key}" value="${value}" step="any">`;
      }
      const tipHtml = meta.tip ? `<div class="setting-tooltip">${meta.tip}</div>` : '';
      div.innerHTML = `<label>${meta.label}</label>${inputHtml}${tipHtml}`;
      grid.appendChild(div);
    }

    section.appendChild(grid);
    container.appendChild(section);
  }
}

async function saveConfig() {
  const inputs = $$('#settings-grouped [data-key]');
  const updates = {};
  inputs.forEach(el => {
    const key = el.dataset.key;
    let val = el.value;
    if (el.dataset.array) {
      val = val.split(',').map(s => s.trim()).filter(Boolean);
    } else if (val === 'true') {
      val = true;
    } else if (val === 'false') {
      val = false;
    } else if (!isNaN(Number(val)) && val !== '') {
      val = Number(val);
    }
    updates[key] = val;
  });

  const res = await api('/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });

  if (res && res.config) {
    showToast('Configuration saved successfully', 'success');
  } else {
    showToast(`Error: ${res?.error || 'Unknown error'}`, 'error');
  }
}

async function resetConfigToDefault() {
  if (!confirm('Reset all settings to defaults? This cannot be undone.')) return;
  const res = await api('/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      correlationThreshold: 0.75,
      cointegrationPValue: 0.05,
      lookbackPeriods: 168,
      entryZScore: 2.0,
      exitZScore: 0.5,
      stopLossZScore: 3.0,
      safeZoneBuffer: 0.5,
      autoTradingEnabled: true,
      maxLeverage: 5,
      maxCapitalPerPair: 100,
      maxOpenPairs: 3,
      cooldownMs: 3600000,
      gracePeriodMs: 300000,
      reconciliationIntervalMs: 60000,
      scanIntervalMs: 900000,
    }),
  });
  if (res && res.config) {
    showToast('Config reset to defaults', 'success');
    loadSettings();
  } else {
    showToast('Reset failed', 'error');
  }
}

function showToast(msg, type) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.style.cssText = `position:fixed;bottom:20px;right:20px;padding:10px 20px;border-radius:4px;
      font-family:var(--font-mono);font-size:12px;z-index:2000;transition:opacity .3s;`;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  if (type === 'success') {
    toast.style.background = 'rgba(0,255,136,.12)';
    toast.style.color = '#00ff88';
    toast.style.border = '1px solid rgba(0,255,136,.3)';
  } else {
    toast.style.background = 'rgba(255,68,68,.12)';
    toast.style.color = '#ff4444';
    toast.style.border = '1px solid rgba(255,68,68,.3)';
  }
  setTimeout(() => { toast.style.opacity = '0'; }, 3500);
}

// ═══════════════════════════════════════════════
//  AUTO SCHEDULER PAGE
// ═══════════════════════════════════════════════

async function loadAutoPage() {
  const scanStatus = await api('/scanner/status');
  if (!scanStatus) return;

  const autoOn = scanStatus.autoTradingEnabled !== false;
  setText('#auto-status-val', autoOn ? 'ENABLED' : 'DISABLED', autoOn ? 'val-positive' : 'val-negative');

  const intervalMin = scanStatus.scanIntervalMs ? Math.round(scanStatus.scanIntervalMs / 60000) : '—';
  setText('#auto-interval-val', intervalMin + 'm');

  const last = scanStatus.lastScanAt
    ? new Date(scanStatus.lastScanAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : 'Never';
  setText('#auto-last-scan-val', last);
  setText('#auto-pairs-val', scanStatus.symbolCount || 0);

  const btn = document.getElementById('btn-toggle-auto');
  if (btn) {
    btn.textContent = autoOn ? 'DISABLE AUTO TRADING' : 'ENABLE AUTO TRADING';
    btn.className = autoOn ? 'btn-terminal btn-danger' : 'btn-terminal btn-primary';
  }
}

async function toggleAutoTrading() {
  const scanStatus = await api('/scanner/status');
  const currentlyOn = scanStatus?.autoTradingEnabled !== false;
  const newVal = !currentlyOn;

  const res = await api('/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ autoTradingEnabled: newVal }),
  });
  if (res && res.config) {
    showToast(newVal ? 'Auto-trading ENABLED' : 'Auto-trading DISABLED', newVal ? 'success' : 'error');
    loadAutoPage();
    updateStatusBar();
  }
}

// ═══════════════════════════════════════════════
//  LOGS PAGE
// ═══════════════════════════════════════════════

async function loadLogsPage() {
  loadLogSignals();
  loadLogTrades();
}

function switchLogSubTab(tab) {
  $$('#log-subtabs .sub-tab').forEach(b => b.classList.toggle('active', b.dataset.subtab === tab));
  ['log-signals', 'log-trades', 'log-errors'].forEach(id => {
    const el = $(`#subtab-${id}`);
    if (el) el.classList.toggle('active', id === tab);
  });
}

async function loadLogSignals() {
  const data = await api('/signals');
  const tbody = $('#log-signals-tbody');
  if (!tbody) return;
  if (!data || !data.signals || data.signals.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-msg">No recent signals</td></tr>';
    return;
  }
  tbody.innerHTML = data.signals.slice(0, 50).map(s => {
    const time = new Date(s.timestamp || s.created_at).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
    const dirClass = s.direction === 'LONG_SPREAD' ? 'badge-long' : 'badge-short';
    const dirLabel = s.direction === 'LONG_SPREAD' ? 'LONG' : 'SHORT';
    return `<tr>
      <td style="color:var(--text-dim)">${time}</td>
      <td style="font-weight:600;color:var(--text-bright)">${s.pair}</td>
      <td><span class="badge-signal ${dirClass}">${dirLabel}</span></td>
      <td>${fmtNum(s.z_score, 2)}</td>
      <td style="color:var(--text-dim)">${s.status || 'GENERATED'}</td>
    </tr>`;
  }).join('');
}

async function loadLogTrades() {
  const data = await api('/positions/closed?limit=50');
  const tbody = $('#log-trades-tbody');
  if (!tbody) return;
  if (!data || !data.positions || data.positions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-msg">No trade history</td></tr>';
    return;
  }
  tbody.innerHTML = data.positions.map(p => {
    const dirClass = p.direction === 'LONG_SPREAD' ? 'badge-long' : 'badge-short';
    const dirLabel = p.direction === 'LONG_SPREAD' ? 'LONG' : 'SHORT';
    const pnl = p.pnl ?? 0;
    return `<tr>
      <td style="font-weight:600;color:var(--text-bright)">${p.pair}</td>
      <td><span class="badge-signal ${dirClass}">${dirLabel}</span></td>
      <td class="${valClass(pnl)}">${fmtUsd(pnl)}</td>
      <td>${p.close_reason ?? '—'}</td>
      <td style="color:var(--text-dim)">${p.opened_at ? new Date(p.opened_at).toLocaleDateString() : '—'}</td>
      <td style="color:var(--text-dim)">${p.closed_at ? new Date(p.closed_at).toLocaleDateString() : '—'}</td>
    </tr>`;
  }).join('');
}

// ═══════════════════════════════════════════════
//  ORPHAN MONITOR PAGE
// ═══════════════════════════════════════════════

async function loadOrphanPage() {
  loadOrdersPage();
}

async function loadOrdersPage() {
  const tbody = $('#orphan-tbody');
  if (!tbody) return;

  const [exchangeData, dbData] = await Promise.all([
    api('/positions/exchange'),
    api('/positions'),
  ]);

  if (!exchangeData || !exchangeData.connected) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-msg">OKX not connected — cannot check orphans</td></tr>';
    return;
  }

  const dbPairs = new Set((dbData?.positions || []).flatMap(p => {
    const parts = p.pair.split('/');
    return parts.map(s => s.toUpperCase());
  }));

  const positions = exchangeData.positions || [];
  if (positions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-msg">No open exchange positions</td></tr>';
    return;
  }

  tbody.innerHTML = positions.map(p => {
    const sym = (p.symbol || '').toUpperCase();
    const isTracked = dbPairs.has(sym);
    const statusHtml = isTracked
      ? '<span style="color:var(--neon-green)">TRACKED</span>'
      : '<span style="color:var(--neon-red);font-weight:700">ORPHAN</span>';
    const upl = p.upl ?? 0;
    return `<tr${!isTracked ? ' class="row-highlight"' : ''}>
      <td style="font-weight:600;color:var(--text-bright)">${p.symbol}</td>
      <td>${(p.side || '').toUpperCase()}</td>
      <td>${fmtNum(p.size, 4)}</td>
      <td class="${valClass(upl)}">${fmtUsd(upl)}</td>
      <td>${statusHtml}</td>
    </tr>`;
  }).join('');
}

// ═══════════════════════════════════════════════
//  INITIALIZATION
// ═══════════════════════════════════════════════

(function init() {
  startClock();
  startTickerTape();
  updateStatusBar();
  switchPage('scanner');

  // Periodic status bar refresh
  setInterval(updateStatusBar, 60000);
})();
