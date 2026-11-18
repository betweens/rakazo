import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { databaseUrls, SINGLE_DATABASE_URL_WARNING } from "@rakazo/db";

/** Opt-in. Unset and `false` leave startup as it is today. */
export const MIGRATE_ON_START_ENV = "RAKAZO_MIGRATE_ON_START";

const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/**
 * Built entry and migrate command are siblings: `scripts/build-server.mjs` writes
 * `dist/index.js` and `dist/cli/migrate-database.js`. `node dist/index.js` puts the
 * entry on `argv`, which stays correct after the bundle step.
 */
export function migrateCliPath(moduleUrl?: string): string {
  const entry = moduleUrl
    ? fileURLToPath(moduleUrl)
    : process.argv[1] && path.basename(process.argv[1]) === "index.js"
      ? path.resolve(process.argv[1])
      : fileURLToPath(import.meta.url);
  return path.join(path.dirname(entry), "cli", "migrate-database.js");
}

export function migrateOnStartEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env[MIGRATE_ON_START_ENV];
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${MIGRATE_ON_START_ENV} must be true or false`);
}

export interface MigrateOnStartOptions {
  log?: (line: string) => void;
  /** Test seam. Production spawns the built migrate command with the current environment. */
  run?: (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<number>;
  cliPath?: string;
  cliExists?: (file: string) => boolean;
}

/**
 * When `RAKAZO_MIGRATE_ON_START=true`, run the existing migrate command and wait for
 * it to exit 0 before the caller opens the database. The child is
 * `dist/cli/migrate-database.js`: schema deploy, the job queue schema, then the
 * runtime login. Nothing here edits that command, sets `RAKAZO_DEPLOYED_MIGRATIONS`,
 * or resets the database. Schema deploy already holds its Postgres advisory lock, so
 * a rolling update can overlap processes — including a one-replica Deployment —
 * without applying schema migrations at the same time.
 */
export async function migrateDatabaseOnStart(
  env: NodeJS.ProcessEnv,
  options: MigrateOnStartOptions = {},
): Promise<void> {
  if (!migrateOnStartEnabled(env)) return;
  assertSeparateMigrationUrl(env);
  const cli = options.cliPath ?? migrateCliPath();
  if (!(options.cliExists ?? existsSync)(cli)) {
    throw new Error(
      `${MIGRATE_ON_START_ENV} needs dist/cli/migrate-database.js beside the API entry. Build @rakazo/api first. The API did not start.`,
    );
  }
  options.log?.("Applying database migrations before the API listens");
  let code: number;
  try {
    code = await (options.run ?? spawnMigrateCli)(
      process.execPath,
      ["--enable-source-maps", cli],
      env,
    );
  } catch (error) {
    const detail = error instanceof Error ? stripUrls(error.message) : "the migrate command failed";
    throw new Error(
      `Database migration could not be started. The API did not start. The database was not reset. ${detail}`,
    );
  }
  if (code !== 0) {
    throw new Error(
      `Database migration failed (exit ${code}). The API did not start. The database was not reset; the next start runs the same migrate command again.`,
    );
  }
}

function assertSeparateMigrationUrl(env: NodeJS.ProcessEnv): void {
  if (!env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL is required");
  if (!env.DATABASE_MIGRATION_URL?.trim()) {
    throw new Error(
      `${MIGRATE_ON_START_ENV} requires DATABASE_MIGRATION_URL set to the migration owner. DATABASE_URL stays the runtime login and is not used to migrate.`,
    );
  }
  let separate = false;
  try {
    separate = databaseUrls(env).separate;
  } catch {
    throw new Error(
      "DATABASE_URL or DATABASE_MIGRATION_URL is not a usable PostgreSQL URL. The API did not start.",
    );
  }
  if (!separate) throw new Error(SINGLE_DATABASE_URL_WARNING);
}

function stripUrls(text: string): string {
  return text.replace(URL_IN_TEXT, "[database-url]");
}

/** Same environment the API already unwrapped. Output stays on this process's logs. */
function spawnMigrateCli(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      settle();
    };
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code, signal) =>
      finish(() => {
        if (signal) {
          reject(
            new Error(
              `Database migration was stopped (${signal}). The API did not start. The database was not reset.`,
            ),
          );
          return;
        }
        resolve(code ?? 1);
      }),
    );
  });
}
