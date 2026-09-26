'use strict';

/**
 * 采购报价组合（purchase quote combination）。
 *
 * 在需求张数（默认接入印刷备料的整包采购张数，也可手工填写覆盖）与多条本地报价之间
 * 求解唯一的整包采购组合。每条本地报价包含：
 * - supplier       供应商名称（非空字符串，不可重复）；
 * - sheetsPerPack  每包张数（≥1 的整数）；
 * - pricePerPack   每包价格（元，精确到分；内部一律按整数「分」计算与比较，不做浮点比较）；
 * - minPacks       最少可购包数（≥0 的整数，缺省 0；启用该供应商时至少购买此包数）；
 * - maxPacks       最多可购包数（≥ minPacks 的整数；缺省 / null 表示不限）。
 *
 * 每条报价的采购包数 p 满足：p = 0（不向该供应商采购）或 minPacks ≤ p ≤ maxPacks。
 * 在所有满足「总张数 ≥ 需求张数」且各报价边界成立的组合中，按以下优先级确定唯一方案：
 *   1. 总价最低（按分精确比较）；
 *   2. 超购张数最少（总张数 − 需求张数）；
 *   3. 供应商数量最少（采购包数 > 0 的报价条数）；
 *   4. 录入顺序优先（从第 1 条报价起逐项比较采购包数向量，先出现差异的报价中
 *      包数较多者胜出，即同等条件下优先让先录入的报价承担采购）。
 *
 * 无可行组合（全部报价按最多可购包数采购仍不足需求）时不抛错，返回
 * { feasible: false, maxPurchasableSheets, gapSheets } 给出具体缺口。
 *
 * 未启用（purchaseQuotes 缺省 / null / false / { enabled: false }）时 parse 返回
 * { enabled: false }，attachPurchaseQuotes 返回 undefined，原响应完全不变。
 *
 * 求解器：后缀 DP（第 i..n 条报价凑出恰好 t 张的最优 (总价, 供应商数)），
 * 每条报价的 {0} ∪ [min, max] 包数域用单调队列滑窗在 O(总张数) 内转移；
 * 最优解总张数上界 T = 需求 + max(最大每包张数, 最大单条报价最少采购张数) − 1
 * （超出该上界的方案必可去掉至少一包而不更差），逐状态记录所选包数供回溯。
 */

const MAX_QUOTES = 20;               // 本地报价条数上限
const MAX_DEMAND_SHEETS = 500000;    // 需求张数上限 50 万张
const MAX_SHEETS_PER_PACK = 500000;  // 每包张数上限 50 万张
const MAX_PACKS = 100000;            // 最少 / 最多可购包数上限 10 万包
const MAX_PRICE_CENTS = 9999999;     // 每包价格上限 99,999.99 元（按分存储）
const MAX_SUPPLIER_LEN = 50;         // 供应商名称长度上限
const MAX_DP_TOTAL = 1000000;        // 求解空间（需求 + 边界余量）上限

/** 解析整数参数：接受整数或纯数字字符串，布尔 / null / 空串等返回 NaN。 */
function toInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

/**
 * 把每包价格解析为整数「分」：接受数字或字符串（如 120.5 / "120.50"），
 * 必须 ≥ 0 且精确到分（小数最多两位）；非法返回 NaN。
 * 数字输入按 ×100 后四舍五入并校验残差，容忍 0.1+0.2 这类浮点尾数；
 * 字符串输入逐位解析，避免 0.1 × 100 这类浮点误差进入比较。
 */
function toCents(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return NaN;
    const scaled = value * 100;
    const cents = Math.round(scaled);
    // 超出分位精度（如 0.105 元）拒绝；浮点尾数（残差 < 1e-6 分）归整
    if (Math.abs(scaled - cents) > 1e-6) return NaN;
    return cents;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
    if (!m) return NaN;
    return Number(m[1]) * 100 + (m[2] ? Number(m[2].padEnd(2, '0')) : 0);
  }
  return NaN;
}

