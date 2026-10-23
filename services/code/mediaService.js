// services/code/mediaService.js — tải lên ảnh / âm thanh / video cho dạng code "html" ({user_id}/codes/html/[thư-mục]/...)
//
// Mọi request đều NHỎ (≤ 3.5MB, hợp giới hạn 4.5MB của Vercel) và KHÔNG giữ trạng thái giữa các request:
//   ┌ file ≤ 23MB ("direct")  : PUT part (mã hoá từng phần → blob) … POST finish (ghép → 1 file cùng tên, đã mã hoá).  File ≤ 3.5MB: 1 request.
//   └ âm thanh/video > 23MB   : TRÌNH DUYỆT cắt thành đoạn MPEG-TS (public/js/tsMux.js), PUT seg (mã hoá từng đoạn → blob),
//                              POST commit từng lô: ghi đoạn + m3u8 + ĐÁNH DẤU TIẾN ĐỘ vào mnha-media.json (1 commit/lô) → có thể làm tiếp nếu đứt.
//        âm thanh: đoạn .ts mã hoá 2 chiều trực tiếp (MNHAENC1)       — Node giải mã từng đoạn khi trình phát xin (previewServer)
//        video   : đoạn .ts mã hoá AES-128 chuẩn HLS (DRM), khoá ghi trong json (đã mã hoá 2 chiều) — hls.js giải mã khi phát, key.bin do Node trả
//   mnha-media.json (cùng thư mục file gốc) khai báo "song.mp3" → playlist _media/song_mp3/index.m3u8 (đuôi gốc được khai báo là m3u8).
//   Biên nhận HMAC ngăn client nhét sha blob bất kỳ (của người khác) vào commit.
'use strict';
const crypto = require('crypto');
const gh = require('../githubService');
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
                `${c.kind === 'video' ? ' (H.264 + AAC, mp4 thường — không phải mp4 phân mảnh)' : ''}. Định dạng ${'.' + c.ext} chỉ tải được khi ≤ ${Math.round(MEDIA.DIRECT_MAX / 1048576)}MB — hãy chuyển sang ${c.kind === 'audio' ? 'mp3' : 'mp4 (H.264/AAC)'}.`);
        }
    }
    const m = await readManifest(uid, c.dirSegs);
    const ex = m.files[c.name];
    const resume = plan === 'hls' && ex && ex.state === 'uploading' && ex.src && ex.src.size === size && ex.src.lastModified === Number(b.lastModified) && ex.src.name === String(b.srcName || c.name) ? ex : null;
    const tree = await gh.getRepoTree();
    return {
        ok: true, name: c.name, kind: c.kind, plan, encrypt, uploadId: resume ? resume.uploadId : hex(16),
        partBytes: MEDIA.PART_BYTES, segBytes: MEDIA.SEG_MAX_BYTES, segSec: c.kind === 'audio' ? MEDIA.SEG_AUDIO_SEC : MEDIA.SEG_VIDEO_SEC,
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
    delete manifest.files[c.name];
    const mp = manifestPath(uid, c.dirSegs);
    if (Object.keys(manifest.files).length) out.push({ path: mp, content: Buffer.from(JSON.stringify(manifest, null, 2)) });
    else out.push({ path: mp, remove: true });
    await gh.commitFiles(out, `media: thay ${c.name}`);
}

// ---------------------------------------------------------------- direct (≤ 23MB)
async function putPart(uid, q, body) {
    const c = ctxOf(uid, q);
    const uploadId = checkUploadId(q.uploadId);
    const i = Number(q.i), n = Number(q.n);
    if (!Buffer.isBuffer(body) || !body.length) throw bad('Phần dữ liệu rỗng.');
    if (body.length > MEDIA.PART_BYTES) throw bad('Phần dữ liệu quá lớn.', 413);
    if (!Number.isInteger(i) || !Number.isInteger(n) || n < 1 || n > 8 || i < 0 || i >= n) throw bad('Số thứ tự phần không hợp lệ.');
    const encrypt = c.kind === 'image' ? String(q.encrypt) !== '0' : true;
    if (n === 1) {
        await dropEntryIfAny(uid, c);
        const data = encrypt ? mc.encryptBuffer(body) : body;
        await gh.writeBinaryFileBig(c.filePath, data, `media: ${c.name}`);
        return { ok: true, done: true, name: c.name, encrypted: encrypt };
    }
    if (!encrypt) throw bad('File nhiều phần bắt buộc mã hoá.');
    const rec = mc.encryptRecord(body, mc.deriveSalt(uploadId), i);
    const sha = await gh.createBlob(rec);
    return { ok: true, sha, size: rec.length, receipt: mc.receipt(uid, uploadId, `${c.filePath}#${i}`, sha, rec.length) };
}
async function finish(uid, b) {
    const c = ctxOf(uid, b);
    const uploadId = checkUploadId(b.uploadId);
    const parts = Array.isArray(b.parts) ? b.parts : [];
    if (parts.length < 2 || parts.length > 8) throw bad('Số phần không hợp lệ.');
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
    return { ok: true, name: c.name, encrypted: true };
}

