process.env.ASTRO_NODE_AUTOSTART = 'disabled';

const { startServer } = await import('../dist/server/entry.mjs');
const runningServer = startServer();
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) {
    process.exit(1);
  }
  shuttingDown = true;
  process.stdout.write(`Received ${signal}; stopping the HTTP server.\n`);

  const timeout = setTimeout(() => {
    process.stderr.write('Graceful shutdown timed out; exiting.\n');
    process.exit(1);
  }, 25_000);
  timeout.unref();

  runningServer.server.server.close((error) => {
    clearTimeout(timeout);
    if (error) {
      process.stderr.write(`HTTP server shutdown failed: ${error.message}\n`);
      process.exitCode = 1;
    }
  });
  runningServer.server.server.closeIdleConnections();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
