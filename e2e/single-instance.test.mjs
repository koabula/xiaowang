import { test } from 'node:test';
import { checkSingleInstance } from './fixtures/single-instance.mjs';
test('a second background launch does not duplicate tasks or reveal the hidden owner', { timeout: 60000 }, t => checkSingleInstance(t));
