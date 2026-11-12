// Refreshes the Portfolio Dashboard page (portfolio/index.html) from Supabase. READ-ONLY against Supabase (GET only).
//
// What it updates (stage 1 - everything the daily Entrata rent roll and activity feed can drive):
//   D   rent history: appends each newly finished month (property, bedroom and floor-plan averages)
//   RR  resident drill-down: rebuilt from the latest daily rent roll
//   PR  pricing rows: status, market rent, leased rent, lease dates and resident refreshed (base rent and premiums are kept);
//       resident balance and deposit from the daily receivables snapshot; days vacant from Entrata's unit availability
//   TO  turnover: appends each newly finished month from Entrata's Property Pulse
// Everything else on the page (Expenses, Concessions, Collections, Housing, ...) is left exactly as it is.
//
//   node refresh.js --page <index.html> --check     compare what Supabase gives with what the page already shows; writes nothing
//   node refresh.js --page <index.html>             dry run: writes <page>.candidate.html
//   node refresh.js --page <index.html> --write     updates the page in place (the workflow then commits it)
import { readFileSync, writeFileSync } from 'node:fs'

const URL = (process.env.SUPABASE_URL || 'https://smwxizlaxskjedhtjsqc.supabase.co') + '/rest/v1/'
const KEY = (process.env.SUPABASE_KEY || '').trim()
if (!KEY) { console.error('SUPABASE_KEY is not set'); process.exit(2) }
const HEADERS = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const argv = process.argv.slice(2)
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
const PAGE = opt('--page'); if (!PAGE) { console.error('Pass --page <path to portfolio/index.html>'); process.exit(2) }
const CHECK = argv.includes('--check'), WRITE = argv.includes('--write')
const OCCUPIED = new Set(['Occupied No Notice', 'Notice Rented', 'Notice Unrented'])
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

const errors = []
const fail = (m) => { errors.push(m); console.log('CHECK FAILED: ' + m) }

async function getAll(path) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const res = await fetch(URL + path, { headers: { ...HEADERS, Range: `${from}-${from + 999}` } })
    if (!res.ok) throw new Error(`${path.split('?')[0]}: ${res.status} ${(await res.text()).slice(0, 200)}`)
    const page = await res.json(); out.push(...page)
    if (page.length < 1000) return out
  }
}

// ---------- page data blocks: each is one line "const NAME=<json>;..." ----------
let html = readFileSync(PAGE, 'utf8')
function jsonEnd(s, start) { // index just past the JSON value that starts at `start`
  let depth = 0, inStr = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue }
    if (c === '"') inStr = true
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return i + 1 }
  }
  throw new Error('unbalanced data block')
}
function block(name) {
  const m = new RegExp(`(^|\\n)\\s*const ${name}=(?=[\\[{])`).exec(html)
  if (!m) throw new Error(`data block ${name} not found in the page`)
  const start = m.index + m[0].length, end = jsonEnd(html, start)
  return { start, end, value: JSON.parse(html.slice(start, end)) }
}
function setBlock(name, value) { const b = block(name); html = html.slice(0, b.start) + JSON.stringify(value) + html.slice(b.end) }

const D = block('D').value, RR = block('RR').value, PR = block('PR').value, TO = block('TO').value
const NAMES = D.map((d) => d.p)

// ---------- Supabase ----------
const props = await getAll('properties?select=id,name')
const idOf = Object.fromEntries(props.map((p) => [p.name, p.id])), nameOf = Object.fromEntries(props.map((p) => [p.id, p.name]))
for (const n of NAMES) if (!idOf[n]) fail(`property "${n}" is on the dashboard but not in Supabase`)

