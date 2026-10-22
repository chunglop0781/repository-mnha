// server.js — repository-mnha: web chạy code Emu8086 / C++ (Node.js)
// Dùng CHUNG database người dùng (MongoDB) với dự án Luyện thi CNTT UTC; không phụ thuộc code của dự án đó.
require('dotenv').config();
process.env.TZ = process.env.TZ || 'Asia/Ho_Chi_Minh';
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const connectMongo = require('connect-mongo');
const MongoStore = connectMongo.default || connectMongo;
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
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Nơi lưu session: 'github' (cookies/index.json trên GitHub, mã hoá AES-256-GCM) hoặc 'mongo' (collection repo_mnha_sessions, mặc định)
const SESSION_STORE = (process.env.SESSION_STORE || 'mongo').toLowerCase();
let sessionStore;
if (SESSION_STORE === 'github') {
    try { sessionStore = new (require('./services/githubSessionStore'))(); }
    catch (e) { console.error('❌ SESSION_STORE=github nhưng cấu hình thiếu:', e.message); process.exit(1); }
    console.log('🍪 Session lưu ở GitHub: ' + (process.env.SESSION_INDEX_PATH || 'cookies/index.json') + ' (mã hoá AES-256-GCM)');
} else {
    sessionStore = MongoStore.create({ mongoUrl: MONGODB_URI, collectionName: 'repo_mnha_sessions', autoRemove: 'native' });   // bảng session RIÊNG
}
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
