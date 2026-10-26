// server.js — repository-mnha: web chạy code Emu8086 / C++ (Node.js)
// Dùng CHUNG database người dùng (MongoDB) với dự án Luyện thi CNTT UTC; không phụ thuộc code của dự án đó.
require('dotenv').config();
process.env.TZ = process.env.TZ || 'Asia/Ho_Chi_Minh';
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');

const app = express();
app.set('trust proxy', 1);
app.set('view engine', 'pug');
app.set('views', path.join(__dirname, 'views'));

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) { console.error('❌ Thiếu MONGODB_URI (dùng cùng chuỗi với dự án Luyện thi để chung tài khoản)'); process.exit(1); }

// Vercel (serverless): không app.listen — xuất app cho api/index.js; MongoDB nối lười ở request đầu rồi dùng lại.
const ON_VERCEL = !!process.env.VERCEL;
let dbReady = null;
function connectDb() {
    if (!dbReady) {
        dbReady = mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000, maxPoolSize: 5 }).then(() => {
            console.log('✅ MongoDB connected (database dùng chung)');
            require('./models/OTP').ensureTTLIndex().catch((e) => console.error('[OTP] ensureTTLIndex:', e.message));
        }).catch((e) => { dbReady = null; throw e; });
    }
    return dbReady;
}
if (ON_VERCEL) app.use((req, res, next) => (req.path === '/api/node/health' ? next() : connectDb().then(() => next(), next)));

app.use(morgan('dev'));
// Xem trước trang HTML (iframe sandbox, KHÔNG cookie): quyền đọc nằm trong token ký → gắn TRƯỚC cookie/session để khỏi chạm session store (GitHub)
app.use('/preview', require('./services/code/previewServer').createHandler({ mount: '/preview' }));
// Tài liệu Word công khai (không đăng nhập): quyền xem kiểm tra trong mnha-word.json. Gắn TRƯỚC cookie/session.
const wordCtrl = require('./controllers/word.controller');
app.get('/w', wordCtrl.publicView);
app.get('/w/raw', wordCtrl.publicRaw);
app.get('/w/media', wordCtrl.publicMedia);
app.get('/w/download', wordCtrl.publicDownload);
// Webhook GitHub (sự kiện push) → cập nhật DUNG LƯỢNG từng repo dữ liệu (services/githubPool.js). Cần body GỐC để kiểm tra chữ ký
// HMAC (GITHUB_WEBHOOK_SECRET) nên gắn TRƯỚC express.json; dung lượng chỉ giữ trong RAM, không lưu JSON.
app.post('/api/github/webhook', express.raw({ type: () => true, limit: '5mb' }), (req, res) => {
    const gh = require('./services/githubService');
    if (!gh.pool) return res.status(503).json({ ok: false, error: 'Chưa bật nhóm repo GitHub.' });
    gh.pool.handleWebhook(req.body, req.headers)
        .then((r) => res.json(r))
        .catch((e) => res.status(e.status || 500).json({ ok: false, error: e.message }));
});
// Tự gắn webhook push cho mọi repo dữ liệu (1 lần, không chặn request) — địa chỉ lấy từ MAIN_URL hoặc từ request đầu tiên.
app.use((req, res, next) => {
    try {
        const gh = require('./services/githubService');
        if (gh.pool && gh.pooled) gh.pool.autoSetup({ origin: `${(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0]}://${req.get('host')}` });
    } catch (_) { /* không ảnh hưởng request */ }
    next();
});
app.use(cookieParser());
app.use(express.json({ limit: '4.4mb' }));      // html lưu tối đa 3MB (xem LANGS.html.maxFileBytes); Vercel chặn request > 4.5MB
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Đếm lưu lượng trình duyệt ⇄ web (xấp xỉ) cho trang /connect — xem services/connect/usage.js
app.use(require('./services/connect/usage').middleware());