/** 整数分格式化为元（不经过浮点）：12345 -> "123.45"。 */
function formatCents(cents) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/**
 * 解析并校验采购报价组合输入。
 * @returns {{enabled: false} | {enabled: true, demandSheets: number|null, quotes: Array}}
 *          demandSheets 为 null 表示未手工填写，由 attach 阶段接入印刷备料整包采购张数。
 */
function parsePurchaseQuotesInput(input) {
  const raw = input && input.purchaseQuotes;
  if (raw === undefined || raw === null || raw === false) {
    return { enabled: false };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('采购报价组合参数 purchaseQuotes 必须为对象（含 demandSheets / quotes）');
  }
  if (raw.enabled === false) {
    return { enabled: false };
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new Error('采购报价组合开关 enabled 必须为布尔值（true / false）');
  }

  // 需求张数：可手工填写；缺省（null）时由 attach 阶段接入印刷备料的整包采购张数
  let demandSheets = null;
  if (raw.demandSheets !== undefined && raw.demandSheets !== null && raw.demandSheets !== '') {
    demandSheets = toInteger(raw.demandSheets);
    if (!Number.isInteger(demandSheets) || demandSheets < 1 || demandSheets > MAX_DEMAND_SHEETS) {
      throw new Error(`需求张数 demandSheets 必须为 1 ~ ${MAX_DEMAND_SHEETS.toLocaleString('en-US')} 的整数`);
    }
  }

  if (!Array.isArray(raw.quotes) || raw.quotes.length === 0) {
    throw new Error('采购报价组合至少需要 1 条本地报价（quotes 非空数组）');
  }
  if (raw.quotes.length > MAX_QUOTES) {
    throw new Error(`本地报价最多 ${MAX_QUOTES} 条（收到 ${raw.quotes.length} 条）`);
  }

  const seenSuppliers = new Set();
  const quotes = raw.quotes.map((entry, i) => {
    const no = i + 1;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`第 ${no} 条报价必须为对象（含 supplier / sheetsPerPack / pricePerPack / minPacks / maxPacks）`);
    }
    const supplier = typeof entry.supplier === 'string' ? entry.supplier.trim() : '';
    if (!supplier) {
      throw new Error(`第 ${no} 条报价：供应商 supplier 必须为非空字符串`);
    }
    if (supplier.length > MAX_SUPPLIER_LEN) {
      throw new Error(`第 ${no} 条报价（${supplier}）：供应商名称不能超过 ${MAX_SUPPLIER_LEN} 个字符`);
    }
    if (seenSuppliers.has(supplier)) {
      throw new Error(`供应商「${supplier}」的报价重复录入（第 ${no} 条），同一供应商只能有一条报价`);
    }
    seenSuppliers.add(supplier);

    const sheetsPerPack = toInteger(entry.sheetsPerPack);
    if (!Number.isInteger(sheetsPerPack) || sheetsPerPack < 1 || sheetsPerPack > MAX_SHEETS_PER_PACK) {
      throw new Error(`第 ${no} 条报价（${supplier}）：每包张数 sheetsPerPack 必须为 1 ~ ${MAX_SHEETS_PER_PACK.toLocaleString('en-US')} 的整数`);
    }
    const priceCents = toCents(entry.pricePerPack);
    if (!Number.isInteger(priceCents) || priceCents > MAX_PRICE_CENTS) {
      throw new Error(`第 ${no} 条报价（${supplier}）：每包价格 pricePerPack 必须为 0 ~ ${formatCents(MAX_PRICE_CENTS)} 元、精确到分的数字（如 120.50）`);
    }
    let minPacks = 0;
    if (entry.minPacks !== undefined && entry.minPacks !== null && entry.minPacks !== '') {
      minPacks = toInteger(entry.minPacks);
      if (!Number.isInteger(minPacks) || minPacks < 0 || minPacks > MAX_PACKS) {
        throw new Error(`第 ${no} 条报价（${supplier}）：最少可购包数 minPacks 必须为 0 ~ ${MAX_PACKS.toLocaleString('en-US')} 的整数`);
      }
    }
    let maxPacks = null; // 缺省 / null：不限
    if (entry.maxPacks !== undefined && entry.maxPacks !== null && entry.maxPacks !== '') {
      maxPacks = toInteger(entry.maxPacks);
      if (!Number.isInteger(maxPacks) || maxPacks < 1 || maxPacks > MAX_PACKS) {
        throw new Error(`第 ${no} 条报价（${supplier}）：最多可购包数 maxPacks 必须为 1 ~ ${MAX_PACKS.toLocaleString('en-US')} 的整数（留空表示不限）`);
      }
      if (maxPacks < minPacks) {
        throw new Error(`第 ${no} 条报价（${supplier}）：最多可购包数（${maxPacks}）不能小于最少可购包数（${minPacks}）`);
      }
    }
    return { index: no, supplier, sheetsPerPack, priceCents, minPacks, maxPacks };
  });

  return { enabled: true, demandSheets, quotes };
}

