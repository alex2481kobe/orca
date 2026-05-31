process.env.COMMAND_DECK_HOST ||= '127.0.0.1';
process.env.PORT ||= '34125';
process.env.COMMAND_DECK_TAURI_DEV ||= 'true';

const { startServer, stopServer } = await import('../src/server.js');

let shuttingDown = false;
const server = await startServer();

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[tauri-dev-server] ${signal} received, stopping Command Deck server`);
  try {
    await stopServer();
  } finally {
    server.close(() => {
      process.exit(0);
    });
  }
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
