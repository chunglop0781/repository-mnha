// test/word.js — Word (DOCX): chuyển HTML ⇄ DOCX, mã hoá khi lưu, công khai/riêng tư, lưu/tải theo phần
process.env.SESSION_ENC_KEY = 'k'.repeat(40);
const R = require('path').join(__dirname, '..') + '/';
const assert = require('assert');
const crypto = require('crypto');

const files = new Map(), blobs = new Map(), shas = new Map();
function shaOf(b) { return crypto.createHash('sha1').update(b).digest('hex'); }
function put(p, b) {
    const buf = Buffer.isBuffer(b) ? b : Buffer.from(String(b), 'utf8');
    files.set(p, buf); shas.set(p, shaOf(buf)); blobs.set(shaOf(buf), buf);
}
const fakeGh = {
    isConfigured: true,
    async getRepoTree() { return { files: new Map(shas), truncated: false }; },
    async createBlob(b) { const s = shaOf(b); blobs.set(s, b); return s; },
    async getBlobBuffer(s) { return blobs.get(s) || null; },
    async writeBinaryFile(p, b) { put(p, b); },
    async writeBinaryFileBig(p, b) { put(p, b); },
    async readBinaryFile(p) { return files.get(p) || null; },
    async readBinaryFileLarge(p) { return files.get(p) || null; },
    async readJsonFile(p) { const b = files.get(p); return b ? JSON.parse(b.toString('utf8')) : null; },
    async writeJsonFile(p, o) { put(p, Buffer.from(JSON.stringify(o), 'utf8')); },
    async deleteFile(p) { files.delete(p); shas.delete(p); },
    async commitFiles(changes) {
        for (const c of changes) {
            if (c.remove) { files.delete(c.path); shas.delete(c.path); }
            else if (c.content) put(c.path, c.content);
            else if (c.sha) { files.set(c.path, blobs.get(c.sha)); shas.set(c.path, c.sha); }
        }
    }
};
const gp = require.resolve(R + 'services/githubService.js');
require.cache[gp] = { id: gp, filename: gp, loaded: true, exports: fakeGh };

const { htmlToDocx } = require(R + 'services/word/htmlToDocx');
const { convertDocx } = require(R + 'services/word/docxToHtml');
const { readZip } = require(R + 'services/word/zip');
const { sanitizeHtml } = require(R + 'services/word/htmlSanitize');
const store = require(R + 'services/word/wordStore');
const codeStore = require(R + 'services/code/codeStore');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lZq6WQAAAABJRU5ErkJggg==';
const SAMPLE = '<h1>Báo cáo tháng 10</h1>' +
    '<p style="text-align:center"><strong>Đậm</strong> <em>nghiêng</em> <u>gạch chân</u> <s>xóa</s></p>' +
    '<p>Màu <span style="color:#c00000;background-color:#fff59d">đỏ</span> và <span style="font-family:\'Courier New\';font-size:19px">Courier</span>.</p>' +
    '<p style="margin-left:36px">Thụt lề</p>' +
    '<ul><li>Mục một</li><li>Mục hai</li></ul><ol><li>Bước 1</li><li>Bước 2</li></ol>' +
    '<table><tbody><tr><td colspan="2"><strong>Gộp cột</strong></td></tr><tr><td>B</td><td>C</td></tr></tbody></table>' +
    '<p><img src="data:image/png;base64,' + PNG + '" alt="cham" style="width:80px;height:80px"></p>' +
    '<p><a href="https://example.com">Liên kết</a></p><hr class="word-pagebreak"><p>Trang sau</p>' +
    '<blockquote>Trích dẫn</blockquote>';

