/**
 * reveal.js — 抽卡动画（纯色发光卡 → 翻牌 → 逐张揭示）
 *
 * 需求来自用户，逐条对应：
 *
 *   **单抽**：出现一张纯色的发光卡牌（SR 白 / SSR 蓝 / UR 金 / ??? 红），
 *   品质越高背景越暗（显得卡牌发光强烈）。点击卡牌 → 翻转变为实际抽到的卡；
 *   再点击任意位置 → 回到结果视图。
 *
 *   **十连**：出现堆叠的一堆纯色卡牌（牌面正对屏幕），最上方是一张空白卡牌。
 *   若本次出现 UR / ???，牌堆边缘隐约透出金光 / 红光。
 *   点击或拖拽（**各个方向**；纯点击默认向右滑）逐张查看：
 *   上一张**完全移走之后**，底下那张的卡面才显示出来（从纯色翻成卡图）。
 *   轮到 UR / ??? 时，牌堆随拖拽**放大**、光溢出来，上一张移走后它迅速缩回正常
 *   大小并翻面，同时弹出表情包。
 *   全部揭示完之后，再点一下回到结果视图。
 *
 * ---------------------------------------------------------------------------
 * 为什么分成两层
 * ---------------------------------------------------------------------------
 * 配色、背景暗度、排序、牌堆顺序这些**几何与内容决策**写成纯函数，
 * 由 scripts/test-reveal.mjs 直接测（动画本身没法在 Node 里"看"，但它的
 * 输入输出可以）。DOM 那一层只负责播放，尽量不含判断。
 *
 * 与 draw.js / shards.js 一样：浏览器脚本 + CommonJS 双挂载。
 */
