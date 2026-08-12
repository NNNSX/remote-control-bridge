import net from "node:net";

const MAX_REQUEST_BYTES = 64 * 1024;

function writeReply(channel, code) {
  channel.write(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
}

function fail(channel, code) {
  try { writeReply(channel, code); } catch {}
  try { channel.destroy(); } catch { try { channel.end(); } catch {} }
}

function parseRequest(buffer) {
  if (buffer.length < 4) return null;
  if (buffer[0] !== 0x05) return { error: 0x01 };
  if (buffer[1] !== 0x01) return { error: 0x07 };
  let offset = 4;
  let host;
  if (buffer[3] === 0x01) {
    if (buffer.length < offset + 6) return null;
    host = [...buffer.subarray(offset, offset + 4)].join(".");
    offset += 4;
  } else if (buffer[3] === 0x03) {
    if (buffer.length < offset + 1) return null;
    const length = buffer[offset++];
    if (buffer.length < offset + length + 2) return null;
    host = buffer.subarray(offset, offset + length).toString("utf8");
    offset += length;
  } else if (buffer[3] === 0x04) {
    if (buffer.length < offset + 18) return null;
    const parts = [];
    for (let i = 0; i < 16; i += 2) parts.push(buffer.readUInt16BE(offset + i).toString(16));
    host = parts.join(":");
    offset += 16;
  } else return { error: 0x08 };
  return { host, port: buffer.readUInt16BE(offset), consumed: offset + 2 };
}

export function handleSocksConnection(channel, connect = net.connect) {
  let buffer = Buffer.alloc(0);
  let stage = "greeting";
  let upstream = null;
  let connected = false;
  const failConnection = (code) => {
    if (!connected) fail(channel, code);
    if (upstream) { try { upstream.destroy(); } catch {} }
  };
  const process = () => {
    if (stage === "greeting") {
      if (buffer.length < 2) return;
      const methodsLength = buffer[1];
      if (buffer[0] !== 0x05 || buffer.length < 2 + methodsLength) return failConnection(0x01);
      if (![...buffer.subarray(2, 2 + methodsLength)].includes(0x00)) return failConnection(0xff);
      channel.write(Buffer.from([0x05, 0x00]));
      buffer = buffer.subarray(2 + methodsLength);
      stage = "request";
    }
    if (stage !== "request") return;
    const request = parseRequest(buffer);
    if (!request) { if (buffer.length > MAX_REQUEST_BYTES) failConnection(0x01); return; }
    if (request.error) return failConnection(request.error);
    buffer = buffer.subarray(request.consumed);
    stage = "connecting";
    upstream = connect({ host: request.host, port: request.port });
    upstream.once("connect", () => {
      connected = true;
      writeReply(channel, 0x00);
      channel.pipe(upstream).pipe(channel);
      if (buffer.length) upstream.write(buffer);
      buffer = Buffer.alloc(0);
    });
    upstream.once("error", () => failConnection(0x05));
    upstream.once("close", () => { try { channel.end(); } catch {} });
  };
  channel.on("data", (chunk) => {
    if (stage === "connecting") return;
    buffer = Buffer.concat([buffer, chunk]);
    process();
  });
  channel.once("error", () => { try { upstream?.destroy(); } catch {} });
  channel.once("close", () => { try { upstream?.destroy(); } catch {} });
  return channel;
}
