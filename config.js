/**
 * Runtime configuration. Replace the placeholder values before deploying.
 * None of these values are secrets — they are safe to commit.
 * (The OneSignal REST API key lives ONLY in Apps Script "Script Properties".)
 */
window.APP_CONFIG = Object.freeze({
  EVENT_NAME: 'Our 3-Day Celebration',
  EVENT_TAGLINE: 'Schedule, live updates & pick-ups',
  // Optional: shown on the invitation screen and in the header ('' to hide)
  EVENT_DATES: '',                       // e.g. '12 – 14 January 2027'
  EVENT_BLESSING: '॥ श्री गणेशाय नमः ॥',  // auspicious line atop the invitation
  EVENT_HOSTS: '',                       // e.g. 'The Sharma & Verma families' — signs the welcome blessing

  // Apps Script Web App URL (Deploy → New deployment → Web app → copy URL ending in /exec)
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/REPLACE_WITH_DEPLOYMENT_ID/exec',

  // Google Cloud OAuth 2.0 Client ID (type: Web application)
  GOOGLE_CLIENT_ID: 'REPLACE_WITH_CLIENT_ID.apps.googleusercontent.com',

  // OneSignal App ID (Settings → Keys & IDs)
  ONESIGNAL_APP_ID: 'REPLACE_WITH_ONESIGNAL_APP_ID',

  // Auto-refresh cadence for public data while the app is visible
  REFRESH_INTERVAL_MS: 60000,

  // Network timeout for backend calls
  REQUEST_TIMEOUT_MS: 25000,
});
