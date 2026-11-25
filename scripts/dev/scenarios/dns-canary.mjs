// A resolver that stands for "the rest of the internet" in the app end-to-end scenario: it logs the name of
// every query it receives and answers every A query with 203.0.113.80. If a mesh name ever reaches it, the
// log shows it. Usage: node dns-canary.mjs   (listens on UDP 53)
import dgram from 'node:dgram';

const sock = dgram.createSocket('udp4');
sock.on('message', (msg, rinfo) => {
  if (msg.length < 17) return;
  let i = 12;
  const labels = [];
  while (i < msg.length && msg[i] !== 0) {
    labels.push(msg.subarray(i + 1, i + 1 + msg[i]).toString());
    i += msg[i] + 1;
  }
  const qtype = msg.readUInt16BE(i + 1);
  const question = msg.subarray(12, i + 5);
  console.log(`Q ${labels.join('.')} type ${qtype}`);
  const head = Buffer.alloc(12);
  head.writeUInt16BE(msg.readUInt16BE(0), 0);
  head.writeUInt16BE(0x8180, 2);
  head.writeUInt16BE(1, 4);
  head.writeUInt16BE(qtype === 1 ? 1 : 0, 6);
  const parts = [head, question];
  if (qtype === 1) parts.push(Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 203, 0, 113, 80]));
  sock.send(Buffer.concat(parts), rinfo.port, rinfo.address);
});
sock.bind(53, () => console.log('canary listening'));
