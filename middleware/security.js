// Request-level hardening that needs no extra dependency: a small in-memory
// rate limiter for the sign-in and recovery endpoints, and the standard
// security response headers.
//
// The limiter is per process. On a single API instance (the current
// deployment) that is exact; behind several instances each keeps its own
// count, which still caps an attacker at N × the limit — acceptable until the
// API is scaled out, at which point this should move to Redis.

const buckets = new Map(); // key -> { count, resetAt }

// Drop expired buckets once a minute so the map cannot grow without bound
// under a spray of distinct IPs.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}, 60 * 1000).unref();

const clientIp = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

/**
 * rateLimit({ windowMs, max, keyBy, message })
 *
 * `keyBy` picks what a "client" is. Sign-in keys on IP *and* the email being
 * tried, so one office behind a shared NAT does not lock itself out, while a
 * password-guessing run against one account is still stopped from any IP.
 */
export const rateLimit = ({ windowMs, max, keyBy = clientIp, message, name = 'limit' }) => (req, res, next) => {
  const key = `${name}:${keyBy(req)}`;
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;

  res.setHeader('RateLimit-Limit', String(max));
  res.setHeader('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));

  if (bucket.count > max) {
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({
      success: false,
      error: message || `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`
    });
  }
  next();
};

const emailOf = (req) => String(req.body?.email || '').trim().toLowerCase();

// Ten sign-in attempts per IP+email per 15 minutes, and a looser ceiling per IP
// alone so one address cannot walk through a list of accounts.
export const loginLimiter = [
  rateLimit({ name: 'login-ip', windowMs: 15 * 60 * 1000, max: 50 }),
  rateLimit({
    name: 'login',
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyBy: (req) => `${clientIp(req)}:${emailOf(req)}`,
    message: 'Too many sign-in attempts for this account. Wait 15 minutes and try again.'
  })
];

// OTP and password reset: an OTP is six digits, so guessing has to be capped
// hard or it is brute-forceable.
export const recoveryLimiter = rateLimit({
  name: 'recovery',
  windowMs: 15 * 60 * 1000,
  max: 8,
  keyBy: (req) => `${clientIp(req)}:${emailOf(req)}`,
  message: 'Too many attempts. Wait 15 minutes before requesting or entering another code.'
});

export const registerLimiter = rateLimit({ name: 'register', windowMs: 60 * 60 * 1000, max: 10 });

// Standard security headers. No Content-Security-Policy here: the frontend is
// served separately and loads Google Maps, whose script and tile hosts change;
// a CSP belongs in the web server config next to the HTML it protects.
export const securityHeaders = (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(self), microphone=()');
  res.removeHeader('X-Powered-By');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
};
