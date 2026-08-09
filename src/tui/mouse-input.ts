export type MouseInput =
  | { readonly type: "wheel"; readonly direction: "up" | "down"; readonly x: number; readonly y: number }
  | { readonly type: "left_release"; readonly x: number; readonly y: number };

/** Parse an SGR 1006 mouse report, accepting Ink's escape-stripped form too. */
export function parseSgrMouse(input: string): MouseInput | undefined {
  const match = /^(?:\u001b)?\[<(\d+);(\d+);(\d+)([Mm])$/.exec(input);
  if (!match) return undefined;
  const button = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (button === 64 || button === 65) {
    return { type: "wheel", direction: button === 64 ? "up" : "down", x, y };
  }
  if ((button & 3) === 0 && match[4] === "m") {
    return { type: "left_release", x, y };
  }
  return undefined;
}
