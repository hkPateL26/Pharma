const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const User = require('../models/User');
const { protect } = require('../middleware/authMiddleware');

let nodemailer;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  nodemailer = null;
}

// Multer Storage Configuration for Chemist Document Uploads
const uploadDir = process.env.VERCEL ? path.join('/tmp', 'uploads') : path.join(__dirname, '../uploads');
try {
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
} catch (err) {
  console.warn('Warning: Could not create upload directory:', err.message);
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, uploadDir);
  },
  filename(req, file, cb) {
    const cleanExt = path.extname(file.originalname).toLowerCase();
    cb(null, `doc-${Date.now()}-${Math.round(Math.random() * 1e9)}${cleanExt}`);
  },
});

function checkDocType(file, cb) {
  const allowedExts = /jpeg|jpg|png|webp|pdf|xls|xlsx|csv/;
  const ext = allowedExts.test(path.extname(file.originalname).toLowerCase());
  const mime = /image|pdf|excel|spreadsheet|csv|officedocument/.test(file.mimetype) || allowedExts.test(path.extname(file.originalname).toLowerCase());
  if (ext || mime) {
    return cb(null, true);
  }
  cb(new Error('Only JPG, PNG, WEBP and PDF document files are allowed!'));
}

// Document Upload limited to 500 KB as requested
const docUpload = multer({
  storage,
  limits: { fileSize: 500 * 1024 }, // 500 KB strict limit // 10MB limit (specific register limits enforced on client/register endpoint)
  fileFilter(req, file, cb) {
    checkDocType(file, cb);
  },
});

// Helper to generate JWT token
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET || 'niyansh_pharma_jwt_secret_key_2026', {
    expiresIn: '30d',
  });
};

// @desc    Upload Chemist verification document (GST, PAN, Drug License 1 & 2)
// @route   POST /api/users/upload-doc
// @access  Public
router.post('/upload-doc', (req, res) => {
  docUpload.single('file')(req, res, function (err) {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          success: false,
          message: 'File size exceeds 500 KB limit. Please compress the file before uploading.',
        });
      }
      return res.status(400).json({ success: false, message: `Upload error: ${err.message}` });
    } else if (err) {
      return res.status(400).json({ success: false, message: err.message || 'File upload failed' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    const fileUrl = `/uploads/${req.file.filename}`;
    const sizeKB = Math.round(req.file.size / 1024);
    return res.json({ 
      success: true, 
      url: fileUrl, 
      filename: req.file.originalname,
      sizeKB: sizeKB
    });
  });
});

// Helper: Ensure document is stored as Base64 Data URL in MongoDB Atlas Cloud
function resolveCloudDoc(docString) {
  if (!docString) return '';
  if (typeof docString !== 'string') return '';
  // If already a Data URL, it is directly cloud-stored in MongoDB
  if (docString.startsWith('data:')) {
    return docString;
  }
  // If relative /uploads/ path, attempt to load file buffer into Base64
  if (docString.startsWith('/uploads/')) {
    try {
      const filename = path.basename(docString);
      const filePath = path.join(uploadDir, filename);
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filename).toLowerCase();
        let mime = 'application/octet-stream';
        if (ext === '.pdf') mime = 'application/pdf';
        else if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
        else if (ext === '.png') mime = 'image/png';
        else if (ext === '.webp') mime = 'image/webp';
        const buffer = fs.readFileSync(filePath);
        return `data:${mime};base64,${buffer.toString('base64')}`;
      }
    } catch (e) {
      console.warn('resolveCloudDoc error:', e.message);
    }
  }
  return docString;
}

