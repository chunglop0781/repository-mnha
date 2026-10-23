(function () {
    var root = document.getElementById('codeFiles'); if (!root) return;
    var lang = root.dataset.lang, dir = root.dataset.dir || '';
    function post(url, body) {
        return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Lỗi'); return j; }); });
    }
    var exts = (root.dataset.exts || '').split(',');
    document.getElementById('btnNewFile').onclick = function () {
        var n = prompt('Tên file (đuôi: ' + exts.map(function (e) { return '.' + e; }).join(', ') + ')'); if (!n) return;
        post('/code/' + lang + '/file', { dir: dir, name: n.trim() }).then(function (j) {
            window.open('/code/' + lang + '/edit?dir=' + encodeURIComponent(dir) + '&file=' + encodeURIComponent(j.file), '_blank');
            location.reload();
        }).catch(function (e) { alert(e.message); });
    };
    document.getElementById('btnNewFolder').onclick = function () {
        var n = prompt('Tên thư mục (chữ, số, - _ và dấu ngoặc ( ))'); if (!n) return;
        post('/code/' + lang + '/folder', { dir: dir, name: n.trim() }).then(function () { location.reload(); }).catch(function (e) { alert(e.message); });
    };
    var df = document.getElementById('btnDelFolder');
    if (df) df.onclick = function () {
        if (!confirm('Xoá thư mục "' + dir + '" và mọi file trong đó?')) return;
        post('/code/' + lang + '/delete', { type: 'folder', dir: dir }).then(function () { location.href = '/code/' + lang; }).catch(function (e) { alert(e.message); });
    };
    document.querySelectorAll('.btn-del-file').forEach(function (b) {
        b.onclick = function () {
            if (!confirm('Xoá file "' + b.dataset.file + '"?')) return;
            post('/code/' + lang + '/delete', { type: 'file', dir: dir, file: b.dataset.file }).then(function () { location.reload(); }).catch(function (e) { alert(e.message); });
        };
    });
    if (window.lucide) lucide.createIcons();
})();
