// controllers/auth.controller.js — đăng nhập / đăng ký (OTP) dùng CHUNG collection users & otps
// với dự án Luyện thi CNTT UTC → tài khoản tạo ở web nào cũng dùng được ở web kia.
// Tài khoản mới có đúng dạng dự án cũ yêu cầu (role 'client', status 'pending', userKey null);
// repository-mnha KHÔNG kiểm tra/đọc trạng thái duyệt.
'use strict';
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const User = require('../models/User');
const OTP = require('../models/OTP');
const { OTP_TTL_MS } = OTP;
const mail = require('../services/mailService');

const IS_DEV = process.env.NODE_ENV !== 'production';
const RESEND_COOLDOWN_MS = 60 * 1000, MAX_ATTEMPTS = 5;
const norm = (e) => String(e || '').trim().toLowerCase();
const genOTP = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const saveSession = (req) => new Promise((ok) => (req.session ? req.session.save(() => ok()) : ok()));
const sessionUser = (u) => ({ _id: String(u._id), name: u.name, email: u.email });

exports.showLogin = (req, res) => {
    if (req.session && req.session.user) return res.redirect('/');
    res.render('auth/login', { title: 'Đăng nhập', error: null, email: req.query.email || '', info: req.query.registered ? 'Đăng ký thành công, hãy đăng nhập.' : null });
};
exports.login = async (req, res) => {
    const email = norm(req.body.email), password = String(req.body.password || '');
    const fail = (msg, code = 401) => res.status(code).render('auth/login', { title: 'Đăng nhập', error: msg, email, info: null });
    try {
        const user = email ? await User.findOne({ email }).select('+password') : null;
        const ok = user ? await bcrypt.compare(password, user.password) : false;
        if (!user || !ok) return fail('Email hoặc mật khẩu không đúng.');
        if (user.status === 'disabled') return fail('Tài khoản đã bị vô hiệu hoá.', 403);
        req.session.user = sessionUser(user);
        const back = req.session.returnTo; delete req.session.returnTo;
        await saveSession(req);
        res.redirect(back && back.startsWith('/') ? back : '/');
    } catch (e) { console.error('[login]', e); fail('Có lỗi xảy ra, thử lại sau.', 500); }
};
exports.logout = (req, res) => { req.session.destroy(() => { res.clearCookie('mnha.sid'); res.redirect('/auth/login'); }); };

exports.showRegister = (req, res) => res.render('auth/register', { title: 'Đăng ký', error: null, name: '', email: '' });
exports.register = async (req, res) => {
    const name = String(req.body.name || '').trim(), email = norm(req.body.email);
    const { password = '', confirmPassword = '' } = req.body;
    const fail = (msg, code = 400) => res.status(code).render('auth/register', { title: 'Đăng ký', error: msg, name, email });
    try {
        if (!name || !email || !password) return fail('Vui lòng nhập đầy đủ thông tin.');
        if (name.length > 100) return fail('Tên quá dài.');
        if (password !== confirmPassword) return fail('Mật khẩu xác nhận không khớp.');
        if (password.length < 8) return fail('Mật khẩu phải có ít nhất 8 ký tự.');
        if (await User.findOne({ email })) return fail('Email này đã được sử dụng (có thể từ web Luyện thi).', 409);
        const old = await OTP.findOne({ email, type: 'register' });
        if (old && Date.now() - old.updatedAt.getTime() < RESEND_COOLDOWN_MS) return fail('Vui lòng chờ một phút trước khi yêu cầu mã mới.', 429);
        await OTP.deleteMany({ email, type: 'register' });
        const code = genOTP();
        await OTP.create({ email, code, type: 'register', expiresAt: new Date(Date.now() + OTP_TTL_MS), payload: { name, email, passwordHash: await bcrypt.hash(password, 12) } });
        try { await mail.sendOTP(email, code); }
        catch (e) { if (!IS_DEV) { await OTP.deleteMany({ email, type: 'register' }); return fail('Không gửi được email OTP: ' + e.message, 500); } console.warn('[register] không gửi được mail (dev):', e.message); }
        req.session.pendingEmail = email; await saveSession(req);
        res.redirect('/auth/verify-otp');
    } catch (e) { console.error('[register]', e); fail('Có lỗi xảy ra khi đăng ký.', 500); }
};

exports.showVerify = async (req, res) => {
    const email = (req.session && req.session.pendingEmail) || norm(req.query.email);
    if (!email) return res.redirect('/auth/register');
    const o = IS_DEV ? await OTP.findOne({ email, type: 'register' }) : null;
    res.render('auth/verify-otp', { title: 'Xác minh OTP', email, error: null, debugOtp: o ? o.code : null });
};
exports.verify = async (req, res) => {
    const email = norm(req.body.email || (req.session && req.session.pendingEmail));
    const code = String(req.body.code || '').replace(/\D/g, '').slice(0, 6);
    const fail = (msg, c = 400) => res.status(c).render('auth/verify-otp', { title: 'Xác minh OTP', email, error: msg, debugOtp: null });
    try {
        const doc = await OTP.findOne({ email, type: 'register' });
        if (!doc) return fail('Mã đã hết hạn hoặc không tồn tại. Hãy đăng ký lại.');
        if (code.length !== 6) return fail('Vui lòng nhập đủ 6 chữ số OTP.');
        if (doc.attempts >= MAX_ATTEMPTS) { await OTP.deleteOne({ _id: doc._id }); return fail('Nhập sai quá nhiều lần. Hãy đăng ký lại.', 429); }
        if (doc.code !== code) { doc.attempts += 1; await doc.save(); return fail(`Mã không đúng (còn ${MAX_ATTEMPTS - doc.attempts} lần thử).`); }
        const p = doc.payload || {};
        if (!(await User.findOne({ email }))) {
            await User.create({ name: p.name, email, password: p.passwordHash, role: 'client', status: 'pending', userKey: null, connectedUserKeys: [] });
        }
        await OTP.deleteOne({ _id: doc._id });
        if (req.session) delete req.session.pendingEmail;
        await saveSession(req);
        res.redirect('/auth/login?registered=1&email=' + encodeURIComponent(email));
    } catch (e) { console.error('[verify]', e); fail('Có lỗi xảy ra.', 500); }
};
