// public/js/perfKit.js — tiện ích hiệu năng dùng chung cho emu8086 và C++ WASM (chạy được cả ở trình duyệt lẫn Node để test).
//   yieldNow(fn)        nhường trình duyệt rồi chạy fn NGAY (MessageChannel) — không bị khoá tối thiểu ~4ms như setTimeout(0)
//                       (Chrome và Safari đều khoá setTimeout lồng nhau ≥ 4ms; tab nền còn bị kéo lên 1 giây)
//   nextBatch(b, ms)    chỉnh số lệnh mỗi lát để mỗi lát chạy ≈ 12ms: UI mượt mà vòng lặp nặng vẫn chạy hết tốc lực
//   hash(parts)         băm chuỗi (2 × cyrb53 + độ dài) làm khoá cache bản dịch wasm
//   Lru(max)            bộ nhớ đệm LRU nhỏ
//   idle(fn, timeout)   chạy khi trình duyệt rảnh (Safari không có requestIdleCallback → setTimeout)
//   shouldPreload(nav)  có nên tải trước clang (~vài chục MB) khi mở trang không: KHÔNG tải trước trên iPhone/iPad (WebKit hay
//                       kill tab khi Wasm ăn RAM — bấm Chạy mới nạp), khi Tiết kiệm dữ liệu / mạng chậm, hoặc máy ≤ 2 GB RAM
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(root);
    else root.PerfKit = factory(root);
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    var chan = null, queue = [];
    function yieldNow(fn) {
        if (typeof root.MessageChannel === 'function') {
            if (!chan) {
                chan = new root.MessageChannel();
                chan.port1.onmessage = function () { var f = queue.shift(); if (f) f(); };
                if (typeof chan.port1.unref === 'function') chan.port1.unref();      // Node: không giữ tiến trình sống
            }
            queue.push(fn); chan.port2.postMessage(0); return;
        }
        setTimeout(fn, 0);
    }

    // Lát kế tiếp: tối đa ×2 / ÷2 mỗi lần để không dao động; ms = 0 (đồng hồ thô, vd Safari làm tròn 1ms) → tăng dần.
    function nextBatch(batch, ms, target, min, max) {
        target = target || 12; min = min || 2000; max = max || 4000000;
        var next;
        if (!(ms > 0)) next = batch * 2;
        else {
            var ideal = batch * target / ms;
            next = ideal > batch ? Math.min(ideal, batch * 2) : Math.max(ideal, batch / 2);
        }
        return Math.max(min, Math.min(max, Math.round(next)));
    }

    function cyrb53(str, seed) {
        var h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
        for (var i = 0, ch; i < str.length; i++) {
            ch = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return 4294967296 * (2097151 & h2) + (h1 >>> 0);
    }
    function hash(parts) {
        var s = parts.join('\u0000');
        return cyrb53(s, 0).toString(36) + cyrb53(s, 7).toString(36) + s.length.toString(36);
    }

    function Lru(max) { this.max = max; this.m = new Map(); }
    Lru.prototype.get = function (k) { if (!this.m.has(k)) return undefined; var v = this.m.get(k); this.m.delete(k); this.m.set(k, v); return v; };
    Lru.prototype.set = function (k, v) { this.m.delete(k); this.m.set(k, v); while (this.m.size > this.max) this.m.delete(this.m.keys().next().value); };
    Lru.prototype.has = function (k) { return this.m.has(k); };
    Object.defineProperty(Lru.prototype, 'size', { get: function () { return this.m.size; } });

    function idle(fn, timeout) {
        if (typeof root.requestIdleCallback === 'function') root.requestIdleCallback(fn, { timeout: timeout || 4000 });
        else setTimeout(fn, 1200);
    }

    function isIOS(nav) {
        if (!nav) return false;
        if (/\b(iPhone|iPad|iPod)\b/.test(String(nav.userAgent || ''))) return true;
        return nav.platform === 'MacIntel' && nav.maxTouchPoints > 1;       // iPad ở chế độ "desktop site"
    }
    function shouldPreload(nav) {
        if (isIOS(nav)) return false;
        var c = nav && (nav.connection || nav.mozConnection || nav.webkitConnection);
        if (c && (c.saveData || /(^|-)2g$/.test(String(c.effectiveType || '')))) return false;
        if (nav && nav.deviceMemory && nav.deviceMemory <= 2) return false;   // deviceMemory chỉ có ở Chromium; Safari/Firefox không có → bỏ qua
        return true;
    }

    return { yieldNow: yieldNow, nextBatch: nextBatch, hash: hash, Lru: Lru, idle: idle, shouldPreload: shouldPreload };
});
