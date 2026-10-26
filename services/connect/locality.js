// services/connect/locality.js — web này đang chạy ở đâu và dữ liệu (tải lên / tải xuống / xem media) phải đi qua đâu?
//
//   • localhost (máy bạn tự chạy, KHÔNG phải Vercel)       → 'local': dữ liệu kết nối thẳng với chính localhost.
//   • web dữ liệu (DATA_NODE=on)                           → 'self' : chính nó là nơi giữ dữ liệu.
//   • web chính trên mạng (vd repository-mnha.vercel.app)  → 'node' : chỉ lo giao diện + backend; dữ liệu BẮT BUỘC đi qua
//       web kết nối (không có web nào hoạt động → báo lỗi rõ ràng, KHÔNG tự lùi về web chính).
'use strict';

const LOCAL_HOST = /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?)$/i;
const isDataNode = () => String(process.env.DATA_NODE || '').toLowerCase() === 'on';

/** Request đến từ localhost? Trên Vercel thì KHÔNG BAO GIỜ (tránh giả header Host để lách quy tắc). */
function isLocalRequest(req) {
    if (process.env.VERCEL) return false;
    const h = String((req && (req.hostname || (req.headers && req.headers.host))) || '').replace(/:\d+$/, '');
    return LOCAL_HOST.test(h) || /\.localhost$/i.test(h);
}

/** 'self' | 'local' | 'node' */
function dataMode(req) {
    if (isDataNode()) return 'self';
    return isLocalRequest(req) ? 'local' : 'node';
}

const LOCAL_NODE = { id: 'localhost', name: 'localhost' };

/**
 * Nơi giữ dữ liệu cho request này.
 * @returns {Promise<{mode:'local'|'self'|'node'|'none', base:string, node:{id,name}|null, error:string|null}>}
 *   base: '' (cùng origin) hoặc URL gốc của web kết nối — tiền tố cho /preview/<token>/... (xem + tải media).
 */
async function dataTarget(req) {
    const mode = dataMode(req);
    if (mode === 'self') {
        const id = String(process.env.NODE_ID || 'data-node');
        return { mode, base: '', node: { id, name: String(process.env.NODE_NAME || id) }, error: null };
    }
    if (mode === 'local') return { mode, base: '', node: LOCAL_NODE, error: null };
    let r;
    try { r = await require('./nodes').currentNode(); } catch (e) { r = { node: null, error: e.message }; }
    if (r && r.node) return { mode: 'node', base: String(r.node.url).replace(/\/+$/, ''), node: { id: r.node.id, name: r.node.name }, error: null };
    return { mode: 'none', base: '', node: null, error: (r && r.error) || 'Chưa có web kết nối nào hoạt động.' };
}

/** Chặn các đường GHI dữ liệu trực tiếp lên web chính (chỉ localhost / web dữ liệu được nhận). */
function requireLocalData(req, res, next) {
    if (dataMode(req) !== 'node') return next();
    return res.status(403).json({
        error: 'Web chính không nhận dữ liệu. Ảnh / âm thanh / video phải đi qua web kết nối (xem /connect).', code: 'DATA_ON_NODE'
    });
}

module.exports = { isLocalRequest, isDataNode, dataMode, dataTarget, requireLocalData, LOCAL_NODE };
