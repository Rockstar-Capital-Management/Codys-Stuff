// GoatCounter hits for the QR dashboard (index.html shapes them per property).
// The API key lives only in the Vercel env var GOATCOUNTER_API_KEY, never in the page.
const API = "https://rockstarcapital.goatcounter.com/api/v0/stats/hits";

const ymd = (d) => d.toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async (req, res) => {
  const key = process.env.GOATCOUNTER_API_KEY;
  if (!key) {
    res.status(500).json({ error: "GOATCOUNTER_API_KEY is not set" });
    return;
  }

  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * 86400000);
  const url = `${API}?start=${ymd(start)}&end=${ymd(end)}&limit=100&daily=true`;

  // GoatCounter now and then answers 404 for a valid request and works moments later
  let last = 502;
  for (const wait of [0, 600, 1800]) {
    if (wait) await sleep(wait);
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
      if (r.ok) {
        const body = await r.json();
        res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
        res.status(200).json({ start: ymd(start), end: ymd(end), hits: body.hits || [] });
        return;
      }
      last = r.status;
    } catch (e) {
      last = 502;
    }
  }
  res.status(502).json({ error: `GoatCounter returned ${last}` });
};
