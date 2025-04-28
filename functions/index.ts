// functions/index.ts
//------------------------------------------------------------
import { Hono } from 'hono'

//------------------------------------------------------------
// 兼容旧运行时没有 crypto.randomUUID
//------------------------------------------------------------
const uuid = (): string => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const a = [...crypto.getRandomValues(new Uint8Array(16))]
  return a
    .map((b, i) =>
      (
        i === 6 ? (b & 0x0f) | 0x40 :            // version 4
        i === 8 ? (b & 0x3f) | 0x80 : b          // variant
      )
        .toString(16)
        .padStart(2, '0')
    )
    .join('')
}

//------------------------------------------------------------
// Hono 实例 & 路由（统一用 /api/playlist… 单数）
//------------------------------------------------------------
type Bindings = { PLAYLIST_KV: KVNamespace }
const app = new Hono<{ Bindings: Bindings }>()

// GET /api/playlist        → 列表
app.get('/api/playlist', async c => {
  const raw = await c.env.PLAYLIST_KV.get('playlists')
  return c.json(raw ? JSON.parse(raw) : [])
})

// POST /api/playlist       → 新增
// body: { name?: string, url: string }
app.post('/api/playlist', async c => {
  const body = await c.req.json<{ name?: string; url?: string }>().catch(() => null)
  if (!body?.url) return c.text('url required', 400)
  const name = body.name || body.url

  const id = uuid()
  await c.env.PLAYLIST_KV.put(`playlist:${id}`, JSON.stringify(body))

  const listRaw = await c.env.PLAYLIST_KV.get('playlists')
  const list = listRaw ? JSON.parse(listRaw) : []
  list.push({ id, name })
  await c.env.PLAYLIST_KV.put('playlists', JSON.stringify(list))

  return c.json({ id }, 201)
})

// GET /api/playlist/:id    → 取单条
app.get('/api/playlist/:id', async c => {
  const raw = await c.env.PLAYLIST_KV.get(`playlist:${c.req.param('id')}`)
  if (!raw) return c.text('not found', 404)
  return c.json(JSON.parse(raw))
})

//------------------------------------------------------------
// 只让 /api/… 走 Hono；其它请求交给静态资源 (ctx.next())
//------------------------------------------------------------
export const onRequest: PagesFunction<Bindings> = async ctx => {
  const { pathname } = new URL(ctx.request.url)

  // API 前缀可自行改，例如 '/api/' '/proxy/' 等
  if (pathname.startsWith('/api/')) {
    return app.fetch(ctx.request, ctx.env, ctx)
  }

  // 其余路径交还给 Cloudflare Pages 静态资源层
  return ctx.next()
}
