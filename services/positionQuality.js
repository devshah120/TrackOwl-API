import { distanceMeters, isPlausibleCoordinate } from '../utils/geo.js';

// Decides whether an incoming GPS fix can be trusted. Every packet is still
// stored — a rejected fix is evidence about the device, and deleting it would
// hide a faulty unit — but a rejected one is saved with `valid: false`, which
// every trail, history and replay query already filters out, and it never
// becomes the vehicle's "current" position.
//
// The rules, in the order they are checked:
//
//   1. The tracker itself flagged the fix invalid (no satellite lock).
//   2. The coordinates are impossible or the (0, 0) "no fix" placeholder.
//   3. The device clock is far in the future. A module with a flat RTC battery
//      reports 2080; a fix from the future would sort ahead of every real one
//      and freeze the live position on a stale point.
//   4. Reaching it from the previous good fix needs an impossible speed — the
//      classic multipath "jump" to the other side of town and back.

// Tolerance for device clock drift before a timestamp counts as "the future".
export const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;

// No road vehicle averages this between two fixes. High enough that a genuine
// fast stretch of expressway, measured over a short interval with ordinary GPS
// noise, never trips it.
export const MAX_IMPLIED_KMH = 200;

// Jumps shorter than this are never rejected, whatever speed they imply: two
// fixes a second apart with 30 m of scatter "imply" 108 km/h without anything
// being wrong.
const MIN_JUMP_METERS = 500;

// The jump check only compares against a recent fix. If the last accepted fix
// was itself a bad one that slipped through, comparing against it forever would
// reject every genuine fix after it; bounding the window means the worst case is
// a few minutes of lost trail, after which the device re-anchors.
const JUMP_WINDOW_MS = 5 * 60 * 1000;

/**
 * @param {object} fix   { latitude, longitude, fixTime, valid }
 * @param {object|null} previous  the last *valid* stored fix for the device
 * @returns {{ valid: boolean, reason: string }}
 */
export const assessFix = (fix, previous = null, now = Date.now()) => {
  if (fix.valid === false) return { valid: false, reason: 'device_invalid' };

  if (!isPlausibleCoordinate(fix.latitude, fix.longitude)) {
    return { valid: false, reason: 'bad_coordinates' };
  }

  if (fix.fixTime.getTime() - now > MAX_FUTURE_SKEW_MS) {
    return { valid: false, reason: 'future_timestamp' };
  }

  if (previous?.fixTime) {
    const meters = distanceMeters(previous.latitude, previous.longitude, fix.latitude, fix.longitude);
    const gapMs = Math.abs(fix.fixTime.getTime() - new Date(previous.fixTime).getTime());
    const seconds = gapMs / 1000;
    if (gapMs <= JUMP_WINDOW_MS && meters > MIN_JUMP_METERS) {
      // A zero interval with a real distance is the same jump at infinite speed.
      const impliedKmh = seconds > 0 ? (meters / seconds) * 3.6 : Infinity;
      if (impliedKmh > MAX_IMPLIED_KMH) return { valid: false, reason: 'impossible_jump' };
    }
  }

  return { valid: true, reason: '' };
};
