// A real second API process with its own local cache and Valkey namespace. The
// parent supplies only an isolated test database; no shared cache is flushed.
const { createApp } = require('../../server');
const { closeDatabase } = require('../../db');
const { closeValkey } = require('../../db/valkey');
const { settleAuditWrites } = require('../../utils/audit');
const { initTopologyWebSocket, closeTopologyWebSocket } = require('../../ws/topologyServer');

const server = createApp().listen(0, '127.0.0.1', () => {
  initTopologyWebSocket(server);
  process.send({ port: server.address().port });
});

process.on('message', async (message) => {
  if (message !== 'shutdown') return;
  closeTopologyWebSocket();
  closeValkey();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await settleAuditWrites();
  await closeDatabase();
  process.disconnect();
});
