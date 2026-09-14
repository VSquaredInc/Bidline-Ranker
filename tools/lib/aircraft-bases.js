// The fleet/base combos the monthly review tooling checks.
//
// This used to be scraped out of ABR.html's AIRCRAFT_BASES constant (the app
// used the same map to populate the "Fetch from Portal" base dropdown). That
// UI was retired in v1.12.0 when Atlas moved the bid portal to SharePoint
// Online behind MFA + Conditional Access, which broke automated per-user
// portal fetch entirely. The app no longer needs this list, so it now lives
// here as the tooling's own config instead of being read out of shipped app
// code.
module.exports = {
  '747': ['ANC', 'JFK', 'LAX', 'MIA', 'ORD'],
  '767': ['JFK', 'MIA', 'SEA'],
  '777': ['ANC', 'LAX', 'MIA', 'ORD'],
};
