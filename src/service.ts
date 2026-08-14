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

/**
 * What the process says when it cannot start.
 *
 * Fixed text, and all of it: not the error, not its message, not a stack, not
 * the variable that was wrong or the value it held. It lives here rather than
 * in the entrypoint so that a test can read it without importing a module
 * whose import *is* starting the server.
 *
 * Somebody who sees this line is at the machine, with the configuration in
 * front of them. A line that quoted the configuration back would be the line
 * that gets pasted into an issue.
 */
export const STARTUP_FAILURE_MESSAGE = 'memory server failed to start';

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
