const express = require('express');
const rateLimit = require('express-rate-limit');
const c = require('../controllers/auth.controller');
const router = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

router.get('/login', c.showLogin);
router.post('/login', limiter, c.login);
router.get('/register', c.showRegister);
router.post('/register', limiter, c.register);
router.get('/verify-otp', c.showVerify);
router.post('/verify-otp', limiter, c.verify);
router.post('/logout', c.logout);
router.get('/logout', c.logout);
module.exports = router;
