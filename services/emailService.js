import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

// Create transporter with env vars
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: parseInt(process.env.EMAIL_PORT || '465'),
  secure: process.env.EMAIL_SECURE === 'true',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  },
  logger: true,
  debug: true
});

console.log('📧 Email service initialized with:');
console.log('   HOST:', process.env.EMAIL_HOST);
console.log('   PORT:', process.env.EMAIL_PORT);
console.log('   SECURE:', process.env.EMAIL_SECURE);

// Send OTP email
export const sendOTPEmail = async (email, name, otp) => {
  const mailOptions = {
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to: email,
    subject: 'TrackOwl - Password Reset OTP',
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Inter, Arial, sans-serif; background-color: #f9fafb; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .card { background: white; border-radius: 8px; padding: 40px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
            .header { text-align: center; margin-bottom: 30px; }
            .logo { font-size: 24px; font-weight: 700; color: #1f2937; }
            .logo span { color: #f59e0b; }
            .content { color: #374151; line-height: 1.6; }
            .otp-box { background: #f0fdf4; border: 2px solid #bbf7d0; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center; }
            .otp-code { font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #166534; font-family: monospace; }
            .footer { font-size: 12px; color: #9ca3af; text-align: center; margin-top: 30px; border-top: 1px solid #e5e7eb; padding-top: 20px; }
            .warning { color: #dc2626; font-size: 12px; margin-top: 10px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="card">
              <div class="header">
                <div class="logo">🦉 Track<span>Owl</span></div>
              </div>
              <div class="content">
                <p>Hi ${name},</p>
                <p>We received a request to reset your TrackOwl account password. Use the following 6-digit code to proceed:</p>
                <div class="otp-box">
                  <div class="otp-code">${otp}</div>
                  <p style="margin: 10px 0 0 0; color: #666;">Valid for 10 minutes</p>
                </div>
                <p><strong>Never share this code with anyone.</strong> Our support team will never ask for your OTP.</p>
                <p>If you didn't request this password reset, please ignore this email or contact support immediately.</p>
                <div class="footer">
                  <p>© 2026 TrackOwl. All rights reserved.</p>
                  <p style="color: #dc2626;">This OTP will expire in 10 minutes.</p>
                </div>
              </div>
            </div>
          </div>
        </body>
      </html>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    return true;
  } catch (error) {
    console.error('Email sending error:', error);
    throw new Error('Failed to send OTP email');
  }
};

// Verify transporter
export const verifyEmailService = async () => {
  try {
    await transporter.verify();
    console.log('Email service is ready');
    return true;
  } catch (error) {
    console.error('Email service verification failed:', error);
    return false;
  }
};
