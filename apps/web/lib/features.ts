// Feature switches for the single-school pilot.
//
// DISTRICT_ENABLED: Recover is approved at one school, not yet by the district. While this is false,
// the district pages (overview, schools, settings, stats), their APIs, the cross-school search
// option, and district wording are hidden; the code stays in place. The one district tool the
// pilot still needs, campus map approval, stays at /district/maps for the Recover admin (the
// district_admin account), linked as "Map approvals". To bring the district back, set this to
// true and search for DISTRICT_ENABLED to review each spot.
export const DISTRICT_ENABLED = false;

// Picks the district wording when the district is enabled, the school wording otherwise.
export const districtOr = <T,>(district: T, school: T): T => (DISTRICT_ENABLED ? district : school);
