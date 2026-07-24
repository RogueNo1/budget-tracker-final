// ───────────────────────────────────────────────
// State
// ───────────────────────────────────────────────
let allTxns = [];       // everything loaded from Supabase for this user
let filteredTxns = [];  // after account/search/category/sort filters
let currentPage = 1;
const PAGE_SIZE = 20;
let currentAccount = '__all__';

const FALLBACK_COLORS = [
  '#4FB99F','#D4A73D','#C1602B','#A9713C','#6B4F3A','#5B87A6',
  '#8A7F6A','#9B8556','#D18B4A','#7A8FA0','#3F8F76','#5E9A87'
];
const CAT_COLORS = {
  'Coffee':'#A9713C','Rent':'#6B4F3A','Staff Fee':'#9B8556','ATM & Cash':'#C1602B','Deposits':'#4FB99F',
  'Dining':'#D18B4A','Fees':'#8C4A2A','Tithe':'#3F8F76','Groceries':'#5E9A87','Subscriptions':'#D4A73D',
  'Transportation':'#C98F4C','Health Insurance':'#5B87A6','Other':'#8A7F6A','Data':'#7A8FA0','Donations':'#4C9C82',
  'Uncategorised':'#8A7F6A'
};
let catColorMap = { ...CAT_COLORS };
let colorCursor = 0;
function colorFor(cat) {
  if (!catColorMap[cat]) catColorMap[cat] = FALLBACK_COLORS[colorCursor++ % FALLBACK_COLORS.length];
  return catColorMap[cat];
}

const CATEGORY_RULES = [
  { cat: 'Health Insurance', re: /health insur|blue cross|bcbs|aetna|cigna|united ?health|medical insur/i },
  { cat: 'Tithe',            re: /\btithe\b/i },
  { cat: 'Donations',        re: /donation|charity|nonprofit|non-profit|missions?/i },
  { cat: 'Rent',             re: /\brent\b|landlord|apartment|lease/i },
  { cat: 'Staff Fee',        re: /staff fee|agency fee/i },
  { cat: 'Coffee',           re: /starbucks|coffee|dunkin|caribou/i },
  { cat: 'Dining',           re: /restaurant|mcdonald|chipotle|doordash|grubhub|uber ?eats/i },
  { cat: 'Groceries',        re: /grocery|walmart|kroger|aldi|trader joe|meijer|whole foods/i },
  { cat: 'Subscriptions',    re: /uber \*one|netflix|spotify|hulu|subscription|membership/i },
  { cat: 'Data',             re: /\bdata\b|verizon|at&t|t-mobile|tmobile|internet|comcast|xfinity|data plan/i },
  { cat: 'Transportation',   re: /uber|lyft|gas station|shell|exxon|chevron|parking/i },
  { cat: 'Fees',             re: /foreign cur con|overdraft|nsf|service fee|\bfee\b/i },
  { cat: 'ATM & Cash',       re: /atm\/(dep|wdr)/i },
  { cat: 'Deposits',         re: /remote dep capture|mobile deposit|payroll|direct dep|salary|paycheck/i },
];
function categorize(description) {
  for (const r of CATEGORY_RULES) if (r.re.test(description)) return r.cat;
  return 'Uncategorised';
}

// ───────────────────────────────────────────────
// Dedupe key — same account + date + amount + first
// part of the description always hashes the same,
// regardless of which file it was imported from or
// how many times it's re-imported.
// ───────────────────────────────────────────────
function dedupeKey(t) {
  const raw = [
    (t.account || '').trim().toLowerCase(),
    t.date,
    t.amount.toFixed(2),
    (t.description || '').trim().toLowerCase().slice(0, 60)
  ].join('|');
  let hash = 5381;
  for (let i = 0; i < raw.length; i++) hash = ((hash * 33) ^ raw.charCodeAt(i)) >>> 0;
  return hash.toString(16);
}

function toISODate(d) {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  const parsed = new Date(d);
  if (!isNaN(parsed)) return parsed.toISOString().slice(0, 10);
  return String(d);
}

