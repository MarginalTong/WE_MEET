const DEFAULT_MODEL = "gemini-3-flash";

function buildPrompt() {
  return [
    "# Role: 高级视觉网格分析器 (Visual Grid Analyzer)",
    "",
    "# Task:",
    "将课程表图片转化为结构化 JSON。这张图是一个标准的二维矩阵，你需要通过行列对齐来锁定每个课程的具体属性。",
    "",
    "# Logic Protocol:",
    "1. 建立 X 轴 (日期): 识别顶部第一行（周一至周日）。",
    "2. 建立 Y 轴 (时间): 识别最左侧时间列。",
    "3. 色块定位: 扫描带文字的色块，通过垂直和水平对齐确定 day/start/end。",
    "4. 提取内容: 课程块顶部主要文字作为 title。",
    "",
    "# Output Rules:",
    "- 严格输出 JSON，无任何解释。",
    "- 时间格式 HH:mm。",
    "",
    "{",
    '  "events": [',
    '    {"day":"周几","start":"HH:mm","end":"HH:mm","title":"课程名"}',
    "  ],",
    '  "rawText":"optional"',
    "}",
  ].join("\n");
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return jsonResponse({ ok: true });
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }
    if (!env.GEMINI_API_KEY) {
      return jsonResponse({ error: "Missing GEMINI_API_KEY secret" }, 500);
    }

    try {
      const { imageBase64, mimeType } = await request.json();
      if (!imageBase64) {
        return jsonResponse({ error: "imageBase64 is required" }, 400);
      }
      const model = env.GEMINI_MODEL || DEFAULT_MODEL;
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
        env.GEMINI_API_KEY
      )}`;
      const upstream = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: buildPrompt() },
                {
                  inlineData: {
                    mimeType: mimeType || "image/jpeg",
                    data: imageBase64,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0,
          },
        }),
      });

      const payload = await upstream.json();
      if (!upstream.ok) {
        return jsonResponse(
          { error: payload?.error?.message || "Gemini request failed" },
          upstream.status
        );
      }

      const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
      let parsed = {};
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { events: [], rawText: text };
      }
      return jsonResponse(parsed, 200);
    } catch (error) {
      return jsonResponse({ error: error.message || "Unexpected error" }, 500);
    }
  },
};
