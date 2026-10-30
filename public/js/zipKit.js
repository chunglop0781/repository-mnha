// public/js/zipKit.js — dùng chung: gói nhiều file thành .zip (không nén) ngay ở trình duyệt + lưu blob về máy
(function (g) {
    'use strict';
    var crcT = null;
    function crc32(u8) {
        if (!crcT) { crcT = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; } }
        var x = 0xFFFFFFFF; for (var i = 0; i < u8.length; i++) x = crcT[(x ^ u8[i]) & 255] ^ (x >>> 8); return (x ^ 0xFFFFFFFF) >>> 0;
    }
    function zip(entries) {      // entries: [{name, data:Uint8Array}] → Blob
        var enc = new TextEncoder(), parts = [], central = [], offset = 0, d = new Date();
        var dosT = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), dosD = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
        entries.forEach(function (e) {
            var nm = enc.encode(e.name), crc = crc32(e.data), h = new DataView(new ArrayBuffer(30));
            h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
            h.setUint16(10, dosT, true); h.setUint16(12, dosD, true); h.setUint32(14, crc, true); h.setUint32(18, e.data.length, true); h.setUint32(22, e.data.length, true); h.setUint16(26, nm.length, true); h.setUint16(28, 0, true);
            parts.push(h.buffer, nm, e.data);
            var c = new DataView(new ArrayBuffer(46));
            c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
            c.setUint16(12, dosT, true); c.setUint16(14, dosD, true); c.setUint32(16, crc, true); c.setUint32(20, e.data.length, true); c.setUint32(24, e.data.length, true); c.setUint16(28, nm.length, true); c.setUint32(42, offset, true);
            central.push(c.buffer, nm);
            offset += 30 + nm.length + e.data.length;
        });
        var csize = central.reduce(function (n, b) { return n + (b.byteLength || b.length); }, 0), end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true); end.setUint32(12, csize, true); end.setUint32(16, offset, true);
        return new Blob(parts.concat(central, [end.buffer]), { type: 'application/zip' });
    }
    function save(blob, filename) {
        var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    }
    g.MnhaZip = { zip: zip, save: save };
})(window);
