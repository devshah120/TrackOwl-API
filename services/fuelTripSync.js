import TripOrder from '../models/TripOrder.js';
import { applyTotals } from './tripFinance.js';

// Keeps a trip's fuel expense line in step with the fuel entry that owns it.
//
// Why this exists
// ---------------
// Fuel is entered once, in the fuel register, and it has to show up in two
// places: the fleet's fuel history (where mileage comes from) and the cost side
// of the trip it was burnt on (where profit comes from). Asking the office to
// type the same bill into both is how the two drift apart.
//
// So the fuel entry is the source of truth, and the trip's expense line is a
// projection of it. This module writes that projection.
//
// The rules it holds to
// ---------------------
//   1. It only ever touches the line it created, identified by the id stored on
//      the fuel entry as `tripExpenseId`. A fuel expense someone typed on the
//      trip itself is left completely alone — it is their record, not ours, and
//      silently overwriting or removing it would destroy an operator's work.
//
//   2. It never fails the fuel entry. Recording the bill is the thing the user
//      asked for; syncing it onto a trip is a convenience. A trip that has been
//      deleted, completed, or is otherwise unwritable is reported back to the
//      caller as a warning, and the fuel entry still saves.
//
//   3. Totals are recomputed through services/tripFinance.js, never by hand
//      here, so the trip's profit is arrived at exactly one way.

// Turns a fuel entry into the expense line that represents it. The description
// carries the station and the quantity because on the trip's money tab it has
// to stand on its own — a reader there has no fuel register in front of them.
const asExpenseLine = (entry) => {
  const station = entry.station?.name || '';
  const quantity = `${entry.quantity} ${entry.unit || 'L'}`;
  const description = [`Fuel — ${quantity}`, station].filter(Boolean).join(' @ ');

  return {
    category: 'fuel',
    description,
    amount: entry.amount,
    spentAt: entry.filledAt,
    paidBy: entry.driverName || '',
    paymentMode: entry.paymentMode || 'Cash',
    vendor: station,
    // The two fields TripOrder's expense schema already carries for fuel. They
    // are what let the trip compute its own fuel cost per km without parsing
    // the description above.
    litres: entry.quantity,
    odometer: entry.odometer,
    // The receipt is deliberately not copied. It is already stored once on the
    // fuel entry, and duplicating a base64 image into the trip would double the
    // storage and give two copies that can disagree after an edit.
    receipt: { dataUrl: '', filename: '', mimeType: '' },
    createdAt: new Date(),
    createdBy: entry.createdBy || null
  };
};

// Removes the line this entry owns from whichever trip currently holds it.
// Safe to call when there is nothing to remove.
export const detachFromTrip = async ({ accountId, tripId, expenseId }) => {
  if (!tripId || !expenseId) return { ok: true };

  try {
    const trip = await TripOrder.findOne({ _id: tripId, owner: accountId });
    if (!trip) return { ok: true }; // already gone; nothing to unlink

    const line = trip.expenses.id(expenseId);
    if (!line) return { ok: true }; // already removed on the trip side

    line.deleteOne();
    applyTotals(trip);
    await trip.save();
    return { ok: true };
  } catch (error) {
    console.error('[fuel] could not detach expense from trip:', error.message);
    return { ok: false, warning: 'The fuel cost could not be removed from the previous trip' };
  }
};

// Writes this fuel entry onto its trip, creating the expense line or updating
// the one it already owns. Returns the line's id for the caller to store.
//
// `previousTripId` lets the entry move between trips: the old line is removed
// before the new one is written, so the cost never sits on two trips at once.
export const syncToTrip = async ({ accountId, entry, previousTripId = null, previousExpenseId = null }) => {
  // Moving off a trip, or off trips entirely: clean up the old line first.
  const movedAway = previousTripId && String(previousTripId) !== String(entry.trip || '');
  if (movedAway) {
    await detachFromTrip({ accountId, tripId: previousTripId, expenseId: previousExpenseId });
  }

  if (!entry.trip) {
    return { expenseId: null, warning: null };
  }

  try {
    const trip = await TripOrder.findOne({ _id: entry.trip, owner: accountId });
    if (!trip) {
      return {
        expenseId: null,
        warning: 'That trip could not be found, so the fuel cost was not added to it'
      };
    }

    const payload = asExpenseLine(entry);

    // Update the line we already own, if it is still there.
    const existingId = movedAway ? null : previousExpenseId;
    if (existingId) {
      const line = trip.expenses.id(existingId);
      if (line) {
        // Assigned field by field rather than replacing the subdocument, so the
        // line keeps its _id — that id is what this entry uses to find it again.
        line.set({ ...payload, createdAt: line.createdAt, createdBy: line.createdBy });
        applyTotals(trip);
        await trip.save();
        return { expenseId: line._id, warning: null };
      }
      // The line was deleted on the trip side. Fall through and write a fresh
      // one: the fuel was still bought, and the trip should still show it.
    }

    trip.expenses.push(payload);
    const created = trip.expenses[trip.expenses.length - 1];
    applyTotals(trip);
    await trip.save();

    return { expenseId: created._id, warning: null };
  } catch (error) {
    console.error('[fuel] could not sync expense to trip:', error.message);
    return {
      expenseId: null,
      warning: 'The fuel entry was saved, but the cost could not be added to the trip'
    };
  }
};
