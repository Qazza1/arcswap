export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    return res.status(200).end();
  }

  const path = Array.isArray(req.query.path) ? req.query.path.join("/") : (req.query.path || "");
  const targetUrl = `https://api.circle.com/${path}`;

  const skipHeaders = new Set([
    "host", "x-user-agent", "x-forwarded-for", "x-forwarded-proto",
    "x-forwarded-host", "x-vercel-id", "x-vercel-deployment-url",
    "x-real-ip", "x-vercel-forwarded-for", "content-length"
  ]);

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!skipHeaders.has(key.toLowerCase())) headers[key] = value;
  }

  let body = undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (req.body && Object.keys(req.body).length > 0) {
      body = JSON.stringify(req.body);
      headers["content-type"] = "application/json";
    }
  }

  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
    });

    const text = await response.text();
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    const ct = response.headers.get("content-type");
    if (ct) res.setHeader("Content-Type", ct);
    res.status(response.status).send(text);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export const config = {
  api: {
    bodyParser: true,
  },
};
