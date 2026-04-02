import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const imageInput = document.getElementById("imageInput");
const recognizeBtn = document.getElementById("recognizeBtn");
const downloadBtn = document.getElementById("downloadBtn");
const rawTextEl = document.getElementById("rawText");
const statusEl = document.getElementById("status");
const tableWrap = document.getElementById("tableWrap");
const supabaseUrlInput = document.getElementById("supabaseUrl");
const supabaseAnonInput = document.getElementById("supabaseAnonKey");
const aiApiUrlInput = document.getElementById("aiApiUrl");
const saveConfigBtn = document.getElementById("saveConfigBtn");
const emailInput = document.getElementById("emailInput");
const sendMagicBtn = document.getElementById("sendMagicBtn");
const signOutBtn = document.getElementById("signOutBtn");
const authStatus = document.getElementById("authStatus");
const shareCodeInput = document.getElementById("shareCodeInput");
const createTimetableBtn = document.getElementById("createTimetableBtn");
const joinTimetableBtn = document.getElementById("joinTimetableBtn");
const timetableStatus = document.getElementById("timetableStatus");
const createLocalScheduleBtn = document.getElementById("createLocalScheduleBtn");
const googleSignInBtn = document.getElementById("googleSignInBtn");

/** Canonical weekday keys (must match DB / AI output). */
const DAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const DAY_HEADERS_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MAX_IMAGE_BYTES = 250 * 1024;
const HALF_HOUR_SLOTS = Array.from({ length: 48 }, (_, idx) => {
  const startMin = idx * 30;
  const endMin = startMin + 30;
  const startHour = String(Math.floor(startMin / 60)).padStart(2, "0");
  const startMinute = String(startMin % 60).padStart(2, "0");
  const endHour = String(Math.floor(endMin / 60)).padStart(2, "0");
  const endMinute = String(endMin % 60).padStart(2, "0");
  return `${startHour}:${startMinute}-${endHour}:${endMinute}`;
});

/** Local-only schedule (not synced to Supabase). */
const LOCAL_SCHEDULE_ID = "__local__";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeStoredTimetableId(raw) {
  const s = String(raw || "").trim();
  if (!s || s === LOCAL_SCHEDULE_ID) return s || "";
  return UUID_RE.test(s) ? s : "";
}

/** Only valid UUID strings for PostgREST filters (avoid id=eq.[object Object] → 400). */
function coerceUuidString(value) {
  if (value == null || typeof value !== "string") return null;
  const t = value.trim();
  return UUID_RE.test(t) ? t : null;
}

function getValidCloudTimetableId() {
  if (!currentTimetableId || currentTimetableId === LOCAL_SCHEDULE_ID) return null;
  return coerceUuidString(currentTimetableId);
}

function clearInvalidCloudTimetableId() {
  if (!currentTimetableId || currentTimetableId === LOCAL_SCHEDULE_ID) return;
  if (getValidCloudTimetableId()) return;
  currentTimetableId = "";
  localStorage.removeItem(STORAGE_KEYS.timetableId);
}

const STORAGE_KEYS = {
  supabaseUrl: "we_meet_supabase_url",
  supabaseAnon: "we_meet_supabase_anon",
  aiApiUrl: "we_meet_ai_api_url",
  timetableId: "we_meet_timetable_id",
  localEvents: "we_meet_local_events_v1",
};

/** Default project connection (overridable via localStorage). */
const DEFAULT_APP_CONFIG = {
  supabaseUrl: "https://ffoigzshtkstosjbquhp.supabase.co",
  supabaseAnonKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZmb2lnenNodGtzdG9zamJxdWhwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwNTU2NDIsImV4cCI6MjA5MDYzMTY0Mn0.h6iFTFsQGb48zgmnLnUJyhjwp-ufWgg3AtimANsrWzk",
  aiApiUrl: "https://we-meet-ai-proxy.grjtqz2g9m-085.workers.dev",
};

