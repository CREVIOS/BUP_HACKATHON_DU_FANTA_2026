import { describe, expect, it } from "vitest";
import { can, requiredRole } from "@/lib/permissions";

describe("can", () => {
  it("lets a viewer only read", () => {
    expect(can("viewer", "approve")).toBe(false);
    expect(can("viewer", "control")).toBe(false);
  });

  it("lets an operator decide but not control the simulator", () => {
    expect(["approve", "reject", "ack", "allocate", "cancel"].every((a) => can("operator", a as never))).toBe(true);
    expect(can("operator", "control")).toBe(false);
    expect(can("operator", "policy")).toBe(false);
  });

  it("lets an admin do everything", () => {
    expect(can("admin", "control")).toBe(true);
    expect(can("admin", "approve")).toBe(true);
  });

  it("denies when the role is unknown", () => {
    expect(can(undefined, "approve")).toBe(false);
  });

  it("names the role an action needs", () => {
    expect(requiredRole("approve")).toBe("operator");
    expect(requiredRole("control")).toBe("admin");
  });
});
