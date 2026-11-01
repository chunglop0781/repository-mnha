// services/code/includeResolver.js — gom các file mà code C++ cần ở CÙNG THƯ MỤC (hoặc thư mục con) khi chạy:
//   • #include "x.hpp" / "sub/x.h" / "x.cpp"  → file mã nguồn (src), tìm đệ quy trong cả các header được include
//   • x.hpp có x.cpp cùng tên (kiểu "khai báo ở .hpp, cài đặt ở .cpp") → biên dịch cùng (unit) — trừ khi x.cpp có hàm main
// Dùng cho cả code CỦA TÔI (đọc từ thư mục trên GitHub của người dùng) lẫn code XEM TRÊN MẠNG (đọc từ cùng thư mục
// trong repo GitHub/GitLab) — chỉ khác hàm readFile(segs) được truyền vào.
'use strict';

const HEADER_EXT = ['h', 'hpp', 'hh', 'hxx', 'inl', 'ipp', 'tpp'];
const SRC_EXT = [...HEADER_EXT, 'cpp'];
const SEG = /^[A-Za-z0-9_\-]{1,60}$/;
const LIM = { FILES: 30, UNITS: 8, DEPTH: 4, BYTES: 400 * 1024, PATH_DEPTH: 4 };
const INCLUDE_RE = /^[ \t]*#[ \t]*include[ \t]*"([^"\r\n]+)"/gm;

function scanIncludes(code) {
    const out = [];
    for (const m of String(code).matchAll(INCLUDE_RE)) out.push(m[1].trim());
    return out;
}

/** "sub/x.hpp" tính từ thư mục baseDir (mảng) → mảng đoạn đường dẫn hợp lệ, hoặc null (ra ngoài thư mục gốc / tên lạ / sai đuôi). */
function resolveInclude(baseDir, inc) {
    const out = baseDir.slice();
    for (const p of String(inc).replace(/\\/g, '/').split('/')) {
        if (!p || p === '.') continue;
        if (p === '..') { if (!out.length) return null; out.pop(); continue; }
        out.push(p);
    }
    if (!out.length || out.length > LIM.PATH_DEPTH + 1) return null;
    const m = /^(.+)\.([A-Za-z0-9]+)$/.exec(out[out.length - 1]);
    if (!m || !SRC_EXT.includes(m[2].toLowerCase()) || !SEG.test(m[1])) return null;
    if (!out.slice(0, -1).every((s) => SEG.test(s))) return null;
    return out;
}

const extOf = (segs) => segs[segs.length - 1].split('.').pop().toLowerCase();
const hasMain = (code) => /\bmain\s*\(/.test(String(code));

/**
 * @param {{code:string, readFile:(segs:string[])=>Promise<string|null>}} opt
 *   readFile nhận đường dẫn TƯƠNG ĐỐI so với thư mục của file đang chạy (vd ['DanhSachPhuongTien.hpp']);
 *   trả nội dung hoặc null nếu không có.
 * @returns {{files:{name:string,content:string,src:true,unit?:true}[], missing:string[]}}
 */
async function collect({ code, readFile }) {
    const files = []; const missing = []; const seen = new Set();
    let bytes = 0, units = 0;
    const queue = [{ code, dir: [], depth: 0 }];

    const fetchOne = async (segs) => { try { return await readFile(segs); } catch (_) { return null; } };
    const add = (segs, content, unit) => {
        const f = { name: segs.join('/'), content, src: true };
        if (unit) { f.unit = true; units++; }
        files.push(f); bytes += content.length;
    };

    while (queue.length) {
        const cur = queue.shift();
        for (const inc of scanIncludes(cur.code)) {
            const segs = resolveInclude(cur.dir, inc);
            if (!segs) continue;
            const key = segs.join('/');
            if (seen.has(key)) continue;
            if (files.length >= LIM.FILES || bytes > LIM.BYTES) return { files, missing };
            seen.add(key);
            const content = await fetchOne(segs);
            if (content == null) { missing.push(key); continue; }
            add(segs, content, false);
            if (cur.depth + 1 < LIM.DEPTH) queue.push({ code: content, dir: segs.slice(0, -1), depth: cur.depth + 1 });

            // x.hpp ⇒ thử x.cpp cùng thư mục (phần cài đặt) để biên dịch cùng
            if (HEADER_EXT.includes(extOf(segs)) && units < LIM.UNITS) {
                const comp = [...segs.slice(0, -1), segs[segs.length - 1].replace(/\.[^.]+$/, '.cpp')];
                const ck = comp.join('/');
                if (!seen.has(ck) && files.length < LIM.FILES) {
                    seen.add(ck);
                    const c2 = await fetchOne(comp);
                    if (c2 != null && !hasMain(c2)) {
                        add(comp, c2, true);
                        if (cur.depth + 1 < LIM.DEPTH) queue.push({ code: c2, dir: comp.slice(0, -1), depth: cur.depth + 1 });
                    }
                }
            }
        }
    }
    return { files, missing };
}

/** Tên file dữ liệu (.txt, hoặc .cpp dùng làm dữ liệu) được nhắc trong chuỗi "..." của code — KHÔNG tính file được #include. */
function scanDataNames(code, includeKeys = new Set()) {
    const txt = new Set(), cpp = new Set();
    for (const m of String(code).matchAll(/"([A-Za-z0-9_\-]{1,60})\.(txt|cpp)"/gi)) {
        const full = m[1] + '.' + m[2];
        if (includeKeys.has(full)) continue;
        (m[2].toLowerCase() === 'txt' ? txt : cpp).add(full);
    }
    return { txt: [...txt], cpp: [...cpp] };
}
/** Các tên được #include "..." (chỉ phần tên file, để loại khỏi nhóm "file dữ liệu"). */
const includedNames = (code) => new Set(scanIncludes(code).map((i) => i.replace(/\\/g, '/').split('/').pop()));

module.exports = { collect, scanIncludes, resolveInclude, scanDataNames, includedNames, HEADER_EXT, SRC_EXT, LIM };
