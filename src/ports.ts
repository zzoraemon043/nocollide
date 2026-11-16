import { createServer } from "node:net";

const UNAVAILABLE_HOST = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT", "EINVAL"]);

function canListen(port: number, host?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => resolve(UNAVAILABLE_HOST.has(error.code ?? "")));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

export async function isPortFree(port: number): Promise<boolean> {
  for (const host of [undefined, "0.0.0.0", "127.0.0.1", "::1"]) {
    if (!(await canListen(port, host))) return false;
  }
  return true;
}
