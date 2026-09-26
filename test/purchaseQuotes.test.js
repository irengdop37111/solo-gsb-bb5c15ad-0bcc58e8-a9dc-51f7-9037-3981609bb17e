'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parsePurchaseQuotesInput,
  solveQuoteCombination,
  attachPurchaseQuotes,
} = require('../src/purchaseQuotes');
const { computeImposition } = require('../src/imposition');

const BASE = { totalPages: 16, sheetsPerSignature: 2, binding: 'left', flip: 'short' };

/** 快捷构造规范化报价（跳过 parse，直接喂给求解器）。 */
function q(supplier, sheetsPerPack, priceCents, minPacks = 0, maxPacks = null, index = 0) {
  return { index, supplier, sheetsPerPack, priceCents, minPacks, maxPacks };
}

/* ------------------------------ 启用开关 ------------------------------ */

test('未启用：purchaseQuotes 缺省 / null / false / { enabled: false } 时响应不含该字段', () => {
  [undefined, null, false, { enabled: false }].forEach((purchaseQuotes) => {
    const parsed = parsePurchaseQuotesInput({ purchaseQuotes });
    assert.deepEqual(parsed, { enabled: false });
    const r = computeImposition(purchaseQuotes === undefined ? { ...BASE } : { ...BASE, purchaseQuotes });
    assert.equal(r.purchaseQuotes, undefined);
    assert.equal('purchaseQuotes' in r, false);
  });
});

/* ------------------------------ 求解器：优化目标与并列打破 ------------------------------ */

test('总价最低：两家报价组合优于单一报价（乙×4 + 甲×1 = 4500 张 / 1040 元）', () => {
  const quotes = [
    q('甲', 500, 12000, 0, null, 1),  // 500 张/包，120 元/包
    q('乙', 1000, 23000, 0, null, 2), // 1000 张/包，230 元/包
  ];
  const s = solveQuoteCombination(4500, quotes);
  assert.equal(s.feasible, true);
  // 甲×9 = 4500 张 / 1080 元；乙×5 = 5000 张 / 1150 元；乙×4+甲×1 = 4500 张 / 1040 元 ← 最优
  assert.deepEqual(s.packs, [1, 4]);
  assert.equal(s.totalSheets, 4500);
  assert.equal(s.overageSheets, 0);
  assert.equal(s.totalCostCents, 104000);
  assert.equal(s.supplierCount, 2);
});

test('总价相同 → 超购张数最少者优先', () => {
  const quotes = [
    q('甲', 500, 10000, 0, null, 1), // 甲×2 = 1000 张，超购 0
    q('乙', 600, 10000, 0, null, 2), // 乙×2 = 1200 张，超购 200
  ];
  const s = solveQuoteCombination(1000, quotes);
  assert.equal(s.totalCostCents, 20000);
  assert.deepEqual(s.packs, [2, 0]);
  assert.equal(s.overageSheets, 0);
});

test('总价、超购相同 → 供应商数量最少者优先', () => {
  const quotes = [
    q('甲', 1000, 20000, 0, null, 1), // 甲×1：1 家供应商
    q('乙', 500, 10000, 0, null, 2),  // 乙+丙：2 家供应商
    q('丙', 500, 10000, 0, null, 3),
  ];
  const s = solveQuoteCombination(1000, quotes);
  assert.equal(s.totalCostCents, 20000);
  assert.equal(s.overageSheets, 0);
  assert.deepEqual(s.packs, [1, 0, 0]);
  assert.equal(s.supplierCount, 1);
});

test('总价、超购、供应商数均相同 → 录入顺序优先（先录入者承担采购）', () => {
  const quotes = [
    q('甲', 500, 10000, 0, null, 1), // 与乙完全同价同规格，先录入
    q('乙', 500, 10000, 0, null, 2),
  ];
  const s = solveQuoteCombination(1000, quotes);
  assert.deepEqual(s.packs, [2, 0]); // 全部落在先录入的甲
  // 不同规格并列：甲×2（1000 张）与乙×1（1000 张）同价同超购同供应商数 → 甲优先
  const s2 = solveQuoteCombination(1000, [
    q('甲', 500, 5000, 0, null, 1),
    q('乙', 1000, 10000, 0, null, 2),
  ]);
  assert.deepEqual(s2.packs, [2, 0]);
});

