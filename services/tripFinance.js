// Every number the trip reports about money and distance is computed here, on
// the server. The frontend renders these values and never derives its own — a
// browser-side total is a number nobody can audit, and two screens disagreeing
// about a trip's profit is worse than either being slightly stale.
//
// Recomputed on every write that touches revenue, expenses or the odometer
// readings, and stored on the trip so the list can sort and filter on profit
// without loading every line of every trip.

// Categories that reduce what the customer owes rather than adding to it.
// Amounts are stored positive everywhere (the schema enforces min: 0), so the
// sign lives here, in one place, instead of depending on a client sending a
// negative number.
const DEDUCTIONS = new Set(['discount']);

// Rounds money to paise. Floating-point addition over a dozen lines otherwise
// leaves totals like 12499.999999998, which then renders as a stray rupee
// difference against the sum of the lines shown above it.
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Rounds a derived rate to two places. Same reasoning as `money`, but these are
// ratios rather than currency, so they are kept separate for clarity.
const rate = (n) => Math.round((Number(n) || 0) * 100) / 100;

// What the customer is billed, net of discounts. Tax is included in the total:
// it is money the customer pays on this trip, and the invoice total the office
// chases is the gross figure. It is listed as its own category so the breakdown
// can still show it separately.
export const computeRevenue = (lines = []) =>
  money(
    lines.reduce((sum, line) => {
      const amount = Number(line?.amount) || 0;
      return DEDUCTIONS.has(line?.category) ? sum - amount : sum + amount;
    }, 0)
  );

// What the trip cost to run. Every expense category adds; there is no such
// thing as a negative expense here — a refund is recorded by editing or
// removing the line it corrects, so the trail shows what actually happened.
export const computeExpenses = (lines = []) =>
  money(lines.reduce((sum, line) => sum + (Number(line?.amount) || 0), 0));

// Distance actually driven, from the odometer pair.
//
// Returns null rather than 0 when either reading is missing: "we do not know
// how far it went" and "it went nowhere" are different facts, and collapsing
// them would make every un-closed trip look like a zero-kilometre run in the
// per-km figures below.
export const computeActualKm = (start, end) => {
  const from = Number(start?.odometer);
  const to = Number(end?.odometer);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  if (to < from) return null; // guarded at the route with a clear error; never negative here
  return rate(to - from);
};

