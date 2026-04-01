# WE_MEET - 多人协作课表

上传课表图片，AI 提取事件后写入 Supabase，并以 30 分钟粒度展示 `busy/available`。  
支持多人共享同一课表、实时同步更新。

## 现在的架构

- 前端：静态页面（`index.html` + `app.js`）
- 数据与协作：Supabase（Postgres + Auth + Realtime + RLS）
- AI 代理：Cloudflare Worker（隐藏 Gemini API Key）

## 1) 初始化 Supabase

1. 在 Supabase 创建项目
2. 打开 SQL Editor，执行 `supabase/schema.sql`
3. 在项目里开启 Email OTP 登录（Auth -> Providers）
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

1. 邮箱登录（Magic Link）
2. 创建课表（会返回分享码）
3. 其他成员用分享码加入
4. 上传图片识别，结果写入同一课表并实时同步

## 4) 核心表

- `timetables`：课表主表
- `timetable_members`：成员与角色（owner/editor/viewer）
- `events`：课程/活动明细（day/start/end/title/source）

## 5) 安全说明

- Gemini Key 只在 Worker Secret 中保存，不出现在前端
- 前端仅使用 Supabase Anon Key（配合 RLS 控制权限）
- RLS 已按成员角色限制读写
