/**
 * Runtime configuration. Replace the placeholder values before deploying.
 * None of these values are secrets — they are safe to commit.
 * (The OneSignal REST API key lives ONLY in Apps Script "Script Properties".)
 */
window.APP_CONFIG = Object.freeze({
  // App name everywhere: header, browser tab and the installed app's name.
  // After changing it run `npm run sync:config` (copies it into manifest.json / index.html).
  EVENT_NAME: 'Kaus-Anch : Our 3-Day Celebration',
  // Optional shorter name under the home-screen icon ('' = use EVENT_NAME).
  APP_SHORT_NAME: '',
  EVENT_TAGLINE: 'Schedule, live updates & pick-ups',
  // Optional: shown on the invitation screen and in the header ('' to hide)
  EVENT_DATES: '23 - 25 January 2027',                       // e.g. '12 – 14 January 2027'
  EVENT_BLESSING: '॥ श्री गणेशाय नमः ॥',  // auspicious line atop the invitation
  EVENT_HOSTS: 'Kaus - Anch',                       // e.g. 'The Sharma & Verma families' — signs the welcome blessing

  // Apps Script Web App URL (Deploy → New deployment → Web app → copy URL ending in /exec)
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbyQRW2wdZ3Mr57AGcO78x7e36bNvixdH3hP3M2dzbBRUzrqyn0QODns9w3CcJUHiIZl_g/exec',

  // Google Cloud OAuth 2.0 Client ID (type: Web application)
  GOOGLE_CLIENT_ID: '281021281917-1m94kreaivjtuhdiitnqctko3jbl5st6.apps.googleusercontent.com',

  // OneSignal App ID (Settings → Keys & IDs)
  ONESIGNAL_APP_ID: 'd04bcd0a-65ae-4e82-bf5e-be3ea85bbfb8',

  // Auto-refresh cadence for public data while the app is visible
  REFRESH_INTERVAL_MS: 60000,

  // Network timeout for backend calls
  REQUEST_TIMEOUT_MS: 25000,
});
