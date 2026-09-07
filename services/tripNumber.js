import TripOrder from '../models/TripOrder.js';

// Generates the human trip key: TRP-2026-0001, numbered per account and per
// year. Never taken from the client — a trip number is the office's reference
// for a job, and letting a browser choose it invites collisions and gaps.
//
// The sequence restarts each calendar year, which is how the paperwork is
// filed: "the fourth trip of 2026" is a more useful reference than an
// ever-growing counter, and it matches how LR and invoice books are kept.

const PREFIX = 'TRP';
const PAD = 4;

// Highest number already issued to this account for this year, read off the
// existing rows rather than from a counter document.
//
// A counter would be one more collection to keep consistent, and would drift
// from reality the moment a trip is deleted or imported. Reading the maximum
// costs one indexed query on (owner, tripNumber) and is always right.
const nextSequence = async (accountId, year) => {
  const latest = await TripOrder.findOne({
    owner: accountId,
    tripNumber: new RegExp(`^${PREFIX}-${year}-\\d+$`)
  })
    .sort({ tripNumber: -1 }) // zero-padded, so lexical order is numeric order
    .select('tripNumber')
    .lean();

  if (!latest?.tripNumber) return 1;

  const parsed = Number(latest.tripNumber.split('-')[2]);
  return Number.isFinite(parsed) ? parsed + 1 : 1;
};

// Issues the next trip number for an account.
//
// Two dispatchers creating a trip in the same second would both read the same
// maximum and try to write the same number. The unique index on
// (owner, tripNumber) refuses the second one, so this retries on that
// collision rather than pre-locking anything — contention is rare enough that
// a handful of retries is cheaper than serialising every trip creation, and the
// index means a duplicate can never actually be stored.
//
// `create` is passed in so the caller stays in control of what the trip looks
// like: this function owns the number, not the record.
export const createWithTripNumber = async (accountId, create, { attempts = 5 } = {}) => {
  const year = new Date().getFullYear();

  for (let attempt = 0; attempt < attempts; attempt++) {
    const sequence = await nextSequence(accountId, year);
    const tripNumber = `${PREFIX}-${year}-${String(sequence).padStart(PAD, '0')}`;

    try {
      return await create(tripNumber);
    } catch (error) {
      // 11000 is the duplicate-key error: another request took this number
      // between our read and our write. Read again and take the next one.
      const isDuplicateTripNumber =
        error?.code === 11000 && JSON.stringify(error?.keyPattern || {}).includes('tripNumber');
      if (!isDuplicateTripNumber || attempt === attempts - 1) throw error;
    }
  }

  // Unreachable: the loop either returns or throws on its final attempt.
  throw new Error('Could not allocate a trip number');
};

// The number this account would issue next, for the create form to show before
// anything is saved. Explicitly a preview: it is not reserved, and the trip
// actually gets its number at save time.
export const previewTripNumber = async (accountId) => {
  const year = new Date().getFullYear();
  const sequence = await nextSequence(accountId, year);
  return `${PREFIX}-${year}-${String(sequence).padStart(PAD, '0')}`;
};
