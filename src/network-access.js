import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

const mappedIpv4 = new BlockList();
mappedIpv4.addSubnet('::ffff:0:0', 96, 'ipv6');

const privateNetworks = new BlockList();
privateNetworks.addSubnet('10.0.0.0', 8, 'ipv4');
privateNetworks.addSubnet('172.16.0.0', 12, 'ipv4');
privateNetworks.addSubnet('192.168.0.0', 16, 'ipv4');
privateNetworks.addSubnet('169.254.0.0', 16, 'ipv4');
privateNetworks.addSubnet('fc00::', 7, 'ipv6');
privateNetworks.addSubnet('fe80::', 10, 'ipv6');

function addressFamily(address) {
  if (typeof address !== 'string') return null;
  const version = isIP(address);
  if (version === 4) return 'ipv4';
  if (version === 6) return 'ipv6';
  return null;
}

export function gatewayLocalPeer(address) {
  const family = addressFamily(address);
  return family !== null && loopback.check(address, family);
}

function matchesOverlay(remoteAddress, remoteFamily, localAddress, localFamily, entry) {
  if (entry.internal || typeof entry.cidr !== 'string') return false;
  const family = addressFamily(entry.address);
  const parts = entry.cidr.split('/');
  const prefix = Number(parts[1]);
  // Treat only a concrete interface subnet as an overlay. Reject default routes
  // and wide public ranges, even if they were installed on a ZeroTier adapter.
  const minimumPrefix = family === 'ipv4' ? 16 : 48;
  const maximumPrefix = family === 'ipv4' ? 32 : 128;
  if (!family || parts.length !== 2 || addressFamily(parts[0]) !== family
    || !/^\d{1,3}$/.test(parts[1]) || prefix < minimumPrefix || prefix > maximumPrefix) return false;
  // BlockList maps IPv4 into IPv6 for matching. An IPv6 interface rule must
  // never match a native or mapped IPv4 peer through that conversion.
  if (family === 'ipv6' && (remoteFamily !== 'ipv6' || mappedIpv4.check(remoteAddress, remoteFamily)
    || mappedIpv4.check(entry.address, family))) return false;

  const endpoint = new BlockList();
  endpoint.addAddress(entry.address, family);
  if (!endpoint.check(localAddress, localFamily)) return false;

  const subnet = new BlockList();
  subnet.addSubnet(parts[0], prefix, family);
  return subnet.check(entry.address, family) && subnet.check(remoteAddress, remoteFamily);
}

/** Check the TCP peer and destination as reported by the socket. */
export function gatewayNetworkAllowed(remoteAddress, localAddress, interfaces) {
  const remoteFamily = addressFamily(remoteAddress);
  if (!remoteFamily) return false;
  if (loopback.check(remoteAddress, remoteFamily) || privateNetworks.check(remoteAddress, remoteFamily)) return true;

  const localFamily = addressFamily(localAddress);
  if (!localFamily) return false;
  const availableInterfaces = interfaces ?? networkInterfaces();
  return Object.entries(availableInterfaces).some(([name, addresses]) =>
    /^(?:ZeroTier(?:\s|[-_]|$)|zt[a-z0-9]{8,13}$)/i.test(name)
      && addresses?.some((entry) => matchesOverlay(remoteAddress, remoteFamily, localAddress, localFamily, entry)));
}