test('价格按分精确计算：0.1×3 与 0.30 判等，不做浮点比较', () => {
  // 浮点下 0.1*3 = 0.30000000000000004 > 0.3，若按浮点比较会误判乙更便宜；
  // 按分计算两者同为 30 分，并列时录入顺序优先 → 甲×3。
  const quotes = [
    q('甲', 100, 10, 0, null, 1), // 0.10 元/包 = 10 分
    q('乙', 300, 30, 0, null, 2), // 0.30 元/包 = 30 分
  ];
  const s = solveQuoteCombination(300, quotes);
  assert.equal(s.totalCostCents, 30);
  assert.deepEqual(s.packs, [3, 0]);
});

test('最少可购包数：启用该供应商即至少购买 minPacks 包', () => {
  // 甲单价便宜但最少 5 包起购（2500 张远超需求），乙可零买
  const quotes = [
    q('甲', 500, 9000, 5, null, 1),
    q('乙', 500, 10000, 0, null, 2),
  ];
  const s = solveQuoteCombination(1000, quotes);
  // 甲×5 = 2500 张 / 450 元；乙×2 = 1000 张 / 200 元 → 乙
  assert.deepEqual(s.packs, [0, 2]);
  // 需求放大到甲的起购量合算时：甲×5 = 2500 张 / 450 元 vs 乙×5 = 2500 张 / 500 元
  const s2 = solveQuoteCombination(2400, quotes);
  assert.deepEqual(s2.packs, [5, 0]);
  assert.equal(s2.overageSheets, 100);
});

test('最多可购包数：单家不够时自动组合多家', () => {
  const quotes = [
    q('甲', 500, 10000, 0, 2, 1), // 最多 2 包（1000 张）
    q('乙', 500, 11000, 0, 3, 2), // 最多 3 包（1500 张）
  ];
  const s = solveQuoteCombination(2000, quotes);
  assert.deepEqual(s.packs, [2, 2]); // 甲买满 2 包 + 乙 2 包
  assert.equal(s.totalCostCents, 2 * 10000 + 2 * 11000);
});

test('无可行组合：返回具体缺口（最多可购张数与缺口张数）', () => {
  const quotes = [
    q('甲', 500, 10000, 0, 2, 1),
    q('乙', 1000, 20000, 0, 2, 2),
  ];
  const s = solveQuoteCombination(5000, quotes);
  assert.equal(s.feasible, false);
  assert.equal(s.maxPurchasableSheets, 2 * 500 + 2 * 1000); // 3000
  assert.equal(s.gapSheets, 2000);
});

/* ------------------------------ 随机对照：与暴力枚举一致 ------------------------------ */

/** 暴力枚举全部组合，按同一优先级取最优（用于交叉验证 DP 求解器）。 */
function bruteForce(demand, quotes) {
  const n = quotes.length;
  const packs = new Array(n).fill(0);
  let best = null;
  function better(a, b) {
    if (a.cost !== b.cost) return a.cost < b.cost;
    if (a.sheets !== b.sheets) return a.sheets < b.sheets; // 超购更少
    if (a.suppliers !== b.suppliers) return a.suppliers < b.suppliers;
    for (let i = 0; i < n; i++) {
      if (a.packs[i] !== b.packs[i]) return a.packs[i] > b.packs[i]; // 录入顺序优先
    }
    return false;
  }
  function dfs(i, sheets, cost, suppliers) {
    if (i === n) {
      if (sheets < demand) return;
      const cand = { sheets, cost, suppliers, packs: packs.slice() };
      if (!best || better(cand, best)) best = cand;
      return;
    }
    const qt = quotes[i];
    packs[i] = 0;
    dfs(i + 1, sheets, cost, suppliers);
    for (let p = Math.max(qt.minPacks, 1); p <= qt.maxPacks; p++) {
      packs[i] = p;
      dfs(i + 1, sheets + p * qt.sheetsPerPack, cost + p * qt.priceCents, suppliers + 1);
    }
    packs[i] = 0;
  }
  dfs(0, 0, 0, 0);
  return best;
}

