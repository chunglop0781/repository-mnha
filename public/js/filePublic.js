// public/js/filePublic.js — trang xem file CÔNG KHAI (/f): xin khoá ở /f/key rồi tải các phần mã hoá thẳng từ GitHub raw và giải mã NGAY TRONG TRÌNH DUYỆT.
//   Ảnh / PDF (≤ 25MB) tự hiện; Word / Excel / PowerPoint và file lớn: bấm "Tải về" mới tải + giải mã. Lỗi tải thẳng → hiện nút "Tải qua máy chủ" (dự phòng).
(function () {
    'use strict';
    var b = document.body, msg = document.getElementById('msg'), view = document.getElementById('view'), btn = document.getElementById('btnDl'), srv = document.getElementById('aSrv');
    var kind = b.dataset.kind, size = Number(b.dataset.size) || 0, name = b.dataset.name, AUTO_MAX = 25 * 1024 * 1024, TEXT_MAX = 2 * 1024 * 1024;
    var info = null, blob = null;

    function say(t, err) { msg.textContent = t; msg.className = err ? 'note err' : 'note'; msg.style.display = t ? '' : 'none'; }
    function fallback(e) {
        var why = e && e.message ? e.message : 'Không giải mã được trong trình duyệt.';
        say(why + ' Bạn có thể tải qua máy chủ.', true);
        srv.classList.remove('hide'); btn.classList.add('hide');
        if (kind === 'image' || kind === 'pdf') { var v = document.createElement('a'); v.className = 'btn alt'; v.href = b.dataset.srvView; v.textContent = 'Xem qua máy chủ'; v.style.marginLeft = '8px'; srv.parentNode.insertBefore(v, srv.nextSibling); }
    }
    function getInfo() {
        if (info) return Promise.resolve(info);
        return fetch(b.dataset.key, { credentials: 'omit', cache: 'no-store' }).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (j) {
                if (!r.ok) { var e = new Error(j.error || ('Lỗi ' + r.status)); e.fatal = true; throw e; }
                return (info = j);
            });
        });
    }
    function load() {
        if (blob) return Promise.resolve(blob);
        return getInfo().then(function (inf) {
            if (inf.mode !== 'direct') { var e = new Error('Máy chủ không bật tải thẳng từ GitHub.'); e.code = 'NO_RAW'; throw e; }
            return window.MnhaFiles.toBlob(inf, { onProgress: function (i, n) { say('Đang tải & giải mã… ' + Math.round(i * 100 / n) + '%'); } });
        }).then(function (bl) { blob = bl; return bl; });
    }
    function show(bl) {
        say('');
        if (kind === 'text') {          // chỉ XEM (textContent — không chạy được mã); sửa thì chủ đăng nhập vào Lưu trữ file
            bl.arrayBuffer().then(function (ab) { var pre = document.createElement('pre'); pre.textContent = new TextDecoder('utf-8').decode(ab); pre.style.cssText = 'text-align:left;white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:12px;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace'; view.appendChild(pre); });
            return;
        }
        var url = URL.createObjectURL(bl);
        if (kind === 'image') { var im = document.createElement('img'); im.src = url; im.alt = name; view.appendChild(im); }
        else if (kind === 'pdf') { var f = document.createElement('iframe'); f.src = url; f.title = name; view.appendChild(f); }
    }
    btn.onclick = function () {
        btn.disabled = true;
        load().then(function (bl) { window.MnhaFiles.save(bl, name); say(''); }).catch(function (e) { if (e.fatal) say(e.message, true); else fallback(e); }).then(function () { btn.disabled = false; });
    };
    if (!window.MnhaFiles || !window.MnhaFiles.supported()) { fallback(new Error('Trình duyệt không hỗ trợ giải mã (WebCrypto).')); return; }
    if (((kind === 'image' || kind === 'pdf') && size <= AUTO_MAX) || (kind === 'text' && size <= TEXT_MAX)) {
        load().then(show).catch(function (e) { if (e.fatal) say(e.message, true); else fallback(e); });
    } else {
        say(kind === 'image' || kind === 'pdf' || kind === 'text' ? 'File lớn — bấm "Tải về" (tải và giải mã ngay trong trình duyệt).' : 'File Word / Excel / PowerPoint không xem trực tiếp được trên web — bấm "Tải về" để mở bằng ứng dụng Office. File được tải và giải mã ngay trong trình duyệt của bạn.');
    }
})();
