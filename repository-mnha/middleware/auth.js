// middleware/auth.js — chỉ cần ĐĂNG NHẬP (không có bước duyệt tài khoản).
// Người dùng đọc từ database dùng chung (collection users của dự án Luyện thi).
'use strict';
const User = require('../models/User');

async function attachUser(req, res, next) {
    if (req._userAttached) return next();
    req._userAttached = true;
    try {
        const id = req.session && req.session.user && req.session.user._id;
        if (id) {
            const u = await User.findById(id).lean();
            // tài khoản bị xoá hẳn ở dự án kia (deletedForever) hoặc bị vô hiệu hoá → coi như khách
            if (u && !u.deletedForever && u.status !== 'disabled') {
                req.user = u;
                res.locals.user = u;
            }
        }
    } catch (e) { console.error('[attachUser]', e.message); }
    next();
}

function wantsJson(req) {
    return !!(req.xhr || (req.headers.accept || '').includes('json') || req.method !== 'GET');
}
function requireAuth(req, res, next) {
    if (req.user) return next();
    if (wantsJson(req)) return res.status(401).json({ error: 'Chưa đăng nhập' });
    if (req.session) req.session.returnTo = req.originalUrl;
    return res.redirect('/auth/login');
}
module.exports = { attachUser, requireAuth };
