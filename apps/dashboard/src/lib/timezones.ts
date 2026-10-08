/**
 * Timezone names as people expect to see them. The browser lists some zones by an older name ("Asia/Calcutta",
 * "Asia/Katmandu"); these are the current names for the same zones, which the server accepts as they are. No browser
 * APIs here (the server's tests import it).
 */
const CURRENT_NAME: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Rangoon': 'Asia/Yangon',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Godthab': 'America/Nuuk',
  'Europe/Kiev': 'Europe/Kyiv',
  'Pacific/Truk': 'Pacific/Chuuk',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Africa/Asmera': 'Africa/Asmara',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'America/Coral_Harbour': 'America/Atikokan',
};

/** A zone's current name ("Asia/Calcutta" → "Asia/Kolkata"); names that are already current come back unchanged. */
export function currentTimezoneName(zone: string): string {
  return CURRENT_NAME[zone] ?? zone;
}

/** The zones to choose from: the browser's list under their current names, sorted, with UTC. */
export function timezoneChoices(listed: string[]): string[] {
  const names = new Set([...listed.map(currentTimezoneName), 'UTC']);
  return [...names].sort((a, b) => (a === 'UTC' ? -1 : b === 'UTC' ? 1 : a.localeCompare(b)));
}