/**
 * 采购组合求解（纯函数，全部按整数分 / 整数张计算，不做浮点比较）。
 *
 * @param {number} demandSheets 需求张数（≥1 的整数）
 * @param {Array} quotes 规范化后的报价（parsePurchaseQuotesInput 输出）
 * @returns {object} 可行：{ feasible: true, packs, totalSheets, totalCostCents, overageSheets, supplierCount }；
 *                   不可行：{ feasible: false, maxPurchasableSheets, gapSheets }
 */
function solveQuoteCombination(demandSheets, quotes) {
  const D = demandSheets;
  const n = quotes.length;

  // 可行性快检：全部报价按最多可购包数采购仍不足需求 → 唯一不可行情形，给出具体缺口
  let maxPurchasable = 0;
  let hasUnlimited = false;
  for (const q of quotes) {
    if (q.maxPacks === null) {
      hasUnlimited = true;
      break;
    }
    maxPurchasable += q.maxPacks * q.sheetsPerPack;
  }
  if (!hasUnlimited && maxPurchasable < D) {
    return { feasible: false, maxPurchasableSheets: maxPurchasable, gapSheets: D - maxPurchasable };
  }

  // 有效上界：最优解中每条报价 p ≤ max(minPacks, ceil(D / 每包张数))
  // （超过该界必可去掉一包仍满足需求，总价不变或更低、超购更少，与最优矛盾）。
  const items = quotes.map((q) => {
    const need = Math.ceil(D / q.sheetsPerPack);
    const hi = Math.min(q.maxPacks === null ? Infinity : q.maxPacks, Math.max(q.minPacks, need));
    return { ...q, hi };
  });

  // 最优解总张数上界：超过 需求 + max(最大每包张数, 最大单条报价最少采购张数) − 1 的方案
  // 必可去掉一包（或整退一条处于最少包数的报价）仍满足需求且不更差。
  const maxS = Math.max(...items.map((it) => it.sheetsPerPack));
  const maxLoTotal = Math.max(0, ...items.map((it) => it.minPacks * it.sheetsPerPack));
  const T = D + Math.max(maxS, maxLoTotal) - 1;
  if (T > MAX_DP_TOTAL) {
    throw new Error(`报价边界导致求解空间过大（需求加边界余量达 ${T.toLocaleString('en-US')} 张，上限 ${MAX_DP_TOTAL.toLocaleString('en-US')} 张）：请调小最少可购包数或每包张数`);
  }

  // 后缀 DP：cost[t] / sup[t] = 用第 i..n-1 条报价凑出恰好 t 张的最低总价（分）与
  // 该总价下的最少供应商数；choice[i][t] 记录第 i 条报价所选包数（0 = 不采购）。
  // 状态内并列时取「本报价包数更大」者——从第 1 条起逐条如此，回溯即得
  // 「录入顺序优先」（包数向量从第 1 条起首个差异处包数较多）的唯一方案。
  let cost = new Float64Array(T + 1).fill(Infinity);
  let sup = new Uint8Array(T + 1);
  cost[0] = 0;
  const choiceLayers = new Array(n);

  for (let i = n - 1; i >= 0; i--) {
    const { sheetsPerPack: s, priceCents: c, minPacks: lo, hi } = items[i];
    const loW = Math.max(lo, 1); // p = 0（不采购）单独处理，滑窗只覆盖 p ∈ [max(lo,1), hi]
    const nextCost = new Float64Array(T + 1);
    const nextSup = new Uint8Array(T + 1);
    const choice = new Uint32Array(T + 1);
    for (let r = 0; r < s; r++) {
      // 同余类 t = r + j·s 上滑窗：候选源 k = j − p ∈ [j − hi, j − loW]，
      // 比较键 g(k) = cost[r + k·s] − k·c（整数分），并列比供应商数、再并列取下标更小者
      // （下标更小 = 本报价包数更大 = 录入顺序优先）。
      const deque = [];
      let head = 0;
      for (let t = r, j = 0; t <= T; t += s, j++) {
        const kAdd = j - loW;
        if (kAdd >= 0) {
          const tAdd = t - loW * s;
          if (cost[tAdd] !== Infinity) {
            const gAdd = cost[tAdd] - kAdd * c;
            const sAdd = sup[tAdd];
            while (deque.length > head) {
              const kb = deque[deque.length - 1];
              const tb = t - (j - kb) * s;
              const gb = cost[tb] - kb * c;
              const sb = sup[tb];
              if (gb > gAdd || (gb === gAdd && sb > sAdd)) {
                deque.pop();
              } else {
                break;
              }
            }
            deque.push(kAdd);
          }
        }
        const kMin = j - hi;
        while (deque.length > head && deque[head] < kMin) head++;

        // 候选 1：不向该报价采购（p = 0）
        let bestCost = cost[t];
        let bestSup = sup[t];
        let bestP = 0;
        // 候选 2：向该报价采购 p ∈ [loW, hi] 包
        if (deque.length > head) {
          const k = deque[head];
          const p = j - k;
          const wCost = cost[t - p * s] + p * c;
          const wSup = sup[t - p * s] + 1;
          if (
            wCost < bestCost ||
            (wCost === bestCost && (wSup < bestSup || (wSup === bestSup && p > 0)))
          ) {
            bestCost = wCost;
            bestSup = wSup;
            bestP = p;
          }
        }
        nextCost[t] = bestCost;
        nextSup[t] = bestSup;
        choice[t] = bestP;
      }
    }
    choiceLayers[i] = choice;
    cost = nextCost;
    sup = nextSup;
  }

  // 总张数决策：总价最低 → 超购张数最少（t 递增扫描，首个最低总价即超购最少）。
  // 供应商数量已在各状态内随总价一并最小化，录入顺序由回溯时的包数选择保证。
  let bestT = -1;
  let bestCost = Infinity;
  for (let t = D; t <= T; t++) {
    if (cost[t] < bestCost) {
      bestCost = cost[t];
      bestT = t;
    }
  }
  if (bestT < 0) {
    // 防御：可行性快检通过则 DP 必有解，理论上不可达
    throw new Error('采购报价组合求解失败：可行性检查与求解结果不一致');
  }

  // 回溯各报价采购包数
  const packs = new Array(n).fill(0);
  let rest = bestT;
  for (let i = 0; i < n; i++) {
    const p = choiceLayers[i][rest];
    packs[i] = p;
    rest -= p * items[i].sheetsPerPack;
  }

  return {
    feasible: true,
    packs,
    totalSheets: bestT,
    totalCostCents: bestCost,
    overageSheets: bestT - D,
    supplierCount: packs.filter((p) => p > 0).length,
  };
}