const RR_COLS = 'property_id,unit,unit_type,floorplan,bedrooms,sqft,unit_status,move_in,lease_start,lease_end,market_rent,scheduled_rent'
async function rentRoll(date) {
  const rows = await getAll(`rent_roll_snapshots?select=${RR_COLS}&as_of=eq.${date}&order=id`)
  const by = Object.fromEntries(NAMES.map((n) => [n, []]))
  for (const r of rows) { const n = nameOf[r.property_id]; if (by[n]) by[n].push(r) }
  return by
}
const natural = (a, b) => a.localeCompare(b, 'en-US', { numeric: true })
const avg = (rows) => (rows.length ? Math.round((rows.reduce((s, r) => s + Number(r.scheduled_rent || 0), 0) / rows.length) * 100) / 100 : null)

// The dashboard's own floor-plan code for each unit (it strips tier suffixes and keeps a few legacy codes).
const planOf = {}
for (const n of NAMES) { planOf[n] = {}; for (const r of RR.p[n] || []) planOf[n][r[1]] = r[0] }
const plan = (n, r) => planOf[n][r.unit] ?? r.floorplan
const bedLabel = (n) => (n == null ? 'Other' : n === 0 ? 'Studio' : `${n} Bed`)

// ---------- D: month-end rent history ----------
const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}` }
const nextMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}` }
const today = new Date().toISOString().slice(0, 10)
function monthStats(d, rows) {
  const occ = rows.filter((r) => OCCUPIED.has(r.unit_status))
  const fp = {}, bed = {}
  for (const f of d.f) fp[f.c] = { occ: [], all: 0 }
  for (const r of rows) {
    const c = plan(d.p, r), f = d.f.find((x) => x.c === c)
    const b = f ? f.b : bedLabel(r.bedrooms)
    ;(fp[c] ??= { occ: [], all: 0, isNew: true }).all++
    ;(bed[b] ??= { occ: [], all: 0 }).all++
    if (OCCUPIED.has(r.unit_status)) { fp[c].occ.push(r); bed[b].occ.push(r) }
  }
  return { rent: avg(occ), occ: occ.length, units: rows.length, fp, bed }
}

const dLast = D[0].lm
if (CHECK) {
  const rr = await rentRoll(lastDay(dLast))
  let same = 0, fpSame = 0, fpAll = 0; const diffs = []
  for (const d of D) {
    const st = monthStats(d, rr[d.p]), s = d.s.find((x) => x[0] === dLast)
    if (s && s[1] === st.rent && s[2] === st.occ) same++; else diffs.push(`${d.p}: page ${s?.[1]}/${s?.[2]}, Supabase ${st.rent}/${st.occ}`)
    for (const f of d.f) { const fs = f.s.find((x) => x[0] === dLast); if (!fs) continue; fpAll++; const g = st.fp[f.c]; if (fs[2] === g.occ.length && fs[3] === g.all && (avg(g.occ) ?? fs[1]) === fs[1]) fpSame++ }
  }
  console.log(`Rent history ${dLast}: ${same} of ${D.length} properties identical; floor plans ${fpSame} of ${fpAll} identical`)
  diffs.forEach((x) => console.log('   ' + x))
}

const added = []
for (let m = nextMonth(dLast); lastDay(m) < today; m = nextMonth(m)) {
  const rr = await rentRoll(lastDay(m))
  const short = D.filter((d) => rr[d.p].length < d.t * 0.95)
  if (short.length) { console.log(`Month ${m}: rent roll for ${lastDay(m)} is missing or incomplete for ${short.map((d) => d.p).join(', ')}; stopping there.`); break }
  for (const d of D) {
    const st = monthStats(d, rr[d.p])
    d.s.push([m, st.rent, st.occ])
    for (const [b, g] of Object.entries(st.bed)) (d.b[b] ??= []).push([m, avg(g.occ) ?? d.b[b]?.at(-1)?.[1] ?? 0, g.occ.length, g.all])
    for (const f of d.f) { const g = st.fp[f.c]; if (g.all) f.s.push([m, avg(g.occ) ?? f.s.at(-1)?.[1] ?? 0, g.occ.length, g.all]) }
    const unknown = Object.entries(st.fp).filter(([, g]) => g.isNew).map(([c]) => c)
    if (unknown.length) console.log(`   note - ${d.p}: floor plan code(s) not on the dashboard yet: ${unknown.join(', ')} (units counted in property and bedroom totals only)`)
    // peak and runner-up month
    if (st.rent > d.pv) { d.rm = d.pm; d.rv = d.pv; d.pm = m; d.pv = st.rent; d.po = st.occ } else if (st.rent > d.rv) { d.rm = m; d.rv = st.rent }
    d.lm = m; d.lv = st.rent; d.lo = st.occ
    const prev = d.s.at(-2)
    if (prev && Math.abs(st.rent / prev[1] - 1) > 0.1) fail(`${d.p} ${m}: leased rent moved more than 10% in a month (${prev[1]} -> ${st.rent})`)
    if (prev && Math.abs(st.occ - prev[2]) > d.t * 0.1) fail(`${d.p} ${m}: occupied units moved more than 10% of the property in a month (${prev[2]} -> ${st.occ})`)
  }
  added.push(m)
}

