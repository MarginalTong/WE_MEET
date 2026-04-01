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

const STORAGE_KEYS = {
  supabaseUrl: "we_meet_supabase_url",
  supabaseAnon: "we_meet_supabase_anon",
  aiApiUrl: "we_meet_ai_api_url",
  timetableId: "we_meet_timetable_id",
};

let supabase = null;
let currentRows = [];
let currentUser = null;
let currentTimetableId = localStorage.getItem(STORAGE_KEYS.timetableId) || "";
let realtimeChannel = null;

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
  if (!supabase || !currentTimetableId) return;
  const { data, error } = await supabase
    .from("events")
    .select("day,start,end,title")
    .eq("timetable_id", currentTimetableId)
    .order("start", { ascending: true });
  if (error) throw error;
  const cleaned = sanitizeEvents(data || []);
  currentRows = buildRowsFromEvents(cleaned);
  renderTable(currentRows);
}

async function getTimetableShareCode(timetableId) {
  if (!supabase || !timetableId) return "";
  const { data, error } = await supabase
    .from("timetables")
    .select("share_code")
    .eq("id", timetableId)
    .single();
  if (error) return "";
  return data?.share_code || "";
}

async function persistEvents(cleanedEvents) {
  if (!supabase || !currentTimetableId) {
    throw new Error("请先登录并加入课表");
  }
  const { error: delErr } = await supabase
    .from("events")
    .delete()
    .eq("timetable_id", currentTimetableId)
    .eq("source", "ai");
  if (delErr) throw delErr;

  if (!cleanedEvents.length) return;
  const inserts = cleanedEvents.map((event) => ({
    timetable_id: currentTimetableId,
    day: event.day,
    start: event.start,
    end: event.end,
    title: event.title || null,
    source: "ai",
  }));
  const { error: insErr } = await supabase.from("events").insert(inserts);
  if (insErr) throw insErr;
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
  if (!currentTimetableId) {
    setStatus("请先创建或加入课表", true);
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
    await persistEvents(cleanedEvents);
    await loadEventsAndRender();
    setStatus(`识别完成，共 ${Math.max(currentRows.length - 1, 0)} 个时间段`);
  } catch (err) {
    setStatus(err.message || "识别失败", true);
  } finally {
    recognizeBtn.disabled = false;
  }
}

function setupRealtime() {
  if (!supabase || !currentTimetableId) return;
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  realtimeChannel = supabase
    .channel(`events:${currentTimetableId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "events", filter: `timetable_id=eq.${currentTimetableId}` },
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
  const url = localStorage.getItem(STORAGE_KEYS.supabaseUrl) || "";
  const anon = localStorage.getItem(STORAGE_KEYS.supabaseAnon) || "";
  if (!url || !anon) {
    setAuthStatus("请先填写 Supabase URL 和 Anon Key", true);
    return;
  }
  supabase = createClient(url, anon);
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    setAuthStatus(error.message, true);
  } else {
    currentUser = data.session?.user || null;
    setAuthStatus(currentUser ? `已登录：${currentUser.email}` : "未登录");
  }
  supabase.auth.onAuthStateChange((_event, session) => {
    currentUser = session?.user || null;
    setAuthStatus(currentUser ? `已登录：${currentUser.email}` : "未登录");
  });
  if (currentTimetableId) {
    setTimetableStatus(`当前课表ID：${currentTimetableId}`);
    await loadEventsAndRender();
    setupRealtime();
  }
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
  const { error } = await supabase.auth.signInWithOtp({ email });
  if (error) {
    setAuthStatus(error.message, true);
    return;
  }
  setAuthStatus("登录链接已发送，请查收邮箱");
}

async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

async function createTimetable() {
  if (!supabase || !currentUser) {
    setTimetableStatus("请先登录", true);
    return;
  }
  const { data, error } = await supabase.rpc("create_timetable", {
    p_name: `课表-${new Date().toLocaleDateString()}`,
  });
  if (error) {
    setTimetableStatus(error.message, true);
    return;
  }
  currentTimetableId = data;
  localStorage.setItem(STORAGE_KEYS.timetableId, currentTimetableId);
  const shareCode = await getTimetableShareCode(currentTimetableId);
  setTimetableStatus(
    `已创建课表，分享码：${shareCode || "获取失败"}，ID：${currentTimetableId}`
  );
  await loadEventsAndRender();
  setupRealtime();
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
  currentTimetableId = data;
  localStorage.setItem(STORAGE_KEYS.timetableId, currentTimetableId);
  const shareCode = await getTimetableShareCode(currentTimetableId);
  setTimetableStatus(`加入成功，分享码：${shareCode || code}，ID：${currentTimetableId}`);
  await loadEventsAndRender();
  setupRealtime();
}

recognizeBtn.addEventListener("click", recognizeImage);
saveConfigBtn.addEventListener("click", async () => {
  await initSupabase();
  setStatus("配置已保存");
});
sendMagicBtn.addEventListener("click", sendMagicLink);
signOutBtn.addEventListener("click", signOut);
createTimetableBtn.addEventListener("click", createTimetable);
joinTimetableBtn.addEventListener("click", joinTimetable);
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
  supabaseUrlInput.value = localStorage.getItem(STORAGE_KEYS.supabaseUrl) || "";
  supabaseAnonInput.value = localStorage.getItem(STORAGE_KEYS.supabaseAnon) || "";
  aiApiUrlInput.value = localStorage.getItem(STORAGE_KEYS.aiApiUrl) || "";
}

loadConfigInputs();
initSupabase();
