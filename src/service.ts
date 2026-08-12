/**
 * Service identity and startup reporting.
 *
 * This repository implements the Problem-Solving Memory service only — a
 * Context Layer module, not the wider Personal AI Development OS.
 *
 * The summary reports where the server is bound and how it is configured, and
 * deliberately nothing about who or what it connects to: no connection string,
 * no owner id. Startup output is the first thing pasted into an issue.
 */

import type { AppEnv } from './config/env.js';

export const SERVICE_NAME = 'ai-problem-solving-memory';

export interface StartupSummary {
  readonly service: string;
  readonly nodeEnv: AppEnv['nodeEnv'];
  readonly logLevel: AppEnv['logLevel'];
  readonly nodeVersion: string;
  readonly host: string;
  readonly port: number;
}

export function buildStartupSummary(env: AppEnv, nodeVersion = process.version): StartupSummary {
  return {
    service: SERVICE_NAME,
    nodeEnv: env.nodeEnv,
    logLevel: env.logLevel,
    nodeVersion,
    host: env.host,
    port: env.port,
  };
}

export function formatStartupSummary(summary: StartupSummary): string {
  return [
    `${summary.service} starting`,
    `node=${summary.nodeVersion}`,
    `env=${summary.nodeEnv}`,
    `log=${summary.logLevel}`,
    `host=${summary.host}`,
    `port=${summary.port}`,
  ].join(' | ');
}
