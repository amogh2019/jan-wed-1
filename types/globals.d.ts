// Editor-only type hints for IDE inspections and JSDoc. Never loaded by the browser.

interface GsiIdApi {
  initialize(options: Record<string, unknown>): void;
  prompt(): void;
  renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
  disableAutoSelect(): void;
}

declare const google: { accounts: { id: GsiIdApi } };

interface Window {
  google?: typeof google;
  OneSignalDeferred?: Array<(sdk: any) => void | Promise<void>>;
  APP_CONFIG?: Record<string, any>;
}

interface Navigator {
  /** iOS Safari: true when launched from the home screen. */
  standalone?: boolean;
}

/** Row of the "Logistics" sheet, as returned by the backend (admin only). */
interface Guest {
  id: string;
  name: string;
  members: string;
  contact: string;
  arrival: string;
  departure: string;
  mode: string;
  pickupStatus: 'Pending' | 'Picked Up';
}

/** Fields of the "Add member" form. */
interface MemberFormFields {
  email: HTMLInputElement;
  role: HTMLSelectElement;
}
