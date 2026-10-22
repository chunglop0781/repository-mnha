// scripts/migrateMongoToGithub.js — chuyển TOÀN BỘ session ở MongoDB (collection repo_mnha_sessions) sang GitHub: cookies/index.json
//   • Mỗi session được mã hoá AES-256-GCM (services/sessionCrypto.js) trước khi đẩy lên; chuyển xong đọc lại + giải mã để đối chiếu.
//   • Không đổi SESSION_SECRET / tên cookie → cookie của người dùng vẫn hợp lệ, không bị đăng xuất.
// Chạy:  node scripts/migrateMongoToGithub.js [--dry-run] [--force] [--delete-mongo] [--collection=repo_mnha_sessions] [--chunk=200]
//   --dry-run       chỉ đếm, không ghi gì        --force        ghi đè session đã có trên GitHub
//   --delete-mongo  xoá khỏi MongoDB những session đã chuyển VÀ đối chiếu giải mã khớp (mặc định giữ nguyên MongoDB)
'use strict';
const assert = require('assert');

function convertDoc(doc, now = Date.now()) {
    let sess = doc.session;
    if (typeof sess === 'string') { try { sess = JSON.parse(sess); } catch (_) { return { skip: 'invalid' }; } }
    if (!sess || typeof sess !== 'object') return { skip: 'invalid' };
    const { expOf } = require('../services/githubSessionStore');
    const exp = doc.expires ? new Date(doc.expires).getTime() : expOf(sess);
    if (!Number.isFinite(exp) || exp <= now) return { skip: 'expired' };
    sess.cookie = sess.cookie || {};
    if (!sess.cookie.expires) sess.cookie.expires = new Date(exp).toISOString();
    return { sid: String(doc._id), sess, exp };
}

async function main() {
    require('dotenv').config();
    const argv = process.argv.slice(2);
    const flag = (n) => argv.includes('--' + n);
    const val = (n, d) => { const a = argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : d; };
    const DRY = flag('dry-run'), FORCE = flag('force'), DEL = flag('delete-mongo');
    const collection = val('collection', process.env.SESSION_COLLECTION || 'repo_mnha_sessions');
    const chunk = Math.max(1, Number(val('chunk', 200)));

    if (!process.env.MONGODB_URI) throw new Error('Thiếu MONGODB_URI');
    const gh = require('../services/githubService');
    if (!gh.isConfigured) throw new Error('Thiếu GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO');
    const GithubSessionStore = require('../services/githubSessionStore');
    const store = new GithubSessionStore();       // báo lỗi sớm nếu thiếu SESSION_ENC_KEY

    const mongoose = require('mongoose');
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    const col = mongoose.connection.db.collection(collection);
    const docs = await col.find({}).toArray();
    console.log(`MongoDB "${collection}": ${docs.length} document`);

    const ok = [], stat = { expired: 0, invalid: 0 };
    for (const d of docs) { const r = convertDoc(d); if (r.skip) stat[r.skip]++; else ok.push(r); }
    console.log(`Còn hạn & hợp lệ: ${ok.length} | hết hạn: ${stat.expired} | hỏng: ${stat.invalid}`);
    if (DRY) { console.log('--dry-run: không ghi gì.'); return mongoose.disconnect(); }

    let added = 0, skipped = 0, verified = 0, deleted = 0;
    for (let i = 0; i < ok.length; i += chunk) {
        const part = ok.slice(i, i + chunk);
        const r = await store.importSessions(part, { force: FORCE });
        added += r.added; skipped += r.skipped;
        for (const e of part) {
            let back = null;
            try { back = await store.verify(e.sid); } catch (_) { /* không giải mã được */ }
            let same = false; try { assert.deepStrictEqual(back, e.sess); same = true; } catch (_) { /* lệch */ }
            if (same) { verified++; if (DEL) { await col.deleteOne({ _id: e.sid }); deleted++; } }
            else console.warn('⚠️ Đối chiếu KHÔNG khớp, giữ nguyên ở MongoDB:', e.sid.slice(0, 6) + '…');
        }
        console.log(`  … ${Math.min(i + chunk, ok.length)}/${ok.length}`);
    }
    console.log(`✅ Xong: ghi mới ${added}, đã có (bỏ qua) ${skipped}, đối chiếu khớp ${verified}/${ok.length}${DEL ? `, xoá khỏi MongoDB ${deleted}` : ' (MongoDB giữ nguyên)'}`);
    await mongoose.disconnect();
}

module.exports = { convertDoc };
if (require.main === module) main().catch((e) => { console.error('❌', e.message); process.exit(1); });
