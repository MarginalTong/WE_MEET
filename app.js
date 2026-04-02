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

const DAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
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

/** 标记当前选中为仅本机日程（不写入 Supabase） */
const LOCAL_SCHEDULE_ID = "__local__";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeStoredTimetableId(raw) {
  const s = String(raw || "").trim();
  if (!s || s === LOCAL_SCHEDULE_ID) return s || "";
  return UUID_RE.test(s) ? s : "";
}

/** 仅合法 UUID 字符串可用于 PostgREST，禁止把对象拼进 id=eq....（否则会 400） */
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

/** 项目默认连接（首次打开自动使用；本地 storage 可覆盖） */
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
        reject(new Error("图片读取失败"));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("图片读取失败"));
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
      reject(new Error("图片解码失败"));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("图片压缩失败"));
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
    throw new Error("浏览器不支持图片压缩");
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

  if (!bestBlob) throw new Error("图片压缩失败");
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
  const rows = [["时间段", ...DAYS]];
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
    tableWrap.innerHTML = "<p>没有可展示的数据</p>";
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
 * RPC create_timetable / join_timetable_by_code 返回 { id, share_code }（json）。
 * PostgREST / 客户端有时会把 id 包成嵌套对象；若当字符串用会出现 ID: [object Object]。
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
    throw new Error("请先登录并加入云端日程表");
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
  if (!apiUrl) throw new Error("请先配置 AI 代理接口地址");
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
    throw new Error(`AI 代理请求失败：${response.status} ${errText}`);
  }
  return response.json();
}

async function recognizeImage() {
  const originalFile = imageInput.files?.[0];
  if (!originalFile) {
    setStatus("请先选择图片文件", true);
    return;
  }
  if (isLocalSchedule()) {
    /* ok */
  } else if (!getValidCloudTimetableId()) {
    setStatus("请先点「创建本机日程」或登录后创建/加入云端日程表", true);
    return;
  }

  recognizeBtn.disabled = true;
  downloadBtn.disabled = true;
  setStatus("正在识别中，请稍候...");

  try {
    setStatus("正在压缩图片到 250KB 以下...");
    const file = await compressImageUnderLimit(originalFile);
    setStatus(`正在识别中（图片大小 ${(file.size / 1024).toFixed(1)}KB）...`);
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
    const scope = isLocalSchedule() ? "本机日程" : "云端共享日程表";
    if (merged === 0 && cleanedEvents.length > 0) {
      setStatus(
        `识别完成：本次 ${cleanedEvents.length} 条与已有日程重复，未新增；当前${scope}共 ${slotCount} 个时段行`
      );
    } else if (merged === 0 && cleanedEvents.length === 0) {
      setStatus(`未识别到新活动，日程未变；当前${scope}共 ${slotCount} 个时段行`);
    } else {
      setStatus(
        `识别完成：新增 ${merged} 条活动${skipped ? `，跳过重复 ${skipped} 条` : ""}；已合并进${scope}，共 ${slotCount} 个时段行`
      );
    }
  } catch (err) {
    setStatus(err.message || "识别失败", true);
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
      "当前为仅本机日程，数据仅保存在本浏览器，无法与他人共享"
    );
    await loadEventsAndRender();
  }

  const url = localStorage.getItem(STORAGE_KEYS.supabaseUrl) || "";
  const anon = localStorage.getItem(STORAGE_KEYS.supabaseAnon) || "";
  if (!url || !anon) {
    setAuthStatus("请先填写 Supabase URL 和 Anon Key（本机日程可不依赖登录）", true);
    setStatus("保存失败：请填齐 URL 和 Anon Key", true);
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
    setStatus(`Supabase 连接失败：${error.message}`, true);
    updateSharingUi();
    return false;
  }
  currentUser = data.session?.user || null;
  setAuthStatus(
    currentUser
      ? `已登录：${currentUser.email || currentUser.user_metadata?.full_name || "用户"}`
      : "未登录（可本机日程 / 邮箱或 Google 登录）"
  );
  const { data: authData } = supabase.auth.onAuthStateChange((_event, session) => {
    currentUser = session?.user || null;
    setAuthStatus(
      currentUser
        ? `已登录：${currentUser.email || currentUser.user_metadata?.full_name || "用户"}`
        : "未登录（可本机日程 / 邮箱或 Google 登录）"
    );
    updateSharingUi();
  });
  authSubscription = authData.subscription;

  clearInvalidCloudTimetableId();
  const cloudId = getValidCloudTimetableId();
  if (cloudId) {
    setTimetableStatus(`当前云端日程表 ID：${cloudId}`);
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
    setAuthStatus("请填写邮箱", true);
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
  setAuthStatus("登录链接已发送，请查收邮箱（请用最新一封，几分钟内点开，且只点一次）");
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
      "当前为仅本机日程（未登录），数据仍保存在本浏览器"
    );
  } else {
    setTimetableStatus("未选择云端日程表");
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
    "当前为仅本机日程，数据只保存在此浏览器；登录后可创建云端日程以共享"
  );
  loadEventsAndRender();
  updateSharingUi();
  setStatus("已创建本机日程，可上传图片识别");
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
    setTimetableStatus("请先登录", true);
    return;
  }
  const { data, error } = await supabase.rpc("create_timetable", {
    p_name: `日程-${new Date().toLocaleDateString()}`,
  });
  if (error) {
    setTimetableStatus(error.message, true);
    return;
  }
  const parsed = parseTimetableRpcPayload(data);
  const id = coerceUuidString(parsed.id);
  if (!id) {
    setTimetableStatus("创建日程表返回数据无效", true);
    return;
  }
  currentTimetableId = id;
  localStorage.setItem(STORAGE_KEYS.timetableId, currentTimetableId);
  const shareCode = parsed.shareCode || (await getTimetableShareCode(id));
  setTimetableStatus(
    `已创建日程表，分享码：${shareCode || "获取失败"}，ID：${currentTimetableId}`
  );
  await loadEventsAndRender();
  setupRealtime();
  updateSharingUi();
}

async function joinTimetable() {
  if (!supabase || !currentUser) {
    setTimetableStatus("请先登录", true);
    return;
  }
  const code = shareCodeInput.value.trim();
  if (!code) {
    setTimetableStatus("请输入分享码", true);
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
    setTimetableStatus("加入日程表返回数据无效", true);
    return;
  }
  currentTimetableId = id;
  localStorage.setItem(STORAGE_KEYS.timetableId, currentTimetableId);
  const shareCode = parsed.shareCode || (await getTimetableShareCode(id)) || code;
  setTimetableStatus(`已加入日程表，分享码：${shareCode}，ID：${currentTimetableId}`);
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
        ? "配置已保存：Supabase 已连接，AI 代理地址已记录（识别图片时会用）"
        : "配置已保存：Supabase 已连接。识别前请再填「AI 代理接口地址」"
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
      "邮件里的登录链接已过期或已使用过，请回到本页重新点「发送登录链接」",
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
