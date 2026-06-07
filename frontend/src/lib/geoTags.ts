export const GEO_TAGS = new Set([
  // Country adjectives (Last.fm's typical form)
  'american', 'british', 'german', 'norwegian', 'swedish', 'finnish',
  'french', 'japanese', 'australian', 'canadian', 'danish', 'dutch',
  'irish', 'scottish', 'polish', 'italian', 'russian', 'icelandic',
  'ukrainian', 'argentinian', 'brazilian', 'mexican', 'spanish',
  'portuguese', 'greek', 'belgian', 'swiss', 'austrian', 'hungarian',
  'czech', 'romanian', 'bulgarian', 'serbian', 'croatian', 'turkish',
  'israeli', 'chinese', 'korean', 'thai', 'indonesian', 'indian',
  'south african', 'chilean', 'colombian', 'peruvian', 'venezuelan',
  // Country names
  'usa', 'uk', 'england', 'germany', 'norway', 'sweden', 'finland',
  'france', 'japan', 'australia', 'canada', 'denmark', 'netherlands',
  'ireland', 'scotland', 'poland', 'italy', 'russia', 'iceland',
  'ukraine', 'argentina', 'brazil', 'mexico', 'spain', 'portugal',
  'greece', 'belgium', 'switzerland', 'austria', 'hungary', 'czechia',
  'new zealand', 'singapore', 'taiwan',
  // Regions
  'scandinavian', 'nordic', 'european', 'latin american', 'north american',
  'eastern european', 'middle eastern', 'asian', 'latin',
  // Geographically-defined scenes
  'nwobhm', 'nyhc', 'gothenburg', 'bay area', 'tampa', 'seattle',
  'stockholm', 'los angeles', 'new york', 'chicago', 'manchester',
  'london', 'birmingham',
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
