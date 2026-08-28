import { afterEach, describe, expect, it } from "vitest";

import { loadSettings } from "../src/config/env.js";

describe("loadSettings", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("throws a clear error naming every missing required Neo4j variable", () => {
    delete process.env.NEO4J_URI;
    delete process.env.NEO4J_USER;
    process.env.NEO4J_PASSWORD = "irrelevant";

    expect(() => loadSettings()).toThrowError(/NEO4J_URI, NEO4J_USER/);
  });

  it("treats an empty string the same as unset", () => {
    process.env.NEO4J_URI = "";
    process.env.NEO4J_USER = "neo4j";
    process.env.NEO4J_PASSWORD = "secret";

    expect(() => loadSettings()).toThrowError(/NEO4J_URI/);
  });

  it("succeeds and returns typed settings when all required vars are present", () => {
    process.env.NEO4J_URI = "neo4j://127.0.0.1:7687";
    process.env.NEO4J_USER = "neo4j";
    process.env.NEO4J_PASSWORD = "secret";
    delete process.env.NEO4J_DATABASE;

    const settings = loadSettings();

    expect(settings.neo4j).toEqual({
      uri: "neo4j://127.0.0.1:7687",
      username: "neo4j",
      password: "secret",
      database: undefined,
    });
  });

  it("rejects a non-numeric ESP32 baud rate with a clear error", () => {
    process.env.NEO4J_URI = "neo4j://127.0.0.1:7687";
    process.env.NEO4J_USER = "neo4j";
    process.env.NEO4J_PASSWORD = "secret";
    process.env.CIRCUITLOOP_ESP32_BAUD = "not-a-number";

    expect(() => loadSettings()).toThrowError(/CIRCUITLOOP_ESP32_BAUD/);
  });
});
