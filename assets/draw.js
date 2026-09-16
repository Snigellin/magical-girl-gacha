/**
 * draw.js — 抽卡判定（纯逻辑，无 DOM）
 *
 * 为什么单独一个文件、而且放在前端：
 *   这个站要发布到 GitHub Pages，静态站没有后端，判定只能在浏览器里跑。
 *   服务端**不重复实现一遍**，它只负责把结果记账（POST api/draw/sync）——
 *   同一个规则前后端各写一份，必然出现「本地对、导出错」的错位。
 *
 * 本文件不碰 DOM，所以能在 Node 里加载做测试（scripts/test-draw.mjs 用 vm 跑它）。
 *
 * ---------------------------------------------------------------------------
 * 机制（用户 2026-09-15 给定）
 * ---------------------------------------------------------------------------
 *   · 出率：SR 60% / SSR 35% / UR 4.4% / ??? 0.6%（= 卡池权重，归一化后就是百分比）
 *     权重**允许小数**：这里不做任何「必须整数」的假设。
 *   · **同一稀有度内所有卡牌等概率**（见 drawSingle 末尾那一行）
 *   · 十连保底：settings.pull.tenPullGuarantee（至少一张不低于该档）
 *   · 保底计数：settings.pull.pityMax（自上次出最高档起算）
 *   · 重复卡 -> 碎片，规则在 page/shards.js（settleDraw）
 *
 * 参数（权重、保底、消耗）全部来自数据，改数值不用改代码。
 * 数据没配好时一律**显式报错**，不悄悄用一个默认值糊过去 —— 见 issues()。
 */

