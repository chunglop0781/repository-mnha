// public/js/pwToggle.js — nút Hiện / Ẩn mật khẩu: <button data-pw-toggle="id-của-ô-nhập">
(function () {
    'use strict';
    document.addEventListener('click', function (e) {
        var b = e.target && e.target.closest ? e.target.closest('[data-pw-toggle]') : null; if (!b) return;
        var inp = document.getElementById(b.getAttribute('data-pw-toggle')); if (!inp) return;
        var show = inp.type === 'password';
        inp.type = show ? 'text' : 'password'; b.textContent = show ? 'Ẩn' : 'Hiện';
    });
})();
