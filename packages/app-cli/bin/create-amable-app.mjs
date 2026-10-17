#!/usr/bin/env node
import { main } from '../dist/cli.mjs';

process.exitCode = await main(['create', ...process.argv.slice(2)]);