(async () => {
    // ---- HTML → DOCX
    const docx = htmlToDocx(SAMPLE, { title: 'Báo cáo', page: { widthPx: 794, heightPx: 1123, marginsPx: { top: 96, right: 96, bottom: 96, left: 96 } } });
    assert(Buffer.isBuffer(docx) && docx.length > 500, 'docx phải là buffer');
    assert.strictEqual(docx.subarray(0, 2).toString('latin1'), 'PK', 'docx phải là ZIP');
    const zip = readZip(docx);
    for (const n of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels']) {
        assert(zip.has(n), 'thiếu ' + n);
    }
    assert(/Báo cáo tháng 10/.test(zip.text('word/document.xml')), 'document.xml phải có nội dung');
    assert(zip.names.some((n) => /^word\/media\/image1\./.test(n)), 'phải có ảnh nhúng');

    // ---- DOCX → HTML
    const back = convertDocx(docx);
    assert(/Báo cáo tháng 10/.test(back.html), 'phải giữ tiêu đề');
    assert(/<strong>(?:<span[^>]*>)?Đậm/.test(back.html), 'phải giữ đậm');
    assert(/<em>(?:<span[^>]*>)?nghiêng/.test(back.html), 'phải giữ nghiêng');
    assert(/Courier/.test(back.html), 'phải giữ phông');
    assert(/<table/.test(back.html) && /colspan="2"/.test(back.html), 'phải giữ bảng + gộp cột');
    assert(/<img [^>]*src="data:image\/png;base64,/.test(back.html), 'phải giữ ảnh dạng data URI');
    assert(/<ul>/.test(back.html) && /<ol>/.test(back.html), 'phải giữ danh sách');
    assert(/word-pagebreak/.test(back.html), 'phải giữ ngắt trang');
    assert.strictEqual(back.page.size, 'A4');
    assert.strictEqual(back.page.margin, 'normal');
    const clean = sanitizeHtml(back.html);
    assert(/Báo cáo tháng 10/.test(clean) && !/<script/i.test(clean), 'HTML phải sạch');

    // ---- lưu mã hoá
    const created = await store.createDoc('u1', '', 'Bao cao.docx', { html: SAMPLE });
    assert.strictEqual(created.name, 'Bao cao.docx');
    assert(files.has('u1/file-word/Bao cao.docx'), 'phải lưu trong file-word/');
    const rawDoc = files.get('u1/file-word/Bao cao.docx');
    assert.strictEqual(rawDoc.subarray(0, 8).toString('latin1'), 'MNHAENC1', 'file phải được mã hoá');
    assert(!rawDoc.includes(Buffer.from('Báo cáo tháng 10')), 'không được có HTML rõ trong file');
    const manifestRaw = files.get('u1/file-word/mnha-word.json').toString('utf8');
    assert(!/Báo cáo tháng 10/.test(manifestRaw), 'manifest không chứa nội dung');
    assert(/public/.test(manifestRaw), 'manifest có trạng thái công khai');
    const IMG_PATH = 'u1/file-word/Bao cao/anh-001-cham.png';
    assert(files.has(IMG_PATH), 'ảnh phải được tách ra file riêng cạnh tài liệu');
    const rawImg = files.get(IMG_PATH);
    assert.strictEqual(rawImg.subarray(0, 8).toString('latin1'), 'MNHAENC1', 'ảnh cũng phải được mã hoá');
    assert(!rawImg.includes(Buffer.from(PNG, 'base64')), 'không được có ảnh rõ trong file');
    const mf = JSON.parse(manifestRaw);
    assert.strictEqual(mf.docs['Bao cao.docx'].images['anh-001-cham.png'], crypto.createHash('sha256').update(Buffer.from(PNG, 'base64')).digest('hex'), 'manifest ghi hash ảnh');
    assert(!/data:image/.test(manifestRaw), 'manifest không chứa nội dung ảnh');

    const read = await store.readDoc('u1', '', 'Bao cao.docx');
    assert(/Báo cáo tháng 10/.test(read.html), 'đọc lại đúng HTML');
    assert.strictEqual(read.meta.title, 'Bao cao');
    assert(/src="anh-001-cham\.png"/.test(read.html) && !/data:image/.test(read.html), 'HTML chỉ tham chiếu tên ảnh, không nhúng data URI');

    // ---- đọc ảnh đã tách (giải mã) + URL hiển thị
    const gotImg = await store.readImage('u1', '', 'Bao cao.docx', 'anh-001-cham.png');
    assert(gotImg && gotImg.mime === 'image/png' && gotImg.buffer.equals(Buffer.from(PNG, 'base64')), 'đọc lại đúng ảnh');
    assert.strictEqual(await store.readImage('u1', '', 'Bao cao.docx', 'anh-999-khong-co.png'), null, 'ảnh thiếu → null');
    await assert.rejects(store.readImage('u1', '', 'Bao cao.docx', '../x.png'), /không hợp lệ/i);
    const ownerHtml = store.inlineMediaUrls(read.html, 'u1', '', 'Bao cao.docx');
    assert(ownerHtml.includes('/code/word/media?') && ownerHtml.includes('n=anh-001-cham.png'), 'HTML cho chủ dùng URL media');
    const publicHtml = store.publicMediaUrls(read.html, 'u1', '', 'Bao cao.docx');
    assert(publicHtml.includes('/w/media?u=u1') && publicHtml.includes('n=anh-001-cham.png'), 'HTML công khai dùng URL /w/media');
    const inlined = await store.inlineImageData('u1', '', 'Bao cao.docx', read.html);
    assert(inlined.includes('data:image/png;base64,' + PNG), 'xuất .docx phải nhúng lại ảnh');
    const dlImg = await store.toDocx('u1', '', 'Bao cao.docx');
    assert(readZip(dlImg.buffer).names.some((n) => /^word\/media\/image1\./.test(n)), 'tải .docx vẫn có ảnh');

    // ---- danh sách ẩn manifest
    const listed = await store.list('u1', '');
    assert.strictEqual(listed.docs.length, 1);
    assert.strictEqual(listed.docs[0].name, 'Bao cao.docx');
    assert(!listed.docs.some((d) => d.name === 'mnha-word.json'));
    const generic = await codeStore.list('u1', 'word', '');
    assert(!generic.files.includes('mnha-word.json'), 'codeStore.list phải ẩn manifest');
    const listWithImg = await store.list('u1', '');
    assert(!listWithImg.folders.includes('Bao cao'), 'phải ẩn thư mục ảnh của tài liệu');

    // ---- công khai / riêng tư
    assert.strictEqual(await store.getPublic('u1', '', 'Bao cao.docx'), null, 'mặc định riêng tư');
    await store.setPublic('u1', '', 'Bao cao.docx', true);
    const pub = await store.getPublic('u1', '', 'Bao cao.docx');
    assert(pub && /Báo cáo tháng 10/.test(pub.html), 'công khai phải đọc được');
    // lưu tiếp không được tự tắt công khai
    await store.saveHtml('u1', '', 'Bao cao.docx', '<p>Bản mới</p>', { page: { size: 'Letter', orientation: 'landscape', margin: 'narrow' } });
    const pub2 = await store.getPublic('u1', '', 'Bao cao.docx');
    assert(pub2 && /Bản mới/.test(pub2.html) && pub2.meta.public === true, 'giữ trạng thái công khai khi lưu');
    assert.strictEqual(pub2.meta.page.size, 'Letter');
    assert.strictEqual(pub2.meta.page.orientation, 'landscape');
    await store.setPublic('u1', '', 'Bao cao.docx', false);
    assert.strictEqual(await store.getPublic('u1', '', 'Bao cao.docx'), null, 'tắt công khai phải chặn');

    // ---- tải .docx
    const dl = await store.toDocx('u1', '', 'Bao cao.docx');
    assert(dl && dl.buffer.subarray(0, 2).toString('latin1') === 'PK', 'tải về phải là .docx thật');
    assert(/Bản mới/.test(convertDocx(dl.buffer).html));

    // ---- tách ảnh: dùng lại ảnh cùng nội dung, xoá ảnh không còn dùng, đổi tên/xoá đi kèm
    await store.createDoc('u1', '', 'Anh.docx', { html: SAMPLE });
    const imgKeys = () => [...files.keys()].filter((p) => p.startsWith('u1/file-word/Anh/'));
    assert.strictEqual(imgKeys().length, 1, 'ảnh đầu tiên được tách');
    await store.saveHtml('u1', '', 'Anh.docx', SAMPLE);                     // y hệt → phải dùng lại
    assert.strictEqual(imgKeys().length, 1, 'không nhân đôi ảnh khi lưu lại cùng nội dung');
    const anhRead = await store.readDoc('u1', '', 'Anh.docx');
    assert(/anh-001-cham\.png/.test(anhRead.html), 'lưu lại vẫn giữ ảnh');
    await store.saveHtml('u1', '', 'Anh.docx', '<p>Không còn ảnh</p>');
    assert.strictEqual(imgKeys().length, 0, 'ảnh không dùng nữa phải bị xoá');
    const anhManifest = await store.readManifest('u1', '');
    assert.deepStrictEqual(anhManifest.docs['Anh.docx'].images, {}, 'manifest bỏ ảnh đã xoá');

    await store.saveHtml('u1', '', 'Anh.docx', SAMPLE);
    // trình soạn gửi lại HTML có URL /code/word/media (không phải tên file) → vẫn phải giữ ảnh
    const editorHtml = store.inlineMediaUrls((await store.readDoc('u1', '', 'Anh.docx')).html, 'u1', '', 'Anh.docx');
    await store.saveHtml('u1', '', 'Anh.docx', editorHtml);
    assert.strictEqual(imgKeys().length, 1, 'không tạo thêm ảnh khi lưu từ trình soạn');
    assert(/anh-001-cham\.png/.test((await store.readDoc('u1', '', 'Anh.docx')).html), 'lưu từ trình soạn không mất ảnh');
    // trình duyệt có thể gửi src thành URL tuyệt đối (http://host/code/word/media?...)
    await store.saveHtml('u1', '', 'Anh.docx', editorHtml.replace('src="/code/word/media', 'src="https://example.test/code/word/media'));
    assert(/anh-001-cham\.png/.test((await store.readDoc('u1', '', 'Anh.docx')).html), 'nhận cả URL media tuyệt đối');
    await store.renameDoc('u1', '', 'Anh.docx', 'Anh moi.docx');
    assert(files.has('u1/file-word/Anh moi.docx') && !files.has('u1/file-word/Anh.docx'), 'đổi tên tài liệu');
    assert(files.has('u1/file-word/Anh moi/anh-001-cham.png') && !files.has('u1/file-word/Anh/anh-001-cham.png'), 'đổi tên phải di chuyển thư mục ảnh');
    const movedImg = await store.readImage('u1', '', 'Anh moi.docx', 'anh-001-cham.png');
    assert(movedImg && movedImg.buffer.equals(Buffer.from(PNG, 'base64')), 'ảnh đi theo tên mới, vẫn giải mã được');
    await store.removeDoc('u1', '', 'Anh moi.docx');
    assert(![...files.keys()].some((p) => p.startsWith('u1/file-word/Anh moi/')), 'xoá tài liệu phải xoá cả thư mục ảnh');

    // ---- lưu theo phần (mỗi phần được mã hoá trước khi lên GitHub)
    const bigHtml = '<p>ĐẦU</p>' + ('<p>Xin chào 😀 ' + 'é'.repeat(80) + '</p>').repeat(18000) + '<p>CUỐI</p>';
    const cutAt = Math.floor(bigHtml.length / 2);
    const pieces = [bigHtml.slice(0, cutAt), bigHtml.slice(cutAt)];
    const id = 'b'.repeat(32), parts = [];
    for (let i = 0; i < pieces.length; i++) {
        const r = await store.putPart('u1', 'html', { dir: '', file: 'Lon.docx', uploadId: id, i, n: pieces.length }, Buffer.from(pieces[i]));
        parts.push({ i, sha: r.sha, size: r.size, receipt: r.receipt });
        const blob = blobs.get(r.sha).toString('latin1');
        assert(blob.indexOf('Xin chào') < 0 && blob.indexOf('MNHAENC1') < 0, 'blob phải là bản mã hoá, không lộ HTML');
    }
    await assert.rejects(store.finishSave('u1', { dir: '', file: 'Lon.docx', uploadId: id, parts: [{ ...parts[0], receipt: 'x'.repeat(40) }, parts[1]] }), /Biên nhận/);
    const saved = await store.finishSave('u1', { dir: '', file: 'Lon.docx', uploadId: id, parts, page: { size: 'A4', orientation: 'portrait', margin: 'normal' } });
    assert(saved.ok && saved.size > 100000, 'lưu theo phần phải thành công');
    const bigRead = await store.readDoc('u1', '', 'Lon.docx');
    assert(bigRead.html.indexOf('ĐẦU') >= 0 && bigRead.html.indexOf('CUỐI') >= 0, 'ghép đúng nội dung lớn');

    // ---- tải .docx lên theo phần → tự chuyển HTML
    const upDocx = htmlToDocx('<h1>Tài liệu tải lên</h1><p>Nội dung <strong>đậm</strong></p><ul><li>A</li></ul>' +
        '<p><img src="data:image/png;base64,' + PNG + '" alt="logo"></p>', { title: 'Tải lên' });
    const upParts = [], upId = 'c'.repeat(32), half = Math.ceil(upDocx.length / 2);
    const chunks = [upDocx.subarray(0, half), upDocx.subarray(half)];
    for (let i = 0; i < chunks.length; i++) {
        const r = await store.putPart('u1', 'docx', { dir: '', file: 'Tai len.docx', uploadId: upId, i, n: chunks.length }, chunks[i]);
        upParts.push({ i, sha: r.sha, size: r.size, receipt: r.receipt });
        assert(blobs.get(r.sha).indexOf(Buffer.from('word/document.xml')) < 0, 'blob .docx phải được mã hoá');
    }
    const up = await store.finishDocx('u1', { dir: '', file: 'Tai len.docx', uploadId: upId, parts: upParts });
    assert(up.ok && up.converted, 'phải chuyển .docx → HTML');
    const upRead = await store.readDoc('u1', '', 'Tai len.docx');
    assert(/Tài liệu tải lên/.test(upRead.html) && /<strong>(?:<span[^>]*>)?đậm/.test(upRead.html) && /<li>(?:<p[^>]*>|<span[^>]*>)*A/.test(upRead.html), 'chuyển đúng nội dung');
    assert.strictEqual(upRead.meta.title, 'Tải lên');
    assert(files.has('u1/file-word/Tai len/anh-001-logo.png'), 'tải .docx lên cũng tách ảnh ra file riêng');
    assert(/anh-001-logo\.png/.test(upRead.html), 'mô tả ảnh trong .docx thành tên file');

    // ---- đổi tên / xoá / chặn .doc
    await store.setPublic('u1', '', 'Tai len.docx', true);
    await store.renameDoc('u1', '', 'Tai len.docx', 'Da doi ten.docx');
    assert(files.has('u1/file-word/Da doi ten.docx') && !files.has('u1/file-word/Tai len.docx'), 'đổi tên file + manifest');
    assert(files.has('u1/file-word/Da doi ten/anh-001-logo.png') && !files.has('u1/file-word/Tai len/anh-001-logo.png'), 'đổi tên kéo theo thư mục ảnh');
    assert((await store.getPublic('u1', '', 'Da doi ten.docx')) !== null, 'giữ công khai sau đổi tên');
    await store.removeDoc('u1', '', 'Da doi ten.docx');
    assert(!files.has('u1/file-word/Da doi ten.docx'), 'xoá file');
    assert(![...files.keys()].some((p) => p.startsWith('u1/file-word/Da doi ten/')), 'xoá cả ảnh của tài liệu');
    assert.throws(() => store.docName('cu.doc'), /Chỉ nhận tài liệu \.docx/);
    assert.throws(() => store.docName('mnha-word.json'), /dành riêng/);
    await assert.rejects(store.createDoc('u1', '', 'a.exe', '<p>x</p>'));
    await assert.rejects(store.createDoc('u1', '', 'Bao cao.docx', { html: '<p>ghi đè</p>' }), /Đã có tài liệu/, 'tạo mới không được ghi đè');

    // ---- .docx thật từ Word/python-docx: danh sách theo STYLE + ngắt trang không lồng trong <p><span>
    try {
        const real = require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'real-style-list.docx'));
        const rh = convertDocx(real).html;
        assert(/<ul><li>/.test(rh) && /<ol><li>/.test(rh), 'danh sách kiểu List Bullet/List Number phải thành <ul>/<ol>');
        assert(!/<(?:p|span)[^>]*>(?:<span[^>]*>)?<hr/.test(rh), 'ngắt trang không được nằm trong <p>/<span>');
    } catch (e) { if (e.code !== 'ENOENT') throw e; }

    console.log('OK word');
})().catch((e) => { console.error('✘', e); process.exit(1); });
