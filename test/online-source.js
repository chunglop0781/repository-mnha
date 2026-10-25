// test/online-source.js — "Xem code trên mạng": phân tích link, chặn SSRF/redirect, tải an toàn; chạy từ link thì lịch sử lưu origin + code + screen.
//   Chạy: node test/online-source.js   (không cần mạng/GitHub thật: giả lập fetch và GitHub)
const R = require('path').join(__dirname, '..') + '/';
const assert = require('assert');
// ---- giả GitHub
const saved = [];
const fakeGh = { isConfigured: true, owner: 'o', repo: 'r', branch: 'main',
  async getRepoTree() { return { files: new Map(), truncated: false }; },
  async writeJsonFile(p, data) { saved.push({ p, data }); } };
const gp = require.resolve(R + 'services/githubService.js');
require.cache[gp] = { id: gp, filename: gp, loaded: true, exports: fakeGh };

const rs = require(R + 'services/code/remoteSource.js');
const mk = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] || null }, arrayBuffer: async () => Buffer.from(body), body: null });
let calls = [];
async function withFetch(fn, impl) { const o = global.fetch; global.fetch = async (u, opt) => { calls.push(u); return impl(u, opt); }; try { return await fn(); } finally { global.fetch = o; } }
const P = (u) => rs.parseSourceUrl(u);

(async () => {
  // ok
  let txt = await withFetch(() => rs.fetchText(P('https://github.com/a/b/blob/main/x.asm')), () => mk(200, 'mov ax,1\n', { 'content-type': 'text/plain' }));
  assert.strictEqual(txt, 'mov ax,1\n'); assert(calls[0].startsWith('https://raw.githubusercontent.com/a/b/main/'));
  // cache (không gọi fetch lần 2)
  calls = []; await withFetch(() => rs.fetchText(P('https://github.com/a/b/blob/main/x.asm')), () => { throw new Error('không được tải lại'); }); assert.strictEqual(calls.length, 0, 'lần 2 lấy từ cache, không tải lại');
  console.log('✔ tải + cache');
  // redirect tới host lạ → từ chối
  await assert.rejects(withFetch(() => rs.fetchText(P('https://gitlab.com/g/p/-/blob/main/a.asm')), () => mk(302, '', { location: 'http://169.254.169.254/latest' })), /không được phép/);
  await assert.rejects(withFetch(() => rs.fetchText(P('https://gitlab.com/g/p2/-/blob/main/a.asm')), () => mk(302, '', { location: 'https://evil.example/x' })), /không được phép/);
  console.log('✔ chặn redirect ra ngoài (SSRF)');
  // redirect hợp lệ cùng host
  let n = 0; txt = await withFetch(() => rs.fetchText(P('https://github.com/a/b/blob/main/y.asm')), (u) => (n++ === 0 ? mk(301, '', { location: 'https://raw.githubusercontent.com/a/b2/main/y.asm' }) : mk(200, 'ok', { 'content-type': 'text/plain' })));
  assert.strictEqual(txt, 'ok'); console.log('✔ redirect hợp lệ');
  // html / quá lớn / nhị phân / 404
  await assert.rejects(withFetch(() => rs.fetchText(P('https://gitlab.com/g/p3/-/blob/main/a.asm')), () => mk(200, '<html>', { 'content-type': 'text/html; charset=utf-8' })), /trang web/);
  await assert.rejects(withFetch(() => rs.fetchText(P('https://github.com/a/b/blob/main/big.asm')), () => mk(200, 'x'.repeat(200 * 1024 + 1), { 'content-type': 'text/plain' })), /quá lớn/);
  await assert.rejects(withFetch(() => rs.fetchText(P('https://github.com/a/b/blob/main/bin.asm')), () => mk(200, 'ab\0cd', { 'content-type': 'text/plain' })), /văn bản/);
  await assert.rejects(withFetch(() => rs.fetchText(P('https://github.com/a/b/blob/main/no.asm')), () => mk(404, '')), /Không tìm thấy/);
  console.log('✔ html / quá lớn / nhị phân / 404 bị từ chối');

  // ---- chạy emu8086 từ "link": lịch sử có origin + source
  const sessions = require(R + 'services/code/sessionManager.js');
  const code = ['.model small', '.stack 100h', '.data', "msg db 'Hi$'", '.code', 'main proc', '  mov ax,@data', '  mov ds,ax', '  lea dx,msg', '  mov ah,9', '  int 21h', '  mov ah,4ch', '  int 21h', 'main endp', 'end main', ''].join('\n');
  const s = await sessions.create({ uid: 'u1', lang: 'emu8086', code, file: 'x.asm', dir: '', siblingFiles: [], origin: 'https://github.com/a/b/blob/main/x.asm' });
  for (let i = 0; i < 100 && !s.savedPath && !s.saveError; i++) await new Promise((r) => setTimeout(r, 50));
  assert(s.savedPath, 'đã lưu lịch sử: ' + s.saveError);
  const rec = saved[saved.length - 1].data;
  assert.strictEqual(rec.origin, 'https://github.com/a/b/blob/main/x.asm'); assert.strictEqual(rec.source, code);
  assert(rec.screen.join('\n').includes('Hi'), 'có màn hình'); assert.strictEqual(rec.file, 'x.asm');
  console.log('✔ chạy từ link → lịch sử lưu origin + code + screen');
  // chạy file thường: không có origin
  const s2 = await sessions.create({ uid: 'u1', lang: 'emu8086', code, file: 'y.asm', dir: 'd' });
  for (let i = 0; i < 100 && !s2.savedPath; i++) await new Promise((r) => setTimeout(r, 50));
  assert(!('origin' in saved[saved.length - 1].data)); console.log('✔ file thường không gắn origin');
  process.exit(0);
})().catch((e) => { console.error('✘', e); process.exit(1); });