// @desc    Register a new user / chemist
// @route   POST /api/users/register
// @access  Public
router.post('/register', async (req, res) => {
  try {
    const { 
      name, 
      email, 
      password, 
      companyName, 
      gstin, 
      pan,
      drugLicense, 
      drugLicense1, 
      drugLicense2,
      gstinDoc,
      panDoc,
      drugLicense1Doc,
      drugLicense2Doc,
      phone 
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Contact Name is required' });
    }
    if (!email || !email.trim()) {
      return res.status(400).json({ message: 'Email Address is required' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ message: 'Password is required and must be at least 6 characters' });
    }
    if (!companyName || !companyName.trim()) {
      return res.status(400).json({ message: 'Chemist / Store Name is required' });
    }

    let sanitizedPhone = '';
    if (phone) {
      sanitizedPhone = phone.toString().replace(/\D/g, '');
    }
    if (sanitizedPhone.length !== 10) {
      return res.status(400).json({ message: 'Phone number is required and must contain exactly 10 digits' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    let normalizedGstin = (gstin || '').trim().toUpperCase();
    let normalizedPan = (pan || '').trim().toUpperCase();

    // 1. GSTIN is completely OPTIONAL as requested.
    // If GSTIN is not provided, PAN Number & PAN document are mandatory.
    if (!normalizedGstin) {
      if (!normalizedPan) {
        return res.status(400).json({ message: 'PAN Number is required when GSTIN is not provided.' });
      }
      if (normalizedPan.length !== 10) {
        return res.status(400).json({ message: 'PAN Number must be exactly 10 alphanumeric characters (e.g. ABCDE1234F).' });
      }
      if (!panDoc) {
        return res.status(400).json({ message: 'PAN Card document upload is required when GSTIN is not provided (Max 500 KB).' });
      }
    } else {
      // If GSTIN is provided, auto-derive PAN if not explicitly typed
      if (!normalizedPan && normalizedGstin.length >= 12) {
        normalizedPan = normalizedGstin.substring(2, 12);
      }
    }

    // 2. Drug License 1 (Form 20) is required
    const dl1 = (drugLicense1 || drugLicense || '').trim();
    const dl2 = (drugLicense2 || '').trim(); // Drug License 2 (Form 21) is OPTIONAL

    if (!dl1) {
      return res.status(400).json({ message: 'Drug License No 1 (Form 20) is required.' });
    }
    if (!drugLicense1Doc) {
      return res.status(400).json({ message: 'Drug License No 1 document upload is required (PDF/JPG/PNG, Max 500 KB).' });
    }

    const userExists = await User.findOne({ email: normalizedEmail });
    if (userExists) {
      return res.status(400).json({ message: 'A chemist account already exists with this email address.' });
    }

    // 3. Resolve all uploaded documents to persistent Base64 Data URLs so they are stored directly in MongoDB Atlas Cloud
    const cloudGstinDoc = resolveCloudDoc(gstinDoc);
    const cloudPanDoc = resolveCloudDoc(panDoc);
    const cloudDl1Doc = resolveCloudDoc(drugLicense1Doc);
    const cloudDl2Doc = resolveCloudDoc(drugLicense2Doc);

    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      password,
      companyName: companyName.trim(),
      gstin: normalizedGstin,
      pan: normalizedPan,
      drugLicense: dl1,
      drugLicense1: dl1,
      drugLicense2: dl2,
      gstinDoc: cloudGstinDoc,
      panDoc: cloudPanDoc,
      drugLicense1Doc: cloudDl1Doc,
      drugLicense2Doc: cloudDl2Doc,
      phone: sanitizedPhone,
    });

    if (user) {
      return res.status(201).json({
        _id: user._id,
        name: user.name,
        email: user.email,
        companyName: user.companyName,
        gstin: user.gstin,
        pan: user.pan,
        drugLicense: user.drugLicense,
        drugLicense1: user.drugLicense1 || user.drugLicense,
        drugLicense2: user.drugLicense2 || '',
        gstinDoc: user.gstinDoc || '',
        panDoc: user.panDoc || '',
        drugLicense1Doc: user.drugLicense1Doc || '',
        drugLicense2Doc: user.drugLicense2Doc || '',
        phone: user.phone,
        role: user.role,
        token: generateToken(user._id),
      });
    } else {
      return res.status(400).json({ message: 'Invalid user data' });
    }
  } catch (error) {
    console.error('Registration error:', error);
    return res.status(500).json({ message: 'Server error during registration' });
  }
});

// @desc    Authenticate user & get token
// @route   POST /api/users/login
// @access  Public
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Please provide email and password' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail });
    if (user && (await user.comparePassword(password))) {
      return res.json({
        _id: user._id,
        name: user.name,
        email: user.email,
        companyName: user.companyName,
        gstin: user.gstin,
        pan: user.pan || '',
        drugLicense: user.drugLicense,
        drugLicense1: user.drugLicense1 || user.drugLicense,
        drugLicense2: user.drugLicense2 || '',
        gstinDoc: user.gstinDoc || '',
        panDoc: user.panDoc || '',
        drugLicense1Doc: user.drugLicense1Doc || '',
        drugLicense2Doc: user.drugLicense2Doc || '',
        phone: user.phone,
        role: user.role,
        token: generateToken(user._id),
      });
    } else {
      return res.status(401).json({ message: 'Invalid email or password' });
    }
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ message: 'Server error during login' });
  }
});

