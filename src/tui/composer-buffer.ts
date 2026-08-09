export interface ComposerBuffer {
  readonly text: string;
  readonly cursor: number;
  readonly past: readonly ComposerSnapshot[];
  readonly future: readonly ComposerSnapshot[];
}

interface ComposerSnapshot {
  readonly text: string;
  readonly cursor: number;
}

export type ComposerAction =
  | { readonly type: "insert"; readonly text: string }
  | { readonly type: "move_left" }
  | { readonly type: "move_right" }
  | { readonly type: "move_home" }
  | { readonly type: "move_end" }
  | { readonly type: "backspace" }
  | { readonly type: "delete" }
  | { readonly type: "undo" }
  | { readonly type: "redo" };

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function createComposerBuffer(text = ""): ComposerBuffer {
  return { text, cursor: text.length, past: [], future: [] };
}

export function applyComposerAction(
  buffer: ComposerBuffer,
  action: ComposerAction
): ComposerBuffer {
  switch (action.type) {
    case "insert":
      return commit(
        buffer,
          buffer.text.slice(0, buffer.cursor) +
          action.text.slice(0, Math.max(0, 65_536 - buffer.text.length)) +
          buffer.text.slice(buffer.cursor),
        buffer.cursor + Math.min(action.text.length, Math.max(0, 65_536 - buffer.text.length))
      );
    case "move_left":
      return { ...buffer, cursor: previousBoundary(buffer.text, buffer.cursor) };
    case "move_right":
      return { ...buffer, cursor: nextBoundary(buffer.text, buffer.cursor) };
    case "move_home":
      return { ...buffer, cursor: 0 };
    case "move_end":
      return { ...buffer, cursor: buffer.text.length };
    case "backspace": {
      const start = previousBoundary(buffer.text, buffer.cursor);
      if (start === buffer.cursor) return buffer;
      return commit(
        buffer,
        buffer.text.slice(0, start) + buffer.text.slice(buffer.cursor),
        start
      );
    }
    case "delete": {
      const end = nextBoundary(buffer.text, buffer.cursor);
      if (end === buffer.cursor) return buffer;
      return commit(
        buffer,
        buffer.text.slice(0, buffer.cursor) + buffer.text.slice(end),
        buffer.cursor
      );
    }
    case "undo": {
      const previous = buffer.past.at(-1);
      if (!previous) return buffer;
      return {
        ...previous,
        past: buffer.past.slice(0, -1),
        future: [{ text: buffer.text, cursor: buffer.cursor }, ...buffer.future].slice(0, 100),
      };
    }
    case "redo": {
      const next = buffer.future[0];
      if (!next) return buffer;
      return {
        ...next,
        past: [...buffer.past, { text: buffer.text, cursor: buffer.cursor }].slice(-100),
        future: buffer.future.slice(1),
      };
    }
  }
}

function commit(buffer: ComposerBuffer, text: string, cursor: number): ComposerBuffer {
  if (text === buffer.text && cursor === buffer.cursor) return buffer;
  return {
    text,
    cursor,
    past: [...buffer.past, { text: buffer.text, cursor: buffer.cursor }].slice(-100),
    future: [],
  };
}

function boundaries(text: string): number[] {
  const result = Array.from(graphemes.segment(text), ({ index }) => index);
  if (result.at(-1) !== text.length) result.push(text.length);
  return result;
}

function previousBoundary(text: string, cursor: number): number {
  let previous = 0;
  for (const boundary of boundaries(text)) {
    if (boundary >= cursor) break;
    previous = boundary;
  }
  return previous;
}

function nextBoundary(text: string, cursor: number): number {
  return boundaries(text).find((boundary) => boundary > cursor) ?? cursor;
}
