# Task 2 — Controlled insecurity demos (INFO2222)

**These programs are deliberately vulnerable.** Use only on `127.0.0.1`, fake passwords, and for recorded demos / the report. Do not deploy publicly.

This folder is separate from `security-task1/` so your Task 1 submission stays “secure by default” while Task 2 shows what goes wrong when protections are missing or misconfigured.

## Demo A — Cleartext on the wire (HTTP, no TLS)

**File:** `server-insecure-transport.js`  
**Idea:** Passwords must not be sent without TLS (see Task 1). Here, HTTP lets anyone on the path read them with a sniffer.

### Run

```bash
node security-task2/server-insecure-transport.js
```

Default URL: `http://127.0.0.1:9080` (override with `INSECURE_HTTP_PORT`).

### Trigger traffic (for video / Wireshark)

```bash
curl -s -X POST http://127.0.0.1:9080/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"demo","password":"DemoPass!2026"}'
```

### Wireshark (macOS)

1. Capture interface: **`Loopback: lo0`**.
2. Display filter: `tcp.port == 9080` (or change port if you overrode it).
3. Find the `POST /login` packet → **Follow → TCP Stream** → show JSON with the password in plaintext.
4. In the video: explain impact (network eavesdropping / MITM on untrusted networks) and mitigation (**HTTPS + certificate verification**, as in Task 1).

---

## Demo B — Weak password storage (unsalted MD5 + “leak”)

**File:** `server-weak-password-storage.js`  
**Idea:** Task 1 requires strong salted KDF (e.g. PBKDF2). Here, **MD5 without salt** is fast to guess offline; the fake **`/backup-export-for-demo`** endpoint simulates a stolen DB or debug leak.

### Run

```bash
node security-task2/server-weak-password-storage.js
```

Default URL: `http://127.0.0.1:9081` (override with `WEAK_STORAGE_PORT`).

### Commands

```bash
curl -s -X POST http://127.0.0.1:9081/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"demo","password":"DemoPass!2026"}'

curl -s http://127.0.0.1:9081/backup-export-for-demo
```

In the video: show the JSON leak → explain why unsalted MD5 is weak → mitigation: **salt + slow KDF + no sensitive debug exports** (match your Task 1 design).

---

## Suggested 3-minute video structure (each demo)

1. **10–20 s:** What security was disabled or misconfigured.  
2. **60–90 s:** Live attack (Wireshark or `curl` leak).  
3. **60 s:** Impact + **how Task 1 / best practice fixes it**.

---

## Report / appendix

List these files in your AI appendix table if you used an assistant to create or edit them, and link your USyd GitHub repo as required by the subject outline.
