// services/code/hlsPlaylist.js — dựng playlist m3u8 (VOD) cho media đã cắt thành đoạn MPEG-TS.
//   • Bản LƯU trên GitHub (_media/<id>/index.m3u8): đường dẫn tương đối (seg00000.ts, key.bin).
//   • Bản PHỤC VỤ cho trình phát (previewServer): đường dẫn tuyệt đối trong /preview/<token>/... ;
//       - có entry.drm (video + âm thanh mới): đoạn mã hoá AES-128 (DRM chuẩn HLS), key.bin do Node trả (mở khoá 2 chiều từ json, đã kiểm quyền) → hls.js/Safari tự giải mã;
//         đoạn có thể là địa chỉ GitHub raw (trình duyệt tải thẳng) hoặc /preview (đường dự phòng qua máy chủ);
//       - âm thanh cũ (không có drm): đoạn MNHAENC1, Node giải mã khi trình phát xin từng đoạn → playlist không có EXT-X-KEY.
//   Video codec thế hệ mới (H.265 / AV1 / VP9) dùng đoạn fMP4: entry.segExt = 'm4s' → thêm EXT-X-MAP (init.mp4) + VERSION 7.
//   EXT-X-MAP đặt TRƯỚC EXT-X-KEY nên init.mp4 KHÔNG mã hoá (chỉ có cấu hình codec); các đoạn .m4s vẫn AES-128.
'use strict';

const segName = (i, ext) => 'seg' + String(i).padStart(5, '0') + '.' + (ext || 'ts');

/**
 * @param {{mode:'hls-video'|'hls-audio', durs:number[]}} entry
 * @param {{seg:(i:number)=>string, key?:string, init?:string}} urls
 */
function build(entry, urls) {
    const durs = entry.durs || [];
    const target = Math.max(1, Math.ceil(Math.max(0, ...durs)));
    const fmp4 = entry.segExt === 'm4s';
    const L = ['#EXTM3U', '#EXT-X-VERSION:' + (fmp4 ? 7 : 3), '#EXT-X-TARGETDURATION:' + target, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
    if (fmp4) L.push('#EXT-X-MAP:URI="' + urls.init + '"');
    if (entry.drm) L.push('#EXT-X-KEY:METHOD=AES-128,URI="' + urls.key + '"');      // IV mặc định = số thứ tự đoạn
    durs.forEach((d, i) => { L.push('#EXTINF:' + Number(d).toFixed(3) + ','); L.push(urls.seg(i)); });
    L.push('#EXT-X-ENDLIST');
    return L.join('\n') + '\n';
}
module.exports = { build, segName };
