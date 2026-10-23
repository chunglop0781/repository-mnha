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

app.use(morgan('dev'));
// Xem trước trang HTML (iframe sandbox, KHÔNG cookie): quyền đọc nằm trong token ký → gắn TRƯỚC cookie/session để khỏi chạm session store (GitHub)
app.use('/preview', require('./services/code/previewServer').createHandler({ mount: '/preview' }));
app.use(cookieParser());
app.use(express.json({ limit: '4.4mb' }));      // html lưu tối đa 3MB (xem LANGS.html.maxFileBytes); Vercel chặn request > 4.5MB
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

app.use('/auth', require('./routes/auth'));
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

mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000, maxPoolSize: 5 }).then(() => {
    console.log('✅ MongoDB connected (database dùng chung)');
    require('./models/OTP').ensureTTLIndex().catch((e) => console.error('[OTP] ensureTTLIndex:', e.message));
    app.listen(PORT, () => console.log(`🚀 repository-mnha chạy ở http://localhost:${PORT}`));
}).catch((e) => { console.error('❌ Không kết nối được MongoDB:', e.message); process.exit(1); });
