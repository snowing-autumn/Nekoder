interface RegexRequest {
  readonly id: number;
  readonly line: string;
  readonly query: string;
  readonly caseSensitive: boolean;
}

interface RegexResponse {
  readonly id: number;
  readonly matches?: Array<{ index: number; value: string }>;
  readonly error?: string;
}

self.onmessage = (event: MessageEvent<RegexRequest>): void => {
  const { id, line, query, caseSensitive } = event.data;
  try {
    const regex = new RegExp(query, `gu${caseSensitive ? "" : "i"}`);
    const matches = [...line.matchAll(regex)].map((match) => ({
      index: match.index,
      value: match[0],
    }));
    postMessage({ id, matches } satisfies RegexResponse);
  } catch (error) {
    postMessage({ id, error: String(error) } satisfies RegexResponse);
  }
};