// Elapsed time between the recorded start and end, in minutes. Same null rule
// as the distance: absent readings mean unknown, not instant.
export const computeActualMinutes = (start, end) => {
  if (!start?.at || !end?.at) return null;
  const ms = new Date(end.at).getTime() - new Date(start.at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.round(ms / 60000);
};

// The headline profitability block for one trip.
//
// The per-kilometre figures are only reported when there is a real distance to
// divide by. Dividing by a null or zero actual distance would produce Infinity
// or a wildly overstated rate on a trip whose odometer has not been closed out
// yet, and that number would then be shown next to genuine ones as though it
// meant something.
export const computeProfitability = (trip = {}) => {
  const revenue = computeRevenue(trip.revenue);
  const expenses = computeExpenses(trip.expenses);
  const profit = money(revenue - expenses);

  // Margin is against revenue, the standard reading of "what share of what we
  // billed did we keep". A trip with no revenue has no margin to report — 0%
  // would imply it broke even when it may have run at a pure loss.
  const marginPct = revenue > 0 ? rate((profit / revenue) * 100) : 0;

  const actualKm = trip.actualKm ?? computeActualKm(trip.start, trip.end);
  const hasDistance = Number.isFinite(actualKm) && actualKm > 0;

  // Fuel is pulled out of the expense lines rather than tracked separately, so
  // fuel cost per km stays consistent with the expense list the operator sees.
  const fuelCost = money(
    (trip.expenses || [])
      .filter((e) => e?.category === 'fuel')
      .reduce((sum, e) => sum + (Number(e.amount) || 0), 0)
  );
  const fuelLitres = (trip.expenses || [])
    .filter((e) => e?.category === 'fuel')
    .reduce((sum, e) => sum + (Number(e.litres) || 0), 0);

  return {
    revenue,
    expenses,
    profit,
    marginPct,
    actualKm: hasDistance ? actualKm : null,
    plannedKm: Number.isFinite(trip.plannedKm) ? trip.plannedKm : null,
    revenuePerKm: hasDistance ? rate(revenue / actualKm) : null,
    expensePerKm: hasDistance ? rate(expenses / actualKm) : null,
    profitPerKm: hasDistance ? rate(profit / actualKm) : null,
    fuelCost,
    fuelCostPerKm: hasDistance && fuelCost > 0 ? rate(fuelCost / actualKm) : null,
    // Fuel economy, reported only when litres were actually entered against the
    // fuel lines — an amount alone cannot give a km/l figure.
    kmPerLitre: hasDistance && fuelLitres > 0 ? rate(actualKm / fuelLitres) : null,
    // Breakdown by category, for the profitability tab's tables.
    revenueByCategory: sumByCategory(trip.revenue),
    expensesByCategory: sumByCategory(trip.expenses)
  };
};

// Totals per category, for the breakdown tables. Categories with nothing
// against them are omitted rather than listed as zero.
const sumByCategory = (lines = []) => {
  const out = {};
  for (const line of lines) {
    if (!line?.category) continue;
    out[line.category] = money((out[line.category] || 0) + (Number(line.amount) || 0));
  }
  return out;
};

// Recomputes the stored `totals` block plus the derived actuals, and assigns
// them onto the trip document. Called by every route that changes revenue,
// expenses or the odometer readings, so the stored numbers can never drift from
// the lines they come from.
//
// Mutates and returns the document rather than saving it: the caller is usually
// mid-way through other changes and should write once.
export const applyTotals = (trip) => {
  const revenue = computeRevenue(trip.revenue);
  const expenses = computeExpenses(trip.expenses);
  const profit = money(revenue - expenses);

  trip.totals = {
    revenue,
    expenses,
    profit,
    marginPct: revenue > 0 ? rate((profit / revenue) * 100) : 0
  };

  const actualKm = computeActualKm(trip.start, trip.end);
  if (actualKm !== null) trip.actualKm = actualKm;

  const actualMinutes = computeActualMinutes(trip.start, trip.end);
  if (actualMinutes !== null) trip.actualMinutes = actualMinutes;

  return trip;
};

// Planned against actual, for the tab of that name. Every field is null-safe:
// a trip that has not run yet reports nulls rather than zeros, so the UI can
// show "—" instead of a confident 0 km deviation.
export const computeVariance = (trip = {}) => {
  const plannedKm = Number.isFinite(trip.plannedKm) ? trip.plannedKm : null;
  const actualKm = Number.isFinite(trip.actualKm) ? trip.actualKm : null;
  const plannedMinutes = Number.isFinite(trip.plannedMinutes) ? trip.plannedMinutes : null;
  const actualMinutes = Number.isFinite(trip.actualMinutes) ? trip.actualMinutes : null;

  const kmDeviation = plannedKm !== null && actualKm !== null ? rate(actualKm - plannedKm) : null;
  const timeDeviation =
    plannedMinutes !== null && actualMinutes !== null ? actualMinutes - plannedMinutes : null;

  return {
    plannedKm,
    actualKm,
    kmDeviation,
    // Deviation as a share of the plan, which is the figure that actually says
    // whether a route was followed — 40 km over on a 200 km run is routine, on
    // a 50 km run it is not.
    kmDeviationPct:
      plannedKm !== null && plannedKm > 0 && kmDeviation !== null
        ? rate((kmDeviation / plannedKm) * 100)
        : null,
    plannedMinutes,
    actualMinutes,
    timeDeviation,
    // Average speed over the whole trip including stops, which is what the
    // planned duration was also measured against.
    averageSpeedKmph:
      actualKm !== null && actualMinutes !== null && actualMinutes > 0
        ? rate(actualKm / (actualMinutes / 60))
        : null
  };
};
