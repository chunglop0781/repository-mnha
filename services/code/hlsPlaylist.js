// services/code/hlsPlaylist.js — dựng playlist m3u8 (VOD) cho media đã cắt thành đoạn MPEG-TS.
//   • Bản LƯU trên GitHub (_media/<id>/index.m3u8): đường dẫn tương đối (seg00000.ts, key.bin).
//   • Bản PHỤC VỤ cho trình phát (previewServer): đường dẫn tuyệt đối trong /preview/<token>/... ;
//       - video : đoạn .ts mã hoá AES-128 (DRM chuẩn HLS), key.bin do Node trả (giải mã 2 chiều từ json) → hls.js/Safari tự giải mã;
//       - âm thanh: đoạn .ts đã mã hoá 2 chiều (MNHAENC1), Node giải mã khi trình phát xin từng đoạn → playlist không có EXT-X-KEY.
'use strict';

const segName = (i) => 'seg' + String(i).padStart(5, '0') + '.ts';

/**
 * @param {{mode:'hls-video'|'hls-audio', durs:number[]}} entry
 * @param {{seg:(i:number)=>string, key?:string}} urls
 */
function build(entry, urls) {
    const durs = entry.durs || [];
    const target = Math.max(1, Math.ceil(Math.max(0, ...durs)));
    const L = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:' + target, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
    if (entry.mode === 'hls-video') L.push('#EXT-X-KEY:METHOD=AES-128,URI="' + urls.key + '"');      // IV mặc định = số thứ tự đoạn
    durs.forEach((d, i) => { L.push('#EXTINF:' + Number(d).toFixed(3) + ','); L.push(urls.seg(i)); });
    L.push('#EXT-X-ENDLIST');
    return L.join('\n') + '\n';
}
module.exports = { build, segName };
