const Module = require('module'); const orig = Module._load;
const files = new Map();
const gh = {
  getRepoTree: async () => ({ files: new Map([...files.keys()].map((k) => [k, 'x'])) }),
  writeBinaryFile: async (p, b) => { files.set(p, b); },
  readBinaryFile: async (p) => files.get(p) || null,
  writeJsonFile: async (p, d) => { files.set(p, Buffer.from(JSON.stringify(d))); },
  readJsonFile: async (p) => files.has(p) ? JSON.parse(files.get(p)) : null,
  deleteFile: async (p) => { files.delete(p); },
};
Module._load = function (r, ...a) { if (/githubService$/.test(r)) return gh; return orig.call(this, r, ...a); };
const store = require('../services/code/codeStore');
const sm = require('../services/code/sessionManager');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const uid = 'u1';
  await store.mkdir(uid, 'cpp', '', 'bai1');
  await store.writeFile(uid, 'cpp', 'bai1', 'input', '5 6\n'.replace('input','')); // placeholder
  await store.writeFile(uid, 'cpp', 'bai1', 'input.txt', '5 6\n');
  console.log('list', JSON.stringify(await store.list(uid, 'cpp', 'bai1')));
  try { await store.mkdir(uid, 'cpp', '../x', 'y'); } catch (e) { console.log('path guard:', e.message); }
  try { await store.writeFile(uid, 'emu8086', '', 'a.cpp', 'x'); } catch (e) { console.log('ext guard:', e.message); }
  // cpp + freopen
  const sib = await store.siblingTextFiles(uid, 'cpp', 'bai1');
  let s = await sm.create({ uid, lang: 'cpp', code: '#include <bits/stdc++.h>\nint main(){freopen("input.txt","r",stdin);freopen("output.txt","w",stdout);int a,b;std::cin>>a>>b;std::cout<<a+b;}', file: 'main.cpp', dir: 'bai1', siblingFiles: sib });
  while (s.impl.status !== 'finished') await sleep(100); await sleep(200);
  console.log('cpp freopen:', JSON.stringify(s.impl.view().files), 'saved:', s.savedPath);
  // emu8086 with input
  s = await sm.create({ uid, lang: 'emu8086', code: 'org 100h\nmov ah,1\nint 21h\nmov dl,al\nmov ah,2\nint 21h\nret', file: 'a.asm', dir: '' });
  await sleep(100); console.log('emu waiting:', s.impl.view().waiting, s.impl.view().waitMode);
  s.impl.sendInput('Q'); await sleep(200);
  console.log('emu screen:', JSON.stringify(s.impl.view().screen), s.impl.status, 'saved:', s.savedPath);
  // lỗi cũng được lưu
  s = await sm.create({ uid, lang: 'emu8086', code: 'mov ax, bl', file: 'bad.asm', dir: '' }); await sleep(300);
  console.log('asm err saved:', s.savedPath, JSON.stringify(JSON.parse(files.get(s.savedPath)).assemble));
  console.log('results:', JSON.stringify(await store.listResults(uid, 'emu8086')));
})();
