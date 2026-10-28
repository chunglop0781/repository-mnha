// routes/code.js — mount ở /code (menu chính ở '/' do server.js gắn)
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/code.controller');
const html = require('../controllers/html.controller');
const { attachUser, requireAuth } = require('../middleware/auth');
const { requireMediaUploader } = require('../middleware/uploadAuth');
const { requireLocalData } = require('../services/connect/locality');

router.use(attachUser);
router.use(requireAuth);          // chỉ cần đăng nhập

// phiên chạy (đặt TRƯỚC /:lang)
router.get('/session/:sid', ctrl.poll);
router.post('/session/:sid/input', ctrl.input);
router.post('/session/:sid/stop', ctrl.stop);

router.get('/emu8086/engine.js', ctrl.emuEngine);      // bộ máy emu8086 chạy ở trình duyệt (mỗi người một máy ảo riêng, không cần phiên trên máy chủ)

// HTML + CSS (đặt TRƯỚC /:lang; các thao tác chung như folder/save/delete rơi xuống route chung bên dưới)
const raw = express.raw({ type: () => true, limit: '4mb' });          // phần/đoạn tải lên ≤ 3.5MB (Vercel giới hạn 4.5MB)
router.get('/html', html.files);
router.get('/html/edit', html.edit);
router.get('/html/player', html.player);
router.get('/html/online', html.online);
router.get('/html/online/folder', html.onlineFolder);
router.get('/html/online/player', html.onlinePlayer);
router.post('/html/file', html.createFile);
router.post('/html/preview-token', html.previewToken);
router.post('/html/upload/init', requireMediaUploader, html.uploadInit);
router.post('/html/upload/local/init', requireLocalData, requireMediaUploader, html.uploadLocalInit);
router.post('/html/upload/node-fail', requireMediaUploader, html.uploadNodeFail);
router.put('/html/upload/part', requireLocalData, requireMediaUploader, raw, html.uploadPart);
router.post('/html/upload/finish', requireLocalData, requireMediaUploader, html.uploadFinish);
router.put('/html/upload/seg', requireLocalData, requireMediaUploader, raw, html.uploadSeg);
router.post('/html/upload/commit', requireLocalData, requireMediaUploader, html.uploadCommit);
router.put('/html/save/part', raw, html.savePart);
router.post('/html/save/finish', html.saveFinish);
router.get('/html/raw', html.raw);
router.get('/html/online/raw', html.onlineRaw);
router.post('/html/media/delete', html.mediaDelete);
router.post('/html/media/visibility', html.mediaVisibility);

router.get('/:lang', ctrl.files);
router.get('/:lang/edit', ctrl.edit);
router.get('/:lang/warmup', ctrl.warmup);
router.get('/:lang/siblings', ctrl.siblings);
router.post('/:lang/siblings', ctrl.siblingsPost);
router.post('/:lang/client-result', ctrl.saveClientResult);
router.get('/:lang/history', ctrl.history);
router.get('/:lang/online', ctrl.online);
router.get('/:lang/online/folder', ctrl.onlineFolder);      // đọc thư mục trên mạng (chỉ file liên quan tới dạng code)
router.get('/:lang/results', ctrl.results);
router.get('/:lang/results/:ts', ctrl.resultOne);
router.post('/:lang/folder', ctrl.createFolder);
router.post('/:lang/rename-folder', ctrl.renameFolder);
router.post('/:lang/rename-file', ctrl.renameFile);      // đổi tên thư mục (cả html)
router.post('/:lang/file', ctrl.createFile);
router.post('/:lang/save', ctrl.save);
router.post('/:lang/delete', ctrl.remove);
router.post('/:lang/run', ctrl.run);
router.post('/:lang/compile', ctrl.compile);
router.post('/:lang/save-output', ctrl.saveOutputFile);

module.exports = router;
