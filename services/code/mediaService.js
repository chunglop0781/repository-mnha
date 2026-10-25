// services/code/mediaService.js — tải lên ảnh / âm thanh / video cho dạng code "html" ({user_id}/codes/html/[thư-mục]/...)
//
// Mọi request đều NHỎ (≤ 3.5MB, hợp giới hạn 4.5MB của Vercel) và KHÔNG giữ trạng thái giữa các request:
//   ┌ file ≤ 23MB ("direct")  : PUT part (mã hoá từng phần → blob) … POST finish (ghép → 1 file cùng tên, đã mã hoá).  File ≤ 3.5MB: 1 request.
//   └ âm thanh/video > 23MB   : TRÌNH DUYỆT cắt thành đoạn MPEG-TS (public/js/tsMux.js), PUT seg (mã hoá từng đoạn → blob),
//                              POST commit từng lô: ghi đoạn + m3u8 + ĐÁNH DẤU TIẾN ĐỘ vào mnha-media.json (1 commit/lô) → có thể làm tiếp nếu đứt.
//        âm thanh + video: đoạn .ts mã hoá AES-128 chuẩn HLS (DRM), khoá RIÊNG ghi trong json (đã mã hoá 2 chiều) — hls.js trong TRÌNH DUYỆT giải mã khi phát
//                  (đoạn tải thẳng từ GitHub raw / Cloudflare R2; chỉ key.bin — 16 byte, đã kiểm quyền — đi qua máy chủ)
//                  codec thế hệ mới (H.265 / AV1 / VP9): đoạn fMP4 .m4s (moof+mdat) cùng AES-128; init.mp4 (chỉ cấu hình codec, không mã hoá) lưu base64 trong json
//   mnha-media.json (cùng thư mục file gốc) khai báo "song.mp3" → playlist _media/song_mp3/index.m3u8 (đuôi gốc được khai báo là m3u8).
//   Biên nhận HMAC ngăn client nhét sha blob bất kỳ (của người khác) vào commit.
//
//   KHO LƯU MEDIA MỚI (xem services/connect/cloudflare.js):
//     • ẢNH: vẫn ghi GitHub như trước (media pool / repo chính).
//     • ÂM THANH / VIDEO: ưu tiên Cloudflare R2. R2 lỗi khi ghi hoặc không tạo được link →
//       tự ghi sang repo GitHub DỰ PHÒNG (token/owner/repo riêng, mã hoá trong v-s/cloudflare.json).
//       Không bao giờ ghi media mới vào tài khoản GitHub media đang bị khoá.
//     • Entry trong mnha-media.json có `storage` = { provider:'cloudflare'|'github-fallback', ... }
//       để máy chủ biết đọc/giải mã và tạo link ở đâu. Entry cũ không có `storage` vẫn đọc GitHub như trước.
'use strict';
const crypto = require('crypto');
const mediaRepo = require('../connect/mediaRepo');
const cloudflare = require('../connect/cloudflare');
const gh = mediaRepo.facade();
const store = require('./codeStore');
const mc = require('./mediaCrypto');
const hls = require('./hlsPlaylist');
const { LANGS, MEDIA, mediaKind } = require('../../config/codeConfig');

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const cfg = LANGS.html;
const root = (uid) => `${uid}/codes/html`;
const extOf = (n) => { const i = String(n).lastIndexOf('.'); return i < 0 ? '' : String(n).slice(i + 1).toLowerCase(); };
const stemOf = (n) => { const i = String(n).lastIndexOf('.'); return i < 0 ? String(n) : String(n).slice(0, i); };
const dirRel = (dirSegs) => dirSegs.join('/');
const join = (...p) => p.filter(Boolean).join('/');
const manifestPath = (uid, dirSegs) => join(root(uid), dirRel(dirSegs), MEDIA.MANIFEST);
const mediaId = (name) => `${stemOf(name)}_${extOf(name)}`;
const MIME_OF = { mp3: 'audio/mpeg', aac: 'audio/aac', m4a: 'audio/mp4', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime' };
const isMediaStorage = (st) => !!(st && (st.provider === 'cloudflare' || st.provider === 'github-fallback'));
const provOf = (st) => (isMediaStorage(st) ? st.provider : 'github');
const isAudioVideo = (kind) => kind === 'audio' || kind === 'video';

/** Tên file tải lên → tên hợp lệ (chữ/số/-/_ + đuôi ảnh/âm thanh/video). Ký tự lạ đổi thành "_". */
function cleanAssetName(name) {
    const base = String(name || '').split(/[\\/]/).pop().trim();
    const ext = extOf(base);
    if (!mediaKind('x.' + ext)) throw bad('Đuôi file không hỗ trợ (ảnh: ' + cfg.assetExts.image.join(', ') + ' · âm thanh: ' + cfg.assetExts.audio.join(', ') + ' · video: ' + cfg.assetExts.video.join(', ') + ').');
    let stem = stemOf(base).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[^A-Za-z0-9_\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
    if (!stem) stem = 'file';
    if ((stem + '.' + ext).toLowerCase() === MEDIA.MANIFEST) stem = 'file_' + stem;
    return stem + '.' + ext;
}

async function readManifest(uid, dirSegs) {
    const j = await gh.readJsonFile(manifestPath(uid, dirSegs)).catch((e) => { if (e.status === 404) return null; throw e; });
    return j && typeof j === 'object' && j.files && typeof j.files === 'object' ? j : { v: 1, files: {} };
}
// Danh sách file TẮT CÔNG KHAI của thư mục: m.private = ["a.png", "phim.mp4", ...] (tên file, cùng thư mục với mnha-media.json)
const privList = (m) => (Array.isArray(m && m.private) ? m.private.map(String) : []);
const keepManifest = (m) => Object.keys(m.files).length > 0 || privList(m).length > 0;      // còn mục media hoặc còn file riêng tư → giữ json
function dropPrivate(m, name) { const l = privList(m).filter((n) => n !== name); if (l.length) m.private = l; else delete m.private; }
async function treePaths(prefix) {
    const t = await gh.getRepoTree({ force: true });
    return [...t.files.keys()].filter((p) => p.startsWith(prefix));
}
const hex = (n) => crypto.randomBytes(n).toString('hex');
const checkUploadId = (id) => { if (!/^[a-f0-9]{32}$/.test(String(id || ''))) throw bad('Mã tải lên không hợp lệ.'); return String(id); };

function ctxOf(uid, q) {
    const dirSegs = store.cleanDir(q.dir || '');
    const name = cleanAssetName(q.name);
    return { uid, dirSegs, name, kind: mediaKind(name), ext: extOf(name), filePath: join(root(uid), dirRel(dirSegs), name) };
}

/** Kho lưu cho media mới: ảnh → GitHub; âm thanh/video → R2, không có R2 thì GitHub dự phòng. */
async function targetFor(kind) {
    if (!isAudioVideo(kind)) return { provider: 'github', storage: null, fallback: null };
    let rt = null;
    try { rt = await cloudflare.runtime(); }
    catch (e) { console.warn('[mediaService] đọc cấu hình Cloudflare:', e.message); }
    if (rt && rt.storage) return { provider: 'cloudflare', storage: rt.storage, fallback: rt.fallback || null };
    if (rt && rt.fallback) return { provider: 'github-fallback', storage: rt.fallback, fallback: rt.fallback };
    if (String(process.env.CLOUDFLARE_REQUIRED || '').toLowerCase() === 'on') {
        throw bad('Chưa cấu hình Cloudflare R2 hoặc repo GitHub dự phòng — không ghi video/âm thanh mới vào tài khoản GitHub media đang khoá. Hãy vào /connect để cấu hình.', 503);
    }
    return { provider: 'github', storage: null, fallback: null };
}
function storageFor(provider, target) {
    if (provider === 'cloudflare') return target.storage && target.storage.provider === 'cloudflare' ? target.storage : null;
    if (provider === 'github-fallback') return target.fallback || (target.storage && target.storage.provider === 'github-fallback' ? target.storage : null);
    return null;
}
const contentTypeOf = (c) => MIME_OF[c.ext] || 'application/octet-stream';

/** Ghi object vào đúng kho (R2 hoặc repo GitHub dự phòng). */
async function writeObject(storage, key, data, type) {
    if (!isMediaStorage(storage)) throw bad('Kho lưu media chưa được cấu hình.', 503);
    if (storage.provider === 'cloudflare') return cloudflare.putObject(storage, key, data, type);
    return cloudflare.fallbackWriteBinary(storage, key, data, 'media dự phòng: ' + key);
}
async function readPart(provider, storage, ref) {
    if (provider === 'cloudflare') return cloudflare.getObject(storage, ref);
    if (provider === 'github-fallback') return cloudflare.fallbackGetBlob(storage, ref);
    return gh.getBlobBuffer(String(ref));
}
async function removeObject(storage, key) {
    try {
        if (!isMediaStorage(storage)) return;
        if (storage.provider === 'cloudflare') await cloudflare.deleteObject(storage, key);
        else await cloudflare.fallbackCommit(storage, [{ path: key, remove: true }], 'media dự phòng: xoá ' + key);
    } catch (e) { console.warn('[mediaService] xoá media cũ:', e.message); }
}

/** Xoá mọi object/đoạn của 1 entry khỏi kho đã ghi trong json (R2 / GitHub dự phòng). */
async function purgeEntry(uid, dirSegs, entry) {
    if (!entry || !isMediaStorage(entry.storage)) return;
    const base = join(root(uid), dirRel(dirSegs));
    const stores = new Map();
    const add = (st) => { if (isMediaStorage(st)) stores.set([st.provider, st.owner || '', st.repo || '', st.bucket || '', st.accountId || ''].join('|'), st); };
    add(entry.storage);
    if (entry.segStorage && typeof entry.segStorage === 'object') for (const st of Object.values(entry.segStorage)) add(st);
    for (const st of stores.values()) {
        if (entry.mode === 'direct') {
            await removeObject(st, join(base, entry.name));
            continue;
        }
        if (!entry.id) continue;
        const prefix = join(base, MEDIA.HIDDEN_DIR, entry.id) + '/';
        try {
            if (st.provider === 'cloudflare') await cloudflare.deletePrefix(st, prefix);
            else await cloudflare.fallbackRemovePrefix(st, prefix);
        } catch (e) { console.warn('[mediaService] dọn đoạn cũ:', e.message); }
    }
}

// ---------------------------------------------------------------- init
async function init(uid, b) {
    const c = ctxOf(uid, b);
    const size = Number(b.size);
    if (!Number.isInteger(size) || size <= 0) throw bad('Kích thước file không hợp lệ.');
    if (size > MEDIA.MAX_FILE_BYTES) throw bad(`File quá lớn (tối đa ${Math.round(MEDIA.MAX_FILE_BYTES / 1048576)}MB).`);
    const encrypt = c.kind === 'image' ? b.encrypt !== false : true;     // ảnh: tuỳ chọn (mặc định có); âm thanh/video: luôn mã hoá
    let plan = size <= MEDIA.DIRECT_MAX ? 'direct' : 'hls';
    if (c.kind === 'image' && plan === 'hls') throw bad(`Ảnh tối đa ${Math.round(MEDIA.DIRECT_MAX / 1048576)}MB.`);
    if (!encrypt && size > MEDIA.PART_BYTES) throw bad(`Ảnh không mã hoá chỉ tối đa ${(MEDIA.PART_BYTES / 1048576).toFixed(1)}MB — hãy bật mã hoá.`);
    if (plan === 'hls') {
        const ok = c.kind === 'audio' ? MEDIA.HLS_AUDIO_EXTS : MEDIA.HLS_VIDEO_EXTS;
        if (!ok.includes(c.ext)) {
            throw bad(`File ${c.kind === 'audio' ? 'âm thanh' : 'video'} trên ${Math.round(MEDIA.DIRECT_MAX / 1048576)}MB chỉ cắt (m3u8) được với đuôi: ${ok.map((e) => '.' + e).join(', ')}` +
                `${c.kind === 'video' ? ' (H.264 / H.265 / AV1 / VP9 + AAC, mp4 thường — không phải mp4 phân mảnh)' : ''}. Định dạng ${'.' + c.ext} chỉ tải được khi ≤ ${Math.round(MEDIA.DIRECT_MAX / 1048576)}MB — hãy chuyển sang ${c.kind === 'audio' ? 'mp3' : 'mp4 (H.264/AAC)'}.`);
        }
    }
    const m = await readManifest(uid, c.dirSegs);
    const ex = m.files[c.name];
    const resume = plan === 'hls' && ex && ex.state === 'uploading' && ex.src && ex.src.size === size && ex.src.lastModified === Number(b.lastModified) && ex.src.name === String(b.srcName || c.name) ? ex : null;
    const tree = await gh.getRepoTree();
    let target = resume && isMediaStorage(ex.storage) ? { provider: ex.storage.provider, storage: ex.storage, fallback: null } : await targetFor(c.kind);
    if (resume && isMediaStorage(ex.storage)) { const t = await targetFor(c.kind).catch(() => null); if (t && t.fallback) target.fallback = t.fallback; }
    const notice = target.provider === 'github-fallback'
        ? 'Cloudflare chưa dùng được — âm thanh/video sẽ lưu vào repo GitHub dự phòng (không dùng tài khoản media đang khoá).'
        : null;
    return {
        ok: true, name: c.name, kind: c.kind, plan, encrypt, uploadId: resume ? resume.uploadId : hex(16),
        partBytes: MEDIA.PART_BYTES, segBytes: MEDIA.SEG_MAX_BYTES, segSec: c.kind === 'audio' ? MEDIA.SEG_AUDIO_SEC : MEDIA.SEG_VIDEO_SEC,
        storage: target.provider, provider: target.provider, notice,
        exists: !!(ex && !resume) || tree.files.has(c.filePath),
        resume: resume ? { done: resume.done || 0, durs: resume.durs || [], sizes: resume.sizes || [] } : null
    };
}

// ---------------------------------------------------------------- xoá bản cũ cùng tên (file trực tiếp hoặc mục media đã cắt)
async function removalChanges(uid, dirSegs, name, { keepPrefixPaths = new Set(), keepManifestEntries = false } = {}) {
    const out = [];
    const m = await readManifest(uid, dirSegs);
    const ex = m.files[name];
    if (ex && ex.id) for (const p of await treePaths(join(root(uid), dirRel(dirSegs), MEDIA.HIDDEN_DIR, ex.id) + '/')) if (!keepPrefixPaths.has(p)) out.push({ path: p, remove: true });
    return { out, manifest: m, entry: ex };
}
async function dropEntryIfAny(uid, c) {          // ghi file trực tiếp cùng tên → bỏ mục media cũ (và các đoạn) khỏi json
    const { out, manifest, entry } = await removalChanges(uid, c.dirSegs, c.name);
    if (!entry) return;
    await purgeEntry(uid, c.dirSegs, entry);
    delete manifest.files[c.name];
    const mp = manifestPath(uid, c.dirSegs);
    if (keepManifest(manifest)) out.push({ path: mp, content: Buffer.from(JSON.stringify(manifest, null, 2)) });
    else out.push({ path: mp, remove: true });
    await gh.commitFiles(out, `media: thay ${c.name}`);
}
async function writeDirectEntry(uid, c, entry) {
    const m = await readManifest(uid, c.dirSegs);
    m.files[c.name] = entry;
    m.v = 1;
    await gh.commitFiles([{ path: manifestPath(uid, c.dirSegs), content: Buffer.from(JSON.stringify(m, null, 2)) }], `media: ${c.name}`);
}

// ---------------------------------------------------------------- direct (≤ 23MB)
async function putPart(uid, q, body) {
    const c = ctxOf(uid, q);
    const uploadId = checkUploadId(q.uploadId);
    const i = Number(q.i), n = Number(q.n);
    if (!Buffer.isBuffer(body) || !body.length) throw bad('Phần dữ liệu rỗng.');
    if (body.length > MEDIA.PART_BYTES) throw bad('Phần dữ liệu quá lớn.', 413);
    if (!Number.isInteger(i) || !Number.isInteger(n) || n < 1 || n > 8 || i < 0 || i >= n) throw bad('Số thứ tự phần không hợp lệ.');
    const target = await targetFor(c.kind);
    const useCloud = target.provider !== 'github';

    if (!useCloud) {                 // đường cũ: ảnh / khi chưa cấu hình Cloudflare hoặc GitHub dự phòng
        let encrypt = c.kind === 'image' ? String(q.encrypt) !== '0' : true;
        if (!encrypt && n === 1 && privList(await readManifest(uid, c.dirSegs)).includes(c.name)) encrypt = true;      // tên đang tắt công khai → luôn mã hoá, không để lộ bản rõ
        if (n === 1) {
            await dropEntryIfAny(uid, c);
            const data = encrypt ? mc.encryptBuffer(body) : body;
            await gh.writeBinaryFileBig(c.filePath, data, `media: ${c.name}`);
            mediaRepo.addBytes(data.length);
            return { ok: true, done: true, name: c.name, encrypted: encrypt };
        }
        if (!encrypt) throw bad('File nhiều phần bắt buộc mã hoá.');
        const rec = mc.encryptRecord(body, mc.deriveSalt(uploadId), i);
        const sha = await gh.createBlob(rec);
        return { ok: true, sha, size: rec.length, receipt: mc.receipt(uid, uploadId, `${c.filePath}#${i}`, sha, rec.length) };
    }

    // ---- Cloudflare R2 / GitHub dự phòng
    if (n === 1) {
        let encrypt = true;
        if (!encrypt) throw bad('Âm thanh/video luôn được mã hoá.');
        if (privList(await readManifest(uid, c.dirSegs)).includes(c.name)) encrypt = true;
        await dropEntryIfAny(uid, c);
        const salt = mc.deriveSalt(uploadId);
        const data = mc.encryptBuffer(body, salt);
        let st = target.storage, notice = null;
        try {
            await writeObject(st, c.filePath, data, contentTypeOf(c));
        } catch (e) {
            if (target.provider === 'cloudflare' && target.fallback) {
                st = target.fallback;
                await writeObject(st, c.filePath, data, contentTypeOf(c));
                notice = 'Cloudflare R2 lỗi khi ghi — đã lưu vào repo GitHub dự phòng.';
            } else throw e;
        }
        const saltHex = mc.saltOf(data) ? mc.saltOf(data).toString('hex') : null;
        await writeDirectEntry(uid, c, {
            name: c.name, kind: c.kind, mode: 'direct', mime: contentTypeOf(c), size: body.length,
            state: 'ready', storage: st, enc: saltHex ? { salt: saltHex } : null,
            uploadId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
        });
        return { ok: true, done: true, name: c.name, encrypted: true, storage: provOf(st), provider: provOf(st), notice };
    }

    const salt = mc.deriveSalt(uploadId);
    const rec = mc.encryptRecord(body, salt, i);
    const tempKey = `${c.filePath}.__parts/${uploadId}/${i}`;
    let st = target.storage, provider = provOf(st), ref = tempKey, notice = null;
    try {
        await writeObject(st, tempKey, rec, 'application/octet-stream');
    } catch (e) {
        if (target.provider === 'cloudflare' && target.fallback) {
            st = target.fallback;
            provider = 'github-fallback';
            ref = await cloudflare.fallbackCreateBlob(st, rec);
            notice = 'Cloudflare R2 lỗi khi ghi — phần này dùng repo GitHub dự phòng.';
        } else throw e;
    }
    return {
        ok: true, sha: ref, ref, size: rec.length, storage: provider, provider, notice,
        receipt: mc.receipt(uid, uploadId, `${c.filePath}#${i}`, ref, rec.length)
    };
}
async function finish(uid, b) {
    const c = ctxOf(uid, b);
    const uploadId = checkUploadId(b.uploadId);
    const parts = Array.isArray(b.parts) ? b.parts : [];
    if (parts.length < 2 || parts.length > 8) throw bad('Số phần không hợp lệ.');

    const legacy = parts.every((p) => !p || !p.provider || p.provider === 'github');
    if (legacy) {
        const bufs = [];
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i] || {};
            if (Number(p.i) !== i) throw bad('Các phần phải đủ và đúng thứ tự.');
            if (!mc.verifyReceipt(p.receipt, uid, uploadId, `${c.filePath}#${i}`, String(p.sha), Number(p.size))) throw bad('Biên nhận phần ' + (i + 1) + ' không hợp lệ.', 403);
            const buf = await gh.getBlobBuffer(String(p.sha));
            if (!buf || buf.length !== Number(p.size)) throw bad('Không đọc lại được phần ' + (i + 1) + ' trên GitHub — hãy tải lên lại.');
            bufs.push(buf);
        }
        const data = mc.assemble(mc.deriveSalt(uploadId), bufs);
        if (data.length > MEDIA.DIRECT_MAX + 1024 * 1024) throw bad('File quá lớn.');
        await dropEntryIfAny(uid, c);
        await gh.writeBinaryFileBig(c.filePath, data, `media: ${c.name}`);
        mediaRepo.addBytes(data.length);
        return { ok: true, name: c.name, encrypted: true };
    }

    // ---- ghép các phần từ R2 / GitHub dự phòng (có thể trộn nếu R2 lỗi giữa chừng)
    const target = await targetFor(c.kind);
    const bufs = [], cfTemps = [];
    for (let i = 0; i < parts.length; i++) {
        const p = parts[i] || {};
        if (Number(p.i) !== i) throw bad('Các phần phải đủ và đúng thứ tự.');
        const ref = String(p.ref || p.sha || '');
        if (!mc.verifyReceipt(p.receipt, uid, uploadId, `${c.filePath}#${i}`, ref, Number(p.size))) throw bad('Biên nhận phần ' + (i + 1) + ' không hợp lệ.', 403);
        const provider = p.provider || target.provider;
        let buf;
        try { buf = await readPart(provider, provider === 'cloudflare' ? (storageFor('cloudflare', target) || target.storage) : storageFor('github-fallback', target), ref); }
        catch (e) { throw bad('Không đọc lại được phần ' + (i + 1) + ' (' + provider + '): ' + e.message); }
        if (!buf || buf.length !== Number(p.size)) throw bad('Không đọc lại được phần ' + (i + 1) + ' — hãy tải lên lại.');
        bufs.push(buf);
        if (provider === 'cloudflare') cfTemps.push(ref);
    }
    const data = mc.assemble(mc.deriveSalt(uploadId), bufs);
    if (data.length > MEDIA.DIRECT_MAX + 1024 * 1024) throw bad('File quá lớn.');
    let st = storageFor('cloudflare', target) || storageFor('github-fallback', target);
    if (!st) throw bad('Chưa cấu hình kho lưu cho âm thanh/video.', 503);
    let notice = null;
    try {
        await writeObject(st, c.filePath, data, contentTypeOf(c));
    } catch (e) {                        // R2 lỗi lúc ghép → ghi cả file sang repo dự phòng
        if (provOf(st) === 'cloudflare' && target.fallback) {
            st = target.fallback;
            await writeObject(st, c.filePath, data, contentTypeOf(c));
            notice = 'Cloudflare R2 lỗi khi ghi — đã lưu vào repo GitHub dự phòng.';
        } else throw e;
    }
    for (const key of cfTemps) { try { await removeObject(storageFor('cloudflare', target) || st, key); } catch (_) { /* blob tạm */ } }
    await dropEntryIfAny(uid, c);
    const saltHex = mc.saltOf(data) ? mc.saltOf(data).toString('hex') : null;
    await writeDirectEntry(uid, c, {
        name: c.name, kind: c.kind, mode: 'direct', mime: contentTypeOf(c), size: data.length,
        state: 'ready', storage: st, enc: saltHex ? { salt: saltHex } : null,
        uploadId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
    return { ok: true, name: c.name, encrypted: true, storage: provOf(st), provider: provOf(st), notice };
}

// ---------------------------------------------------------------- hls (> 23MB): đoạn + commit
const segRel = (id, file) => `${MEDIA.HIDDEN_DIR}/${id}/${file}`;
const isFmp4 = (f) => f === 'fmp4';
/** init.mp4 do client gửi (base64): phải là ftyp + moov, nhỏ (chỉ cấu hình codec, không có mẫu nén). */
function checkInit(b64) {
    if (typeof b64 !== 'string' || !b64 || b64.length > 180000) throw bad('Thiếu hoặc quá lớn init segment (fMP4).');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 32 || buf.length > 131072 || buf.toString('latin1', 4, 8) !== 'ftyp' || buf.indexOf('moov', 8, 'latin1') < 0) throw bad('Init segment (fMP4) không hợp lệ.');
    return buf.toString('base64');
}
async function putSeg(uid, q, body) {
    const c = ctxOf(uid, q);
    const uploadId = checkUploadId(q.uploadId);
    if (!Buffer.isBuffer(body) || !body.length) throw bad('Đoạn rỗng.');
    if (body.length > MEDIA.SEG_MAX_BYTES) throw bad('Đoạn quá lớn (tối đa ' + (MEDIA.SEG_MAX_BYTES / 1048576).toFixed(1) + 'MB).', 413);
    if (c.kind !== 'audio' && c.kind !== 'video') throw bad('Chỉ âm thanh/video mới cắt đoạn.');
    if (!MEDIA.HLS_AUDIO_EXTS.concat(MEDIA.HLS_VIDEO_EXTS).includes(c.ext)) throw bad('File này không cắt được.');
    const fm = isFmp4(q.fmt);
    if (fm) {
        if (c.kind !== 'video') throw bad('Chỉ video mới có đoạn fMP4.');
        if (body.length < 16 || body.toString('latin1', 4, 8) !== 'moof') throw bad('Đoạn không phải fMP4 hợp lệ (phải bắt đầu bằng hộp moof).');
    } else if (body.length % 188 !== 0 || body[0] !== 0x47) throw bad('Đoạn không phải MPEG-TS hợp lệ (độ dài phải chia hết 188 và bắt đầu bằng 0x47).');
    const i = Number(q.i);
    if (!Number.isInteger(i) || i < 0 || i > 200000) throw bad('Số thứ tự đoạn không hợp lệ.');
    const id = mediaId(c.name), file = hls.segName(i, fm ? 'm4s' : 'ts');
    // âm thanh & video: AES-128 chuẩn HLS, khoá RIÊNG của lần tải lên (bọc 2 chiều trong json) → hls.js trong trình duyệt tự giải mã đoạn.
    const data = mc.encryptHlsSegment(body, mc.hlsKey(uid, uploadId), i);
    const path = join(root(uid), dirRel(c.dirSegs), segRel(id, file));
    const target = await targetFor(c.kind);

    if (target.provider === 'github') {
        const sha = await gh.createBlob(data);
        mediaRepo.addBytes(data.length);
        return { ok: true, sha, size: data.length, plainSize: body.length, provider: 'github', receipt: mc.receipt(uid, uploadId, path, sha, data.length) };
    }

    let st = target.storage, provider = provOf(st), ref = path, notice = null;
    try {
        await writeObject(st, path, data, fm ? 'video/iso.segment' : 'video/mp2t');
    } catch (e) {
        if (target.provider === 'cloudflare' && target.fallback) {
            st = target.fallback;
            provider = 'github-fallback';
            ref = await cloudflare.fallbackCreateBlob(st, data);
            notice = 'Cloudflare R2 lỗi khi ghi đoạn ' + (i + 1) + ' — dùng repo GitHub dự phòng.';
        } else throw e;
    }
    return { ok: true, sha: ref, ref, size: data.length, plainSize: body.length, storage: provider, provider, notice, receipt: mc.receipt(uid, uploadId, path, ref, data.length) };
}

async function commit(uid, b) {
    const c = ctxOf(uid, b);
    if (c.kind !== 'audio' && c.kind !== 'video') throw bad('Chỉ âm thanh/video mới cắt đoạn.');
    const uploadId = checkUploadId(b.uploadId);
    const src = b.src || {};
    const srcSize = Number(src.size);
    if (!Number.isInteger(srcSize) || srcSize <= MEDIA.DIRECT_MAX || srcSize > MEDIA.MAX_FILE_BYTES) throw bad('Kích thước file gốc không hợp lệ.');
    const id = mediaId(c.name), base = join(root(uid), dirRel(c.dirSegs));
    const segs = Array.isArray(b.segs) ? b.segs : [];
    if (segs.length > 400) throw bad('Lô quá lớn.');
    if (!MEDIA.HLS_AUDIO_EXTS.concat(MEDIA.HLS_VIDEO_EXTS).includes(c.ext)) throw bad('Đuôi file không cắt được.');

    const fm = isFmp4(b.fmt), segExt = fm ? 'm4s' : 'ts';
    if (fm && c.kind !== 'video') throw bad('Chỉ video mới có đoạn fMP4.');
    const m = await readManifest(uid, c.dirSegs);
    let e = m.files[c.name];
    const cont = e && e.uploadId === uploadId && e.state === 'uploading';
    if (cont && (e.segExt || 'ts') !== segExt) throw bad('Kiểu đoạn không khớp với lần tải dở trước — hãy tải lại file từ đầu.');

    const target = await targetFor(c.kind);
    const entryStorage = cont && isMediaStorage(e.storage) ? e.storage : null;
    const hasCloudSeg = segs.some((s) => s && (s.provider === 'cloudflare' || s.provider === 'github-fallback'));
    const useCloud = isMediaStorage(entryStorage) || (!cont && target.provider !== 'github') || hasCloudSeg;

    if (!useCloud) {                 // đường cũ (ảnh không cắt; khi chưa cấu hình Cloudflare/dự phòng)
        const changes = [];
        if (!cont) {
            if (Number(segs[0] && segs[0].i) !== 0 && segs.length) throw bad('Lô đầu tiên phải bắt đầu từ đoạn 0.');
            const keep = new Set(segs.map((s) => join(base, segRel(id, hls.segName(Number(s.i), segExt)))));
            changes.push(...(await removalChanges(uid, c.dirSegs, c.name, { keepPrefixPaths: keep })).out);
            e = { name: c.name, id, kind: c.kind, mode: c.kind === 'audio' ? 'hls-audio' : 'hls-video', mime: MIME_OF[c.ext] || 'application/octet-stream', segExt, size: srcSize, durs: [], sizes: [], done: 0, createdAt: new Date().toISOString() };
            e.drm = { method: 'AES-128', key: mc.wrapKey(mc.hlsKey(uid, uploadId)) };
        }
        if (fm) {
            e.init = checkInit(b.init);
            if (typeof b.codecs === 'string' && /^[A-Za-z0-9_.,+\- ]{1,120}$/.test(b.codecs)) e.codecs = b.codecs;
        }
        let expect = e.done || 0;
        for (const s of segs) {
            const i = Number(s.i);
            if (i !== expect) throw bad(`Các đoạn phải liên tục: cần đoạn ${expect}, nhận ${s.i}.`);
            const dur = Number(s.dur), plain = Number(s.plainSize);
            if (!(dur > 0 && dur < 600) || !(plain > 0)) throw bad('Thời lượng/kích thước đoạn không hợp lệ.');
            const path = join(base, segRel(id, hls.segName(i, segExt)));
            if (!mc.verifyReceipt(s.receipt, uid, uploadId, path, String(s.sha), Number(s.size))) throw bad(`Biên nhận đoạn ${i} không hợp lệ.`, 403);
            changes.push({ path, sha: String(s.sha) });
            e.durs[i] = Math.round(dur * 1000) / 1000; e.sizes[i] = plain; expect++;
        }
        e.done = expect;
        e.src = { name: String(b.srcName || c.name), size: srcSize, lastModified: Number(src.lastModified) || 0 };
        e.uploadId = uploadId; e.updatedAt = new Date().toISOString();
        const final = b.final === true;
        if (final) {
            if (!e.done) throw bad('Chưa có đoạn nào.');
            e.state = 'ready'; e.total = e.done; e.duration = Math.round(e.durs.reduce((a, x) => a + x, 0) * 1000) / 1000; e.playlist = segRel(id, 'index.m3u8');
            changes.push({ path: join(base, e.playlist), content: Buffer.from(hls.build(e, { seg: (i) => hls.segName(i, e.segExt), key: 'key.bin', init: 'init.mp4' })) });
            if ((await gh.getRepoTree()).files.has(c.filePath)) changes.push({ path: c.filePath, remove: true });
        } else { e.state = 'uploading'; e.total = Number(b.total) > 0 ? Number(b.total) : undefined; }
        m.files[c.name] = e; m.v = 1;
        changes.push({ path: manifestPath(uid, c.dirSegs), content: Buffer.from(JSON.stringify(m, null, 2)) });
        await gh.commitFiles(changes, `media: ${c.name} ${final ? 'xong' : e.done + ' đoạn'}`);
        return { ok: true, done: e.done, state: e.state, storage: 'github' };
    }

    // ---- Cloudflare R2 / GitHub dự phòng
    const changes = [], fbChanges = [];
    if (!cont) {
        if (Number(segs[0] && segs[0].i) !== 0 && segs.length) throw bad('Lô đầu tiên phải bắt đầu từ đoạn 0.');
        if (e) await purgeEntry(uid, c.dirSegs, e);
        const keep = new Set(segs.map((s) => join(base, segRel(id, hls.segName(Number(s.i), segExt)))));
        changes.push(...(await removalChanges(uid, c.dirSegs, c.name, { keepPrefixPaths: keep })).out);
        const st = isMediaStorage(target.storage) ? target.storage : (target.provider === 'github-fallback' ? target.fallback : null);
        if (!st) throw bad('Cloudflare R2 và repo GitHub dự phòng đều chưa cấu hình — không có chỗ lưu video/âm thanh.', 503);
        e = { name: c.name, id, kind: c.kind, mode: c.kind === 'audio' ? 'hls-audio' : 'hls-video', mime: MIME_OF[c.ext] || 'application/octet-stream', segExt, size: srcSize, durs: [], sizes: [], done: 0, createdAt: new Date().toISOString(), storage: st };
        e.drm = { method: 'AES-128', key: mc.wrapKey(mc.hlsKey(uid, uploadId)) };
    }
    if (!isMediaStorage(e.storage)) e.storage = target.storage || target.fallback;
    if (!isMediaStorage(e.storage)) throw bad('Không xác định được kho lưu của media.', 503);
    if (fm) {
        e.init = checkInit(b.init);
        if (typeof b.codecs === 'string' && /^[A-Za-z0-9_.,+\- ]{1,120}$/.test(b.codecs)) e.codecs = b.codecs;
    }
    let expect = e.done || 0;
    for (const s of segs) {
        const i = Number(s.i);
        if (i !== expect) throw bad(`Các đoạn phải liên tục: cần đoạn ${expect}, nhận ${s.i}.`);
        const dur = Number(s.dur), plain = Number(s.plainSize);
        if (!(dur > 0 && dur < 600) || !(plain > 0)) throw bad('Thời lượng/kích thước đoạn không hợp lệ.');
        const path = join(base, segRel(id, hls.segName(i, segExt)));
        const ref = String(s.ref || s.sha || '');
        const provider = s.provider === 'github-fallback' ? 'github-fallback' : (s.provider === 'cloudflare' ? 'cloudflare' : provOf(e.storage));
        const st = storageFor(provider, target) || (provider === provOf(e.storage) ? e.storage : null);
        if (!isMediaStorage(st)) throw bad(`Đoạn ${i} không có kho lưu hợp lệ (${provider}).`, 503);
        if (!mc.verifyReceipt(s.receipt, uid, uploadId, path, ref, Number(s.size))) throw bad(`Biên nhận đoạn ${i} không hợp lệ.`, 403);
        if (provider === 'github-fallback') {
            fbChanges.push({ path, sha: ref });
            if (provOf(e.storage) !== 'github-fallback') {
                e.segStorage = e.segStorage || {};
                e.segStorage[i] = st;
            }
        } else if (provider === 'cloudflare') {
            if (provOf(e.storage) !== 'cloudflare') {
                e.segStorage = e.segStorage || {};
                e.segStorage[i] = st;
            }
        } else throw bad(`Đoạn ${i} không có kho lưu Cloudflare/dự phòng.`, 503);
        e.durs[i] = Math.round(dur * 1000) / 1000; e.sizes[i] = plain; expect++;
    }
    e.done = expect;
    e.src = { name: String(b.srcName || c.name), size: srcSize, lastModified: Number(src.lastModified) || 0 };
    e.uploadId = uploadId; e.updatedAt = new Date().toISOString();
    const final = b.final === true;
    let notice = null;
    if (final) {
        if (!e.done) throw bad('Chưa có đoạn nào.');
        e.state = 'ready'; e.total = e.done; e.duration = Math.round(e.durs.reduce((a, x) => a + x, 0) * 1000) / 1000; e.playlist = segRel(id, 'index.m3u8');
        const playlistPath = join(base, e.playlist);
        const playlist = Buffer.from(hls.build(e, { seg: (i) => hls.segName(i, e.segExt), key: 'key.bin', init: 'init.mp4' }));
        // Đếm đoạn thật sự nằm trên R2: R2 có thể đã lỗi khi tải đoạn và mọi đoạn đã sang GitHub dự phòng.
        let cloudSegs = 0;
        for (let i = 0; i < e.done; i++) {
            const st = e.segStorage && isMediaStorage(e.segStorage[i]) ? e.segStorage[i] : e.storage;
            if (st && st.provider === 'cloudflare') cloudSegs++;
        }
        if (!cloudSegs) {                       // không còn đoạn nào trên R2 → cả media thuộc repo dự phòng
            const fbSt = storageFor('github-fallback', target) || (provOf(e.storage) === 'github-fallback' ? e.storage : null);
            if (!fbSt) throw bad('Repo GitHub dự phòng chưa cấu hình để ghi media.', 503);
            e.storage = fbSt;
            delete e.segStorage;
            notice = 'Cloudflare R2 lỗi khi tải đoạn — media được ghi sang repo GitHub dự phòng.';
        }
        // m3u8 lưu cùng kho với đoạn: R2 hoặc repo GitHub dự phòng (yêu cầu "ghi m3u8 sang đó").
        const plStores = new Map();
        const putPl = (st) => { if (isMediaStorage(st)) plStores.set([st.provider, st.owner || '', st.repo || '', st.bucket || '', st.accountId || ''].join('|'), st); };
        putPl(e.storage);
        if (e.segStorage) for (const st of Object.values(e.segStorage)) putPl(st);
        let needFbPl = false;
        for (const st of plStores.values()) {
            if (st.provider !== 'cloudflare') { needFbPl = true; continue; }
            try { await writeObject(st, playlistPath, playlist, 'application/vnd.apple.mpegurl'); }
            catch (err) {                       // R2 lỗi khi ghi m3u8 → vẫn phải có m3u8 ở repo dự phòng
                console.warn('[mediaService] ghi m3u8 lên Cloudflare R2 thất bại:', err.message);
                needFbPl = true;
                notice = 'Cloudflare R2 lỗi khi ghi m3u8 — đã ghi sang repo GitHub dự phòng.';
            }
        }
        if (needFbPl) fbChanges.push({ path: playlistPath, content: playlist });
        if ((await gh.getRepoTree()).files.has(c.filePath)) changes.push({ path: c.filePath, remove: true });
    } else { e.state = 'uploading'; e.total = Number(b.total) > 0 ? Number(b.total) : undefined; }
    if (fbChanges.length) {                 // đoạn/m3u8 dự phòng: ghi ngay theo từng lô để đứt mạng vẫn tiếp tục được
        const fbSt = storageFor('github-fallback', target) || (provOf(e.storage) === 'github-fallback' ? e.storage : null);
        if (!fbSt) throw bad('Repo GitHub dự phòng chưa cấu hình để ghi đoạn/m3u8.', 503);
        await cloudflare.fallbackCommit(fbSt, fbChanges, `media: ${c.name} ${e.done} đoạn (dự phòng)`);
    }
    m.files[c.name] = e; m.v = 1;
    changes.push({ path: manifestPath(uid, c.dirSegs), content: Buffer.from(JSON.stringify(m, null, 2)) });
    await gh.commitFiles(changes, `media: ${c.name} ${final ? 'xong' : e.done + ' đoạn'}`);
    return { ok: true, done: e.done, state: e.state, storage: provOf(e.storage), notice };
}

// ---------------------------------------------------------------- liệt kê / xoá
async function listMedia(uid, dirSegs) { return listFrom(await readManifest(uid, dirSegs)); }
function listFrom(m) {
    return Object.entries(m.files).map(([name, e]) => ({ name, kind: e.kind, mode: e.mode, size: e.size, state: e.state, done: e.done || 0, total: e.total || null, duration: e.duration || null, storage: provOf(e.storage) }))
        .sort((a, b) => a.name.localeCompare(b.name));
}
async function deleteMedia(uid, q) {
    const dirSegs = store.cleanDir(q.dir || '');
    const name = String(q.name || '');
    const { out, manifest, entry } = await removalChanges(uid, dirSegs, name);
    if (!entry) throw bad('Không có media này trong json.', 404);
    await purgeEntry(uid, dirSegs, entry);
    delete manifest.files[name];
    const mp = manifestPath(uid, dirSegs);
    dropPrivate(manifest, name);
    out.push(keepManifest(manifest) ? { path: mp, content: Buffer.from(JSON.stringify(manifest, null, 2)) } : { path: mp, remove: true });
    await gh.commitFiles(out, `media: xoá ${name}`);
    return { ok: true };
}


// ---------------------------------------------------------------- bật / tắt công khai (trình phát của tôi)
// Tắt công khai → file chỉ bị ẨN khỏi danh sách + trình phát của "Xem thư mục trên mạng" (nhúng vào html vẫn chạy bình thường); ảnh chưa mã hoá BẮT BUỘC mã hoá
// (repo công khai nên bản rõ vẫn tải thẳng được). Âm thanh/video vốn luôn mã hoá. Bật lại công khai: giữ nguyên bản đã mã hoá (máy chủ tự giải mã khi phát).
async function setPublic(uid, b) {
    const dirSegs = store.cleanDir(b.dir || '');
    const name = String(b.name || '');
    if (!name || /[\\/]/.test(name) || !mediaKind(name)) throw bad('Tên file ảnh/âm thanh/video không hợp lệ.');
    const pub = b.public === true;
    const m = await readManifest(uid, dirSegs);
    const ent = m.files[name];
    const filePath = join(root(uid), dirRel(dirSegs), name);
    const tree = await gh.getRepoTree({ force: true });
    if (!ent && !tree.files.has(filePath)) throw bad('Không tìm thấy file này.', 404);
    const cur = privList(m), isPriv = cur.includes(name);
    if (pub === !isPriv) return { ok: true, public: pub, changed: false };
    const changes = [];
    let encrypted = true;
    if (!pub && !ent && mediaKind(name) === 'image') {
        const buf = await gh.readBinaryFile(filePath);
        if (!buf) throw bad('Không đọc được file ảnh.', 404);
        if (!mc.isEncrypted(buf)) { changes.push({ path: filePath, content: mc.encryptBuffer(buf) }); encrypted = false; }
    }
    if (pub) dropPrivate(m, name); else m.private = [...new Set([...cur, name])].sort();
    m.v = 1;
    const mp = manifestPath(uid, dirSegs);
    changes.push(keepManifest(m) ? { path: mp, content: Buffer.from(JSON.stringify(m, null, 2)) } : { path: mp, remove: true });
    await gh.commitFiles(changes, `media: ${pub ? 'công khai' : 'tắt công khai'} ${name}`);
    return { ok: true, public: pub, changed: true, encryptedNow: !pub && !encrypted };
}

module.exports = {
    cleanAssetName, init, putPart, finish, putSeg, commit, listMedia, listFrom, deleteMedia, readManifest, mediaId, setPublic,
    targetFor, purgeEntry
};