;(function (root) {
  'use strict'

  // =========================================================================
  // 纯函数层
  // =========================================================================

  var FALLBACK_REVEAL = {
    enabled: true,
    colors: { SR: '#ffffff', SSR: '#4aa3ff', UR: '#ffd257', '???': '#ff3b3b' },
    backdropBase: 0.42,
    backdropStep: 0.13,
    dragScale: 0.1,
    dragScaleTop: 0.18,
    emojiRarities: ['UR', '???'],
  }

  function revealCfg(reveal) {
    var r = reveal && typeof reveal === 'object' ? reveal : {}
    var colors = {}
    var src = r.colors && typeof r.colors === 'object' ? r.colors : {}
    for (var k in FALLBACK_REVEAL.colors) {
      if (Object.prototype.hasOwnProperty.call(FALLBACK_REVEAL.colors, k)) {
        colors[k] = src[k] || FALLBACK_REVEAL.colors[k]
      }
    }
    for (var k2 in src) {
      if (Object.prototype.hasOwnProperty.call(src, k2) && !colors[k2]) colors[k2] = src[k2]
    }
    var numOr = function (v, fb) {
      var n = Number(v)
      return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fb
    }
    return {
      enabled: r.enabled === undefined ? FALLBACK_REVEAL.enabled : !!r.enabled,
      colors: colors,
      backdropBase: numOr(r.backdropBase, FALLBACK_REVEAL.backdropBase),
      backdropStep: numOr(r.backdropStep, FALLBACK_REVEAL.backdropStep),
      dragScale: numOr(r.dragScale, FALLBACK_REVEAL.dragScale),
      dragScaleTop: numOr(r.dragScaleTop, FALLBACK_REVEAL.dragScaleTop),
      emojiRarities: Array.isArray(r.emojiRarities) && r.emojiRarities.length
        ? r.emojiRarities.slice()
        : FALLBACK_REVEAL.emojiRarities.slice(),
    }
  }

  /** 纯色卡与光晕的颜色。认不出的档位给白色 —— 绝不返回空串（那会让卡变成透明）。 */
  function colorFor(rarityId, reveal) {
    var cfg = revealCfg(reveal)
    var c = cfg.colors[rarityId]
    return c || '#ffffff'
  }

  /** 某个档位的 rank（取不到时给 0） */
  function rankOf(rarityId, rarities) {
    var list = rarities || []
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === rarityId) return Number(list[i].rank || 0)
    }
    return 0
  }

  /**
   * 光晕强度倍数：品质越高越亮。
   *
   * 背景变暗（backdropFor）已经在视觉上把高稀有度衬托出来了，这里再加一层，
   * 让纯色卡本身的辉光也随档位增强。两者叠加才是需求里说的「发光强烈」。
   */
  function glowFor(rarityId, rarities) {
    var rank = rankOf(rarityId, rarities)
    return 1 + Math.max(0, rank - 1) * 0.45
  }

  /**
   * 背景暗度 [0,1]：品质越高越暗（这样纯色卡看起来越「发光」）。
   * 用 rank 递推，rank 越大越暗；同时在「本次结果里最高的那一档」达到最暗，
   * 这样单抽抽到 SSR 时的观感不会因为卡池里有 ??? 而显得平淡。
   */
  function backdropFor(rarityId, rarities, reveal) {
    var cfg = revealCfg(reveal)
    var list = (rarities || []).slice().sort(function (a, b) {
      return Number(a.rank || 0) - Number(b.rank || 0)
    })
    if (!list.length) return cfg.backdropBase
    var rank = rankOf(rarityId, list)
    // 最低档 -> backdropBase，最高档 -> backdropBase + step*(档位数-1)
    var idx = 0
    for (var i = 0; i < list.length; i++) if (Number(list[i].rank || 0) <= rank) idx = i
    return Math.min(1, cfg.backdropBase + cfg.backdropStep * idx)
  }

  /**
   * 结果按稀有度**从高到低**排。
   *
   * 同档位保持抽到的先后顺序（稳定排序）—— 十连里出了两张 UR 时，
   * 先抽到的那张应该排在前面，否则「谁先出的」这个信息就没了。
   */
  function sortByRarity(items, rarities) {
    var list = (items || []).slice()
    // 记下原始位置，保证同档稳定
    for (var i = 0; i < list.length; i++) list[i].__ord = i
    list.sort(function (a, b) {
      var d = rankOf(b.rarityId, rarities) - rankOf(a.rarityId, rarities)
      if (d !== 0) return d
      return a.__ord - b.__ord
    })
    for (var j = 0; j < list.length; j++) delete list[j].__ord
    return list
  }

  /** 本次结果里最高的那一档的 id（空结果返回 ''） */
  function topTierOf(items, rarities) {
    var best = ''
    var bestRank = -1
    for (var i = 0; i < (items || []).length; i++) {
      var r = rankOf(items[i].rarityId, rarities)
      if (r > bestRank) {
        bestRank = r
        best = items[i].rarityId
      }
    }
    return best
  }

  /**
   * 牌堆的揭示顺序：**先一张空白卡牌**，然后按抽到的先后。
   *
   * 为什么按抽到顺序而不是稀有度顺序：动画的乐趣在「一张张揭」，
   * 按稀有度排会剧透（第一张就是最高档）。结果视图才按稀有度排。
   * @returns {Array<{blank:boolean, item:object|null}>}
   */
  function revealOrder(items) {
    var out = [{ blank: true, item: null }]
    for (var i = 0; i < (items || []).length; i++) out.push({ blank: false, item: items[i] })
    return out
  }

  /** 这一档要不要弹表情包、弹哪张 */
  function emojiFor(rarityId, reveal, emojiUrls) {
    var cfg = revealCfg(reveal)
    if (cfg.emojiRarities.indexOf(rarityId) < 0) return ''
    var urls = emojiUrls || {}
    return urls[rarityId] || ''
  }

  /** 牌堆边缘的光：本次最高的档位属于「值得庆祝」的那几档时，用它的颜色透出来 */
  function edgeGlowRarity(items, rarities, reveal) {
    var top = topTierOf(items, rarities)
    if (!top) return ''
    var cfg = revealCfg(reveal)
    return cfg.emojiRarities.indexOf(top) >= 0 ? top : ''
  }

  // =========================================================================
  // DOM 动画层
  // =========================================================================

  var SWIPE_THRESHOLD = 56 // px，超过就算滑动（以下算点击）
  var OUT_MS = 300 // 上一张移走的时长
  var FLIP_MS = 520 // 翻牌时长
  var REVEAL_DELAY = 40 // 上一张完全移走后，稍等一拍再翻，让「露出」这一步看得见

  function el(doc, tag, cls, text) {
    var n = doc.createElement(tag)
    if (cls) n.className = cls
    if (text !== undefined && text !== null) n.textContent = String(text)
    return n
  }

  function rm(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node)
  }

  function prefersReducedMotion(win) {
    try {
      return !!(win && win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches)
    } catch (e) {
      return false
    }
  }

  /**
   * 播放抽卡动画。
   *
   * @param {object} opts
   *   @param {Document} [opts.document]
   *   @param {Window} [opts.window]
   *   @param {'single'|'ten'} opts.mode
   *   @param {Array} opts.items  [{ rarityId, name, faceEl }]  faceEl 由调用方建好
   *                              （这样能复用 cardFigure 的占位与「读不到图」提示）
   *   @param {Array} [opts.rarities]
   *   @param {object} [opts.reveal]      settings.reveal
   *   @param {object} [opts.emojiUrls]   { UR: url }
   *   @returns {Promise<'played'|'skipped'|'empty'>}
   */
  function play(opts) {
    opts = opts || {}
    var win = opts.window || root
    var doc = opts.document || (win && win.document)
    var cfg = revealCfg(opts.reveal)
    var items = opts.items || []

    if (!doc) return Promise.resolve('skipped')
    if (!items.length) return Promise.resolve('empty')
    // 关掉动画，或者读者系统设了「减少动态效果」—— 都直接回结果视图。
    // reduced-motion 不是「可选优化」：那是使用者的明确偏好。
    if (!cfg.enabled) return Promise.resolve('skipped')
    if (prefersReducedMotion(win)) return Promise.resolve('skipped')

    return new Promise(function (resolve) {
      var overlay = el(doc, 'div', 'rv-overlay')
      var stage = el(doc, 'div', 'rv-stage')
      overlay.appendChild(stage)
      var hints = el(doc, 'div', 'rv-hints')
      var hint = el(doc, 'div', 'rv-hint')
      var progress = el(doc, 'div', 'rv-progress')
      hints.appendChild(hint)
      hints.appendChild(progress)
      overlay.appendChild(hints)

      // 跳过按钮必须有：动画是模态弹层，页面上的按钮点不到。
      // 不给一个明确的出口，读者只能猜 Esc。
      var skipBtn = el(doc, 'button', 'rv-skip', '跳过 ▸')
      skipBtn.setAttribute('type', 'button')
      skipBtn.addEventListener('click', function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation()
        finish('played')
      })
      // 按钮上的 pointerdown 不能触发「推进一步」，否则点跳过会顺便翻一张
      skipBtn.addEventListener('pointerdown', function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation()
      })
      overlay.appendChild(skipBtn)

      // 弹层打开期间禁止页面滚动 —— 否则在触屏上拖动会把背景一起滚走
      var prevOverflow = doc.body ? doc.body.style.overflow : ''
      if (doc.body) doc.body.style.overflow = 'hidden'

      var closed = false
      // 事件处理器先声明成 null，两个分支各自赋值。
      // 不这么做的话 detach() 会在另一个分支里拿到 undefined ——
      // removeEventListener(fn) 传 undefined 在真浏览器里是安全的空操作，
      // 但在测试用的 shim 上会炸，而且症状与真正的 bug 无关。
      var onDown = null
      var onMove = null
      var onUp = null
      var onKey = null

      function finish(result) {
        if (closed) return
        closed = true
        detach()
        if (doc.body) doc.body.style.overflow = prevOverflow
        // 先淡出再移除，避免「啪」地消失
        overlay.classList.remove('is-in')
        var done = function () {
          rm(overlay)
          resolve(result)
        }
        if (win && win.setTimeout) win.setTimeout(done, 180)
        else done()
      }

      function detach() {
        var pairs = [
          ['pointerdown', onDown],
          ['pointermove', onMove],
          ['pointerup', onUp],
          ['pointercancel', onUp],
          ['keydown', onKey],
        ]
        for (var i = 0; i < pairs.length; i++) {
          if (typeof pairs[i][1] === 'function') overlay.removeEventListener(pairs[i][0], pairs[i][1])
        }
        if (typeof onKey === 'function') doc.removeEventListener('keydown', onKey)
      }

      var api = {
        el: overlay,
        finish: finish,
        // 给测试用：不依赖真实指针事件也能推进一步
        advance: function () {},
        state: function () {
          return { mode: opts.mode, index: idx, total: steps.length }
        },
      }

      // ---------------------------------------------------------------------
      // 表情包：**两个分支都要用**，所以必须建在公共区。
      //
      // ⚠️ 这里踩过一次：showEmoji 原本定义在十连分支的 `else { }` 里面，
      // 而严格模式下块级函数声明是**块作用域**的 —— 单抽分支调用它直接
      // ReferenceError。症状是「单抽抽到 UR 时动画崩掉」，
      // 而报错信息指向的是单抽那一行，很容易往错的方向查。
      // ---------------------------------------------------------------------
      var emojiBox = el(doc, 'div', 'rv-emoji')
      emojiBox.hidden = true
      stage.appendChild(emojiBox)

      function showEmoji(url) {
        if (!url) return
        emojiBox.textContent = ''
        var img = el(doc, 'img')
        img.setAttribute('src', url)
        img.setAttribute('alt', '抽到了！')
        img.addEventListener('error', function () {
          // 表情包读不到不能静默 —— 但也不该挡住动画，所以在框里写一行原因
          emojiBox.textContent = ''
          emojiBox.appendChild(el(doc, 'span', 'rv-emoji-err', '表情包读不到：' + url))
        })
        emojiBox.appendChild(img)
        emojiBox.hidden = false
        emojiBox.classList.add('is-in')
        if (win.setTimeout) {
          win.setTimeout(function () {
            emojiBox.classList.remove('is-in')
            win.setTimeout(function () {
              emojiBox.hidden = true
            }, 260)
          }, 1400)
        }
      }

      // ---------------------------------------------------------------------
      // 单抽：一张纯色卡 → 点击翻牌 → 再点击关闭
      // ---------------------------------------------------------------------
      if (opts.mode !== 'ten') {
        var item = items[0]
        overlay.setAttribute('data-mode', 'single')
        overlay.style.setProperty('--rv-backdrop', String(backdropFor(item.rarityId, opts.rarities, opts.reveal)))
        overlay.style.setProperty('--rv-color', colorFor(item.rarityId, opts.reveal))

        var card = buildCard(doc, item, opts.reveal, false, opts.rarities)
        card.classList.add('rv-single')
        card.style.setProperty('--rv-i', '0')
        stage.appendChild(card)

        var revealed = false
        hint.textContent = '点击卡牌翻开'
        progress.textContent = ''

        var openSingle = function () {
          if (!revealed) {
            revealed = true
            card.classList.add('is-revealed')
            hint.textContent = '点击任意位置查看结果'
            showEmoji(emojiFor(item.rarityId, opts.reveal, opts.emojiUrls))
            return
          }
          finish('played')
        }
        api.advance = openSingle

        onDown = function (ev) {
          // 点卡牌本身与点空白处都是「推进」——需求就是这么说的
          if (ev && ev.preventDefault) ev.preventDefault()
          openSingle()
        }
        onKey = function (ev) {
          if (!ev) return
          if (ev.key === 'Escape') return finish('played')
          if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
            if (ev.preventDefault) ev.preventDefault()
            openSingle()
          }
        }
      } else {
        // -------------------------------------------------------------------
        // 十连：空白卡 + 逐张揭示
        // -------------------------------------------------------------------
        overlay.setAttribute('data-mode', 'ten')
        var steps = revealOrder(items)
        var idx = 0
        var busy = false

        var edge = edgeGlowRarity(items, opts.rarities, opts.reveal)
        overlay.setAttribute('data-edge', edge || 'none')
        if (edge) overlay.style.setProperty('--rv-edge', colorFor(edge, opts.reveal))

        var stack = el(doc, 'div', 'rv-stack')
        stage.appendChild(stack)

        // 从底往上建，这样 DOM 顺序就是「上面那张在后面」-> z-index 自然正确
        var cards = []
        for (var i = steps.length - 1; i >= 0; i--) {
          var st = steps[i]
          var c = st.blank
            ? buildBlank(doc)
            : buildCard(doc, st.item, opts.reveal, false, opts.rarities)
          c.setAttribute('data-step', String(i))
          // 层序：0 是最上面那张。CSS 用它把牌堆错开一点，让「一叠牌」看得出来
          c.style.setProperty('--rv-i', String(i))
          stack.appendChild(c)
          cards[i] = c
        }

        function updateChrome() {
          // steps[0] 是空白卡，所以「所有结果都揭示完」= idx 到了最后一张的序号。
          // ⚠️ 用 steps.length - 1 而不是 steps.length ——
          // 写成 steps.length 的话这个条件永远不成立（空白卡多占了一格），
          // 于是「查看全部结果」的提示永远不出现，而最后一张也会被多余地移走。
          var allRevealed = idx >= steps.length - 1
          progress.textContent = idx > 0 ? Math.min(idx, items.length) + ' / ' + items.length : ''
          hint.textContent =
            idx === 0
              ? '点击或向任意方向滑动，翻开第一张'
              : allRevealed
              ? '点击任意位置查看全部结果'
              : '点击或滑动，继续翻开'
          overlay.setAttribute('data-done', allRevealed ? '1' : '0')
        }
        updateChrome()

        function revealCurrent() {
          var c = cards[idx]
          if (!c) return
          var st = steps[idx]
          if (st.blank) return
          c.classList.add('is-revealed')
          var url = emojiFor(st.item.rarityId, opts.reveal, opts.emojiUrls)
          if (url) showEmoji(url)
        }

        /** 推进一步：把当前顶上的卡移走，然后揭示下面那张 */
        function step(dirX, dirY) {
          if (busy || closed) return
          // 所有结果都揭示完了 -> 再点就是**结束**，不再把最后一张也移走。
          // （把最后一张也移走会露出空牌堆，然后才结束 —— 观感上像「少了一张」。）
          if (idx >= steps.length - 1) return finish('played')
          busy = true

          var c = cards[idx]
          var nextStep = steps[idx + 1]
          var nextIsTop = !!(
            nextStep &&
            !nextStep.blank &&
            cfg.emojiRarities.indexOf(nextStep.item.rarityId) >= 0
          )

          // 卡堆随拖拽放大（要揭的下一张是 UR/??? 时放大得更多）
          if (nextIsTop) {
            stack.classList.add('rv-stack-hype')
            if (c) c.classList.add('rv-out-hype')
          }

          // 移走的方向：按拖动方向；纯点击时走默认向右
          var dist = Math.sqrt(dirX * dirX + dirY * dirY)
          var ux = 0
          var uy = 0
          if (dist < 1) {
            ux = 1
          } else {
            ux = dirX / dist
            uy = dirY / dist
          }
          var travel = 900
          var tx = ux * travel
          var ty = uy * travel
          var rot = (ux || 0.001) * 22

          if (c) {
            c.classList.add('rv-out')
            c.style.transform =
              'translate(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px) rotate(' + rot.toFixed(1) + 'deg)'
            c.style.opacity = '0'
          }

          var after = function () {
            if (c) {
              c.hidden = true
              c.classList.remove('rv-out', 'rv-out-hype')
            }
            idx++
            // 撤销放大：UR/??? 是「迅速变回普通大小」，普通档位本来就没放大
            stack.classList.remove('rv-stack-hype')
            // 上一张**完全移走之后**才揭示卡面 —— 这是需求里明确的一步
            if (win.setTimeout) {
              win.setTimeout(function () {
                revealCurrent()
                busy = false
                updateChrome()
              }, REVEAL_DELAY)
            } else {
              revealCurrent()
              busy = false
              updateChrome()
            }
          }
          if (win.setTimeout) win.setTimeout(after, OUT_MS)
          else after()
        }
        api.advance = step

        var drag = null
        onDown = function (ev) {
          if (busy || closed) return
          drag = {
            x: ev.clientX || 0,
            y: ev.clientY || 0,
            moved: 0,
            id: ev.pointerId,
          }
          var c = cards[idx]
          if (c) {
            c.classList.add('rv-dragging')
            c.style.transform = 'none'
          }
        }
        onMove = function (ev) {
          if (!drag || busy || closed) return
          var dx = (ev.clientX || 0) - drag.x
          var dy = (ev.clientY || 0) - drag.y
          drag.moved = Math.max(drag.moved, Math.sqrt(dx * dx + dy * dy))
          var c = cards[idx]
          if (c) c.style.transform = 'translate(' + dx + 'px,' + dy + 'px)'
          // 拖到一定程度就开始放大牌堆 —— 让「要出大货」这件事在拖的过程中就有感觉
          var p = Math.min(1, drag.moved / 160)
          var dragNextIsTop = (function () {
            var ns = steps[idx + 1]
            return !!(ns && !ns.blank && cfg.emojiRarities.indexOf(ns.item.rarityId) >= 0)
          })()
          var scaleBase = 1 + p * (dragNextIsTop ? cfg.dragScaleTop : cfg.dragScale)
          stack.style.transform = 'scale(' + scaleBase.toFixed(3) + ')'
        }
        onUp = function (ev) {
          if (!drag || closed) return
          var dx = (ev.clientX || 0) - drag.x
          var dy = (ev.clientY || 0) - drag.y
          var moved = drag.moved
          var c = cards[idx]
          if (c) {
            c.classList.remove('rv-dragging')
            c.style.transform = ''
          }
          stack.style.transform = ''
          drag = null
          if (busy) return
          if (moved < SWIPE_THRESHOLD) {
            // 视为点击：默认向右滑（需求：点击默认向右滑动）
            step(1, 0)
          } else {
            // 滑动方向随手势；各个方向都可以
            step(dx, dy)
          }
        }

        onKey = function (ev) {
          if (!ev) return
          if (ev.key === 'Escape') return finish('played')
          if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
            if (ev.preventDefault) ev.preventDefault()
            step(1, 0)
          }
        }

        api.state = function () {
          return { mode: 'ten', index: idx, total: steps.length, busy: busy }
        }
      }

      // 事件注册统一放在两个分支**之后**。
      // 之前把 pointerdown 的注册写在十连分支里，结果单抽的点击完全没反应 ——
      // 而且它不报错，只表现成「动画卡住了」。测试抓到了这一条。
      if (typeof onDown === 'function') overlay.addEventListener('pointerdown', onDown)
      if (typeof onMove === 'function') overlay.addEventListener('pointermove', onMove)
      if (typeof onUp === 'function') overlay.addEventListener('pointerup', onUp)
      if (typeof onUp === 'function') overlay.addEventListener('pointercancel', onUp)
      if (typeof onKey === 'function') {
        overlay.addEventListener('keydown', onKey)
        doc.addEventListener('keydown', onKey)
      }

      if (doc.body) doc.body.appendChild(overlay)
      else if (doc.documentElement) doc.documentElement.appendChild(overlay)
      // 触发进入动画（先挂上去再改类，否则过渡不会跑）
      if (win.requestAnimationFrame) {
        win.requestAnimationFrame(function () {
          overlay.classList.add('is-in')
        })
      } else {
        overlay.classList.add('is-in')
      }

      root.__lastReveal = api
    })
  }

  /** 一张纯色卡牌（背面是纯色 + 光晕，正面由 faceEl 提供） */
  function buildCard(doc, item, reveal, revealed, rarities) {
    var card = el(doc, 'div', 'rv-card')
    card.setAttribute('data-rarity', item.rarityId || '')
    card.style.setProperty('--rv-color', colorFor(item.rarityId, reveal))
    card.style.setProperty('--rv-glow', String(glowFor(item.rarityId, rarities)))
    var flip = el(doc, 'div', 'rv-flip')
    var back = el(doc, 'div', 'rv-back')
    var front = el(doc, 'div', 'rv-front')
    if (item.faceEl) front.appendChild(item.faceEl)
    else front.appendChild(el(doc, 'div', 'rv-face-fallback', item.name || ''))
    flip.appendChild(back)
    flip.appendChild(front)
    card.appendChild(flip)
    if (revealed) card.classList.add('is-revealed')
    return card
  }

  /** 最上方那张空白卡牌 */
  function buildBlank(doc) {
    var card = el(doc, 'div', 'rv-card rv-blank')
    card.setAttribute('data-rarity', 'blank')
    var flip = el(doc, 'div', 'rv-flip')
    flip.appendChild(el(doc, 'div', 'rv-back rv-back-blank'))
    card.appendChild(flip)
    return card
  }

  var api = {
    // 纯函数（测试直接用）
    revealCfg: revealCfg,
    colorFor: colorFor,
    rankOf: rankOf,
    glowFor: glowFor,
    backdropFor: backdropFor,
    sortByRarity: sortByRarity,
    topTierOf: topTierOf,
    revealOrder: revealOrder,
    emojiFor: emojiFor,
    edgeGlowRarity: edgeGlowRarity,
    FALLBACK_REVEAL: FALLBACK_REVEAL,
    SWIPE_THRESHOLD: SWIPE_THRESHOLD,
    // 动画
    play: play,
  }

  root.GachaReveal = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this)