// Session CHỈ đọc/ghi ở GitHub (cookies/index.json, mã hoá AES-256-GCM) — KHÔNG còn ghi session vào MongoDB.
// Thiếu GITHUB_* hoặc SESSION_ENC_KEY thì dừng ngay (không có đường lùi về Mongo).
let sessionStore;
try {
    if (!require('./services/githubService').isConfigured) throw new Error('thiếu GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO');
    sessionStore = new (require('./services/githubSessionStore'))();
} catch (e) { console.error('❌ Không khởi tạo được session store trên GitHub:', e.message); process.exit(1); }
console.log('🍪 Session lưu ở GitHub: ' + (process.env.SESSION_INDEX_PATH || 'cookies/index.json') + ' (mã hoá AES-256-GCM)');
app.use(session({
    name: 'mnha.sid',
    secret: process.env.SESSION_SECRET || 'change-this-session-secret',
    resave: false, saveUninitialized: false, proxy: true,
    store: sessionStore,
    cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 }
}));

const { attachUser, requireAuth } = require('./middleware/auth');
app.use(attachUser);
app.use((req, res, next) => { res.locals.user = req.user || null; next(); });

// Web dữ liệu (DATA_NODE=on) hay web chính: cùng codebase, khác .env.
const connectVercel = require('./connect/vercel');
const DATA_NODE = connectVercel.isDataNode();
app.use((req, res, next) => {
    res.locals.dataNode = DATA_NODE;
    res.locals.nodeName = DATA_NODE ? connectVercel.nodeName() : null;
    next();
});
if (DATA_NODE) {
    // Web dữ liệu: tài khoản KHÔNG phải admin mặc định không được dùng (kể cả session cũ).
    app.use((req, res, next) => {
        const u = req.user;
        if (!u || (u.role === 'admin' && !u.userKey)) return next();
        if (req.session) delete req.session.user;
        req.user = null;
        res.locals.user = null;
        if (req.path.startsWith('/auth/')) return next();
        if (req.session) return req.session.save(() => res.redirect('/auth/login'));
        return res.redirect('/auth/login');
    });
}

// Hiện "đang kết nối web kết nối nào" ở mọi trang (public/js/connectBadge.js) — chỉ cho người đã đăng nhập.
app.get('/api/connect-info', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.user) return res.status(401).json({ error: 'Chưa đăng nhập' });
    const loc = require('./services/connect/locality'), mode = loc.dataMode(req);
    if (mode === 'self') return res.json({ mode, name: connectVercel.nodeName(), id: connectVercel.nodeId(), ok: true });
    if (mode === 'local') return res.json({ mode, name: 'localhost', id: 'localhost', ok: true });
    try {
        const r = await require('./services/connect/nodes').currentNode();
        res.json(r.node ? { mode, ok: true, name: r.node.name, id: r.node.id, url: r.node.url } : { mode, ok: false, error: r.error });
    } catch (e) { res.json({ mode, ok: false, error: e.message }); }
});
app.use('/auth', require('./routes/auth'));
if (DATA_NODE) {
    // /api/node/health|status|media/* + /connect (chỉ admin mặc định) của web dữ liệu
    app.use(connectVercel.createRouter());
    console.log('🔗 Chế độ WEB DỮ LIỆU: ' + connectVercel.nodeName() + ' (' + connectVercel.nodeId() + ')');
} else {
    // Quản lý các web dữ liệu + Fast Data Transfer / Fast Origin Transfer
    app.use('/connect', require('./routes/connect'));
}
app.get('/', requireAuth, require('./controllers/code.controller').hub);     // menu chính: chọn ngôn ngữ code
app.get('/code', (req, res) => res.redirect('/'));
app.use('/code', require('./routes/code'));

app.use((req, res) => res.status(404).render('error', { title: 'Không tìm thấy', message: 'Trang không tồn tại.', statusCode: 404, user: req.user }));
app.use((err, req, res, next) => {            // eslint-disable-line no-unused-vars
    console.error(err);
    if (res.headersSent) return;
    const json = req.xhr || (req.headers.accept || '').includes('json') || req.method !== 'GET';
    if (json) return res.status(err.status || 500).json({ error: err.message });
    res.status(err.status || 500).render('error', { title: 'Lỗi', message: process.env.NODE_ENV === 'production' ? 'Đã xảy ra lỗi.' : err.message, statusCode: err.status || 500, user: req.user });
});

if (!ON_VERCEL) {
    connectDb().then(() => {
        app.listen(PORT, () => console.log(`🚀 repository-mnha chạy ở http://localhost:${PORT}`));
    }).catch((e) => { console.error('❌ Không kết nối được MongoDB:', e.message); process.exit(1); });
}
module.exports = app;
