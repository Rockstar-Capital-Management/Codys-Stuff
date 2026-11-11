// Downloads the two bank-balance workbooks from SharePoint with Microsoft Graph, for runs that have no synced
// OneDrive folder (GitHub Actions). Read-only: it only requests a token and downloads files.
//
// Needs these environment variables (stored as GitHub secrets, never in the repo):
//   MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET   an Entra app registration with read access to the site
//   SP_SITE     the site address in Graph form, e.g.  contoso.sharepoint.com:/sites/RockstarCapital
//   SP_FOLDER   (optional) folder inside the document library; defaults to the Bank Balances folder
// Usage: node fetch-workbooks.js <output folder>
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`Missing ${k}`); process.exit(2) } return v }
const TENANT = need('MS_TENANT_ID'), CLIENT = need('MS_CLIENT_ID'), SECRET = need('MS_CLIENT_SECRET'), SITE = need('SP_SITE')
const FOLDER = process.env.SP_FOLDER || 'RCM SharePoint/Corporate Asset Management/Bank Balances'
const FILES = ['~Bank Balances~.xlsm', 'Refunds & Reserves Tracker.xlsx']
const outDir = process.argv[2]
if (!outDir) { console.error('Pass an output folder'); process.exit(2) }

const tokenRes = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ client_id: CLIENT, client_secret: SECRET, grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default' }),
})
if (!tokenRes.ok) { console.error(`Sign-in to Microsoft failed (${tokenRes.status}). Check the tenant, client id and secret.`); process.exit(2) }
const { access_token } = await tokenRes.json()
const auth = { Authorization: `Bearer ${access_token}` }
const enc = (p) => p.split('/').map(encodeURIComponent).join('/')

mkdirSync(outDir, { recursive: true })
for (const name of FILES) {
  const item = `https://graph.microsoft.com/v1.0/sites/${SITE}:/drive/root:/${enc(`${FOLDER}/${name}`)}`
  const meta = await fetch(item, { headers: auth })
  if (!meta.ok) { console.error(`Could not find "${name}" (${meta.status}). Check SP_SITE, SP_FOLDER and the app's access to the site.`); process.exit(2) }
  const { lastModifiedDateTime, size } = await meta.json()
  const file = await fetch(`${item}:/content`, { headers: auth })
  if (!file.ok) { console.error(`Could not download "${name}" (${file.status}).`); process.exit(2) }
  writeFileSync(join(outDir, name), Buffer.from(await file.arrayBuffer()))
  console.log(`Downloaded ${name} (${Math.round(size / 1024)} KB, last saved ${lastModifiedDateTime})`)
}