let supabase = null;
let authSubscription = null;
let currentRows = [];
let currentUser = null;
let currentTimetableId = normalizeStoredTimetableId(
  localStorage.getItem(STORAGE_KEYS.timetableId) || ""
);
if (
  localStorage.getItem(STORAGE_KEYS.timetableId) &&
  !currentTimetableId &&
  localStorage.getItem(STORAGE_KEYS.timetableId) !== LOCAL_SCHEDULE_ID
) {
  localStorage.removeItem(STORAGE_KEYS.timetableId);
}
let realtimeChannel = null;

function isLocalSchedule() {
  return currentTimetableId === LOCAL_SCHEDULE_ID;
}

function loadLocalEventsRaw() {
  try {
    const s = localStorage.getItem(STORAGE_KEYS.localEvents);
    if (!s) return [];
    const p = JSON.parse(s);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

function saveLocalEvents(events) {
  localStorage.setItem(STORAGE_KEYS.localEvents, JSON.stringify(events));
}

function updateSharingUi() {
  const loggedIn = Boolean(currentUser);
  const cloud = Boolean(currentTimetableId) && !isLocalSchedule();
  const canShare = loggedIn && cloud;
  if (shareCodeInput) shareCodeInput.disabled = !canShare;
  if (joinTimetableBtn) joinTimetableBtn.disabled = !canShare;
  if (createTimetableBtn) createTimetableBtn.disabled = !loggedIn;
  if (googleSignInBtn) googleSignInBtn.disabled = !supabase;
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "#b91c1c" : "#4b5563";
}

function setAuthStatus(text, isError = false) {
  authStatus.textContent = text;
  authStatus.style.color = isError ? "#b91c1c" : "#4b5563";
}

function setTimetableStatus(text, isError = false) {
  timetableStatus.textContent = text;
  timetableStatus.style.color = isError ? "#b91c1c" : "#4b5563";
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const base64 = dataUrl.split(",")[1];
      if (!base64) {
        reject(new Error("Failed to read image"));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("Failed to read image"));
    reader.readAsDataURL(file);
  });
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to decode image"));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Image compression failed"));
          return;
        }
        resolve(blob);
      },
      "image/jpeg",
      quality
    );
  });
}

async function compressImageUnderLimit(file, maxBytes = MAX_IMAGE_BYTES) {
  if (file.size <= maxBytes) {
    return file;
  }
  const img = await loadImageFromFile(file);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Image compression is not supported in this browser");
  }

  let scale = 1;
  let quality = 0.9;
  let bestBlob = null;

  for (let i = 0; i < 10; i += 1) {
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await canvasToBlob(canvas, quality);
    bestBlob = blob;
    if (blob.size <= maxBytes) {
      return new File([blob], "compressed.jpg", { type: "image/jpeg" });
    }
    if (quality > 0.55) quality -= 0.12;
    else scale *= 0.86;
  }

  if (!bestBlob) throw new Error("Image compression failed");
  return new File([bestBlob], "compressed.jpg", { type: "image/jpeg" });
}

function normalizeState(value) {
  return String(value || "").toLowerCase().trim() === "busy" ? "busy" : "available";
}

function normalizeDayToCn(value) {
  const v = String(value || "").trim().toLowerCase();
  if (["周一", "星期一", "mon", "monday", "1", "day1"].includes(v)) return "周一";
  if (["周二", "星期二", "tue", "tuesday", "2", "day2"].includes(v)) return "周二";
  if (["周三", "星期三", "wed", "wednesday", "3", "day3"].includes(v)) return "周三";
  if (["周四", "星期四", "thu", "thursday", "4", "day4"].includes(v)) return "周四";
  if (["周五", "星期五", "fri", "friday", "5", "day5"].includes(v)) return "周五";
  if (["周六", "星期六", "sat", "saturday", "6", "day6"].includes(v)) return "周六";
  if (["周日", "星期日", "星期天", "周天", "sun", "sunday", "7", "day7"].includes(v)) return "周日";
  return "";
}

