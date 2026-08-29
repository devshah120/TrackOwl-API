import Driver, { DRIVER_STATUSES } from '../models/Driver.js';

// Shared driver helpers. Trucks are saved with their full driver list in one
// form submit (AddNewTruck / the admin modal), while /api/drivers edits one
// driver at a time — both funnel through here so the "exactly one primary"
// rule and the input shaping live in a single place.

// Normalises one driver row off a form payload. Returns null for a blank row so
// an untouched extra row on the form is dropped rather than failing validation.
// Shared by the nullable scalar fields below: `undefined` when the key was not
// sent at all, `null` when it was sent blank, else the parsed value.
const nullableDate = (raw, key) => {
  if (!(key in raw)) return undefined;
  return raw[key] ? raw[key] : null;
};

const nullableNumber = (raw, key) => {
  if (!(key in raw)) return undefined;
  const value = raw[key];
  if (value === null || value === '' || Number.isNaN(Number(value))) return null;
  return Number(value);
};

export const normaliseDriver = (raw) => {
  if (!raw || typeof raw !== 'object') return null;

  const name = String(raw.name || '').trim();
  const mobile = String(raw.mobile || '').replace(/\D/g, '');
  if (!name && !mobile) return null;

  // Only built when the caller actually sent a contact. The truck form posts
  // driver rows without one, and $set-ing a blank object there would erase a
  // contact captured on the driver screen.
  const rawContact = raw.emergencyContact;
  const contact = rawContact && typeof rawContact === 'object'
    ? {
        name: String(rawContact.name || '').trim(),
        relation: String(rawContact.relation || '').trim(),
        mobile: String(rawContact.mobile || '').replace(/\D/g, '')
      }
    : undefined;

  return {
    name,
    mobile,
    licenseNumber: String(raw.licenseNumber || '').trim(),
    // Absent vs. explicitly emptied are different edits. A field the caller
    // never sent stays undefined so $set skips it (the truck form posts only a
    // subset); one the caller sent as null/'' becomes null so clearing a date
    // or salary on the driver screen actually persists.
    licenseExpiry: nullableDate(raw, 'licenseExpiry'),
    joiningDate: nullableDate(raw, 'joiningDate'),
    salary: nullableNumber(raw, 'salary'),
    emergencyContact: contact,
    // Left undefined when the caller sent nothing recognisable, so $set skips
    // it: the truck form posts driver rows without a status, and that must not
    // reset a driver who is On Trip or on Leave back to Available. New
    // documents pick up the schema default instead.
    status: DRIVER_STATUSES.includes(raw.status) ? raw.status : undefined,
    isPrimary: Boolean(raw.isPrimary)
  };
};

// Accepts either the new `drivers: []` array or a legacy single `driver` object,
// so older clients (and the admin screen before it was updated) keep working.
export const readDriverList = (body) => {
  const source = Array.isArray(body?.drivers)
    ? body.drivers
    : body?.driver
      ? [body.driver]
      : null;

  if (!source) return null; // field absent entirely — caller should not touch drivers

  const list = source.map(normaliseDriver).filter(Boolean);

  // Guarantee exactly one primary: honour an explicit flag, else promote the
  // first row, so the single-driver screens always have something to show.
  if (list.length && !list.some((d) => d.isPrimary)) list[0].isPrimary = true;
  let seenPrimary = false;
  for (const d of list) {
    if (d.isPrimary && seenPrimary) d.isPrimary = false;
    else if (d.isPrimary) seenPrimary = true;
  }

  return list;
};

// Replaces a truck's driver roster with `list`, reusing existing documents
// where an _id was sent back so a driver keeps its identity (and any future
// references to it) across an edit.
export const syncTruckDrivers = async (truckId, ownerId, list, rawSource = []) => {
  if (!Array.isArray(list)) return;

  const keptIds = rawSource
    .map((raw) => raw && (raw._id || raw.id))
    .filter(Boolean)
    .map(String);

  await Driver.deleteMany({
    truck: truckId,
    owner: ownerId,
    ...(keptIds.length ? { _id: { $nin: keptIds } } : {})
  });

  await Promise.all(
    list.map((fields, i) => {
      const raw = rawSource[i] || {};
      const id = raw._id || raw.id;
      if (id) {
        return Driver.findOneAndUpdate(
          { _id: id, owner: ownerId },
          { $set: { ...fields, truck: truckId, owner: ownerId } },
          { new: true, runValidators: true }
        );
      }
      return Driver.create({ ...fields, truck: truckId, owner: ownerId });
    })
  );
};

// Attaches each truck's drivers, plus a `driver` field holding the primary one.
// That legacy-shaped field is what keeps single-driver views (LR/invoice
// defaults, dashboards) rendering without each needing to know about the array.
export const attachDrivers = async (trucks, ownerId = null) => {
  const list = Array.isArray(trucks) ? trucks : [trucks];
  if (!list.length) return trucks;

  const query = { truck: { $in: list.map((t) => t._id) } };
  if (ownerId) query.owner = ownerId;

  const drivers = await Driver.find(query).sort({ isPrimary: -1, createdAt: 1 });

  const byTruck = new Map();
  for (const d of drivers) {
    const key = String(d.truck);
    if (!byTruck.has(key)) byTruck.set(key, []);
    byTruck.get(key).push(d);
  }

  const decorated = list.map((truck) => {
    const own = byTruck.get(String(truck._id)) || [];
    const json = typeof truck.toJSON === 'function' ? truck.toJSON() : truck;
    return {
      ...json,
      drivers: own,
      driver: own.find((d) => d.isPrimary) || own[0] || json.driver || null
    };
  });

  return Array.isArray(trucks) ? decorated : decorated[0];
};