test('随机小规模用例与暴力枚举完全一致（含边界与全部并列打破规则）', () => {
  let seed = 20260926;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  for (let round = 0; round < 300; round++) {
    const n = randInt(1, 4);
    const demand = randInt(1, 80);
    const quotes = [];
    for (let i = 0; i < n; i++) {
      const minPacks = randInt(0, 2);
      quotes.push(q(`S${i + 1}`, randInt(1, 15), randInt(0, 500), minPacks, minPacks + randInt(0, 4), i + 1));
    }
    const expected = bruteForce(demand, quotes);
    const actual = solveQuoteCombination(demand, quotes);
    if (!expected) {
      assert.equal(actual.feasible, false, `第 ${round} 轮应无可行组合`);
      const maxPurchasable = quotes.reduce((sum, x) => sum + x.maxPacks * x.sheetsPerPack, 0);
      assert.equal(actual.maxPurchasableSheets, maxPurchasable);
      assert.equal(actual.gapSheets, demand - maxPurchasable);
    } else {
      assert.equal(actual.feasible, true, `第 ${round} 轮应有可行组合`);
      assert.equal(actual.totalCostCents, expected.cost, `第 ${round} 轮总价不符`);
      assert.equal(actual.totalSheets, expected.sheets, `第 ${round} 轮总张数不符`);
      assert.equal(actual.supplierCount, expected.suppliers, `第 ${round} 轮供应商数不符`);
      assert.deepEqual(actual.packs, expected.packs, `第 ${round} 轮采购包数不符`);
      assert.equal(actual.overageSheets, expected.sheets - demand);
    }
  }
});

/* ------------------------------ 参数校验 ------------------------------ */

test('报价参数非法返回明确错误', () => {
  const valid = { demandSheets: 1000, quotes: [{ supplier: '甲', sheetsPerPack: 500, pricePerPack: 120 }] };
  assert.throws(() => parsePurchaseQuotesInput({ purchaseQuotes: 'x' }), /purchaseQuotes 必须为对象/);
  assert.throws(() => parsePurchaseQuotesInput({ purchaseQuotes: { demandSheets: 1000 } }), /至少需要 1 条本地报价/);
  assert.throws(() => parsePurchaseQuotesInput({ purchaseQuotes: { ...valid, demandSheets: 0 } }), /需求张数/);
  assert.throws(() => parsePurchaseQuotesInput({ purchaseQuotes: { ...valid, demandSheets: 500001 } }), /需求张数/);
  assert.throws(
    () => parsePurchaseQuotesInput({ purchaseQuotes: { quotes: [{ supplier: '', sheetsPerPack: 500, pricePerPack: 1 }] } }),
    /供应商/
  );
  assert.throws(
    () => parsePurchaseQuotesInput({
      purchaseQuotes: {
        quotes: [
          { supplier: '甲', sheetsPerPack: 500, pricePerPack: 1 },
          { supplier: '甲', sheetsPerPack: 600, pricePerPack: 2 },
        ],
      },
    }),
    /重复录入/
  );
  assert.throws(
    () => parsePurchaseQuotesInput({ purchaseQuotes: { quotes: [{ supplier: '甲', sheetsPerPack: 0, pricePerPack: 1 }] } }),
    /每包张数/
  );
  // 价格必须精确到分：0.105 元（三位小数）非法
  assert.throws(
    () => parsePurchaseQuotesInput({ purchaseQuotes: { quotes: [{ supplier: '甲', sheetsPerPack: 500, pricePerPack: 0.105 }] } }),
    /每包价格/
  );
  assert.throws(
    () => parsePurchaseQuotesInput({ purchaseQuotes: { quotes: [{ supplier: '甲', sheetsPerPack: 500, pricePerPack: '12.345' }] } }),
    /每包价格/
  );
  assert.throws(
    () => parsePurchaseQuotesInput({ purchaseQuotes: { quotes: [{ supplier: '甲', sheetsPerPack: 500, pricePerPack: -1 }] } }),
    /每包价格/
  );
  assert.throws(
    () => parsePurchaseQuotesInput({ purchaseQuotes: { quotes: [{ supplier: '甲', sheetsPerPack: 500, pricePerPack: 1, minPacks: -1 }] } }),
    /最少可购包数/
  );
  assert.throws(
    () => parsePurchaseQuotesInput({ purchaseQuotes: { quotes: [{ supplier: '甲', sheetsPerPack: 500, pricePerPack: 1, minPacks: 5, maxPacks: 3 }] } }),
    /不能小于最少可购包数/
  );
  assert.throws(
    () => parsePurchaseQuotesInput({
      purchaseQuotes: { quotes: Array.from({ length: 21 }, (_, i) => ({ supplier: `S${i}`, sheetsPerPack: 500, pricePerPack: 1 })) },
    }),
    /最多 20 条/
  );
});

