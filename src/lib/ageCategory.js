// ageCategory — map the backend's free-form age_category values onto the
// EditMetadataModal <select> vocabulary (Childrens / Teens / Young Adult /
// Adult). L8: values like "Middle Grade" or "Teen 13-17" previously landed in
// the select verbatim and showed as blank because they aren't valid options.

const AGE_CATEGORY_MAP = {
  "children's": 'Childrens',
  'childrens': 'Childrens',
  'children': 'Childrens',
  'middle grade': 'Childrens',
  'early reader': 'Childrens',
  'picture book': 'Childrens',
  'juvenile': 'Childrens',
  'teen': 'Teens',
  'teens': 'Teens',
  'teen 13-17': 'Teens',
  'young adult': 'Young Adult',
  'ya': 'Young Adult',
  'adult': 'Adult',
  'adults': 'Adult',
};

const VALID = new Set(['Childrens', 'Teens', 'Young Adult', 'Adult']);

// Returns a valid select value, or null when there is no sensible mapping.
export function mapAgeCategory(value) {
  if (!value) return null;
  const key = String(value).trim().toLowerCase();
  if (AGE_CATEGORY_MAP[key]) return AGE_CATEGORY_MAP[key];
  // Already a valid option (case-insensitive).
  for (const v of VALID) {
    if (v.toLowerCase() === key) return v;
  }
  return null;
}
