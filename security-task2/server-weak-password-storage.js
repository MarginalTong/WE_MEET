/**
 * Task 2 demo ONLY — intentionally insecure.
 * Passwords stored as unsalted MD5 in memory; "stolen backup" endpoint exposes them.
 * Do not use real passwords. Run on localhost only.
 */
const http = require("http");
const crypto = require("crypto");

const PORT = Number(process.env.WEAK_STORAGE_PORT || 9081);

/** @type {Map<string, string>} username -> md5(password) unsalted */
const weakStore = new Map();

function md5Weak(s) {
  return crypto.createHash("md5").update(String(s), "utf8").digest("hex");
}

function json(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      warning: "MD5 without salt + leak endpoint (insecure by design).",
    });
  }

  if (req.method === "POST" && url.pathname === "/register") {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return json(res, 400, { error: "invalid_json" });
    }
    const { username, password } = body;
    if (!username || !password) return json(res, 400, { error: "missing_fields" });
    weakStore.set(String(username), md5Weak(password));
    console.log("[weak-storage] registered (md5, no salt):", username, weakStore.get(String(username)));
    return json(res, 201, { ok: true, stored: "md5_unsalted" });
  }

  if (req.method === "POST" && url.pathname === "/login") {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return json(res, 400, { error: "invalid_json" });
    }
    const { username, password } = body;
    const want = weakStore.get(String(username));
    if (!want || want !== md5Weak(password)) {
      return json(res, 401, { error: "invalid_credentials" });
    }
    return json(res, 200, { token: "fake-session-token" });
  }

  // Simulates an attacker accessing a debug endpoint, backup file, or stolen DB export.
  if (req.method === "GET" && url.pathname === "/backup-export-for-demo") {
    const rows = [...weakStore.entries()].map(([u, h]) => ({ username: u, password_md5_unsalted: h }));
    console.log("[weak-storage] LEAK:", rows);
    return json(res, 200, { leaked_user_table: rows });
  }

  json(res, 404, { error: "not_found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Task2 weak STORAGE demo: http://127.0.0.1:${PORT}`);
  console.log("  POST /register  body: {\"username\":\"demo\",\"password\":\"DemoPass!2026\"}");
  console.log("  POST /login      (same body)");
  console.log("  GET  /backup-export-for-demo   (shows unsalted MD5 — attacker can offline crack / rainbow)");
});