// ───────────────────────────────────────────────
// CSV parsing (bank export format)
// ───────────────────────────────────────────────
function parseCSVText(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  return lines.slice(1).filter(Boolean).map(line => {
    const cols = [];
    let inQ = false, cur = '';
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    cols.push(cur.trim());
    const row = {};
    headers.forEach((h, idx) => { row[h] = cols[idx] || ''; });
    return row;
  });
}

function normaliseCSVRows(rows, fallbackAccount) {
  return rows.map(r => {
    const moneyIn = parseFloat(r['Money In']) || 0;
    const moneyOutRaw = parseFloat(r['Money Out']) || 0;
    const moneyOut = moneyOutRaw > 0 ? -moneyOutRaw : moneyOutRaw; // ensure negative
    const amount = moneyIn > 0 ? moneyIn : moneyOut;
    const description = r['Description'] || r['Original Description'] || '(transaction)';
    const t = {
      account: r['Account'] || fallbackAccount,
      date: toISODate(r['Posting Date'] || r['Transaction Date']),
      description,
      category: r['Category'] || categorize(description),
      amount,
      fee: Math.abs(parseFloat(r['Fee']) || 0),
      balance: r['Balance'] !== undefined && r['Balance'] !== '' ? parseFloat(r['Balance']) : null,
    };
    t.dedupe_key = dedupeKey(t);
    return t;
  });
}

// ───────────────────────────────────────────────
// PDF parsing (bank statement format)
// ───────────────────────────────────────────────
const DATE_RE = /^(\d{1,2}\/\d{1,2}\/\d{2,4})\b/;
const AMOUNT_RE = /\$?-?[\d,]+\.\d{2}-?/g;
const SKIP_LINE_RE = /^(Date|Transaction Type|Disclosures|Member #|Page \d|Your savings|Loan number|If you think|In Case of|Telephone or write|We will tell|If we decide|This error correction|\* This error|\*\* If you|\*\*\* If you|Special Rule)/i;

async function extractPDFLines(pdf) {
  const lines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = content.items
      .map(it => ({ text: it.str, x: it.transform[4], y: it.transform[5] }))
      .filter(it => it.text.trim().length > 0);
    const rows = {};
    items.forEach(it => {
      const key = Math.round(it.y);
      let bucket = key;
      const existingKeys = Object.keys(rows).map(Number);
      const near = existingKeys.find(k => Math.abs(k - key) <= 2);
      if (near !== undefined) bucket = near;
      if (!rows[bucket]) rows[bucket] = [];
      rows[bucket].push(it);
    });
    const sortedKeys = Object.keys(rows).map(Number).sort((a, b) => b - a);
    sortedKeys.forEach(k => {
      const rowItems = rows[k].sort((a, b) => a.x - b.x);
      const text = rowItems.map(i => i.text).join(' ').replace(/\s+/g, ' ').trim();
      if (text) lines.push(text);
    });
  }
  return lines;
}

function parsePDFLines(lines) {
  const txns = [];
  let current = null;
  lines.forEach(line => {
    const dm = line.match(DATE_RE);
    if (dm) {
      if (current) txns.push(current);
      const rest = line.slice(dm[0].length).trim();
      if (/beginning balance|ending balance/i.test(rest)) { current = null; return; }
      const amounts = rest.match(AMOUNT_RE) || [];
      if (amounts.length === 0) { current = null; return; }
      const balanceTok = amounts[amounts.length - 1];
      const amountTok = amounts.length > 1 ? amounts[0] : null;
      let typeText = rest;
      amounts.forEach(a => { typeText = typeText.replace(a, ''); });
      typeText = typeText.replace(/\*\*\d+\s*:\s*[^\w]*[A-Za-z ]*$/, '').trim();
      typeText = typeText.replace(/\s{2,}/g, ' ').trim();
      let signed = 0;
      if (amountTok) {
        const isNeg = amountTok.trim().endsWith('-');
        const val = parseFloat(amountTok.replace(/[^0-9.]/g, ''));
        signed = isNeg ? -val : val;
      }
      current = {
        dateStr: dm[0],
        date: parsePDFDate(dm[0]),
        type: typeText || '(transaction)',
        description: '',
        amount: signed,
        balance: parseFloat(balanceTok.replace(/[^0-9.]/g, ''))
      };
    } else if (current) {
      if (SKIP_LINE_RE.test(line)) return;
      if (/^\$?-?[\d,]+\.\d{2}-?$/.test(line)) return;
      current.description += (current.description ? ' ' : '') + line;
    }
  });
  if (current) txns.push(current);
  return txns.filter(t => t.amount !== 0 || t.description);
}

