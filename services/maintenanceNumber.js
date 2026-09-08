import RepairRequest from '../models/RepairRequest.js';

// Generates the human repair key: REP-2026-0001, numbered per account and per
// year. The same arrangement as services/tripNumber.js, and for the same
// reasons — see the note there about why the sequence is read off the rows
// rather than kept in a counter document.
//
// A repair needs a spoken reference more than most records here: the driver
// who reported the fault, the workshop doing the work and the office chasing
// it are three parties who never see the same screen, and "REP-2026-0042" is
// what they can say to each other.

const PREFIX = 'REP';
const PAD = 4;

const nextSequence = async (accountId, year) => {
  const latest = await RepairRequest.findOne({
    owner: accountId,
    requestNumber: new RegExp(`^${PREFIX}-${year}-\\d+$`)
  })
    .sort({ requestNumber: -1 }) // zero-padded, so lexical order is numeric order
    .select('requestNumber')
    .lean();

  if (!latest?.requestNumber) return 1;

  const parsed = Number(latest.requestNumber.split('-')[2]);
  return Number.isFinite(parsed) ? parsed + 1 : 1;
};

// Issues the next repair number for an account, retrying on the unique-index
// collision two simultaneous creates would cause.
//
// `create` is passed in so the caller stays in control of what the request
// looks like: this function owns the number, not the record.
export const createWithRequestNumber = async (accountId, create, { attempts = 5 } = {}) => {
  const year = new Date().getFullYear();

  for (let attempt = 0; attempt < attempts; attempt++) {
    const sequence = await nextSequence(accountId, year);
    const requestNumber = `${PREFIX}-${year}-${String(sequence).padStart(PAD, '0')}`;

    try {
      return await create(requestNumber);
    } catch (error) {
      // 11000 is the duplicate-key error: another request took this number
      // between our read and our write. Read again and take the next one.
      const isDuplicateNumber =
        error?.code === 11000 && JSON.stringify(error?.keyPattern || {}).includes('requestNumber');
      if (!isDuplicateNumber || attempt === attempts - 1) throw error;
    }
  }

  // Unreachable: the loop either returns or throws on its final attempt.
  throw new Error('Could not allocate a repair number');
};

// The number this account would issue next, for the create form to show before
// anything is saved. Explicitly a preview: it is not reserved, and the request
// actually gets its number at save time.
export const previewRequestNumber = async (accountId) => {
  const year = new Date().getFullYear();
  const sequence = await nextSequence(accountId, year);
  return `${PREFIX}-${year}-${String(sequence).padStart(PAD, '0')}`;
};
