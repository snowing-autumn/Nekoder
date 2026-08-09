#!/usr/bin/env bun
import { runCli } from "./cli.js";

process.exitCode = await runCli();
