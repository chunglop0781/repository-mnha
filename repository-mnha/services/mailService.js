// services/mailService.js — gửi OTP đăng ký bằng SMTP (cùng biến MAIL_* với dự án cũ)
'use strict';
const nodemailer = require('nodemailer');
const { MAIL_USER, MAIL_PASS, MAIL_HOST, MAIL_PORT, MAIL_SECURE, MAIL_FROM } = process.env;

let transporter = null;
function get() {
    if (!transporter) {
        transporter = nodemailer.createTransport({
            host: MAIL_HOST || 'smtp.gmail.com', port: Number(MAIL_PORT) || 465, secure: MAIL_SECURE !== 'false',
            auth: { user: MAIL_USER, pass: MAIL_PASS }, connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000
        });
    }
    return transporter;
}
const configured = () => !!(MAIL_USER && MAIL_PASS);

async function sendOTP(to, code) {
    if (!configured()) throw new Error('Chưa cấu hình MAIL_USER / MAIL_PASS');
    await get().sendMail({
        from: MAIL_FROM || `"repository-mnha" <${MAIL_USER}>`, to,
        subject: `Mã xác minh đăng ký: ${code}`,
        text: `Mã OTP của bạn là ${code}. Mã có hiệu lực 10 phút.`,
        html: `<p>Mã OTP của bạn là <b style="font-size:20px;letter-spacing:3px">${code}</b></p><p>Mã có hiệu lực 10 phút.</p>`
    });
}
module.exports = { sendOTP, configured };
