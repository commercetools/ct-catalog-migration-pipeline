/**
 * Personal data kept out of diagnostics: the parser's quote of a feed line, and an
 * email address repeated in an API error.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeJsonError, maskEmails } from '../src/model/redact.js';

test('maskEmails: every email-shaped value is replaced, the rest kept', () => {
  assert.equal(
    maskEmails("DuplicateField: A duplicate value '\"ada.lovelace+shop@mail.example.co.uk\"' exists for field 'email'."),
    "DuplicateField: A duplicate value '\"[email]\"' exists for field 'email'.",
  );
  assert.equal(maskEmails('a@example.com and b@example.org'), '[email] and [email]');
  assert.equal(maskEmails('defaultShippingAddress must be a valid index'), 'defaultShippingAddress must be a valid index');
  assert.equal(maskEmails('SKU AB-12@2x stays'), 'SKU AB-12@2x stays', 'no dot-TLD, not an email');
});

test('describeJsonError: the parser\'s quote of the line never comes through', () => {
  // The form Node uses for an unexpected token quotes the end of the input.
  let quoting: unknown;
  try {
    JSON.parse('{"email":"ada@example.com","x":tru}');
  } catch (err) {
    quoting = err;
  }
  const text = describeJsonError(quoting);
  assert.doesNotMatch(text, /ada|example|tru/);
  assert.match(text, /^Not valid JSON/);
});

test('describeJsonError: the column is kept when the parser gives one', () => {
  let positioned: unknown;
  try {
    JSON.parse('{"a":1,}');
  } catch (err) {
    positioned = err;
  }
  assert.match(describeJsonError(positioned), /^Not valid JSON at column \d+\.$/);
  assert.equal(describeJsonError(new SyntaxError('Unexpected token in JSON at position 7')), 'Not valid JSON at column 8.');
  assert.equal(describeJsonError(new SyntaxError('x in JSON at position 27 (line 1 column 28)')), 'Not valid JSON at column 28.');
  assert.equal(describeJsonError('not an error'), 'Not valid JSON.');
});
