import { describe, it, expect } from "vitest";
import { validate } from "../src/index";

const env = { ALLOWED_EVENTS: "install,demo,proxy,serve,command" };
const uuid = "11111111-1111-1111-1111-111111111111";

describe("validate", () => {
  it("accepts a well-formed node payload", () => {
    const r = validate({ id: uuid, event: "install", version: "0.1.0", os: "linux", node: "v20.10.0" }, env);
    expect(r).toEqual({ id: uuid, event: "install", version: "0.1.0", os: "linux", runtime: "node v20.10.0" });
  });

  it("accepts a well-formed python payload", () => {
    const r = validate({ id: uuid, event: "demo", version: "0.1.0", os: "darwin", python: "3.12.4" }, env);
    expect(r?.runtime).toBe("python 3.12.4");
  });

  it("drops unknown event names", () => {
    expect(validate({ id: uuid, event: "exfiltrate", version: "0.1.0", os: "linux", node: "v20" }, env)).toBeNull();
  });

  it("drops missing fields", () => {
    expect(validate({ id: uuid, event: "install", os: "linux", node: "v20" }, env)).toBeNull();
  });

  it("drops overlong fields", () => {
    const long = "x".repeat(200);
    expect(validate({ id: uuid, event: "install", version: long, os: "linux", node: "v20" }, env)).toBeNull();
  });

  it("drops non-object bodies", () => {
    expect(validate(null, env)).toBeNull();
    expect(validate("hi", env)).toBeNull();
    expect(validate(42, env)).toBeNull();
  });

  it("drops missing runtime", () => {
    expect(validate({ id: uuid, event: "install", version: "0.1.0", os: "linux" }, env)).toBeNull();
  });
});