/**
 * 依据拼版 / 备料结果组装采购报价组合段。
 * 仅在 parsePurchaseQuotesInput 返回 enabled 时调用；否则返回 undefined（不写入任何字段）。
 *
 * @param {{enabled:true, demandSheets:number|null, quotes:Array}} parsed
 * @param {object|undefined} materialPrepResult 印刷备料结果（用于接入整包采购张数）
 * @returns {object} 采购报价组合结果（purchaseQuotes 段）
 */
function attachPurchaseQuotes(parsed, materialPrepResult) {
  if (!parsed.enabled) return undefined;

  // 需求张数：手工填写优先；缺省时接入印刷备料的整包采购张数
  let demandSheets = parsed.demandSheets;
  let demandSource = 'manual';
  if (demandSheets === null) {
    const fromPrep = materialPrepResult && materialPrepResult.enabled
      ? materialPrepResult.totals.purchaseSheets
      : null;
    if (fromPrep === null) {
      throw new Error('启用采购报价组合时请手工填写需求张数 demandSheets，或同时启用印刷备料以自动接入整包采购张数');
    }
    if (fromPrep > MAX_DEMAND_SHEETS) {
      throw new Error(`印刷备料的整包采购张数 ${fromPrep.toLocaleString('en-US')} 张超过采购报价组合需求上限 ${MAX_DEMAND_SHEETS.toLocaleString('en-US')} 张，请调整备料参数或手工填写需求张数`);
    }
    demandSheets = fromPrep;
    demandSource = 'materialPrep';
  }

  const solution = solveQuoteCombination(demandSheets, parsed.quotes);

  // 逐报价采购量（包数 / 张数）、金额（分）与余量（距最多可购包数的剩余；不限为 null）
  const quotes = parsed.quotes.map((q, i) => {
    const packs = solution.feasible ? solution.packs[i] : 0;
    return {
      index: q.index,
      supplier: q.supplier,
      sheetsPerPack: q.sheetsPerPack,
      pricePerPackCents: q.priceCents,
      minPacks: q.minPacks,
      maxPacks: q.maxPacks,
      packs,
      sheets: packs * q.sheetsPerPack,
      costCents: packs * q.priceCents,
      remainingPacks: q.maxPacks === null ? null : q.maxPacks - packs,
      remainingSheets: q.maxPacks === null ? null : (q.maxPacks - packs) * q.sheetsPerPack,
    };
  });

  const sourceText = demandSource === 'materialPrep' ? '取自印刷备料整包采购张数' : '手工填写';
  const segment = {
    enabled: true,
    demandSheets,
    demandSource,
    rule: '总价最低 → 超购张数最少 → 供应商数量最少 → 录入顺序',
    feasible: solution.feasible,
    quotes,
  };
  if (solution.feasible) {
    const packCount = solution.packs.reduce((sum, p) => sum + p, 0);
    segment.totals = {
      packCount,
      totalSheets: solution.totalSheets,
      overageSheets: solution.overageSheets,
      supplierCount: solution.supplierCount,
      totalCostCents: solution.totalCostCents,
    };
    segment.message =
      `需求 ${demandSheets.toLocaleString('en-US')} 张（${sourceText}）：共采购 ${packCount.toLocaleString('en-US')} 包 / ` +
      `${solution.totalSheets.toLocaleString('en-US')} 张，超购 ${solution.overageSheets.toLocaleString('en-US')} 张，` +
      `总价 ${formatCents(solution.totalCostCents)} 元，使用 ${solution.supplierCount} 家供应商。`;
  } else {
    segment.maxPurchasableSheets = solution.maxPurchasableSheets;
    segment.gapSheets = solution.gapSheets;
    segment.message =
      `无可行组合：全部报价按最多可购包数采购仅 ${solution.maxPurchasableSheets.toLocaleString('en-US')} 张，` +
      `距需求 ${demandSheets.toLocaleString('en-US')} 张仍缺 ${solution.gapSheets.toLocaleString('en-US')} 张。`;
  }
  return segment;
}

module.exports = {
  parsePurchaseQuotesInput,
  solveQuoteCombination,
  attachPurchaseQuotes,
  formatCents,
};
