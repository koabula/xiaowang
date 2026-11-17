import { test } from 'node:test';
import { checkSingleInstance } from '../fixtures/single-instance.mjs';
test('native: a second launch displays the existing owner and executes each task once', { timeout: 60000 }, t => checkSingleInstance(t, { native: true }));
