/**
 * Where an organization is, as far as its timezone says: the country its customers' phone numbers are most likely
 * from and the currency its deals are in. Only the sensible guess for zones in one country; a zone that isn't listed
 * (or spans several countries) gives no guess and the organization keeps the general defaults.
 */

export interface Region {
  country: string;
  currency: string;
}

const R = (country: string, currency: string): Region => ({ country, currency });

const BY_ZONE: Record<string, Region> = {
  // The same zone can go by an older name (Node lists "Asia/Calcutta"; the current name is "Asia/Kolkata"): both are here.
  'Asia/Kolkata': R('IN', 'INR'),
  'Asia/Calcutta': R('IN', 'INR'),
  'Asia/Karachi': R('PK', 'PKR'),
  'Asia/Dhaka': R('BD', 'BDT'),
  'Asia/Kathmandu': R('NP', 'NPR'),
  'Asia/Katmandu': R('NP', 'NPR'),
  'Asia/Colombo': R('LK', 'LKR'),
  'Asia/Dubai': R('AE', 'AED'),
  'Asia/Riyadh': R('SA', 'SAR'),
  'Asia/Singapore': R('SG', 'SGD'),
  'Asia/Kuala_Lumpur': R('MY', 'MYR'),
  'Asia/Bangkok': R('TH', 'THB'),
  'Asia/Ho_Chi_Minh': R('VN', 'VND'),
  'Asia/Saigon': R('VN', 'VND'),
  'Asia/Jakarta': R('ID', 'IDR'),
  'Asia/Manila': R('PH', 'PHP'),
  'Asia/Hong_Kong': R('HK', 'HKD'),
  'Asia/Shanghai': R('CN', 'CNY'),
  'Asia/Tokyo': R('JP', 'JPY'),
  'Asia/Seoul': R('KR', 'KRW'),
  'Asia/Taipei': R('TW', 'TWD'),
  'America/New_York': R('US', 'USD'),
  'America/Chicago': R('US', 'USD'),
  'America/Denver': R('US', 'USD'),
  'America/Phoenix': R('US', 'USD'),
  'America/Los_Angeles': R('US', 'USD'),
  'America/Anchorage': R('US', 'USD'),
  'Pacific/Honolulu': R('US', 'USD'),
  'America/Toronto': R('CA', 'CAD'),
  'America/Vancouver': R('CA', 'CAD'),
  'America/Edmonton': R('CA', 'CAD'),
  'America/Winnipeg': R('CA', 'CAD'),
  'America/Regina': R('CA', 'CAD'),
  'America/Halifax': R('CA', 'CAD'),
  'America/St_Johns': R('CA', 'CAD'),
  'America/Mexico_City': R('MX', 'MXN'),
  'America/Sao_Paulo': R('BR', 'BRL'),
  'America/Argentina/Buenos_Aires': R('AR', 'ARS'),
  'America/Buenos_Aires': R('AR', 'ARS'),
  'America/Bogota': R('CO', 'COP'),
  'America/Santiago': R('CL', 'CLP'),
  'America/Lima': R('PE', 'PEN'),
  'Europe/London': R('GB', 'GBP'),
  'Europe/Dublin': R('IE', 'EUR'),
  'Europe/Paris': R('FR', 'EUR'),
  'Europe/Berlin': R('DE', 'EUR'),
  'Europe/Madrid': R('ES', 'EUR'),
  'Europe/Rome': R('IT', 'EUR'),
  'Europe/Amsterdam': R('NL', 'EUR'),
  'Europe/Brussels': R('BE', 'EUR'),
  'Europe/Vienna': R('AT', 'EUR'),
  'Europe/Lisbon': R('PT', 'EUR'),
  'Europe/Athens': R('GR', 'EUR'),
  'Europe/Helsinki': R('FI', 'EUR'),
  'Europe/Zurich': R('CH', 'CHF'),
  'Europe/Stockholm': R('SE', 'SEK'),
  'Europe/Oslo': R('NO', 'NOK'),
  'Europe/Copenhagen': R('DK', 'DKK'),
  'Europe/Warsaw': R('PL', 'PLN'),
  'Europe/Istanbul': R('TR', 'TRY'),
  'Australia/Sydney': R('AU', 'AUD'),
  'Australia/Melbourne': R('AU', 'AUD'),
  'Australia/Brisbane': R('AU', 'AUD'),
  'Australia/Perth': R('AU', 'AUD'),
  'Australia/Adelaide': R('AU', 'AUD'),
  'Pacific/Auckland': R('NZ', 'NZD'),
  'Africa/Lagos': R('NG', 'NGN'),
  'Africa/Johannesburg': R('ZA', 'ZAR'),
  'Africa/Cairo': R('EG', 'EGP'),
  'Africa/Nairobi': R('KE', 'KES'),
};

/** The country and currency a timezone points to, or null when it doesn't point to just one. */
export function regionOfTimezone(timezone: string | null | undefined): Region | null {
  return (timezone && BY_ZONE[timezone]) || null;
}

/** A real ISO 3166 country code: two capital letters that the runtime knows a country by. */
export function isCountryCode(code: string): boolean {
  if (!/^[A-Z]{2}$/.test(code)) return false;
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(code);
    return Boolean(name) && name !== code && name !== 'Unknown Region';
  } catch {
    return false;
  }
}

/** Whether the runtime knows this timezone (by its current or its older name). */
export function isTimezone(value: string): boolean {
  if (!value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
