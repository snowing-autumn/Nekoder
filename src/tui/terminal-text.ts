/** Remove terminal control protocols while preserving ordinary Unicode text. */
export function sanitizeTerminalText(value: unknown): string {
  const text = typeof value === "string" ? value : safeStringify(value);
  return text
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b[PX^_][\s\S]*?\u001b\\/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\n]*$/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unprintable value]";
  }
}
