"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { FIELD, LABEL } from "@/components/form-styles";
import { Button } from "@/components/ui/button";
import { useAccess, useCredentials } from "@/hooks/use-access";
import { clearCredentials, isValidActor, setCredentials } from "@/lib/api/credentials";
import { keys } from "@/lib/api/keys";

// Operator and admin actions need the matching token (docs/API.md section 2). The token stays in
// this browser tab only (sessionStorage) and is sent as a Bearer header.
export function AccessPanel() {
  const access = useAccess();
  const credentials = useCredentials();
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const [actor, setActor] = useState(credentials.actor ?? "");
  const actorOk = actor.trim() === "" || isValidActor(actor.trim());

  function apply(next: { token?: string; actor?: string } | null) {
    if (next) setCredentials(next);
    else clearCredentials();
    setToken("");
    void queryClient.invalidateQueries({ queryKey: keys.me });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm">
        Signed in as <span className="font-medium">{access.role ?? "unknown"}</span>
        {access.actor ? <span className="text-muted-foreground"> ({access.actor})</span> : null}.{" "}
        {access.authEnabled ? null : (
          <span className="text-warn-fg">Auth is off on this server, so everyone is admin (local development).</span>
        )}
      </p>
      <form
        className="grid gap-3 sm:grid-cols-[1fr_12rem_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          if (actorOk && token.trim()) apply({ token: token.trim(), actor: actor.trim() || undefined });
        }}
      >
        <label>
          <span className={LABEL}>Operator or admin token</span>
          <input className={FIELD} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
        </label>
        <label>
          <span className={LABEL}>Your name (for the audit trail)</span>
          <input className={FIELD} value={actor} maxLength={64} onChange={(e) => setActor(e.target.value)} aria-invalid={!actorOk} />
        </label>
        <div className="flex items-end gap-2">
          <Button type="submit" disabled={!token.trim() || !actorOk}>
            Sign in
          </Button>
          {credentials.token ? (
            <Button type="button" variant="outline" onClick={() => apply(null)}>
              Sign out
            </Button>
          ) : null}
        </div>
      </form>
      {!actorOk ? <p className="text-xs text-bad-fg">Use 1 to 64 letters, digits, spaces or . _ @ -</p> : null}
    </div>
  );
}
