import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { migrateCliPath, migrateDatabaseOnStart } from "./migrate-on-start.js";

const runtimeUrl = "postgres://rakazo_app:runtime-secret@db.internal:5432/vertexbot";
const ownerUrl = "postgres://vertexbot:owner-secret@db.internal:5432/vertexbot";

function enabledEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: runtimeUrl,
    DATABASE_MIGRATION_URL: ownerUrl,
    RAKAZO_MIGRATE_ON_START: "true",
    ...extra,
  };
}

describe("migrateDatabaseOnStart", () => {
  it("does nothing when the switch is off", async () => {
    const run = vi.fn();
    await migrateDatabaseOnStart({ DATABASE_URL: runtimeUrl }, { run });
    await migrateDatabaseOnStart(
      { DATABASE_URL: runtimeUrl, RAKAZO_MIGRATE_ON_START: "false" },
      { run },
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the built migrate command before the caller continues, and leaves the inventory unset", async () => {
    const order: string[] = [];
    const env = enabledEnv();
    await migrateDatabaseOnStart(env, {
      cliExists: () => true,
      cliPath: "/app/apps/api/dist/cli/migrate-database.js",
      run: async (command, args, childEnv) => {
        order.push("migrate");
        expect(command).toBe(process.execPath);
        expect(args).toEqual([
          "--enable-source-maps",
          "/app/apps/api/dist/cli/migrate-database.js",
        ]);
        expect(args.join(" ")).not.toContain("postgres://");
        expect(childEnv).toBe(env);
        expect(childEnv.RAKAZO_DEPLOYED_MIGRATIONS).toBeUndefined();
        return 0;
      },
    });
    order.push("createApp");
    expect(order).toEqual(["migrate", "createApp"]);
  });

  it("keeps an explicit empty inventory empty", async () => {
    const env = enabledEnv({ RAKAZO_DEPLOYED_MIGRATIONS: "" });
    await migrateDatabaseOnStart(env, {
      cliExists: () => true,
      run: async (_command, _args, childEnv) => {
        expect(childEnv.RAKAZO_DEPLOYED_MIGRATIONS).toBe("");
        return 0;
      },
    });
  });

  it("does not start the migrate command without a separate migration URL", async () => {
    const run = vi.fn();
    const present = { run, cliExists: () => true };
    await expect(
      migrateDatabaseOnStart({ ...enabledEnv(), DATABASE_MIGRATION_URL: undefined }, present),
    ).rejects.toThrow(/DATABASE_MIGRATION_URL/);
    await expect(
      migrateDatabaseOnStart(
        { ...enabledEnv(), DATABASE_URL: ownerUrl, DATABASE_MIGRATION_URL: ownerUrl },
        present,
      ),
    ).rejects.toThrow(/row-level security is not enforced/);
    await expect(
      migrateDatabaseOnStart({ ...enabledEnv(), DATABASE_MIGRATION_URL: "not a url" }, present),
    ).rejects.toThrow(/not a usable PostgreSQL URL/);
    const failure = await migrateDatabaseOnStart(
      { ...enabledEnv(), DATABASE_MIGRATION_URL: "not a url" },
      present,
    ).catch((error: unknown) => error);
    expect(failure instanceof Error ? failure.message : "").not.toContain("owner-secret");
    expect(failure instanceof Error ? failure.message : "").not.toContain("runtime-secret");
    expect(run).not.toHaveBeenCalled();
  });

  it("stops startup when the migrate command fails and does not echo the URL", async () => {
    const secret = "postgres://vertexbot:s3cret-token@db.internal:5432/vertexbot";
    const order: string[] = [];
    const failure = await migrateDatabaseOnStart(enabledEnv(), {
      cliExists: () => true,
      run: async () => {
        order.push("migrate");
        throw new Error(`spawn failed ${secret}`);
      },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : "";
    expect(message).toMatch(/did not start/);
    expect(message).toMatch(/not reset/);
    expect(message).not.toContain("s3cret-token");
    expect(message).not.toContain("db.internal");
    await expect(
      migrateDatabaseOnStart(enabledEnv(), {
        cliExists: () => true,
        run: async () => 1,
      }),
    ).rejects.toThrow(/exit 1/);
    try {
      await migrateDatabaseOnStart(enabledEnv(), {
        cliExists: () => true,
        run: async () => 1,
      });
      order.push("createApp");
    } catch {
      order.push("exit");
    }
    expect(order).toEqual(["migrate", "exit"]);
  });

  it("refuses to listen when the built migrate command is missing", async () => {
    const run = vi.fn();
    await expect(
      migrateDatabaseOnStart(enabledEnv(), { run, cliExists: () => false }),
    ).rejects.toThrow(/dist\/cli\/migrate-database\.js/);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("migrate CLI layout", () => {
  it("resolves the migrate command next to the built API entry", () => {
    expect(migrateCliPath("file:///app/apps/api/dist/index.js")).toBe(
      "/app/apps/api/dist/cli/migrate-database.js",
    );
  });

  it("is emitted by the API build that also emits dist/index.js", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts.build).toContain("src/index.ts");
    expect(pkg.scripts.build).toContain("src/cli/migrate-database.ts");
    expect(pkg.scripts.start).toContain("dist/index.js");
    const entry = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const migrate = entry.indexOf("await migrateDatabaseOnStart");
    const create = entry.indexOf("await createApp");
    const listen = entry.indexOf("serve(");
    expect(migrate).toBeGreaterThan(-1);
    expect(migrate).toBeLessThan(create);
    expect(create).toBeLessThan(listen);
  });
});
