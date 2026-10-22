// scripts/clearMongoSessions.js — XOÁ HẾT session còn lại ở MongoDB (collection repo_mnha_sessions) sau khi đã chuyển sang GitHub.
// Chạy:  node scripts/clearMongoSessions.js            → chỉ kiểm tra + báo cáo (KHÔNG xoá)
//        node scripts/clearMongoSessions.js --yes      → xoá toàn bộ document trong collection
//        node scripts/clearMongoSessions.js --yes --drop   → xoá luôn cả collection
//        --force   bỏ qua kiểm tra "session còn hạn ở MongoDB phải có trên GitHub" (mất đăng nhập của những người đó)
// An toàn: từ chối xoá nếu cookies/index.json trống/không đọc được, hoặc còn session CÒN HẠN ở MongoDB chưa có trên GitHub.
'use strict';

/** Trả về danh sách session còn hạn ở Mongo mà GitHub chưa có. */
function missingOnGithub(docs, idx, sidId, now = Date.now()) {
    const out = [];
    for (const d of docs) {
        const exp = d.expires ? new Date(d.expires).getTime() : now + 1;
        if (exp <= now) continue;                                  // đã hết hạn: xoá được
        const r = idx && idx.sessions && idx.sessions[sidId(String(d._id))];
        if (!r) out.push(String(d._id));
    }
    return out;
}

async function main() {
    require('dotenv').config();
    const argv = process.argv.slice(2), has = (n) => argv.includes('--' + n);
    const YES = has('yes'), DROP = has('drop'), FORCE = has('force');
    const a = argv.find((x) => x.startsWith('--collection='));
    const collection = a ? a.split('=')[1] : (process.env.SESSION_COLLECTION || 'repo_mnha_sessions');

    if (!process.env.MONGODB_URI) throw new Error('Thiếu MONGODB_URI');
    const gh = require('../services/githubService');
    if (!gh.isConfigured) throw new Error('Thiếu GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO');
    const sc = require('../services/sessionCrypto'); sc.keys();      // cần SESSION_ENC_KEY để so khớp sid

    const path = process.env.SESSION_INDEX_PATH || 'cookies/index.json';
    const idx = await gh.readJsonFile(path);
    const nGh = idx && idx.sessions ? Object.keys(idx.sessions).length : 0;
    console.log(`GitHub ${path}: ${nGh} session`);

    const mongoose = require('mongoose');
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    const col = mongoose.connection.db.collection(collection);
    const docs = await col.find({}, { projection: { _id: 1, expires: 1 } }).toArray();
    console.log(`MongoDB "${collection}": ${docs.length} document`);

    const miss = missingOnGithub(docs, idx, sc.sidId);
    if (!idx && docs.length) console.warn('⚠️ Không đọc được cookies/index.json trên GitHub.');
    if (miss.length) console.warn(`⚠️ ${miss.length} session CÒN HẠN ở MongoDB chưa có trên GitHub (vd: ${miss.slice(0, 3).map((s) => s.slice(0, 6) + '…').join(', ')}). Chạy lại migrateMongoToGithub trước.`);

    if (!YES) { console.log('Chưa xoá gì. Thêm --yes để xoá.'); return mongoose.disconnect(); }
    if ((!idx || miss.length) && !FORCE) { console.error('❌ Từ chối xoá (dùng --force nếu chắc chắn).'); await mongoose.disconnect(); process.exit(1); }

    if (DROP) { try { await col.drop(); console.log(`✅ Đã xoá cả collection "${collection}"`); } catch (e) { if (e.codeName !== 'NamespaceNotFound') throw e; console.log('Collection không tồn tại.'); } }
    else { const r = await col.deleteMany({}); console.log(`✅ Đã xoá ${r.deletedCount} document khỏi "${collection}"`); }
    await mongoose.disconnect();
}

module.exports = { missingOnGithub };
if (require.main === module) main().catch((e) => { console.error('❌', e.message); process.exit(1); });
