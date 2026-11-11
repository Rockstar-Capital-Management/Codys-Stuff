// Mac version of refresh.ps1: refreshes the Rockstar bank-balance dashboard (Codys-Stuff/index.html).
//
// Reads ~Bank Balances~.xlsm and Refunds & Reserves Tracker.xlsx straight from the synced SharePoint folder
// (no Excel needed, the files are only read) and regenerates the four marker-fenced data blocks in index.html:
//   GEN:LOANS    internal loans (Internal Loans sheet)
//   GEN:BAL      month-end series (Historical) + current operating/reserve + lender-held escrow (Current Snapshot)
//   GEN:REFUNDS  refunds (tracker)
//   GEN:DAILY    daily per-property balances since 2024-01-01 (Historical)
//
//   node refresh.js --repo <Codys-Stuff folder>              dry run: writes index.candidate.html, changes nothing else
//   node refresh.js --repo <folder> --out <file>             dry run to a file of your choice
//   node refresh.js --repo <folder> --deploy                 writes index.html, commits and pushes (Vercel deploys)
//   node refresh.js --repo <folder> --scheduled              one unattended attempt: skips if already done today or
//                                                            the workbook was not saved today, otherwise deploys
// Nothing is written or pushed if validation fails.
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, appendFileSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const XLSX = createRequire(import.meta.url)('xlsx')

// ---------------- config ----------------
const HERE = dirname(fileURLToPath(import.meta.url))
const BANK_DIR = process.env.BANK_BALANCES_DIR ??
  join(homedir(), 'Library/CloudStorage/OneDrive-RockstarCapital/RCM SharePoint/Corporate Asset Management/Bank Balances')
const WB = join(BANK_DIR, '~Bank Balances~.xlsm')
const TRACKER = join(BANK_DIR, 'Refunds & Reserves Tracker.xlsx')
const LOG = join(HERE, 'refresh.log')
const MARKER = join(HERE, 'last-success.txt')
const BASELINE_LAST = 'Jul-2026' // RAW_DATA baseline in index.html ends here; the series is appended after this
const RCM_NAMES = ['RCM Clearing', 'RCM Main OPS', 'Rockstar MMA', 'RCM Academy']
const PROPS = ['Apple Creek', 'Brookmore Hollow', 'Cedar Ridge', 'Churchill Square', 'City Crossing', 'Deerbrook Forest', 'Deerbrook Gardens', 'Green Meadows', 'Huntington Oaks', 'Kingsville Pointe', 'Lakeview at Westpark', 'Meadow Park', 'Meadowbrook', 'Newport Oaks', 'Oak Tree', 'Parkside', 'Reserve on Garth Rd', 'Steeplechase', 'Valencia Place', 'Rockstar Waterchase', 'Westwood Village']
const PSET = new Set(PROPS)
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const argv = process.argv.slice(2)
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null }
const REPO = opt('--repo')
const SCHEDULED = argv.includes('--scheduled')
const DEPLOY = argv.includes('--deploy') || SCHEDULED
if (!REPO) { console.error('Pass --repo <path to the Codys-Stuff folder>'); process.exit(1) }
const HTML_PATH = join(REPO, 'index.html')

const pad = (n) => String(n).padStart(2, '0')
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
const localDay = (d = new Date()) => stamp(d).slice(0, 10)
function log(msg) { const line = `${stamp()}  ${msg}`; appendFileSync(LOG, line + '\n'); console.log(line) }

