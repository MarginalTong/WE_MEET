# WE_MEET - 多人协作日程表

上传日程截图（日历、应用排期等），AI 提取占用时段后写入 Supabase，并以 30 分钟粒度展示 `busy/available`。  
支持多人共享同一份日程表、实时同步更新。

## 现在的架构

- 前端：静态页面（`index.html` + `app.js`）
- 数据与协作：Supabase（Postgres + Auth + Realtime + RLS）
- AI 代理：Cloudflare Worker（隐藏 Gemini API Key）

## 1) 初始化 Supabase

1. 在 Supabase 创建项目
2. 打开 SQL Editor，执行 `supabase/schema.sql`
3. 在项目里开启登录方式：**Authentication → Providers**
   - 开启 **Email**（Magic Link）
   - 可选：开启 **Google**（需在控制台配置 Google OAuth 客户端 ID/Secret，并把站点 URL 加入重定向白名单）
4. 确认 Realtime 已启用（`events` 表会加入 publication）

## 2) 部署 AI 代理（Cloudflare Worker）

目录：`worker/`

```bash
cd worker
npm create cloudflare@latest . -- --existing-script
npx wrangler secret put GEMINI_API_KEY
npx wrangler deploy
```

部署后得到 URL（例如 `https://we-meet-ai-proxy.xxx.workers.dev`），用于前端 `AI 代理接口地址`。

## 3) 启动前端

```bash
python3 -m http.server 8080
```

打开 `http://localhost:8080`，在页面中填写：

- `Supabase URL`
- `Supabase Anon Key`
- `AI 代理接口地址`

然后：

1. **可选**「创建本机日程」：无需登录，数据仅存浏览器，不可共享。
2. 或 **邮箱 / Google** 登录后，创建云端日程表（会返回分享码）
3. 其他成员用分享码加入
4. 上传图片识别，结果写入同一份日程表并实时同步

## 4) 核心表

- `timetables`：日程表主表（技术名未改）
- `timetable_members`：成员与角色（owner/editor/viewer）
- `events`：活动/占用明细（day/start/end/title/source）

## 5) 安全说明

- Gemini Key 只在 Worker Secret 中保存，不出现在前端
- 前端仅使用 Supabase Anon Key（配合 RLS 控制权限）
- RLS 已按成员角色限制读写
