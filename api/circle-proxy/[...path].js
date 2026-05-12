// Raw proxy — forwards request to Circle API server-side (no CORS issues).
// We keep x-user-agent because Circle's API needs it to route requests.
// CORS only blocks x-user-agent in the browser — server-side it's fine.

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    return res.status(200).end();
  }

  const path = Array.isArray(req.query.path)
    ? req.query.path.join("/")
    : req.query.path || "";

  const targetUrl = `https://api.circle.com/${path}`;

  // Only strip Vercel-specific infrastructure headers — keep everything else
  // including x-user-agent which Circle's API needs to route correctly
  const skipHeaders = new Set([
    "host",
    "x-forwarded-for",
    "x-forwarded-proto",
    "x-forwarded-host",
    "x-vercel-id",
    "x-vercel-deployment-url",
    "x-real-ip",
    "x-vercel-forwarded-for",
  ]);

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!skipHeaders.has(key.toLowerCase())) headers[key] = value;
  }

  // Override host to point to Circle
  headers["host"] = "api.circle.com";

  // Read raw body — no parsing, forward exactly as received
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const rawBody = Buffer.concat(chunks);

  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: rawBody.length > 0 ? rawBody : undefined,
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
    bodyParser: false,
  },
};