function parseTimeToMinutes(value) {
  const match = String(value || "").trim().match(/^([01]?\d|2[0-4]):([0-5]\d)$/);
  if (!match) return NaN;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour === 24 && minute !== 0) return NaN;
  return hour * 60 + minute;
}

function sanitizeEvents(rawEvents) {
  const unique = new Set();
  const cleaned = [];
  rawEvents.forEach((event) => {
    const day = normalizeDayToCn(event?.day);
    const start = String(event?.start || "").trim();
    const end = String(event?.end || "").trim();
    const startMin = parseTimeToMinutes(start);
    const endMin = parseTimeToMinutes(end);
    if (!day || Number.isNaN(startMin) || Number.isNaN(endMin) || endMin <= startMin) return;
    if (endMin - startMin > 180) return;
    const key = `${day}-${start}-${end}`;
    if (unique.has(key)) return;
    unique.add(key);
    cleaned.push({ day, start, end, startMin, endMin, title: String(event?.title || "") });
  });
  return cleaned;
}

function buildRowsFromEvents(events) {
  const rows = [["Time slot", ...DAY_HEADERS_EN]];
  const grid = HALF_HOUR_SLOTS.map(() => Object.fromEntries(DAYS.map((d) => [d, "available"])));
  events.forEach((event) => {
    HALF_HOUR_SLOTS.forEach((_, idx) => {
      const slotStart = idx * 30;
      const slotEnd = slotStart + 30;
      if (event.startMin < slotEnd && event.endMin > slotStart) {
        grid[idx][event.day] = "busy";
      }
    });
  });
  HALF_HOUR_SLOTS.forEach((slot, idx) => {
    rows.push([slot, ...DAYS.map((d) => normalizeState(grid[idx][d]))]);
  });
  return rows;
}