;(function (root) {
  'use strict'

  // -------------------------------------------------------------------------
  // 随机数
  // -------------------------------------------------------------------------

  /**
   * 可复现的伪随机数（mulberry32）。
   * 用途：测试必须能复现同一串抽卡结果，否则「保底有没有生效」这种断言
   * 只能靠运气。生产环境用 crypto。
   */
  function mulberry32(seed) {
    var a = seed >>> 0
    return function () {
      a = (a + 0x6d2b79f5) >>> 0
      var t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  /** 无法复现的随机数（生产用）。crypto 拿不到时退回 Math.random。 */
  function cryptoRandom() {
    var c = root.crypto
    if (c && typeof c.getRandomValues === 'function') {
      return function () {
        // 用 32 位整数拼出 [0,1)：直接取 Uint32 / 2^32 足够均匀
        var buf = new Uint32Array(1)
        c.getRandomValues(buf)
        return buf[0] / 4294967296
      }
    }
    return Math.random
  }

  // -------------------------------------------------------------------------
  // 校验
  // -------------------------------------------------------------------------

  /**
   * 把「卡池配置缺了什么」变成一句能照着做的话。
   *
   * ⚠️ 这是本文件最重要的部分。抽卡最容易出的 bug 不是算法写错，而是
   * **数据没配好却静默算出一个看似合理的结果** —— 例如权重全缺时平分、
   * 卡池为空时返回 undefined 让页面白屏。宁可返回明确的问题。
   */
  function issues(data, poolId) {
    var out = []
    var rarities = (data && data.rarities) || []
    var pools = (data && data.pools) || []
    var cards = (data && data.cards) || []

    if (!rarities.length) out.push('稀有度档位表是空的（settings 里应有 rarities）')
    if (!pools.length) out.push('没有任何卡池')
    if (!cards.length) out.push('卡牌名册是空的 —— 到后台「扫描卡池」把图片目录扫进来')

    var ids = {}
    for (var i = 0; i < rarities.length; i++) ids[rarities[i].id] = true

    var pool = null
    for (var j = 0; j < pools.length; j++) {
      if (!poolId || pools[j].id === poolId) {
        pool = pools[j]
        break
      }
    }
    if (!pool) out.push('找不到卡池 ' + poolId)

    if (pool) {
      var w = pool.weights || {}

      // 这一档在当前卡池里到底有没有可抽的卡。
      // 池子自带 byRarity（服务端算好的）时以它为准，否则自己从名册数。
      var countIn = function (rid) {
        if (pool.byRarity && pool.byRarity[rid]) return pool.byRarity[rid].length
        var n = 0
        for (var ci = 0; ci < cards.length; ci++) {
          var c = cards[ci]
          if (!c.hidden && c.rarityKnown && c.rarity === rid) n++
        }
        return n
      }

      var positive = 0
      for (var k in w) {
        if (!Object.prototype.hasOwnProperty.call(w, k)) continue
        if (!ids[k]) continue
        if (Number(w[k]) > 0 && countIn(k) > 0) positive++
      }
      if (!positive) {
        out.push(
          '卡池「' + pool.name + '」的出率权重全是 0 或没配 —— ' +
            '所有档位都抽不出来。到后台把权重填上（本项目是 SR 60 / SSR 35 / UR 4.4 / ??? 0.6）',
        )
      }
      // 缺权重的档位要报出来 —— 但**只报真的有卡的那些**。
      //
      // ⚠️ 这条一开始写成了「所有权重表里没有的档位都报」，结果一个只有 SR 卡、
      // 权重只配了 SR 的卡池会被判成「没配好」而抽不了卡。档位表里那一档压根没有卡时，
      // 没有权重是**完全正常**的（抽不到它是因为没卡，不是因为权重）。
      // 拿抽不到的档位去拦一个可用卡池，属于假失败 —— 比不报更糟。
      var missingWithCards = []
      for (var r = 0; r < rarities.length; r++) {
        var rid = rarities[r].id
        if (w[rid] !== undefined) continue
        var n = countIn(rid)
        if (n > 0) missingWithCards.push(rid + '（' + n + ' 张卡）')
      }
      if (missingWithCards.length) {
        out.push(
          '卡池「' + pool.name + '」这些档位有卡但没配权重，所以抽不出来：' + missingWithCards.join(' / ') +
            '。到后台给它们填权重，或把这些卡的稀有度改掉。',
        )
      }
    }
    return out
  }

  /** 建索引：id -> 卡；稀有度 -> 卡 id 列表（来自池子的 byRarity） */
  function indexes(data, pool) {
    var byId = Object.create(null)
    var cards = (data && data.cards) || []
    for (var i = 0; i < cards.length; i++) byId[cards[i].id] = cards[i]

    var byRarity = Object.create(null)
    for (var k in byId) {
      var c = byId[k]
      if (c.hidden) continue
      if (!c.rarityKnown) continue
      ;(byRarity[c.rarity] || (byRarity[c.rarity] = [])).push(c.id)
    }

    // 池子如果自带了 byRarity（服务端算好的），以它为准 —— 保证前后端一致
    if (pool && pool.byRarity) {
      for (var r in pool.byRarity) byRarity[r] = pool.byRarity[r].slice()
    }
    return { byId: byId, byRarity: byRarity }
  }

  // -------------------------------------------------------------------------
  // 核心
  // -------------------------------------------------------------------------

  function weightedPick(list, weightOf, rng) {
    var total = 0
    var i
    for (i = 0; i < list.length; i++) total += weightOf(list[i])
    if (!(total > 0)) return null
    var roll = rng() * total
    var acc = 0
    for (i = 0; i < list.length; i++) {
      acc += weightOf(list[i])
      if (roll < acc) return list[i]
    }
    return list[list.length - 1]
  }

  /** 抽一张。返回 { ok:true, card, rarityId } 或 { ok:false, error } */
  function drawSingle(data, poolId, opts) {
    opts = opts || {}
    var rng = opts.rng || cryptoRandom()
    var bad = issues(data, poolId)
    if (bad.length) return { ok: false, error: bad.join('；') }

    var pools = data.pools
    var pool = null
    for (var i = 0; i < pools.length; i++) {
      if (!poolId || pools[i].id === poolId) {
        pool = pools[i]
        break
      }
    }
    var idx = indexes(data, pool)
    var weights = pool.weights || {}

    // 参与掷档的稀有度：权重 > 0，且池子里真的有这一档的卡。
    // 「权重 > 0 但无卡」必须提前排除，否则会抽到一个空的档位然后返回 undefined。
    var candidates = []
    var emptyWithWeight = []
    for (var r = 0; r < data.rarities.length; r++) {
      var rid = data.rarities[r].id
      var w = Number(weights[rid] || 0)
      if (!(w > 0)) continue
      var bucket = idx.byRarity[rid] || []
      if (!bucket.length) {
        emptyWithWeight.push(rid)
        continue
      }
      candidates.push(rid)
    }

    if (!candidates.length) {
      return {
        ok: false,
        error:
          '卡池「' + pool.name + '」里没有任何可抽的档位。' +
          (emptyWithWeight.length
            ? '这些档位配了权重但一张卡都没有：' + emptyWithWeight.join(' / ') + '。'
            : '') +
          '请到后台给卡牌设置稀有度，或调整权重。',
      }
    }

    // 保底：够了就必出最高档
    var pull = data.settings && data.settings.pull ? data.settings.pull : {}
    var pityMax = Number(pull.pityMax || 0)
    var sinceTop = Number((data.player && data.player.sinceTop) || 0)
    var forced = ''
    if (pityMax > 0 && sinceTop + 1 >= pityMax) {
      // 最高档 = rank 最大的那一档（表已按 rank 升序）
      var top = data.rarities[data.rarities.length - 1].id
      if (candidates.indexOf(top) >= 0) forced = top
    }

    // 十连保底的兜底：drawMany 指定一个最低档位，这里必须真的用它，
    // 否则「保底」传进来却被忽略 —— 那就是一次静默失效。
    var forcedKind = forced ? 'pity' : ''
    if (opts._forceRarity) {
      var want = String(opts._forceRarity)
      if (candidates.indexOf(want) >= 0) {
        forced = want
        forcedKind = 'tenpull'
      } else if (!forced) {
        // 指定的保底档位在这个池子里抽不出来（没卡或权重为 0）：
        // 退到「不高于它的、可抽的最高档」，并标成 fallback，不假装保底成功。
        var wantRank = -1
        for (var t = 0; t < data.rarities.length; t++) {
          if (data.rarities[t].id === want) wantRank = Number(data.rarities[t].rank || 0)
        }
        var bestFallback = ''
        var bestRank = -1
        for (var u = 0; u < candidates.length; u++) {
          for (var v = 0; v < data.rarities.length; v++) {
            if (data.rarities[v].id === candidates[u]) {
              var rk2 = Number(data.rarities[v].rank || 0)
              if (rk2 <= wantRank && rk2 > bestRank) {
                bestRank = rk2
                bestFallback = candidates[u]
              }
            }
          }
        }
        if (bestFallback) {
          forced = bestFallback
          forcedKind = 'tenpull-fallback'
        }
      }
    }
    // 十连保底的兜底：drawMany 会指定一个最低档位，这里必须真的用它，
    // 否则「保底」传进来却被忽略 —— 那就是一次静默失效。
    if (opts._forceRarity) {
      var want = String(opts._forceRarity)
      if (candidates.indexOf(want) >= 0) forced = want
      else if (!forced) {
        // 指定的保底档位在这个池子里抽不出来（没卡或权重为 0）：
        // 退到「不高于它的、可抽的最高档」，并在结果里标出来，不假装保底成功。
        var wantRank = -1
        for (var t = 0; t < data.rarities.length; t++) {
          if (data.rarities[t].id === want) wantRank = Number(data.rarities[t].rank || 0)
        }
        var bestFallback = ''
        var bestRank = -1
        for (var u = 0; u < candidates.length; u++) {
          for (var v = 0; v < data.rarities.length; v++) {
            if (data.rarities[v].id === candidates[u]) {
              var rk2 = Number(data.rarities[v].rank || 0)
              if (rk2 <= wantRank && rk2 > bestRank) {
                bestRank = rk2
                bestFallback = candidates[u]
              }
            }
          }
        }
        if (bestFallback) forced = bestFallback
      }
    }

    var rarityId = forced || weightedPick(candidates, function (rid) {
      return Number(weights[rid] || 0)
    }, rng)

    var bucket2 = idx.byRarity[rarityId] || []
    if (!bucket2.length) {
      // 走到这里说明上面的一致性检查漏了 —— 明确报出来，别返回 undefined
      return { ok: false, error: '档位 ' + rarityId + ' 下没有卡（卡池数据不一致）' }
    }
    // 同档位内等概率。若之后要「同档内不同权重」，改这一行即可。
    var pickId = bucket2[Math.floor(rng() * bucket2.length) % bucket2.length]
    var card = idx.byId[pickId]
    if (!card) return { ok: false, error: '卡牌 ' + pickId + ' 在名册里找不到（数据不一致）' }

    return { ok: true, card: card, rarityId: rarityId, forced: forcedKind }
  }

  /**
   * 连抽 n 次，并施加十连保底。
   *
   * @param {object} data  快照（rarities / pools / cards / settings / player）
   * @param {object} [opts] { poolId, count, rng }
   * @returns {{ok:true, results:Array} | {ok:false, error:string}}
   */
  function drawMany(data, opts) {
    opts = opts || {}
    var count = Math.max(1, Math.min(100, Number(opts.count) || 1))
    var poolId = opts.poolId
    var rng = opts.rng || cryptoRandom()

    var bad = issues(data, poolId)
    if (bad.length) return { ok: false, error: bad.join('；') }

    var pool = null
    var pools = data.pools
    for (var i = 0; i < pools.length; i++) {
      if (!poolId || pools[i].id === poolId) {
        pool = pools[i]
        break
      }
    }
    var pull = (data.settings && data.settings.pull) || {}
    var guarantee = String(pull.tenPullGuarantee || '')
    var guaranteeRank = -1
    if (guarantee) {
      for (var r = 0; r < data.rarities.length; r++) {
        if (data.rarities[r].id === guarantee) guaranteeRank = Number(data.rarities[r].rank || 0)
      }
    }

    var results = []
    for (var n = 0; n < count; n++) {
      var one = drawSingle(data, poolId, { rng: rng })
      if (!one.ok) return one
      results.push(one)
    }

    // 十连保底：count >= 10 时，若这一轮里没有任何一张达到保底档，
    // 把**最后一张**替换成保底档的一张（而不是整轮重抽 —— 重抽会让前面
    // 已经看到的动画失效，而且消耗的随机数不一样，结果不可复现）。
    if (count >= 10 && guaranteeRank >= 0) {
      var best = -1
      for (var m = 0; m < results.length; m++) {
        var rid = results[m].rarityId
        for (var q = 0; q < data.rarities.length; q++) {
          if (data.rarities[q].id === rid) {
            var rk = Number(data.rarities[q].rank || 0)
            if (rk > best) best = rk
          }
        }
      }
      if (best < guaranteeRank) {
        var forced = drawSingle(data, poolId, { rng: rng, _forceRarity: guarantee })
        if (forced.ok) {
          // ⚠️ 只有真的出了保底档才算保底生效。若保底档在这个池子里抽不出来，
          // drawSingle 会退到较低的档并标 forced='tenpull-fallback' ——
          // 那种情况绝不能写 guaranteed=true，否则 UI 会宣称一件没发生的事。
          forced.guaranteed = forced.forced === 'tenpull'
          if (!forced.guaranteed) {
            forced.guaranteeNote =
              '本应在十连里保底 ' + guarantee + '，但这一档在池子里没有可抽的卡（没卡或权重为 0），已退到 ' + forced.rarityId
          }
          results[results.length - 1] = forced
        }
      }
    }

    return { ok: true, results: results, poolId: pool.id }
  }

  // -------------------------------------------------------------------------
  // 花费与统计
  // -------------------------------------------------------------------------

  /** 一次抽卡要花多少。十连与单抽的价格可以不同。 */
  function costFor(data, count) {
    var pull = (data && data.settings && data.settings.pull) || {}
    var single = Number(pull.costSingle || 0)
    var ten = pull.costTen === null || pull.costTen === undefined ? null : Number(pull.costTen)
    if (Number(count) >= 10 && ten !== null && Number.isFinite(ten)) return ten
    return single * Math.max(1, Number(count) || 1)
  }

  /** 卡池概况：每档多少张、总共有多少张可抽。给「卡池一览」用。 */
  function poolSummary(data, poolId) {
    var rarities = (data && data.rarities) || []
    var cards = (data && data.cards) || []
    var pools = (data && data.pools) || []
    var pool = null
    for (var i = 0; i < pools.length; i++) {
      if (!poolId || pools[i].id === poolId) {
        pool = pools[i]
        break
      }
    }
    var rows = []
    var total = 0
    for (var r = 0; r < rarities.length; r++) {
      var id = rarities[r].id
      var n = 0
      for (var c = 0; c < cards.length; c++) {
        if (!cards[c].hidden && cards[c].rarityKnown && cards[c].rarity === id) n++
      }
      var w = pool && pool.weights ? Number(pool.weights[id] || 0) : 0
      rows.push({ rarity: rarities[r], count: n, weight: w })
      total += n
    }
    return { pool: pool, rows: rows, total: total }
  }

  /**
   * 按权重算出「每个档位的实际出率」，给页面显示用。
   *
   * 注意：只对**池子里真的有卡**的档位归一化 —— 配了权重但没卡的档位
   * 实际出率是 0，按它参与归一化会把别的档位算得偏低。
   */
  function rateTable(data, poolId) {
    var summary = poolSummary(data, poolId)
    var totalW = 0
    var i
    for (i = 0; i < summary.rows.length; i++) {
      if (summary.rows[i].count > 0 && summary.rows[i].weight > 0) totalW += summary.rows[i].weight
    }
    var out = []
    for (i = 0; i < summary.rows.length; i++) {
      var row = summary.rows[i]
      var playable = row.count > 0 && row.weight > 0
      out.push({
        rarity: row.rarity,
        count: row.count,
        weight: row.weight,
        rate: totalW > 0 && playable ? row.weight / totalW : 0,
        playable: playable,
      })
    }
    return out
  }

  var api = {
    issues: issues,
    drawSingle: drawSingle,
    drawMany: drawMany,
    draw: drawSingle,
    costFor: costFor,
    poolSummary: poolSummary,
    rateTable: rateTable,
    mulberry32: mulberry32,
    cryptoRandom: cryptoRandom,
  }

  root.Gacha = api
  // CommonJS / ESM 互操作，方便 Node 里直接 import 做测试
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
