const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");

// Railway sets PORT and terminates TLS at its edge — run plain HTTP there.
// Locally the cert files exist, so HTTPS is used instead.
const CERT_DIR = path.join(__dirname, "certs");
const ON_RAILWAY = Boolean(process.env.RAILWAY_ENVIRONMENT);
const USE_HTTP = ON_RAILWAY || !fs.existsSync(path.join(CERT_DIR, "server.key"));
const PORT = Number(process.env.PORT || process.env.SECURE_CHAT_PORT || 8443);
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for Task 1 password auth");
}


const HASH_CONFIG = {
  algorithm: "pbkdf2-sha256",
  iterations: 210000,
  keyLength: 32,
  digest: "sha256",
};

const tokenStore = new Map();

function corsHeaders(req) {
  return {
    "Access-Control-Allow-Origin": req.headers.origin || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    Vary: "Origin",
  };
}

function json(req, res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...corsHeaders(req),
  });
  res.end(JSON.stringify(payload));
}

async function supabaseRequest(method, restPath, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${restPath}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = data?.message || data?.error_description || data?.error || `Supabase REST error ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// --- Supabase session-bridge helpers ---

function task1SupabaseEmail(username) {
  return `task1.${Buffer.from(username).toString("base64url").toLowerCase()}@we-meet.local`;
}

async function supabaseAdminAuth(method, authPath, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${authPath}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    throw new Error(data?.msg || data?.message || data?.error_description || data?.error || `Auth API error ${res.status}`);
  }
  return data;
}

async function findSupabaseUserIdByEmail(email) {
  const data = await supabaseRequest("POST", "rpc/get_auth_user_id_by_email", { p_email: email });
  return typeof data === "string" && data.length > 0 ? data : null;
}

async function ensureSupabaseAuthUser(username) {
  const email = task1SupabaseEmail(username);
  const newPassword = crypto.randomBytes(24).toString("base64url");
  let userId;
  try {
    const created = await supabaseAdminAuth("POST", "admin/users", {
      email,
      password: newPassword,
      email_confirm: true,
      user_metadata: { task1_username: username },
    });
    userId = created.id;
  } catch (err) {
    if (!/already.*(registered|exists)/i.test(err.message)) throw err;
    const existingId = await findSupabaseUserIdByEmail(email);
    if (!existingId) throw new Error("Supabase user not found after conflict");
    await supabaseAdminAuth("PUT", `admin/users/${existingId}`, { password: newPassword });
    userId = existingId;
  }
  await supabaseRequest("PATCH", `task1_users?username=eq.${encodeURIComponent(username)}`, {
    supabase_user_id: userId,
    supabase_password_b64: newPassword,
  });
  return newPassword;
}

async function getSupabaseSession(username, supabasePassword) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: task1SupabaseEmail(username), password: supabasePassword }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error_description || data?.error || `Session error ${res.status}`);
  }
  return { access_token: data.access_token, refresh_token: data.refresh_token };
}

// --- End session-bridge helpers ---

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function hashPassword(password, saltB64) {
  return crypto
    .pbkdf2Sync(password, Buffer.from(saltB64, "base64"), HASH_CONFIG.iterations, HASH_CONFIG.keyLength, HASH_CONFIG.digest)
    .toString("base64");
}

function authenticate(req) {
  const authHeader = String(req.headers.authorization || "");
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) return null;
  const row = tokenStore.get(token);
  if (!row) return null;
  if (Date.now() > row.expiresAt) {
    tokenStore.delete(token);
    return null;
  }
  return row.username;
}

function createToken(username) {
  const token = crypto.randomBytes(32).toString("base64url");
  tokenStore.set(token, {
    username,
    expiresAt: Date.now() + 2 * 60 * 60 * 1000,
  });
  return token;
}

function routeNotFound(req, res) {
  json(req, res, 404, { error: "Not found" });
}

async function handleRegister(req, res) {
  const body = await parseJsonBody(req);
  const username = normalizeUsername(body.username);
  const password = String(body.password || "");
  const e2eePublicKey = String(body.e2eePublicKey || "").trim();
  const signingPublicKey = String(body.signingPublicKey || "").trim();

  if (!username || password.length < 10) {
    json(req, res, 400, { error: "username and a password of at least 10 characters are required" });
    return;
  }

  const existing = await supabaseRequest("GET", `task1_users?username=eq.${encodeURIComponent(username)}&select=username`);
  if (Array.isArray(existing) && existing.length > 0) {
    json(req, res, 409, { error: "Username already exists" });
    return;
  }

  const saltB64 = crypto.randomBytes(16).toString("base64");
  const passwordHash = hashPassword(password, saltB64);
  await supabaseRequest("POST", "task1_users", {
    username,
    password_algorithm: HASH_CONFIG.algorithm,
    password_iterations: HASH_CONFIG.iterations,
    password_salt_b64: saltB64,
    password_hash_b64: passwordHash,
    e2ee_public_key: e2eePublicKey || "",
    signing_public_key: signingPublicKey || "",
  });

  try {
    await ensureSupabaseAuthUser(username);
  } catch (err) {
    console.warn("Supabase paired-user setup failed (timetables will be unavailable):", err.message);
  }

  json(req, res, 201, { ok: true, username });
}

async function handleLogin(req, res) {
  const body = await parseJsonBody(req);
  const username = normalizeUsername(body.username);
  const password = String(body.password || "");
  const rows = await supabaseRequest(
    "GET",
    `task1_users?username=eq.${encodeURIComponent(
      username
    )}&select=username,password_salt_b64,password_hash_b64,password_iterations,supabase_password_b64`
  );
  const user = Array.isArray(rows) ? rows[0] : null;
  if (!user || !user.password_salt_b64 || !user.password_hash_b64) {
    json(req, res, 401, { error: "Invalid credentials" });
    return;
  }

   const computedHash = hashPassword(password, user.password_salt_b64);
  const valid =
    computedHash.length === String(user.password_hash_b64).length &&
    crypto.timingSafeEqual(Buffer.from(computedHash), Buffer.from(String(user.password_hash_b64)));
  if (!valid) {
    json(req, res, 401, { error: "Invalid credentials" });
    return;
  }

  const token = createToken(username);

  // Bridge: obtain a real Supabase session so the browser can call timetable RPCs.
  // If supabase_password_b64 is missing (registered before phase2), create the paired user now.
  let supabasePasswordB64 = user.supabase_password_b64 || null;
  let _linkError = null;
  let _sessionError = null;

  if (!supabasePasswordB64) {
    try {
      supabasePasswordB64 = await ensureSupabaseAuthUser(username);
    } catch (err) {
      _linkError = err.message;
      console.error("Supabase auto-link failed:", err.message);
    }
  }

  let supabaseSession = null;
  if (supabasePasswordB64) {
    try {
      supabaseSession = await getSupabaseSession(username, supabasePasswordB64);
    } catch (err) {
      _sessionError = err.message;
      console.error("Supabase session bridge failed:", err.message);
    }
  }

  json(req, res, 200, { token, username, supabaseSession, _debug: { _linkError, _sessionError } });
}

async function handleGetPublicKeys(req, res, urlObj) {
  const username = normalizeUsername(urlObj.searchParams.get("username"));
  if (!username) {
    json(req, res, 400, { error: "username is required" });
    return;
  }
  const rows = await supabaseRequest(
    "GET",
    `task1_users?username=eq.${encodeURIComponent(username)}&select=username,e2ee_public_key,signing_public_key`
  );
  const user = Array.isArray(rows) ? rows[0] : null;
  if (!user) {
    json(req, res, 404, { error: "User not found" });
    return;
  }
  json(req, res, 200, {
    username: String(user.username),
    keys: {
      e2eePublicKey: String(user.e2ee_public_key || ""),
      signingPublicKey: String(user.signing_public_key || ""),
    },
  });
}

async function handleSendMessage(req, res, sender) {
  const body = await parseJsonBody(req);
  const to = normalizeUsername(body.to);
  const envelope = body.envelope;
  if (!to || !envelope || typeof envelope !== "object") {
    json(req, res, 400, { error: "to and envelope are required" });
    return;
  }

  const recipientRows = await supabaseRequest(
    "GET",
    `task1_users?username=eq.${encodeURIComponent(to)}&select=username`
  );
  const recipient = Array.isArray(recipientRows) ? recipientRows[0] : null;
  if (!recipient) {
    json(req, res, 404, { error: "Recipient not found" });
    return;
  }

  const inserted = await supabaseRequest("POST", "task1_messages", {
    from: sender,
    to,
    envelope_json: envelope,
  });
  const row = Array.isArray(inserted) ? inserted[0] : null;
  json(req, res, 201, { ok: true, id: row?.id || null });
}

async function handleReceiveMessages(req, res, username) {
  const rows = await supabaseRequest(
    "GET",
    `task1_messages?to=eq.${encodeURIComponent(
      username
    )}&select=id,from,to,envelope_json,created_at&order=created_at.asc`
  );
  const messages = (Array.isArray(rows) ? rows : []).map((r) => ({
    id: r.id,
    from: r.from,
    to: r.to,
    envelope: r.envelope_json,
    createdAt: r.created_at,
  }));
  json(req, res, 200, { messages });
}

function handleTlsInfo(res, req) {
  const tlsSocket = req.socket;
  json(req, res, 200, {
    protocol: tlsSocket.getProtocol(),
    cipher: tlsSocket.getCipher(),
    minSupported: "TLSv1.2",
    note: "Credentials are only accepted over HTTPS with TLS1.2+",
  });
}

async function main() {
  const handler = async (req, res) => {
    try {
      const urlObj = new URL(req.url, `https://${req.headers.host}`);
      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders(req));
        res.end();
        return;
      }

      if (req.method === "GET" && urlObj.pathname === "/health") {
        json(req, res, 200, { ok: true, backend: "supabase" });
        return;
      }
      if (req.method === "GET" && urlObj.pathname === "/tls-info") {
        handleTlsInfo(res, req);
        return;
      }
      if (req.method === "POST" && urlObj.pathname === "/register") {
        await handleRegister(req, res);
        return;
      }
      if (req.method === "POST" && urlObj.pathname === "/login") {
        await handleLogin(req, res);
        return;
      }
      if (req.method === "GET" && urlObj.pathname === "/public-keys") {
        await handleGetPublicKeys(req, res, urlObj);
        return;
      }
      if (urlObj.pathname === "/messages") {
        const username = authenticate(req);
        if (!username) {
          json(req, res, 401, { error: "Unauthorized" });
          return;
        }
        if (req.method === "GET") {
          await handleReceiveMessages(req, res, username);
          return;
        }
        if (req.method === "POST") {
          await handleSendMessage(req, res, username);
          return;
        }
      }

      routeNotFound(req, res);
    } catch (error) {
      json(req, res, 500, { error: error.message || "Unexpected error" });
    }
  };

  let server;
  if (USE_HTTP) {
    server = http.createServer(handler);
    server.listen(PORT, () => {
      console.log(`Task1 server listening on http://0.0.0.0:${PORT} (HTTP — TLS terminated upstream)`);
    });
  } else {
    const tlsOptions = {
      key: fs.readFileSync(path.join(CERT_DIR, "server.key")),
      cert: fs.readFileSync(path.join(CERT_DIR, "server.crt")),
      ca: fs.readFileSync(path.join(CERT_DIR, "ca.crt")),
      minVersion: "TLSv1.2",
    };
    server = https.createServer(tlsOptions, handler);
    server.listen(PORT, () => {
      console.log(`Task1 server listening on https://localhost:${PORT} (HTTPS)`);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
