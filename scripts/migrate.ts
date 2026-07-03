// Standalone migration runner (boot also applies migrations automatically).
// Usage: npm run db:migrate
import { runMigrations } from "@omni/sdk";

const applied = runMigrations();
console.log(
  applied.length
    ? `Applied ${applied.length} migration(s): ${applied.join(", ")}`
    : "Database is up to date."
);