function renderTable(rows) {
  tableWrap.innerHTML = "";
  if (!rows.length) {
    tableWrap.innerHTML = "<p>No data to display</p>";
    downloadBtn.disabled = true;
    return;
  }

  const table = document.createElement("table");
  table.className = "schedule-table";
  const thead = document.createElement("thead");
  const tbody = document.createElement("tbody");

  const headRow = document.createElement("tr");
  for (let i = 0; i < rows[0].length; i += 1) {
    const th = document.createElement("th");
    th.textContent = rows[0][i];
    if (i === 0) th.className = "time-col";
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);

  rows.slice(1).forEach((row) => {
    const tr = document.createElement("tr");
    for (let i = 0; i < row.length; i += 1) {
      const td = document.createElement("td");
      if (i === 0) {
        td.textContent = row[i] || "";
        td.className = "time-col";
      } else {
        const value = row[i] || "available";
        const pill = document.createElement("span");
        pill.className = `state-pill ${value}`;
        pill.textContent = value;
        td.appendChild(pill);
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });

  table.appendChild(thead);
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  downloadBtn.disabled = false;
}

function escapeCSV(value) {
  const str = String(value ?? "");
  if (str.includes('"') || str.includes(",") || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCSV(rows) {
  return rows.map((r) => r.map(escapeCSV).join(",")).join("\n");
}

async function loadEventsAndRender() {
  if (isLocalSchedule()) {
    const raw = loadLocalEventsRaw();
    const cleaned = sanitizeEvents(raw);
    currentRows = buildRowsFromEvents(cleaned);
    renderTable(currentRows);
    return;
  }
  const tid = getValidCloudTimetableId();
  if (!tid) {
    clearInvalidCloudTimetableId();
    currentRows = buildRowsFromEvents([]);
    renderTable(currentRows);
    return;
  }
  if (!supabase) return;
  const { data, error } = await supabase
    .from("events")
    .select("day,start,end,title")
    .eq("timetable_id", tid)
    .order("start", { ascending: true });
  if (error) throw error;
  const cleaned = sanitizeEvents(data || []);
  currentRows = buildRowsFromEvents(cleaned);
  renderTable(currentRows);
}

async function getTimetableShareCode(timetableId) {
  const tid = coerceUuidString(
    typeof timetableId === "string" ? timetableId : ""
  );
  if (!supabase || !tid) return "";
  const { data, error } = await supabase
    .from("timetables")
    .select("share_code")
    .eq("id", tid)
    .maybeSingle();
  if (error) return "";
  return data?.share_code || "";
}

function firstUuidStringIn(value, depth) {
  const d = depth ?? 0;
  if (d > 4) return null;
  if (typeof value === "string" && UUID_RE.test(value.trim())) return value.trim();
  if (value && typeof value === "object") {
    for (const k of Object.keys(value)) {
      const found = firstUuidStringIn(value[k], d + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * RPC create_timetable / join_timetable_by_code returns { id, share_code } (json).
 * Some clients nest id; coerce to a UUID string before use.
 */
function parseTimetableRpcPayload(data) {
  let v = data;
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("{")) {
      try {
        v = JSON.parse(t);
      } catch {
        return { id: null, shareCode: "" };
      }
    } else {
      return UUID_RE.test(t) ? { id: t, shareCode: "" } : { id: null, shareCode: "" };
    }
  }
  if (Array.isArray(v) && v.length === 1) {
    v = v[0];
  }
  if (!v || typeof v !== "object") {
    return { id: null, shareCode: "" };
  }

  let idRaw = v.id;
  let shareCode = typeof v.share_code === "string" ? v.share_code : "";

  if (idRaw && typeof idRaw === "object" && "id" in idRaw) {
    shareCode = typeof idRaw.share_code === "string" ? idRaw.share_code : shareCode;
    idRaw = idRaw.id;
  }

  let id = null;
  if (typeof idRaw === "string" && UUID_RE.test(idRaw.trim())) {
    id = idRaw.trim();
  } else if (idRaw != null && typeof idRaw === "object") {
    id = firstUuidStringIn(idRaw);
  }

  if (!id) {
    id = firstUuidStringIn(v);
  }

  return { id, shareCode: shareCode || "" };
}

function eventKey(day, start, end) {
  return `${day}|${start}|${end}`;
}

function persistLocalEvents(cleanedEvents) {
  if (!cleanedEvents.length) {
    return { merged: 0, skipped: 0 };
  }
  const existing = loadLocalEventsRaw();
  const existingKeys = new Set(
    existing.map((e) => eventKey(e.day, e.start, e.end))
  );
  const toAdd = [];
  let skipped = 0;
  cleanedEvents.forEach((event) => {
    const key = eventKey(event.day, event.start, event.end);
    if (existingKeys.has(key)) {
      skipped += 1;
      return;
    }
    existingKeys.add(key);
    toAdd.push({
      day: event.day,
      start: event.start,
      end: event.end,
      title: event.title || "",
    });
  });
  saveLocalEvents([...existing, ...toAdd]);
  return { merged: toAdd.length, skipped };
}

async function persistEvents(cleanedEvents) {
  if (isLocalSchedule()) {
    return persistLocalEvents(cleanedEvents);
  }
  const tid = getValidCloudTimetableId();
  if (!supabase || !tid) {
    throw new Error("Sign in and select a cloud timetable first");
  }
  if (!cleanedEvents.length) {
    return { merged: 0, skipped: 0 };
  }

  const { data: existing, error: exErr } = await supabase
    .from("events")
    .select("day,start,end")
    .eq("timetable_id", tid);
  if (exErr) throw exErr;

  const existingKeys = new Set(
    (existing || []).map((e) => eventKey(e.day, e.start, e.end))
  );

  const toInsert = [];
  let skipped = 0;
  cleanedEvents.forEach((event) => {
    const key = eventKey(event.day, event.start, event.end);
    if (existingKeys.has(key)) {
      skipped += 1;
      return;
    }
    existingKeys.add(key);
    toInsert.push({
      timetable_id: tid,
      day: event.day,
      start: event.start,
      end: event.end,
      title: event.title || null,
      source: "ai",
      created_by: currentUser?.id ?? null,
    });
  });

  if (!toInsert.length) {
    return { merged: 0, skipped };
  }

  const { error: insErr } = await supabase.from("events").insert(toInsert);
  if (insErr) throw insErr;
  return { merged: toInsert.length, skipped };
}

async function recognizeWithProxy(file) {
  const apiUrl = aiApiUrlInput.value.trim();
  if (!apiUrl) throw new Error("Configure the AI proxy URL first");
  const base64Data = await readFileAsBase64(file);
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      imageBase64: base64Data,
      mimeType: file.type || "image/jpeg",
    }),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`AI proxy request failed: ${response.status} ${errText}`);
  }
  return response.json();
}

async function recognizeImage() {
  const originalFile = imageInput.files?.[0];
  if (!originalFile) {
    setStatus("Choose an image file first", true);
    return;
  }
  if (isLocalSchedule()) {
    /* ok */
  } else if (!getValidCloudTimetableId()) {
    setStatus('Create a local schedule or sign in and create/join a cloud timetable', true);
    return;
  }

  recognizeBtn.disabled = true;
  downloadBtn.disabled = true;
  setStatus("Recognizing, please wait…");

  try {
    setStatus("Compressing image to under 250KB…");
    const file = await compressImageUnderLimit(originalFile);
    setStatus(`Recognizing (image ${(file.size / 1024).toFixed(1)} KB)…`);
    const payload = await recognizeWithProxy(file);
    const rawEvents = Array.isArray(payload?.events) ? payload.events : [];
    const cleanedEvents = sanitizeEvents(rawEvents);
    rawTextEl.value = JSON.stringify(
      {
        events: rawEvents,
        sanitizedEvents: cleanedEvents,
        rawText: String(payload?.rawText || ""),
      },
      null,
      2
    );
    const { merged, skipped } = await persistEvents(cleanedEvents);
    await loadEventsAndRender();
    const slotCount = Math.max(currentRows.length - 1, 0);
    const scope = isLocalSchedule() ? "local schedule" : "shared cloud timetable";
    if (merged === 0 && cleanedEvents.length > 0) {
      setStatus(
        `Done: all ${cleanedEvents.length} events were duplicates; ${slotCount} time rows in this ${scope}`
      );
    } else if (merged === 0 && cleanedEvents.length === 0) {
      setStatus(`No new events found; ${slotCount} time rows in this ${scope}`);
    } else {
      setStatus(
        `Done: added ${merged} event(s)${skipped ? `, skipped ${skipped} duplicate(s)` : ""}; merged into ${scope}, ${slotCount} time rows`
      );
    }
  } catch (err) {
    setStatus(err.message || "Recognition failed", true);
  } finally {
    recognizeBtn.disabled = false;
  }
}

function setupRealtime() {
  const tid = getValidCloudTimetableId();
  if (!supabase || !tid) return;
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  realtimeChannel = supabase
    .channel(`events:${tid}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "events", filter: `timetable_id=eq.${tid}` },
      async () => {
        await loadEventsAndRender();
      }
    )
    .subscribe();
}

function saveConfig() {
  localStorage.setItem(STORAGE_KEYS.supabaseUrl, supabaseUrlInput.value.trim());
  localStorage.setItem(STORAGE_KEYS.supabaseAnon, supabaseAnonInput.value.trim());
  localStorage.setItem(STORAGE_KEYS.aiApiUrl, aiApiUrlInput.value.trim());
}

async function initSupabase() {
  saveConfig();
  if (currentTimetableId === LOCAL_SCHEDULE_ID) {
    setTimetableStatus(
      "Local-only schedule: data stays in this browser and is not shared."
    );
    await loadEventsAndRender();
  }

  const url = localStorage.getItem(STORAGE_KEYS.supabaseUrl) || "";
  const anon = localStorage.getItem(STORAGE_KEYS.supabaseAnon) || "";
  if (!url || !anon) {
    setAuthStatus("Enter Supabase URL and anon key (optional for local-only mode)", true);
    setStatus("Could not save: URL and anon key are required", true);
    updateSharingUi();
    return false;
  }
  if (authSubscription) {
    authSubscription.unsubscribe();
    authSubscription = null;
  }
  supabase = createClient(url, anon);
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    setAuthStatus(error.message, true);
    setStatus(`Supabase connection failed: ${error.message}`, true);
    updateSharingUi();
    return false;
  }
  currentUser = data.session?.user || null;
  setAuthStatus(
    currentUser
      ? `Signed in: ${currentUser.email || currentUser.user_metadata?.full_name || "User"}`
      : "Signed out (local schedule / email or Google sign-in)"
  );
  const { data: authData } = supabase.auth.onAuthStateChange((_event, session) => {
    currentUser = session?.user || null;
    setAuthStatus(
      currentUser
        ? `Signed in: ${currentUser.email || currentUser.user_metadata?.full_name || "User"}`
        : "Signed out (local schedule / email or Google sign-in)"
    );
    updateSharingUi();
  });
  authSubscription = authData.subscription;

  clearInvalidCloudTimetableId();
  const cloudId = getValidCloudTimetableId();
  if (cloudId) {
    setTimetableStatus(`Current cloud timetable ID: ${cloudId}`);
    await loadEventsAndRender();
    setupRealtime();
  }
  updateSharingUi();
  return true;
}

async function sendMagicLink() {
  if (!supabase) {
    await initSupabase();
  }
  if (!supabase) return;
  const email = emailInput.value.trim();
  if (!email) {
    setAuthStatus("Enter your email", true);
    return;
  }
  const redirectTo = `${window.location.origin}${window.location.pathname}`;
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: redirectTo,
    },
  });
  if (error) {
    setAuthStatus(error.message, true);
    return;
  }
  setAuthStatus("Magic link sent. Check your inbox and open the latest email once, within a few minutes.");
}

async function signOut() {
  if (!supabase) return;
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  await supabase.auth.signOut();
  if (currentTimetableId && !isLocalSchedule()) {
    currentTimetableId = "";
    localStorage.removeItem(STORAGE_KEYS.timetableId);
  }
  if (isLocalSchedule()) {
    setTimetableStatus(
      "Local-only schedule (signed out); data remains in this browser."
    );
  } else {
    setTimetableStatus("No cloud timetable selected");
  }
  await loadEventsAndRender();
  updateSharingUi();
}

function createLocalSchedule() {
  if (realtimeChannel && supabase) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  currentTimetableId = LOCAL_SCHEDULE_ID;
  localStorage.setItem(STORAGE_KEYS.timetableId, LOCAL_SCHEDULE_ID);
  saveLocalEvents([]);
  setTimetableStatus(
    "Local-only schedule: data stays in this browser. Sign in to use a shared cloud timetable."
  );
  loadEventsAndRender();
  updateSharingUi();
  setStatus("Local schedule created — you can upload an image to recognize");
}

async function signInWithGoogle() {
  if (!supabase) {
    const ok = await initSupabase();
    if (!ok) return;
  }
  const redirectTo = `${window.location.origin}${window.location.pathname}`;
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo },
  });
  if (error) {
    setAuthStatus(error.message, true);
  }
}

async function createTimetable() {
  if (!supabase || !currentUser) {
    setTimetableStatus("Please sign in first", true);
    return;
  }
  const { data, error } = await supabase.rpc("create_timetable", {
    p_name: `Schedule-${new Date().toLocaleDateString("en-US")}`,
  });
  if (error) {
    setTimetableStatus(error.message, true);
    return;
  }
  const parsed = parseTimetableRpcPayload(data);
  const id = coerceUuidString(parsed.id);
  if (!id) {
    setTimetableStatus("Invalid response from create timetable", true);
    return;
  }
  currentTimetableId = id;
  localStorage.setItem(STORAGE_KEYS.timetableId, currentTimetableId);
  const shareCode = parsed.shareCode || (await getTimetableShareCode(id));
  setTimetableStatus(
    `Timetable created — share code: ${shareCode || "unavailable"}, ID: ${currentTimetableId}`
  );
  await loadEventsAndRender();
  setupRealtime();
  updateSharingUi();
}

async function joinTimetable() {
  if (!supabase || !currentUser) {
    setTimetableStatus("Please sign in first", true);
    return;
  }
  const code = shareCodeInput.value.trim();
  if (!code) {
    setTimetableStatus("Enter a share code", true);
    return;
  }
  const { data, error } = await supabase.rpc("join_timetable_by_code", { p_share_code: code });
  if (error) {
    setTimetableStatus(error.message, true);
    return;
  }
  const parsed = parseTimetableRpcPayload(data);
  const id = coerceUuidString(parsed.id);
  if (!id) {
    setTimetableStatus("Invalid response from join timetable", true);
    return;
  }
  currentTimetableId = id;
  localStorage.setItem(STORAGE_KEYS.timetableId, currentTimetableId);
  const shareCode = parsed.shareCode || (await getTimetableShareCode(id)) || code;
  setTimetableStatus(`Joined timetable — share code: ${shareCode}, ID: ${currentTimetableId}`);
  await loadEventsAndRender();
  setupRealtime();
  updateSharingUi();
}

recognizeBtn.addEventListener("click", recognizeImage);
saveConfigBtn.addEventListener("click", async () => {
  const ok = await initSupabase();
  if (ok) {
    const ai = aiApiUrlInput.value.trim();
    setStatus(
      ai
        ? "Saved: Supabase connected; AI proxy URL stored for recognition."
        : "Saved: Supabase connected. Add the AI proxy URL before recognizing images."
    );
  }
});
sendMagicBtn.addEventListener("click", sendMagicLink);
signOutBtn.addEventListener("click", signOut);
createTimetableBtn.addEventListener("click", createTimetable);
joinTimetableBtn.addEventListener("click", joinTimetable);
createLocalScheduleBtn?.addEventListener("click", createLocalSchedule);
googleSignInBtn?.addEventListener("click", () => {
  signInWithGoogle();
});
downloadBtn.addEventListener("click", () => {
  if (!currentRows.length) {
    return;
  }
  const csv = toCSV(currentRows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "ocr-table.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

function loadConfigInputs() {
  supabaseUrlInput.value =
    localStorage.getItem(STORAGE_KEYS.supabaseUrl) || DEFAULT_APP_CONFIG.supabaseUrl;
  supabaseAnonInput.value =
    localStorage.getItem(STORAGE_KEYS.supabaseAnon) || DEFAULT_APP_CONFIG.supabaseAnonKey;
  aiApiUrlInput.value =
    localStorage.getItem(STORAGE_KEYS.aiApiUrl) || DEFAULT_APP_CONFIG.aiApiUrl;
}

function consumeAuthErrorFromUrl() {
  const hash = window.location.hash;
  if (!hash || hash.length < 2) return;
  const params = new URLSearchParams(hash.slice(1));
  const code = params.get("error_code");
  const err = params.get("error");
  if (code === "otp_expired" || err === "access_denied") {
    setAuthStatus(
      "That sign-in link expired or was already used. Return here and send a new magic link.",
      true
    );
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }
}

loadConfigInputs();
consumeAuthErrorFromUrl();
(async () => {
  await initSupabase();
})();
