import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { handleSocksConnection } from "../lib/socks-proxy.mjs";

class FakeChannel extends EventEmitter {
  constructor() { super(); this.writes = []; this.piped = null; this.destroyed = false; }
  write(value) { this.writes.push(Buffer.from(value)); }
  pipe(target) { this.piped = target; return target; }
  end() { this.ended = true; }
  destroy() { this.destroyed = true; }
}

class FakeUpstream extends EventEmitter {
  constructor() { super(); this.writes = []; }
  write(value) { this.writes.push(Buffer.from(value)); }
  pipe(target) { this.piped = target; return target; }
  destroy() { this.destroyed = true; }
}

test("SOCKS5 connects by hostname and forwards buffered payload", () => {
  const channel = new FakeChannel();
  const upstream = new FakeUpstream();
  let options;
  handleSocksConnection(channel, (value) => { options = value; return upstream; });
  channel.emit("data", Buffer.from([0x05, 0x01, 0x00]));
  assert.deepEqual(channel.writes[0], Buffer.from([0x05, 0x00]));
  const host = Buffer.from("pypi.org");
  channel.emit("data", Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, Buffer.from([0x01, 0xbb, 0x16, 0x03])]));
  assert.deepEqual(options, { host: "pypi.org", port: 443 });
  upstream.emit("connect");
  assert.deepEqual(channel.writes[1], Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
  assert.deepEqual(upstream.writes, [Buffer.from([0x16, 0x03])]);
});

