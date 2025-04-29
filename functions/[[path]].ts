/* functions/[[path]].ts
   拦截 /api/**   /proxy/**   其它全部交给静态资源层
   依赖 KV Namespace：PLAYLIST_KV
------------------------------------------------------ */
import { Hono } from 'hono'

/* ---------- 绑定类型 ---------- */
type Env = {
  PLAYLIST_KV: KVNamespace
}

/* ---------- Hono 实例 ---------- */
const app = new Hono<{ Bindings: Env }>()

/* ---------- 工具 ---------- */
const uuid = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // 旧 runtime 兼容（几乎用不到，但以防万一）
  const a = [...crypto.getRandomValues(new Uint8Array(16))]
  return a.map((b, i) =>
      ((i === 6 ? (b & 0x0f) | 0x40 : i === 8 ? (b & 0x3f) | 0x80 : b)
        ).toString(16).padStart(2, '0')
    ).join('')
}

/* 解析外部 m3u 文本为频道数组 */
async function parseM3u(text: string) {
  const lines = text.split(/\r?\n/)
  const list: { name: string; url: string }[] = []
  let cur = ''
  for (const l of lines) {
    if (l.startsWith('#EXTINF')) cur = l.split(',').pop() || 'unknown'
    else if (l && !l.startsWith('#')) list.push({ name: cur || 'unknown', url: l.trim() })
  }
  return list
}

/* 把 m3u8 里的 URI 改写成 /proxy/http(s)/… */
function rewriteM3U8(content: string, base: string, origin: string) {
  return content.replace(
    /(#EXT-X-KEY.*?URI=")([^"]+)(")|(^(?!#)(.+)$)/gm,
    (_m, p1, uriInKey, p3, _p4, urlLine) => {
      const raw = uriInKey || urlLine
      if (!raw) return _m

      let abs = ''
      try {
        abs = raw.match(/^https?:\/\//) ? raw
             : new URL(raw, new URL(base, 'http://d/')).toString() // base 必须是目录
      } catch { return _m }

      const proto = abs.startsWith('https') ? 'https' : 'http'
      const proxied = `${origin}/proxy/${proto}/${abs.replace(/^https?:\/\//, '')}`
      return uriInKey ? `${p1}${proxied}${p3}` : proxied
    }
  )
}

/* ======================================================
   一、/api/playlist* 订阅管理
====================================================== */
// POST /api/playlist   body: { url, name? }
app.post('/api/playlist', async c => {
  const body = await c.req.json<{ url?: string; name?: string }>()
                      .catch(() => ({}))
  if (!body.url) return c.text('url missing', 400)

  /* 抓取并解析 M3U */
  let channels: { name: string; url: string }[]
  try {
    const res = await fetch(body.url)
    if (!res.ok) throw new Error(`fetch ${res.status}`)
    channels = await parseM3u(await res.text())
  } catch (e: any) {
    return c.text(`拉取或解析失败：${e.message || e}`, 400)
  }

  const id = uuid()
  await c.env.PLAYLIST_KV.put(`playlist:${id}`, JSON.stringify(channels))

  /* 更新总列表（只保存 id / name / count） */
  const raw = await c.env.PLAYLIST_KV.get('playlists')
  const list = raw ? JSON.parse(raw) : []
  list.push({ id, name: body.name || body.url, count: channels.length })
  await c.env.PLAYLIST_KV.put('playlists', JSON.stringify(list))

  return c.json({ id }, 201)
})

app.get('/api/playlist', async c => {
  const raw = await c.env.PLAYLIST_KV.get('playlists')
  return c.json(raw ? JSON.parse(raw) : [])
})

app.get('/api/playlist/:id', async c => {
  const raw = await c.env.PLAYLIST_KV.get(`playlist:${c.req.param('id')}`)
  if (!raw) return c.text('not found', 404)
  return c.json(JSON.parse(raw))
})

/* ======================================================
   二、/proxy/http(s)/** 通用反向代理
====================================================== */
app.get('/proxy/:scheme{http|https}/:rest{.*}', async c => {
  const scheme = c.req.param('scheme')  // http 或 https
  let rest = c.req.param('rest')        // host/path
  const urlObj = new URL(c.req.url)
  // 带查询串时，Hono 已经包含到 urlObj.search 里，需要补回
  if (urlObj.search) rest += urlObj.search
  const target = `${scheme}://${rest}`

  /* 透传部分请求头（Range/UA/Referer） */
const fwdHeaders = new Headers()
;['range', 'user-agent', 'referer'].forEach(k => {
  const v = c.req.header(k)
  if (v) fwdHeaders.set(k, v)
})
  fwdHeaders.set('host', new URL(target).host)

  let upstream: Response
  try {
    upstream = await fetch(target, { headers: fwdHeaders, redirect: 'follow' })
  } catch (e: any) {
    return c.text(`upstream fetch error: ${e.message || e}`, 502)
  }
  if (!upstream.ok && upstream.status !== 206) {
    // HLS 分段 206 也算成功
    return c.text(`upstream status ${upstream.status}`, upstream.status)
  }

  /* 改写 m3u8 内容中的 URL */
  const ct = upstream.headers.get('content-type') || ''
  let body: BodyInit | null = upstream.body
  if (/mpegurl/i.test(ct)) {
    const text = await upstream.text()
    const baseDir = target.substring(0, target.lastIndexOf('/') + 1)
    body = rewriteM3U8(text, baseDir, urlObj.origin)
  }

  /* 复制响应头 + 加 CORS */
  const respHeaders = new Headers(upstream.headers)
  respHeaders.set('access-control-allow-origin', '*')
  respHeaders.set('access-control-expose-headers', '*') // 方便 HLS.js 读取 Range/Length
  respHeaders.delete('content-length') // 避免 m3u8 改写后长度不符

  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders
  })
})

/* ======================================================
   三、导出给 Cloudflare Pages
====================================================== */
export const onRequest: PagesFunction<Env> = async ctx => {
  const { pathname } = new URL(ctx.request.url)

  // 动态请求（API、代理）交给 Hono
  if (pathname.startsWith('/api/') || pathname.startsWith('/proxy/')) {
    return app.fetch(ctx.request, ctx.env, ctx)
  }

  // 其它静态路径交回 Pages 静态资源层
  return ctx.next()
}
