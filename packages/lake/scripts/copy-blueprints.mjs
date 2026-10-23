// The project's blueprints (spec/blueprints) go next to the build, so every node starts with them.
import { cpSync, existsSync } from 'node:fs';
const from = new URL('../../../spec/blueprints/', import.meta.url);
if (existsSync(from)) cpSync(from, new URL('../dist/blueprints/', import.meta.url), { recursive: true });
