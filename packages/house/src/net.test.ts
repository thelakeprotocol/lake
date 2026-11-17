import { hostname } from 'node:os';
import { describe, expect, it } from 'vitest';
import { callsHome } from './net.js';

describe('a URL an outsider gave never makes the house call its own machine', () => {
  const house = { publicUrl: 'https://sandbox.example/t/sam', podRoot: 'http://localhost:4310/sam/' };
  it('refuses loopback in every spelling, link-local, this machine and its pod', () => {
    for (const u of ['http://127.0.0.1:4310/x', 'http://localhost:7000/a2a', 'http://2130706433/a2a', 'http://[::1]:80/', 'http://0.0.0.0:4800/', 'http://[::ffff:127.0.0.1]/', 'http://a.localhost/'])
      expect(callsHome(u, house), u).toBe('it points at this machine');
    expect(callsHome('http://169.254.169.254/latest/meta-data', house)).toBe('it points at a link-local address');
    expect(callsHome(`http://${hostname()}:4310/`, house)).toBe('it points at this machine');
    expect(callsHome('file:///etc/passwd', house)).toBe('not an http address');
  });
  it('lets public addresses and the operator\'s own services through, and a house on a laptop call anything', () => {
    expect(callsHome('https://shop.example/a2a', house)).toBeNull();
    expect(callsHome('http://grocers:4810/puddlelane/a2a', house)).toBeNull();
    expect(callsHome('http://10.0.0.5:4810/a2a', house)).toBeNull();
    expect(callsHome('http://127.0.0.1:4810/a2a', { publicUrl: 'http://localhost:4001' })).toBeNull();
  });
});
