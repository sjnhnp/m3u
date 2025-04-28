/* functions/index.ts */
import { Hono } from 'hono'

type Env = {
  PLAYLIST_KV: KVNamespace
}

const app = new Hono<{ Bindings: Env }>()

/* ---------- 工具 ---------- */
const uuid = () => crypto.randomUUID()

// 解析外部 M3U 订阅为频道数组
async function parseM3u(text: string) {
  const lines = text.split(/\r?\n/)
  const list: { name: string; url: string }[] = []
  let cur = ''
  for (const l of lines) {
    if (l.startsWith('#EXTINF')) cur = l.split(',').pop() || ''
    else if (l && !l.startsWith('#')) list.push({ name: cur, url: l.trim() })
  }
  return list
}

// 把 m3u8 内容中的 URL 改写成继续走 /proxy/...
function rewriteM3U8(content: string, base: string, origin: string) {
  return content.replace(/(#EXT-X-KEY[^]*?URI="([^"]+)"[^]*?)|^(?!#)(.+)$/gm, (_, keyLine, uriInKey, normalLine) => {
    const raw = uriInKey || normalLine
    if (!raw) return _
    const absolute = raw.match(/^https?:\/\//)
      ? raw                               // 原本就是绝对
      : new URL(raw, base).toString()     // 相对 → 绝对

    const proto = absolute.startsWith('https://') ? 'https' : 'http'
    const proxied = `${origin}/proxy/${proto}/${absolute.replace(/^https?:\/\//, '')}`
    if (uriInKey) return keyLine.replace(uriInKey, proxied) // key 行
    return proxied                                           // 普通行
  })
}

/* ---------- API：订阅管理 ---------- */
// 新增订阅
app.post('/api/playlist', async c => {
  const body = await c.req.json<{ url: string; name?: string }>().catch(() => ({}))
  if (!body.url) return c.text('url missing', 400)

  const res = await fetch(body.url)
  if (!res.ok) return c.text('源拉取失败', 400)

  const channels = await parseM3u(await res.text())
  const id = uuid()

  await c.env.PLAYLIST_KV.put(`playlist:${id}`, JSON.stringify(channels))
  const list = JSON.parse((await c.env.PLAYLIST_KV.get('playlists')) || '[]')
  list.push({ id, name: body.name || body.url, count: channels.length })
  await c.env.PLAYLIST_KV.put('playlists', JSON.stringify(list))

  return c.json({ id })
})

// 获取全部订阅
app.get('/api/playlist', async c => {
  return c.json(JSON.parse((await c.env.PLAYLIST_KV.get('playlists')) || '[]'))
})

// 获取单个订阅内的频道
app.get('/api/playlist/:id', async c => {
  const data = await c.env.PLAYLIST_KV.get(`playlist:${c.req.param('id')}`)
  if (!data) return c.text('not found', 404)
  return c.json(JSON.parse(data))
})

/* ---------- 通用代理 ---------- */
// 任何 /proxy/http/… 或 /proxy/https/… 请求都会走到这里
app.get('/proxy/:proto{http|https}/:rest{.*}', async c => {
  const target = `${c.req.param('proto')}://${c.req.param('rest')}`

  // 透传客户端请求头里与播放相关的一些字段
  const headers = new Headers()
  for (const k of ['Range', 'User-Agent', 'Referer']) {
    const v = c.req.header(k)
    if (v) headers.set(k, v)
  }
  // 注意：不可直接透传 Host，改用目标的 host
  headers.set('Host', new URL(target).host)

  const upstream = await fetch(target, {
    method: 'GET',
    headers,
    cf: { cacheTtl: 0, cacheEverything: false }
  }).catch(() => null)

  if (!upstream || !upstream.ok)
    return c.text('upstream error', 502)

  const respHeaders = new Headers(upstream.headers)
  respHeaders.set('Access-Control-Allow-Origin', '*')
  respHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type')

  const ct = respHeaders.get('content-type') || ''
  let body: BodyInit | ReadableStream = upstream.body!

  // 如果是 m3u8，需要把里面的 URL 也改写成 proxy
  if (ct.includes('mpegurl')) {
    const text = await upstream.text()
    const base = target.slice(0, target.lastIndexOf('/') + 1)
    body = rewriteM3U8(text, base, new URL(c.req.url).origin)
    respHeaders.delete('content-length') // 长度已变
  }

  return new Response(body, { status: upstream.status, headers: respHeaders })
})

export const onRequest = app.handle   // Pages Functions / Workers 入口
