// public/js/tsMux.js — CẮT âm thanh / video thành các đoạn MPEG-TS (cho m3u8) NGAY TRONG TRÌNH DUYỆT (cũng chạy được ở Node để test).
//
//   Vì sao ở trình duyệt: máy chủ (Vercel) chỉ nhận body ≤ 4.5MB/request và không có ffmpeg → trình duyệt đọc file gốc theo từng LÁT
//   (File.slice, không nạp cả file vào RAM nên file vài GB vẫn được), cắt thành đoạn ≤ ~3.5MB rồi gửi từng đoạn lên để mã hoá.
//
//   Hỗ trợ:  .mp3 · .aac (ADTS) · .m4a  → đoạn TS chỉ có âm thanh
//            .mp4 / .m4v / .mov (H.264 + AAC hoặc MP3, KHÔNG phân mảnh) → đoạn TS có hình + tiếng, cắt ở khung hình khoá (keyframe)
//            .mp4 / .m4v / .mov codec THẾ HỆ MỚI: H.265/HEVC (hvc1/hev1) · AV1 (av01) · VP9 (vp09)  (+ AAC / MP3 / Opus / FLAC)
//                → đoạn fMP4 (CMAF: init.mp4 + moof/mdat), KHÔNG chuyển mã — chép nguyên mẫu nén, chỉ bọc lại; cắt ở keyframe.
//                  (HLS chỉ cho phép AV1 trong fMP4, không có trong MPEG-TS.)  H.264 + âm thanh lạ (vd Opus) cũng đi đường fMP4.
//   Ra:      TS  : mỗi đoạn là 1 file .ts độc lập (PAT+PMT ở đầu, PTS liên tục giữa các đoạn) — ghép các đoạn lại = 1 luồng MPEG-TS hợp lệ.
//            fMP4: f.init (ftyp+moov, dùng chung) + mỗi đoạn là 1 cặp moof+mdat — init + các đoạn ghép lại = 1 file mp4 phân mảnh hợp lệ.
//
//   API:  const f = await TsMux.open(reader, 'mp4', { segSec: 6, segBytes: 3.5*1024*1024 });
//         f.fmt = 'ts' | 'fmp4' ; f.init (chỉ fmp4) ; f.codecString (vd 'av01.0.08M.08,mp4a.40.2')
//         for await (const seg of f.segments(skip)) { seg.i, seg.bytes (Uint8Array TS hoặc moof+mdat), seg.dur (giây), seg.progress (0..1) }
//   reader = { size, read(start, end) → Promise<Uint8Array> }     (TsMux.fileReader(File) dùng cho trình duyệt)
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.TsMux = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var PID_PMT = 0x1000, PID_VIDEO = 0x100, PID_AUDIO = 0x101;
    var PTS_OFFSET = 90000;                  // mốc thời gian bắt đầu 1 giây (tránh PTS âm)
    var START4 = [0, 0, 0, 1], AUD = new Uint8Array([0, 0, 0, 1, 0x09, 0xF0]);
    var ST_H264 = 0x1B, ST_AAC = 0x0F, ST_MP1 = 0x03, ST_MP2 = 0x04;
    var FMP4_VIDEO = ['avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'vp09'], FMP4_AUDIO = ['mp4a', 'Opus', 'fLaC'];

    function fail(msg) { return new Error(msg); }
    function concat(list, total) {
        if (total == null) { total = 0; for (var i = 0; i < list.length; i++) total += list[i].length; }
        var out = new Uint8Array(total), p = 0;
        for (var k = 0; k < list.length; k++) { out.set(list[k], p); p += list[k].length; }
        return out;
    }

    // ------------------------------------------------------------------ CRC32 (MPEG-2) cho bảng PAT/PMT
    var CRC = (function () {
        var t = new Uint32Array(256);
        for (var i = 0; i < 256; i++) {
            var c = (i << 24) >>> 0;
            for (var j = 0; j < 8; j++) c = (c & 0x80000000) ? (((c << 1) ^ 0x04C11DB7) >>> 0) : ((c << 1) >>> 0);
            t[i] = c;
        }
        return t;
    })();
    function crc32(b) { var c = 0xFFFFFFFF; for (var i = 0; i < b.length; i++) c = (((c << 8) >>> 0) ^ CRC[((c >>> 24) ^ b[i]) & 0xFF]) >>> 0; return c >>> 0; }

    // ------------------------------------------------------------------ ghi TS
    function TsWriter(o) {
        this.cc = {};
        this.video = !!o.video;
        this.audioType = o.audioType || 0;
        this.pcrPid = this.video ? PID_VIDEO : PID_AUDIO;
    }
    TsWriter.prototype._cc = function (pid) { var c = this.cc[pid] | 0; this.cc[pid] = (c + 1) & 15; return c; };
    TsWriter.prototype._section = function (tableId, idExt, body) {
        var len = 5 + body.length + 4, s = new Uint8Array(3 + len);
        s[0] = tableId; s[1] = 0xB0 | ((len >> 8) & 0x0F); s[2] = len & 0xFF;
        s[3] = (idExt >> 8) & 0xFF; s[4] = idExt & 0xFF; s[5] = 0xC1; s[6] = 0; s[7] = 0;
        s.set(body, 8);
        var c = crc32(s.subarray(0, s.length - 4)), q = s.length - 4;
        s[q] = c >>> 24; s[q + 1] = (c >>> 16) & 0xFF; s[q + 2] = (c >>> 8) & 0xFF; s[q + 3] = c & 0xFF;
        return s;
    };
    TsWriter.prototype._psiPacket = function (pid, section) {
        var p = new Uint8Array(188); p.fill(0xFF);
        p[0] = 0x47; p[1] = 0x40 | ((pid >> 8) & 0x1F); p[2] = pid & 0xFF; p[3] = 0x10 | this._cc(pid);
        p[4] = 0; p.set(section, 5);
        return p;
    };
    /** PAT + PMT (2 gói) — đặt ở đầu MỖI đoạn để đoạn nào cũng phát độc lập được. */
    TsWriter.prototype.psi = function () {
        var pat = this._section(0x00, 1, new Uint8Array([0x00, 0x01, 0xE0 | (PID_PMT >> 8), PID_PMT & 0xFF]));
        var es = [];
        if (this.video) es.push(ST_H264, 0xE0 | (PID_VIDEO >> 8), PID_VIDEO & 0xFF, 0xF0, 0x00);
        if (this.audioType) es.push(this.audioType, 0xE0 | (PID_AUDIO >> 8), PID_AUDIO & 0xFF, 0xF0, 0x00);
        var pmt = this._section(0x02, 1, new Uint8Array([0xE0 | (this.pcrPid >> 8), this.pcrPid & 0xFF, 0xF0, 0x00].concat(es)));
        var out = new Uint8Array(376);
        out.set(this._psiPacket(0, pat), 0); out.set(this._psiPacket(PID_PMT, pmt), 188);
        return out;
    };
    function ts5(prefix, v) {
        var hi = Math.floor(v / 4294967296) & 1, lo = v >>> 0;
        return [(prefix << 4) | (((hi << 2) | ((lo >>> 30) & 3)) << 1) | 1, (lo >>> 22) & 0xFF, (((lo >>> 15) & 0x7F) << 1) | 1, (lo >>> 7) & 0xFF, ((lo & 0x7F) << 1) | 1];
    }
    TsWriter.prototype._packet = function (out, off, pid, pusi, payload, pcr, rai) {
        var needAf = !!rai || pcr != null;
        var afBody = needAf ? 1 + (pcr != null ? 6 : 0) : 0;
        var room = needAf ? 183 - afBody : 184, plen = payload.length;
        var stuff = room - plen, hasAf = needAf || stuff > 0, afl = 0;
        if (needAf) afl = afBody + stuff; else if (stuff > 0) afl = stuff - 1;
        out[off] = 0x47; out[off + 1] = (pusi ? 0x40 : 0) | ((pid >> 8) & 0x1F); out[off + 2] = pid & 0xFF;
        out[off + 3] = (hasAf ? 0x30 : 0x10) | this._cc(pid);
        var p = off + 4;
        if (hasAf) {
            out[p++] = afl;
            if (afl > 0) {
                out[p++] = (rai ? 0x40 : 0) | (pcr != null ? 0x10 : 0);
                if (pcr != null) {
                    var base = pcr;
                    out[p++] = Math.floor(base / 33554432) & 0xFF; out[p++] = Math.floor(base / 131072) & 0xFF;
                    out[p++] = Math.floor(base / 512) & 0xFF; out[p++] = Math.floor(base / 2) & 0xFF;
                    out[p++] = ((base % 2) << 7) | 0x7E; out[p++] = 0;
                }
                var endAf = off + 5 + afl;
                while (p < endAf) out[p++] = 0xFF;
            }
        }
        out.set(payload, p);
    };
    /** Gói 1 khung (PES) thành các gói TS 188 byte. pts/dts: đơn vị 90kHz. o: {pcr, rai, unbounded} */
    TsWriter.prototype.pes = function (pid, streamId, payload, pts, dts, o) {
        o = o || {};
        var hasDts = dts != null && dts !== pts, hl = hasDts ? 10 : 5;
        var pesLen = o.unbounded ? 0 : 3 + hl + payload.length;
        if (pesLen > 65535) pesLen = 0;
        var head = [0, 0, 1, streamId, pesLen >> 8, pesLen & 0xFF, 0x84, hasDts ? 0xC0 : 0x80, hl].concat(ts5(hasDts ? 3 : 2, pts), hasDts ? ts5(1, dts) : []);
        var total = head.length + payload.length;
        // đếm số gói: gói đầu có thể có AF (PCR/RAI) nên chứa ít hơn 184 byte
        var first = (o.rai || o.pcr != null) ? 183 - (1 + (o.pcr != null ? 6 : 0)) : 184;
        var n = total <= first ? 1 : 1 + Math.ceil((total - first) / 184);
        var out = new Uint8Array(n * 188), pos = 0, k = 0;
        var buf = new Uint8Array(total); buf.set(head, 0); buf.set(payload, head.length);
        while (pos < total) {
            var take = Math.min(k === 0 ? first : 184, total - pos);
            this._packet(out, k * 188, pid, k === 0, buf.subarray(pos, pos + take), k === 0 ? o.pcr : null, k === 0 ? o.rai : false);
            pos += take; k++;
        }
        return out;
    };

    // ------------------------------------------------------------------ đọc khung MP3 / AAC (ADTS)
    var MP3_BR = {
        '1-1': [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], '1-2': [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], '1-3': [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
        '2-1': [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], '2-2': [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], '2-3': [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
    };
    var MP3_SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
    var AAC_SR = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

    function mp3Header(b, p) {
        if (p + 4 > b.length || b[p] !== 0xFF || (b[p + 1] & 0xE0) !== 0xE0) return null;
        var ver = (b[p + 1] >> 3) & 3, layer = (b[p + 1] >> 1) & 3, brI = (b[p + 2] >> 4) & 15, srI = (b[p + 2] >> 2) & 3, pad = (b[p + 2] >> 1) & 1;
        if (ver === 1 || layer === 0 || brI === 0 || brI === 15 || srI === 3) return null;
        var L = 4 - layer, V = ver === 3 ? 1 : 2;
        var br = MP3_BR[V + '-' + L][brI - 1] * 1000, sr = MP3_SR[ver][srI];
        var spf = L === 1 ? 384 : (L === 2 || V === 1 ? 1152 : 576);
        var len = L === 1 ? (Math.floor(12 * br / sr) + pad) * 4 : Math.floor((V === 1 || L === 2 ? 144 : 72) * br / sr) + pad;
        return { len: len, dur: spf / sr, key: ver + '-' + layer + '-' + sr, type: ver === 3 ? ST_MP1 : ST_MP2 };
    }
    function adtsHeader(b, p) {
        if (p + 7 > b.length || b[p] !== 0xFF || (b[p + 1] & 0xF6) !== 0xF0) return null;
        var sfI = (b[p + 2] >> 2) & 15; if (sfI > 12) return null;
        var len = ((b[p + 3] & 3) << 11) | (b[p + 4] << 3) | (b[p + 5] >> 5), blocks = (b[p + 6] & 3) + 1;
        if (len < ((b[p + 1] & 1) ? 7 : 9)) return null;
        return { len: len, dur: 1024 * blocks / AAC_SR[sfI], key: 'aac-' + sfI + '-' + (((b[p + 2] & 1) << 2) | (b[p + 3] >> 6)), type: ST_AAC };
    }
    /** Lướt qua file, trả từng khung {data, dur}. Bỏ ID3v2 ở đầu; gặp rác thì dò lại (resync), kiểm tra khung kế tiếp cùng thông số. */
    async function* scanFrames(reader, parse) {
        var size = reader.size, BLOCK = 2 * 1024 * 1024, pos = 0, buf = new Uint8Array(0), bufStart = 0;
        async function ensure(p, n) {
            if (p >= bufStart && p + n <= bufStart + buf.length) return true;
            if (p >= size) return false;
            var end = Math.min(size, p + Math.max(n, BLOCK));
            buf = await reader.read(p, end); bufStart = p;
            return p + n <= bufStart + buf.length;
        }
        if (await ensure(0, 10)) {
            if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) pos = 10 + (((buf[6] & 0x7F) << 21) | ((buf[7] & 0x7F) << 14) | ((buf[8] & 0x7F) << 7) | (buf[9] & 0x7F)) + ((buf[5] & 0x10) ? 10 : 0);
        }
        while (pos + 4 <= size) {
            if (!(await ensure(pos, 7))) break;
            var h = parse(buf, pos - bufStart);
            if (h && pos + h.len <= size) {
                var ok = true;
                if (pos + h.len + 7 <= size) {
                    if (await ensure(pos, h.len + 7)) { var h2 = parse(buf, pos - bufStart + h.len); ok = !!h2 && h2.key === h.key; }
                }
                if (ok && await ensure(pos, h.len)) {
                    yield { data: buf.subarray(pos - bufStart, pos - bufStart + h.len), dur: h.dur, type: h.type, key: h.key, pos: pos + h.len };
                    pos += h.len; continue;
                }
            }
            pos++;
        }
    }

    /** frames: async iterable {data, dur, type}  → các đoạn TS chỉ có âm thanh */
    async function* audioSegments(frames, opts, size, skip) {
        var segSec = opts.segSec, cap = Math.floor(opts.segBytes * 0.9), w = null;
        var cur = [], curDur = 0, curBytes = 0, acc = 0, idx = 0, lastPos = 0, startAcc = 0;
        function build() {
            var parts = [w.psi()], i = 0, first = true;
            while (i < cur.length) {
                var g = [], bytes = 0, gAcc = cur[i].at;
                while (i < cur.length && g.length < 8 && bytes < 6000) { g.push(cur[i].data); bytes += cur[i].data.length; i++; }
                var pts = PTS_OFFSET + Math.round(gAcc * 90000);
                parts.push(w.pes(PID_AUDIO, 0xC0, concat(g, bytes), pts, null, first ? { pcr: Math.max(0, pts - 9000), rai: true } : { rai: true }));
                first = false;
            }
            return concat(parts);
        }
        async function* flush(final) {
            if (!cur.length) return;
            var seg = { i: idx, dur: Math.round(curDur * 1000) / 1000, progress: final ? 1 : Math.min(0.999, lastPos / size) };
            if (idx >= skip) { seg.bytes = build(); yield seg; }
            idx++; cur = []; curDur = 0; curBytes = 0;
        }
        for await (var f of frames) {
            if (!w) w = new TsWriter({ video: false, audioType: f.type });
            if (cur.length && (curDur >= segSec || curBytes + f.data.length > cap)) yield* flush(false);
            cur.push({ data: f.data, at: acc }); curDur += f.dur; curBytes += f.data.length; acc += f.dur; lastPos = f.pos || lastPos;
        }
        yield* flush(true);
    }

    // ------------------------------------------------------------------ MP4 (không phân mảnh)
    var u32 = function (b, p) { return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0; };
    var u16 = function (b, p) { return (b[p] << 8) | b[p + 1]; };
    var str4 = function (b, p) { return String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]); };
    function children(b, start, end) {
        var out = [], p = start;
        while (p + 8 <= end) {
            var sz = u32(b, p), hdr = 8;
            if (sz === 1) { sz = u32(b, p + 8) * 4294967296 + u32(b, p + 12); hdr = 16; } else if (sz === 0) sz = end - p;
            if (sz < hdr || p + sz > end) break;
            out.push({ type: str4(b, p + 4), start: p, body: p + hdr, end: p + sz });
            p += sz;
        }
        return out;
    }
    function child(b, box, type) { var c = children(b, box.body, box.end); for (var i = 0; i < c.length; i++) if (c[i].type === type) return c[i]; return null; }
    function path(b, box) { var cur = box; for (var i = 2; i < arguments.length; i++) { cur = cur && child(b, cur, arguments[i]); } return cur; }

    function descr(b, p, end) {       // đọc 1 descriptor MPEG-4 → {tag, body, end}
        if (p >= end) return null;
        var tag = b[p++], len = 0, k = 0, c;
        do { c = b[p++]; len = (len << 7) | (c & 0x7F); k++; } while ((c & 0x80) && k < 4 && p < end);
        return { tag: tag, body: p, end: Math.min(end, p + len) };
    }
    function parseAudioEntry(b, entry) {
        var ver = u16(b, entry.body + 8), skip = 28 + (ver === 1 ? 16 : ver === 2 ? 36 : 0);
        var esds = child(b, { body: entry.body + skip, end: entry.end }, 'esds');
        if (!esds) throw fail('Không đọc được cấu hình âm thanh (esds) trong file mp4.');
        var d = descr(b, esds.body + 4, esds.end);
        if (!d || d.tag !== 0x03) throw fail('Cấu hình âm thanh (esds) không hợp lệ.');
        var p = d.body + 2, fl = b[p++]; if (fl & 0x80) p += 2; if (fl & 0x40) p += 1 + b[p]; if (fl & 0x20) p += 2;
        var dc = descr(b, p, d.end);
        if (!dc || dc.tag !== 0x04) throw fail('Cấu hình âm thanh (esds) không hợp lệ.');
        var oti = b[dc.body];
        if (oti === 0x6B || oti === 0x69) return { codec: 'mp3' };
        if (oti !== 0x40) throw fail('Âm thanh trong file dùng codec không hỗ trợ (mã 0x' + oti.toString(16) + '). Chỉ cắt được AAC hoặc MP3.');
        var ds = descr(b, dc.body + 13, dc.end);
        if (!ds || ds.tag !== 0x05 || ds.end - ds.body < 2) throw fail('Thiếu cấu hình AAC (AudioSpecificConfig).');
        var a0 = b[ds.body], a1 = b[ds.body + 1], obj = a0 >> 3, sf = ((a0 & 7) << 1) | (a1 >> 7), ch = (a1 >> 3) & 15;
        if (obj === 31) throw fail('AAC dạng mở rộng chưa hỗ trợ.');
        if (obj === 5 || obj === 29) obj = 2;
        if (sf === 15 || sf > 12 || ch < 1) throw fail('Thông số AAC chưa hỗ trợ (tần số/số kênh).');
        return { codec: 'aac', obj: obj, sf: sf, ch: ch };
    }
    function parseVideoEntry(b, entry) {
        var avcC = child(b, { body: entry.body + 78, end: entry.end }, 'avcC');
        if (!avcC) throw fail('Không đọc được cấu hình H.264 (avcC).');
        var p = avcC.body + 4, lengthSize = (b[p] & 3) + 1, nSps = b[p + 1] & 31, sps = [], pps = [];
        p += 2;
        for (var i = 0; i < nSps; i++) { var l = u16(b, p); sps.push(b.slice(p + 2, p + 2 + l)); p += 2 + l; }
        var nPps = b[p++];
        for (var j = 0; j < nPps; j++) { var l2 = u16(b, p); pps.push(b.slice(p + 2, p + 2 + l2)); p += 2 + l2; }
        if (!sps.length || !pps.length) throw fail('Thiếu SPS/PPS H.264.');
        return { lengthSize: lengthSize, sps: sps, pps: pps };
    }
    function parseTrak(b, trak) {
        var mdia = child(b, trak, 'mdia'); if (!mdia) return null;
        var mdhd = child(b, mdia, 'mdhd'), hdlr = child(b, mdia, 'hdlr'), stbl = path(b, mdia, 'minf', 'stbl');
        if (!mdhd || !hdlr || !stbl) return null;
        var handler = str4(b, hdlr.body + 8); if (handler !== 'vide' && handler !== 'soun') return null;
        var timescale = b[mdhd.body] === 1 ? u32(b, mdhd.body + 20) : u32(b, mdhd.body + 12);
        var stsd = child(b, stbl, 'stsd'), stts = child(b, stbl, 'stts'), stsz = child(b, stbl, 'stsz'), stsc = child(b, stbl, 'stsc');
        var stco = child(b, stbl, 'stco'), co64 = child(b, stbl, 'co64'), stss = child(b, stbl, 'stss'), ctts = child(b, stbl, 'ctts');
        if (!stsd || !stts || !stsz || !stsc || !(stco || co64)) throw fail('Bảng mẫu (sample table) của file mp4 không đầy đủ' + (child(b, stbl, 'stz2') ? ' (stz2 chưa hỗ trợ)' : '') + '.');
        var entry = children(b, stsd.body + 8, stsd.end)[0]; if (!entry) throw fail('Thiếu mô tả mẫu (stsd).');
        var fourcc = str4(b, entry.start + 4), tr = { type: handler === 'vide' ? 'video' : 'audio', timescale: timescale, fourcc: fourcc };
        tr.entryBytes = b.slice(entry.start, entry.end);          // nguyên mô tả mẫu (avc1/av01/hvc1/mp4a/Opus…) — chép vào init.mp4 khi đóng gói fMP4
        if (tr.type === 'video') {
            if (fourcc === 'avc1' || fourcc === 'avc3') tr.avc = parseVideoEntry(b, entry);
            else if (FMP4_VIDEO.indexOf(fourcc) < 0) throw fail('Video dùng codec "' + fourcc.trim() + '" — chỉ cắt (m3u8) được H.264 (avc1), H.265/HEVC (hvc1, hev1), AV1 (av01) và VP9 (vp09). Hãy chuyển video sang mp4 một trong các codec này (H.264/AAC là chuẩn nhất, phát được ở mọi trình duyệt).');
            tr.width = u16(b, entry.body + 24); tr.height = u16(b, entry.body + 26);
        } else {
            if (fourcc === 'mp4a') {
                try { tr.audio = parseAudioEntry(b, entry); tr.fmp4Ok = true; } catch (e) { tr.audioErr = e; tr.fmp4Ok = false; }
            } else if (FMP4_AUDIO.indexOf(fourcc) >= 0) {
                tr.fmp4Ok = true; tr.audioErr = fail('Âm thanh "' + fourcc.trim() + '" chỉ đóng gói được vào fMP4 (không vào MPEG-TS).');
            } else {
                tr.fmp4Ok = false; tr.audioErr = fail('Âm thanh trong file dùng codec "' + fourcc.trim() + '" — chỉ cắt được AAC (mp4a), MP3, Opus hoặc FLAC.');
            }
        }
        // kích thước mẫu
        var cs = u32(b, stsz.body + 4), n = u32(b, stsz.body + 8), sizes = new Uint32Array(n);
        if (cs) sizes.fill(cs); else for (var i = 0; i < n; i++) sizes[i] = u32(b, stsz.body + 12 + i * 4);
        // vị trí từng mẫu
        var nChunks = u32(b, (stco || co64).body + 4), chunkOff = new Float64Array(nChunks);
        for (var c = 0; c < nChunks; c++) chunkOff[c] = stco ? u32(b, stco.body + 8 + c * 4) : u32(b, co64.body + 8 + c * 8) * 4294967296 + u32(b, co64.body + 12 + c * 8);
        var nsc = u32(b, stsc.body + 4), offs = new Float64Array(n), si = 0;
        for (var e = 0; e < nsc; e++) {
            var first = u32(b, stsc.body + 8 + e * 12), per = u32(b, stsc.body + 12 + e * 12);
            var next = e + 1 < nsc ? u32(b, stsc.body + 8 + (e + 1) * 12) : nChunks + 1;
            for (var ch = first; ch < next && ch <= nChunks; ch++) { var o = chunkOff[ch - 1]; for (var k = 0; k < per && si < n; k++) { offs[si] = o; o += sizes[si]; si++; } }
        }
        if (si < n) throw fail('Bảng mẫu mp4 bị hỏng (thiếu vị trí mẫu).');
        // thời gian giải mã
        var ne = u32(b, stts.body + 4), dts = new Float64Array(n), acc = 0, ix = 0, lastDelta = 0;
        for (var t = 0; t < ne; t++) { var cnt = u32(b, stts.body + 8 + t * 8), dl = u32(b, stts.body + 12 + t * 8); lastDelta = dl; for (var q = 0; q < cnt && ix < n; q++) { dts[ix++] = acc; acc += dl; } }
        for (; ix < n; ix++) { dts[ix] = acc; acc += lastDelta; }
        var cto = new Int32Array(n);
        if (ctts) {
            var signed = b[ctts.body] === 1, nc = u32(b, ctts.body + 4), z = 0;
            for (var m = 0; m < nc; m++) { var cc = u32(b, ctts.body + 8 + m * 8), v = u32(b, ctts.body + 12 + m * 8); if (signed) v = v | 0; for (var r = 0; r < cc && z < n; r++) cto[z++] = v; }
        }
        var sync = new Uint8Array(n);
        if (stss) { var ns = u32(b, stss.body + 4); for (var s = 0; s < ns; s++) { var sn = u32(b, stss.body + 8 + s * 4) - 1; if (sn >= 0 && sn < n) sync[sn] = 1; } } else sync.fill(1);
        tr.n = n; tr.sizes = sizes; tr.offs = offs; tr.dts = dts; tr.cto = cto; tr.sync = sync; tr.lastDelta = lastDelta;
        return tr;
    }
    async function parseMp4(reader) {
        var size = reader.size, pos = 0, moov = null;
        while (pos + 8 <= size) {
            var head = await reader.read(pos, Math.min(size, pos + 16)), sz = u32(head, 0), type = str4(head, 4), hdr = 8;
            if (sz === 1) { if (head.length < 16) break; sz = u32(head, 8) * 4294967296 + u32(head, 12); hdr = 16; } else if (sz === 0) sz = size - pos;
            if (sz < hdr) break;
            if (type === 'moof') throw fail('File mp4 dạng phân mảnh (fragmented) chưa hỗ trợ cắt — hãy xuất lại thành mp4 thường (faststart).');
            if (type === 'moov') {
                if (sz > 256 * 1024 * 1024) throw fail('Phần mô tả (moov) của file quá lớn.');
                moov = await reader.read(pos + hdr, pos + sz);
                if (moov.length !== sz - hdr) throw fail('Không đọc đủ phần mô tả (moov) của file.');
            }
            pos += sz;
        }
        if (!moov) throw fail('Không tìm thấy phần mô tả (moov) — đây không phải file mp4/m4a/mov hợp lệ hoặc bị hỏng.');
        var tracks = children(moov, 0, moov.length).filter(function (x) { return x.type === 'trak'; }).map(function (t) { return parseTrak(moov, t); }).filter(Boolean);
        var video = tracks.filter(function (t) { return t.type === 'video'; })[0] || null, audio = tracks.filter(function (t) { return t.type === 'audio'; })[0] || null;
        return { video: video, audio: audio };
    }

    /** Đọc các mẫu [i0, i1) của 1 track: gom các mẫu gần nhau thành ít lần đọc. */
    async function readSamples(reader, tr, i0, i1) {
        var out = new Array(i1 - i0), GAP = 256 * 1024, MAXRUN = 12 * 1024 * 1024, i = i0;
        while (i < i1) {
            var j = i, start = tr.offs[i], end = start + tr.sizes[i];
            while (j + 1 < i1) {
                var ns = tr.offs[j + 1], ne = ns + tr.sizes[j + 1];
                if (ns < start || ns - end > GAP || Math.max(end, ne) - start > MAXRUN) break;
                end = Math.max(end, ne); j++;
            }
            var data = await reader.read(start, end);
            if (data.length !== end - start) throw fail('Đọc file bị thiếu dữ liệu (file đổi trong lúc tải lên?).');
            for (var k = i; k <= j; k++) out[k - i0] = data.subarray(tr.offs[k] - start, tr.offs[k] - start + tr.sizes[k]);
            i = j + 1;
        }
        return out;
    }

    function adts(a, raw) {
        var len = raw.length + 7, h = new Uint8Array(7 + raw.length);
        h[0] = 0xFF; h[1] = 0xF1; h[2] = (((a.obj - 1) & 3) << 6) | (a.sf << 2) | ((a.ch >> 2) & 1); h[3] = ((a.ch & 3) << 6) | ((len >> 11) & 3);
        h[4] = (len >> 3) & 0xFF; h[5] = ((len & 7) << 5) | 0x1F; h[6] = 0xFC; h.set(raw, 7);
        return h;
    }
    function annexB(sample, tr, isSync) {
        var parts = [AUD], total = AUD.length, ls = tr.avc.lengthSize, p = 0, i, x;
        if (isSync) for (i = 0; i < tr.avc.sps.length; i++) { x = tr.avc.sps[i]; parts.push(new Uint8Array(START4), x); total += 4 + x.length; }
        if (isSync) for (i = 0; i < tr.avc.pps.length; i++) { x = tr.avc.pps[i]; parts.push(new Uint8Array(START4), x); total += 4 + x.length; }
        while (p + ls <= sample.length) {
            var len = 0; for (i = 0; i < ls; i++) len = len * 256 + sample[p + i];
            p += ls;
            if (len <= 0 || p + len > sample.length) break;
            if ((sample[p] & 0x1F) !== 9) { parts.push(new Uint8Array(START4), sample.subarray(p, p + len)); total += 4 + len; }
            p += len;
        }
        return concat(parts, total);
    }
    function lowerBound(tr, t) {          // chỉ số mẫu đầu tiên có dts ≥ t giây
        var lo = 0, hi = tr.n, ts = tr.timescale;
        while (lo < hi) { var mid = (lo + hi) >> 1; if (tr.dts[mid] / ts < t) lo = mid + 1; else hi = mid; }
        return lo;
    }
    function prefix(tr, extra) { var p = new Float64Array(tr.n + 1); for (var i = 0; i < tr.n; i++) p[i + 1] = p[i] + tr.sizes[i] + (extra || 0); return p; }

    /** Video (+ tiếng): chia theo GOP — đoạn bắt đầu ở keyframe, dài ≈ segSec và không vượt segBytes; GOP nặng hơn 1 đoạn thì tự chia tiếp ở ranh giới khung hình. */
    function planVideo(v, a, opts, fmp4) {
        var n = v.n, ts = v.timescale, cap = Math.floor(opts.segBytes * 0.9);
        var vp = prefix(v, 0), ap = a ? prefix(a, !fmp4 && a.audio && a.audio.codec === 'aac' ? 7 : 0) : null;
        var tAt = function (i) { return i >= n ? (v.dts[n - 1] + (v.lastDelta || 0)) / ts : v.dts[i] / ts; };
        var est = function (x, y) { var t0 = tAt(x), t1 = tAt(y), ab = a ? ap[lowerBound(a, t1)] - ap[lowerBound(a, t0)] : 0; return vp[y] - vp[x] + ab + Math.ceil((vp[y] - vp[x]) * 0.02); };
        var gops = []; for (var i = 0; i < n; i++) if (v.sync[i] || i === 0) gops.push(i);
        var plan = [], cur = null;
        for (var g = 0; g < gops.length; g++) {
            var gs = gops[g], ge = g + 1 < gops.length ? gops[g + 1] : n, t0 = tAt(gs), t1 = tAt(ge);
            var ab = a ? ap[lowerBound(a, t1)] - ap[lowerBound(a, t0)] : 0, gb = vp[ge] - vp[gs] + ab + Math.ceil((vp[ge] - vp[gs]) * 0.02);
            if (gb > cap) {          // GOP nặng hơn 1 đoạn → tự chia nhỏ ở ranh giới khung hình (không bắt người dùng nén lại)
                if (cur) { plan.push(cur); cur = null; }
                for (var s0 = gs; s0 < ge;) {
                    var s1 = s0 + 1;
                    if (est(s0, s1) > cap) throw fail('Một khung hình đơn lẻ nặng ~' + (est(s0, s1) / 1048576).toFixed(1) + 'MB, vượt giới hạn mỗi đoạn ' + (opts.segBytes / 1048576).toFixed(1) + 'MB. Hãy nén lại video với bitrate thấp hơn.');
                    while (s1 < ge && est(s0, s1 + 1) <= cap && tAt(s1) - tAt(s0) < opts.segSec) s1++;
                    plan.push({ vs: s0, ve: s1, t0: tAt(s0), t1: tAt(s1), bytes: est(s0, s1) });
                    s0 = s1;
                }
                continue;
            }
            if (cur && (cur.t1 - cur.t0 >= opts.segSec || cur.bytes + gb > cap)) { plan.push(cur); cur = null; }
            if (!cur) cur = { vs: gs, ve: ge, t0: t0, t1: t1, bytes: 0 };
            cur.ve = ge; cur.t1 = t1; cur.bytes += gb;
        }
        if (cur) plan.push(cur);
        return plan;
    }
    function videoSegments(reader, mp4, opts, skip) {
        var v = mp4.video, a = mp4.audio, plan = planVideo(v, a, opts);
        var audioType = a ? (a.audio.codec === 'aac' ? ST_AAC : ST_MP1) : 0;
        var gen = async function* () {
            var w = new TsWriter({ video: true, audioType: audioType }), ts = v.timescale;
            for (var k = skip || 0; k < plan.length; k++) {
                var s = plan[k], vs = await readSamples(reader, v, s.vs, s.ve), vpes = [], apes = [];
                for (var i = s.vs; i < s.ve; i++) {
                    var dts = PTS_OFFSET + Math.round(v.dts[i] * 90000 / ts), pts = PTS_OFFSET + Math.round((v.dts[i] + v.cto[i]) * 90000 / ts);
                    if (pts < dts) pts = dts;
                    var first = i === s.vs;
                    vpes.push({ t: dts, buf: w.pes(PID_VIDEO, 0xE0, annexB(vs[i - s.vs], v, !!v.sync[i] || first), pts, dts, { unbounded: true, rai: !!v.sync[i] || first, pcr: first ? Math.max(0, dts - 63000) : null }) });
                }
                if (a) {
                    var a0 = k === 0 ? 0 : lowerBound(a, s.t0), a1 = k === plan.length - 1 ? a.n : lowerBound(a, s.t1);
                    var as = a1 > a0 ? await readSamples(reader, a, a0, a1) : [];
                    for (var j = a0; j < a1; j += 4) {
                        var grp = [], bytes = 0;
                        for (var m = j; m < Math.min(a1, j + 4); m++) { var fr = a.audio.codec === 'aac' ? adts(a.audio, as[m - a0]) : as[m - a0]; grp.push(fr); bytes += fr.length; }
                        var apts = PTS_OFFSET + Math.round(a.dts[j] * 90000 / a.timescale);
                        apes.push({ t: apts, buf: w.pes(PID_AUDIO, 0xC0, concat(grp, bytes), apts, null, { rai: true }) });
                    }
                }
                var parts = [w.psi()], x = 0, y = 0;
                while (x < vpes.length || y < apes.length) {
                    if (y >= apes.length || (x < vpes.length && vpes[x].t <= apes[y].t)) parts.push(vpes[x++].buf); else parts.push(apes[y++].buf);
                }
                yield { i: k, bytes: concat(parts), dur: Math.round((s.t1 - s.t0) * 1000) / 1000, progress: (k + 1) / plan.length };
            }
        };
        return { total: plan.length, gen: gen };
    }
    // ------------------------------------------------------------------ fMP4 (CMAF) — cho H.265 / AV1 / VP9 (và H.264 + âm thanh lạ)
    //   Không chuyển mã: chép nguyên mẫu nén từ mp4 gốc, chỉ dựng init (ftyp+moov rỗng bảng mẫu) + moof/mdat cho từng đoạn.
    function be32(n) { n = n >>> 0; return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
    function be64(n) { return be32(Math.floor(n / 4294967296)).concat(be32(n % 4294967296)); }
    function ascii(t) { return [t.charCodeAt(0), t.charCodeAt(1), t.charCodeAt(2), t.charCodeAt(3)]; }
    function mkBox(type, parts) {
        var arr = [], total = 8, i;
        for (i = 0; i < parts.length; i++) { var x = parts[i] instanceof Uint8Array ? parts[i] : Uint8Array.from(parts[i]); arr.push(x); total += x.length; }
        var out = new Uint8Array(total), p = 8;
        out.set(be32(total), 0); out.set(ascii(type), 4);
        for (i = 0; i < arr.length; i++) { out.set(arr[i], p); p += arr[i].length; }
        return out;
    }
    function fullBox(type, ver, flags, parts) { return mkBox(type, [[ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]].concat(parts)); }
    var MATRIX = [].concat(be32(0x10000), be32(0), be32(0), be32(0), be32(0x10000), be32(0), be32(0), be32(0), be32(0x40000000));

    function trakBox(tr, id) {
        var isV = tr.type === 'video';
        var tkhd = fullBox('tkhd', 0, 7, [be32(0), be32(0), be32(id), be32(0), be32(0), [0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0], isV ? [0, 0, 0, 0] : [1, 0, 0, 0],
            MATRIX, be32(isV ? tr.width * 65536 : 0), be32(isV ? tr.height * 65536 : 0)]);
        var mdhd = fullBox('mdhd', 0, 0, [be32(0), be32(0), be32(tr.timescale), be32(0), [0x55, 0xC4, 0, 0]]);
        var hdlr = fullBox('hdlr', 0, 0, [be32(0), ascii(isV ? 'vide' : 'soun'), be32(0), be32(0), be32(0), Array.prototype.map.call(isV ? 'VideoHandler\0' : 'SoundHandler\0', function (c) { return c.charCodeAt(0); })]);
        var dinf = mkBox('dinf', [fullBox('dref', 0, 0, [be32(1), fullBox('url ', 0, 1, [])])]);
        var stbl = mkBox('stbl', [fullBox('stsd', 0, 0, [be32(1), tr.entryBytes]), fullBox('stts', 0, 0, [be32(0)]), fullBox('stsc', 0, 0, [be32(0)]), fullBox('stsz', 0, 0, [be32(0), be32(0)]), fullBox('stco', 0, 0, [be32(0)])]);
        var minf = mkBox('minf', [isV ? fullBox('vmhd', 0, 1, [[0, 0, 0, 0, 0, 0, 0, 0]]) : fullBox('smhd', 0, 0, [[0, 0, 0, 0]]), dinf, stbl]);
        return mkBox('trak', [tkhd, mkBox('mdia', [mdhd, hdlr, minf])]);
    }
    /** init segment: ftyp + moov (track 1 = video, track 2 = âm thanh nếu có). */
    function buildInit(v, a) {
        var ids = a ? 2 : 1;
        var mvhd = fullBox('mvhd', 0, 0, [be32(0), be32(0), be32(1000), be32(0), be32(0x10000), [1, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0], MATRIX, new Uint8Array(24), be32(ids + 1)]);
        var traks = [trakBox(v, 1)], trex = [fullBox('trex', 0, 0, [be32(1), be32(1), be32(0), be32(0), be32(0)])];
        if (a) { traks.push(trakBox(a, 2)); trex.push(fullBox('trex', 0, 0, [be32(2), be32(1), be32(0), be32(0), be32(0x02000000)])); }
        var ftyp = mkBox('ftyp', [ascii('iso6'), be32(1), ascii('iso6'), ascii('isom'), ascii('mp41')]);
        return concat([ftyp, mkBox('moov', [mvhd].concat(traks, [mkBox('mvex', trex)]))]);
    }
    /** 1 đoạn = moof + mdat. tracks: [{id, base, dur[], size[], flags[]|null, cto[]|null}], datas: mẫu theo thứ tự track. */
    function buildFragment(seq, tracks, datas) {
        function moof(offs) {
            var trafs = tracks.map(function (t, k) {
                var hasF = !!t.flags, hasC = !!t.cto, fl = 0x1 | 0x100 | 0x200 | (hasF ? 0x400 : 0) | (hasC ? 0x800 : 0), body = [be32(t.dur.length), be32(offs[k])];
                for (var i = 0; i < t.dur.length; i++) { body.push(be32(t.dur[i]), be32(t.size[i])); if (hasF) body.push(be32(t.flags[i])); if (hasC) body.push(be32(t.cto[i])); }
                return mkBox('traf', [fullBox('tfhd', 0, 0x020000, [be32(t.id)]), fullBox('tfdt', 1, 0, [be64(t.base)]), fullBox('trun', hasC ? 1 : 0, fl, body)]);
            });
            return mkBox('moof', [fullBox('mfhd', 0, 0, [be32(seq)])].concat(trafs));
        }
        var zero = tracks.map(function () { return 0; }), len = moof(zero).length, offs = [], acc = len + 8, k;
        for (k = 0; k < tracks.length; k++) { offs.push(acc); for (var i = 0; i < tracks[k].size.length; i++) acc += tracks[k].size[i]; }
        var mdatHead = new Uint8Array(8); mdatHead.set(be32(acc - len), 0); mdatHead.set(ascii('mdat'), 4);
        return concat([moof(offs), mdatHead].concat(datas));
    }
    function sampleDur(tr, i) { return i + 1 < tr.n ? tr.dts[i + 1] - tr.dts[i] : tr.lastDelta; }

    /** Chuỗi codec (RFC 6381) cho video / âm thanh — để báo/ghi lại; trình phát tự đọc lại từ init. */
    function codecOf(tr) {
        var e = tr.entryBytes, hdr = 86, kids = children(e, hdr, e.length), cfg = function (t) { for (var i = 0; i < kids.length; i++) if (kids[i].type === t) return kids[i]; return null; };
        var h2 = function (n) { return (n < 16 ? '0' : '') + n.toString(16).toUpperCase(); }, d2 = function (n) { return (n < 10 ? '0' : '') + n; }, c;
        if (tr.type === 'audio') {
            if (tr.fourcc === 'Opus') return 'opus'; if (tr.fourcc === 'fLaC') return 'flac';
            return tr.audio ? (tr.audio.codec === 'aac' ? 'mp4a.40.2' : 'mp4a.6B') : 'mp4a.40.2';
        }
        if (tr.fourcc === 'av01' && (c = cfg('av1C'))) { var b1 = e[c.body + 1], b2 = e[c.body + 2]; return 'av01.' + (b1 >> 5) + '.' + d2(b1 & 31) + ((b2 & 128) ? 'H' : 'M') + '.' + d2((b2 & 32) ? 12 : (b2 & 64) ? 10 : 8); }
        if ((tr.fourcc === 'hvc1' || tr.fourcc === 'hev1') && (c = cfg('hvcC'))) {
            var o = c.body, comp = 0, x, sp = e[o + 1] >> 6, rev = 0;
            for (x = 0; x < 32; x++) { var bit = (u32(e, o + 2) >>> x) & 1; rev = ((rev << 1) | bit) >>> 0; }
            comp = rev.toString(16).toUpperCase();
            var cons = []; for (x = 0; x < 6; x++) cons.push(h2(e[o + 6 + x])); while (cons.length > 1 && cons[cons.length - 1] === '00') cons.pop();
            return tr.fourcc + '.' + ['', 'A', 'B', 'C'][sp] + (e[o + 1] & 31) + '.' + comp + '.' + ((e[o + 1] & 32) ? 'H' : 'L') + e[o + 12] + '.' + cons.join('.');
        }
        if (tr.fourcc === 'vp09' && (c = cfg('vpcC'))) return 'vp09.' + d2(e[c.body + 4]) + '.' + d2(e[c.body + 5]) + '.' + d2(e[c.body + 6] >> 4);
        if ((tr.fourcc === 'avc1' || tr.fourcc === 'avc3') && (c = cfg('avcC'))) return tr.fourcc + '.' + h2(e[c.body + 1]) + h2(e[c.body + 2]) + h2(e[c.body + 3]);
        return tr.fourcc;
    }

    function fmp4Segments(reader, mp4, opts, skip) {
        var v = mp4.video, a = mp4.audio, plan = planVideo(v, a, opts, true);
        var shift = (v.dts[0] + v.cto[0]) / v.timescale;       // mp4 gốc dùng edit list để khung hình đầu rơi vào t=0; ta không có edit list → dời tiếng cùng lượng để hình–tiếng giữ nguyên lệch
        var init = buildInit(v, a);
        var gen = async function* () {
            for (var k = skip || 0; k < plan.length; k++) {
                var s = plan[k], vs = await readSamples(reader, v, s.vs, s.ve), i;
                var vt = { id: 1, base: v.dts[s.vs], dur: [], size: [], flags: [], cto: [] }, tracks = [vt], datas = vs.slice();
                for (i = s.vs; i < s.ve; i++) { vt.dur.push(sampleDur(v, i)); vt.size.push(vs[i - s.vs].length); vt.flags.push(v.sync[i] || i === 0 ? 0x02000000 : 0x01010000); vt.cto.push(v.cto[i]); }
                if (a) {
                    var a0 = k === 0 ? 0 : lowerBound(a, s.t0), a1 = k === plan.length - 1 ? a.n : lowerBound(a, s.t1);
                    if (a1 > a0) {
                        var as = await readSamples(reader, a, a0, a1), at = { id: 2, base: Math.round(a.dts[a0] + shift * a.timescale), dur: [], size: [], flags: null, cto: null };
                        for (var j = a0; j < a1; j++) { at.dur.push(sampleDur(a, j)); at.size.push(as[j - a0].length); datas.push(as[j - a0]); }
                        tracks.push(at);
                    }
                }
                yield { i: k, bytes: buildFragment(k + 1, tracks, datas), dur: Math.round((s.t1 - s.t0) * 1000) / 1000, progress: (k + 1) / plan.length };
            }
        };
        return { total: plan.length, gen: gen, init: init };
    }

    function mp4AudioFrames(reader, a) {
        return (async function* () {
            var BATCH = 400, size = reader.size, i = 0;
            while (i < a.n) {
                var j = Math.min(a.n, i + BATCH), samples = await readSamples(reader, a, i, j);
                for (var k = i; k < j; k++) {
                    var dur = (k + 1 < a.n ? a.dts[k + 1] - a.dts[k] : a.lastDelta) / a.timescale;
                    yield { data: a.audio.codec === 'aac' ? adts(a.audio, samples[k - i]) : samples[k - i], dur: dur, type: a.audio.codec === 'aac' ? ST_AAC : ST_MP1, pos: a.offs[k] + a.sizes[k] };
                }
                i = j;
            }
        })();
    }

    // ------------------------------------------------------------------ API
    /** @returns {Promise<{kind:'audio'|'video', total:number|null, codecs:object, segments:(skip?:number)=>AsyncGenerator}>} */
    async function open(reader, ext, opts) {
        opts = Object.assign({ segSec: 6, segBytes: 3.5 * 1024 * 1024 }, opts || {});
        ext = String(ext || '').toLowerCase();
        if (ext === 'mp3' || ext === 'aac') {
            var parse = ext === 'mp3' ? mp3Header : adtsHeader;
            return { kind: 'audio', fmt: 'ts', total: null, codecs: { audio: ext }, segments: function (skip) { return audioSegments(scanFrames(reader, parse), opts, reader.size, skip || 0); } };
        }
        if (ext === 'mp4' || ext === 'm4v' || ext === 'mov' || ext === 'm4a') {
            var mp4 = await parseMp4(reader);
            if (ext === 'm4a') {
                if (!mp4.audio) throw fail('File m4a không có luồng âm thanh.');
                if (!mp4.audio.audio) throw mp4.audio.audioErr || fail('Âm thanh m4a dùng codec không hỗ trợ (chỉ AAC hoặc MP3).');
                return { kind: 'audio', fmt: 'ts', total: null, codecs: { audio: mp4.audio.audio.codec }, segments: function (skip) { return audioSegments(mp4AudioFrames(reader, mp4.audio), opts, reader.size, skip || 0); } };
            }
            if (!mp4.video) throw fail('File không có luồng video.');
            if (mp4.video.n < 1) throw fail('File video không có khung hình nào.');
            var a = mp4.audio && mp4.audio.n > 0 ? mp4.audio : null;
            if (mp4.video.avc && (!a || a.audio)) {                      // H.264 + AAC/MP3 → MPEG-TS (như trước)
                var tsIn = { video: mp4.video, audio: a }, vs = videoSegments(reader, tsIn, opts, 0);
                return { kind: 'video', fmt: 'ts', total: vs.total, codecs: { video: 'h264', audio: a ? a.audio.codec : null }, segments: function (skip) { return videoSegments(reader, tsIn, opts, skip || 0).gen(); } };
            }
            if (a && !a.fmp4Ok) throw a.audioErr;                         // codec hình mới (hoặc âm thanh lạ) → fMP4, nhưng âm thanh phải đóng gói được
            var fm = fmp4Segments(reader, { video: mp4.video, audio: a }, opts, 0), vc = codecOf(mp4.video), ac = a ? codecOf(a) : null;
            return {
                kind: 'video', fmt: 'fmp4', total: fm.total, init: fm.init, codecString: ac ? vc + ',' + ac : vc,
                codecs: { video: mp4.video.fourcc.trim(), audio: a ? a.fourcc.trim() : null },
                segments: function (skip) { return fmp4Segments(reader, { video: mp4.video, audio: a }, opts, skip || 0).gen(); }
            };
        }
        throw fail('Đuôi .' + ext + ' chưa hỗ trợ cắt thành m3u8 (hỗ trợ: mp3, aac, m4a, mp4, m4v, mov).');
    }
    function fileReader(file) {
        return { size: file.size, read: function (a, b) { return file.slice(a, b).arrayBuffer().then(function (ab) { return new Uint8Array(ab); }); } };
    }
    return { open: open, fileReader: fileReader, TsWriter: TsWriter, parseMp4: parseMp4, PID_VIDEO: PID_VIDEO, PID_AUDIO: PID_AUDIO };
});