// ---------------- helpers that mirror the PowerShell version ----------------
const txt = (v) => (v == null ? '' : String(v)).trim()
const num = (v) => { // like `-as [double]`: a number, numeric text, or nothing
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
  return null
}
function mapProp(n) { // balances/escrow: old Waterchase residual dropped (double-counts), Bender/Westport sold
  n = txt(n)
  if (n === 'Reserve on Garth') return 'Reserve on Garth Rd'
  if (n === 'Deerbrook Garden') return 'Deerbrook Gardens'
  if (n === 'Rockstar Waterchase' || n === 'Rockstar Waterchase LLC') return 'Rockstar Waterchase'
  if (n === 'Waterchase' || n === 'Bender Hollow' || n === 'Westport') return '__DROP__'
  return n
}
function mapLoanProp(n) { // loans: fold old Waterchase into Rockstar Waterchase, drop only Westport
  n = txt(n)
  if (n === 'Reserve on Garth') return 'Reserve on Garth Rd'
  if (n === 'Waterchase' || n === 'Rockstar Waterchase LLC') return 'Rockstar Waterchase'
  if (n === 'Westport') return '__DROP__'
  return n
}
const escJson = (s) => (s == null ? '' : String(s)).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\t', ' ').replaceAll('\r', '').replaceAll('\n', ' ').trim()
// Numbers print with 15 significant digits, as the Windows version did, so unchanged values produce no diff.
const numJson = (d) => (Number.isInteger(d) && Math.abs(d) < 1e15 ? String(d) : String(Number(Number(d).toPrecision(15))))
const round2 = (v) => { // round half to even at 2 decimals, as .NET Math.Round(x, 2)
  const x = (v ?? 0) * 100, f = Math.floor(x), diff = x - f
  const r = diff > 0.5 ? f + 1 : diff < 0.5 ? f : f % 2 === 0 ? f : f + 1
  return r / 100
}
const oaDate = (serial) => new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000) // Excel serial -> UTC midnight
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
const oaOrText = (v) => (typeof v === 'number' ? ymd(oaDate(v)) : txt(v))
const monthKey = (d) => `${MON[d.getUTCMonth()]}-${d.getUTCFullYear()}`
const monthLabel = (d) => `${MON[d.getUTCMonth()]}-${String(d.getUTCFullYear()).slice(2)}`
const byName = (a, b) => a.localeCompare(b, 'en-US')

const errors = []
const fail = (m) => { errors.push(m); log(`VALIDATION FAIL: ${m}`) }

function openBook(path) { return XLSX.read(readFileSync(path), { cellDates: false, cellFormula: false, cellHTML: false, cellStyles: false }) }
function sheetOf(book, name) { const ws = book.Sheets[name]; if (!ws) throw new Error(`sheet "${name}" not found`); return ws }
// Raw cell value by 1-based row/column, like Range.Value2 (dates stay serial numbers, error cells count as empty).
function val(ws, r, c) { const cell = ws[XLSX.utils.encode_cell({ r: r - 1, c: c - 1 })]; return !cell || cell.t === 'e' || cell.v === undefined ? null : cell.v }
const used = (ws) => { const g = XLSX.utils.decode_range(ws['!ref'] ?? 'A1'); return { rows: g.e.r + 1, cols: g.e.c + 1 } }

// ---------------- scheduled mode: one attempt, same rules as run-with-retry.ps1 ----------------
if (SCHEDULED) {
  const today = localDay()
  if (existsSync(MARKER) && readFileSync(MARKER, 'utf8').trim() === today) process.exit(0) // already done today
  if (!existsSync(WB)) { log('[retry] workbook not reachable (OneDrive offline or still syncing?)'); process.exit(1) }
  const saved = statSync(WB).mtime
  if (localDay(saved) < today) { log(`[retry] workbook not updated today yet (last saved ${stamp(saved)})`); process.exit(1) }
}

// ---------------- read the workbook ----------------
if (!existsSync(WB)) { log(`ABORT: workbook not found at ${WB}`); process.exit(2) }
let book
try { book = openBook(WB) } catch (e) { log(`ABORT: could not read workbook (offline or still syncing?): ${e.message}`); process.exit(2) }

