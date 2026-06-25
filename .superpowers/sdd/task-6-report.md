# Task 6 Report — Frontend Session Management

## Summary of Changes

### `src/services/api.ts`
Added `X-Session-Id` header injection from `sessionStorage` in `apiFetch`. The header is included on every request when a `sessionId` is present in `sessionStorage`.

### `src/context/AuthContext.tsx`

**Change A — syncAndLoadProfile:** `apiFetch('/auth/sync-profile', ...)` now typed as `apiFetch<{ sessionId: string }>` and the returned `sessionId` is stored via `sessionStorage.setItem('sessionId', syncResponse.sessionId)`.

**Change B — signOut:** Added `sessionStorage.removeItem('sessionId')` before the Firebase sign-out call so the session token is cleared on logout.

**Change C — BroadcastChannel tab duplication detection:** Added a new `useEffect` (placed before the `onAuthStateChanged` effect) that:
- Assigns each tab a unique `TAB_ID` via `crypto.randomUUID()`.
- Opens a `BroadcastChannel('auth_session')` and immediately broadcasts `CLAIM_PRIMARY`.
- After 150 ms with no response, the tab marks itself as primary (`isPrimary = true`).
- If a primary tab receives a `CLAIM_PRIMARY` from another tab, it responds with `PRIMARY_EXISTS`.
- If a non-primary tab receives `PRIMARY_EXISTS` addressed to it, it clears the `sessionId` and redirects to `/`, forcing re-authentication.

## TypeScript Check Result

```
npx tsc --noEmit
```

**Result: No errors (exit 0, no output).**
