// Vercel serverless function — proxies all requests to Circle API.
// Strips x-user-agent header that Circle's CORS policy blocks.

export default async function handler(req, res) {
  // Handle preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    return res.status(200).end();
  }

  // req.url will be something like /api/circle-proxy/v1/stablecoinKits/swap
  // We need to extract everything after /api/circle-proxy
  const url = new URL(req.url, "http://localhost");
  const targetPath = url.pathname.replace(/^\/api\/circle-proxy/, "") + (url.search || "");
  const targetUrl = `https://api.circle.com${targetPath}`;

  console.log("Proxying to:", targetUrl);

  // Copy headers, strip problematic ones
  const headers = {};
  const skipHeaders = new Set([
    "host", "x-user-agent", "x-forwarded-for", "x-forwarded-proto",
    "x-forwarded-host", "x-vercel-id", "x-vercel-deployment-url",
    "x-real-ip", "x-vercel-forwarded-for"
  ]);

  for (const [key, value] of Object.entries(req.headers)) {
    if (!skipHeaders.has(key.toLowerCase())) {
      headers[key] = value;
    }
  }

  // Build body
  let body;
  if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
    body = JSON.stringify(req.body);
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(body).toString();
  }

  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
    });

    const text = await response.text();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", response.headers.get("content-type") || "application/json");
    res.status(response.status).send(text);

  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).json({ error: "Proxy error", message: err.message });
  }
}

export const config = {
  api: {
    bodyParser: true,
  },
};
