// middleware/uploadAuth.js — quyền tải ảnh / âm thanh / video.
//
//   • Web chính: chỉ tài khoản ĐÃ ĐƯỢC DUYỆT (hoặc admin) mới được tải lên.
//     client status pending/rejected → chặn với đúng câu:
//       "Tài khoản bị ... vì vậy hãy nhắn quản trị viên để mở tính năng này."
//   • Web dữ liệu (DATA_NODE=on): nhận yêu cầu từ trình duyệt bằng PHIẾU TẢI LÊN
//     (services/connect/uploadToken.js) thay cho cookie — phiếu do web chính ký,
//     gắn uid + uploadId + tên file + thư mục, hết hạn sau 2 giờ.
'use strict';
const uploadToken = require('../services/connect/uploadToken');

const isDefaultAdmin = (u) => !!u && u.role === 'admin' && !u.userKey;

function uploadDenyMessage(user) {
    const st = user && user.status;
    const reason = st === 'rejected' ? 'bị từ chối'
        : st === 'pending' ? 'chưa được duyệt'
            : st === 'disabled' ? 'bị vô hiệu hoá'
                : 'chưa được cấp quyền tải lên';
    return `Tài khoản ${reason} vì vậy hãy nhắn quản trị viên để mở tính năng này.`;
}

/** Chỉ admin mặc định (role=admin, userKey=null) — dùng cho web dữ liệu + trang /connect. */
function requireDefaultAdmin(req, res, next) {
    if (!req.user) {
        if (req.method !== 'GET' || (req.headers.accept || '').includes('json')) return res.status(401).json({ error: 'Chưa đăng nhập' });
        if (req.session) req.session.returnTo = req.originalUrl;
        return res.redirect('/auth/login');
    }
    if (isDefaultAdmin(req.user)) return next();
    if (req.method !== 'GET' || (req.headers.accept || '').includes('json')) {
        return res.status(403).json({ error: 'Chỉ quản trị viên mặc định (role=admin, không thuộc tổ chức) được dùng trang này.' });
    }
    return res.status(403).render('error', {
        title: 'Không có quyền', message: 'Chỉ quản trị viên mặc định (role=admin, không thuộc tổ chức) được dùng trang này.',
        statusCode: 403, user: req.user
    });
}

/** Tài khoản được tải media? (admin / student / client đã duyệt) */
function canUploadMedia(user) {
    if (!user) return false;
    if (user.status === 'rejected' || user.status === 'disabled') return false;
    if (isDefaultAdmin(user)) return true;
    if (user.role === 'admin') return true;             // admin tổ chức: vẫn cho tải
    if (user.role === 'student') return true;           // đã được duyệt
    return user.role === 'client' && user.status === 'approved';
}

function requireMediaUploader(req, res, next) {
    if (canUploadMedia(req.user)) return next();
    const msg = uploadDenyMessage(req.user);
    const json = req.method !== 'GET' || req.xhr || (req.headers.accept || '').includes('json');
    if (json) return res.status(403).json({ error: msg, code: 'UPLOAD_NOT_ALLOWED' });
    return res.status(403).render('error', { title: 'Chưa được tải lên', message: msg, statusCode: 403, user: req.user });
}

function tokenOf(req) {
    const h = req.headers && (req.headers['x-mnha-upload'] || req.headers.authorization);
    if (h) {
        const m = /^Bearer\s+(.+)$/i.exec(String(h));
        return m ? m[1] : String(h);
    }
    return String((req.body && req.body.token) || (req.query && req.query.token) || '');
}

/** Xác thực phiếu tải lên cho các endpoint của web dữ liệu. */
function nodeUploadAuth(req, res, next) {
    const tok = tokenOf(req);
    const p = uploadToken.verify(tok);
    if (!p) return res.status(401).json({ error: 'Phiếu tải lên không hợp lệ hoặc đã hết hạn — hãy tải lại từ web chính.' });
    const dir = req.body && req.body.dir != null ? req.body.dir : req.query.dir;
    const name = req.body && req.body.name != null ? req.body.name : req.query.name;
    const uploadId = req.body && req.body.uploadId != null ? req.body.uploadId : req.query.uploadId;
    if (!uploadToken.matches(p, { dir, name, uploadId })) {
        return res.status(403).json({ error: 'Phiếu tải lên không khớp với file/thư mục đang gửi.' });
    }
    req.mediaUid = p.uid;
    req.upload = p;
    return next();
}

module.exports = {
    isDefaultAdmin, canUploadMedia, uploadDenyMessage,
    requireDefaultAdmin, requireMediaUploader, nodeUploadAuth, tokenOf
};
