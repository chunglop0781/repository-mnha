// test/online-pool.js — xem thư mục / ảnh trên mạng khi nguồn là repo của app (nhóm repo -1, -2…): gộp đủ file, link đúng repo.
'use strict';
const assert = require('assert');
const rs = require('../services/code/remoteSource');

const MAIN = { owner: 'me', repo: 'repository-mnha-database', branch: 'main' };
const R1 = { owner: 'me', repo: 'repository-mnha-database-1', branch: 'main' };
const fakeGh = {
    isPoolRepo: (o, r) => o === 'me' && /^repository-mnha-database(-\d+)?$/.test(r),
    listDir: async (dir) => (dir === 'u1/codes/html/d'
        ? { files: [{ name: 'a.png', rec: R1 }, { name: 'index.html', rec: R1 }, { name: 'mnha-media.json', rec: MAIN }], dirs: [{ name: 'sub', rec: R1 }, { name: 'old', rec: MAIN }] }
        : null),
    repoIfKnown: async (p) => (p === 'u1/codes/html/d/mnha-media.json' ? MAIN : p === 'u1/codes/html/d/a.png' ? R1 : null)
};
rs.setPoolProvider(() => fakeGh);

(async () => {
    const f = { host: 'github', base: ['me', 'repository-mnha-database'], ref: 'main', dirSegs: ['u1', 'codes', 'html', 'd'] };
    const items = await rs.listFolder(f);
    // file ở repo -1 vẫn hiện khi mở link repo chính; manifest hệ thống bị ẩn
    assert.deepStrictEqual(items.map((x) => x.name), ['old', 'sub', 'a.png', 'index.html']);
    assert.strictEqual(items.hasManifest, true);
    assert.strictEqual(rs.otherRepo(f, items.find((x) => x.name === 'a.png')).repo, 'repository-mnha-database-1');
    assert.strictEqual(rs.otherRepo(f, items.find((x) => x.name === 'old')), null);        // cùng repo đang xem → không nhãn
    const link = rs.fromParts(rs.withRepo(f, R1), [...f.dirSegs, 'a.png']).web;
    assert(link.includes('/me/repository-mnha-database-1/blob/main/u1/codes/html/d/a.png'), link);
    console.log('✓ listFolder gộp mọi repo của app, mục ở repo khác có link repo đó');

    // locateLink: ảnh ở repo -1, manifest ở repo chính — dù trang đang xem thuộc repo nào
    const a = await rs.locateLink(f, [...f.dirSegs, 'a.png']);
    assert(a.raw.includes('/repository-mnha-database-1/'), a.raw);
    const f1 = { ...f, base: ['me', 'repository-mnha-database-1'] };
    const m = await rs.locateLink(f1, [...f1.dirSegs, 'mnha-media.json']);
    assert(m.raw.includes('/repository-mnha-database/') && !m.raw.includes('database-1'), m.raw);
    const unknown = await rs.locateLink(f1, [...f1.dirSegs, 'x.css']);            // chưa biết ở đâu → giữ repo đang xem
    assert(unknown.raw.includes('/repository-mnha-database-1/'), unknown.raw);
    console.log('✓ locateLink tự tìm đúng repo chứa ảnh / manifest');

    // repo lạ (không thuộc app) → không đổi gì
    const g = { host: 'github', base: ['other', 'repo'], ref: 'main', dirSegs: ['u1', 'codes', 'html', 'd'] };
    assert((await rs.locateLink(g, [...g.dirSegs, 'a.png'])).raw.includes('/other/repo/'));
    console.log('online-pool: tất cả test đạt');
})().catch((e) => { console.error(e); process.exit(1); });
