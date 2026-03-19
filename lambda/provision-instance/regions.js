/**
 * claw-me.com — Region Routing
 *
 * Maps customer country codes → nearest AWS region.
 * Used by the provisioning Lambda to deploy ECS tasks
 * as close as possible to the customer.
 */

// ── AWS region definitions ────────────────────────────────────
const REGIONS = {
  'us-east-1':      { name: 'US East (N. Virginia)',   cluster: 'claw-me-cluster-use1' },
  'us-west-2':      { name: 'US West (Oregon)',         cluster: 'claw-me-cluster-usw2' },
  'ca-central-1':   { name: 'Canada (Central)',         cluster: 'claw-me-cluster-cac1' },
  'eu-west-1':      { name: 'Europe (Ireland)',         cluster: 'claw-me-cluster-euw1' },
  'eu-central-1':   { name: 'Europe (Frankfurt)',       cluster: 'claw-me-cluster-euc1' },
  'ap-southeast-1': { name: 'Asia Pacific (Singapore)', cluster: 'claw-me-cluster-apse1' },
  'ap-northeast-1': { name: 'Asia Pacific (Tokyo)',     cluster: 'claw-me-cluster-apne1' },
  'ap-southeast-2': { name: 'Asia Pacific (Sydney)',    cluster: 'claw-me-cluster-apse2' },
  'sa-east-1':      { name: 'South America (São Paulo)', cluster: 'claw-me-cluster-sae1' },
};

// ── Country → AWS region mapping ─────────────────────────────
const COUNTRY_TO_REGION = {
  // North America
  'US': 'us-east-1',
  'CA': 'ca-central-1',
  'MX': 'us-east-1',

  // South America
  'BR': 'sa-east-1',
  'AR': 'sa-east-1',
  'CL': 'sa-east-1',
  'CO': 'sa-east-1',
  'PE': 'sa-east-1',
  'VE': 'sa-east-1',

  // Europe (GDPR — must stay in EU)
  'GB': 'eu-west-1',
  'IE': 'eu-west-1',
  'FR': 'eu-central-1',
  'DE': 'eu-central-1',
  'NL': 'eu-west-1',
  'BE': 'eu-west-1',
  'CH': 'eu-central-1',
  'AT': 'eu-central-1',
  'IT': 'eu-central-1',
  'ES': 'eu-west-1',
  'PT': 'eu-west-1',
  'SE': 'eu-central-1',
  'NO': 'eu-central-1',
  'DK': 'eu-central-1',
  'FI': 'eu-central-1',
  'PL': 'eu-central-1',
  'CZ': 'eu-central-1',
  'HU': 'eu-central-1',
  'RO': 'eu-central-1',
  'GR': 'eu-central-1',

  // Middle East & Africa
  'AE': 'eu-central-1',
  'SA': 'eu-central-1',
  'IL': 'eu-central-1',
  'ZA': 'eu-west-1',
  'EG': 'eu-central-1',
  'NG': 'eu-west-1',
  'KE': 'eu-west-1',

  // Asia Pacific
  'JP': 'ap-northeast-1',
  'KR': 'ap-northeast-1',
  'CN': 'ap-southeast-1',
  'HK': 'ap-southeast-1',
  'TW': 'ap-northeast-1',
  'SG': 'ap-southeast-1',
  'MY': 'ap-southeast-1',
  'TH': 'ap-southeast-1',
  'ID': 'ap-southeast-1',
  'PH': 'ap-southeast-1',
  'VN': 'ap-southeast-1',
  'IN': 'ap-southeast-1',
  'AU': 'ap-southeast-2',
  'NZ': 'ap-southeast-2',
};

// ── Default fallback region ───────────────────────────────────
const DEFAULT_REGION = 'us-east-1';

/**
 * Get the best AWS region for a given country code.
 * @param {string} countryCode — ISO 3166-1 alpha-2 (e.g. 'US', 'DE', 'JP')
 * @returns {string} AWS region string
 */
function getRegionForCountry(countryCode) {
  if (!countryCode) return DEFAULT_REGION;
  const region = COUNTRY_TO_REGION[countryCode.toUpperCase()];
  return region || DEFAULT_REGION;
}

/**
 * Get full region config (name + cluster) for a region string.
 * @param {string} region — AWS region string
 * @returns {{ name: string, cluster: string }}
 */
function getRegionConfig(region) {
  return REGIONS[region] || REGIONS[DEFAULT_REGION];
}

/**
 * Get a human-readable description for a region.
 * @param {string} countryCode
 * @returns {{ region: string, name: string, cluster: string }}
 */
function resolveRegion(countryCode) {
  const region = getRegionForCountry(countryCode);
  const config = getRegionConfig(region);
  return { region, ...config };
}

module.exports = { getRegionForCountry, getRegionConfig, resolveRegion, REGIONS, DEFAULT_REGION };
