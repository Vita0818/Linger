import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Ajv is a dependency of the wire-contracts package, not of the repository root.
const requireFromWireContracts = createRequire(
  path.resolve(import.meta.dirname, "../generated/typescript/package.json"),
);
const { Ajv2020 } = requireFromWireContracts("ajv/dist/2020.js");
const addFormats = requireFromWireContracts("ajv-formats");

const componentsDirectory = path.resolve(
  import.meta.dirname,
  "../openapi/components",
);
const localModelsUrl = pathToFileURL(
  path.join(componentsDirectory, "local-models.yaml"),
).href;

interface ReadinessCase {
  readonly rule: string;
  readonly case: string;
  readonly readiness: { readonly state: string; readonly reason?: string };
}

const fixtures = JSON.parse(
  readFileSync(
    path.resolve(
      import.meta.dirname,
      "../fixtures/local-models/readiness.json",
    ),
    "utf8",
  ),
) as {
  readonly readiness: readonly ReadinessCase[];
  readonly computers: readonly unknown[];
  readonly summary_page: unknown;
  readonly non_owner_summary: Record<string, unknown>;
  readonly profile: unknown;
  readonly local_computer_readiness: unknown;
};

function componentValidator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const file of readdirSync(componentsDirectory)) {
    if (!file.endsWith(".yaml")) continue;
    const url = pathToFileURL(path.join(componentsDirectory, file)).href;
    ajv.addSchema(
      parse(readFileSync(path.join(componentsDirectory, file), "utf8")),
      url,
    );
  }
  return (schema: string, value: unknown) => {
    const validate = ajv.getSchema(
      `${localModelsUrl}#/components/schemas/${schema}`,
    );
    if (!validate) throw new Error(`missing schema ${schema}`);
    const valid = validate(value);
    return valid ? [] : validate.errors;
  };
}

describe("local-models readiness contracts", () => {
  const schemas = parse(
    readFileSync(path.join(componentsDirectory, "local-models.yaml"), "utf8"),
  ).components.schemas;
  const validate = componentValidator();

  it("has a fixture for every readiness state and reason", () => {
    const states = new Set(fixtures.readiness.map((c) => c.readiness.state));
    const reasons = new Set(
      fixtures.readiness.flatMap((c) =>
        c.readiness.reason ? [c.readiness.reason] : [],
      ),
    );
    expect([...states].sort()).toEqual(
      [...schemas.LocalModelsReadinessState.enum].sort(),
    );
    expect([...reasons].sort()).toEqual(
      [...schemas.LocalModelsReadinessReason.enum].sort(),
    );
    expect(fixtures.readiness.map((c) => c.rule)).toContain("10b");
  });

  it("accepts every fixture", () => {
    for (const fixture of fixtures.readiness) {
      expect(
        validate("LocalModelsReadiness", fixture.readiness),
        fixture.case,
      ).toEqual([]);
    }
    for (const computer of fixtures.computers) {
      expect(validate("LocalModelsComputer", computer)).toEqual([]);
    }
    expect(
      validate("LocalModelsComputerSummaryPage", fixtures.summary_page),
    ).toEqual([]);
    expect(
      validate("RecordLocalComputerProfileRequest", fixtures.profile),
    ).toEqual([]);
    expect(
      validate("LocalModelsReadiness", fixtures.local_computer_readiness),
    ).toEqual([]);
  });

  it("keeps a non-owner summary row to name, owner, status and readiness", () => {
    expect(Object.keys(fixtures.non_owner_summary).sort()).toEqual(
      [...schemas.LocalModelsComputerSummary.required].sort(),
    );
  });

  it("rejects readiness without enable_command and unknown states", () => {
    expect(validate("LocalModelsReadiness", { state: "ready" })).not.toEqual(
      [],
    );
    expect(
      validate("LocalModelsReadiness", {
        state: "cpu_only",
        enable_command: false,
      }),
    ).not.toEqual([]);
  });
});
