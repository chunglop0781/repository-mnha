const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
            maxlength: 100
        },

        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true,
            index: true
        },

        password: {
            type: String,
            required: true,
            select: false
        },

        // ====================================================
        // ROLE — mặc định là CLIENT khi đăng ký mới
        //   - client : vừa đăng ký, chờ admin duyệt
        //   - student: đã được duyệt
        //   - admin  : quản trị viên
        // ====================================================
        role: {
            type: String,
            enum: ['admin', 'student', 'client'],   // ← thêm 'client'
            default: 'client',                       // ← đổi từ 'student'
            index: true
        },

        // ====================================================
        // STATUS — mặc định PENDING chờ duyệt
        //   - pending  : chờ admin duyệt
        //   - approved : đã duyệt (dùng cùng với role=student)
        //   - rejected : bị từ chối
        //   - disabled : bị vô hiệu hoá
        // ====================================================
        status: {
            type: String,
            enum: ['pending', 'approved', 'rejected', 'disabled'],
            default: 'pending',
            index: true
        },

        // ====================================================
        // ĐA TỔ CHỨC (user_key)
        //   - userKey: tổ chức gốc. null = tổ chức "default".
        //     Được gắn lúc đăng ký (nhập mã tổ chức) và bị CỐ ĐỊNH
        //     khi admin user_key duyệt — chỉ admin default mới đổi được.
        //   - connectedUserKeys: chỉ dùng cho student — các tổ chức
        //     student TỰ kết nối thêm bằng code. Không chứa userKey gốc.
        // ====================================================
        userKey: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'UserKey',
            default: null,
            index: true
        },

        connectedUserKeys: {
            type: [
                {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: 'UserKey'
                }
            ],
            default: []
        },

        avatar: {
            type: String,
            default: null
        },

        resetPasswordToken: {
            type: String,
            default: null
        },

        resetPasswordExpires: {
            type: Date,
            default: null
        },

        lastLoginAt: {
            type: Date,
            default: null
        },

        approvedAt: {
            type: Date,
            default: null
        },

        approvedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null
        },

        // ====================================================
        // QUYỀN SỬA LAYOUT (giao diện của tổ chức)
        //   - Chỉ admin default mới đổi được (route layout-permission).
        //   - Chỉ có nghĩa với role=admin + userKey != null.
        //   - KHÔNG nhận từ body đăng ký / form hồ sơ.
        // ====================================================
        canEditLayout: {
            type: Boolean,
            default: false
        }
    },
    {
        timestamps: true
    }
);

// Trang duyệt user của admin user_key: lọc theo tổ chức + role + trạng thái
userSchema.index({ userKey: 1, role: 1, status: 1 });

module.exports = mongoose.model('User', userSchema);