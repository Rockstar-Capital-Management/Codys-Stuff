// Downloads the two bank-balance workbooks from SharePoint with Microsoft Graph, for runs that have no synced
// OneDrive folder (GitHub Actions). Read-only: it only requests a token, lists one folder and downloads files.
//
// Needs these environment variables (stored as GitHub secrets, never in the repo):
//   MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET   an Entra app registration with read access to the site
//   SP_SITE     the site address in Graph form, e.g.  contoso.sharepoint.com:/sites/RockstarCapital
//   SP_FOLDER   (optional) folder inside the document library; defaults to the Bank Balances folder
// Usage: node fetch-workbooks.js <output folder>
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const need = (k) => { const v = (process.env[k] ?? '').trim(); if (!v) { console.error(`Missing ${k}`); process.exit(2) } return v }
const TENANT = need('MS_TENANT_ID'), CLIENT = need('MS_CLIENT_ID'), SECRET = need('MS_CLIENT_SECRET'), SITE = need('SP_SITE')
const FOLDER = (process.env.SP_FOLDER ?? '').trim() || 'RCM SharePoint/Corporate Asset Management/Bank Balances'
const FILES = ['~Bank Balances~.xlsm', 'Refunds & Reserves Tracker.xlsx']
const outDir = process.argv[2]
if (!outDir) { console.error('Pass an output folder'); process.exit(2) }
const GRAPH = 'https://graph.microsoft.com/v1.0'

// Microsoft's own error code and message (never a secret) so a failed run says what to fix.
async function why(res) {
  try { const j = await res.json(); const e = j.error ?? j; return `${e.code ?? e.error ?? ''} ${e.message ?? e.error_description ?? ''}`.trim().split('\n')[0].slice(0, 300) } catch { return '' }
}
function stop(msg) { console.error(msg); process.exit(2) }

const tokenRes = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ client_id: CLIENT, client_secret: SECRET, grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default' }),
})
if (!tokenRes.ok) stop(`Sign-in to Microsoft failed (${tokenRes.status}): ${await why(tokenRes)}`)
const { access_token } = await tokenRes.json()
const auth = { Authorization: `Bearer ${access_token}` }
const enc = (p) => p.split('/').map(encodeURIComponent).join('/')

// 1. Resolve the site to its id (works with either the address form or an id).
const siteRes = await fetch(`${GRAPH}/sites/${SITE}?$select=id,displayName`, { headers: auth })
if (!siteRes.ok) stop(`Could not open the SharePoint site "${SITE}" (${siteRes.status}): ${await why(siteRes)}`)
const site = await siteRes.json()
console.log(`Site: ${site.displayName}`)

// 2. List the folder, then download each workbook by its item id (file names with ~ and & are awkward in addresses).
const listRes = await fetch(`${GRAPH}/sites/${site.id}/drive/root:/${enc(FOLDER)}:/children?$select=id,name,size,lastModifiedDateTime&$top=200`, { headers: auth })
if (!listRes.ok) stop(`Could not open the folder "${FOLDER}" (${listRes.status}): ${await why(listRes)}`)
const items = (await listRes.json()).value ?? []

mkdirSync(outDir, { recursive: true })
for (const name of FILES) {
  const item = items.find((i) => i.name === name)
  if (!item) stop(`"${name}" is not in "${FOLDER}". Files there: ${items.map((i) => i.name).slice(0, 30).join(', ')}`)
  const file = await fetch(`${GRAPH}/sites/${site.id}/drive/items/${item.id}/content`, { headers: auth })
  if (!file.ok) stop(`Could not download "${name}" (${file.status}): ${await why(file)}`)
  writeFileSync(join(outDir, name), Buffer.from(await file.arrayBuffer()))
  console.log(`Downloaded ${name} (${Math.round(item.size / 1024)} KB, last saved ${item.lastModifiedDateTime})`)
}
