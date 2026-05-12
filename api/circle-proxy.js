// Vercel serverless function — proxies requests to Circle API.
// Strips the x-user-agent header that Circle's CORS policy blocks.

export default async function handler(req, res) {
  // Build the target URL — strip /api/circle-proxy prefix
  const targetPath = req.url.replace(/^\/api\/circle-proxy/, "");
  const targetUrl = `https://api.circle.com${targetPath}`;

  // Copy headers, but remove the ones that cause CORS issues
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (
      lower === "host" ||
      lower === "x-user-agent" ||
      lower === "x-forwarded-for" ||
      lower === "x-forwarded-proto" ||
      lower === "x-forwarded-host" ||
      lower === "x-vercel-id" ||
      lower === "x-vercel-deployment-url"
    ) continue;
    headers[key] = value;
  }

  // Get request body
  const body = req.method !== "GET" && req.method !== "HEAD"
    ? JSON.stringify(req.body)
    : undefined;

  if (body) {
    headers["content-type"] = "application/json";
  }

  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
    });

    const data = await response.text();

    // Forward response headers
    res.setHeader("Content-Type", response.headers.get("content-type") || "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");

    res.status(response.status).send(data);
  } catch (err) {
    res.status(500).json({ error: "Proxy error", message: err.message });
  }
}

export const config = {
  api: {
    bodyParser: true,
  },
};
