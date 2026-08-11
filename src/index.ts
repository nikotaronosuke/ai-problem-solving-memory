/**
 * Executable entrypoint.
 *
 * P1-01 establishes the runtime only: it loads configuration and reports what
 * it started as. No HTTP surface, no database and no Memory domain logic yet.
 */

import { loadEnv } from './config/env.js';
import { buildStartupSummary, formatStartupSummary } from './service.js';

const summary = buildStartupSummary(loadEnv());
console.log(formatStartupSummary(summary));
