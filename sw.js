/* sw.js — 卡面图片的持久缓存（Service Worker）。
 *
 * 为什么需要它：站点发布在 GitHub Pages 上，而 **Pages 不允许自定义响应头**
 *（`_headers` 文件在 Pages 上无效）。它给图片的是 `Cache-Control: max-age=600` ——
 * 10 分钟就过期，之后每次打开都要重新校验/下载。整套资源 12.5 MB（126 张卡面
 * 10.7 MB + 8 张横幅 1.3 MB），所以「每次打开都重新加载」是真实存在的。
 *
 * Service Worker 是 Pages 上唯一能自己说了算的缓存层，于是：
 *   · 命中缓存就直接返回，一个字节都不下载
 *   · 页面上有「加载图片」（一键）/「强制重新下载」/「清理缓存」（见 page.js）
 *   · `cache: 'reload'` 的请求**跳过读缓存**，但仍然把新响应写回去 ——
 *     不认这个标记的话，页面上那个「强制重新下载」按钮就是假的。
 *
 * ---------------------------------------------------------------------------
 * 三条安全约束（这个文件碰错一点就会变成「页面永远不更新」的经典事故）
 * ---------------------------------------------------------------------------
 * 1. **只拦内容寻址的图片**：同源的 `/assets/img/<名字>.<内容哈希>.<ext>`，
 *    以及**镜像站**上的同名路径（见 MIRROR_HOST）。名字里带内容哈希，所以
 *    内容一变 URL 就变 —— 缓存永远不会发出旧图。
 * 2. **绝不缓存 HTML / JS / CSS**。那些一旦进缓存，页面更新就发不出去，
 *    而且用户自己也不知道为什么「我改了但线上没变」。
 *    其余请求一律 `return`（不调用 respondWith），完全交给浏览器与网络。
 *    镜像站也守这一条：路径不以 `/assets/img/` 结尾的，一律放行。
 * 3. **失败要说出来**：离线且没缓存时回 504 加一句人话，
 *    而不是假装成功返回空内容（那会变成一张碎图，看不出原因）。
 *
 * 动态站（本机 DSH）不受影响：它的图片走 `api/image?src=...`，路径不在
 * `/assets/img/` 下，所以这里整段都会被跳过 —— 而且那条路由本来就已经带了
 * 长缓存头（派生图是 `private, max-age=604800`）。
 *
 * 跨域镜像（Gitee / raw.githubusercontent.com）返回的是 **opaque** 响应：
 * 读不到状态码与内容，但可以原样存进 Cache Storage、之后原样喂给 `<img>`。
 * 这就是「国内走镜像」与「一次抓好、之后离线可见」能同时成立的原因
 *（页面那一侧见 page.js 的 mirrorAssetUrls / isCrossOrigin / onImageError）。
 */

const CACHE_NAME = 'gacha-img-v2'

/** 只有内容寻址的卡面/横幅会进缓存。改这个正则前先读上面第 1、2 条。 */
const CACHEABLE = /\/assets\/img\/[^/]+$/

/**
 * 允许缓存的镜像主机（只有图片镜像该在这里）。
 *
 * ⚠️ 别把「任何跨域图片」都收进来：opaque 响应既读不到内容也读不到状态码，
 * 把别处的图缓存下来，一旦那边换了内容我们会永远发旧的 —— 而且名字里没有内容
 * 哈希，没有任何东西能发现这件事。这里的几个主机都是**图片 CDN / 代码托管**，
 * 而下面还会再用 `CACHEABLE` 卡住路径，只认 `/assets/img/` 结尾的地址。
 */
const MIRROR_HOST = /(^|\.)gitee\.com$|(^|\.)giteeusercontent\.com$|(^|\.)githubusercontent\.com$|(^|\.)jsdelivr\.net$/

/** 上限，超过就删最早的一批（Cache Storage 的 keys() 按插入顺序） */
const MAX_ENTRIES = 400

self.addEventListener('install', () => {
  // 新版本立刻接替，不等旧标签页关闭 —— 否则用户要开两次才生效
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 清掉本 SW 历史版本留下的缓存（名字前缀相同、版本不同）
      const names = await caches.keys()
      await Promise.all(
        names
          .filter((n) => n.indexOf('gacha-img-') === 0 && n !== CACHE_NAME)
          .map((n) => caches.delete(n)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  let url
  try {
    url = new URL(req.url)
  } catch (e) {
    return
  }
  // 同源的内容寻址图片，或者**镜像站上**的同名图片。
  // 其余跨域请求一律不碰（见 MIRROR_HOST 的说明）。
  const sameOriginAsset = url.origin === self.location.origin && CACHEABLE.test(url.pathname)
  const mirrorAsset = MIRROR_HOST.test(url.hostname) && CACHEABLE.test(url.pathname)
  if (!sameOriginAsset && !mirrorAsset) return
  event.respondWith(cacheFirst(req))
})

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME)
  // 「强制重新下载」：页面用 fetch(url, { cache: 'reload' }) 发请求。
  // 不认这个标记的话，我们会照样拿旧缓存回话 —— 那个按钮就只是**看着**在干活。
  // 注意只跳过「读」，抓回来的新响应仍然要写进缓存。
  const force = req.cache === 'reload' || req.cache === 'no-cache'
  // ignoreSearch：万一以后带上 ?v=... 也能命中同一张
  const hit = force ? null : await cache.match(req, { ignoreSearch: true })
  if (hit) return hit
  try {
    // req 自带 cache 模式，所以 fetch(req) 本身就会绕过 HTTP 缓存
    const res = await fetch(req)
    // 可缓存 = 同源 200（basic）或 CORS 200，**或者跨域镜像的 opaque 响应**。
    // opaque 读不到状态码，但 Cache Storage 允许原样存下来、之后原样喂给 <img>；
    // 不认它的话，镜像的图每次打开都要重新下载（缓存层等于不存在）。
    const cacheable = res && ((res.ok && (res.type === 'basic' || res.type === 'cors')) || res.type === 'opaque')
    if (cacheable) {
      await trimCache(cache)
      // 用 url.pathname 而不是 req 当钥匙：force 请求的 cache 模式是 reload，
      // 直接 put(req) 有被规范挡掉的风险，而钥匙本来就该是「干净的地址」。
      // 图片是内容寻址的（名字里带内容哈希），不带查询串，所以丢掉 search 无损。
      await cache.put(urlOf(req), res.clone())
    }
    return res
  } catch (err) {
    // 绝不假装成功：说清是「离线且没缓存」
    return new Response('图片取不到：离线，而且这张没有缓存过', {
      status: 504,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
}

/** 缓存钥匙：绝对 URL，且不带查询串（与服务端下发的 src 一一对应） */
function urlOf(req) {
  const u = new URL(req.url)
  return u.origin + u.pathname
}

async function trimCache(cache) {
  const keys = await cache.keys()
  if (keys.length < MAX_ENTRIES) return
  const drop = keys.length - MAX_ENTRIES + 1
  for (let i = 0; i < drop; i++) await cache.delete(keys[i])
}
