#!/usr/bin/env node
/// <reference types="node" />
/**
 * The `bb-sdk-link` executable. Everything it does lives in
 * {@link runSdkLinkCli}; this file exists only to bind that to the process.
 *
 * Kept apart from `sdk-link.ts` so importing the engine never runs a command:
 * a module that reads `process.argv` at import time cannot be unit tested, and
 * this tool's whole design is that its filesystem moves are.
 */

import { runSdkLinkCli } from "./sdk-link.js";

process.exitCode = runSdkLinkCli(process.argv.slice(2), {
  cwd: process.cwd(),
  sdkPath: process.env.BB_SDK_PATH,
});