// ---------- TO: turnover from Property Pulse (monthly rows) ----------
const toAdded = []
{
  const pulse = await getAll(`property_pulse_periods?select=property_id,period_start,total_rentable_units,move_ins,move_outs,transfers_completed,renewal_lease_approvals,skips,evictions_completed,notices&period_type=eq.monthly&period_start=gte.${TO.m.at(-1)}-01&order=period_start`)
  const by = {}; for (const x of pulse) (by[x.period_start.slice(0, 7)] ??= {})[nameOf[x.property_id]] = x
  const row = (x, occ) => [x.total_rentable_units, x.move_ins, x.move_outs, x.transfers_completed, x.renewal_lease_approvals, x.skips, x.evictions_completed, x.notices, occ]
  if (CHECK) {
    const m = TO.m.at(-1), i = TO.m.length - 1; let same = 0, n = 0; const diffs = []
    for (const p of Object.keys(TO.p)) { const cur = TO.p[p]?.[i], x = by[m]?.[p]; if (!cur || !x) continue; n++; const mine = row(x, cur[8]); if (JSON.stringify(mine) === JSON.stringify(cur)) same++; else if (diffs.length < 5) diffs.push(`${p}: page ${cur.join(',')} | Supabase ${mine.join(',')}`) }
    console.log(`Turnover ${m} [units, move-ins, move-outs, transfers, renewals, skips, evictions, notices, occupied]: ${same} of ${n} identical`); diffs.forEach((x) => console.log('   ' + x))
  }
  for (let m = nextMonth(TO.m.at(-1)); lastDay(m) < today; m = nextMonth(m)) {
    const occOf = (p) => D.find((d) => d.p === p)?.s.find((x) => x[0] === m)?.[2]
    const names = Object.keys(TO.p)
    if (!by[m] || names.some((p) => TO.p[p] && (!by[m][p] || occOf(p) == null))) { console.log(`Turnover ${m}: activity or month-end occupancy not available yet; stopping there.`); break }
    TO.m.push(m); TO.sys.push('E')
    for (const p of names) if (TO.p[p]) TO.p[p].push(row(by[m][p], occOf(p)))
    toAdded.push(m)
  }
}

