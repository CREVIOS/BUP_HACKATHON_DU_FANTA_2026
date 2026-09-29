import type { Role } from "@/lib/api/schemas";

// Mirrors docs/API.md section 2 (Auth). The API enforces it; the UI only hides what would fail.
export type Action = "approve" | "reject" | "ack" | "allocate" | "cancel" | "control" | "policy";

const OPERATOR_ACTIONS: ReadonlySet<Action> = new Set(["approve", "reject", "ack", "allocate", "cancel"]);

export function can(role: Role | undefined, action: Action): boolean {
  if (role === "admin") return true;
  if (role === "operator") return OPERATOR_ACTIONS.has(action);
  return false;
}

export const requiredRole = (action: Action): "operator" | "admin" => (OPERATOR_ACTIONS.has(action) ? "operator" : "admin");
