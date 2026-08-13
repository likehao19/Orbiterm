import { createServer } from "vite";

const host = "127.0.0.1";
const port = 1420;
const url = `http://${host}:${port}`;

async function probeExistingServer() {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(800) });
    const html = await response.text();
    return response.ok && html.includes("<title>Orbiterm</title>") && html.includes('src="/src/main.js"');
  } catch {
    return false;
  }
}

if (await probeExistingServer()) {
  console.log(`Orbiterm 开发服务器已运行，复用 ${url}`);
  process.exit(0);
}

const server = await createServer();

try {
  await server.listen();
  server.printUrls();
} catch (error) {
  if (error?.code === "EADDRINUSE") {
    console.error(`端口 ${port} 已被其他程序占用，请关闭占用程序后重试。`);
  }
  throw error;
}

async function closeServer() {
  await server.close();
  process.exit(0);
}

process.once("SIGINT", closeServer);
process.once("SIGTERM", closeServer);
