import { afterEach, describe, expect, it } from "vitest";
import { clearCredentials, getCredentials, isValidActor, setCredentials } from "@/lib/api/credentials";

describe("credentials", () => {
  afterEach(() => clearCredentials());

  it("start empty and can be set and cleared", () => {
    expect(getCredentials()).toEqual({});
    setCredentials({ token: "t", actor: "asif" });
    expect(getCredentials()).toEqual({ token: "t", actor: "asif" });
    clearCredentials();
    expect(getCredentials()).toEqual({});
  });

  it("drop an actor name the API would reject", () => {
    setCredentials({ token: "t", actor: "bad<name>" });
    expect(getCredentials()).toEqual({ token: "t" });
  });

  it("validate actor names like the API (1-64 of [A-Za-z0-9 ._@-])", () => {
    expect(isValidActor("operator asif.k@bup")).toBe(true);
    expect(isValidActor("")).toBe(false);
    expect(isValidActor("x".repeat(65))).toBe(false);
    expect(isValidActor("drop;table")).toBe(false);
  });
});
