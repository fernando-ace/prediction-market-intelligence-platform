export function friendlyDbError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("Environment variable not found: DATABASE_URL")) {
    return "DATABASE_URL is not configured. Copy .env.example to .env and set the Postgres connection string.";
  }

  if (message.includes("does not exist")) {
    return "The Postgres database is not available yet. Start Postgres and run npm run db:migrate.";
  }

  if (message.includes("Can't reach database server") || message.includes("ECONNREFUSED")) {
    return "Cannot reach Postgres. Start the database service, then refresh this page.";
  }

  return message.split("\n")[0] ?? "Unknown database error.";
}
