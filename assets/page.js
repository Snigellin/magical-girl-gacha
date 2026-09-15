/**
 * page.js — 魔法少女抽卡（前端全部逻辑，无构建）
 *
 * 分层（改起来才不打架）：
 *   ① 配置与常量      CFG / API / SECTIONS
 *   ② 基础设施        el() / clear() / toast() / announce()
 *   ③ 网络            request()（带超时 + 把 401/403 翻译成人话）
 *   ④ 状态与路由      state / parseRoute() / render()
 *   ⑤ 抽卡            runDraw()（判定在 draw.js，这里只管记账与呈现）
 *   ⑥ 各板块渲染      draw / pool / collection / history / admin
 *   ⑦ 卡片与详情      cardFigure() / rarityChip()
 *   ⑧ 编辑器          FIELDS 字段表 → 打开 / 保存
 *   ⑨ 启动            cacheEls() → wire() → boot()
 *
 * 两条纪律：
 *   · 派生字段（xxxUrl）由服务端算好，这里**只读不拼路径**
 *   · 任何失败都要在页面上留下可读痕迹，绝不静默吞掉
 */
;(function () {
  'use strict'

  // -------------------------------------------------------------------------
  // ① 配置与常量
  // -------------------------------------------------------------------------

  /**
   * 读运行时配置。
   *
   * ⚠️ 这个函数**绝不能碰 `state`**：它在模块顶部就被调用，而 `var state` 在它下面
   * 才声明 —— 配置缺失或 JSON 损坏时写 `state.xxx` 会抛 TypeError，把整页带崩，
   * 于是「配置坏了要留痕」这条错误路径自己先坏掉（真踩过：页面白屏且没有任何提示）。
   * 所以它只返回 { cfg, error }，由调用方去记。
   */
  function readConfig() {
    var fallback = { base: '', api: '', unlocked: false, hasKey: false, backend: false, readonly: true }
    var node = document.getElementById('gacha-config')
    if (!node) {
      return { cfg: fallback, error: '页面里没有 #gacha-config 配置块（page.html 被改坏了？）' }
    }
    try {
      var parsed = JSON.parse(node.textContent || '{}')
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { cfg: fallback, error: '#gacha-config 不是 JSON 对象' }
      }
      // 注意 Object.assign 的语义：fallback 里的默认值会被 parsed 覆盖。
      // fallback.readonly=true 只是「没有配置时的安全默认」，显式传 false 才算动态站。
      return { cfg: Object.assign(fallback, parsed), error: '' }
    } catch (err) {
      return { cfg: fallback, error: '页面配置（#gacha-config）不是合法 JSON：' + err.message }
    }
  }

  var _cfgResult = readConfig()
  var CFG = _cfgResult.cfg

  /** API 前缀：静态站没有后端，所有写操作直接落到 localStorage */
  var API = CFG.api || ''
  var BACKEND = CFG.backend !== false
  /** 静态导出站：整体隐藏编辑入口（区别于「这次没解锁」） */
  var READONLY = !!CFG.readonly

  /**
   * 动态站的配置里不该有 readonly。
   * 没有它时 fallback 的 true 不会生效（parsed 覆盖了别的键），但漏传 backend 之类的
   * 情况会让页面误判成静态站 —— 那种「看起来能用、其实编辑入口全没了」的症状极难查，
   * 所以在开发期就把可疑配置喊出来。
   */
  if (!READONLY && CFG.backend === undefined) {
    console.warn('[gacha] 配置里既没有 readonly 也没有 backend —— 页面会按动态站处理，请检查注入的配置。')
  }

  var SECTIONS = [
    { id: 'draw', label: '抽卡', hash: '#/draw' },
    { id: 'pool', label: '卡池一览', hash: '#/pool' },
    { id: 'collection', label: '图鉴', hash: '#/collection' },
    { id: 'shards', label: '碎片兑换', hash: '#/shards' },
    { id: 'history', label: '抽卡记录', hash: '#/history' },
    { id: 'admin', label: '后台管理', hash: '#/admin', needsEdit: true },
  ]

  /** localStorage 键（静态站用它承载抽卡状态） */
  var LS = {
    player: 'gacha.player.v1',
    collection: 'gacha.collection.v1',
    last: 'gacha.last.v1',
  }

  var state = {
    data: null,
    unlocked: false,
    hasKey: false,
    route: 'draw',
    routeArg: '',
    poolId: '',
    warning: '',
    /** 配置块读不出来时的原因（非空就说明页面起不来，且原因要留在标题上） */
    configBroken: '',
    /** 最近一次抽卡结果：{ results, at, poolId, dryRun } */
    last: null,
    /** 待编辑对象：{ kind:'card'|'pool', id } */
    editing: null,
    /** 本次会话的碎片兑换记录（只用于显示，不落盘） */
    shardLog: [],
    els: {},
  }

  var TERMINOLOGY = {
    top: '最高档',
  }

  // -------------------------------------------------------------------------
  // ② 基础设施
  // -------------------------------------------------------------------------

  // 配置坏了时的可见痕迹。放在「基础设施」这一段里、在 state 声明之后设置 ——
  // readConfig() 自己不能写 state（见它的注释），所以由这里落账。
  if (_cfgResult.error) {
    state.configBroken = _cfgResult.error
    document.title = '配置解析失败 — 魔法少女抽卡'
    var brokenBox = document.getElementById('view')
    if (brokenBox) {
      brokenBox.textContent = _cfgResult.error + '（这是构建/注入的问题，不是你的操作问题）'
    }
    console.error('[gacha] ' + _cfgResult.error)
  }

  /**
   * 建 DOM。
   *
   * ⚠️ 绝不通过 setAttribute 写 style：页面的 CSP 是 style-src 'self'（没有
   * unsafe-inline），`setAttribute('style', ...)` / 传 `{style: ...}` 会被浏览器
   * **静默丢掉、不报错** —— 参考实现里首页封面因此整整一版没显示出来。
   * 需要动态样式请用 CSSOM（node.style.xxx = ...，CSP 不管它）。
   */
  function el(tag, attrs, children) {
    var node = document.createElement(tag)
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue
        var v = attrs[k]
        if (v === undefined || v === null || v === false) continue
        if (k === 'style') {
          // 把静默失效变成开发期可见的错
          console.error('[gacha] 拒绝 style 属性（CSP 会静默丢掉它）：请改用 CSS 类或 CSSOM', attrs)
          continue
        }
        if (k === 'class') node.className = String(v)
        else if (k === 'text') node.textContent = String(v)
        else if (k === 'html') node.innerHTML = String(v) // 仅用于内部固定片段，绝不用于用户内容
        else if (k.indexOf('data-') === 0 || k === 'type' || k === 'value' || k === 'placeholder' || k === 'title' || k === 'href' || k === 'src' || k === 'alt' || k === 'id' || k === 'name' || k === 'rows' || k === 'loading' || k === 'aria-label' || k === 'aria-live' || k === 'autocomplete' || k === 'spellcheck' || k === 'min' || k === 'max' || k === 'step') {
          node.setAttribute(k, String(v))
        } else if (k === 'hidden') {
          if (v) node.hidden = true
        } else {
          node.setAttribute(k, String(v))
        }
      }
    }
    append(node, children)
    return node
  }

  function append(node, children) {
    if (children === undefined || children === null || children === false) return
    if (Array.isArray(children)) {
      for (var i = 0; i < children.length; i++) append(node, children[i])
      return
    }
    if (isNode(children)) {
      node.appendChild(children)
      return
    }
    // 文本一律走 textContent —— 内容里可能有角色名，防 XSS
    node.appendChild(document.createTextNode(String(children)))
  }

  /**
   * 是不是一个 DOM 节点。
   *
   * 用鸭子类型而不是 `instanceof Node`：那在真实浏览器里没问题，但在测试用的最小
   * DOM shim 上，节点是普通对象，`instanceof Node` 恒为 false —— 于是**所有子节点
   * 都被当成文本**、整棵树退化成一行字符串，页面看起来像没渲染。测试里出现这种
   * 症状时，先看这里。
   */
  function isNode(v) {
    return !!v && typeof v === 'object' && typeof v.nodeType === 'number' && typeof v.appendChild === 'function'
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild)
    return node
  }

  function announce(msg) {
    var a = state.els.announce
    if (a) a.textContent = String(msg)
  }

  var toastTimer = null
  function toast(msg, kind) {
    var t = state.els.toast
    if (!t) return
    t.textContent = String(msg)
    t.hidden = false
    t.className = 'toast' + (kind ? ' toast-' + kind : '')
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(function () {
      t.hidden = true
    }, kind === 'error' ? 6000 : 2600)
  }

  function fmt(n) {
    return String(n == null ? 0 : n)
  }

  function fmtTime(ms) {
    if (!ms) return '—'
    var d = new Date(Number(ms))
    if (isNaN(d.getTime())) return '—'
    function p(x) {
      return (x < 10 ? '0' : '') + x
    }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }

  // -------------------------------------------------------------------------
  // ③ 网络
  // -------------------------------------------------------------------------

  /**
   * 带超时的请求。把 401/403 翻译成「人能照着做」的话 ——
   * 直接把 status code 甩到界面上等于让人去猜。
   */
  function request(path, opts) {
    opts = opts || {}
    var url = API + path
    var timeoutMs = opts.timeoutMs || 15000
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
    var timer = ctrl
      ? setTimeout(function () {
          ctrl.abort()
        }, timeoutMs)
      : null

    var init = {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    }
    if (ctrl) init.signal = ctrl.signal
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body)

    return fetch(url, init)
      .then(function (res) {
        return res.text().then(function (text) {
          var json = null
          try {
            json = JSON.parse(text)
          } catch (e) {}
          if (!res.ok) {
            var msg =
              (json && json.error) ||
              (res.status === 401
                ? '请求被 DSH 的信任栅栏拦下了（可能是会话过期，刷新页面重试）'
                : res.status === 403
                ? '没有权限：这个操作需要先解锁编辑秘钥'
                : res.status === 404
                ? '接口不存在：' + path + '（插件可能没重新加载）'
                : 'HTTP ' + res.status + (text ? '：' + text.slice(0, 200) : ''))
            var err = new Error(msg)
            err.status = res.status
            err.payload = json
            throw err
          }
          return json === null ? { ok: true, raw: text } : json
        })
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') {
          throw new Error('请求超时（' + Math.round(timeoutMs / 1000) + 's）：' + path)
        }
        throw err
      })
      .then(function (v) {
        if (timer) clearTimeout(timer)
        return v
      })
      .catch(function (err) {
        if (timer) clearTimeout(timer)
        throw err
      })
  }

  // -------------------------------------------------------------------------
  // ④ 状态：本地存储（静态站用）
  // -------------------------------------------------------------------------

  function lsGet(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key)
      if (!raw) return fallback
      var parsed = JSON.parse(raw)
      return parsed === null || parsed === undefined ? fallback : parsed
    } catch (err) {
      // 存储读不出来（隐私模式/配额）必须留痕，否则会表现成「记录凭空消失」
      console.warn('[gacha] 读取 localStorage 失败：' + key, err)
      return fallback
    }
  }

  function lsSet(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
      return true
    } catch (err) {
      console.warn('[gacha] 写入 localStorage 失败：' + key, err)
      toast('本机存储写入失败（可能是隐私模式或配额满）：抽卡记录无法保存', 'error')
      return false
    }
  }

  /**
   * 本地抽卡状态。
   *
   * 动态站也有它 —— 静态站（GitHub Pages）**完全靠它**承载抽卡状态：
   * 拥有张数、碎片、抽数、保底计数、记录。形状与服务端的 `player` 字段
   * 刻意保持一致，这样 `player()` / `collection()` / `shards()` 三个访问器
   * 在两种站上返回同样的东西，渲染代码不用分支。
   */
  function localState() {
    var s = lsGet(LS.player, null)
    if (!s || typeof s !== 'object') {
      s = {
        currency: 0,
        currencyName: '抽卡券',
        pulls: 0,
        sinceTop: 0,
        history: [],
        // 与服务端同名：卡牌 id -> 张数
        owned: {},
        // 与服务端同名：稀有度 id -> 个数
        shards: {},
        duplicates: 0,
      }
    }
    // 旧版本用过 collection 这个名字 —— 迁移过来，别让老玩家的收集进度凭空消失
    if (s.collection && typeof s.collection === 'object' && !s.owned) {
      s.owned = s.collection
    }
    delete s.collection
    if (!s.owned || typeof s.owned !== 'object') s.owned = {}
    if (!s.shards || typeof s.shards !== 'object') s.shards = {}
    if (!Array.isArray(s.history)) s.history = []
    if (typeof s.duplicates !== 'number') s.duplicates = 0
    return s
  }

  function saveLocal(s) {
    lsSet(LS.player, s)
  }

  /**
   * 抽卡状态：**由「服务端快照里有没有 player」决定归谁管**。
   *
   *   · 有 player  -> 动态站，服务端那份是权威（它记账、它算碎片）
   *   · 没有 player -> 静态站（export-static 会剥掉 player），状态在 localStorage
   *
   * 为什么用「有没有这个字段」而不是 `state.unlocked` 来判断：
   * 未解锁的人**不是没有状态**，只是不能改卡池 —— 他一样会抽卡、一样该看到自己的收集进度。
   * 早先用 unlocked 分流，导致未解锁时读到一份空状态，表现成
   * 「重复卡永远算新卡、碎片永远是 0、图鉴永远没进度、记录永远为空」。
   * 而导出脚本一定会删掉 player，所以这个判据在两种站上是确定的。
   */
  function player() {
    var sv = state.data && state.data.player
    if (BACKEND && sv && typeof sv === 'object') return sv
    return localState()
  }

  /** 已拥有张数：卡牌 id -> 张数 */
  function collection() {
    var p = player()
    return (p && (p.owned || p.collection)) || {}
  }

  /** 碎片：稀有度 id -> 个数 */
  function shards() {
    var p = player()
    return (p && p.shards) || {}
  }

  /** 碎片规则（服务端/本地都要按同一份规则显示与判定） */
  function shardRules() {
    var S = window.GachaShards
    if (!S) return { perDuplicate: 1, costForCard: 5, costForUpgrade: 5 }
    return S.rules(state.data || {})
  }

  /**
   * 把**已确认的状态**写回内存快照。
   *
   * ⚠️ 这一步不能省。抽卡/兑换在本地记账后如果只写 localStorage，
   * `state.data.player` 还停在页面加载时那一眼的值 —— 于是**下一次抽卡的重复判定
   * 读到的还是「什么都没拥有」**，同一张卡抽一百次都算新卡、一个碎片也攒不到。
   * 所有改动状态的代码路径都必须调用它。
   */
  function applyStateToSnapshot(patch) {
    if (!state.data) return
    if (!state.data.player || typeof state.data.player !== 'object') state.data.player = {}
    var p = state.data.player
    if (patch.owned) p.owned = patch.owned
    if (patch.shards) p.shards = patch.shards
    if (patch.duplicates !== undefined) p.duplicates = Number(patch.duplicates || 0)
    if (patch.pulls !== undefined) p.pulls = Number(patch.pulls || 0)
    if (patch.sinceTop !== undefined) p.sinceTop = Number(patch.sinceTop || 0)
    if (patch.history) p.history = patch.history
  }

  /**
   * 把**当前实际状态**（owned / shards）折进快照，供 shards.js 的纯函数使用。
   *
   * ⚠️ 这一步也不能省。shards.js 的函数是纯函数，只认传入对象里的 `player.shards`；
   * 而静态站的数据快照里**根本没有 player**（导出时会剥离），
   * 直接传 state.data 会让碎片永远显示 0、兑换按钮永远禁用 —— 一个「点了没反应」
   * 的静默 bug。所有 asking「能不能兑换」「现在有多少碎片」的地方都先过这里。
   */
  function dataWithState() {
    var d = state.data || {}
    var p = player() || {}
    return Object.assign({}, d, {
      player: Object.assign({}, d.player, {
        owned: p.owned || p.collection || {},
        shards: p.shards || {},
        duplicates: Number(p.duplicates || 0),
      }),
    })
  }

  // -------------------------------------------------------------------------
  // ④ 路由
  // -------------------------------------------------------------------------

  function parseRoute() {
    var hash = String(window.location.hash || '')
    if (!hash || hash === '#' || hash === '#/') return { route: 'draw', arg: '' }
    var body = hash.replace(/^#\/?/, '')
    var parts = body.split('/')
    var name = parts[0] || 'draw'
    var known = false
    for (var i = 0; i < SECTIONS.length; i++) if (SECTIONS[i].id === name) known = true
    if (!known) return { route: 'draw', arg: '', bad: name }
    return { route: name, arg: decodeURIComponent(parts.slice(1).join('/') || '') }
  }

  function go(hash) {
    if (window.location.hash === hash) render()
    else window.location.hash = hash
  }

  // -------------------------------------------------------------------------
  // 排行榜 / 卡池辅助
  // -------------------------------------------------------------------------

  function rarityList() {
    return (state.data && state.data.rarities) || []
  }

  function rarityById(id) {
    var list = rarityList()
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]
    return null
  }

  function topRarity() {
    var list = rarityList()
    return list.length ? list[list.length - 1] : null
  }

  function cardById(id) {
    var cards = (state.data && state.data.cards) || []
    for (var i = 0; i < cards.length; i++) if (cards[i].id === id) return cards[i]
    return null
  }

  function currentPool() {
    var pools = (state.data && state.data.pools) || []
    if (!pools.length) return null
    for (var i = 0; i < pools.length; i++) if (pools[i].id === state.poolId) return pools[i]
    return pools[0]
  }

  function rarityChip(rarityId, opts) {
    opts = opts || {}
    var r = rarityById(rarityId)
    var chip = el('span', { class: 'chip' + (opts.big ? ' chip-big' : ''), text: r ? r.label || r.id : rarityId || '?' })
    // 颜色由服务端数据给（rarity.color）。CSP 允许 CSSOM，所以这里用它而不是 style 属性
    chip.style.color = r && r.color ? r.color : '#8b8b99'
    chip.style.borderColor = r && r.color ? r.color : '#8b8b99'
    if (!r) chip.title = '这个稀有度不在档位表里：' + rarityId
    return chip
  }

  /** 现在能不能改内容：静态站永远不能（那是「没有后端」，不是「没输秘钥」） */
  function canEdit() {
    return !READONLY && state.unlocked
  }

  /**
   * 卡面。2:3 竖版，图片 object-fit: contain（美术图不能裁）。
   *
   * 四条硬要求：
   *   1. 占位层先留着：图没加载出来时它是内容，不是空白
   *   2. 失败要有原因：把「哪个文件读不到」写在卡上
   *   3. 占位里显示角色名与稀有度，所以没有美术资源时页面依然是可用的
   *   4. 隐藏条目对读者不可见，对已解锁的人带角标
   */
  function cardFigure(card, opts) {
    opts = opts || {}
    var box = el('div', { class: 'card' + (opts.size ? ' card-' + opts.size : '') })

    var r = rarityById(card.rarity)
    if (r && r.color) box.style.setProperty('--rarity-color', r.color)

    var face = el('div', { class: 'card-face' })
    // 占位层（永远先放）
    face.appendChild(
      el('div', { class: 'card-placeholder' }, [
        el('div', { class: 'card-placeholder-glyph', text: '✦' }),
        el('div', { class: 'card-placeholder-name', text: card.name || '未命名' }),
      ])
    )

    if (card.imageUrl) {
      var img = el('img', { class: 'card-img', src: card.imageUrl, alt: card.name || '卡面', loading: 'lazy' })
      img.addEventListener('error', function () {
        // 绝不静默：图读不到要把原因和可点开的地址挂在卡上
        img.hidden = true
        var url = card.imageUrl
        face.appendChild(
          el('div', { class: 'card-error' }, [
            el('div', { class: 'card-error-title', text: '卡面读不到' }),
            el('div', { class: 'card-error-file', text: card.image || '(未填图片)' }),
            el('a', { class: 'card-error-link', href: url, target: '_blank', rel: 'noopener', text: '打开这个地址看原因' }),
          ])
        )
        announce('卡面读不到：' + (card.image || '(未填图片)'))
      })
      face.appendChild(img)
    } else {
      // 没有填图片 —— 这是「还没配」，不是「读不到」，两者要分清
      face.appendChild(
        el('div', { class: 'card-nofile' }, [
          el('div', { text: canEdit() ? '还没有卡面图' : '暂无卡面' }),
          canEdit()
            ? el('div', { class: 'card-nofile-hint', text: '点「编辑」填图片，或到后台扫描卡池' })
            : null,
        ])
      )
    }
    box.appendChild(face)

    // 卡面下方：角色名 + 稀有度角标
    var foot = el('div', { class: 'card-foot' }, [
      el('div', { class: 'card-name', text: card.name || '未命名' }),
      rarityChip(card.rarity),
    ])

    if (opts.count) {
      foot.appendChild(el('span', { class: 'card-count', text: '×' + opts.count, title: '已拥有 ' + opts.count + ' 张' }))
    }
    box.appendChild(foot)

    if (card.hidden) box.appendChild(el('div', { class: 'card-flag', text: '已隐藏' }))
    if (!card.rarityKnown) {
      box.appendChild(
        el('div', { class: 'card-flag card-flag-warn', text: '稀有度未设置', title: '稀有度「' + card.rarity + '」不在档位表里' })
      )
    }
    return box
  }

  function sectionHead(title, desc, extra) {
    return el('div', { class: 'sec-head' }, [
      el('div', {}, [el('h2', { class: 'sec-title', text: title }), desc ? el('p', { class: 'sec-desc', text: desc }) : null]),
      extra ? el('div', { class: 'sec-extra' }, extra) : null,
    ])
  }

  function emptyBox(title, lines, action) {
    return el('div', { class: 'empty' }, [
      el('div', { class: 'empty-title', text: title }),
      el(
        'ul',
        { class: 'empty-lines' },
        (lines || []).map(function (l) {
          return el('li', { text: l })
        })
      ),
      action || null,
    ])
  }

  // -------------------------------------------------------------------------
  // ⑤ 抽卡
  // -------------------------------------------------------------------------

  function G() {
    return window.Gacha
  }

  /**
   * 执行一次抽卡。
   *
   * 记账有三种情况，别混：
   *   · 动态站 + 已解锁 → 结果同步到服务端（data.json），页面刷新不丢
   *   · 动态站 + 未解锁 → 抽卡状态本来就不该写服务端，落 localStorage
   *   · 静态站（GitHub Pages）→ 只能落 localStorage
   */
  function runDraw(count) {
    var data = state.data
    if (!data) {
      toast('卡池数据还没加载好', 'error')
      return
    }
    var g = G()
    if (!g) {
      toast('draw.js 没有加载成功，抽卡无法进行（看 Console 的报错）', 'error')
      return
    }
    var pool = currentPool()
    if (!pool) {
      toast('没有任何卡池可抽', 'error')
      return
    }

    // 先做一次预检：把「为什么抽不了」直接说出来，而不是点下去没反应
    var probs = g.issues(data, pool.id)
    if (probs.length) {
      renderDrawProblem(probs, pool)
      toast('卡池还没配好，抽不了（页面里有原因）', 'error')
      return
    }

    var cost = g.costFor(data, count)
    var p = player()
    var have = Number(p.currency || 0)
    if (cost > 0 && have < cost) {
      toast('不够 ' + (p.currencyName || '抽卡券') + '：需要 ' + cost + '，现有 ' + have, 'error')
      return
    }

    var result = g.drawMany(data, { poolId: pool.id, count: count })
    if (!result.ok) {
      toast('抽卡失败：' + result.error, 'error')
      renderDrawProblem([result.error], pool)
      return
    }

    // --- 结算：重复卡 -> 碎片 ---------------------------------------------
    // 用与「服务端权威兑换」完全同一份规则（page/shards.js 的 settleDraw）。
    //
    // ⚠️ 判定「重复」必须看到**真正的**状态：静态站与未解锁的动态站里，
    // 服务端快照是没有 player 的，实际状态在 localStorage。直接传 state.data 会让
    // 第二次抽同一张卡仍然算「新卡」—— 重复卡永远拿不到碎片，页面上还显示 NEW。
    // dataWithState() 就是为这件事存在的（把当前状态折进快照）。
    var sh = window.GachaShards
    if (!sh) {
      toast('shards.js 没有加载成功，碎片结算无法进行（看 Console 的报错）', 'error')
      return
    }
    var settle = sh.settleDraw(dataWithState(), result.results)

    // 保底计数（自上次出最高档起算）
    var topId = topRarity() ? topRarity().id : ''
    var sinceTop = Number(p.sinceTop || 0)
    for (var i = 0; i < result.results.length; i++) {
      sinceTop += 1
      if (result.results[i].rarityId === topId) sinceTop = 0
    }

    // --- 落本地（静态站靠它；动态站也写一份，作为同步失败时的兜底） --------
    var local = localState()
    local.currency = Math.max(0, Number(local.currency || 0) - cost)
    local.pulls = Number(local.pulls || 0) + result.results.length
    local.sinceTop = sinceTop
    local.owned = settle.owned
    local.shards = settle.shards
    local.duplicates = Number(local.duplicates || 0) + settle.duplicates

    var at = Date.now()
    var rows = settle.perCard.map(function (pc, idx) {
      return {
        cardId: pc.card.id,
        rarity: pc.rarity,
        at: at,
        index: local.pulls - settle.perCard.length + idx + 1,
        duplicate: pc.duplicate,
        shards: pc.shards,
        guaranteed: !!(result.results[idx] && result.results[idx].guaranteed),
      }
    })
    for (var j = rows.length - 1; j >= 0; j--) local.history.unshift(rows[j])
    local.history = local.history.slice(0, 500)
    saveLocal(local)

    // 把已确认的状态写回内存快照 —— 否则下一次抽卡的重复判定会读到一个空状态
    // （见 applyStateToSnapshot 的注释）
    applyStateToSnapshot({
      owned: local.owned,
      shards: local.shards,
      duplicates: local.duplicates,
      pulls: local.pulls,
      sinceTop: local.sinceTop,
      history: local.history,
    })

    // --- 展示用的本轮结果 ------------------------------------------------
    state.last = {
      poolId: pool.id,
      at: at,
      results: result.results.map(function (item, idx) {
        var pc = settle.perCard[idx] || {}
        return {
          card: item.card,
          rarityId: item.rarityId,
          forced: item.forced || '',
          guaranteed: !!item.guaranteed,
          guaranteeNote: item.guaranteeNote || '',
          isNew: !pc.duplicate,
          duplicate: !!pc.duplicate,
          shards: Number(pc.shards || 0),
        }
      }),
    }
    lsSet(LS.last, {
      poolId: pool.id,
      at: state.last.at,
      ids: state.last.results.map(function (r) { return r.card.id }),
    })

    state.sinceTop = sinceTop
    render()

    // 提示要把「拿到多少碎片」说出来，别让人自己去数
    var shardTotal = 0
    for (var k in settle.gainedShards) {
      if (Object.prototype.hasOwnProperty.call(settle.gainedShards, k)) shardTotal += settle.gainedShards[k]
    }
    if (settle.duplicates > 0) {
      toast(
        (count > 1 ? '十连完成' : '抽到 ' + result.results[0].card.name) +
          ' · ' + settle.duplicates + ' 张重复，转化为 ' + shardTotal + ' 个碎片',
        'ok'
      )
    } else {
      toast(count > 1 ? '十连完成 · 全部是新卡！' : '抽到新卡 ' + result.results[0].card.name, 'ok')
    }

    // --- 同步到服务端（仅动态站 + 已解锁） --------------------------------
    // 服务端会用同一份规则**重新结算一遍**（它有自己的 owned 状态），
    // 所以这里只送卡牌 id，不送碎片数 —— 让服务端算，避免两边对不上。
    if (BACKEND && state.unlocked) {
      request('/draw/sync', {
        method: 'POST',
        body: {
          poolId: pool.id,
          cost: cost,
          sinceTop: sinceTop,
          results: result.results.map(function (item) {
            return { cardId: item.card.id }
          }),
        },
      })
        .then(function (res) {
          if (res && res.rejected && res.rejected.length) {
            // 服务端退回了条目 —— 这必须说出来，不能当没发生
            toast('服务端拒绝了 ' + res.rejected.length + ' 条记录：' + res.rejected[0].reason, 'error')
          }
          if (res && res.player && state.data) {
            // 服务端权威状态覆盖本地 —— 碎片数以它为准
            state.data.player = res.player
            // 本地也跟上，避免静态站/动态站来回切换时数字跳变
            var l2 = localState()
            l2.owned = res.player.owned || l2.owned
            l2.shards = res.player.shards || l2.shards
            l2.duplicates = Number(res.player.duplicates || 0)
            saveLocal(l2)
            render()
          }
        })
        .catch(function (err) {
          // 抽卡本身已经成功了（结果在本地），但账没记上 —— 要说清是「记账失败」
          toast('抽卡结果没能同步到服务端：' + err.message + '（本次结果仍显示在页面上）', 'error')
        })
    }
  }

  function renderDrawProblem(probs, pool) {
    var view = state.els.view
    clear(view)
    view.appendChild(
      sectionHead('抽不了 —— 卡池还没配好', '这不是你的操作问题。下面是具体缺什么，照着做即可。')
    )
    view.appendChild(
      el(
        'div',
        { class: 'panel panel-warn' },
        [
          el('div', { class: 'panel-title', text: '卡池「' + (pool ? pool.name : '(无)') + '」的问题' }),
          el('ul', { class: 'issue-list' }, probs.map(function (t) { return el('li', { text: t }) })),
          el('div', { class: 'panel-actions' }, [
            canEdit()
              ? el('button', { class: 'btn primary', type: 'button', 'data-bind': 'goto-admin' }, ['去后台管理'])
              : el('div', { class: 'panel-hint', text: READONLY ? '这是静态站，改卡池需要在本机的 DSH 页面里操作。' : '需要编辑秘钥才能改卡池。' }),
          ]),
        ]
      )
    )
    var b = view.querySelector('[data-bind="goto-admin"]')
    if (b) b.addEventListener('click', function () { go('#/admin') })
  }

  // -------------------------------------------------------------------------
  // ⑥ 板块：抽卡
  // -------------------------------------------------------------------------

  function viewDraw() {
    var g = G()
    var view = state.els.view
    var pool = currentPool()
    var probs = g ? g.issues(state.data, pool ? pool.id : '') : ['draw.js 没有加载']

    var wrap = el('div', { class: 'sec' })
    wrap.appendChild(
      sectionHead('抽卡', state.data.settings.subtitle || '抽卡 · 图鉴 · 卡池', [
        el('span', { class: 'pill', text: '累计 ' + fmt(player().pulls) + ' 抽' }),
        state.sinceTop !== undefined && state.data.settings.pull.pityMax > 0
          ? el('span', { class: 'pill', text: '保底 ' + fmt(state.sinceTop) + '/' + state.data.settings.pull.pityMax })
          : null,
      ])
    )

    if (probs.length) {
      wrap.appendChild(
        el('div', { class: 'panel panel-warn' }, [
          el('div', { class: 'panel-title', text: '卡池还没配好，现在抽不了' }),
          el('ul', { class: 'issue-list' }, probs.map(function (t) { return el('li', { text: t }) })),
          canEdit()
            ? el('button', { class: 'btn primary', type: 'button', 'data-bind': 'goto-admin2' }, ['去后台管理'])
            : el('div', { class: 'panel-hint', text: READONLY ? '这是静态站，改卡池需要在本机的 DSH 页面里操作。' : '需要编辑秘钥才能改卡池。' }),
        ])
      )
    } else {
      // 出率表：让人在抽之前就知道各档概率
      var rates = g.rateTable(state.data, pool.id)
      wrap.appendChild(
        el('div', { class: 'rate-row' }, rates.map(function (x) {
          return el('div', { class: 'rate-cell' + (x.playable ? '' : ' rate-off') }, [
            rarityChip(x.rarity.id),
            el('div', { class: 'rate-num', text: (x.rate * 100).toFixed(2) + '%' }),
            el('div', { class: 'rate-sub', text: x.count + ' 张' }),
          ])
        }))
      )
    }

    // 抽卡按钮
    var cost1 = state.data.settings.pull.costSingle
    var cost10 = g.costFor(state.data, 10)
    var have = Number(player().currency || 0)
    var disabled = probs.length > 0

    var actions = el('div', { class: 'draw-actions' }, [
      el('button', {
        class: 'btn big primary',
        type: 'button',
        'data-bind': 'draw1',
        disabled: disabled || undefined,
      }, ['单抽' + (cost1 ? '（' + cost1 + '）' : '')]),
      el('button', {
        class: 'btn big',
        type: 'button',
        'data-bind': 'draw10',
        disabled: disabled || undefined,
      }, ['十连' + (cost10 ? '（' + cost10 + '）' : '')]),
      el('span', { class: 'draw-have', text: '现有 ' + have + ' ' + (player().currencyName || '抽卡券') }),
    ])
    wrap.appendChild(actions)

    // 结果区
    if (state.last && state.last.results.length) {
      var res = el('div', { class: 'result-box' })
      res.appendChild(
        el('div', { class: 'result-head' }, [
          el('span', { text: '本次结果' }),
          el('span', { class: 'result-time', text: fmtTime(state.last.at) }),
          el('button', { class: 'btn ghost small', type: 'button', 'data-bind': 'clear-result' }, ['收起']),
        ])
      )
      var grid = el('div', { class: 'grid cards' })
      var dupCount = 0
      var shardGain = 0
      state.last.results.forEach(function (item) {
        var holder = el('div', { class: 'result-cell' })
        holder.appendChild(cardFigure(item.card, { size: 'lg' }))
        if (item.isNew) {
          holder.appendChild(el('div', { class: 'badge-new', text: 'NEW' }))
        } else if (item.duplicate) {
          // 重复卡转成碎片 —— 必须画在卡上，否则「这张明明是我的」这种困惑无法解释
          var n = Number(item.shards || 0)
          dupCount++
          shardGain += n
          holder.appendChild(el('div', { class: 'badge-dup', text: '重复 +' + n + ' 碎片' }))
          holder.classList.add('result-dup')
        }
        if (item.guaranteed) holder.appendChild(el('div', { class: 'badge-guarantee', text: '保底' }))
        if (item.guaranteed === false && item.forced === 'tenpull-fallback') {
          // 保底档在池子里抽不出来 —— 如实说明，不假装保底成功
          holder.appendChild(el('div', { class: 'badge-note', text: '保底档不可抽', title: item.guaranteeNote }))
        }
        grid.appendChild(holder)
      })
      res.appendChild(grid)
      if (dupCount > 0) {
        res.appendChild(
          el('div', { class: 'result-summary' }, [
            el('span', { text: '本次 ' + dupCount + ' 张重复，转化为 ' + shardGain + ' 个碎片' }),
            el('a', { class: 'result-link', href: '#/shards', text: '去碎片兑换 →' }),
          ])
        )
      }
      wrap.appendChild(res)
    }

    view.appendChild(wrap)

    var d1 = view.querySelector('[data-bind="draw1"]')
    var d10 = view.querySelector('[data-bind="draw10"]')
    if (d1) d1.addEventListener('click', function () { runDraw(1) })
    if (d10) d10.addEventListener('click', function () { runDraw(10) })
    var cr = view.querySelector('[data-bind="clear-result"]')
    if (cr) cr.addEventListener('click', function () { state.last = null; render() })
    var ga = view.querySelector('[data-bind="goto-admin2"]')
    if (ga) ga.addEventListener('click', function () { go('#/admin') })
  }

  // -------------------------------------------------------------------------
  // ⑥ 板块：卡池一览
  // -------------------------------------------------------------------------

  function viewPool() {
    var g = G()
    var view = state.els.view
    var wrap = el('div', { class: 'sec' })
    wrap.appendChild(sectionHead('卡池一览', '整个卡池按稀有度分组。带锁角标的是还没抽到的。'))

    if (!state.data.pools.length) {
      wrap.appendChild(emptyBox('没有任何卡池', ['到后台管理里新建一个卡池。']))
      view.appendChild(wrap)
      return
    }

    var poolPicker = el('div', { class: 'pool-tabs' })
    state.data.pools.forEach(function (p) {
      var b = el('button', {
        class: 'tab' + (p.id === (currentPool() || {}).id ? ' tab-on' : ''),
        type: 'button',
        'data-pool': p.id,
      }, [p.name])
      poolPicker.appendChild(b)
    })
    wrap.appendChild(poolPicker)

    var pool = currentPool()
    var summary = g ? g.poolSummary(state.data, pool.id) : null
    var rates = g ? g.rateTable(state.data, pool.id) : []

    if (summary && !summary.total) {
      wrap.appendChild(
        emptyBox('这个卡池里一张卡都没有', [
          '卡牌名册是空的，或者所有卡都没有设置认识的稀有度。',
          state.unlocked && !READONLY ? '到后台管理里点「扫描卡池」。' : '需要作者在后台把卡牌加进来。',
        ])
      )
    }

    var owned = collection()
    summary &&
      summary.rows.forEach(function (row) {
        if (!row.count) return
        var rate = null
        for (var i = 0; i < rates.length; i++) if (rates[i].rarity.id === row.rarity.id) rate = rates[i]
        var cards = state.data.cards.filter(function (c) {
          return !c.hidden && c.rarityKnown && c.rarity === row.rarity.id
        })
        // 「出率 0.00%」和「抽不出」是两件事，不能混：
        //   · 权重 0 或没配 -> 这一档在这轮抽卡里根本抽不到
        //   · 真正在掷档里参与、只是概率低 -> 显示具体百分比
        // 混在一起会让人以为「有卡就能抽到」。
        var meta
        if (!rate || !rate.playable) {
          meta = row.count + ' 张 · 抽不出（权重 0 或这一档没配权重）'
        } else {
          meta = row.count + ' 张 · 出率 ' + (rate.rate * 100).toFixed(2) + '%'
        }
        wrap.appendChild(
          el('div', { class: 'group' + (rate && rate.playable ? '' : ' group-off') }, [
            el('div', { class: 'group-head' }, [
              rarityChip(row.rarity.id, { big: true }),
              el('span', { class: 'group-meta', text: meta }),
            ]),
            el('div', { class: 'grid cards' }, cards.map(function (c) {
              var cell = el('div', { class: 'pool-cell' })
              cell.appendChild(cardFigure(c))
              var n = Number(owned[c.id] || 0)
              if (n > 0) cell.appendChild(el('div', { class: 'badge-owned', text: n > 1 ? '×' + n : '已获得' }))
              else cell.appendChild(el('div', { class: 'badge-locked', text: '未获得' }))
              return cell
            })),
          ])
        )
      })

    view.appendChild(wrap)
    wrap.querySelectorAll('[data-pool]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.poolId = b.getAttribute('data-pool')
        render()
      })
    })
  }

  // -------------------------------------------------------------------------
  // ⑥ 板块：图鉴
  // -------------------------------------------------------------------------

  /**
   * 图鉴分组。
   *
   * 规则（用户要求「系列卡在图鉴中一起显示」）：
   *   · 有 series 的卡：**同一个系列合成一组**，组内先按 seriesOrder 再按稀有度排。
   *     系列组排在最前面 —— 「一起显示」的意图就是它们要挨着。
   *   · 没有 series 的卡：按稀有度分组（原来的行为）。
   *   · 稀有度表里不认识的卡：单独一组，永远看得见（数据写错不该被藏起来）。
   *
   * @returns {Array<{kind:'series'|'rarity'|'unknown', key, label, cards}>}
   */
  function collectionGroups(cards) {
    var groups = []
    var seriesMap = {}
    var seriesOrder = []

    cards.forEach(function (c) {
      if (!c.series) return
      if (!seriesMap[c.series]) {
        seriesMap[c.series] = []
        seriesOrder.push(c.series)
      }
      seriesMap[c.series].push(c)
    })

    var rarityRank = {}
    rarityList().forEach(function (r) {
      rarityRank[r.id] = Number(r.rank || 0)
    })

    seriesOrder.forEach(function (name) {
      var list = seriesMap[name].slice().sort(function (a, b) {
        var ao = Number(a.seriesOrder || 0)
        var bo = Number(b.seriesOrder || 0)
        if (ao !== bo) return ao - bo
        var ar = rarityRank[a.rarity] === undefined ? 999 : rarityRank[a.rarity]
        var br = rarityRank[b.rarity] === undefined ? 999 : rarityRank[b.rarity]
        if (ar !== br) return ar - br
        return String(a.name).localeCompare(String(b.name))
      })
      groups.push({ kind: 'series', key: 'series:' + name, label: name, cards: list })
    })

    rarityList().forEach(function (r) {
      var list = cards.filter(function (c) {
        return !c.series && c.rarity === r.id
      })
      if (list.length) groups.push({ kind: 'rarity', key: 'rarity:' + r.id, label: r.id, cards: list })
    })

    var unknown = cards.filter(function (c) {
      return !c.rarityKnown
    })
    if (unknown.length) groups.push({ kind: 'unknown', key: 'unknown', label: '稀有度未设置', cards: unknown })

    return groups
  }

  function viewCollection() {
    var view = state.els.view
    var wrap = el('div', { class: 'sec' })
    var cards = state.data.cards.filter(function (c) { return !c.hidden })
    var owned = collection()
    var got = 0
    cards.forEach(function (c) { if (Number(owned[c.id] || 0) > 0) got += 1 })
    var pct = cards.length ? Math.round((got / cards.length) * 100) : 0
    var seriesCount = {}
    cards.forEach(function (c) {
      if (c.series) seriesCount[c.series] = (seriesCount[c.series] || 0) + 1
    })
    var seriesNames = Object.keys(seriesCount)

    wrap.appendChild(
      sectionHead('图鉴', '收集进度：已获得 ' + got + ' / ' + cards.length + ' 张（' + pct + '%）', [
        el('span', { class: 'pill', text: '累计 ' + fmt(player().pulls) + ' 抽' }),
        Number(player().duplicates || 0) > 0
          ? el('span', { class: 'pill', text: '重复 ' + fmt(player().duplicates) + ' 张' })
          : null,
        seriesNames.length ? el('span', { class: 'pill', text: seriesNames.length + ' 个系列' }) : null,
      ])
    )

    // 进度条：没有内联样式，宽度用 CSSOM 设置
    var bar = el('div', { class: 'progress' }, [el('div', { class: 'progress-fill' })])
    var fill = bar.querySelector('.progress-fill')
    if (fill) fill.style.width = pct + '%'
    wrap.appendChild(bar)

    if (!cards.length) {
      wrap.appendChild(emptyBox('图鉴是空的', ['还没有任何卡牌。']))
      view.appendChild(wrap)
      return
    }

    collectionGroups(cards).forEach(function (g) {
      var gotHere = g.cards.filter(function (c) { return Number(owned[c.id] || 0) > 0 }).length
      var head
      if (g.kind === 'series') {
        head = el('div', { class: 'group-head' }, [
          el('span', { class: 'series-chip', text: g.label }),
          el('span', { class: 'group-meta', text: gotHere + ' / ' + g.cards.length }),
          el('span', { class: 'group-note', text: '系列' }),
        ])
      } else if (g.kind === 'unknown') {
        head = el('div', { class: 'group-head' }, [
          el('span', { class: 'chip chip-big chip-warn', text: g.label }),
          el('span', { class: 'group-meta', text: g.cards.length + ' 张' }),
        ])
      } else {
        head = el('div', { class: 'group-head' }, [
          rarityChip(g.label, { big: true }),
          el('span', { class: 'group-meta', text: gotHere + ' / ' + g.cards.length }),
        ])
      }

      wrap.appendChild(
        el('div', { class: 'group' + (g.kind === 'unknown' ? ' group-warn' : '') }, [
          head,
          el('div', { class: 'grid cards' }, g.cards.map(function (c) {
            var n = Number(owned[c.id] || 0)
            var holder = el('div', { class: 'coll-cell' + (n > 0 ? '' : ' coll-locked') })
            holder.appendChild(cardFigure(c))
            if (n > 0) holder.appendChild(el('div', { class: 'badge-owned', text: n > 1 ? '×' + n : '已获得' }))
            return holder
          })),
        ])
      )
    })

    view.appendChild(wrap)
  }

  // -------------------------------------------------------------------------
  // ⑥ 板块：碎片兑换
  // -------------------------------------------------------------------------

  /**
   * 碎片兑换。
   *
   * 规则来自 page/shards.js（与服务端权威兑换同一份源码），这里只负责画与点。
   *
   * ⚠️ 动态站 + 已解锁 -> 走服务端 `POST api/shards.json`（权威）。
   *    静态站（GitHub Pages）没有服务端，所以只能本地记账 —— 这一点必须在页面上
   *    说清楚，否则「在静态站换的碎片换完就没了」会变成一个说不清的 bug。
   */
  function viewShards() {
    var view = state.els.view
    var wrap = el('div', { class: 'sec' })
    var S = window.GachaShards

    wrap.appendChild(
      sectionHead('碎片兑换', '抽到重复的卡会转化成对应稀有度的碎片。' + shardRules().costForCard + ' 个碎片可以换一张同档卡牌，或换成更高一级的碎片。', [
        el('span', { class: 'pill', text: '重复 ' + fmt(player().duplicates || 0) + ' 张' }),
      ])
    )

    if (!S) {
      wrap.appendChild(
        emptyBox('碎片模块没有加载', [
          'page/shards.js 没有加载成功，所以这里无法判断能不能兑换。',
          '看浏览器 Console 的报错（多半是资源 404 或 CSP 拦了）。',
        ])
      )
      view.appendChild(wrap)
      return
    }

    // 动态站需要已解锁才能走服务端权威兑换；静态站本地记账
    var serverMode = BACKEND && state.unlocked
    if (BACKEND && !state.unlocked) {
      wrap.appendChild(
        el('div', { class: 'panel' }, [
          el('div', { class: 'panel-title', text: '提示：兑换需要先解锁秘钥' }),
          el('p', { class: 'panel-hint', text: '碎片兑换会改动你的收集进度，所以动态站上要求先输编辑秘钥。你现在可以看，但点兑换会被拒。' }),
        ])
      )
    }
    if (READONLY) {
      wrap.appendChild(
        el('div', { class: 'panel' }, [
          el('div', { class: 'panel-title', text: '这是静态站：兑换只存在你自己的浏览器里' }),
          el('p', { class: 'panel-hint', text: '静态站没有服务端，所以碎片与兑换记录都保存在本机浏览器（localStorage）。换台机器/清缓存就没了 —— 这是静态站的固有限制，不是 bug。' }),
        ])
      )
    }

    var status = S.status(dataWithState())
    var anyShards = status.some(function (r) { return r.have > 0 })
    if (!anyShards) {
      wrap.appendChild(
        emptyBox('还没有任何碎片', [
          '抽到重复的卡才会产生碎片。',
          '当前卡池与图鉴都在，去「抽卡」页抽几次就会出现重复卡。',
        ])
      )
    }

    status.forEach(function (row) {
      var body = el('div', { class: 'shard-row' }, [
        rarityChip(row.rarity.id, { big: true }),
        el('div', { class: 'shard-count' }, [
          el('span', { class: 'shard-num', text: fmt(row.have) }),
          el('span', { class: 'shard-unit', text: '个碎片' }),
        ]),
      ])

      // 兑卡
      var cardBtn = el('button', {
        class: 'btn primary',
        type: 'button',
        'data-shard-action': 'card',
        'data-rarity': row.rarity.id,
        disabled: row.canRedeemCard ? undefined : true,
      }, ['兑换一张 ' + (row.rarity.label || row.rarity.id) + '（' + row.costForCard + '）'])

      var cardHint
      if (row.canRedeemCard) {
        cardHint = el('div', { class: 'shard-hint', text: '同档共 ' + row.cardCount + ' 张，兑换时随机给一张' })
      } else if (row.cardCount === 0) {
        cardHint = el('div', { class: 'shard-hint shard-hint-off', text: '这一档还没有任何卡牌，碎片换不了' })
      } else {
        cardHint = el('div', { class: 'shard-hint shard-hint-off', text: '还差 ' + row.missingForCard + ' 个碎片' })
      }

      var actions = el('div', { class: 'shard-actions' }, [cardBtn, cardHint])

      // 升档
      if (row.isTop) {
        actions.appendChild(el('div', { class: 'shard-hint shard-hint-off', text: '已经是最高档，没有更高一级可以升' }))
      } else {
        var upBtn = el('button', {
          class: 'btn',
          type: 'button',
          'data-shard-action': 'upgrade',
          'data-rarity': row.rarity.id,
          disabled: row.canUpgrade ? undefined : true,
        }, ['换 1 个 ' + (row.nextRarity.label || row.nextRarity.id) + ' 碎片（' + row.costForUpgrade + '）'])
        actions.appendChild(upBtn)
        actions.appendChild(
          el('div', {
            class: 'shard-hint' + (row.canUpgrade ? '' : ' shard-hint-off'),
            text: row.canUpgrade ? '升到更高一级的碎片' : '还差 ' + row.missingForUpgrade + ' 个碎片',
          })
        )
      }

      body.appendChild(actions)
      wrap.appendChild(el('div', { class: 'group shard-group' }, [body]))
    })

    // 兑换记录（碎片怎么少掉的要能查）
    var exchanges = state.shardLog || []
    if (exchanges.length) {
      wrap.appendChild(
        el('div', { class: 'panel' }, [
          el('div', { class: 'panel-title', text: '本次会话的兑换记录' }),
          el('div', { class: 'hist' }, exchanges.map(function (x) {
            return el('div', { class: 'hist-row' }, [
              rarityChip(x.rarity),
              el('span', { class: 'hist-name', text: x.text }),
              el('span', { class: 'hist-time', text: fmtTime(x.at) }),
            ])
          })),
        ])
      )
    }

    view.appendChild(wrap)

    view.querySelectorAll('[data-shard-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        doExchange(btn.getAttribute('data-rarity'), btn.getAttribute('data-shard-action'))
      })
    })
  }

  /** 执行一次兑换。两条通路：动态站走服务端，静态站本地记账。 */
  function doExchange(rarityId, action) {
    var S = window.GachaShards
    if (!S) {
      toast('碎片模块没有加载，无法兑换', 'error')
      return
    }
    // 先本地判一次：把「为什么换不了」立刻说出来，而不是等接口回一个 400
    var check = S.canExchange(dataWithState(), rarityId, action)
    if (!check.ok) {
      toast(check.error, 'error')
      return
    }

    if (BACKEND) {
      if (!state.unlocked) {
        toast('需要先解锁编辑秘钥才能兑换（右上角「解锁」）', 'error')
        return
      }
      request('/shards.json', { method: 'POST', body: { rarity: rarityId, action: action } })
        .then(function (res) {
          if (res.player && state.data) state.data.player = res.player
          pushShardLog(rarityId, action, check.cost, res.card, res.gainedShard)
          render()
          toast(
            action === 'card' && res.card
              ? '兑换到 ' + res.card.name
              : '换到 1 个 ' + ((res.gainedShard && res.gainedShard.rarity) || '更高档') + ' 碎片',
            'ok'
          )
        })
        .catch(function (err) {
          toast('兑换失败：' + err.message, 'error')
        })
      return
    }

    // 静态站：本地记账
    var result = S.exchange(dataWithState(), rarityId, action)
    if (!result.ok) {
      toast(result.error, 'error')
      return
    }
    var local = localState()
    local.shards = result.shards
    if (result.card) {
      local.owned = Object.assign({}, local.owned)
      local.owned[result.card.id] = Number(local.owned[result.card.id] || 0) + 1
    }
    saveLocal(local)
    // 同步写回内存快照（否则连续兑换两次时第二次读到的还是旧碎片数）
    applyStateToSnapshot({ owned: local.owned, shards: local.shards, duplicates: local.duplicates })

    pushShardLog(rarityId, action, result.cost, result.card, result.gainedShard)
    render()
    toast(
      result.card ? '兑换到 ' + result.card.name + '（记在这台浏览器上）' : '换到 1 个 ' + result.gainedShard.rarity + ' 碎片',
      'ok'
    )
  }

  function pushShardLog(rarityId, action, cost, card, gainedShard) {
    if (!state.shardLog) state.shardLog = []
    var r = rarityById(rarityId)
    var label = r ? r.label || r.id : rarityId
    state.shardLog.unshift({
      rarity: rarityId,
      at: Date.now(),
      text:
        label + ' 碎片 -' + cost + ' -> ' +
        (card ? '卡牌「' + card.name + '」' : '1 个 ' + ((gainedShard && gainedShard.rarity) || '?') + ' 碎片'),
    })
    state.shardLog = state.shardLog.slice(0, 30)
  }


  // -------------------------------------------------------------------------
  // ⑥ 板块：抽卡记录
  // -------------------------------------------------------------------------

  function viewHistory() {
    var view = state.els.view
    var wrap = el('div', { class: 'sec' })
    var hist = (player().history || []).slice()

    wrap.appendChild(
      sectionHead('抽卡记录', '最新的在最上面，最多保留 500 条。', [
        canEdit()
          ? el('button', { class: 'btn ghost small', type: 'button', 'data-bind': 'reset-player' }, ['清空记录与计数'])
          : null,
      ])
    )

    if (!hist.length) {
      wrap.appendChild(emptyBox('还没有抽过卡', ['到「抽卡」页面抽一次，这里就会列出来。']))
      view.appendChild(wrap)
      return
    }

    var stats = {}
    var dupTotal = 0
    var shardTotal = 0
    hist.forEach(function (h) {
      stats[h.rarity] = (stats[h.rarity] || 0) + 1
      if (h.duplicate) {
        dupTotal++
        shardTotal += Number(h.shards || 0)
      }
    })
    wrap.appendChild(
      el('div', { class: 'rate-row' }, rarityList().map(function (r) {
        return el('div', { class: 'rate-cell' }, [
          rarityChip(r.id),
          el('div', { class: 'rate-num', text: fmt(stats[r.id] || 0) }),
          el('div', { class: 'rate-sub', text: '次' }),
        ])
      }))
    )
    wrap.appendChild(
      el('div', { class: 'hist-summary' }, [
        el('span', { text: '重复 ' + dupTotal + ' 张' }),
        el('span', { text: '累计获得碎片 ' + shardTotal + ' 个' }),
        el('a', { class: 'result-link', href: '#/shards', text: '去碎片兑换 →' }),
      ])
    )

    var rows = el('div', { class: 'hist' })
    hist.slice(0, 200).forEach(function (h) {
      var card = cardById(h.cardId)
      var row = el('div', { class: 'hist-row' }, [
        el('span', { class: 'hist-idx', text: '#' + fmt(h.index) }),
        rarityChip(h.rarity),
        el('span', { class: 'hist-name', text: card ? card.name : h.cardId + '（这张卡已不在名册里）' }),
        h.duplicate
          ? el('span', { class: 'badge-dup small', text: '重复 +' + fmt(h.shards || 0) + ' 碎片' })
          : el('span', { class: 'badge-new small', text: 'NEW' }),
        h.guaranteed ? el('span', { class: 'badge-guarantee small', text: '保底' }) : null,
        el('span', { class: 'hist-time', text: fmtTime(h.at) }),
      ])
      if (!card) row.className += ' hist-missing'
      rows.appendChild(row)
    })
    wrap.appendChild(rows)
    if (hist.length > 200) {
      wrap.appendChild(el('div', { class: 'panel-hint', text: '只显示最近 200 条，共 ' + hist.length + ' 条。' }))
    }

    view.appendChild(wrap)
    var rp = view.querySelector('[data-bind="reset-player"]')
    if (rp) {
      rp.addEventListener('click', function () {
        if (!window.confirm('清空抽卡记录、累计抽数与保底计数？收集进度会重置，卡池本身不受影响。')) return
        resetPlayer()
      })
    }
  }

  function resetPlayer() {
    // 动态站清服务端，静态站清本地 —— 两边都要清，否则会出现「清了一半」
    var local = localState()
    local.pulls = 0
    local.sinceTop = 0
    local.history = []
    local.owned = {}
    local.shards = {}
    local.duplicates = 0
    saveLocal(local)
    state.last = null
    state.sinceTop = 0
    state.shardLog = []
    applyStateToSnapshot({
      owned: local.owned,
      shards: local.shards,
      duplicates: local.duplicates,
      pulls: local.pulls,
      sinceTop: local.sinceTop,
      history: local.history,
    })

    function done() {
      render()
      toast('已清空抽卡记录、收集进度与碎片', 'ok')
    }
    if (BACKEND && state.unlocked) {
      request('/player.json', { method: 'POST', body: { action: 'reset' } })
        .then(function (res) {
          if (res && res.player && state.data) state.data.player = res.player
          done()
        })
        .catch(function (err) {
          render()
          toast('本地已清空，但服务端没清成功：' + err.message, 'error')
        })
    } else {
      done()
    }
  }

  // -------------------------------------------------------------------------
  // ⑥ 板块：后台管理
  // -------------------------------------------------------------------------

  function viewAdmin() {
    var view = state.els.view
    var wrap = el('div', { class: 'sec' })
    wrap.appendChild(sectionHead('后台管理', '改卡池、稀有度、图片目录与抽卡参数。'))

    if (READONLY) {
      wrap.appendChild(
        emptyBox('这是静态导出版，没有后台', [
          '静态站没有服务端，所以没有可写的地方 —— 所有编辑入口都已隐藏（不是权限不足）。',
          '要改内容请打开本机的 DSH 页面。',
        ])
      )
      view.appendChild(wrap)
      return
    }

    if (!state.unlocked) {
      wrap.appendChild(
        emptyBox('需要编辑秘钥', ['输对秘钥后才能改卡池与设置。', BACKEND ? '点右上角「解锁」。' : '这个页面没有配置后端。'], [
          el('div', { class: 'panel-actions' }, [
            el('button', { class: 'btn primary', type: 'button', 'data-bind': 'admin-unlock' }, ['输入秘钥']),
          ]),
        ])
      )
      view.appendChild(wrap)
      var bu = view.querySelector('[data-bind="admin-unlock"]')
      if (bu) bu.addEventListener('click', openUnlock)
      return
    }

    // 只读站绝不显示对话框
    if (state.els.pickDialog && state.els.pickDialog.open) hide(state.els.pickDialog)

    // --- 扫描卡池 ---------------------------------------------------------
    wrap.appendChild(
      el('div', { class: 'panel' }, [
        el('div', { class: 'panel-title', text: '① 扫描卡池' }),
        el('p', { class: 'panel-hint', text: '把受控目录里的图片扫成卡牌，角色名取自图片文件名。只补新图，不动已有条目的名字与稀有度。' }),
        el('div', { class: 'panel-actions' }, [
          el('button', { class: 'btn primary', type: 'button', 'data-bind': 'scan-add' }, ['扫描并补入新图']),
          el('button', { class: 'btn', type: 'button', 'data-bind': 'scan-replace' }, ['扫描并重建整个名册']),
          el('button', { class: 'btn ghost', type: 'button', 'data-bind': 'scan-images' }, ['看看目录里有哪些图']),
        ]),
        el('div', { class: 'panel-out', 'data-bind': 'scan-out' }),
      ])
    )

    // --- 设置 -------------------------------------------------------------
    // 这些字段都按「可能缺失」处理：服务端 normalize 会补齐它们，但前端不该因为
    // 一个可选字段缺失就整页崩掉（实测 s.imageDirs.join 会让整个后台白屏）。
    var s = state.data.settings || {}
    var imageDirs = Array.isArray(s.imageDirs) ? s.imageDirs : []
    wrap.appendChild(
      el('div', { class: 'panel' }, [
        el('div', { class: 'panel-title', text: '② 站点设置' }),
        field('标题', input('text', s.title, 'set-title')),
        field('副标题', input('text', s.subtitle, 'set-subtitle')),
        field('首页背景图（文件名或绝对路径）', input('text', s.coverImage, 'set-cover')),
        field('卡面比例（形如 2/3 或 832/1216）', input('text', s.cardRatio || '2/3', 'set-ratio')),
        field('图片目录（一行一个，受控白名单）', textarea(imageDirs.join('\n'), 3, 'set-dirs')),
        field('页脚说明', input('text', s.footerNote, 'set-foot')),
        el('div', { class: 'panel-actions' }, [
          el('button', { class: 'btn primary', type: 'button', 'data-bind': 'save-settings' }, ['保存设置']),
        ]),
      ])
    )

    // --- 抽卡参数 ---------------------------------------------------------
    var pull = s.pull || {}
    wrap.appendChild(
      el('div', { class: 'panel' }, [
        el('div', { class: 'panel-title', text: '③ 抽卡参数' }),
        field('单抽消耗', input('number', pull.costSingle, 'pull-single')),
        field('十连消耗（留空 = 单抽 × 10）', input('number', pull.costTen === null ? '' : pull.costTen, 'pull-ten')),
        field(
          '十连保底档位（留空 = 不保底）',
          select(
            [''].concat(rarityList().map(function (r) { return r.id })),
            pull.tenPullGuarantee || '',
            'pull-guarantee'
          )
        ),
        field('保底抽数（0 = 不启用）', input('number', pull.pityMax, 'pull-pity')),
        field('是否允许重复获得（关掉会让碎片系统失效）', select(['true', 'false'], String(pull.allowDuplicates !== false), 'pull-dup')),
        el('div', { class: 'panel-actions' }, [
          el('button', { class: 'btn primary', type: 'button', 'data-bind': 'save-pull' }, ['保存抽卡参数']),
        ]),
        el('p', { class: 'panel-hint', text: '出率权重在下面的卡池里改。' }),
      ])
    )

    // --- 碎片规则 ---------------------------------------------------------
    var shardCfg = s.shards || {}
    wrap.appendChild(
      el('div', { class: 'panel' }, [
        el('div', { class: 'panel-title', text: '③-2 碎片规则' }),
        el('p', { class: 'panel-hint', text: '抽到重复的卡（图鉴里已解锁过）会转化成对应稀有度的碎片。' }),
        field('每张重复卡给几个碎片', input('number', shardCfg.perDuplicate, 'shard-per')),
        field('兑换一张同档卡牌需要几个碎片', input('number', shardCfg.costForCard, 'shard-card')),
        field('升一级稀有度需要几个碎片', input('number', shardCfg.costForUpgrade, 'shard-up')),
        el('div', { class: 'panel-actions' }, [
          el('button', { class: 'btn primary', type: 'button', 'data-bind': 'save-shards' }, ['保存碎片规则']),
        ]),
        el('p', { class: 'panel-hint', text: '升档是「N 个碎片 -> 1 个更高一级的碎片」。如果你的意思是「N 个碎片 -> N 个更高一级的碎片」，把上面的升档数改成 1 即可。' }),
      ])
    )

    // --- 卡池 -------------------------------------------------------------
    state.data.pools.forEach(function (p) {
      var weightRows = rarityList().map(function (r) {
        return field(
          '权重 · ' + (r.label || r.id),
          input('number', p.weights && p.weights[r.id] !== undefined ? p.weights[r.id] : '', 'w-' + p.id + '-' + r.id, r.id)
        )
      })
      wrap.appendChild(
        el('div', { class: 'panel' }, [
          el('div', { class: 'panel-title' }, [
            el('span', { text: '卡池：' }),
            input('text', p.name, 'pool-name-' + p.id),
          ]),
          field('说明', input('text', p.desc, 'pool-desc-' + p.id)),
          el('div', { class: 'weight-grid' }, weightRows),
          el('div', { class: 'panel-actions' }, [
            el('button', { class: 'btn primary', type: 'button', 'data-bind': 'save-pool-' + p.id }, ['保存这个卡池']),
            el('button', { class: 'btn ghost', type: 'button', 'data-bind': 'del-pool-' + p.id }, ['删除']),
          ]),
        ])
      )
    })
    wrap.appendChild(
      el('div', { class: 'panel-actions' }, [
        el('button', { class: 'btn', type: 'button', 'data-bind': 'add-pool' }, ['新建一个卡池']),
      ])
    )

    // --- 卡牌名册 ---------------------------------------------------------
    var allSeries = Array.from(
      new Set(
        state.data.cards
          .map(function (c) { return c.series })
          .filter(Boolean)
      )
    )
    var seriesList = el('datalist', { id: 'gacha-series-list' })
    allSeries.forEach(function (nm) {
      var opt = el('option', { value: nm })
      seriesList.appendChild(opt)
    })

    wrap.appendChild(
      el('div', { class: 'panel' }, [
        el('div', { class: 'panel-title', text: '④ 卡牌名册（' + state.data.cards.length + ' 张）' }),
        el('p', { class: 'panel-hint', text: '系列：填了同一个系列名的卡在图鉴里会**一起显示**（系列组排在最前）。系列内序用来控制组内顺序，小的在前。' }),
        seriesList,
        el('div', { class: 'table-wrap' }, [
          buildCardTable(),
        ]),
      ])
    )

    // --- 秘钥 -------------------------------------------------------------
    wrap.appendChild(
      el('div', { class: 'panel' }, [
        el('div', { class: 'panel-title', text: '⑤ 编辑秘钥' }),
        el('p', { class: 'panel-hint', text: '换一枚新秘钥会让旧秘钥与所有已解锁的浏览器立即失效。' }),
        el('div', { class: 'panel-actions' }, [
          el('button', { class: 'btn', type: 'button', 'data-bind': 'rotate-key' }, ['换一枚新秘钥']),
          el('button', { class: 'btn ghost', type: 'button', 'data-bind': 'lock' }, ['锁定当前浏览器']),
        ]),
        el('div', { class: 'panel-out', 'data-bind': 'key-out' }),
      ])
    )

    view.appendChild(wrap)
    wireAdmin(view)
  }

  function field(label, control) {
    return el('label', { class: 'field' }, [
      el('span', { class: 'field-label', text: label }),
      control,
    ])
  }

  function input(type, value, bind, dataKey) {
    var attrs = { type: type, value: value === undefined || value === null ? '' : value, 'data-bind': bind }
    if (dataKey) attrs['data-key'] = dataKey
    return el('input', attrs)
  }

  function textarea(value, rows, bind) {
    var t = el('textarea', { rows: rows || 3, 'data-bind': bind })
    t.value = value === undefined || value === null ? '' : String(value)
    return t
  }

  function select(options, value, bind) {
    var s = el('select', { 'data-bind': bind })
    options.forEach(function (o) {
      var opt = el('option', { value: o, text: o === '' ? '(不保底)' : o })
      if (String(o) === String(value)) opt.selected = true
      s.appendChild(opt)
    })
    return s
  }

  function buildCardTable() {
    var table = el('table', { class: 'table' })
    table.appendChild(
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: '卡面' }),
          el('th', { text: '角色名' }),
          el('th', { text: '稀有度' }),
          el('th', { text: '系列' }),
          el('th', { text: '系列内序' }),
          el('th', { text: '图片' }),
          el('th', { text: '状态' }),
          el('th', { text: '操作' }),
        ]),
      ])
    )
    var body = el('tbody')
    var rarities = rarityList()
    // 已用过的系列名：做成 datalist 提示，避免同一个系列因为多打一个空格被拆成两组
    var seriesNames = Array.from(
      new Set(
        state.data.cards
          .map(function (c) { return c.series })
          .filter(Boolean)
      )
    )
    state.data.cards.forEach(function (c) {
      var thumb = el('div', { class: 'thumb' })
      if (c.imageUrl) thumb.appendChild(el('img', { src: c.imageUrl, alt: c.name, loading: 'lazy' }))
      else thumb.appendChild(el('span', { class: 'thumb-none', text: '无图' }))

      var sel = el('select', { 'data-card-rarity': c.id })
      var none = el('option', { value: '', text: '(未设置)' })
      if (!c.rarity) none.selected = true
      sel.appendChild(none)
      rarities.forEach(function (r) {
        var o = el('option', { value: r.id, text: r.label || r.id })
        if (r.id === c.rarity) o.selected = true
        sel.appendChild(o)
      })

      var seriesInput = input('text', c.series, 'card-series-' + c.id)
      if (seriesNames.length) {
        seriesInput.setAttribute('list', 'gacha-series-list')
        seriesInput.setAttribute('placeholder', seriesNames[0])
      }

      body.appendChild(
        el('tr', { class: c.hidden ? 'row-hidden' : '' }, [
          el('td', {}, [thumb]),
          el('td', {}, [input('text', c.name, 'card-name-' + c.id)]),
          el('td', {}, [sel]),
          el('td', {}, [seriesInput]),
          el('td', {}, [input('number', c.seriesOrder || 0, 'card-order-' + c.id)]),
          el('td', { class: 'cell-img', text: c.image || '(未填)' }),
          el('td', {}, [
            c.hidden ? el('span', { class: 'chip chip-warn', text: '已隐藏' }) : el('span', { class: 'chip', text: '显示中' }),
            c.rarityKnown ? null : el('div', { class: 'cell-warn', text: '稀有度不认识' }),
          ]),
          el('td', { class: 'cell-actions' }, [
            el('button', { class: 'btn ghost small', type: 'button', 'data-card-save': c.id }, ['保存']),
            el('button', { class: 'btn ghost small', type: 'button', 'data-card-hide': c.id }, [c.hidden ? '显示' : '隐藏']),
            el('button', { class: 'btn ghost small', type: 'button', 'data-card-pick': c.id }, ['选图']),
            el('button', { class: 'btn ghost small danger', type: 'button', 'data-card-del': c.id }, ['删除']),
          ]),
        ])
      )
    })
    table.appendChild(body)
    return table
  }

  // -------------------------------------------------------------------------
  // ⑦ 后台交互
  // -------------------------------------------------------------------------

  function wireAdmin(view) {
    function q(bind) {
      return view.querySelector('[data-bind="' + bind + '"]')
    }
    function out(bind, text, isErr) {
      var node = q(bind)
      if (!node) return
      node.textContent = text
      node.className = 'panel-out' + (isErr ? ' panel-out-err' : '')
    }

    function afterWrite(res, okMsg) {
      if (res && res.data && state.data) {
        // 服务端回传了完整快照 —— 直接换掉，避免本地推算与服务端不一致
        state.data = normalizeSnapshot(res.data)
      }
      render()
      toast(okMsg, 'ok')
    }

    function fail(err) {
      toast(err.message, 'error')
      return null
    }

    var scanAdd = q('scan-add')
    if (scanAdd) {
      scanAdd.addEventListener('click', function () {
        out('scan-out', '正在扫描…')
        request('/scan.json', { method: 'POST', body: { replace: false } })
          .then(function (res) {
            out('scan-out', '扫描到 ' + res.scanned + ' 张图，新增 ' + res.added + ' 张，已登记跳过 ' + res.skipped + ' 张。\n' + (res.hint || ''), false)
            afterWrite(res, '已补入 ' + res.added + ' 张新卡')
          })
          .catch(function (err) {
            out('scan-out', '扫描失败：' + err.message, true)
            fail(err)
          })
      })
    }

    var scanReplace = q('scan-replace')
    if (scanReplace) {
      scanReplace.addEventListener('click', function () {
        if (!window.confirm('重建会把整个卡牌名册替换成目录扫描结果 —— 你改过的角色名与稀有度都会丢失。继续？')) return
        out('scan-out', '正在重建…')
        request('/scan.json', { method: 'POST', body: { replace: true } })
          .then(function (res) {
            out('scan-out', '重建完成：' + res.added + ' 张。\n' + (res.hint || ''), false)
            afterWrite(res, '名册已重建')
          })
          .catch(function (err) {
            out('scan-out', '重建失败：' + err.message, true)
            fail(err)
          })
      })
    }

    var scanImages = q('scan-images')
    if (scanImages) {
      scanImages.addEventListener('click', function () {
        out('scan-out', '正在读取图片清单…')
        request('/images.json')
          .then(function (res) {
            var lines = ['受控目录：'].concat((res.dirs || []).map(function (d) { return '  ' + d }))
            lines.push('共 ' + (res.images || []).length + ' 张图：')
            ;(res.images || []).slice(0, 40).forEach(function (i) { lines.push('  ' + i.rel) })
            if ((res.images || []).length > 40) lines.push('  …（只列前 40 个）')
            if (res.hint) lines.push(res.hint)
            out('scan-out', lines.join('\n'), false)
          })
          .catch(function (err) {
            out('scan-out', '读取失败：' + err.message, true)
          })
      })
    }

    var saveSettings = q('save-settings')
    if (saveSettings) {
      saveSettings.addEventListener('click', function () {
        var ratioRaw = q('set-ratio') ? String(q('set-ratio').value).trim() : ''
        // 比例格式在保存前先验一次 —— 存进去一个 "2:3"（冒号）的话页面会静默用默认值，
        // 那属于「改了没生效」这类最难查的问题
        if (ratioRaw && !/^\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?$/.test(ratioRaw)) {
          window.alert('卡面比例要写成 "2/3" 或 "832/1216" 这种（斜杠），现在是：' + ratioRaw)
          return
        }
        var body = {
          title: q('set-title').value,
          subtitle: q('set-subtitle').value,
          coverImage: q('set-cover').value.trim(),
          cardRatio: ratioRaw || '2/3',
          footerNote: q('set-foot').value,
          imageDirs: q('set-dirs')
            .value.split('\n')
            .map(function (x) { return x.trim() })
            .filter(Boolean),
        }
        request('/settings.json', { method: 'POST', body: body })
          .then(function (res) { afterWrite(res, '设置已保存') })
          .catch(fail)
      })
    }

    var savePull = q('save-pull')
    if (savePull) {
      savePull.addEventListener('click', function () {
        var ten = q('pull-ten').value.trim()
        var dupSel = q('pull-dup')
        var allowDup = dupSel ? dupSel.value !== 'false' : true
        if (!allowDup) {
          // 关掉重复会让碎片系统失去来源 —— 这必须提醒，不能让人自己踩
          if (!window.confirm('关掉「允许重复获得」后，抽卡永远不会出重复卡，碎片也就永远攒不到、碎片兑换会变成死功能。确定要关吗？')) return
        }
        var body = {
          pull: {
            costSingle: Number(q('pull-single').value || 0),
            costTen: ten === '' ? null : Number(ten),
            tenPullGuarantee: q('pull-guarantee').value,
            pityMax: Number(q('pull-pity').value || 0),
            allowDuplicates: allowDup,
          },
        }
        request('/settings.json', { method: 'POST', body: body })
          .then(function (res) { afterWrite(res, '抽卡参数已保存') })
          .catch(fail)
      })
    }

    var saveShards = q('save-shards')
    if (saveShards) {
      saveShards.addEventListener('click', function () {
        function intOf(bind, fallback) {
          var node = q(bind)
          var n = Number(node ? String(node.value).trim() : '')
          return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback
        }
        request('/settings.json', {
          method: 'POST',
          body: {
            shards: {
              perDuplicate: intOf('shard-per', 1),
              costForCard: intOf('shard-card', 5),
              costForUpgrade: intOf('shard-up', 5),
            },
          },
        })
          .then(function (res) { afterWrite(res, '碎片规则已保存') })
          .catch(fail)
      })
    }

    state.data.pools.forEach(function (p) {
      var btn = q('save-pool-' + p.id)
      if (btn) {
        btn.addEventListener('click', function () {
          var weights = {}
          rarityList().forEach(function (r) {
            var inp = view.querySelector('[data-bind="w-' + p.id + '-' + r.id + '"]')
            if (!inp) return
            var v = inp.value.trim()
            if (v === '') return
            weights[r.id] = Number(v)
          })
          request('/pool/' + encodeURIComponent(p.id), {
            method: 'PUT',
            body: { name: q('pool-name-' + p.id).value, desc: q('pool-desc-' + p.id).value, weights: weights },
          })
            .then(function (res) { afterWrite(res, '卡池已保存') })
            .catch(fail)
        })
      }
      var del = q('del-pool-' + p.id)
      if (del) {
        del.addEventListener('click', function () {
          if (!window.confirm('删除卡池「' + p.name + '」？（卡牌本身不会被删）')) return
          request('/pool/' + encodeURIComponent(p.id), { method: 'DELETE' })
            .then(function (res) { afterWrite(res, '卡池已删除') })
            .catch(fail)
        })
      }
    })

    var addPool = q('add-pool')
    if (addPool) {
      addPool.addEventListener('click', function () {
        var weights = {}
        rarityList().forEach(function (r) { weights[r.id] = 0 })
        request('/pool', { method: 'POST', body: { name: '新卡池', desc: '', weights: weights } })
          .then(function (res) { afterWrite(res, '已新建卡池') })
          .catch(fail)
      })
    }

    // 卡牌表：逐行操作
    view.querySelectorAll('[data-card-save]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-card-save')
        var nameInput = view.querySelector('[data-bind="card-name-' + id + '"]')
        var rarityInput = view.querySelector('[data-card-rarity="' + id + '"]')
        var seriesInput = view.querySelector('[data-bind="card-series-' + id + '"]')
        var orderInput = view.querySelector('[data-bind="card-order-' + id + '"]')
        var name = nameInput ? nameInput.value : ''
        var orderRaw = orderInput ? String(orderInput.value).trim() : ''
        request('/card/' + encodeURIComponent(id), {
          method: 'PUT',
          body: {
            name: name,
            rarity: rarityInput ? rarityInput.value : '',
            // 系列留空 = 不属于任何系列（normalize 会存成空串）
            series: seriesInput ? seriesInput.value : '',
            seriesOrder: orderRaw === '' ? 0 : Number(orderRaw),
          },
        })
          .then(function (res) { afterWrite(res, '已保存 ' + name) })
          .catch(fail)
      })
    })
    view.querySelectorAll('[data-card-hide]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-card-hide')
        var c = cardById(id)
        request('/card/' + encodeURIComponent(id), { method: 'PUT', body: { hidden: !(c && c.hidden) } })
          .then(function (res) { afterWrite(res, c && c.hidden ? '已显示' : '已隐藏') })
          .catch(fail)
      })
    })
    view.querySelectorAll('[data-card-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-card-del')
        var c = cardById(id)
        if (!window.confirm('从名册里删除「' + (c ? c.name : id) + '」？图片文件不会被删。')) return
        request('/card/' + encodeURIComponent(id), { method: 'DELETE' })
          .then(function (res) { afterWrite(res, '已删除') })
          .catch(fail)
      })
    })
    view.querySelectorAll('[data-card-pick]').forEach(function (b) {
      b.addEventListener('click', function () { openPick(b.getAttribute('data-card-pick')) })
    })

    var rotate = q('rotate-key')
    if (rotate) {
      rotate.addEventListener('click', function () {
        if (!window.confirm('换新秘钥？旧秘钥与所有已解锁的浏览器会立即失效。')) return
        request('/auth.json', { method: 'POST', body: { action: 'rotate' } })
          .then(function (res) {
            out('key-out', '新秘钥（只显示这一次，请立刻保存）：\n\n  ' + res.key, false)
            state.unlocked = false
            render()
            toast('已换新秘钥，当前浏览器已锁定', 'ok')
          })
          .catch(function (err) { out('key-out', '换秘钥失败：' + err.message, true) })
      })
    }
    var lock = q('lock')
    if (lock) {
      lock.addEventListener('click', function () {
        request('/auth.json', { method: 'POST', body: { action: 'lock' } })
          .then(function () {
            state.unlocked = false
            render()
            toast('已锁定', 'ok')
          })
          .catch(fail)
      })
    }
  }

  /** 服务端回传的快照缺少派生字段时补齐，保证渲染代码只管读 */
  function normalizeSnapshot(data) {
    if (!data) return state.data
    if (!data.cards) data.cards = []
    return data
  }

  // -------------------------------------------------------------------------
  // ⑧ 选图对话框
  // -------------------------------------------------------------------------

  var pickTarget = null

  function openPick(cardId) {
    var dlg = state.els.pickDialog
    var grid = state.els.pickGrid
    var hint = state.els.pickHint
    var errBox = state.els.pickError
    pickTarget = cardId
    if (!dlg || !grid) return
    clear(grid)
    if (errBox) errBox.hidden = true
    if (hint) hint.textContent = '读取中…'
    showModal(dlg)

    request('/images.json')
      .then(function (res) {
        var images = res.images || []
        if (hint) {
          hint.textContent = images.length
            ? '共 ' + images.length + ' 张。点一张就把它填到这张卡上。'
            : res.hint || '受控目录里没有图片。'
        }
        renderPickGrid(images, '')
        var search = state.els.pickSearch
        if (search) {
          search.value = ''
          search.oninput = function () { renderPickGrid(images, search.value) }
        }
      })
      .catch(function (err) {
        if (hint) hint.textContent = '读取图片清单失败。'
        if (errBox) {
          errBox.hidden = false
          errBox.textContent = err.message
        }
      })
  }

  function renderPickGrid(images, query) {
    var grid = state.els.pickGrid
    clear(grid)
    var q = String(query || '').trim().toLowerCase()
    var shown = 0
    images.forEach(function (img) {
      if (q && img.rel.toLowerCase().indexOf(q) === -1) return
      shown++
      var cell = el('button', { class: 'pick-cell', type: 'button', title: img.rel })
      var src = (CFG.api || '') + '/image?src=' + encodeURIComponent(img.rel)
      cell.appendChild(el('img', { src: src, alt: img.name, loading: 'lazy' }))
      cell.appendChild(el('span', { class: 'pick-name', text: img.rel }))
      cell.addEventListener('click', function () {
        if (!pickTarget) return
        var id = pickTarget
        request('/card/' + encodeURIComponent(id), { method: 'PUT', body: { image: img.rel } })
          .then(function (res) {
            hide(state.els.pickDialog)
            afterPickWrite(res, '已把卡面设为 ' + img.rel)
          })
          .catch(function (err) {
            if (state.els.pickError) {
              state.els.pickError.hidden = false
              state.els.pickError.textContent = err.message
            }
          })
      })
      grid.appendChild(cell)
    })
    if (!shown) grid.appendChild(el('div', { class: 'panel-hint', text: '没有匹配的图片。' }))
  }

  function afterPickWrite(res, msg) {
    if (res && res.data && state.data) state.data = normalizeSnapshot(res.data)
    render()
    toast(msg, 'ok')
  }

  // -------------------------------------------------------------------------
  // ⑧ 秘钥对话框
  // -------------------------------------------------------------------------

  function openUnlock() {
    var dlg = state.els.unlockDialog
    if (!dlg) return
    if (state.els.keyError) state.els.keyError.hidden = true
    if (state.els.keyInput) state.els.keyInput.value = ''
    showModal(dlg)
    if (state.els.keyInput) state.els.keyInput.focus()
  }

  function showModal(dlg) {
    if (!dlg) return
    // 原生 <dialog>：不用自己写遮罩。老浏览器没有 showModal 时退回 open 属性
    if (typeof dlg.showModal === 'function') {
      try {
        dlg.showModal()
        return
      } catch (err) {}
    }
    dlg.setAttribute('open', '')
  }

  function hide(dlg) {
    if (!dlg) return
    if (typeof dlg.close === 'function') {
      try {
        dlg.close()
        return
      } catch (err) {}
    }
    dlg.removeAttribute('open')
  }

  /**
   * 提交秘钥。
   *
   * ⚠️ 只发一次请求。早先的写法先发一次「不带 key 的探测请求」再发真的 ——
   * 那会白白消耗服务端的登录失败熔断次数（5 次锁 1 分钟），
   * 等于让正常人输入正确的秘钥也可能被锁。
   */
  function submitKeyOnce() {
    var key = state.els.keyInput ? state.els.keyInput.value : ''
    var errBox = state.els.keyError
    if (!key) {
      if (errBox) {
        errBox.hidden = false
        errBox.textContent = '请输入秘钥。'
      }
      return
    }
    var btn = state.els.keySubmit
    if (btn) btn.disabled = true
    request('/auth.json', { method: 'POST', body: { action: 'unlock', key: key } })
      .then(function () {
        state.unlocked = true
        hide(state.els.unlockDialog)
        // 解锁后重新拉一次快照（服务端会带上 player 与 unlocked）
        return loadData()
      })
      .then(function () {
        render()
        toast('已解锁，可以编辑了', 'ok')
      })
      .catch(function (err) {
        if (errBox) {
          errBox.hidden = false
          errBox.textContent = err.message
        }
      })
      .then(function () {
        if (btn) btn.disabled = false
      })
  }

  // -------------------------------------------------------------------------
  // ⑨ 渲染与启动
  // -------------------------------------------------------------------------

  function renderNav() {
    var nav = state.els.nav
    if (!nav) return
    clear(nav)
    SECTIONS.forEach(function (sec) {
      // 只读时不渲染编辑入口，而不是渲染了点了报错
      if (sec.needsEdit && READONLY) return
      var active = state.route === sec.id
      var a = el('a', { class: 'nav-link' + (active ? ' nav-on' : ''), href: sec.hash, text: sec.label })
      nav.appendChild(a)
    })
  }

  function renderChrome() {
    var e = state.els
    var d = state.data
    if (!d) return

    if (e.brandTitle) e.brandTitle.textContent = d.settings.title || '魔法少女抽卡'
    // 配置坏了就不许覆盖标题 —— 那个标题是唯一的失败痕迹
    if (!state.configBroken) {
      document.title = (d.settings.title || '魔法少女抽卡') + (state.route === 'draw' ? '' : ' · ' + state.route)
    }

    if (e.footNote) e.footNote.textContent = d.settings.footerNote || ''
    if (e.footMeta) {
      var stats = d.stats || {}
      var total = stats.total !== undefined ? stats.total : d.cards.length
      e.footMeta.textContent =
        (BACKEND ? '本机 DSH' : '静态站（只读）') +
        ' · 卡牌 ' + total + ' 张' +
        (stats.playable !== undefined && stats.playable !== total ? '（可抽 ' + stats.playable + '）' : '') +
        (state.warning ? ' · ⚠ ' + state.warning : '')
    }

    if (e.warning) {
      e.warning.hidden = !state.warning
      e.warning.textContent = state.warning ? '⚠ ' + state.warning : ''
      e.warning.title = state.warning || ''
    }

    // 货币：只有抽卡真的要花东西时才显示。用户给定的机制里抽卡是免费的
    // （costSingle = 0），这时显示「0 抽卡券」只会让人困惑「我该去哪弄券」。
    if (e.currency) {
      var pullCfg = (d.settings && d.settings.pull) || {}
      var usesCurrency = Number(pullCfg.costSingle || 0) > 0 || Number(pullCfg.costTen || 0) > 0
      e.currency.hidden = !usesCurrency
      if (usesCurrency) e.currency.textContent = fmt(player().currency) + ' ' + (player().currencyName || '抽卡券')
    }

    // 碎片总览：抽卡页与碎片页都显示，点得动（跳到碎片兑换）
    if (e.shardChip) {
      var sh = shards()
      var total = 0
      var detail = []
      for (var si = 0; si < rarityList().length; si++) {
        var rid = rarityList()[si].id
        var n = Number(sh[rid] || 0)
        if (n > 0) {
          total += n
          detail.push((rarityList()[si].label || rid) + ' ' + n)
        }
      }
      var showShard = state.route === 'draw' || state.route === 'shards' || state.route === 'collection'
      e.shardChip.hidden = !showShard
      if (showShard) {
        e.shardChip.textContent = '碎片 ' + total
        e.shardChip.title = total ? detail.join(' · ') : '还没有碎片：抽到重复的卡才会产生碎片'
      }
    }

    // 只读站不显示秘钥相关按钮
    if (e.unlockBtn) e.unlockBtn.hidden = READONLY || state.unlocked
    if (e.lockBtn) e.lockBtn.hidden = READONLY || !state.unlocked

    // 首页封面：有就挂上去（背景图走 CSSOM —— CSP 不管它）
    if (e.view && d.settings.coverImageUrl) {
      e.view.style.backgroundImage = 'url("' + d.settings.coverImageUrl + '")'
      e.view.classList.add('has-cover')
    } else if (e.view) {
      e.view.style.backgroundImage = ''
      e.view.classList.remove('has-cover')
    }

    // 卡面比例：数据驱动。写 "832/1216" 或 "832 / 1216" 都能解析。
    // 为什么不用写死 2:3：实际资源里大多数图并不是精确 2:3，按主力图的真实比例
    // 显示才能让卡面完全贴合、不留白边。解析不出来时保留 CSS 默认值，
    // 但要在 Console 里说一声（值写错了不该完全无声）。
    if (e.view && d.settings.cardRatio) {
      var ratioMatch = String(d.settings.cardRatio).match(/^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/)
      if (ratioMatch && Number(ratioMatch[2]) !== 0) {
        e.view.style.setProperty('--card-ratio', ratioMatch[1] + ' / ' + ratioMatch[2])
      } else {
        console.warn('[gacha] settings.cardRatio 格式不对（应形如 "832/1216"）：' + d.settings.cardRatio)
      }
    }
  }

  function render() {
    if (!state.data) return
    var route = parseRoute()
    state.route = route.route
    state.routeArg = route.arg

    renderNav()
    renderChrome()

    var view = state.els.view
    clear(view)

    if (route.bad) {
      view.appendChild(
        emptyBox('没有这个板块：' + route.bad, ['已回到抽卡页。可用的板块见顶栏。'])
      )
    }

    // 抽卡状态：从服务端快照或本地存储取
    state.sinceTop = Number(player().sinceTop || 0)

    // 渲染任何一个板块抛错，都不该变成一页白屏。
    // 白屏最难查 —— 没有任何线索；把错误本身画出来，至少能立刻定位。
    try {
      if (state.route === 'draw') viewDraw()
      else if (state.route === 'pool') viewPool()
      else if (state.route === 'collection') viewCollection()
      else if (state.route === 'shards') viewShards()
      else if (state.route === 'history') viewHistory()
      else if (state.route === 'admin') viewAdmin()
    } catch (err) {
      console.error('[gacha] 渲染板块「' + state.route + '」时出错：', err)
      clear(view)
      view.appendChild(
        el('div', { class: 'panel panel-warn' }, [
          el('div', { class: 'panel-title', text: '这个板块渲染失败了' }),
          el('p', { class: 'panel-hint', text: '页面脚本抛了异常，所以这里是空的。下面是原始错误 —— 请把这个信息贴给作者。' }),
          el('div', { class: 'panel-out panel-out-err', text: '板块：' + state.route + '\n' + String((err && err.message) || err) + '\n\n' + String((err && err.stack) || '') }),
          el('div', { class: 'panel-actions' }, [
            el('button', { class: 'btn', type: 'button', 'data-bind': 'render-retry' }, ['重试渲染']),
            el('a', { class: 'btn ghost', href: '#/draw', text: '回到抽卡页' }),
          ]),
        ])
      )
      var retry = view.querySelector('[data-bind="render-retry"]')
      if (retry) retry.addEventListener('click', function () { render() })
    }
  }

  /**
   * 把 data-bind 的连字符名字转成 camelCase。
   *
   * ⚠️ 这里必须转：page.html 用 `data-bind="brand-title"` 标注元素，而代码里读的是
   * `state.els.brandTitle`。如果直接用连字符当键，那些元素**全都接不上** ——
   * renderChrome() 会在第一行 return 掉，表现成「品牌名是空的、页脚是空的、
   * 解锁按钮该隐藏却没隐藏」，而且不报任何错。
   */
  function camel(s) {
    return String(s).replace(/-([a-z0-9])/g, function (_, c) {
      return c.toUpperCase()
    })
  }

  function cacheEls() {
    var e = state.els
    var byBind = document.querySelectorAll('[data-bind]')
    for (var i = 0; i < byBind.length; i++) {
      var b = byBind[i]
      var name = camel(b.getAttribute('data-bind'))
      // 同一个 bind 名可能有多个节点（各板块各一份），保留第一个即可
      if (!e[name]) e[name] = b
    }
    e.announce = document.getElementById('announce')
    e.toast = document.getElementById('toast')
    e.unlockDialog = document.getElementById('unlock-dialog')
    e.pickDialog = document.getElementById('pick-dialog')

    // 缺失的绑定必须说出来 —— 否则只会表现成「某个角落不更新」，极难定位
    var REQUIRED = ['view', 'nav', 'brandTitle', 'warning', 'currency', 'shardChip', 'unlockBtn', 'lockBtn', 'toast']
    var missing = REQUIRED.filter(function (k) {
      return !e[k]
    })
    if (missing.length) {
      console.error('[gacha] page.html 缺少这些 data-bind 元素：' + missing.join(', '))
    }
  }

  function wire() {
    var e = state.els
    if (e.unlockBtn) e.unlockBtn.addEventListener('click', openUnlock)
    if (e.lockBtn) {
      e.lockBtn.addEventListener('click', function () {
        request('/auth.json', { method: 'POST', body: { action: 'lock' } })
          .then(function () {
            state.unlocked = false
            render()
            toast('已锁定', 'ok')
          })
          .catch(function (err) { toast(err.message, 'error') })
      })
    }
    if (e.keyCancel) e.keyCancel.addEventListener('click', function () { hide(e.unlockDialog) })
    if (e.keySubmit) e.keySubmit.addEventListener('click', submitKeyOnce)
    if (e.keyInput) {
      e.keyInput.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault()
          submitKeyOnce()
        }
      })
    }
    if (e.pickCancel) e.pickCancel.addEventListener('click', function () { hide(e.pickDialog) })
    if (e.shardChip) {
      e.shardChip.addEventListener('click', function () { go('#/shards') })
    }

    window.addEventListener('hashchange', render)
  }

  function loadData() {
    // 静态站：数据内联在页面里，一个网络请求都不发
    var inline = readInlineData()
    if (inline) {
      state.data = normalizeSnapshot(inline)
      state.unlocked = false
      state.poolId = state.data.pools && state.data.pools.length ? state.data.pools[0].id : ''
      return Promise.resolve()
    }
    return request('/data.json')
      .then(function (res) {
        state.data = normalizeSnapshot(res.data)
        state.unlocked = !!res.unlocked
        state.hasKey = !!res.hasKey
        state.warning = res.warning || ''
        if (!state.poolId && state.data.pools && state.data.pools.length) state.poolId = state.data.pools[0].id
        // 恢复上次抽卡结果（跨刷新）
        if (!state.last) {
          var saved = lsGet(LS.last, null)
          if (saved && saved.ids && saved.ids.length) {
            var results = []
            for (var i = 0; i < saved.ids.length; i++) {
              var c = cardById(saved.ids[i])
              if (c) results.push({ card: c, rarityId: c.rarity, isNew: false })
            }
            if (results.length) state.last = { poolId: saved.poolId, at: saved.at, results: results }
          }
        }
      })
      .catch(function (err) {
        state.warning = '卡池数据加载失败：' + err.message
        state.data = normalizeSnapshot({ settings: { pull: {} }, rarities: [], pools: [], cards: [] })
        var view = state.els.view
        if (view) {
          clear(view)
          view.appendChild(
            emptyBox('卡池数据加载失败', [
              err.message,
              '如果是刚改完服务端代码，需要重启 dsh web（lib/** 只在启动时挂载）。',
            ])
          )
        }
        throw err
      })
  }

  function readInlineData() {
    var node = document.getElementById('gacha-data')
    if (!node) return null
    try {
      return JSON.parse(node.textContent || 'null')
    } catch (err) {
      console.error('[gacha] 内联数据（#gacha-data）不是合法 JSON', err)
      return null
    }
  }

  function boot() {
    cacheEls()
    wire()
    loadData()
      .then(function () {
        render()
        var route = parseRoute()
        if (route.bad) window.location.hash = '#/draw'
      })
      .catch(function () {
        // loadData 已经画了错误面板，这里只保证顶栏还是有内容的
        renderNav()
      })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()

  // 给测试用的出口（test-client.mjs 会在 DOM shim 上调用它）。
  // 把 CFG / READONLY / API 一起暴露出来，测试才能直接断言「页面自己以为的运行模式」，
  // 而不是从渲染结果反推 —— 反推在出问题时恰好是最不可靠的。
  window.__gacha = {
    state: state,
    CFG: CFG,
    API: API,
    BACKEND: BACKEND,
    READONLY: READONLY,
    // 状态访问器也暴露出来：测试要能直接断言「页面读到的状态是哪一份」，
    // 而不是从渲染结果反推（反推在出问题时恰好最不可靠）
    localState: localState,
    player: player,
    collection: collection,
    shards: shards,
    render: render,
    boot: boot,
    runDraw: runDraw,
    parseRoute: parseRoute,
    cardFigure: cardFigure,
    el: el,
    canEdit: canEdit,
  }
})()
