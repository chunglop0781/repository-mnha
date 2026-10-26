// services/word/zip.js — đọc/ghi ZIP tối giản (không cần thư viện ngoài) cho .docx
//   • readZip(buf)  → { names, get(name) }  (giải nén method 0/8, giới hạn chống zip-bomb)
//   • writeZip(list) → Buffer               (method 8, tự chuyển sang method 0 nếu nén không nhỏ hơn)
// .docx là 1 file ZIP chuẩn OOXML: word/document.xml, word/styles.xml, word/media/... , [Content_Types].xml
'use strict';
const zlib = require('zlib');

const MAX_TOTAL_UNCOMPRESSED = 512 * 1024 * 1024;    // chống zip-bomb (đủ cho .docx 200MB có nhiều media)
const MAX_ENTRIES = 4000;

function fail(msg) { throw Object.assign(new Error(msg), { status: 400, code: 'BAD_DOCX' }); }

// ---------------------------------------------------------------- CRC32
const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
    }
    return t;
})();
function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function findEocd(buf) {
    const min = Math.max(0, buf.length - 22 - 0xFFFF);
    for (let i = buf.length - 22; i >= min; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            const commentLen = buf.readUInt16LE(i + 20);
            if (i + 22 + commentLen <= buf.length) return i;
        }
    }
    return -1;
}

/**
 * Đọc ZIP trong bộ nhớ. File .docx hỏng/không phải ZIP → lỗi 400 BAD_DOCX.
 * opts.requireDocx === false → đọc ZIP thường (vd. gói nhiều phần .docx) không cần word/document.xml.
 */
function readZip(buf, opts) {
    const requireDocx = !opts || opts.requireDocx !== false;
    if (!Buffer.isBuffer(buf) || buf.length < 22) fail('File Word không hợp lệ (không phải .docx).');
    const eocd = findEocd(buf);
    if (eocd < 0) fail('File Word không hợp lệ hoặc đã hỏng (không tìm thấy ZIP).');
    const count = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (count > MAX_ENTRIES) fail('File Word có quá nhiều thành phần.');
    if (cdOffset + cdSize > buf.length) fail('File Word bị cắt cụt.');
    const entries = new Map();
    let p = cdOffset, total = 0;
    for (let n = 0; n < count; n++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) fail('Danh mục ZIP của file Word không hợp lệ.');
        const flags = buf.readUInt16LE(p + 8);
        const method = buf.readUInt16LE(p + 10);
        const compSize = buf.readUInt32LE(p + 20);
        const uncompSize = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOffset = buf.readUInt32LE(p + 42);
        if (p + 46 + nameLen + extraLen + commentLen > buf.length) fail('Danh mục ZIP của file Word bị cắt cụt.');
        const name = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1').replace(/\\/g, '/');
        p += 46 + nameLen + extraLen + commentLen;
        if (!name || name.endsWith('/')) continue;
        if (compSize > buf.length || localOffset + 30 > buf.length) fail('Thành phần ZIP của file Word không hợp lệ.');
        if (buf.readUInt32LE(localOffset) !== 0x04034b50) fail('Thành phần ZIP của file Word không hợp lệ.');
        const lnLen = buf.readUInt16LE(localOffset + 26), leLen = buf.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + lnLen + leLen;
        const end = start + compSize;
        if (start > buf.length || end > buf.length) fail('Thành phần ZIP của file Word bị cắt cụt.');
        total += uncompSize;
        if (total > MAX_TOTAL_UNCOMPRESSED) fail('File Word giải nén quá lớn.');
        entries.set(name, { method, start, end, compSize, uncompSize });
    }
    if (requireDocx && !entries.has('word/document.xml')) fail('File không phải tài liệu Word (.docx) hợp lệ (thiếu word/document.xml).');
    const get = (name) => {
        const e = entries.get(String(name || '').replace(/^\/+/, ''));
        if (!e) return null;
        const raw = buf.subarray(e.start, e.end);
        if (e.method === 0) return Buffer.from(raw);
        if (e.method === 8) {
            try {
                const out = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1024, e.uncompSize || MAX_TOTAL_UNCOMPRESSED) });
                return out;
            } catch (_) { fail('Không giải nén được thành phần "' + name + '" của file Word.'); }
        }
        fail('File Word dùng kiểu nén không hỗ trợ (method ' + e.method + ').');
        return null;
    };
    return {
        names: [...entries.keys()],
        has: (name) => entries.has(String(name || '').replace(/^\/+/, '')),
        get,
        text: (name) => { const b = get(name); return b === null ? null : b.toString('utf8'); }
    };
}

function dosDateTime(d = new Date()) {
    const year = Math.max(1980, d.getFullYear());
    return {
        time: ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1F),
        date: (((year - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F)
    };
}

/** Ghi ZIP. entries = [{ name, data: Buffer|string, store?: boolean }] */
function writeZip(entries) {
    if (!Array.isArray(entries) || !entries.length) throw new Error('writeZip: không có file nào');
    const { time, date } = dosDateTime();
    const locals = [], centrals = [];
    let offset = 0;
    for (const e of entries) {
        const name = String(e.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (!name) continue;
        const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data == null ? '' : e.data), 'utf8');
        const crc = crc32(data);
        let method = 0, out = data;
        if (!e.store && data.length > 0) {
            const deflated = zlib.deflateRawSync(data, { level: 9 });
            if (deflated.length < data.length) { method = 8; out = deflated; }
        }
        const nameBuf = Buffer.from(name, 'utf8');
        const flags = 0x0800;              // tên file UTF-8
        const local = Buffer.alloc(30 + nameBuf.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(flags, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(out.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        nameBuf.copy(local, 30);
        locals.push(local, out);

        const central = Buffer.alloc(46 + nameBuf.length);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(flags, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(date, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(out.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);
        nameBuf.copy(central, 46);
        centrals.push(central);
        offset += local.length + out.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(centrals.length, 8);
    eocd.writeUInt16LE(centrals.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat([...locals, cd, eocd]);
}

module.exports = { readZip, writeZip, crc32 };
