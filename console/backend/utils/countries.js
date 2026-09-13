// ISO 3166-1 alpha-2 to display name.
//
// The console shows the countries its own nodes are in, so this list covers the
// codes a node can register with rather than the full standard. An unknown code is
// displayed as the code itself, which is more useful than "Unknown" when a new
// country appears.
const COUNTRY_NAMES = {
  AT: 'Austria', AU: 'Australia', BE: 'Belgium', BG: 'Bulgaria', BR: 'Brazil',
  CA: 'Canada', CH: 'Switzerland', CL: 'Chile', CZ: 'Czechia', DE: 'Germany',
  DK: 'Denmark', EE: 'Estonia', ES: 'Spain', FI: 'Finland', FR: 'France',
  GB: 'United Kingdom', GR: 'Greece', HK: 'Hong Kong', HR: 'Croatia', HU: 'Hungary',
  IE: 'Ireland', IL: 'Israel', IN: 'India', IS: 'Iceland', IT: 'Italy',
  JP: 'Japan', KR: 'South Korea', LT: 'Lithuania', LU: 'Luxembourg', LV: 'Latvia',
  MD: 'Moldova', MX: 'Mexico', MY: 'Malaysia', NL: 'Netherlands', NO: 'Norway',
  NZ: 'New Zealand', PL: 'Poland', PT: 'Portugal', RO: 'Romania', RS: 'Serbia',
  SE: 'Sweden', SG: 'Singapore', SI: 'Slovenia', SK: 'Slovakia', TR: 'Turkey',
  UA: 'Ukraine', US: 'United States', ZA: 'South Africa'
};

module.exports = { COUNTRY_NAMES };
