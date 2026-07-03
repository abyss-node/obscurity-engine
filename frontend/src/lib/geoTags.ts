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
  'welsh', 'vietnamese', 'filipino', 'taiwanese',
  'singaporean', 'malaysian',
  // Non-English country names that appear on Last.fm
  'brasil', 'deutschland', 'espana', 'sverige', 'suomi', 'norge',
  'polska', 'magyarorszag',
  // Country names
  'usa', 'uk', 'england', 'germany', 'norway', 'sweden', 'finland',
  'france', 'japan', 'australia', 'canada', 'denmark', 'netherlands',
  'ireland', 'scotland', 'poland', 'italy', 'russia', 'iceland',
  'ukraine', 'argentina', 'brazil', 'mexico', 'spain', 'portugal',
  'greece', 'belgium', 'switzerland', 'austria', 'hungary', 'czechia',
  'slovenia', 'slovakia', 'serbia', 'croatia', 'latvia', 'lithuania', 'estonia',
  'new zealand', 'singapore', 'taiwan', 'bulgaria', 'chile', 'colombia',
  'peru', 'venezuela', 'wales', 'vietnam', 'philippines', 'malaysia',
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
  ['brasil', 'brazil'], ['deutschland', 'germany'],
  ['espana', 'spain'], ['sverige', 'sweden'],
  ['suomi', 'finland'], ['norge', 'norway'],
  ['polska', 'poland'],
  ['slovenian', 'slovenia'], ['slovenia', 'slovenia'],
  ['slovak', 'slovakia'], ['slovakia', 'slovakia'],
  ['serbian', 'serbia'], ['serbia', 'serbia'],
  ['croatian', 'croatia'], ['croatia', 'croatia'],
  ['latvian', 'latvia'], ['latvia', 'latvia'],
  ['lithuanian', 'lithuania'], ['lithuania', 'lithuania'],
  ['estonian', 'estonia'], ['estonia', 'estonia'],
  // Standard country-adjective set — filled in for compound-tag token
  // matching (e.g. "chilean folk", "bulgarian doom"). These were present
  // in GEO_TAGS but had no canonical target before.
  ['bulgarian', 'bulgaria'], ['bulgaria', 'bulgaria'],
  ['chilean', 'chile'], ['chile', 'chile'],
  ['colombian', 'colombia'], ['colombia', 'colombia'],
  ['peruvian', 'peru'], ['peru', 'peru'],
  ['venezuelan', 'venezuela'], ['venezuela', 'venezuela'],
  ['magyarorszag', 'hungary'],
  ['new zealand', 'new zealand'], ['singapore', 'singapore'], ['taiwan', 'taiwan'],
  // A few additional common Last.fm adjectives not previously covered at all.
  ['welsh', 'wales'], ['wales', 'wales'],
  ['vietnamese', 'vietnam'], ['vietnam', 'vietnam'],
  ['filipino', 'philippines'], ['philippines', 'philippines'],
  ['taiwanese', 'taiwan'],
  ['singaporean', 'singapore'],
  ['malaysian', 'malaysia'], ['malaysia', 'malaysia'],
]);

const ACRONYMS = new Set(['usa', 'uk', 'nwobhm', 'nyhc', 'us']);

export function formatGeoTag(tag: string): string {
  if (ACRONYMS.has(tag)) return tag.toUpperCase();
  return tag.charAt(0).toUpperCase() + tag.slice(1);
}

export function isGeoTag(tag: string): boolean {
  return GEO_TAGS.has(tag.toLowerCase().trim());
}

export function firstGenreTag(tags: string[]): string {
  return tags.find(t => !isGeoTag(t)) ?? tags[0] ?? 'untagged';
}

/**
 * Resolve a canonical country/geo key from an artist's tag list.
 *
 * Pass 1 (unchanged precedence): scan tags in order for a whole-tag match
 * against GEO_TAGS — exactly the logic ArtistCard/HeroPicks used to inline.
 *
 * Pass 2 (new): most artists never carry a standalone geo tag, but many
 * carry a compound tag with a country adjective embedded, e.g.
 * "swedish death metal", "french coldwave", "japanese noise rock". Tokenize
 * each tag on spaces/hyphens and look up each token in GEO_CANONICAL, which
 * holds the known adjective/country-name vocabulary. Token-boundary only —
 * a token must equal a full entry in the map, so substrings inside longer
 * words (e.g. "britpop") never false-positive into a country.
 *
 * First hit wins, tags scanned in order, pass 1 before pass 2 across the
 * whole list (so an explicit standalone geo tag anywhere always outranks a
 * compound-tag guess).
 */
export function countryFromTags(tags: string[]): string | null {
  for (const t of tags) {
    if (isGeoTag(t)) {
      const key = t.toLowerCase().trim();
      return GEO_CANONICAL.get(key) ?? key;
    }
  }
  for (const t of tags) {
    const tokens = t.toLowerCase().trim().split(/[\s-]+/);
    for (const tok of tokens) {
      const hit = GEO_CANONICAL.get(tok);
      if (hit) return hit;
    }
  }
  return null;
}
