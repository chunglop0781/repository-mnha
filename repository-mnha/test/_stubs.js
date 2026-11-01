// test/_stubs.js — chỉ dùng khi chạy test ở máy KHÔNG cài node_modules (vd sandbox): giả '@octokit/rest' để require được config/github.js.
// Dùng:  node -r ./test/_stubs.js test/xxx.js     (máy bạn đã `npm install` thì không cần)
const Module = require('module'); const orig = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@octokit/rest') {
    try { return orig.call(this, request, ...rest); } catch (_) {
      return { Octokit: class { constructor() { this.hook = { error() {}, after() {} }; this.git = {}; this.repos = {}; } } };
    }
  }
  return orig.call(this, request, ...rest);
};
