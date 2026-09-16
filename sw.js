/* sw.js — 卡面图片的持久缓存（Service Worker）。
 *
 * 为什么需要它：站点发布在 GitHub Pages 上，而 **Pages 不允许自定义响应头**
 *（`_headers` 文件在 Pages 上无效）。它给图片的是 `Cache-Control: max-age=600` ——
 * 10 分钟就过期，之后每次打开都要重新校验/下载。整套资源 12.5 MB（126 张卡面
 * 10.7 MB + 8 张横幅 1.3 MB），所以「每次打开都重新加载」是真实存在的。
 *
 * Service Worker 是 Pages 上唯一能自己说了算的缓存层，于是：
 *   · 命中缓存就直接返回，一个字节都不下载
 *   · 页面上有「缓存全部图片」与「清理缓存」两个按钮（见 page.js）
 *
 * ---------------------------------------------------------------------------
 * 三条安全约束（这个文件碰错一点就会变成「页面永远不更新」的经典事故）
 * ---------------------------------------------------------------------------
 * 1. **只拦内容寻址的图片**：`/assets/img/<名字>.<内容哈希>.<ext>`。
 *    名字里带内容哈希，所以内容一变 URL 就变 —— 缓存永远不会发出旧图。
 * 2. **绝不缓存 HTML / JS / CSS**。那些一旦进缓存，页面更新就发不出去，
 *    而且用户自己也不知道为什么「我改了但线上没变」。
 *    其余请求一律 `return`（不调用 respondWith），完全交给浏览器与网络。
 * 3. **失败要说出来**：离线且没缓存时回 504 加一句人话，
 *    而不是假装成功返回空内容（那会变成一张碎图，看不出原因）。
 *
 * 动态站（本机 DSH）不受影响：它的图片走 `api/image?src=...`，路径不在
 * `/assets/img/` 下，所以这里整段都会被跳过 —— 而且那条路由本来就已经带了
 * 长缓存头（派生图是 `private, max-age=604800`）。
 */

const CACHE_NAME = 'gacha-img-v1'

/** 只有内容寻址的卡面/横幅会进缓存。改这个正则前先读上面第 1、2 条。 */
const CACHEABLE = /\/assets\/img\/[^/]+$/

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
  // 跨域（例如以后放 CDN）不碰：不透明响应缓存起来只会添乱
  if (url.origin !== self.location.origin) return
  if (!CACHEABLE.test(url.pathname)) return
  event.respondWith(cacheFirst(req))
})

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME)
  // ignoreSearch：万一以后带上 ?v=... 也能命中同一张
  const hit = await cache.match(req, { ignoreSearch: true })
  if (hit) return hit
  try {
    const res = await fetch(req)
    // 只缓存「同源 + 200」的完整响应；206/opaque/错误一律不缓存
    if (res && res.ok && res.type === 'basic') {
      await trimCache(cache)
      await cache.put(req, res.clone())
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

async function trimCache(cache) {
  const keys = await cache.keys()
  if (keys.length < MAX_ENTRIES) return
  const drop = keys.length - MAX_ENTRIES + 1
  for (let i = 0; i < drop; i++) await cache.delete(keys[i])
}