let html, snapDate
try {
  const hist = sheetOf(book, 'Historical'), snap = sheetOf(book, 'Current Snapshot'), loanSheet = sheetOf(book, 'Internal Loans')

  // date -> column map from Historical row 2 (cols 3..80 cover recent months)
  const dateCol = {}
  for (let c = 3; c <= 80; c++) { const v = num(val(hist, 2, c)); if (v != null && v > 40000) dateCol[ymd(oaDate(v))] = c }
  const HROWS = Array.from({ length: 198 }, (_, i) => i + 3) // rows 3..200
  const colA = HROWS.map((r) => txt(val(hist, r, 1))), colB = HROWS.map((r) => txt(val(hist, r, 2)))

  const colForMonthClose = (firstOfNext) => {
    for (let k = 0; k <= 7; k++) { const t = ymd(new Date(firstOfNext.getTime() + k * 86400000)); if (dateCol[t]) return { col: dateCol[t], date: t } }
    return null
  }
  const extractHistMonth = (col) => {
    const raw = {}, rcm = {}
    HROWS.forEach((r, i) => {
      const prop = colA[i], acct = colB[i]
      if (prop === '') return
      const d = num(val(hist, r, col)) ?? 0
      if (RCM_NAMES.some((n) => n.toLowerCase() === prop.toLowerCase()) && !/Sum of Accounts/i.test(acct)) { rcm[prop] = d; return }
      if (/Sum of Accounts/i.test(acct) || /Sum of All|RCM Accounts|RCM Clearing/i.test(prop)) return
      const mp = mapProp(prop); if (mp === '__DROP__' || !PSET.has(mp)) return
      raw[mp] = (raw[mp] ?? 0) + d
    })
    return { raw, rcm }
  }

  // ---- appended monthly series (month after the baseline .. latest closed month) ----
  const now = new Date()
  const todayUTC = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes()))
  const [bm, by] = BASELINE_LAST.split('-')
  let cur = new Date(Date.UTC(+by, MON.indexOf(bm), 1))
  const genMonths = []
  while (true) {
    cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1)) // month we're trying to append
    const firstOfNext = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1)) // its close = first of the following month
    if (firstOfNext > todayUTC) break // month hasn't closed yet
    const c = colForMonthClose(firstOfNext)
    if (!c) break // close balance not in the workbook yet
    const ext = extractHistMonth(c.col)
    if (Object.keys(ext.raw).length < 21) fail(`month ${monthKey(cur)}: only ${Object.keys(ext.raw).length}/21 properties from Historical col ${c.col} (${c.date})`)
    genMonths.push({ key: monthKey(cur), label: monthLabel(cur), closeDate: c.date, raw: ext.raw, rcm: ext.rcm })
  }
  log('appended months: ' + genMonths.map((m) => `${m.key}<-${m.closeDate}`).join(', '))

  // ---- current operating/reserve + lender-held escrow from Current Snapshot ----
  const h1 = val(snap, 1, 8)
  snapDate = typeof h1 === 'number' ? (() => { const d = oaDate(h1); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}` })() : txt(h1)
  const op = {}, res = {}, esc = {}
  let lastProp = null
  for (let r = 4; r <= 330; r++) {
    const prop = txt(val(snap, r, 2)), acct = txt(val(snap, r, 4)), type = txt(val(snap, r, 7))
    const notProp = /^RCM|Sum of All/i.test(prop)
    if (prop !== '' && !notProp) lastProp = prop
    if (prop !== '' && acct !== '' && !/Sum of Accounts/i.test(acct) && !notProp) { // bank account rows
      const mp = mapProp(prop)
      if (mp !== '__DROP__' && PSET.has(mp)) {
        const v = num(val(snap, r, 8)) ?? 0
        if (!(mp in op)) { op[mp] = 0; res[mp] = 0 }
        if (/Operating/i.test(type)) op[mp] += v; else res[mp] += v // escrow bank accounts (~0) fold into reserve
      }
    }
    if (txt(val(snap, r, 20)) === 'Total Escrows') { // lender-held escrow, tied to the last property seen
      const mp = mapProp(lastProp)
      if (mp !== '__DROP__' && PSET.has(mp)) esc[mp] = num(val(snap, r, 21)) ?? 0
    }
  }
  if ('Kingsville Pointe' in esc) esc['Kingsville Pointe'] = 0 // collateral = its Reserve bank account; avoid double-count
  for (const p of PROPS) {
    if (!(p in op)) fail(`current op/reserve missing for ${p}`)
    else if (op[p] + res[p] <= 0) fail(`current op+reserve non-positive for ${p} (${(op[p] + res[p]).toFixed(2)})`)
  }

  // ---- internal loans ----
  const loans = []
  for (let r = 2; r <= 203; r++) {
    const g = (c) => val(loanSheet, r, c)
    if (g(1) == null && g(2) == null && g(8) == null) continue
    const lender = mapLoanProp(g(1)), borrower = mapLoanProp(g(2))
    if (lender === '__DROP__' || borrower === '__DROP__') continue // loans touching Westport (sold)
    const amount = num(g(8)); if (amount == null) continue
    const payments = []
    for (const [ac, dc] of [[9, 10], [11, 12], [13, 14], [15, 16]]) {
      const pv = num(g(ac))
      if (pv != null && pv !== 0) payments.push({ amount: pv, date: oaOrText(g(dc)) })
    }
    loans.push({ lender, borrower, purpose: txt(g(3)), initiation: oaOrText(g(4)), est_reimb: oaOrText(g(5)), status: txt(g(7)) || 'Outstanding', amount, payments })
  }
  if (loans.length < 50) fail(`only ${loans.length} internal loans parsed (expected 100+)`)
  log(`parsed ${loans.length} internal loans; snapshot date ${snapDate}`)

  // ---- refunds (tracker) ----
  const refunds = []
  if (existsSync(TRACKER)) {
    try {
      const rs = sheetOf(openBook(TRACKER), 'Refunds & Reserves')
      for (let r = 2; r <= used(rs).rows; r++) {
        const prop = mapProp(val(rs, r, 1))
        if (prop === '__DROP__' || !PSET.has(prop)) continue
        const amount = num(val(rs, r, 3)); if (amount == null) continue
        const date = oaOrText(val(rs, r, 6)); if (date === '') continue
        refunds.push({ property: prop, checktype: txt(val(rs, r, 2)), amount, account: txt(val(rs, r, 5)), date, notes: txt(val(rs, r, 7)) })
      }
      log(`parsed ${refunds.length} refunds from tracker.`)
    } catch (e) { fail(`could not read refunds tracker: ${e.message}`) }
  } else fail(`refunds tracker not found at ${TRACKER}`)

  // ---- daily per-property balances for the Variances tab (Historical, >= 2024-01-01) ----
  const cutoff = Date.UTC(2024, 0, 1)
  const dcols = []
  for (let c = 3; c <= used(hist).cols; c++) { const v = num(val(hist, 2, c)); if (v != null && v > 40000) { const d = oaDate(v); if (d.getTime() >= cutoff) dcols.push({ col: c, d }) } }
  dcols.sort((a, b) => a.d - b.d)
  const dailyBal = Object.fromEntries(PROPS.map((p) => [p, []]))
  for (const dc of dcols) {
    const sum = {}
    HROWS.forEach((r, i) => {
      const prop = colA[i], acct = colB[i]
      if (prop === '' || /Sum of Accounts/i.test(acct) || /Sum of All|RCM/i.test(prop)) return
      const mp = mapProp(prop); if (mp === '__DROP__' || !PSET.has(mp)) return
      sum[mp] = (sum[mp] ?? 0) + (num(val(hist, r, dc.col)) ?? 0)
    })
    for (const p of PROPS) dailyBal[p].push(round2(sum[p]))
  }
  const dailyDates = dcols.map((x) => ymd(x.d))
  log(`daily series: ${dailyDates.length} days (${dailyDates[0] ?? '-'} .. ${dailyDates.at(-1) ?? '-'})`)

  // ---------------- generate the JS blocks ----------------
  const blockLoans = 'const INTERNAL_LOANS = [' + loans.map((L) =>
    `{"lender":"${escJson(L.lender)}","borrower":"${escJson(L.borrower)}","purpose":"${escJson(L.purpose)}","initiation":"${escJson(L.initiation)}","est_reimb":"${escJson(L.est_reimb)}","status":"${escJson(L.status)}","amount":${numJson(L.amount)},"payments":[` +
    L.payments.map((p) => `{"amount":${numJson(p.amount)},"date":"${escJson(p.date)}"}`).join(',') + ']}').join(',') + '];'

  const objJson = (h) => '{' + Object.keys(h).sort(byName).map((k) => `"${escJson(k)}":${numJson(h[k])}`).join(',') + '}'
  const opResJson = () => '{' + [...PROPS].sort(byName).map((k) => `"${escJson(k)}":{"operating":${numJson(op[k])},"reserve":${numJson(res[k])}}`).join(',') + '}'
  const blockBal = [
    '// Regenerated by refresh.ps1 - month-end series (workbook "Historical", 1st-of-next-month close),',
    `// current operating/reserve + lender-held escrow ("Current Snapshot", ${snapDate}). Bender/Westport/old Waterchase dropped.`,
    'const GEN_MONTHS = [' + genMonths.map((m) => `{key:"${m.key}",label:"${m.label}",raw:${objJson(m.raw)},rcm:${objJson(m.rcm)}}`).join(',') + '];',
    'GEN_MONTHS.forEach(m => { MONTHS.push(m.key); LABELS.push(m.label); PROPS.forEach(p => RAW[p].push(m.raw[p] !== undefined ? m.raw[p] : RAW[p][RAW[p].length-1])); RCM_NAMES.forEach(n => RCM_ACCOUNTS[n].push(m.rcm[n] !== undefined ? m.rcm[n] : 0)); });',
    'const GEN_OPRES = ' + opResJson() + ';',
    'PROPS.forEach(p => { if(GEN_OPRES[p]) OPRES[p] = GEN_OPRES[p]; });',
    'const GEN_ESCROW = ' + objJson(esc) + ';',
    'PROPS.forEach(p => { ESCROW[p] = GEN_ESCROW[p] !== undefined ? GEN_ESCROW[p] : 0; });',
    `try { const _bn=document.querySelector('#byprop .section-note'); if(_bn) _bn.textContent='Bank operating + reserve + lender-held escrow & reserves - refreshed ${snapDate} - hover a bar for the breakdown'; } catch(e){}`,
  ].join('\n')

  const blockRefunds = 'const TRACKER_REFUNDS = [' + refunds.map((rf) =>
    `{"property":"${escJson(rf.property)}","checktype":"${escJson(rf.checktype)}","amount":${numJson(rf.amount)},"account":"${escJson(rf.account)}","date":"${escJson(rf.date)}","notes":"${escJson(rf.notes)}"}`).join(',') + '];'

  const blockDaily = 'const DAILY = {"dates":[' + dailyDates.map((d) => `"${d}"`).join(',') + '],"bal":{' +
    PROPS.map((p) => `"${escJson(p)}":[${dailyBal[p].map(numJson).join(',')}]`).join(',') + '}};'

  // ---------------- inject between markers (plain-string splice) ----------------
  const splice = (s, startTag, endTag, inner, what) => {
    const i = s.indexOf(startTag), close = i < 0 ? -1 : s.indexOf('*/', i), j = close < 0 ? -1 : s.indexOf(endTag, close + 2)
    if (j < 0) { fail(`${what} markers not found`); return s }
    return s.slice(0, close + 2) + '\n' + inner + '\n' + s.slice(j)
  }
  html = readFileSync(HTML_PATH, 'utf8')
  html = splice(html, '/*GEN:LOANS:START', '/*GEN:LOANS:END*/', blockLoans, 'GEN:LOANS')
  html = splice(html, '/*GEN:BAL:START', '/*GEN:BAL:END*/', blockBal, 'GEN:BAL')
  html = splice(html, '/*GEN:REFUNDS:START', '/*GEN:REFUNDS:END*/', blockRefunds, 'GEN:REFUNDS')
  html = splice(html, '/*GEN:DAILY:START', '/*GEN:DAILY:END*/', blockDaily, 'GEN:DAILY')
  html = html.replaceAll('\r\n', '\n') // LF only, so regenerations are byte-stable

  // ---------------- validate ----------------
  if (refunds.length < 20) fail(`only ${refunds.length} refunds parsed (expected many)`)
  if (!refunds.some((r) => r.property === 'Green Meadows' && Math.abs(r.amount - 350000) < 1)) fail('Green Meadows 350k refund missing (tracker canary)')
  if (dailyDates.length < 100) fail(`daily series too short: ${dailyDates.length} days`)
  if (genMonths.length) {
    const total = Object.values(genMonths.at(-1).raw).reduce((s, v) => s + v, 0)
    if (total < 4000000 || total > 15000000) fail(`latest-month portfolio total out of sane range: ${Math.round(total)}`)
  }
  log(`validation: ${errors.length ? `FAIL (${errors.length})` : 'PASS'}`)
} catch (e) { log(`ERROR: ${e.message}`); process.exit(1) }

// ---------------- write output ----------------
if (errors.length) { log('NOT writing/deploying due to validation failures.'); process.exit(3) }
if (!DEPLOY) {
  const cand = opt('--out') ?? join(REPO, 'index.candidate.html')
  writeFileSync(cand, html)
  log(`DRY-RUN: wrote ${cand} (${Math.round(Buffer.byteLength(html) / 1024)} KB). No git action.`)
  process.exit(0)
}
writeFileSync(HTML_PATH, html)
const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
let pushed = false
try {
  if (git('status', '--porcelain', '--', 'index.html').trim()) {
    git('add', 'index.html')
    git('commit', '-m', 'Auto-refresh: bank balances through latest close', '-m', `Regenerated from ~Bank Balances~.xlsm (snapshot ${snapDate}).`)
    log('committed refreshed index.html.')
  } else log('no content change since last commit.')
  git('push', 'origin', 'main')
  log('push OK -> Vercel will deploy.'); pushed = true
} catch (e) { log(`PUSH FAILED: ${(e.stderr || e.message).toString().trim()}`) }
if (SCHEDULED) { if (pushed) { writeFileSync(MARKER, localDay()); log('[retry] ok -> SUCCESS') } else log('[retry] push failed -> will try again on the next run') }
process.exit(pushed ? 0 : 1)
