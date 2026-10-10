// auth.ts — the ONE client-side auth store: the JWT + the logged-in user, kept in localStorage and exposed as a
// tiny external store (useSyncExternalStore) so any component re-renders when the session changes. No token → the
// app shows the login screen (App.tsx gates on this). The token is attached to every API call by api.ts.
import { useSyncExternalStore } from 'react';

export interface AuthUser {
  id: number;
  username: string;
  is_admin: boolean;
  can_access_run: boolean;
}

const TOKEN_KEY = 'aiden.token';
const USER_KEY = 'aiden.user';

function readUser(): AuthUser | null {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
}

let _token = localStorage.getItem(TOKEN_KEY) || '';
let _user: AuthUser | null = readUser();
let _snapshot: { token: string; user: AuthUser | null } = { token: _token, user: _user };
const listeners = new Set<() => void>();

function emit(): void {
  _snapshot = { token: _token, user: _user };   // NEW object ref so useSyncExternalStore detects the change
  listeners.forEach((l) => l());
}

export function getToken(): string { return _token; }
export function getUser(): AuthUser | null { return _user; }
export function authHeader(): Record<string, string> { return _token ? { Authorization: `Bearer ${_token}` } : {}; }

export function setSession(token: string, user: AuthUser): void {
  _token = token; _user = user;
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  emit();
}

/** Update just the cached user (e.g. after /auth/me confirms the latest access flags) without touching the token. */
export function refreshUser(user: AuthUser): void {
  _user = user;
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  emit();
}

export function clearSession(): void {
  _token = ''; _user = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** React hook — the current { token, user }; re-renders on login / logout / user refresh. */
export function useAuth(): { token: string; user: AuthUser | null } {
  return useSyncExternalStore(subscribe, () => _snapshot, () => _snapshot);
}
