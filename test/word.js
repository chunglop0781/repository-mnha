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

    // ---- công thức Word (OMML) + hộp văn bản: trước đây bị dẹt thành "R4", "x1" và mất hẳn nội dung hộp văn bản
    {
        const { htmlToDocx } = require('../services/word/htmlToDocx');
        const { sanitizeHtml } = require('../services/word/htmlSanitize');
        const buf = require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'math-textbox.docx'));
        const c = convertDocx(buf), h = sanitizeHtml(c.html);
        const count = (x, t) => (x.match(new RegExp('<' + t + '[ >]', 'g')) || []).length;
        assert(count(h, 'math') > 200 && count(h, 'msub') > 300 && count(h, 'mfrac') === 21 && count(h, 'mtable') === 5 && count(h, 'mover') === 9, 'giữ công thức: chỉ số, phân số, ma trận, vector');
        assert(/<msup><mrow><mi[^>]*>R<\/mi><\/mrow><mrow><mn>4<\/mn><\/mrow><\/msup>/.test(h), 'R^4 là chỉ số trên thật, không phải chữ "R4"');
        assert((h.match(/class="word-textbox"/g) || []).length === 19, 'giữ đủ 19 hộp văn bản (mc:Choice, không nhân đôi bằng Fallback)');
        const back = htmlToDocx(h, { title: c.title, page: c.page });
        const zip = readZip(back), xml = zip.text('word/document.xml');
        assert(/xmlns:m="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/math"/.test(xml), 'khai báo namespace m:');
        assert((xml.match(/<m:oMath>/g) || []).length === count(h, 'math'), 'mỗi <math> → một m:oMath');
        assert(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml), 'không có ký tự điều khiển cấm trong XML');
        // thứ tự phần tử trong w:rPr / w:pPr theo schema (Word kén thứ tự, sai là báo "file bị lỗi")
        const RPR = ['rFonts', 'b', 'bCs', 'i', 'iCs', 'strike', 'color', 'sz', 'szCs', 'u', 'shd', 'vertAlign'];
        const PPR = ['pStyle', 'keepNext', 'numPr', 'pBdr', 'shd', 'ind', 'jc'];
        const inOrder = (names, order) => names.every((n, i) => i === 0 || order.indexOf(n) >= order.indexOf(names[i - 1]));
        for (const m of xml.matchAll(/<w:rPr>(.*?)<\/w:rPr>/g)) assert(inOrder([...m[1].matchAll(/<w:(\w+)[ /]/g)].map((x) => x[1]), RPR), 'thứ tự w:rPr: ' + m[1].slice(0, 120));
        for (const m of xml.matchAll(/<w:pPr>(.*?)<\/w:pPr>/g)) assert(inOrder([...m[1].replace(/<w:numPr>.*?<\/w:numPr>|<w:pBdr>.*?<\/w:pBdr>/g, (t) => '<w:' + t.slice(3, t.indexOf('>')) + '/>').matchAll(/<w:(\w+)[ /]/g)].map((x) => x[1]), PPR), 'thứ tự w:pPr: ' + m[1].slice(0, 160));
        // đi vòng docx → html → docx → html: công thức giữ nguyên cấu trúc, chữ không mất
        const again = convertDocx(back).html;
        const norm = (x) => x.replace(/<[^>]+>/g, '').replace(/[\s\u00a0]+/g, '');
        for (const t of ['math', 'msub', 'msup', 'msubsup', 'mfrac', 'mtable', 'mover']) assert.strictEqual(count(again, t), count(h, t), 'đi vòng vẫn đủ <' + t + '>');
        assert.strictEqual(norm(again), norm(h), 'đi vòng không mất chữ nào (kể cả nội dung hộp văn bản)');
        // MathML vào từ trình soạn không được mang script/onclick
        assert(!/onclick|<script/i.test(sanitizeHtml('<p><math onclick="x()"><mi>x</mi><script>1</script></math></p>')), 'sanitize MathML');
    }

    // ---- tách HTML theo trang/khối: ghép lại phải ĐÚNG NGUYÊN VĂN (không mất byte nào)
    {
        const big = '<p>ĐẦU 😀</p>' + Array.from({ length: 4000 }, (_, i) => '<p>Dòng ' + i + ' ' + 'nội dung '.repeat(20) + '</p>').join('') + '<p>CUỐI</p>';
        const chunks = store.splitHtmlChunks(big, 64 * 1024);
        assert(chunks.length > 1, 'phải cắt thành nhiều khúc');
        assert.strictEqual(chunks.join(''), big, 'ghép các khúc phải khớp nguyên văn');
        assert.strictEqual([...store.iterHtmlChunks(big, 64 * 1024)].join(''), big, 'generator cũng ghép đúng');
        assert.strictEqual(store.groupHtmlChunks(chunks, 128 * 1024).join(''), big, 'gom khúc không làm mất nội dung');

        // ưu tiên cắt ngay sau <hr class="word-pagebreak">
        const pb = '<p>' + 'a'.repeat(60000) + '</p><hr class="word-pagebreak"><p>' + 'b'.repeat(90000) + '</p>';
        const pcs = store.splitHtmlChunks(pb, 96 * 1024);
        assert(pcs.length >= 2 && /word-pagebreak/.test(pcs[0]), 'cắt ưu tiên sau ngắt trang');
        assert.strictEqual(pcs.join(''), pb);

        // văn bản thuần rất dài: không cắt đôi cặp surrogate (emoji)
        const emo = '😀'.repeat(40000);
        const ec = store.splitHtmlChunks(emo, 64 * 1024);
        assert.strictEqual(ec.join(''), emo, 'ghép đúng văn bản thuần');
        ec.forEach((c) => assert(!/[\uD800-\uDBFF]$/.test(c), 'không cắt đôi surrogate'));
    }

    // ---- mã hoá TỪNG TRANG cho tài liệu lớn + dùng lại/xoá trang/đổi tên
    {
        const LANG = require(R + 'config/codeConfig').LANGS.word;
        const mc = require(R + 'services/code/mediaCrypto');
        const oldStore = LANG.pageStoreBytes, oldChunk = LANG.pageChunkBytes;
        LANG.pageStoreBytes = 128 * 1024;
        LANG.pageChunkBytes = 64 * 1024;
        try {
            const many = Array.from({ length: 1600 }, (_, i) => '<p>TRANG ' + i + ' ' + 'nội dung '.repeat(12) + '</p>').join('');
            const expected = sanitizeHtml(many);
            const createdPage = await store.createDoc('u1', 'thu-muc-lon', 'Lon trang.docx', { html: many });
            assert(createdPage.pages > 1, 'tài liệu lớn phải lưu nhiều trang');
            const docPath = 'u1/file-word/thu-muc-lon/Lon trang.docx';
            const pageFolder = 'u1/file-word/thu-muc-lon/Lon trang/';
            const pageFiles = [...files.keys()].filter((p) => p.startsWith(pageFolder) && /^trang-[a-f0-9]{16,64}\.mnha$/i.test(p.slice(pageFolder.length)));
            assert(pageFiles.length > 1, 'mỗi trang là một file .mnha');
            assert.strictEqual(files.get(docPath).subarray(0, 8).toString('latin1'), 'MNHAENC1', 'chỉ mục trang phải mã hoá');
            const idxPlain = mc.decryptBuffer(files.get(docPath)).toString('utf8');
            assert(idxPlain.startsWith('MNHAPAGE1'), 'file .docx nhỏ chỉ còn chỉ mục trang');
            assert(!idxPlain.includes('TRANG 1') && !files.get(docPath).includes(Buffer.from('TRANG 1')), 'chỉ mục không chứa nội dung rõ');
            for (const p of pageFiles) {
                const raw = files.get(p);
                assert.strictEqual(raw.subarray(0, 8).toString('latin1'), 'MNHAENC1', 'trang phải mã hoá');
                assert(!raw.includes(Buffer.from('TRANG 1')) && !raw.includes(Buffer.from('nội dung')), 'không lộ nội dung trang');
            }
            const pagedRead = await store.readDoc('u1', 'thu-muc-lon', 'Lon trang.docx');
            assert(pagedRead.paged === true && pagedRead.html === expected, 'ghép đúng HTML từ các trang đã giải mã');
            const pagesOnly = await store.readDoc('u1', 'thu-muc-lon', 'Lon trang.docx', { pagesOnly: true });
            assert(Array.isArray(pagesOnly.pages) && pagesOnly.pages.length === pageFiles.length, 'đọc được danh sách trang');
            assert.strictEqual(pagesOnly.pages.join(''), expected, 'các trang ghép đúng nguyên văn');
            const m1 = await store.readManifest('u1', 'thu-muc-lon');
            assert.strictEqual(m1.docs['Lon trang.docx'].pageCount, pageFiles.length, 'manifest ghi số trang');
            assert(!/TRANG 1|nội dung/.test(files.get('u1/file-word/thu-muc-lon/mnha-word.json').toString('utf8')), 'manifest không chứa nội dung');

            // lưu y hệt → tên trang là hash nội dung nên dùng lại, không ghi thêm
            const before = pageFiles.length;
            await store.saveHtml('u1', 'thu-muc-lon', 'Lon trang.docx', many);
            assert.strictEqual([...files.keys()].filter((p) => p.startsWith(pageFolder)).length, before, 'không ghi lại trang không đổi');

            // nhỏ lại → quay về 1 file HTML mã hoá và xoá hết trang rời
            await store.saveHtml('u1', 'thu-muc-lon', 'Lon trang.docx', '<p>Nhỏ lại</p>');
            assert.strictEqual([...files.keys()].filter((p) => p.startsWith(pageFolder)).length, 0, 'xoá trang khi tài liệu nhỏ lại');
            assert.strictEqual(mc.decryptBuffer(files.get(docPath)).toString('utf8'), '<p>Nhỏ lại</p>', 'file nhỏ lưu HTML trực tiếp');
            assert.strictEqual((await store.readManifest('u1', 'thu-muc-lon')).docs['Lon trang.docx'].pageCount, 0, 'manifest bỏ số trang');

            // lớn lại → đổi tên: toàn bộ trang đi theo thư mục mới
            await store.saveHtml('u1', 'thu-muc-lon', 'Lon trang.docx', many);
            const again = [...files.keys()].filter((p) => p.startsWith(pageFolder));
            assert(again.length > 1, 'lưu lại thành nhiều trang');
            await store.renameDoc('u1', 'thu-muc-lon', 'Lon trang.docx', 'Lon moi.docx');
            const newFolder = 'u1/file-word/thu-muc-lon/Lon moi/';
            assert(files.has('u1/file-word/thu-muc-lon/Lon moi.docx') && !files.has(docPath), 'đổi tên file tài liệu');
            assert.strictEqual([...files.keys()].filter((p) => p.startsWith(newFolder)).length, again.length, 'đổi tên chuyển cả trang');
            assert.strictEqual([...files.keys()].filter((p) => p.startsWith(pageFolder)).length, 0, 'không còn trang ở tên cũ');
            assert.strictEqual((await store.readDoc('u1', 'thu-muc-lon', 'Lon moi.docx')).html, expected, 'đọc đúng sau đổi tên');
            await store.removeDoc('u1', 'thu-muc-lon', 'Lon moi.docx');
            assert(![...files.keys()].some((p) => p.startsWith(newFolder)), 'xoá tài liệu phải xoá cả trang');
        } finally {
            LANG.pageStoreBytes = oldStore;
            LANG.pageChunkBytes = oldChunk;
        }
    }

    // ---- tài liệu quá lớn khi tải về: tách thành ten-1.docx, ten-2.docx… trong ZIP, KHÔNG giảm chất lượng
    {
        const LANG = require(R + 'config/codeConfig').LANGS.word;
        const oldPart = LANG.docxPartBytes, oldStore = LANG.pageStoreBytes;
        LANG.docxPartBytes = 192 * 1024;
        LANG.pageStoreBytes = 80 * 1024 * 1024;
        try {
            const many = Array.from({ length: 3500 }, (_, i) => '<p>Đoạn ' + i + ': ' + 'nội dung minh hoạ '.repeat(10) + '</p>').join('');
            await store.createDoc('u1', '', 'Nhieu phan.docx', { html: many });
            const out = await store.toDocxParts('u1', '', 'Nhieu phan.docx');
            assert(out && out.multi && out.parts.length >= 2, 'phải tách thành nhiều .docx');
            assert.strictEqual(out.zipName, 'Nhieu phan.zip');
            out.parts.forEach((p, i) => {
                assert.strictEqual(p.name, 'Nhieu phan-' + (i + 1) + '.docx', 'tên phần đánh số');
                assert.strictEqual(p.buffer.subarray(0, 2).toString('latin1'), 'PK', 'mỗi phần là .docx thật');
                assert(readZip(p.buffer).has('word/document.xml'), 'mỗi phần có document.xml');
            });
            const zipped = await store.toDocx('u1', '', 'Nhieu phan.docx');
            assert(zipped.multi && zipped.buffer.subarray(0, 2).toString('latin1') === 'PK', 'tải về là ZIP');
            const zr = readZip(zipped.buffer, { requireDocx: false });
            assert.strictEqual(zr.names.length, out.parts.length, 'ZIP chứa đủ các phần');
            assert(zr.names.every((n) => /^Nhieu phan-\d+\.docx$/.test(n)), 'tên trong ZIP đúng quy ước');
            await store.removeDoc('u1', '', 'Nhieu phan.docx');
            const one = await store.toDocx('u1', '', 'Bao cao.docx');
            assert(one && !one.multi && one.buffer.subarray(0, 2).toString('latin1') === 'PK', 'tài liệu nhỏ vẫn tải .docx trực tiếp');
        } finally {
            LANG.docxPartBytes = oldPart;
            LANG.pageStoreBytes = oldStore;
        }
    }

    // ---- bảng khổng lồ bị cắt giữa chừng: các phần .docx sau KHÔNG được mất dòng (balanceParts)
    {
        const LANG = require(R + 'config/codeConfig').LANGS.word;
        const oldPart = LANG.docxPartBytes, oldStore = LANG.pageStoreBytes;
        LANG.docxPartBytes = 192 * 1024;
        LANG.pageStoreBytes = 80 * 1024 * 1024;
        try {
            const rows = Array.from({ length: 6000 }, (_, i) => '<tr><td>Ô ' + i + '</td><td>' + 'x'.repeat(60) + '</td></tr>').join('');
            const html = '<p>đầu</p><table><tbody>' + rows + '</tbody></table><p>cuối</p>';
            const bal = store.balanceParts(store.splitHtmlChunks(html, 64 * 1024));
            assert(bal.length > 2 && bal.every((c) => (c.match(/<table/g) || []).length === (c.match(/<\/table>/g) || []).length), 'mỗi phần cân bằng thẻ <table>');
            await store.createDoc('u1', '', 'Bang lon.docx', { html: '<p>x</p>' });
            await store.saveHtml('u1', '', 'Bang lon.docx', html, {});
            const out = await store.toDocxParts('u1', '', 'Bang lon.docx');
            assert(out.multi, 'bảng lớn phải tách nhiều phần');
            let got = 0;
            for (const p of out.parts) got += (readZip(p.buffer).text('word/document.xml').match(/Ô \d+/g) || []).length;
            assert.strictEqual(got, 6000, 'đủ 6000 dòng sau khi tách (không mất dữ liệu)');
            await store.removeDoc('u1', '', 'Bang lon.docx');
        } finally {
            LANG.docxPartBytes = oldPart;
            LANG.pageStoreBytes = oldStore;
        }
    }

    // ---- hình khối đặt tự do: sanitizer + xuất .docx (DrawingML)
    {
        const { sanitizeHtml: san } = require(R + 'services/word/htmlSanitize');
        const { htmlToDocx: toDocx } = require(R + 'services/word/htmlToDocx');
        const raw = '<p>Một</p><div class="word-shape" data-shape="star" data-oy="20" contenteditable="false" style="position: absolute; left: 300px; top: 60px; width: 120px; height: 110px; z-index: 2; background-color: rgb(255, 192, 0); border: 2px solid rgb(0, 0, 0); transform: rotate(20deg)">Sao</div>' +
            '<p style="position:fixed;left:0;top:0">x</p><div class="word-shape" data-shape="line" style="position:absolute;left:10px;top:400px;width:200px;height:0px;z-index:-1;border-top:3px solid rgb(37,99,235)"></div>' +
            '<div class="word-shape" data-shape="round" style="position:fixed;left:99999999px;width:100px;height:50px">trong dòng</div>';
        const clean = san(raw);
        assert(/class="word-shape"/.test(clean) && /data-shape="star"/.test(clean) && /data-oy="20"/.test(clean), 'giữ hình khối + data-shape + data-oy');
        assert(/position:absolute;left:300px;top:60px/.test(clean.replace(/ /g, '')), 'giữ position:absolute/left/top của hình');
        assert(!/position:fixed/.test(clean) && !/contenteditable/.test(clean) && !/99999999/.test(clean), 'chặn position:fixed, contenteditable và toạ độ phi lý');
        const buf = toDocx(clean, { title: 't' });
        const xml = readZip(Buffer.isBuffer(buf) ? buf : buf.buffer || buf).text('word/document.xml');
        assert.strictEqual((xml.match(/<wp:anchor\b/g) || []).length, 2, '2 hình tự do → 2 wp:anchor');
        assert(/prst="star5"/.test(xml) && /prst="line"/.test(xml) && /behindDoc="1"/.test(xml) && /rot="1200000"/.test(xml), 'hình sao xoay 20°, đường thẳng sau văn bản');
        assert(/posOffset>2857500</.test(xml), 'left 300px = 2857500 EMU');
        assert(/<wp:inline\b/.test(xml), 'hình cùng dòng → wp:inline');
    }

    console.log('OK word');
})().catch((e) => { console.error('✘', e); process.exit(1); });
