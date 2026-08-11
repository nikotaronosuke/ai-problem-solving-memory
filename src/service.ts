/**
 * Service identity and startup reporting.
 *
 * This repository implements the Problem-Solving Memory service only — a
 * Context Layer module, not the wider Personal AI Development OS. Memory
 * domain behaviour (Problem / Event / Verification, retrieval, adapters)
 * is not implemented yet; see `.ai/TODO.md`.
 */

import type { AppEnv } from './config/env.js';

export const SERVICE_NAME = 'ai-problem-solving-memory';

export interface StartupSummary {
  readonly service: string;
  readonly nodeEnv: AppEnv['nodeEnv'];
  readonly logLevel: AppEnv['logLevel'];
  readonly nodeVersion: string;
}

export function buildStartupSummary(env: AppEnv, nodeVersion = process.version): StartupSummary {
  return {
    service: SERVICE_NAME,
    nodeEnv: env.nodeEnv,
    logLevel: env.logLevel,
    nodeVersion,
  };
}

export function formatStartupSummary(summary: StartupSummary): string {
  return [
    `${summary.service} starting`,
    `node=${summary.nodeVersion}`,
    `env=${summary.nodeEnv}`,
    `log=${summary.logLevel}`,
  ].join(' | ');
}
