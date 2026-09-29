import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import { afterEach, describe, expect, it } from "vitest";
import { clearCredentials, setCredentials } from "@/lib/api/credentials";
import { ApiError, createHttp } from "@/lib/api/http";

const reply =
  (status: number, data: unknown): AxiosAdapter =>
  async (config) => {
    const response = { data, status, statusText: "", headers: {}, config } as AxiosResponse;
    if (status >= 400) throw new AxiosError("fail", String(status), config, null, response);
    return response;
  };

describe("createHttp", () => {
  afterEach(() => clearCredentials());

  it("turns the API error envelope into an ApiError", async () => {
    const http = createHttp(reply(422, { error: { code: "UNSAFE", message: "would lose fuel", details: ["overflow at station-mirpur"] } }));
    const error = await http.get("/api/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 422, code: "UNSAFE", message: "would lose fuel", details: ["overflow at station-mirpur"] });
  });

  it("names non-envelope failures by status", async () => {
    const error = await createHttp(reply(502, "<html>bad gateway</html>")).get("/api/x").catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 502, code: "HTTP_502" });
  });

  it("reports a network failure", async () => {
    const adapter: AxiosAdapter = async (config) => {
      throw new AxiosError("Network Error", AxiosError.ERR_NETWORK, config);
    };
    const error = await createHttp(adapter).get("/api/x").catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 0, code: "NETWORK" });
  });

  it("reports a timeout", async () => {
    const adapter: AxiosAdapter = async (config) => {
      throw new AxiosError("timeout", AxiosError.ECONNABORTED, config);
    };
    const error = await createHttp(adapter).get("/api/x").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "TIMEOUT" });
  });

  it("attaches the operator token and actor name when set", async () => {
    let seen: InternalAxiosRequestConfig | undefined;
    const http = createHttp(async (config) => {
      seen = config;
      return { data: {}, status: 200, statusText: "", headers: {}, config } as AxiosResponse;
    });
    setCredentials({ token: "secret-token", actor: "asif" });
    await http.get("/api/x");
    expect(seen?.headers.Authorization).toBe("Bearer secret-token");
    expect(seen?.headers["X-Actor"]).toBe("asif");
  });

  it("sends no auth headers without credentials", async () => {
    let seen: InternalAxiosRequestConfig | undefined;
    const http = createHttp(async (config) => {
      seen = config;
      return { data: {}, status: 200, statusText: "", headers: {}, config } as AxiosResponse;
    });
    await http.get("/api/x");
    expect(seen?.headers.Authorization).toBeUndefined();
  });
});