// ---------- RR + PR: latest daily rent roll ----------
const latest = (await getAll('rent_roll_snapshots?select=as_of&order=as_of.desc&limit=1'))[0]?.as_of
const asof = CHECK ? RR.asof : latest
const rrNow = await rentRoll(asof)
const tenure = CHECK ? [] : await getAll('current_resident_tenure?select=property_id,building,unit,role,lease_status,first_name,last_name&role=eq.Primary&order=id')
const resident = {}
for (const t of tenure) {
  const n = nameOf[t.property_id]; if (!n) continue
  const name = `${(t.last_name || '').trim()}, ${(t.first_name || '').trim()}`
  for (const k of [t.building ? `${t.building}-${t.unit}` : null, t.unit]) if (k) (resident[n] ??= {})[k] ??= name
}
// Receivables per lease (a lease with no row owes nothing), unit availability and recorded departures.
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5)
const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10)
const receivable = {}, moveOut = {}
let arDate = null
if (!CHECK) {
  arDate = (await getAll(`ar_lease_snapshots?select=as_of_date&as_of_date=lte.${asof}&order=as_of_date.desc&limit=1`))[0]?.as_of_date
  if (!arDate || dayDiff(asof, arDate) > 3) fail(`no receivables snapshot within 3 days of ${asof}`)
  else for (const a of await getAll(`ar_lease_snapshots?select=property_id,bldg_unit,lease_status,balance,deposit_held&as_of_date=eq.${arDate}&order=id`)) {
    if (!/^(Current|Notice)/.test(a.lease_status)) continue
    const r = ((receivable[nameOf[a.property_id]] ??= {})[a.bldg_unit] ??= { balance: 0, deposit: 0 })
    r.balance += Number(a.balance || 0); r.deposit += Number(a.deposit_held || 0)
  }
  // Entrata sets a vacated unit's available date 8 days after move-out; a recorded departure date is used when there is one.
  const units = await getAll('units?select=id,property_id,unit_number,available_date&order=id')
  const byId = Object.fromEntries(units.map((u) => [u.id, u]))
  for (const u of units) if (u.available_date) ((moveOut[nameOf[u.property_id]] ??= {})[u.unit_number] = { date: addDays(u.available_date, -8) })
  for (const d of await getAll('lease_departures?select=unit_id,departed_at&order=departed_at')) {
    const u = byId[d.unit_id]; if (u) ((moveOut[nameOf[u.property_id]] ??= {})[u.unit_number] = { date: d.departed_at.slice(0, 10), exact: true })
  }
}
const unitNo = (unit) => (unit.includes('-') ? unit.slice(unit.indexOf('-') + 1) : unit)
const round2 = (n) => Math.round(n * 100) / 100
const newRx = {}, newAv = { u: {}, asof }, newSq = {}
let balChanged = 0, vacTracked = 0, vacUnknown = 0
let rrSame = 0, rrN = 0, prSame = 0, prN = 0
const newRR = { asof, p: {} }
for (const d of D) {
  const rows = rrNow[d.p]
  if (rows.length < d.t * 0.95) { fail(`${d.p}: only ${rows.length} of ${d.t} units in the ${asof} rent roll`); continue }
  const old = Object.fromEntries((RR.p[d.p] || []).map((r) => [r[1], r]))
  newRR.p[d.p] = rows.sort((a, b) => natural(a.unit, b.unit)).map((r) => {
    const occ = OCCUPIED.has(r.unit_status)
    const name = occ ? (CHECK ? old[r.unit]?.[2] ?? '' : resident[d.p]?.[r.unit] ?? old[r.unit]?.[2] ?? '') : ''
    const row = [plan(d.p, r), r.unit, name, r.unit_status, occ ? r.move_in ?? '' : '', occ ? r.lease_end ?? '' : '', r.market_rent, occ ? r.scheduled_rent : null]
    if (CHECK && old[r.unit]) { rrN++; if (JSON.stringify(row) === JSON.stringify(old[r.unit])) rrSame++ }
    return row
  })
  // Pricing rows: [unit type, unit, status, base, base2, premium, market, leased, move-in, lease end, resident]
  const snap = Object.fromEntries(rows.map((r) => [r.unit, r]))
  for (const pr of PR.p[d.p] || []) {
    const r = snap[pr[1]]; if (!r) continue
    const occ = OCCUPIED.has(r.unit_status)
    const next = [...pr]; next[2] = r.unit_status; if (!CHECK) next[6] = r.market_rent ?? pr[6]; next[7] = occ ? r.scheduled_rent : null; next[8] = occ ? r.move_in ?? '' : ''; next[9] = occ ? r.lease_end ?? '' : ''
    next[10] = occ ? newRR.p[d.p].find((x) => x[1] === r.unit)?.[2] ?? '' : ''
    if (CHECK) { prN++; if (JSON.stringify(next) === JSON.stringify(pr)) prSame++ } else pr.splice(0, pr.length, ...next)
  }
  if (CHECK) continue
  // Resident extras [lease start, expected move-out, balance, deposit, sq ft], days vacant [days, moved out], sq ft
  const oldRx = PR.rx?.[d.p] || {}, oldAv = PR.av?.u?.[d.p] || {}
  newRx[d.p] = {}; newAv.u[d.p] = {}; newSq[d.p] = {}
  for (const r of rows) {
    if (r.sqft) newSq[d.p][r.unit] = r.sqft
    if (OCCUPIED.has(r.unit_status)) {
      const o = oldRx[r.unit], ar = receivable[d.p]?.[r.unit]
      const sameLease = o && o[0] === r.lease_start
      const balance = ar ? round2(ar.balance) : 0, deposit = ar ? round2(ar.deposit) : sameLease ? o[3] ?? 0 : 0
      if (!o || Math.abs((o[2] ?? 0) - balance) > 0.005) balChanged++
      newRx[d.p][r.unit] = [r.lease_start ?? '', sameLease ? o[1] ?? null : null, balance, deposit, r.sqft ?? o?.[4] ?? null]
    } else if (/^Vacant Unrented/.test(r.unit_status)) {
      // keep the move-out date the page already has for a unit that is still vacant; otherwise take Entrata's
      const known = oldAv[r.unit]?.[1], m = moveOut[d.p]?.[unitNo(r.unit)] ?? moveOut[d.p]?.[r.unit]
      const date = known ?? (m && m.date <= asof ? m.date : null)
      if (date) { newAv.u[d.p][r.unit] = [Math.max(0, dayDiff(asof, date)), date]; vacTracked++ } else vacUnknown++
    }
  }
}
if (CHECK) {
  console.log(`Resident drill-down as of ${asof}: ${rrSame} of ${rrN} unit rows identical`)
  console.log(`Pricing rows as of ${PR.asof}: ${prSame} of ${prN} identical after refreshing status, leased rent and dates`)
  process.exit(0)
}

