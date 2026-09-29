// Operator / admin credentials for the operator API (docs/API.md section 2, Auth). Held in memory
// and mirrored to sessionStorage so a reload keeps the login but closing the tab drops it.
// The token is sent as Authorization: Bearer; the actor name is informational (X-Actor).
export interface Credentials {
  token?: string;
  actor?: string;
}

const STORAGE_KEY = "fuelops.credentials";
const ACTOR_PATTERN = /^[A-Za-z0-9 ._@-]{1,64}$/;

export const isValidActor = (actor: string): boolean => ACTOR_PATTERN.test(actor);

let current: Credentials = readStored();
const listeners = new Set<() => void>();

function readStored(): Credentials {
  try {
    const raw = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(STORAGE_KEY);
    return raw ? sanitize(JSON.parse(raw) as Credentials) : {};
  } catch {
    return {};
  }
}

function sanitize(input: Credentials): Credentials {
  const out: Credentials = {};
  if (typeof input.token === "string" && input.token.trim()) out.token = input.token.trim();
  if (typeof input.actor === "string" && isValidActor(input.actor.trim())) out.actor = input.actor.trim();
  return out;
}

function commit(next: Credentials) {
  current = next;
  try {
    if (typeof sessionStorage !== "undefined") {
      if (next.token || next.actor) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      else sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // storage blocked (private mode): memory only
  }
  listeners.forEach((listener) => listener());
}

export const getCredentials = (): Credentials => current;
export const setCredentials = (next: Credentials): void => commit(sanitize(next));
export const clearCredentials = (): void => commit({});

export function subscribeCredentials(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
