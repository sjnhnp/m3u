/* functions/index.ts */
import { Hono } from 'hono'

type Env = {
  PLAYLIST_KV: KVNamespace
}

const app = new Hono<{ Bindings: Env }>()

/* ---------- 工具 ---------- */
const uuid = () => crypto.randomUUID() // 确保你的环境支持这个

// 解析外部 M3U 订阅为频道数组
async function parseM3u(text: string) {
  const lines = text.split(/\r?\n/)
  const list: { name: string; url: string }[] = []
  let cur = ''
  for (const l of lines) {
    if (l.startsWith('#EXTINF')) cur = l.split(',').pop() || 'unknown' // 给个默认名
    else if (l && !l.startsWith('#')) list.push({ name: cur || 'unknown', url: l.trim() }) // 如果没有 #EXTINF，也给个默认名
  }
  return list
}

// 把 m3u8 内容中的 URL 改写成继续走 /proxy/...
function rewriteM3U8(content: string, base: string, origin: string) {
  // 正则表达式改进：更准确地匹配 URI 和独立行 URL
  return content.replace(/(#EXT-X-KEY.*?URI=")([^"]+)(")|(^(?!#)(.+)$)/gm, (match, keyPrefix, uriInKey, keySuffix, linePrefix, urlInLine) => {
    const rawUrl = uriInKey || urlInLine;
    if (!rawUrl) return match; // 如果没匹配到 URL，返回原始行

    let absoluteUrl;
    try {
      // 处理绝对和相对路径
      if (rawUrl.match(/^https?:\/\//)) {
        absoluteUrl = rawUrl; // 已经是绝对 URL
      } else if (base) {
         // 尝试基于 base URL 解析相对路径
         // base 需要是 M3U8 文件所在的目录 URL，确保以 / 结尾
         const baseObj = new URL(base.endsWith('/') ? base : base + '/');
         absoluteUrl = new URL(rawUrl, baseObj).toString();
      } else {
         console.error("Cannot resolve relative URL without base:", rawUrl);
         return match; // 无法解析，返回原始行
      }
    } catch (e) {
       console.error("Error parsing or resolving URL:", rawUrl, base, e);
       return match; // URL 解析错误，返回原始行
    }


    const proto = absoluteUrl.startsWith('https://') ? 'https' : 'http';
    const proxiedUrl = `${origin}/proxy/${proto}/${absoluteUrl.replace(/^https?:\/\//, '')}`;

    if (uriInKey) {
      // 如果是 #EXT-X-KEY 中的 URI
      return `${keyPrefix}${proxiedUrl}${keySuffix}`;
    } else {
      // 如果是独立的 URL 行
      return proxiedUrl;
    }
  });
}


/* ---------- API：订阅管理 ---------- */
// 新增订阅
app.post('/api/playlist', async c => {
  const body = await c.req.json<{ url: string; name?: string }>().catch(() => ({ url: '' })); // 提供默认值避免 null
  if (!body.url) return c.text('url missing', 400);

  let channels: { name: string; url: string }[] = [];
  try {
      const res = await fetch(body.url);
      if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
      const text = await res.text();
      channels = await parseM3u(text); // **核心：解析 M3U**
      if (channels.length === 0) {
          console.warn("Parsed 0 channels from:", body.url);
          // 可以选择返回错误或继续（允许空列表）
          // return c.text('No channels found in M3U', 400);
      }
  } catch (e) {
      console.error("Failed to fetch or parse M3U:", body.url, e);
      return c.text(`源拉取或解析失败: ${e instanceof Error ? e.message : String(e)}`, 400);
  }


  const id = uuid();
  // **核心：存储解析后的频道列表**
  await c.env.PLAYLIST_KV.put(`playlist:${id}`, JSON.stringify(channels));

  const listRaw = await c.env.PLAYLIST_KV.get('playlists');
  const list = listRaw ? JSON.parse(listRaw) : [];
  // **核心：存储频道数量 count**
  list.push({ id, name: body.name || body.url, count: channels.length });
  await c.env.PLAYLIST_KV.put('playlists', JSON.stringify(list));

  return c.json({ id });
});


// 获取全部订阅
app.get('/api/playlist', async c => {
  const listRaw = await c.env.PLAYLIST_KV.get('playlists');
  return c.json(listRaw ? JSON.parse(listRaw) : []); // 返回存储的列表
});


// 获取单个订阅内的频道
app.get('/api/playlist/:id', async c => {
  const id = c.req.param('id');
  const data = await c.env.PLAYLIST_KV.get(`playlist:${id}`); // 获取存储的频道列表
  if (!data) return c.text('not found', 404);
  try {
      return c.json(JSON.parse(data)); // 返回解析后的 JSON 数组
  } catch (e) {
      console.error("Failed to parse KV data for playlist:", id, e);
      return c.text('Internal error: Invalid data in KV', 500);
  }
});


/* ---------- 通用代理 ---------- */
// 任何 /proxy/http/… 或 /proxy/https/… 请求都会走到这里
app.get('/proxy/:proto{http|https}/:rest{.*}', async c => {
  const { proto, rest } = c.req.param();
  let target = `${proto}://${rest}`;

  // 如果 URL 包含查询参数，Hono 路由可能会错误分割，尝试复原
  const originalUrl = new URL(c.req.url);
  if (originalUrl.search) {
      // 尝试从原始请求 URL 中提取完整的 rest 部分，包括查询参数
      const pathParts = originalUrl.pathname.split('/');
      // 假设路径是 /proxy/http/host/path?query=val
      // 则 pathParts 是 ['', 'proxy', 'http', 'host', 'path']
      if (pathParts.length >= 4) {
          const potentialRest = pathParts.slice(3).join('/'); // 'host/path'
          target = `${proto}://${potentialRest}${originalUrl.search}`;
      }
  }


  console.log(`Proxying: ${target}`);

  // 透传客户端请求头里与播放相关的一些字段
  const headers = new Headers();
  // 从原始请求复制 Range, User-Agent, Referer (如果存在)
  const range = c.req.header('Range');
  const ua = c.req.header('User-Agent');
  const referer = c.req.header('Referer');
  if (range) headers.set('Range', range);
  if (ua) headers.set('User-Agent', ua);
  if (referer) headers.set('Referer', referer);

  // 注意：不可直接透传 Host，改用目标的 host
  try {
      headers.set('Host', new URL(target).host);
  } catch (e) {
      console.error("Invalid target URL for Host header:", target, e);
      return c.text('Invalid target URL', 400);
  }

  let upstreamResponse: Response | null = null;
  try {
      upstreamResponse = await fetch(target, {
          method: 'GET',
          headers: headers, // 使用上面构造的请求头
          redirect: 'follow', // 允许 fetch 跟随重定向
          cf: { cacheTtl: 0, cacheEverything: false } // Cloudflare 特有配置，禁用缓存
      });
  } catch (e) {
      console.error(`Upstream fetch error for ${target}:`, e);
      return c.text(`Upstream fetch error: ${e instanceof Error ? e.message : String(e)}`, 502); // 502 Bad Gateway
  }


  if (!upstreamResponse || !upstreamResponse.ok) {
      console.error(`Upstream error for ${target}: Status ${upstreamResponse?.status}`);
      return c.text(`Upstream error: Status ${upstreamResponse?.status}`, upstreamResponse?.status || 502);
  }

  // 复制上游响应头，并添加 CORS
  const respHeaders = new Headers(upstreamResponse.headers);
  respHeaders.set('Access-Control-Allow-Origin', '*'); // 允许任何来源访问
  respHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  respHeaders.set('Access-Control-Allow-Headers', 'Range, User-Agent, Referer'); // 允许这些请求头
  respHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type'); // 允许前端读取这些响应头

  const contentType = respHeaders.get('content-type') || '';
  let responseBody: BodyInit | ReadableStream | null = upstreamResponse.body;

  // 如果是 m3u8，需要把里面的 URL 也改写成 proxy
  if (contentType.includes('mpegurl') || contentType.includes('x-mpegurl')) {
      try {
        const originalText = await upstreamResponse.text();
        // 确定 base URL，用于解析相对路径。应该是 M3U8 文件自身的 URL 目录。
        const baseUrl = target.substring(0, target.lastIndexOf('/') + 1);
        const origin = new URL(c.req.url).origin; // Cloudflare Worker 的 origin

        responseBody = rewriteM3U8(originalText, baseUrl, origin);
        respHeaders.delete('content-length'); // 内容已改变，删除旧的长度
      } catch (e) {
         console.error("Error reading or rewriting M3U8 body:", e);
         // 如果读取或重写失败，可以考虑返回原始 body 或错误
         // 这里选择返回原始 body，但可能导致播放失败
         responseBody = upstreamResponse.body;
      }
  }

  // 返回最终响应给浏览器
  return new Response(responseBody, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: respHeaders
  });
});

// ---- 旧的导出方式 ----
// export const onRequest = app.handle

// ---- 修改为适配 Pages Functions 的导出方式 ----
// 这个函数会接收 Pages 的上下文
// ---- 正确的适配 Pages Functions 的导出方式 ----
export const onRequest: PagesFunction<Env> = async (context) => {
  const { pathname } = new URL(context.request.url);

  // 检查是否是 API 或代理请求
  if (pathname.startsWith('/api/') || pathname.startsWith('/proxy/')) {
    // 将这些动态请求传递给 Hono 实例处理
    console.log(`Routing dynamic request to Hono: ${pathname}`); // 调试日志
    return app.fetch(context.request, context.env, context);
  }

  // 如果不是 API 或代理请求，则交还给 Pages 处理静态文件
  console.log(`Passing request to Pages static handler: ${pathname}`); // 调试日志
  return context.next();
};

// 确保 Hono 实例 app 的定义在这之前
// const app = new Hono<{ Bindings: Env }>()
// ... app.get / app.post / app.get proxy 定义 ...