// ---------- write ----------
const total = Object.values(newRR.p).reduce((s, r) => s + r.length, 0)
if (total < 4000) fail(`latest rent roll has only ${total} units`)
if (errors.length) { console.log(`Not writing: ${errors.length} check(s) failed.`); process.exit(3) }
if (vacTracked < (vacTracked + vacUnknown) * 0.8) fail(`a move-out date was found for only ${vacTracked} of ${vacTracked + vacUnknown} vacant units`)
if (errors.length) { console.log(`Not writing: ${errors.length} check(s) failed.`); process.exit(3) }
PR.rx = newRx; PR.av = newAv; PR.sq = newSq; PR.asof = asof
setBlock('D', D); setBlock('TO', TO); setBlock('RR', newRR); setBlock('PR', PR)
{ // the two fixed month labels in the page markup follow the latest month in the rent history
  const [y, m] = D[0].lm.split('-').map(Number), label = `${MONTHS[m - 1]} ${y}`
  html = html.replace(/(<span>Data through<\/span><b>)[^<]*(<\/b>)/, `$1${label}$2`)
  html = html.replace(/(class="grp cur"><span>)[^<]*(<\/span>)/, `$1${label}$2`)
}
const out = WRITE ? PAGE : PAGE.replace(/\.html$/, '.candidate.html')
writeFileSync(out, html)
console.log(`Rent history: ${added.length ? 'added ' + added.join(', ') : 'no new finished month'}; turnover: ${toAdded.length ? 'added ' + toAdded.join(', ') : 'no new month'}`)
console.log(`Residents and pricing refreshed to the ${asof} rent roll (${total} units).`)
console.log(`Balances from the ${arDate} receivables snapshot (${balChanged} changed); days vacant set for ${vacTracked} vacant units, ${vacUnknown} without a move-out date.`)
console.log(`${WRITE ? 'Updated' : 'Dry run: wrote'} ${out} (${Math.round(Buffer.byteLength(html) / 1024)} KB)`)
