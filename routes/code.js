// routes/code.js — mount ở /code (menu chính ở '/' do server.js gắn)
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/code.controller');
const { attachUser, requireAuth } = require('../middleware/auth');

router.use(attachUser);
router.use(requireAuth);          // chỉ cần đăng nhập

// phiên chạy (đặt TRƯỚC /:lang)
router.get('/session/:sid', ctrl.poll);
router.post('/session/:sid/input', ctrl.input);
router.post('/session/:sid/stop', ctrl.stop);

router.get('/:lang', ctrl.files);
router.get('/:lang/edit', ctrl.edit);
router.get('/:lang/siblings', ctrl.siblings);
router.post('/:lang/client-result', ctrl.saveClientResult);
router.get('/:lang/results', ctrl.results);
router.get('/:lang/results/:ts', ctrl.resultOne);
router.post('/:lang/folder', ctrl.createFolder);
router.post('/:lang/file', ctrl.createFile);
router.post('/:lang/save', ctrl.save);
router.post('/:lang/delete', ctrl.remove);
router.post('/:lang/run', ctrl.run);
router.post('/:lang/compile', ctrl.compile);
router.post('/:lang/save-output', ctrl.saveOutputFile);

module.exports = router;