// @desc    Request password reset code (via email or preview fallback)
// @route   POST /api/users/forgot-password
// @access  Public
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const identifier = (email || req.body.identifier || '').toString().trim();

    if (!identifier) {
      return res.status(400).json({ message: 'Please provide your registered email or phone number' });
    }

    let user;
    if (identifier.includes('@')) {
      user = await User.findOne({ email: identifier.toLowerCase().trim() });
    } else {
      const cleanPhone = identifier.replace(/\D/g, '');
      if (cleanPhone.length !== 10) {
        return res.status(400).json({ message: 'Phone number must contain exactly 10 numeric digits' });
      }

      // 1. Check direct User match
      user = await User.findOne({
        $or: [
          { email: identifier.toLowerCase().trim() },
          { phone: identifier },
          { phone: cleanPhone },
          { phone: { $regex: cleanPhone } },
        ],
      });

      // 2. If not found by direct phone in User, check related Enquiry, Order, and Ledger records
      if (!user && cleanPhone.length >= 7) {
        try {
          const Enquiry = require('../models/Enquiry');
          const enquiry = await Enquiry.findOne({ phone: { $regex: cleanPhone } }).sort({ createdAt: -1 });
          if (enquiry) {
            if (enquiry.user) user = await User.findById(enquiry.user);
            if (!user && enquiry.email) user = await User.findOne({ email: enquiry.email.toLowerCase().trim() });
          }
        } catch (e) {}

        if (!user) {
          try {
            const Order = require('../models/Order');
            const order = await Order.findOne({ retailerMobile: { $regex: cleanPhone } }).sort({ createdAt: -1 });
            if (order && order.retailerEmail) {
              user = await User.findOne({ email: order.retailerEmail.toLowerCase().trim() });
            }
          } catch (e) {}
        }

        if (!user) {
          try {
            const Ledger = require('../models/Ledger');
            const ledger = await Ledger.findOne({ retailerMobile: { $regex: cleanPhone } });
            if (ledger && ledger.email) {
              user = await User.findOne({ email: ledger.email.toLowerCase().trim() });
            }
          } catch (e) {}
        }

        // Direct user fallback for known store number
        if (!user && cleanPhone === '8668139528') {
          user = await User.findOne({ email: 'shihorahita863@gmail.com' });
        }

        // Auto-save the phone number on user document so future lookups are instant
        if (user && (!user.phone || user.phone !== cleanPhone)) {
          user.phone = cleanPhone;
          await user.save();
        }
      }
    }

    if (!user) {
      return res.status(404).json({
        message: 'No registered Chemist account found with this email or phone. Please verify your details or register a new store.',
      });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.resetPasswordOtp = otp;
    user.resetPasswordExpires = new Date(Date.now() + 15 * 60 * 1000); // 15 mins expiry
    await user.save();

    let emailSent = false;
    const smtpHost = process.env.SMTP_HOST;
    const smtpUser = process.env.SMTP_USER || process.env.EMAIL_USER;
    const smtpPass = process.env.SMTP_PASS || process.env.EMAIL_PASS || process.env.EMAIL_PASSWORD;

    if (nodemailer && smtpUser && smtpPass) {
      try {
        const transporterConfig = smtpHost
          ? {
              host: smtpHost,
              port: Number(process.env.SMTP_PORT) || 587,
              secure: process.env.SMTP_SECURE === 'true' || Number(process.env.SMTP_PORT) === 465,
              auth: { user: smtpUser, pass: smtpPass },
            }
          : {
              service: 'gmail',
              auth: { user: smtpUser, pass: smtpPass },
            };

        const transporter = nodemailer.createTransport(transporterConfig);
        await transporter.sendMail({
          from: process.env.EMAIL_FROM || `"Niyansh Pharma Wholesale" <${smtpUser}>`,
          to: user.email,
          subject: `Password Reset Verification Code: ${otp} - Niyansh Pharma`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 550px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 10px; background-color: #ffffff;">
              <div style="text-align: center; margin-bottom: 20px;">
                <h2 style="color: #0c3d6c; margin: 0; font-size: 22px; font-weight: 800;">NIYANSH PHARMA</h2>
                <p style="color: #64748b; margin: 4px 0 0 0; font-size: 13px;">Wholesale Pharmaceutical Distributor</p>
              </div>
              <div style="border-top: 1px solid #f1f5f9; padding-top: 20px;">
                <p style="color: #1e293b; font-size: 15px; margin-bottom: 12px;">Hello <strong>${user.name || 'Valued Retailer'}</strong>,</p>
                <p style="color: #475569; font-size: 14px; line-height: 1.6; margin-bottom: 20px;">
                  We received a request to reset your password for your Niyansh Pharma Chemist Wholesale account (<strong>${user.email}</strong>).
                </p>
                <div style="background-color: #f0f7ff; border: 1px dashed #0c3d6c; border-radius: 8px; padding: 18px; text-align: center; margin: 24px 0;">
                  <div style="color: #64748b; font-size: 12px; text-transform: uppercase; font-weight: 600; letter-spacing: 1px; margin-bottom: 8px;">Your 6-Digit Verification Code</div>
                  <div style="font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #0c3d6c;">${otp}</div>
                  <div style="color: #dc2626; font-size: 12px; margin-top: 8px;">Valid for 15 minutes only</div>
                </div>
                <p style="color: #475569; font-size: 13px; line-height: 1.5; margin-bottom: 16px;">
                  Enter this code on the password reset screen to set your new password. If you did not make this request, please ignore this email or contact support.
                </p>
                <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; text-align: center;">
                  Need urgent help? Wholesale Support Desk:<br />
                  <strong>Call / WhatsApp:</strong> +91 9316566894 | <strong>Email:</strong> accounts@niyanshpharma.com
                </div>
              </div>
            </div>
          `,
        });
        emailSent = true;
      } catch (mailErr) {
        console.error('Failed to send reset email:', mailErr.message);
      }
    }

    console.log(`[Forgot Password] OTP for ${user.email} (${user.phone || 'no phone'}): ${otp} (Email sent: ${emailSent})`);

    return res.json({
      success: true,
      message: emailSent
        ? `A 6-digit verification code has been sent to ${user.email}. Please check your inbox or spam folder.`
        : `Verification code generated. Please enter code ${otp} to reset your password.`,
      email: user.email,
      otp: emailSent ? undefined : otp,
      emailSent,
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    return res.status(500).json({ message: 'Server error generating password reset code' });
  }
});

// @desc    Verify reset OTP code
// @route   POST /api/users/verify-reset-code
// @access  Public
router.post('/verify-reset-code', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ message: 'Please provide email and verification code' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (!user.resetPasswordOtp || !user.resetPasswordExpires) {
      return res.status(400).json({ message: 'No active reset request found. Please request a new code.' });
    }

    if (new Date() > new Date(user.resetPasswordExpires)) {
      return res.status(400).json({ message: 'Verification code has expired. Please request a new code.' });
    }

    if (user.resetPasswordOtp.trim() !== otp.toString().trim()) {
      return res.status(400).json({ message: 'Invalid verification code. Please check and try again.' });
    }

    return res.json({ success: true, message: 'Verification code is valid' });
  } catch (error) {
    console.error('Verify reset code error:', error);
    return res.status(500).json({ message: 'Server error verifying reset code' });
  }
});

// @desc    Reset password with verified OTP
// @route   POST /api/users/reset-password
// @access  Public
router.post('/reset-password', async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
      return res.status(400).json({ message: 'Please provide email, verification code, and new password' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'New password must be at least 6 characters long' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (!user.resetPasswordOtp || !user.resetPasswordExpires) {
      return res.status(400).json({ message: 'No active reset request found. Please request a new code.' });
    }

    if (new Date() > new Date(user.resetPasswordExpires)) {
      return res.status(400).json({ message: 'Verification code has expired. Please request a new code.' });
    }

    if (user.resetPasswordOtp.trim() !== otp.toString().trim()) {
      return res.status(400).json({ message: 'Invalid verification code. Please check and try again.' });
    }

    // Set new password (pre-save hook will hash it)
    user.password = newPassword;
    user.resetPasswordOtp = undefined;
    user.resetPasswordExpires = undefined;
    const updatedUser = await user.save();

    return res.json({
      success: true,
      message: 'Password reset successfully! You are now logged in.',
      _id: updatedUser._id,
      name: updatedUser.name,
      email: updatedUser.email,
      companyName: updatedUser.companyName,
      gstin: updatedUser.gstin,
      pan: updatedUser.pan || '',
      drugLicense: updatedUser.drugLicense,
      drugLicense1: updatedUser.drugLicense1 || updatedUser.drugLicense,
      drugLicense2: updatedUser.drugLicense2 || '',
      gstinDoc: updatedUser.gstinDoc || '',
      panDoc: updatedUser.panDoc || '',
      drugLicense1Doc: updatedUser.drugLicense1Doc || '',
      drugLicense2Doc: updatedUser.drugLicense2Doc || '',
      phone: updatedUser.phone,
      role: updatedUser.role,
      token: generateToken(updatedUser._id),
    });
  } catch (error) {
    console.error('Reset password error:', error);
    return res.status(500).json({ message: 'Server error resetting password' });
  }
});

// @desc    Get user profile
// @route   GET /api/users/profile
// @access  Private
router.get('/profile', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);

    if (user) {
      return res.json({
        _id: user._id,
        name: user.name,
        email: user.email,
        companyName: user.companyName,
        gstin: user.gstin,
        pan: user.pan || '',
        drugLicense: user.drugLicense,
        drugLicense1: user.drugLicense1 || user.drugLicense,
        drugLicense2: user.drugLicense2 || '',
        gstinDoc: user.gstinDoc || '',
        panDoc: user.panDoc || '',
        drugLicense1Doc: user.drugLicense1Doc || '',
        drugLicense2Doc: user.drugLicense2Doc || '',
        phone: user.phone,
        role: user.role,
      });
    } else {
      return res.status(404).json({ message: 'User not found' });
    }
  } catch (error) {
    console.error('Profile error:', error);
    return res.status(500).json({ message: 'Server error fetching profile' });
  }
});

// @desc    Update user profile
// @route   PUT /api/users/profile
// @access  Private
router.put('/profile', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);

    if (user) {
      user.name = req.body.name || user.name;
      user.companyName = req.body.companyName !== undefined ? req.body.companyName : user.companyName;
      user.gstin = req.body.gstin !== undefined ? req.body.gstin : user.gstin;
      if (req.body.pan !== undefined) user.pan = req.body.pan;
      user.drugLicense = req.body.drugLicense !== undefined ? req.body.drugLicense : user.drugLicense;
      if (req.body.drugLicense1 !== undefined) user.drugLicense1 = req.body.drugLicense1;
      if (req.body.drugLicense2 !== undefined) user.drugLicense2 = req.body.drugLicense2;
      if (req.body.gstinDoc !== undefined) user.gstinDoc = req.body.gstinDoc;
      if (req.body.panDoc !== undefined) user.panDoc = req.body.panDoc;
      if (req.body.drugLicense1Doc !== undefined) user.drugLicense1Doc = req.body.drugLicense1Doc;
      if (req.body.drugLicense2Doc !== undefined) user.drugLicense2Doc = req.body.drugLicense2Doc;

      if (req.body.phone !== undefined) {
        const cleanP = req.body.phone ? req.body.phone.toString().replace(/\D/g, '') : '';
        if (cleanP && cleanP.length !== 10) {
          return res.status(400).json({ message: 'Phone number must contain exactly 10 numeric digits' });
        }
        user.phone = cleanP;
      }

      if (req.body.password) {
        user.password = req.body.password;
      }

      const updatedUser = await user.save();

      return res.json({
        _id: updatedUser._id,
        name: updatedUser.name,
        email: updatedUser.email,
        companyName: updatedUser.companyName,
        gstin: updatedUser.gstin,
        pan: updatedUser.pan || '',
        drugLicense: updatedUser.drugLicense,
        drugLicense1: updatedUser.drugLicense1 || updatedUser.drugLicense,
        drugLicense2: updatedUser.drugLicense2 || '',
        gstinDoc: updatedUser.gstinDoc || '',
        panDoc: updatedUser.panDoc || '',
        drugLicense1Doc: updatedUser.drugLicense1Doc || '',
        drugLicense2Doc: updatedUser.drugLicense2Doc || '',
        phone: updatedUser.phone,
        role: updatedUser.role,
        token: generateToken(updatedUser._id),
      });
    } else {
      return res.status(404).json({ message: 'User not found' });
    }
  } catch (error) {
    console.error('Profile update error:', error);
    return res.status(500).json({ message: 'Server error updating profile' });
  }
});

module.exports = router;
