"use client";

import { useSyncExternalStore } from "react";
import { getCredentials, subscribeCredentials, type Credentials } from "@/lib/api/credentials";
import { useMe } from "@/lib/api/hooks";
import { can, requiredRole, type Action } from "@/lib/permissions";

const NONE: Credentials = {};

export function useCredentials(): Credentials {
  return useSyncExternalStore(subscribeCredentials, getCredentials, () => NONE);
}

// The caller's role from GET /api/me (which reflects the token sent), and what it may do.
export function useAccess() {
  const me = useMe();
  const role = me.data?.role;
  return {
    role,
    actor: me.data?.actor,
    authEnabled: me.data?.auth_enabled ?? true,
    loading: me.isPending,
    can: (action: Action) => can(role, action),
    needs: (action: Action) => `Needs ${requiredRole(action)} access. Add a token in the Control tab.`,
  };
}
