// node test/session-store.js — kiểm tra mã hoá 2 chiều + store cookies/index.json + chuyển từ Mongo (không cần mạng)
process.env.SESSION_ENC_KEY = 'k'.repeat(40);
const assert = require('assert');
const sc = require('../services/sessionCrypto');
const Store = require('../services/githubSessionStore');
const { convertDoc } = require('../scripts/migrateMongoToGithub');

const files = new Map(); let updates = 0;
const gh = {
    readJsonFile: async (p) => (files.has(p) ? JSON.parse(files.get(p)) : null),
    writeJsonFile: async (p, d) => { files.set(p, JSON.stringify(d)); },
    updateJsonFile: async (p, fn) => { updates++; if (!files.has(p)) throw new Error('404'); files.set(p, JSON.stringify(await fn(JSON.parse(files.get(p))))); }
};
const P = (f, ...a) => new Promise((ok, no) => f(...a, (e, r) => (e ? no(e) : ok(r))));
const mk = () => new Store({ gh, flushMs: 5, cacheMs: 5000 });
const sess = (extra = {}) => ({ cookie: { originalMaxAge: 86400000, expires: new Date(Date.now() + 86400000).toISOString(), httpOnly: true }, user: { _id: 'u1', name: 'Hùng Anh', email: 'a@b.vn' }, ...extra });

(async () => {
    // 1. mã hoá 2 chiều
    const t = sc.encrypt({ a: 1 }, 'x'); assert.deepStrictEqual(sc.decrypt(t, 'x'), { a: 1 });
    assert.throws(() => sc.decrypt(t, 'y')); assert.throws(() => sc.decrypt(t.slice(0, -2) + 'AA', 'x'));
    console.log('✓ mã hoá/giải mã 2 chiều, sai AAD / bị sửa → lỗi');

    // 2. set → file chỉ chứa dữ liệu mã hoá
    const s1 = mk(); const sid = 'SID-ABC-123';
    await P(s1.set.bind(s1), sid, sess());
    const raw = files.get('cookies/index.json');
    assert(raw && !raw.includes('a@b.vn') && !raw.includes('Hùng') && !raw.includes(sid)); console.log('✓ cookies/index.json không lộ email/tên/sid');
    // 3. instance mới (cache trống) đọc + giải mã lại
    const s2 = mk(); const got = await P(s2.get.bind(s2), sid); assert.strictEqual(got.user.email, 'a@b.vn'); console.log('✓ instance mới đọc & giải mã lại đúng');
    assert.strictEqual(await P(s2.get.bind(s2), 'khong-co'), null);
    // 4. gom ghi: 10 set song song → 1 commit
    updates = 0; await Promise.all(Array.from({ length: 10 }, (_, i) => P(s1.set.bind(s1), 'S' + i, sess({ n: i })))); assert.strictEqual(updates, 1);
    console.log('✓ 10 session ghi cùng lúc = 1 commit'); assert.strictEqual((await P(mk().get.bind(mk()), 'S7')).n, 7);
    // 5. touch không tạo commit; set trùng nội dung không ghi
    updates = 0; await P(s1.touch.bind(s1), sid, sess()); await P(s1.set.bind(s1), sid, sess()); 
    console.log('✓ touch/set trùng → commit:', updates, '(mong đợi ≤ 1)'); assert(updates <= 1);
    // 6. destroy
    await P(s1.destroy.bind(s1), sid); assert.strictEqual(await P(mk().get.bind(mk()), sid), null); console.log('✓ destroy');
    // 7. hết hạn → null và bị dọn ở lần ghi sau
    const old = sess(); old.cookie.expires = new Date(Date.now() - 1000).toISOString();
    await P(s1.set.bind(s1), 'OLD', old); assert.strictEqual(await P(s1.get.bind(s1), 'OLD'), null);
    await P(s1.set.bind(s1), 'NEW', sess()); assert.strictEqual(Object.keys(JSON.parse(files.get('cookies/index.json')).sessions).includes(sc.sidId('OLD')), false); console.log('✓ hết hạn → không trả về, tự dọn');
    // 8. sai khoá → coi như chưa đăng nhập
    process.env.SESSION_ENC_KEY = 'z'.repeat(40); sc.resetKeys(); assert.strictEqual(await P(mk().get.bind(mk()), 'S3'), null); console.log('✓ sai khoá → null (không văng lỗi)');
    process.env.SESSION_ENC_KEY = 'k'.repeat(40); sc.resetKeys();
    // 9. chuyển từ Mongo (session dạng chuỗi JSON như connect-mongo) + đối chiếu
    const doc = { _id: 'MONGO-SID-1', expires: new Date(Date.now() + 3600e3), session: JSON.stringify({ cookie: { originalMaxAge: 86400000, httpOnly: true }, user: { _id: 'u9', email: 'm@x.vn' } }) };
    const c = convertDoc(doc); assert(c.sid === 'MONGO-SID-1' && c.exp > Date.now());
    assert.strictEqual(convertDoc({ _id: 'e', expires: new Date(Date.now() - 1), session: '{}' }).skip, 'expired'); assert.strictEqual(convertDoc({ _id: 'b', session: '{bad' }).skip, 'invalid');
    const s3 = mk(); const r = await s3.importSessions([c]); assert.deepStrictEqual(r, { added: 1, skipped: 0 });
    assert.deepStrictEqual(await s3.verify('MONGO-SID-1'), c.sess); assert.deepStrictEqual(await s3.importSessions([c]), { added: 0, skipped: 1 });
    const s4 = mk(); assert.strictEqual((await P(s4.get.bind(s4), 'MONGO-SID-1')).user.email, 'm@x.vn'); console.log('✓ chuyển từ Mongo → GitHub, đối chiếu khớp, chạy lại không nhân đôi');
    console.log('TẤT CẢ ĐẠT');
})().catch((e) => { console.error('✗', e); process.exit(1); });
