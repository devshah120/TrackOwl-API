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

// Shared wrapper so every trip email has the same TrackOwl look.
const tripEmailLayout = (name, headline, accentColor, bodyRows, note) => `
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
        .headline { font-size: 20px; font-weight: 700; color: ${accentColor}; margin: 0 0 20px 0; }
        .details { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 20px 0; }
        .details table { width: 100%; border-collapse: collapse; }
        .details td { padding: 6px 0; color: #374151; vertical-align: top; }
        .details td.label { color: #6b7280; width: 130px; font-size: 13px; }
        .footer { font-size: 12px; color: #9ca3af; text-align: center; margin-top: 30px; border-top: 1px solid #e5e7eb; padding-top: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="card">
          <div class="header">
            <div class="logo">🦉 Track<span>Owl</span></div>
          </div>
          <div class="content">
            <p class="headline">${headline}</p>
            <p>Hi ${name},</p>
            ${note}
            <div class="details">
              <table>${bodyRows}</table>
            </div>
            <div class="footer">
              <p>© 2026 TrackOwl. All rights reserved.</p>
            </div>
          </div>
        </div>
      </div>
    </body>
  </html>
`;

// Build the "From / To / Vehicle / Distance" rows shared by both trip emails.
const tripDetailRows = (trip, deviceName) => {
  const distance = Number.isFinite(trip.distanceKm) ? `${trip.distanceKm.toFixed(1)} km` : '—';
  const duration = Number.isFinite(trip.durationMin) ? `${Math.round(trip.durationMin)} min` : '—';
  const rows = [
    ['Vehicle', deviceName || '—'],
    ['From', trip.origin?.name || '—'],
    ['To', trip.destination?.name || '—'],
    ['Distance', distance],
    ['Est. duration', duration]
  ];
  if (trip.note) rows.push(['Note', trip.note]);
  return rows
    .map(([label, value]) => `<tr><td class="label">${label}</td><td>${value}</td></tr>`)
    .join('');
};

// Send an email when a new trip is created.
export const sendTripCreatedEmail = async (email, name, trip, deviceName) => {
  const mailOptions = {
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to: email,
    subject: `TrackOwl - New trip created${deviceName ? ` for ${deviceName}` : ''}`,
    html: tripEmailLayout(
      name,
      '🚚 New Trip Created',
      '#2563eb',
      tripDetailRows(trip, deviceName),
      '<p>A new trip has been planned on your TrackOwl account. Here are the details:</p>'
    )
  };

  try {
    await transporter.sendMail(mailOptions);
    return true;
  } catch (error) {
    console.error('Trip created email error:', error);
    return false;
  }
};

// Send an email when a trip is marked completed.
export const sendTripCompletedEmail = async (email, name, trip, deviceName) => {
  const mailOptions = {
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to: email,
    subject: `TrackOwl - Trip completed${deviceName ? ` for ${deviceName}` : ''}`,
    html: tripEmailLayout(
      name,
      '✅ Trip Completed',
      '#16a34a',
      tripDetailRows(trip, deviceName),
      '<p>The following trip has been marked as completed:</p>'
    )
  };

  try {
    await transporter.sendMail(mailOptions);
    return true;
  } catch (error) {
    console.error('Trip completed email error:', error);
    return false;
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
