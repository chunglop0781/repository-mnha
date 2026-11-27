// node test/perf-kit.js — PerfKit: lát chạy thích ứng, hash, LRU, nhường bằng MessageChannel, chính sách tải trước
const assert = require('assert');
const PK = require('../public/js/perfKit.js');

// nextBatch: hội tụ về ≈ 12ms/lát, không dao động mạnh, có chặn dưới/trên
let b = 20000;
for (let i = 0; i < 12; i++) b = PK.nextBatch(b, b / 1e6 * 1000 / 1);     // máy chạy 1 triệu lệnh/giây → 12ms ≈ 12000 lệnh
assert(b >= 11000 && b <= 13000, 'hội tụ về ~12000, thực tế ' + b);
let f = 20000; for (let i = 0; i < 30; i++) f = PK.nextBatch(f, f / 5e7 * 1000);    // máy nhanh 50 triệu lệnh/giây → 600000
assert(f >= 550000 && f <= 650000, 'máy nhanh → lát lớn, thực tế ' + f);
assert.strictEqual(PK.nextBatch(20000, 1000), 10000, 'chậm gấp bội → chỉ giảm tối đa ÷2 mỗi lát');
assert.strictEqual(PK.nextBatch(20000, 1), 40000, 'nhanh gấp bội → chỉ tăng tối đa ×2 mỗi lát');
assert.strictEqual(PK.nextBatch(20000, 0), 40000, 'đồng hồ thô (Safari làm tròn 1ms) báo 0ms → tăng dần');
assert.strictEqual(PK.nextBatch(3000, 1e6), 2000, 'chặn dưới'); assert.strictEqual(PK.nextBatch(4e6, 0), 4e6, 'chặn trên');

// hash: ổn định, nhạy với mọi phần, không nhầm ranh giới giữa các phần
assert.strictEqual(PK.hash(['a', 'b']), PK.hash(['a', 'b']));
assert.notStrictEqual(PK.hash(['a', 'b']), PK.hash(['ab', '']));
assert.notStrictEqual(PK.hash(['a', 'b']), PK.hash(['b', 'a']));
assert.notStrictEqual(PK.hash(['int main(){}']), PK.hash(['int main(){ }']));
const seen = new Set(); for (let i = 0; i < 20000; i++) seen.add(PK.hash(['code', String(i)])); assert.strictEqual(seen.size, 20000, 'không đụng hash trong 20000 mẫu');

// LRU
const l = new PK.Lru(3); l.set('a', 1); l.set('b', 2); l.set('c', 3); l.get('a'); l.set('d', 4);
assert(l.has('a') && !l.has('b') && l.has('c') && l.has('d') && l.size === 3, 'đẩy phần tử ít dùng gần nhất');

// shouldPreload
assert.strictEqual(PK.shouldPreload(undefined), true);
assert.strictEqual(PK.shouldPreload({ connection: { saveData: true } }), false, 'Tiết kiệm dữ liệu → không tải trước');
assert.strictEqual(PK.shouldPreload({ connection: { effectiveType: '2g' } }), false);
assert.strictEqual(PK.shouldPreload({ connection: { effectiveType: 'slow-2g' } }), false);
assert.strictEqual(PK.shouldPreload({ connection: { effectiveType: '4g' } }), true);
assert.strictEqual(PK.shouldPreload({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Version/18.1 Mobile/15E148 Safari/604.1' }), false, 'iPhone → không tải trước (tránh jetsam)');
assert.strictEqual(PK.shouldPreload({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 }), false, 'iPad chế độ desktop');
assert.strictEqual(PK.shouldPreload({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 0 }), true, 'Mac thật');
assert.strictEqual(PK.shouldPreload({ deviceMemory: 2 }), false, 'máy ít RAM');
assert.strictEqual(PK.shouldPreload({ deviceMemory: 8 }), true);

// yieldNow: giữ thứ tự, không đệ quy đồng bộ, không bị khoá 4ms
(async () => {
    const keep = setInterval(() => { }, 1000);      // port1.unref() (để Node không bị treo) → cần 1 timer giữ tiến trình sống trong lúc chờ MessageChannel
    const order = []; let sync = true;
    PK.yieldNow(() => { order.push(1); assert.strictEqual(sync, false, 'không được chạy đồng bộ'); });
    PK.yieldNow(() => order.push(2)); PK.yieldNow(() => order.push(3)); sync = false;
    await new Promise((r) => setTimeout(r, 20)); assert.deepStrictEqual(order, [1, 2, 3]);
    const t0 = process.hrtime.bigint(); let n = 0;
    await new Promise((res) => { (function tick() { if (++n >= 2000) return res(); PK.yieldNow(tick); })(); });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert(ms < 400, '2000 lần nhường phải nhanh (thực tế ' + ms.toFixed(0) + 'ms; setTimeout(0) lồng nhau tốn ≥ 4ms/lần ở trình duyệt)');
    console.log('perf-kit: lát thích ứng, hash, LRU, preload policy, yieldNow (2000 lần nhường: ' + ms.toFixed(0) + 'ms) — đạt');
    clearInterval(keep); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
