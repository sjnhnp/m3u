// Cloudflare Pages Function (Node.js runtime)
// Handles GET requests to /api/fetch-m3u?url=<encoded_m3u_url>

/**
 * Fetches the M3U content from the target URL acting as a proxy.
 * IMPORTANT: This function runs on Cloudflare's edge, bypassing browser CORS restrictions
 *            for the M3U file download itself. It DOES NOT proxy the video stream segments.
 */
export async function onRequestGet(context) {
  // context includes: request, env, params, waitUntil, next, data
  const { request } = context;
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');

  // 1. Validate Input
  if (!targetUrl) {
    return new Response('错误：缺少 "url" 查询参数', {
      status: 400,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  let decodedTargetUrl;
  try {
    decodedTargetUrl = decodeURIComponent(targetUrl);
    // Basic check if it looks like a URL
    new URL(decodedTargetUrl);
  } catch (e) {
    return new Response('错误：无效的 "url" 参数格式', {
      status: 400,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  // 2. Fetch M3U Content from Origin
  try {
    // Use Cloudflare's fetch. Add a User-Agent, some servers might require it.
    const response = await fetch(decodedTargetUrl, {
      method: 'GET',
      headers: {
        // You might need to customize or remove the User-Agent depending on the M3U source
        'User-Agent': 'CloudflarePagesM3UProxy/1.0 (+https://your-deployed-page-url.pages.dev)',
        'Accept': '*/*' // Be liberal in what we accept
      },
      // Consider redirect handling if needed by the source
      // redirect: 'follow'
    });

    // Check if the fetch was successful
    if (!response.ok) {
      console.error(`Proxy Fetch Error: Failed to fetch ${decodedTargetUrl} - Status: ${response.status} ${response.statusText}`);
      // Return the origin server's error status and message if possible
       return new Response(`获取源 M3U 文件失败: ${response.status} ${response.statusText}`, {
           status: response.status, // Relay the original status code
           headers: {
               'Content-Type': 'text/plain; charset=utf-8',
               // Important: Add CORS headers even for error responses if the browser needs to read the body
               'Access-Control-Allow-Origin': '*',
            },
        });
    }

    // Get the response body as text
    const body = await response.text();

    // 3. Return Response to Client (Browser)
    // CRITICAL: Set CORS headers so the JavaScript running in the browser can access this response.
    const headers = new Headers({
      // Set appropriate Content-Type. 'application/vnd.apple.mpegurl' is common, but text/plain might be safer
      // Or try to sniff from the original response: response.headers.get('Content-Type') || 'text/plain; charset=utf-8'
      'Content-Type': response.headers.get('Content-Type') || 'application/vnd.apple.mpegurl; charset=utf-8',
      'Access-Control-Allow-Origin': '*', // Allow requests from any origin (your Cloudflare Pages site)
      'Access-Control-Allow-Methods': 'GET, OPTIONS', // Specify allowed methods
      'Access-Control-Allow-Headers': 'Content-Type', // Specify allowed headers
      // Optionally add Cache-Control if you want browsers/CF to cache the function's response
      // 'Cache-Control': 'public, max-age=300' // Cache for 5 minutes
    });

    return new Response(body, { status: 200, headers: headers });

  } catch (error) {
    console.error(`Proxy Exception: Error fetching M3U for ${decodedTargetUrl}:`, error);
    // Don't expose detailed internal errors to the client
    return new Response(`代理函数内部错误: ${error.message}`, {
      status: 500, // Internal Server Error
      headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Access-Control-Allow-Origin': '*', // CORS headers for errors too
      },
    });
  }
}

/**
 * Handles CORS preflight requests (OPTIONS method).
 * Browsers send an OPTIONS request before the actual GET request
 * to check if the server allows the cross-origin request.
 */
export async function onRequestOptions(context) {
    // Define allowed origins, methods, headers for CORS preflight response
    const headers = new Headers({
        'Access-Control-Allow-Origin': '*', // Or specify your Pages domain for tighter security
        'Access-Control-Allow-Methods': 'GET, OPTIONS', // Must include methods used in `onRequestGet` and OPTIONS itself
        'Access-Control-Allow-Headers': 'Content-Type', // List headers the client might send
        'Access-Control-Max-Age': '86400', // Cache preflight response for 1 day (in seconds)
    });

    // Return a 204 No Content response for OPTIONS requests
    return new Response(null, {
        status: 204,
        headers: headers,
    });
}
