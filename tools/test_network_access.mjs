import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gatewayLocalPeer, gatewayNetworkAllowed } from '../src/network-access.js';

test('loopback and private sockets are recognized in both native and mapped forms', () => {
  const local = ['127.0.0.1', '127.23.45.67', '::1', '::ffff:127.0.0.1', '0:0:0:0:0:ffff:7f00:1'];
  const privatePeers = ['10.8.0.2', '172.16.0.1', '172.31.255.254', '192.168.1.7',
    '169.254.2.2', '::ffff:192.168.9.9', '0:0:0:0:0:ffff:c0a8:909', 'fc12::3', 'fd12::1', 'fe80::a%12'];
  for (const address of local) assert.equal(gatewayLocalPeer(address), true, address);
  for (const address of privatePeers) assert.equal(gatewayLocalPeer(address), false, address);
  for (const address of [...local, ...privatePeers]) assert.equal(gatewayNetworkAllowed(address, undefined, {}), true, address);
});

test('public, unspecified and invalid socket addresses fail closed', () => {
  const denied = [undefined, null, '', 'localhost', '127.1', '192.168.01.2', '192.168.1.5:8787', '127.0.0.1, 8.8.8.8',
    '8.8.8.8', '::ffff:8.8.8.8', '100.72.42.2', '172.15.0.1', '172.32.0.1', '169.255.1.1',
    '192.169.1.2', '0.0.0.0', '::', '::192.168.1.8', '2001:db8::2', 'ff02::1'];
  for (const address of denied) {
    assert.equal(gatewayNetworkAllowed(address, '192.168.1.1', {}), false, address);
    assert.equal(gatewayLocalPeer(address), false, address);
  }
});

test('the actual socket destination must match the overlay interface and its subnet', () => {
  const interfaces = {
    Ethernet: [{ address: '100.72.42.100', cidr: '100.72.42.100/24', internal: false }],
    'ZeroTier One [d3adb33f00000000]': [
      { address: '100.72.42.9', cidr: '100.72.42.9/24', internal: false },
      { address: '2001:db8:10:2::9', cidr: '2001:db8:10:2::9/64', internal: false },
    ],
  };
  assert.equal(gatewayNetworkAllowed('100.72.42.21', '100.72.42.9', interfaces), true);
  assert.equal(gatewayNetworkAllowed('::ffff:100.72.42.21', '::ffff:100.72.42.9', interfaces), true);
  assert.equal(gatewayNetworkAllowed('100.72.42.21', '100.72.42.100', interfaces), false);
  assert.equal(gatewayNetworkAllowed('100.72.42.21', undefined, interfaces), false);
  assert.equal(gatewayNetworkAllowed('100.72.43.21', '100.72.42.9', interfaces), false);
  assert.equal(gatewayNetworkAllowed('2001:db8:10:2::f', '2001:DB8:10:2:0:0:0:9', interfaces), true);
  assert.equal(gatewayNetworkAllowed('2001:db8:10:3::f', '2001:db8:10:2::9', interfaces), false);
});

test('unknown interfaces and unsafe or incoherent overlay routes cannot admit public peers', () => {
  const remote = '8.8.8.8';
  const local = '8.8.8.10';
  const fixture = { address: local, cidr: '8.8.8.10/24', internal: false };
  assert.equal(gatewayNetworkAllowed(remote, local, { 'Normal Ethernet': [fixture] }), false);
  assert.equal(gatewayNetworkAllowed(remote, local, { ztabc12345: [fixture] }), true);
  for (const cidr of ['0.0.0.0/0', '8.0.0.0/8', '8.8.8.0/33', '8.8.8.0/24/24', '8.8.9.0/24', '::/64', null]) {
    assert.equal(gatewayNetworkAllowed(remote, local, { 'ZeroTier One': [{ ...fixture, cidr }] }), false, cidr);
  }
  assert.equal(gatewayNetworkAllowed(remote, local, { 'ZeroTier One': [{ ...fixture, internal: true }] }), false);
  const unusualV6 = { 'ZeroTier One': [{ address: '::2', cidr: '::2/64', internal: false }] };
  assert.equal(gatewayNetworkAllowed(remote, '::2', unusualV6), false);
  assert.equal(gatewayNetworkAllowed('::ffff:8.8.8.8', '::2', unusualV6), false);
});
