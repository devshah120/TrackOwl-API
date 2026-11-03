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

// Escapes text going into the alert digest's HTML. Alert messages carry
// vehicle numbers, geofence names and driver names typed by users.
const escapeHtml = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SEVERITY_COLOURS = { critical: '#dc2626', warning: '#d97706', info: '#2563eb' };

// One email listing the new alerts for an account, sent by the scheduler
// (services/scheduler.js) — a digest, so a burst of overspeed alerts is one
// mail, not twenty.
export const sendAlertDigestEmail = async (recipients, companyName, alerts, appUrl = '') => {
  if (!recipients?.length || !alerts?.length) return false;
  const rows = alerts
    .map(
      (a) => `<tr>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;"><span style="color:${SEVERITY_COLOURS[a.severity] || '#374151'};font-weight:600;text-transform:capitalize;">${escapeHtml(a.severity || 'info')}</span></td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;"><strong>${escapeHtml(a.title)}</strong><br><span style="color:#4b5563;">${escapeHtml(a.message)}</span></td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;color:#6b7280;white-space:nowrap;">${escapeHtml(new Date(a.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))}</td>
      </tr>`
    )
    .join('');
  const critical = alerts.filter((a) => a.severity === 'critical').length;
  const mailOptions = {
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to: recipients.join(', '),
    subject: `TrackOwl - ${alerts.length} new alert${alerts.length === 1 ? '' : 's'}${critical ? ` (${critical} critical)` : ''}${companyName ? ` · ${companyName}` : ''}`,
    html: `<!DOCTYPE html><html><body style="font-family:Inter,Arial,sans-serif;background:#f9fafb;padding:20px;">
      <div style="max-width:680px;margin:0 auto;background:#fff;border-radius:8px;padding:24px;">
        <h2 style="margin:0 0 4px;color:#111827;">Track<span style="color:#2563eb;">Owl</span> alerts</h2>
        <p style="color:#4b5563;margin:0 0 16px;">${alerts.length} new alert${alerts.length === 1 ? '' : 's'} on ${escapeHtml(companyName || 'your account')}.</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">${rows}</table>
        ${appUrl ? `<p style="margin-top:20px;"><a href="${escapeHtml(appUrl)}/alerts" style="color:#2563eb;">Open alerts in TrackOwl</a></p>` : ''}
        <p style="color:#9ca3af;font-size:12px;margin-top:20px;">Change who gets these under Alerts &amp; Geofences → Alert Settings.</p>
      </div></body></html>`
  };
  try {
    await transporter.sendMail(mailOptions);
    return true;
  } catch (error) {
    console.error('Alert digest email error:', error.message);
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
