import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isItemWebsite, isSameSiteAsItemWebsite } from '../src/sites.ts';

const ITEM = ['https://app.example.com'];

test('the password may only be typed on an exact item website', () => {
  assert.equal(isItemWebsite('https://app.example.com/account/login', ITEM), true);
  assert.equal(isItemWebsite('https://venue.example.com/account/login', ITEM), false);
  assert.equal(isItemWebsite('https://example.com/account/login', ITEM), false);
  assert.equal(isItemWebsite('http://app.example.com/account/login', ITEM), false);
});

test('after signing in, a sibling subdomain of an item website counts', () => {
  assert.equal(isSameSiteAsItemWebsite('https://venue.example.com/booking', ITEM), true);
  assert.equal(isSameSiteAsItemWebsite('https://example.com/', ITEM), true);
});

test('after signing in, look-alikes and other sites do not count', () => {
  for (const url of [
    'https://example.com.evil.test/booking',
    'https://app-example.com/booking',
    'https://evilexample.com/booking',
    'http://venue.example.com/booking',
    'https://venue.example.com:8443/booking',
  ]) {
    assert.equal(isSameSiteAsItemWebsite(url, ITEM), false, url);
  }
});

test('hosts under a public suffix are separate sites, including privately run suffixes', () => {
  assert.equal(isSameSiteAsItemWebsite('https://other.github.io/', ['https://mine.github.io']), false);
  assert.equal(isSameSiteAsItemWebsite('https://other.co.uk/', ['https://mine.co.uk']), false);
  assert.equal(isSameSiteAsItemWebsite('https://www.mine.co.uk/', ['https://app.mine.co.uk']), true);
});

test('an IP address only ever matches exactly', () => {
  assert.equal(isSameSiteAsItemWebsite('http://127.0.0.2:8080/', ['http://127.0.0.1:8080']), false);
  assert.equal(isSameSiteAsItemWebsite('http://127.0.0.1:8080/home', ['http://127.0.0.1:8080']), true);
});
