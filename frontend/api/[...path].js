export default async function handler(req, res) {
  const backend = "http://34.123.224.26:3000";

  // Build the backend URL
  const path = (req.query.path || []).join("/");
  const qsIndex = req.url.indexOf("?");
  const qs = qsIndex >= 0 ? req.url.slice(qsIndex) : "";
  const url = `${backend}/${path}${qs}`;

  // Copy body for non-GET
  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  }

  try {
    const r = await fetch(url, {
      method: req.method,
      headers: {
        // forward content-type
        "content-type": req.headers["content-type"] || "application/json",
      },
      body,
    });

    const contentType = r.headers.get("content-type") || "application/json";
    res.setHeader("content-type", contentType);

    // Return response as text (works for json too)
    const data = await r.text();
    res.status(r.status).send(data);
  } catch (e) {
    res.status(500).json({ error: e?.message || "Proxy failed" });
  }
}
