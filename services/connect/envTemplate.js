// services/connect/envTemplate.js — mẫu .env dùng CHUNG cho web chính + mọi web dữ liệu.
//
//   Các biến bí mật (token, khoá mã hoá, Mongo URI) phải GIỐNG HỆT nhau ở mọi web
//   thì phiếu tải lên / khoá kết nối / dữ liệu mã hoá mới đọc được. Chỉ 4 biến
//   DATA_NODE / NODE_ID / NODE_URL / NODE_NAME là khác nhau giữa các web.
'use strict';

const SECRETS = [
    'MONGODB_URI',
    'SESSION_SECRET',
    'SESSION_ENC_KEY',
    'MEDIA_ENC_KEY',
    'CONNECT_ENC_KEY',
    'CONNECT_HMAC_KEY',
    'GITHUB_TOKEN',
    'GITHUB_MEDIA_TOKEN'
];

function current(name, fallback = '') {
    const v = process.env[name];
    return v == null ? fallback : String(v);
}

/**
 * @param {{id?:string,url?:string,name?:string,dataNode?:boolean,showSecrets?:boolean}} o
 * @returns {string} nội dung .env
 */
function envTemplate(o = {}) {
    const id = o.id || 'repository-mnha-data-1';
    const url = o.url || 'https://' + id + '.vercel.app';
    const name = o.name || id;
    const dataNode = o.dataNode !== false;
    const secret = (k, fallback) => (o.showSecrets ? (current(k) || fallback) : fallback);

    const lines = [
        '# ============================================================',
        '# MNHA — .env DÙNG CHUNG (web chính + web dữ liệu)',
        '# ------------------------------------------------------------',
        '# • Các dòng BÍ MẬT bên dưới phải GIỐNG HỆT nhau ở mọi Vercel project.',
        '# • Mỗi web dữ liệu chỉ đổi DATA_NODE / NODE_ID / NODE_URL / NODE_NAME.',
        '# • Trên web chính để DATA_NODE=off (hoặc bỏ trống).',
        '# ============================================================',
        '',
        '# --- Chế độ ---',
        `DATA_NODE=${dataNode ? 'on' : 'off'}`,
        `NODE_ID=${id}`,
        `NODE_URL=${url}`,
        `NODE_NAME=${name}`,
        'NODE_ENV=production',
        'TZ=Asia/Ho_Chi_Minh',
        '',
        '# --- Database dùng chung ---',
        `MONGODB_URI=${secret('MONGODB_URI', 'mongodb+srv://...')}`,
        '',
        '# --- Phiên đăng nhập + mã hoá (GIỐNG HỆT mọi web) ---',
        `SESSION_SECRET=${secret('SESSION_SECRET', 'chuoi-bi-mat-cho-session')}`,
        `SESSION_ENC_KEY=${secret('SESSION_ENC_KEY', 'khoa-32-ky-tu-tro-len-de-ma-hoa-session')}`,
        `MEDIA_ENC_KEY=${secret('MEDIA_ENC_KEY', 'khoa-32-ky-tu-tro-len-de-ma-hoa-media')}`,
        `CONNECT_ENC_KEY=${secret('CONNECT_ENC_KEY', 'khoa-32-ky-tu-tro-len-de-ma-hoa-khoa-ket-noi')}`,
        `CONNECT_HMAC_KEY=${secret('CONNECT_HMAC_KEY', 'khoa-32-ky-tu-tro-len-de-ky-phieu-tai-len')}`,
        '',
        '# --- GitHub repo chính (GIỐNG HỆT mọi web) ---',
        `GITHUB_TOKEN=${secret('GITHUB_TOKEN', 'ghp_...')}`,
        `GITHUB_OWNER=${current('GITHUB_OWNER', 'your-account')}`,
        `GITHUB_REPO=${current('GITHUB_REPO', 'repository-mnha')}`,
        `GITHUB_BRANCH=${current('GITHUB_BRANCH', 'main')}`,
        '',
        '# --- Sổ đăng ký web kết nối + lưu lượng (trong repo chính) ---',
        `CONNECT_INDEX_PATH=${current('CONNECT_INDEX_PATH', 'v-s/index.json')}`,
        `CONNECT_USAGE_PATH=${current('CONNECT_USAGE_PATH', 'v-s/usage.json')}`,
        '',
        '# --- Xoay vòng repo media khi repo chính > ~500MB ---',
        `MEDIA_REPO_POOL=${current('MEDIA_REPO_POOL', 'on')}`,
        `MEDIA_REPO_LIMIT_BYTES=${current('MEDIA_REPO_LIMIT_BYTES', String(500 * 1024 * 1024))}`,
        `MEDIA_REPO_INDEX_PATH=${current('MEDIA_REPO_INDEX_PATH', 'v-s/media-repos.json')}`,
        `GITHUB_MEDIA_TOKEN=${secret('GITHUB_MEDIA_TOKEN', 'ghp_... (cần quyền tạo repo, có thể trùng GITHUB_TOKEN)')}`,
        `GITHUB_MEDIA_OWNER=${secret('GITHUB_MEDIA_OWNER', current('GITHUB_OWNER', 'your-account'))}`,
        `GITHUB_MEDIA_REPO_PREFIX=${current('GITHUB_MEDIA_REPO_PREFIX', current('GITHUB_REPO', 'repository-mnha') + '-media')}`,
        `MEDIA_REPO_PRIVATE=${current('MEDIA_REPO_PRIVATE', 'off')}`,
        '',
        '# --- Cloudflare R2 cho VIDEO / ÂM THANH (ảnh vẫn ở GitHub) ---',
        '# Cấu hình thật (Account ID, bucket, khoá R2, token GitHub dự phòng) nằm trong v-s/cloudflare.json',
        '# và được MÃ HOÁ 2 CHIỀU — lưu qua trang /connect của web chính. Các biến dưới chỉ là đường dẫn / chế độ.',
        `CLOUDFLARE_INDEX_PATH=${current('CLOUDFLARE_INDEX_PATH', 'v-s/cloudflare.json')}`,
        `CLOUDFLARE_REQUIRED=${current('CLOUDFLARE_REQUIRED', 'off')}`,
        '',
        '# --- Giới hạn / hiển thị ---',
        `MEDIA_MAX_BYTES=${current('MEDIA_MAX_BYTES', String(2 * 1024 * 1024 * 1024))}`,
        `MEDIA_DIRECT=${current('MEDIA_DIRECT', 'on')}`,
        `CONNECT_PROBE_TIMEOUT_MS=${current('CONNECT_PROBE_TIMEOUT_MS', '4000')}`,
        `UPLOAD_TOKEN_TTL_MS=${current('UPLOAD_TOKEN_TTL_MS', String(2 * 60 * 60 * 1000))}`,
        `CONNECT_FALLBACK_LOCAL=${current('CONNECT_FALLBACK_LOCAL', 'on')}`,
        `CONNECT_REQUIRED=${current('CONNECT_REQUIRED', 'off')}`,
        '',
        '# --- Tuỳ chọn (chỉ cần khi dùng) ---',
        `MAIN_URL=${current('MAIN_URL', 'https://repository-mnha.vercel.app')}`,
        `CPP_RUNNER_URL=${current('CPP_RUNNER_URL', '')}`,
        `CPP_RUNNER_KEY=${current('CPP_RUNNER_KEY', '')}`,
        `SMTP_HOST=${current('SMTP_HOST', '')}`,
        `SMTP_PORT=${current('SMTP_PORT', '')}`,
        `SMTP_USER=${current('SMTP_USER', '')}`,
        `SMTP_PASS=${current('SMTP_PASS', '')}`,
        `MAIL_FROM=${current('MAIL_FROM', '')}`,
        ''
    ];
    return lines.join('\n');
}

/** Chỉ các biến cần đổi giữa các web (để so sánh nhanh). */
const DIFFERENT_KEYS = ['DATA_NODE', 'NODE_ID', 'NODE_URL', 'NODE_NAME'];

module.exports = { envTemplate, DIFFERENT_KEYS, SECRETS };
