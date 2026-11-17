// test/_enc.js — giúp test mã hoá phần file Ở "TRÌNH DUYỆT": dùng ĐÚNG mã của trang (public/js/mnhaFiles.js encryptPart, WebCrypto), không phải mã máy chủ.
//   enc(init, plain, i[, over]) — init = kết quả init (có key + salt, base64)  → Buffer 1 phần MNHAENC1
// Nạp mnhaFiles.js LƯỜI (lúc gọi) để test giả lập `window` trước rồi mới nạp thì trang vẫn gắn được window.MnhaFiles.
const lib = () => require('../public/js/mnhaFiles.js');
exports.enc = async (init, plain, i, over) => {
  const M = lib(), o = Object.assign({ key: init.key, salt: init.salt }, over || {});
  const key = await M.importEncryptKey(o.key);
  return Buffer.from(await M.encryptPart(key, M.b64ToBytes(o.salt), new Uint8Array(plain), i));
};
