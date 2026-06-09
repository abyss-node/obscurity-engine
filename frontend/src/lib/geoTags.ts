export const GEO_TAGS = new Set([
  // Country adjectives (Last.fm's typical form)
  'american', 'british', 'german', 'norwegian', 'swedish', 'finnish',
  'french', 'japanese', 'australian', 'canadian', 'danish', 'dutch',
  'irish', 'scottish', 'polish', 'italian', 'russian', 'icelandic',
  'ukrainian', 'argentinian', 'brazilian', 'mexican', 'spanish',
  'portuguese', 'greek', 'belgian', 'swiss', 'austrian', 'hungarian',
  'czech', 'romanian', 'bulgarian', 'serbian', 'croatian', 'turkish',
  'israeli', 'chinese', 'korean', 'thai', 'indonesian', 'indian',
  'slovenian', 'slovak', 'latvian', 'lithuanian', 'estonian',
  'south african', 'chilean', 'colombian', 'peruvian', 'venezuelan',
  // Country names
  'usa', 'uk', 'england', 'germany', 'norway', 'sweden', 'finland',
  'france', 'japan', 'australia', 'canada', 'denmark', 'netherlands',
  'ireland', 'scotland', 'poland', 'italy', 'russia', 'iceland',
  'ukraine', 'argentina', 'brazil', 'mexico', 'spain', 'portugal',
  'greece', 'belgium', 'switzerland', 'austria', 'hungary', 'czechia',
  'slovenia', 'slovakia', 'serbia', 'croatia', 'latvia', 'lithuania', 'estonia',
  'new zealand', 'singapore', 'taiwan',
  // Regions
  'scandinavian', 'nordic', 'european', 'latin american', 'north american',
  'eastern european', 'middle eastern', 'asian', 'latin',
  // Geographically-defined scenes
  'nwobhm', 'nyhc', 'gothenburg', 'bay area', 'tampa', 'seattle',
  'stockholm', 'los angeles', 'new york', 'chicago', 'manchester',
  'london', 'birmingham',
]);

// Maps both adjective and country-name forms to one canonical key for deduplication
export const GEO_CANONICAL = new Map<string, string>([
  ['american', 'usa'], ['usa', 'usa'],
  ['british', 'uk'], ['uk', 'uk'], ['england', 'uk'],
  ['german', 'germany'], ['germany', 'germany'],
  ['norwegian', 'norway'], ['norway', 'norway'],
  ['swedish', 'sweden'], ['sweden', 'sweden'],
  ['finnish', 'finland'], ['finland', 'finland'],
  ['french', 'france'], ['france', 'france'],
  ['japanese', 'japan'], ['japan', 'japan'],
  ['australian', 'australia'], ['australia', 'australia'],
  ['canadian', 'canada'], ['canada', 'canada'],
  ['danish', 'denmark'], ['denmark', 'denmark'],
  ['dutch', 'netherlands'], ['netherlands', 'netherlands'],
  ['irish', 'ireland'], ['ireland', 'ireland'],
  ['scottish', 'scotland'], ['scotland', 'scotland'],
  ['polish', 'poland'], ['poland', 'poland'],
  ['italian', 'italy'], ['italy', 'italy'],
  ['russian', 'russia'], ['russia', 'russia'],
  ['icelandic', 'iceland'], ['iceland', 'iceland'],
  ['ukrainian', 'ukraine'], ['ukraine', 'ukraine'],
  ['argentinian', 'argentina'], ['argentina', 'argentina'],
  ['brazilian', 'brazil'], ['brazil', 'brazil'],
  ['mexican', 'mexico'], ['mexico', 'mexico'],
  ['spanish', 'spain'], ['spain', 'spain'],
  ['portuguese', 'portugal'], ['portugal', 'portugal'],
  ['greek', 'greece'], ['greece', 'greece'],
  ['belgian', 'belgium'], ['belgium', 'belgium'],
  ['swiss', 'switzerland'], ['switzerland', 'switzerland'],
  ['austrian', 'austria'], ['austria', 'austria'],
  ['hungarian', 'hungary'], ['hungary', 'hungary'],
  ['czech', 'czechia'], ['czechia', 'czechia'],
  ['romanian', 'romania'], ['romanian', 'romania'],
  ['chinese', 'china'], ['korean', 'korea'], ['thai', 'thailand'],
  ['turkish', 'turkey'], ['israeli', 'israel'], ['indian', 'india'],
  ['indonesian', 'indonesia'],
  ['slovenian', 'slovenia'], ['slovenia', 'slovenia'],
  ['slovak', 'slovakia'], ['slovakia', 'slovakia'],
  ['serbian', 'serbia'], ['serbia', 'serbia'],
  ['croatian', 'croatia'], ['croatia', 'croatia'],
  ['latvian', 'latvia'], ['latvia', 'latvia'],
  ['lithuanian', 'lithuania'], ['lithuania', 'lithuania'],
  ['estonian', 'estonia'], ['estonia', 'estonia'],
]);

const ACRONYMS = new Set(['usa', 'uk', 'nwobhm', 'nyhc', 'us']);

export function formatGeoTag(tag: string): string {
  if (ACRONYMS.has(tag)) return tag.toUpperCase();
  return tag.charAt(0).toUpperCase() + tag.slice(1);
}

export function isGeoTag(tag: string): boolean {
  return GEO_TAGS.has(tag.toLowerCase());
}

export function firstGenreTag(tags: string[]): string {
  return tags.find(t => !isGeoTag(t)) ?? tags[0] ?? 'untagged';
}
