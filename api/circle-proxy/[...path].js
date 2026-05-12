// Vercel catch-all serverless function
// Handles: /api/circle-proxy/v1/stablecoinKits/swap etc.

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    return res.status(200).end();
  }

  const path = req.query.path ? req.query.path.join("/") : "";
  const targetUrl = `https://api.circle.com/${path}`;

  console.log("Proxying to:", targetUrl);

  const skipHeaders = new Set([
    "host", "x-user-agent", "x-forwarded-for", "x-forwarded-proto",
    "x-forwarded-host", "x-vercel-id", "x-vercel-deployment-url",
    "x-real-ip", "x-vercel-forwarded-for"
  ]);

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!skipHeaders.has(key.toLowerCase())) headers[key] = value;
  }

  let body;
  if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
    body = JSON.stringify(req.body);
    headers["content-type"] = "application/json";
  }

  try {
    const response = await fetch(targetUrl, { method: req.method, headers, body });
    const text = await response.text();
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", response.headers.get("content-type") || "application/json");
    res.status(response.status).send(text);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export const config = { api: { bodyParser: true } };