test('价格解析：数字与字符串等价，0.1+0.2 这类浮点尾数不影响分值', () => {
  const parse = (pricePerPack) =>
    parsePurchaseQuotesInput({ purchaseQuotes: { quotes: [{ supplier: '甲', sheetsPerPack: 500, pricePerPack }] } }).quotes[0].priceCents;
  assert.equal(parse(120), 12000);
  assert.equal(parse(120.5), 12050);
  assert.equal(parse('120.50'), 12050);
  assert.equal(parse('0.30'), 30);
  assert.equal(parse(0.1 + 0.2), 30); // 0.30000000000000004 仍解析为 30 分
  assert.equal(parse(0), 0); // 免费报价合法
});

/* ------------------------------ 与印刷备料集成（computeImposition） ------------------------------ */

const PREP = { copies: 1000, makereadySheets: 10, processWasteRate: 0.03, sheetsPerPack: 500 };
const QUOTES = [
  { supplier: '甲', sheetsPerPack: 500, pricePerPack: 120 },
  { supplier: '乙', sheetsPerPack: 1000, pricePerPack: 230 },
];

test('接入印刷备料整包采购张数：需求缺省时自动取 purchaseSheets', () => {
  const r = computeImposition({ ...BASE, materialPrep: PREP, purchaseQuotes: { quotes: QUOTES } });
  const pq = r.purchaseQuotes;
  assert.equal(pq.enabled, true);
  assert.equal(pq.demandSource, 'materialPrep');
  assert.equal(pq.demandSheets, r.materialPrep.totals.purchaseSheets); // 4500
  assert.equal(pq.demandSheets, 4500);
  assert.equal(pq.feasible, true);
  // 乙×4 + 甲×1 = 4500 张 / 1040 元
  assert.deepEqual(pq.quotes.map((x) => x.packs), [1, 4]);
  assert.equal(pq.totals.totalCostCents, 104000);
  assert.equal(pq.totals.overageSheets, 0);
  assert.equal(pq.totals.supplierCount, 2);
  // 逐报价余量：maxPacks 缺省不限 → null
  pq.quotes.forEach((x) => {
    assert.equal(x.remainingPacks, null);
    assert.equal(x.remainingSheets, null);
  });
});

test('手工填写需求张数优先于印刷备料整包采购张数', () => {
  const r = computeImposition({
    ...BASE,
    materialPrep: PREP,
    purchaseQuotes: { demandSheets: 1000, quotes: QUOTES },
  });
  const pq = r.purchaseQuotes;
  assert.equal(pq.demandSource, 'manual');
  assert.equal(pq.demandSheets, 1000);
  // 甲×2 = 1000 张 / 240 元 vs 乙×1 = 1000 张 / 230 元 → 乙×1
  assert.deepEqual(pq.quotes.map((x) => x.packs), [0, 1]);
  assert.equal(pq.totals.totalCostCents, 23000);
});

test('未启用印刷备料且未填需求张数：返回明确错误', () => {
  assert.throws(
    () => computeImposition({ ...BASE, purchaseQuotes: { quotes: QUOTES } }),
    /需求张数 demandSheets.*印刷备料/
  );
});

test('逐报价余量：maxPacks 有限时给出剩余可购包数 / 张数', () => {
  const r = computeImposition({
    ...BASE,
    purchaseQuotes: {
      demandSheets: 1000,
      quotes: [{ supplier: '甲', sheetsPerPack: 500, pricePerPack: 100, maxPacks: 5 }],
    },
  });
  const row = r.purchaseQuotes.quotes[0];
  assert.equal(row.packs, 2);
  assert.equal(row.sheets, 1000);
  assert.equal(row.costCents, 20000);
  assert.equal(row.remainingPacks, 3);
  assert.equal(row.remainingSheets, 1500);
});

test('无可行组合：feasible=false 并带具体缺口，逐报价采购量为 0', () => {
  const r = computeImposition({
    ...BASE,
    purchaseQuotes: {
      demandSheets: 5000,
      quotes: [{ supplier: '甲', sheetsPerPack: 500, pricePerPack: 100, maxPacks: 4 }],
    },
  });
  const pq = r.purchaseQuotes;
  assert.equal(pq.feasible, false);
  assert.equal(pq.maxPurchasableSheets, 2000);
  assert.equal(pq.gapSheets, 3000);
  assert.match(pq.message, /缺 3,000 张/);
  assert.equal(pq.totals, undefined);
  assert.equal(pq.quotes[0].packs, 0);
});

test('attachPurchaseQuotes：未启用返回 undefined（不写入任何字段）', () => {
  assert.equal(attachPurchaseQuotes({ enabled: false }, undefined), undefined);
});
