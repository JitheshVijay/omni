// Test-time environment defaults.
//
// @omni/env-config validates process.env at import time and calls
// process.exit(1) when a required var is missing. Failing the boot fast is
// right for a real process, but it also kills any test that transitively
// imports @omni/sdk — which is most of them. Supply placeholders here so the
// suite runs against a bare checkout with no developer .env.
//
// OMNI_DATA_DIR matters just as much: @omni/sdk's db.ts creates directories
// and opens omni.db at import time, defaulting to ~/.omni. Without an
// override, running the tests would read and write the developer's real
// Omni data. Point it at a throwaway directory instead.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.NODE_ENV ??= "test";
process.env.OPENROUTER_API_KEY ??= "test-openrouter-key";
process.env.OMNI_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "omni-test-"));
