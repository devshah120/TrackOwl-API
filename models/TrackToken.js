import mongoose from 'mongoose';
import crypto from 'crypto';

// A short-lived, unauthenticated share link for one device: /track/<token>.
// Only the SHA-256 hash of the token is stored, so read access to this
// collection does not yield working links. The raw token is returned exactly
// once, at creation time.
const trackTokenSchema = new mongoose.Schema({
  tokenHash: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  device: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Device',
    required: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  label: {
    type: String,
    trim: true,
    default: ''
  },
  expiresAt: {
    type: Date,
    required: true
  },
  revokedAt: Date,
  lastViewedAt: Date,
  viewCount: {
    type: Number,
    default: 0
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Let MongoDB delete expired tokens on its own.
trackTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

trackTokenSchema.statics.hash = function (rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
};

// Returns { rawToken, doc } — rawToken is never persisted.
trackTokenSchema.statics.issue = async function ({ device, createdBy, ttlMinutes = 60, label = '' }) {
  const rawToken = crypto.randomBytes(24).toString('base64url');
  const doc = await this.create({
    tokenHash: this.hash(rawToken),
    device,
    createdBy,
    label,
    expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000)
  });
  return { rawToken, doc };
};

trackTokenSchema.methods.isUsable = function () {
  return !this.revokedAt && this.expiresAt.getTime() > Date.now();
};

export default mongoose.model('TrackToken', trackTokenSchema);
