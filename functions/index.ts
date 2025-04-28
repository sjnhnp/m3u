// functions/index.ts
//------------------------------------------------------------
// 依赖
//------------------------------------------------------------
import { Hono } from 'hono'
import { handle } from 'hono/cloudflare-pages'

//------------------------------------------------------------
// 通用工具
//------------------------------------------------------------
// 兼容旧运行时没有 crypto.randomUUID 的情况
const uuid = (): string => {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // fallback – RFC‑4122 v4
  const a = [...crypto.getRandomValues(new Uint8Array(16))]
  return a
    .map((b, i) =>
      (
        i === 6 ? (b & 0x0f) | 0x40 : // version 4
        i === 8 ? (b & 0x3f) | 0x80 : b
      )
        .toString(16)
        .padStart(2, '0')
    )
    .join('')
}

//------------------------------------------------------------
// Hono app
//------------------------------------------------------------
type Bindings = {
  PLAYLIST_KV: KVNamespace
}

const app = new Hono<{ Bindings: Bindings }>()

//------------------------------------------------------------
// 路由
//------------------------------------------------------------

// ── 首页 ────────────────────────────────────────────────
// app.get('/', c => c.text('👍 Hono + Cloudflare Pages 正常运行！'))

// ── 读取全部订阅 (GET /api/playlists) ─────────────────────
app.get('/api/playlists', async c => {
  const raw = await c.env.PLAYLIST_KV.get('playlists')
  const list = raw ? JSON.parse(raw) : []
  return c.json(list)
})

// ── 新增订阅 (POST /api/playlists) ───────────────────────
//  body: { name: string, url: string }
app.post('/api/playlists', async c => {
  let body: { name?: string; url?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.text('invalid json', 400)
  }
  if (!body?.name || !body?.url) return c.text('name & url required', 400)

  // 生成 id 并写 KV
  const id = uuid()
  const playlistKey = `playlist:${id}`
  await c.env.PLAYLIST_KV.put(playlistKey, JSON.stringify(body))

  // 更新列表
  const rawList = await c.env.PLAYLIST_KV.get('playlists')
  const list = rawList ? JSON.parse(rawList) : []
  list.push({ id, name: body.name })
  await c.env.PLAYLIST_KV.put('playlists', JSON.stringify(list))

  return c.json({ id }, 201)
})

// ── 获取单个订阅 (GET /api/playlists/:id) ────────────────
app.get('/api/playlists/:id', async c => {
  const id = c.req.param('id')
  const raw = await c.env.PLAYLIST_KV.get(`playlist:${id}`)
  if (!raw) return c.text('not found', 404)
  return c.json(JSON.parse(raw))
})

//------------------------------------------------------------
// 正确导出：**必须是函数**
//------------------------------------------------------------
export const onRequest = handle(app)