function parsePDFDate(s) {
  const [m, d, y] = s.split('/').map(Number);
  const year = y < 100 ? 2000 + y : y;
  return new Date(year, m - 1, d);
}

async function parsePDFFile(file, fallbackAccount) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const lines = await extractPDFLines(pdf);
  const raw = parsePDFLines(lines);
  return raw.map(r => {
    const fullDesc = (r.type + (r.description ? ' ' + r.description : '')).trim();
    const t = {
      account: fallbackAccount,
      date: toISODate(r.date),
      description: fullDesc,
      category: categorize(fullDesc),
      amount: r.amount,
      fee: 0,
      balance: isNaN(r.balance) ? null : r.balance,
    };
    t.dedupe_key = dedupeKey(t);
    return t;
  });
}

// ───────────────────────────────────────────────
// File handling
// ───────────────────────────────────────────────
function setStatus(msg, kind) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = kind || '';
}

async function handleFiles(fileList) {
  const files = Array.from(fileList);
  if (files.length === 0) return;

  let account = currentAccount;
  if (account === '__all__') {
    account = await promptForAccountName('Default');
    if (!account) { setStatus('Import cancelled — an account name is needed.', ''); return; }
  }

  setStatus('Reading ' + files.length + ' file(s)…', 'muted');
  let collected = [];
  try {
    for (const file of files) {
      if (file.name.toLowerCase().endsWith('.csv') || file.type === 'text/csv') {
        const text = await file.text();
        const rows = parseCSVText(text).filter(r => r['Description'] || r['Nr']);
        collected = collected.concat(normaliseCSVRows(rows, account));
      } else if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        collected = collected.concat(await parsePDFFile(file, account));
      }
    }
  } catch (err) {
    setStatus('Something went wrong reading that file: ' + err.message, '');
    return;
  }

  if (collected.length === 0) {
    setStatus("Couldn't find any transactions in that file.", '');
    return;
  }

  // Skip anything that's already loaded, client-side, before we even
  // make the request (the server enforces this too, as a safety net).
  const known = new Set(allTxns.map(t => t.account + '::' + t.dedupe_key));
  const fresh = collected.filter(t => !known.has(t.account + '::' + t.dedupe_key));

  if (fresh.length === 0) {
    setStatus('All ' + collected.length + ' transactions in that file were already in your ledger — nothing new to add.', 'muted');
    return;
  }

  setStatus('Saving ' + fresh.length + ' transaction(s)…', 'muted');
  try {
    const result = await Api.importTransactions(fresh);
    const skipped = collected.length - fresh.length + (result.skipped || 0);
    setStatus(
      'Loaded ' + (result.inserted != null ? result.inserted : fresh.length) + ' new transaction(s).' +
      (skipped > 0 ? ' Skipped ' + skipped + ' duplicate(s).' : ''),
      'ok'
    );
  } catch (err) {
    setStatus('Could not save transactions: ' + err.message, '');
    return;
  }

  await reload();
}

// ───────────────────────────────────────────────
// Loading from the backend + account switcher
// ───────────────────────────────────────────────
async function reload() {
  setStatus('Loading your ledger…', 'muted');
  try {
    allTxns = await Api.fetchTransactions();
  } catch (err) {
    setStatus('Could not load transactions: ' + err.message, '');
    return;
  }
  setStatus(allTxns.length ? '' : 'No transactions yet — import a CSV or PDF above.', 'muted');
  buildAccountSelect();
  document.getElementById('dashboard').classList.toggle('visible', allTxns.length > 0);
  applyFilters();
}

