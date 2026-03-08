export function logGateway(message: string, extra?: Record<string, string | number | boolean | undefined>) {
  const details = extra
    ? Object.entries(extra)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(" ")
    : "";

  console.log(`[pxpx-ssh] ${message}${details ? ` ${details}` : ""}`);
}
