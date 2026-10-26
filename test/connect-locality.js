// Test: services/connect/locality.js — localhost tự giữ dữ liệu; web chính trên mạng phải qua web kết nối
const assert = require('assert');
const L = require('../services/connect/locality');
const rq = (host) => ({ hostname: host.replace(/:\d+$/, ''), headers: { host } });
delete process.env.DATA_NODE;
for (const h of ['localhost:3000', '127.0.0.1:3000', 'localhost', 'app.localhost:3000']) assert.strictEqual(L.dataMode(rq(h)), 'local', h);
for (const h of ['repository-mnha.vercel.app', 'repository-mnha-data-1.vercel.app', 'localhost.evil.com']) assert.strictEqual(L.dataMode(rq(h)), 'node', h);
process.env.DATA_NODE = 'on';
assert.strictEqual(L.dataMode(rq('x.vercel.app')), 'self');
delete process.env.DATA_NODE;
let code = null, nexted = false;
const res = { status(c) { code = c; return this; }, json(o) { this.body = o; return this; } };
L.requireLocalData(rq('repository-mnha.vercel.app'), res, () => { nexted = true; });
assert.strictEqual(code, 403); assert.strictEqual(res.body.code, 'DATA_ON_NODE'); assert.ok(!nexted);
L.requireLocalData(rq('localhost:3000'), res, () => { nexted = true; }); assert.ok(nexted);
console.log('connect-locality: OK');