function buildAccountSelect() {
  const sel = document.getElementById('account-select');
  const accounts = Array.from(new Set(allTxns.map(t => t.account))).sort();
  const prev = currentAccount;
  sel.innerHTML = '<option value="__all__">All accounts</option>' +
    accounts.map(a => `<option value="${a}">${a}</option>`).join('');
  currentAccount = accounts.includes(prev) ? prev : '__all__';
  sel.value = currentAccount;
  buildCategoryFilter();
}

function buildCategoryFilter() {
  const sel = document.getElementById('catFilter');
  const cats = Array.from(new Set(scopedTxns().map(t => t.category))).sort();
  const prev = sel.value;
  sel.innerHTML = '<option value="">All categories</option>' + cats.map(c => `<option value="${c}">${c}</option>`).join('');
  sel.value = cats.includes(prev) ? prev : '';
}

function scopedTxns() {
  return currentAccount === '__all__' ? allTxns : allTxns.filter(t => t.account === currentAccount);
}

// ───────────────────────────────────────────────
// Filters, sort & render
// ───────────────────────────────────────────────
function fmt(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function applyFilters() {
  const scope = scopedTxns();
  const search = document.getElementById('search').value.toLowerCase();
  const cat = document.getElementById('catFilter').value;
  const sort = document.getElementById('sortSelect').value;

  filteredTxns = scope.filter(t => {
    if (search && !t.description.toLowerCase().includes(search) && !t.category.toLowerCase().includes(search)) return false;
    if (cat && t.category !== cat) return false;
    return true;
  });

  filteredTxns.sort((a, b) => {
    if (sort === 'date-desc') return new Date(b.date) - new Date(a.date);
    if (sort === 'date-asc') return new Date(a.date) - new Date(b.date);
    if (sort === 'amount-desc') return b.amount - a.amount;
    if (sort === 'amount-asc') return a.amount - b.amount;
    return 0;
  });

  currentPage = 1;
  renderSummary(scope);
  renderCharts(scope);
  renderTable();
  renderPagination();
}

function renderSummary(scope) {
  const income = scope.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const expense = scope.filter(t => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);
  document.getElementById('totalIn').textContent = fmt(income);
  document.getElementById('totalOut').textContent = fmt(expense);
  document.getElementById('netChange').textContent = fmt(income - expense);
  const withBalance = scope.filter(t => t.balance !== null).sort((a, b) => new Date(a.date) - new Date(b.date));
  const last = withBalance[withBalance.length - 1];
  document.getElementById('endBalance').textContent = last ? fmt(last.balance) : '—';
  document.getElementById('inSub').textContent = scope.filter(t => t.amount > 0).length + ' payments in';
  document.getElementById('outSub').textContent = scope.filter(t => t.amount < 0).length + ' payments out';
  const sorted = [...scope].sort((a, b) => new Date(a.date) - new Date(b.date));
  const first = sorted[0], lastTxn = sorted[sorted.length - 1];
  document.getElementById('endSub').textContent = (first && lastTxn) ? (first.date + ' → ' + lastTxn.date) : '';
}

function renderCharts(scope) {
  renderDonut(scope);
  renderBalanceLine(scope);
}

function renderDonut(scope) {
  const catTotals = {};
  scope.forEach(t => { if (t.amount < 0) catTotals[t.category] = (catTotals[t.category] || 0) + Math.abs(t.amount); });
  const sorted = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((s, [, v]) => s + v, 0);
  const svgEl = document.getElementById('donut-svg');
  const legend = document.getElementById('donut-legend');
  if (total === 0) { svgEl.innerHTML = ''; legend.innerHTML = '<span style="color:var(--muted)">No spending yet</span>'; return; }

  const cx = 70, cy = 70, r = 58, inner = 38;
  let angle = -Math.PI / 2;
  let paths = '';
  sorted.forEach(([cat, val]) => {
    const slice = (val / total) * Math.PI * 2;
    const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
    angle += slice;
    const x2 = cx + r * Math.cos(angle), y2 = cy + r * Math.sin(angle);
    const ix1 = cx + inner * Math.cos(angle - slice), iy1 = cy + inner * Math.sin(angle - slice);
    const ix2 = cx + inner * Math.cos(angle), iy2 = cy + inner * Math.sin(angle);
    const large = slice > Math.PI ? 1 : 0;
    paths += `<path d="M${x1},${y1} A${r},${r} 0 ${large},1 ${x2},${y2} L${ix2},${iy2} A${inner},${inner} 0 ${large},0 ${ix1},${iy1} Z" fill="${colorFor(cat)}" opacity="0.92"><title>${cat}: ${fmt(val)}</title></path>`;
  });
  svgEl.innerHTML = paths + `<circle cx="${cx}" cy="${cy}" r="${inner-2}" fill="var(--panel)"/>`;
  legend.innerHTML = sorted.slice(0, 8).map(([cat, val]) => `
    <div class="donut-item">
      <div class="donut-dot" style="background:${colorFor(cat)}"></div>
      <span class="donut-item-label">${cat}</span>
      <span class="donut-item-val">${fmt(val)}</span>
    </div>`).join('');
}

function renderBalanceLine(scope) {
  const pts = scope.filter(t => t.balance !== null)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map(t => ({ date: t.date, balance: t.balance }));
  const svgEl = document.getElementById('balance-svg');
  if (pts.length < 2) { svgEl.innerHTML = ''; return; }

  const W = 420, H = 160, PAD = 24;
  const minB = Math.min(...pts.map(p => p.balance));
  const maxB = Math.max(...pts.map(p => p.balance));
  const range = maxB - minB || 1;
  const toX = i => PAD + (i / (pts.length - 1)) * (W - PAD * 2);
  const toY = b => PAD + (1 - (b - minB) / range) * (H - PAD * 2);
  const linePts = pts.map((p, i) => `${toX(i)},${toY(p.balance)}`).join(' ');
  const areaPts = `${toX(0)},${H} ${linePts} ${toX(pts.length - 1)},${H}`;

  svgEl.innerHTML = `
    <defs>
      <linearGradient id="balGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--gold)" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="var(--gold)" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <polygon points="${areaPts}" fill="url(#balGrad)"/>
    <polyline points="${linePts}" fill="none" stroke="var(--gold)" stroke-width="2" stroke-linejoin="round"/>
    <text x="${PAD}" y="${H-6}" font-family="IBM Plex Mono,monospace" font-size="10" fill="var(--muted)">${fmt(minB)}</text>
    <text x="${PAD}" y="${PAD+2}" font-family="IBM Plex Mono,monospace" font-size="10" fill="var(--muted)">${fmt(maxB)}</text>
  `;
}

function renderTable() {
  const start = (currentPage - 1) * PAGE_SIZE;
  const slice = filteredTxns.slice(start, start + PAGE_SIZE);
  const tbody = document.getElementById('tbody');
  tbody.innerHTML = slice.map(t => `
    <tr onclick='openModal(${JSON.stringify(t.dedupe_key)})'>
      <td class="date">${t.date}</td>
      <td class="desc">${t.description}</td>
      <td><span class="cat-pill"><span class="cat-dot" style="background:${colorFor(t.category)}"></span>${t.category}</span></td>
      <td class="amt ${t.amount >= 0 ? 'pos' : 'neg'}">${t.amount >= 0 ? '+' : ''}${fmt(t.amount)}</td>
      <td class="bal">${t.balance !== null ? fmt(t.balance) : '—'}</td>
    </tr>
  `).join('');
  document.getElementById('rowCount').textContent = filteredTxns.length + ' transaction(s)';
}

function renderPagination() {
  const total = Math.ceil(filteredTxns.length / PAGE_SIZE);
  const el = document.getElementById('pagination');
  if (total <= 1) { el.innerHTML = ''; return; }
  let html = `<button class="page-btn" onclick="goPage(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''}>←</button>`;
  for (let i = 1; i <= total; i++) {
    if (i === 1 || i === total || Math.abs(i - currentPage) <= 2) {
      html += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="goPage(${i})">${i}</button>`;
    } else if (Math.abs(i - currentPage) === 3) {
      html += `<span style="color:var(--muted)">…</span>`;
    }
  }
  html += `<button class="page-btn" onclick="goPage(${currentPage + 1})" ${currentPage === total ? 'disabled' : ''}>→</button>`;
  el.innerHTML = html;
}

function goPage(n) {
  const total = Math.ceil(filteredTxns.length / PAGE_SIZE);
  if (n < 1 || n > total) return;
  currentPage = n;
  renderTable();
  renderPagination();
}

function openModal(key) {
  const t = filteredTxns.find(x => x.dedupe_key === key) || allTxns.find(x => x.dedupe_key === key);
  if (!t) return;
  document.getElementById('modal-title').textContent = t.description;
  const rows = [
    ['Amount', (t.amount >= 0 ? '+' : '') + fmt(t.amount)],
    ['Date', t.date],
    ['Category', t.category],
    ['Fee', t.fee ? fmt(t.fee) : '—'],
    ['Balance after', t.balance !== null ? fmt(t.balance) : '—'],
    ['Account', t.account],
  ];
  document.getElementById('modal-body').innerHTML = rows.map(([k, v]) => `
    <div class="modal-row"><span class="modal-key">${k}</span><span class="modal-val">${v}</span></div>
  `).join('');
  document.getElementById('modal-overlay').classList.add('open');
}

// ───────────────────────────────────────────────
// Small "name this account" prompt (styled, since
// a bare window.prompt() clashes with the design)
// ───────────────────────────────────────────────
function promptForAccountName(defaultVal) {
  return new Promise(resolve => {
    const overlay = document.getElementById('prompt-overlay');
    const input = document.getElementById('prompt-input');
    input.value = defaultVal || '';
    overlay.classList.add('open');
    input.focus();

    function cleanup(result) {
      overlay.classList.remove('open');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      resolve(result);
    }
    const okBtn = document.getElementById('prompt-ok');
    const cancelBtn = document.getElementById('prompt-cancel');
    function onOk() { cleanup(input.value.trim() || null); }
    function onCancel() { cleanup(null); }
    function onKey(e) { if (e.key === 'Enter') onOk(); if (e.key === 'Escape') onCancel(); }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  });
}

// ───────────────────────────────────────────────
// Wiring
// ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  Auth.init(reload);

  document.getElementById('choose-file-btn').onclick = () => document.getElementById('fileInput').click();
  document.getElementById('fileInput').addEventListener('change', e => handleFiles(e.target.files));

  const dz = document.getElementById('dropzone');
  dz.addEventListener('click', e => { if (e.target === dz) document.getElementById('fileInput').click(); });
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag'); handleFiles(e.dataTransfer.files); });

  document.getElementById('account-select').addEventListener('change', e => {
    currentAccount = e.target.value;
    buildCategoryFilter();
    applyFilters();
  });
  document.getElementById('new-account-btn').addEventListener('click', async () => {
    const name = await promptForAccountName('');
    if (name) {
      currentAccount = name; // will be used as the account for the next import
      setStatus('New imports will be filed under "' + name + '" until you pick another account.', 'muted');
    }
  });

  document.getElementById('search').addEventListener('input', applyFilters);
  document.getElementById('catFilter').addEventListener('change', applyFilters);
  document.getElementById('sortSelect').addEventListener('change', applyFilters);

  document.getElementById('modal-close').addEventListener('click', () => document.getElementById('modal-overlay').classList.remove('open'));
  document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target.id === 'modal-overlay') e.target.classList.remove('open'); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') document.getElementById('modal-overlay').classList.remove('open'); });
});