// ---------------------------------------------------------------- hls (> 23MB): đoạn + commit
const segRel = (id, file) => `${MEDIA.HIDDEN_DIR}/${id}/${file}`;
async function putSeg(uid, q, body) {
    const c = ctxOf(uid, q);
    const uploadId = checkUploadId(q.uploadId);
    if (!Buffer.isBuffer(body) || !body.length) throw bad('Đoạn rỗng.');
    if (body.length > MEDIA.SEG_MAX_BYTES) throw bad('Đoạn quá lớn (tối đa ' + (MEDIA.SEG_MAX_BYTES / 1048576).toFixed(1) + 'MB).', 413);
    if (c.kind !== 'audio' && c.kind !== 'video') throw bad('Chỉ âm thanh/video mới cắt đoạn.');
    if (!MEDIA.HLS_AUDIO_EXTS.concat(MEDIA.HLS_VIDEO_EXTS).includes(c.ext)) throw bad('File này không cắt được.');
    if (body.length % 188 !== 0 || body[0] !== 0x47) throw bad('Đoạn không phải MPEG-TS hợp lệ (độ dài phải chia hết 188 và bắt đầu bằng 0x47).');
    const i = Number(q.i);
    if (!Number.isInteger(i) || i < 0 || i > 200000) throw bad('Số thứ tự đoạn không hợp lệ.');
    const id = mediaId(c.name), file = hls.segName(i);
    // âm thanh: mã hoá 2 chiều trực tiếp (Node giải mã khi phát) · video: AES-128 chuẩn HLS (khoá DRM trong json)
    const data = c.kind === 'audio' ? mc.encryptBuffer(body) : mc.encryptHlsSegment(body, mc.hlsKey(uid, uploadId), i);
    const sha = await gh.createBlob(data);
    const path = join(root(uid), dirRel(c.dirSegs), segRel(id, file));
    return { ok: true, sha, size: data.length, plainSize: body.length, receipt: mc.receipt(uid, uploadId, path, sha, data.length) };
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

    const m = await readManifest(uid, c.dirSegs);
    let e = m.files[c.name];
    const cont = e && e.uploadId === uploadId && e.state === 'uploading';
    const changes = [];
    if (!cont) {            // lần commit đầu của lần tải này: bỏ bản cũ cùng tên (đoạn thừa, file trực tiếp)
        if (Number(segs[0] && segs[0].i) !== 0 && segs.length) throw bad('Lô đầu tiên phải bắt đầu từ đoạn 0.');
        const keep = new Set(segs.map((s) => join(base, segRel(id, hls.segName(Number(s.i))))));
        changes.push(...(await removalChanges(uid, c.dirSegs, c.name, { keepPrefixPaths: keep })).out);
        e = { name: c.name, id, kind: c.kind, mode: c.kind === 'audio' ? 'hls-audio' : 'hls-video', mime: MIME_OF[c.ext] || 'application/octet-stream', segExt: 'ts', size: srcSize, durs: [], sizes: [], done: 0, createdAt: new Date().toISOString() };
        if (c.kind === 'video') e.drm = { method: 'AES-128', key: mc.wrapKey(mc.hlsKey(uid, uploadId)) };
    }
    let expect = e.done || 0;
    for (const s of segs) {
        const i = Number(s.i);
        if (i !== expect) throw bad(`Các đoạn phải liên tục: cần đoạn ${expect}, nhận ${s.i}.`);
        const dur = Number(s.dur), plain = Number(s.plainSize);
        if (!(dur > 0 && dur < 600) || !(plain > 0)) throw bad('Thời lượng/kích thước đoạn không hợp lệ.');
        const path = join(base, segRel(id, hls.segName(i)));
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
        changes.push({ path: join(base, e.playlist), content: Buffer.from(hls.build(e, { seg: (i) => hls.segName(i), key: 'key.bin' })) });
        if ((await gh.getRepoTree()).files.has(c.filePath)) changes.push({ path: c.filePath, remove: true });      // "đọc trực tiếp" ưu tiên → bỏ file trực tiếp cũ cùng tên
    } else { e.state = 'uploading'; e.total = Number(b.total) > 0 ? Number(b.total) : undefined; }
    m.files[c.name] = e; m.v = 1;
    changes.push({ path: manifestPath(uid, c.dirSegs), content: Buffer.from(JSON.stringify(m, null, 2)) });
    await gh.commitFiles(changes, `media: ${c.name} ${final ? 'xong' : e.done + ' đoạn'}`);
    return { ok: true, done: e.done, state: e.state };
}

// ---------------------------------------------------------------- liệt kê / xoá
async function listMedia(uid, dirSegs) {
    const m = await readManifest(uid, dirSegs);
    return Object.entries(m.files).map(([name, e]) => ({ name, kind: e.kind, mode: e.mode, size: e.size, state: e.state, done: e.done || 0, total: e.total || null, duration: e.duration || null }))
        .sort((a, b) => a.name.localeCompare(b.name));
}
async function deleteMedia(uid, q) {
    const dirSegs = store.cleanDir(q.dir || '');
    const name = String(q.name || '');
    const { out, manifest, entry } = await removalChanges(uid, dirSegs, name);
    if (!entry) throw bad('Không có media này trong json.', 404);
    delete manifest.files[name];
    const mp = manifestPath(uid, dirSegs);
    out.push(Object.keys(manifest.files).length ? { path: mp, content: Buffer.from(JSON.stringify(manifest, null, 2)) } : { path: mp, remove: true });
    await gh.commitFiles(out, `media: xoá ${name}`);
    return { ok: true };
}

module.exports = { cleanAssetName, init, putPart, finish, putSeg, commit, listMedia, deleteMedia, readManifest, mediaId };
