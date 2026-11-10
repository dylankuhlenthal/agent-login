import assert from 'node:assert/strict';
import { test } from 'node:test';
import { credentialsFromItem } from '../src/onepassword.ts';

const FIELDS = [
  { purpose: 'USERNAME', value: 'agent@example.test' },
  { purpose: 'PASSWORD', value: 'secret' },
];

test('allowed sites are the origins of every website on the item, and the primary one is the login page', () => {
  const credentials = credentialsFromItem({
    fields: FIELDS,
    urls: [{ href: 'https://other.example.test/x' }, { href: 'https://book.example.test/login?a=1', primary: true }],
  });

  assert.deepEqual(credentials.allowedOrigins, ['https://other.example.test', 'https://book.example.test']);
  assert.equal(credentials.primaryUrl, 'https://book.example.test/login?a=1');
});

test('a website saved without a scheme is treated as https', () => {
  const credentials = credentialsFromItem({ fields: FIELDS, urls: [{ href: 'book.example.test' }] });

  assert.deepEqual(credentials.allowedOrigins, ['https://book.example.test']);
});

test('an item without a username, password or website is refused', () => {
  for (const item of [{ fields: FIELDS }, { fields: FIELDS.slice(0, 1), urls: [{ href: 'https://a.test' }] }]) {
    assert.throws(() => credentialsFromItem(item), { code: 'ITEM_INCOMPLETE' });
  }
});
